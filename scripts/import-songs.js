#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const inputDir = path.resolve(process.argv[2] || path.join(ROOT, "songs"));
const outputFile = path.resolve(process.argv[3] || path.join(ROOT, "data", "songs.json"));
const SUPPORTED_EXTENSIONS = new Set([".txt", ".md"]);
const KEY_PATTERN = /^[A-G](?:#|b)?(?:m|min|maj|sus|dim|aug)?$/i;
const CHORD_PATTERN = /^[A-G](?:#|b)?(?:[^/\]\s]+)?(?:\/[A-G](?:#|b)?)?$/;

function slugify(value) {
  return value.normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function parseSong(contents, filePath) {
  const filename = path.basename(filePath, path.extname(filePath));
  const song = {
    id: slugify(filename),
    title: filename.replace(/[-_]+/g, " ").trim(),
    artist: "",
    key: "",
    lyrics: ""
  };
  const lyrics = [];
  let readingLyrics = false;

  for (const line of contents.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n")) {
    const metadata = !readingLyrics && line.match(/^\s*(title|titulo|título|artist|artista|key|tom)\s*:\s*(.*?)\s*$/i);
    if (metadata) {
      const [, field, value] = metadata;
      const normalizedField = field.toLocaleLowerCase("pt-BR");
      if (["title", "titulo", "título"].includes(normalizedField)) song.title = value;
      else if (["artist", "artista"].includes(normalizedField)) song.artist = value;
      else if (["key", "tom"].includes(normalizedField)) song.key = value;
      continue;
    }

    if (!readingLyrics && line.trim() === "" && lyrics.length === 0) continue;
    readingLyrics = true;
    lyrics.push(line);
  }

  song.lyrics = lyrics.join("\n").trim();
  if (!song.id) throw new Error(`O nome do arquivo "${filename}" não gera um id válido.`);
  if (!song.lyrics) throw new Error(`"${filename}" não contém letra/cifra.`);
  const chordTokens = [...song.lyrics.matchAll(/\[([^\]]*)\]/g)];
  const unparsedLyrics = song.lyrics.replace(/\[[^\]]*\]/g, "");
  if (!chordTokens.length || chordTokens.some(([, chord]) => !CHORD_PATTERN.test(chord)) || /[\[\]]/.test(unparsedLyrics)) {
    throw new Error(`"${filename}" contém cifra inválida. Use acordes entre colchetes, por exemplo [G] ou [D/F#].`);
  }
  if (song.key && !KEY_PATTERN.test(song.key)) {
    throw new Error(`Tom inválido em "${filename}": "${song.key}". Use, por exemplo, G, F# ou Bb.`);
  }
  return song;
}

async function main() {
  let entries;
  try {
    entries = await fs.readdir(inputDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Pasta de entrada não encontrada: ${inputDir}\nCrie a pasta ou informe seu caminho ao executar o script.`);
    }
    throw error;
  }

  const files = entries
    .filter(entry => entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b, "pt-BR"));

  if (!files.length) {
    throw new Error(`Nenhum arquivo .txt ou .md encontrado em ${inputDir}.`);
  }

  const songs = [];
  const ids = new Set();
  for (const filename of files) {
    const song = parseSong(await fs.readFile(path.join(inputDir, filename), "utf8"), filename);
    if (ids.has(song.id)) throw new Error(`Id duplicado "${song.id}". Renomeie um dos arquivos.`);
    ids.add(song.id);
    songs.push(song);
  }

  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  await fs.writeFile(outputFile, `${JSON.stringify(songs, null, 2)}\n`, "utf8");
  console.log(`${songs.length} música(s) importada(s) para ${outputFile}`);
}

main().catch(error => {
  console.error(`Erro na importação: ${error.message}`);
  process.exitCode = 1;
});
