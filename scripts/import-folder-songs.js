#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const WordExtractor = require("word-extractor");

const ROOT = path.resolve(__dirname, "..");
const inputDir = path.join(ROOT, "musicas");
const outputFile = path.join(ROOT, "data", "folder-songs.json");
const audioOutputFile = path.join(ROOT, "data", "folder-audio.json");
const MAX_DOCUMENT_SIZE = 20 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set([".txt", ".md", ".pdf", ".doc", ".docx"]);
const SUPPORTED_AUDIO_EXTENSIONS = new Set([".mp3", ".mp4", ".mpeg", ".ogg", ".wav", ".m4a"]);
const KEY_PATTERN = /^[A-G](?:#|b)?(?:m|min|maj|sus|dim|aug)?$/i;
const CHORD_PATTERN = /^[A-G](?:#|b)?(?:[^/\]\s]+)?(?:\/[A-G](?:#|b)?)?$/;
const wordExtractor = new WordExtractor();
let pdfjsPromise;

function slugify(value) {
  return value.normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function cleanToneFromTitle(title) {
  return title.normalize("NFC")
    .replace(/\s*\(\s*(?:d[oó]|r[eé]|m[ií]|f[aá]|sol|l[aá]|si|[a-g](?:#|b)?m?)\s*\)/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function categoryForPath(relativePath) {
  const rootFolder = slugify(relativePath.split(path.sep)[0]);
  if (rootFolder === "hinario") return "hinario";
  if (rootFolder === "datas-especiais") return "datas-especiais";
  if (rootFolder === "musicas-em-preparacao") return "preparacao";
  return "repertorio";
}

function folderForPath(relativePath) {
  const parts = relativePath.split(path.sep);
  return parts.length > 2 ? parts[1] : "Outras músicas";
}

function folderIdForPath(relativePath) {
  const parts = relativePath.split(path.sep);
  return parts.length > 1 ? slugify(`${parts[0]}-${parts[1]}`) : "";
}

function audioNameKey(value) {
  const withoutTone = value.normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(?:tom|tonalidade)\b.*$/i, " ")
    .replace(/\s+(?:do|re|mi|fa|sol|la|si|[a-g](?:#|b)?m?)\s*$/i, " ");
  return slugify(withoutTone);
}

async function listSongFiles(directory, relativeDirectory = "") {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.toLocaleLowerCase("pt-BR") !== "descartados") {
        files.push(...await listSongFiles(path.join(directory, entry.name), relativePath));
      }
    } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(relativePath);
    }
  }
  return files.sort((a, b) => a.localeCompare(b, "pt-BR"));
}

async function listVoiceAudioFiles(directory, relativeDirectory = "") {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.toLocaleLowerCase("pt-BR") !== "descartados") {
        files.push(...await listVoiceAudioFiles(path.join(directory, entry.name), relativePath));
      }
    } else if (entry.isFile() && SUPPORTED_AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(relativePath);
    }
  }
  return files.sort((a, b) => a.localeCompare(b, "pt-BR"));
}

function getVoiceLabel(filename) {
  if (/contralto/i.test(filename)) return "Contralto";
  if (/tenor/i.test(filename)) return "Tenor";
  if (/melodia.*feminin|feminin.*melodia/i.test(filename)) return "Melodia feminina";
  if (/melodia.*masculin|masculin.*melodia/i.test(filename)) return "Melodia masculina";
  if (/melodia|melody/i.test(filename)) return "Melodia";
  return path.basename(filename, path.extname(filename)).replace(/[_-]+/g, " ").trim() || "Áudio";
}

// Mesma regra de agrupamento usada pelo app para ligar áudios às músicas.
function audioGroup(relativePath) {
  const folders = relativePath.split(path.sep).slice(0, -1).filter(name =>
    !/^(vocal|vocais|audio|audios)$/i.test(name.normalize("NFD").replace(/[\u0300-\u036f]/g, "")));
  const songFolder = folders.length > 1 ? folders[1] : folders[0] || "";
  return {
    folderId: folders.length > 1 ? slugify(`${folders[0]}-${songFolder}`) : slugify(songFolder),
    audioKey: audioNameKey(songFolder)
  };
}

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

async function extractText(filePath) {
  const buffer = await fs.readFile(filePath);
  if (buffer.length > MAX_DOCUMENT_SIZE) throw new Error("arquivo excede o limite de 20 MB");
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".pdf") return extractPdfText(buffer);
  if (extension === ".doc" || extension === ".docx") {
    return (await wordExtractor.extract(buffer)).getBody();
  }
  return buffer.toString("utf8");
}

function convertChordLines(lines) {
  return lines.map((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.includes("[") || trimmed.includes("]")) return line;
    const tokens = trimmed.split(/\s+/).map(token => token.replace(/^[|,;]+|[|,;]+$/g, "")).filter(Boolean);
    if (!tokens.length) return line;
    const allChords = tokens.every(token => CHORD_PATTERN.test(token.replace(/[|,;]+$/g, "")));
    const hasAdjacentLyrics = [lines[index - 1], lines[index + 1]].some(neighbor =>
      neighbor && neighbor.replace(/[\s\p{P}]/gu, "").length > 8
    );
    const hasDistinctiveChord = tokens.length > 1 || tokens.some(token => /[#b/0-9]/.test(token)) || hasAdjacentLyrics;
    return allChords && hasDistinctiveChord ? tokens.map(token => `[${token.replace(/[|,;]+$/g, "")}]`).join("   ") : line;
  });
}

function inferKey(relativePath) {
  const normalizedPath = relativePath.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const normalizedBasename = path.basename(normalizedPath, path.extname(normalizedPath));
  const notePattern = "(do|re|mi|fa|sol|la|si|[a-g](?:#|b)?m?)";
  const match = normalizedBasename.match(new RegExp(`\\(\\s*(?:tom\\s*)?${notePattern}\\s*\\)`, "i")) ||
    normalizedBasename.match(new RegExp(`(?:tonalidade|tom)\\s*[-_ ]*\\s*${notePattern}(?=$|[^a-z])`, "i")) ||
    normalizedPath.match(new RegExp(`(?:tonalidade|tom)\\s*[-_ ]*\\s*${notePattern}(?=$|[^a-z])`, "i"));
  if (!match) return "";
  const note = match[1].toLocaleLowerCase("pt-BR");
  const notes = { do: "C", re: "D", mi: "E", fa: "F", sol: "G", la: "A", si: "B" };
  return notes[note] || `${note[0].toUpperCase()}${note.slice(1)}`;
}

function parseSong(relativePath, contents) {
  const basename = path.basename(relativePath, path.extname(relativePath));
  const normalizedBasename = slugify(basename);
  if (/\bmelodia\b/i.test(basename)) {
    throw new Error("título de melodia removido do catálogo");
  }
  if (normalizedBasename === "relacao-das-musicas" ||
      normalizedBasename === "hinos-ano-novo-2024" ||
      (normalizedBasename.includes("hinario") && normalizedBasename.includes("cifrado"))) {
    throw new Error("arquivo de compilação/lista, não uma cifra individual");
  }
  const song = {
    id: `folder-${slugify(relativePath)}`,
    title: basename.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim(),
    artist: "",
    key: inferKey(relativePath),
    category: categoryForPath(relativePath),
    folder: folderForPath(relativePath),
    folderId: folderIdForPath(relativePath),
    audioKey: audioNameKey(basename),
    lyrics: ""
  };
  const lyrics = [];
  let readingLyrics = false;
  for (const line of contents.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n")) {
    const metadata = !readingLyrics && line.match(/^\s*(title|titulo|título|artist|artista|key|tom)\s*:\s*(.*?)\s*$/i);
    if (metadata) {
      const field = metadata[1].toLocaleLowerCase("pt-BR");
      if (["title", "titulo", "título"].includes(field)) song.title = metadata[2];
      else if (["artist", "artista"].includes(field)) song.artist = metadata[2];
      else song.key = metadata[2] || song.key;
      continue;
    }
    if (!readingLyrics && line.trim() === "" && lyrics.length === 0) continue;
    readingLyrics = true;
    lyrics.push(line);
  }

  song.title = cleanToneFromTitle(song.title);
  song.lyrics = convertChordLines(lyrics).join("\n").trim();
  if (!song.id || !song.title || !song.lyrics) {
    throw new Error("arquivo sem texto legível");
  }
  // Letras sem acordes reconhecíveis continuam no catálogo (como letra simples).
  const chords = [...song.lyrics.matchAll(/\[([^\]]*)\]/g)];
  if (chords.some(([, chord]) => !CHORD_PATTERN.test(chord))) {
    song.lyrics = song.lyrics.replace(/\[([^\]]*)\]/g, (match, chord) => CHORD_PATTERN.test(chord) ? match : chord);
  }
  if (song.key && !KEY_PATTERN.test(song.key)) song.key = "";
  return song;
}

