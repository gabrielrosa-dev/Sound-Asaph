#!/usr/bin/env node
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const WordExtractor = require("word-extractor");
const { syncFromDrive, runImport, hasCredentials, MUSIC_DIR } = require("./drive-sync");

const ROOT = path.resolve(__dirname, "..");
const OVERRIDES_FILE = path.join(ROOT, "data", "overrides.json");
const BLOCKED_PATHS = new Set(["credentials", "scripts", "node_modules", "package.json", "package-lock.json"]);
const AUTO_SYNC_MS = Number(process.env.SYNC_INTERVAL_MS || 60_000);
const syncState = { running: false, promise: null, lastResult: null, lastError: "", lastSyncAt: 0 };
let catalogVersion = 0;
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

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("Arquivo grande demais."), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function readOverrides() {
  try {
    const parsed = JSON.parse(await fsp.readFile(OVERRIDES_FILE, "utf8"));
    return { edits: parsed.edits || {}, deleted: parsed.deleted || [] };
  } catch {
    return { edits: {}, deleted: [] };
  }
}

async function writeOverrides(overrides) {
  await fsp.mkdir(path.dirname(OVERRIDES_FILE), { recursive: true });
  await fsp.writeFile(OVERRIDES_FILE, JSON.stringify(overrides, null, 2));
  catalogVersion = Date.now();
}

async function runSync(reason) {
  if (syncState.running) return syncState.promise;
  syncState.running = true;
  syncState.promise = (async () => {
    try {
      const result = await syncFromDrive();
      Object.assign(syncState, { lastResult: result, lastError: "", lastSyncAt: Date.now() });
      catalogVersion = Date.now();
      console.log(`Sincronização (${reason}): ${result.downloaded} baixado(s), ${result.removed} removido(s), ${result.errors.length} erro(s).`);
      return result;
    } catch (error) {
      syncState.lastError = error.message;
      console.error(`Falha na sincronização (${reason}):`, error.message);
      throw error;
    } finally {
      syncState.running = false;
    }
  })();
  return syncState.promise;
}

async function handleApi(request, response, pathname) {
  try {
    if (pathname === "/api/status" && request.method === "GET") {
      const overrides = await readOverrides();
      sendJson(response, 200, {
        ok: true,
        version: Math.max(catalogVersion, await fsp.stat(path.join(ROOT, "data", "folder-songs.json")).then(s => s.mtimeMs, () => 0)),
        driveConfigured: await hasCredentials(),
        syncing: syncState.running,
        lastSyncAt: syncState.lastSyncAt,
        lastError: syncState.lastError,
        lastResult: syncState.lastResult,
        overrides
      });
      return;
    }
    if (request.headers["x-sound-asaph"] !== "1") {
      sendJson(response, 403, { error: "Requisição não autorizada." });
      return;
    }
    if (pathname === "/api/sync" && request.method === "POST") {
      sendJson(response, 200, await runSync("manual"));
    } else if (pathname === "/api/overrides/edit" && request.method === "PUT") {
      const { id, title, artist, key, lyrics } = JSON.parse((await readBody(request, 1024 * 1024)).toString("utf8"));
      if (typeof id !== "string" || !id || typeof title !== "string" || typeof lyrics !== "string") {
        sendJson(response, 400, { error: "Dados inválidos." });
        return;
      }
      const overrides = await readOverrides();
      overrides.edits[id] = { title, artist: artist || "", key: key || "", lyrics };
      await writeOverrides(overrides);
      sendJson(response, 200, { ok: true });
    } else if (pathname === "/api/overrides/delete" && request.method === "POST") {
      const { id } = JSON.parse((await readBody(request, 4096)).toString("utf8"));
      if (typeof id !== "string" || !id) {
        sendJson(response, 400, { error: "Dados inválidos." });
        return;
      }
      const overrides = await readOverrides();
      overrides.deleted = [...new Set([...overrides.deleted, id])];
      delete overrides.edits[id];
      await writeOverrides(overrides);
      sendJson(response, 200, { ok: true });
    } else if (pathname === "/api/upload" && request.method === "POST") {
      const filename = path.basename(decodeURIComponent(request.headers["x-sound-asaph-filename"] || ""));
      const extension = path.extname(filename).toLowerCase();
      const isAudio = MEDIA_EXTENSIONS.has(extension);
      if (!filename || (!isAudio && ![".txt", ".md", ".pdf", ".doc", ".docx"].includes(extension))) {
        sendJson(response, 415, { error: "Formato não suportado." });
        return;
      }
      const buffer = await readBody(request, isAudio ? 100 * 1024 * 1024 : MAX_DOCUMENT_SIZE);
      const folder = decodeURIComponent(request.headers["x-sound-asaph-folder"] || "") || "Músicas";
      const targetDirectory = path.join(MUSIC_DIR, "Importadas", ...(isAudio ? [path.basename(folder)] : []));
      await fsp.mkdir(targetDirectory, { recursive: true });
      await fsp.writeFile(path.join(targetDirectory, filename), buffer);
      if (request.headers["x-sound-asaph-last"] === "1") {
        await runImport();
        catalogVersion = Date.now();
      }
      sendJson(response, 200, { ok: true });
    } else {
      sendJson(response, 404, { error: "Rota não encontrada." });
    }
  } catch (error) {
    sendJson(response, error.status || 500, { error: error.message });
  }
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
  if (pathname.startsWith("/api/")) {
    handleApi(request, response, pathname);
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
  const topLevel = path.relative(ROOT, filePath).split(path.sep)[0];
  if (BLOCKED_PATHS.has(topLevel.toLowerCase()) || topLevel.startsWith(".")) {
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
}).listen(PORT, "127.0.0.1", async () => {
  console.log(`Sound-Asaph disponível em http://localhost:${PORT}`);
  if (await hasCredentials()) {
    runSync("início").catch(() => {});
    setInterval(() => runSync("automática").catch(() => {}), AUTO_SYNC_MS);
  } else {
    console.log("Drive não configurado: coloque a chave em credentials/service-account.json (veja o README) ou copie as músicas para a pasta musicas/ e rode npm run import:folder.");
  }
});
