#!/usr/bin/env node
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const WordExtractor = require("word-extractor");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 4173);
const MAX_DOCUMENT_SIZE = 20 * 1024 * 1024;
const wordExtractor = new WordExtractor();
let pdfjsPromise;
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".mp3": "audio/mpeg",
  ".mpeg": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4"
};
const MEDIA_EXTENSIONS = new Set([".mp3", ".mpeg", ".ogg", ".wav", ".m4a", ".mp4"]);

async function extractPdfText(buffer) {
  pdfjsPromise ||= import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdfjs = await pdfjsPromise;
  const document = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const lines = [];
    let previousY;
    for (const item of content.items) {
      if (!item.str.trim()) continue;
      const y = item.transform[5];
      if (previousY === undefined || Math.abs(previousY - y) > 3) lines.push(item.str);
      else lines[lines.length - 1] += ` ${item.str}`;
      previousY = y;
    }
    pages.push(lines.join("\n"));
  }
  await document.destroy();
  return pages.join("\n");
}

async function extractDocumentText(filename, buffer) {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".pdf") return extractPdfText(buffer);
  if (extension === ".doc" || extension === ".docx") {
    const document = await wordExtractor.extract(buffer);
    return document.getBody();
  }
  throw new Error("Formato de documento não suportado.");
}

function handleDocumentExtraction(request, response) {
  let filename;
  try {
    filename = decodeURIComponent(request.headers["x-sound-asaph-filename"] || "");
  } catch {
    response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "Nome de arquivo inválido." }));
    return;
  }
  const extension = path.extname(path.basename(filename)).toLowerCase();
  if (![".pdf", ".doc", ".docx"].includes(extension)) {
    response.writeHead(415, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "Formato não suportado para extração." }));
    return;
  }
  if (Number(request.headers["content-length"]) > MAX_DOCUMENT_SIZE) {
    response.writeHead(413, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "O arquivo excede o limite de 20 MB." }));
    return;
  }

  const chunks = [];
  let size = 0;
  let tooLarge = false;
  request.on("data", chunk => {
    size += chunk.length;
    if (size > MAX_DOCUMENT_SIZE) {
      tooLarge = true;
      chunks.length = 0;
      return;
    }
    if (!tooLarge) chunks.push(chunk);
  });
  request.on("end", async () => {
    if (tooLarge) {
      response.writeHead(413, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "O arquivo excede o limite de 20 MB." }));
      return;
    }
    try {
      const text = await extractDocumentText(filename, Buffer.concat(chunks));
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ text }));
    } catch (error) {
      console.error(`Falha ao extrair texto de ${path.basename(filename)}:`, error.message);
      response.writeHead(422, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "Não foi possível ler o arquivo. PDF escaneado sem texto reconhecível não é compatível." }));
    }
  });
}

http.createServer((request, response) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  } catch {
    response.writeHead(400).end("Requisição inválida");
    return;
  }

  if (pathname === "/api/extract-text") {
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" }).end("Método não permitido");
      return;
    }
    handleDocumentExtraction(request, response);
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end("Método não permitido");
    return;
  }

  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(ROOT, `.${requestedPath}`);
  if (filePath !== ROOT && !filePath.startsWith(`${ROOT}${path.sep}`)) {
    response.writeHead(403).end("Acesso negado");
    return;
  }

  fs.stat(filePath, (error, stats) => {
    if (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(error.code === "ENOENT" ? "Arquivo não encontrado" : "Erro ao ler arquivo");
      if (error.code !== "ENOENT") console.error(`Falha ao ler ${filePath}:`, error);
      return;
    }
    if (!stats.isFile()) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Arquivo não encontrado");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    const mediaFile = MEDIA_EXTENSIONS.has(extension);
    const headers = {
      "Content-Type": CONTENT_TYPES[extension] || "application/octet-stream",
      "Content-Length": stats.size
    };
    if (mediaFile) headers["Accept-Ranges"] = "bytes";

    let start = 0;
    let end = stats.size - 1;
    let status = 200;
    if (mediaFile && request.headers.range) {
      const match = request.headers.range.match(/^bytes=(\d*)-(\d*)$/);
      if (!match || (!match[1] && !match[2])) {
        response.writeHead(416, { "Content-Range": `bytes */${stats.size}` });
        response.end();
        return;
      }
      if (!match[1]) {
        const suffixLength = Number(match[2]);
        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
          response.writeHead(416, { "Content-Range": `bytes */${stats.size}` });
          response.end();
          return;
        }
        start = Math.max(stats.size - suffixLength, 0);
      } else {
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), stats.size - 1) : stats.size - 1;
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= stats.size || end < start) {
        response.writeHead(416, { "Content-Range": `bytes */${stats.size}` });
        response.end();
        return;
      }
      status = 206;
      headers["Content-Range"] = `bytes ${start}-${end}/${stats.size}`;
      headers["Content-Length"] = end - start + 1;
    }

    response.writeHead(status, headers);
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    const stream = fs.createReadStream(filePath, { start, end });
    stream.on("error", streamError => {
      console.error(`Falha ao ler ${filePath}:`, streamError);
      if (response.headersSent) response.destroy(streamError);
      else response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end("Erro ao ler arquivo");
    });
    stream.pipe(response);
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Sound-Asaph disponível em http://localhost:${PORT}`);
});
