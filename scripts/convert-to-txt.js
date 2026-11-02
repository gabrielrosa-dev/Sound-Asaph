#!/usr/bin/env node
"use strict";

// Converte PDF/Word da pasta musicas/ em .txt (formato lido pelo app publicado no GitHub Pages).
// Uso: npm run converter [-- --local] [-- --upload]
//   --local   não baixa do Drive; usa o que já está em musicas/
//   --upload  envia os .txt para a mesma pasta do Drive de cada original
const fs = require("node:fs/promises");
const path = require("node:path");
const { syncFromDrive, hasCredentials, uploadTexts } = require("./drive-sync");
const { parseSong, extractText, listSongFiles, getDuplicateKey, inputDir } = require("./import-folder-songs");

const OUTPUT_DIR = path.resolve(__dirname, "..", "cifras-convertidas");
const DOCUMENT_EXTENSIONS = new Set([".pdf", ".doc", ".docx"]);

async function main() {
  const flags = new Set(process.argv.slice(2));
  if (!flags.has("--local") && await hasCredentials()) {
    console.log("Baixando a pasta do Drive...");
    await syncFromDrive();
  }
  const files = await listSongFiles(inputDir).catch(error => {
    if (error.code === "ENOENT") throw new Error("A pasta musicas/ não existe. Configure a conta de serviço (credentials/service-account.json) para baixar do Drive ou copie os arquivos para musicas/.");
    throw error;
  });
  const withoutExtension = file => file.slice(0, file.length - path.extname(file).length).toLowerCase();
  const existingTexts = new Set(files.filter(file => !DOCUMENT_EXTENSIONS.has(path.extname(file).toLowerCase())).map(withoutExtension));
  // Word tem prioridade sobre PDF quando ambos existem para a mesma música.
  const rank = file => path.extname(file).toLowerCase() === ".pdf" ? 1 : 0;
  const documents = files.filter(file => DOCUMENT_EXTENSIONS.has(path.extname(file).toLowerCase()))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, "pt-BR"));

  const written = new Set();
  const seen = new Set();
  const items = [];
  const report = { alreadyText: 0, duplicates: 0, noChords: [], failures: [] };
  await fs.rm(OUTPUT_DIR, { recursive: true, force: true });
  for (const relative of documents) {
    const key = withoutExtension(relative);
    if (existingTexts.has(key) || written.has(key)) {
      report.alreadyText++;
      continue;
    }
    try {
      const song = parseSong(relative, await extractText(path.join(inputDir, relative)));
      const duplicateKey = getDuplicateKey(song);
      if (seen.has(duplicateKey)) {
        report.duplicates++;
        continue;
      }
      seen.add(duplicateKey);
      written.add(key);
      const name = `${path.basename(relative, path.extname(relative))}.txt`;
      const text = `Title: ${song.title}\nArtist: ${song.artist}\nKey: ${song.key}\n\n${song.lyrics}\n`;
      const target = path.join(OUTPUT_DIR, path.dirname(relative), name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, text, "utf8");
      items.push({ source: relative, name, text });
      if (!song.lyrics.includes("[")) report.noChords.push(relative);
    } catch (error) {
      report.failures.push(`${relative}: ${error.message}`);
    }
  }

  const lines = [
    `Convertidos: ${items.length}`,
    `Já tinham .txt/.md: ${report.alreadyText}`,
    `Duplicados ignorados: ${report.duplicates}`,
    `Sem acordes reconhecidos (revisar): ${report.noChords.length}`,
    ...report.noChords.map(file => `  - ${file}`),
    `Falhas: ${report.failures.length}`,
    ...report.failures.map(failure => `  - ${failure}`)
  ];
  if (items.length) await fs.writeFile(path.join(OUTPUT_DIR, "RELATORIO.txt"), `${lines.join("\n")}\n`, "utf8");
  console.log(lines.join("\n"));
  console.log(`\nArquivos gerados em ${path.relative(process.cwd(), OUTPUT_DIR) || OUTPUT_DIR}`);

  if (flags.has("--upload") && items.length) {
    console.log("\nEnviando para o Drive...");
    const result = await uploadTexts(items);
    console.log(`${result.uploaded} enviado(s), ${result.existing} já existiam, ${result.errors.length} erro(s).`);
    for (const error of result.errors.slice(0, 10)) console.log(`  - ${error}`);
    if (result.errors.length) {
      console.log("Se o erro for de cota/permissão, copie o conteúdo de cifras-convertidas para as mesmas pastas no Drive (Drive para computador) ou use um Drive compartilhado com a conta de serviço como Editor.");
    }
  } else if (items.length) {
    console.log("Copie os .txt para as mesmas pastas do Drive ou rode novamente com: npm run converter -- --local --upload");
  }
}

main().catch(error => {
  console.error(`Erro na conversão: ${error.message}`);
  process.exitCode = 1;
});