function normalize(value) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").replace(/\s+/g, " ").trim();
}

function getDuplicateKey(song) {
  return `${normalize(song.title)}|${normalize(song.artist)}|${normalize(song.lyrics)}`;
}

async function main() {
  await fs.mkdir(inputDir, { recursive: true });
  const files = await listSongFiles(inputDir);
  const audioFiles = await listVoiceAudioFiles(inputDir);
  const songs = [];
  const seen = new Set();
  const failures = [];
  let duplicates = 0;

  for (const relativePath of files) {
    try {
      const song = parseSong(relativePath, await extractText(path.join(inputDir, relativePath)));
      const duplicateKey = getDuplicateKey(song);
      if (seen.has(duplicateKey)) {
        duplicates++;
        continue;
      }
      seen.add(duplicateKey);
      songs.push(song);
    } catch (error) {
      failures.push(`${relativePath}: ${error.message}`);
    }
  }

  if (!songs.length && files.length) {
    const examples = failures.slice(0, 5).join("\n");
    throw new Error(`Nenhuma música legível foi encontrada em ${files.length} documento(s).${examples ? `\n${examples}` : ""}`);
  }
  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  await fs.writeFile(outputFile, `${JSON.stringify(songs, null, 2)}\n`, "utf8");
  const audioLibrary = audioFiles.map(relativePath => {
    return {
      ...audioGroup(relativePath),
      label: getVoiceLabel(path.basename(relativePath)),
      path: relativePath.split(path.sep).join("/")
    };
  });
  await fs.writeFile(audioOutputFile, `${JSON.stringify(audioLibrary, null, 2)}\n`, "utf8");
  console.log(`${songs.length} cifra(s) importada(s) de ${files.length} documento(s) para ${path.relative(ROOT, outputFile)}.`);
  console.log(`${audioLibrary.length} áudio(s) vocal(is) indexado(s) em ${path.relative(ROOT, audioOutputFile)}.`);
  if (duplicates) console.log(`${duplicates} arquivo(s) duplicado(s) foram ignorado(s).`);
  if (failures.length) console.log(`${failures.length} arquivo(s) ignorado(s) por não conter cifra reconhecível ou não ser compatível.`);
}

main().catch(error => {
  console.error(`Erro na importação da pasta musicas: ${error.message}`);
  process.exitCode = 1;
});
