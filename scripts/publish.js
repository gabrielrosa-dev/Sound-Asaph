"use strict";

// Sincroniza o Drive e publica o catálogo no GitHub Pages (git add data, commit e push).
const { execFileSync } = require("node:child_process");
const { syncFromDrive } = require("./drive-sync");

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

(async () => {
  console.log("Sincronizando com o Drive (a primeira vez pode demorar alguns minutos)...");
  const result = await syncFromDrive();
  console.log(`Drive: ${result.remoteFiles} arquivos, ${result.downloaded} novos/alterados, ${result.removed} removidos.`);
  if (result.errors.length) console.warn(`Avisos:\n${result.errors.join("\n")}`);

  git("add", "data");
  if (!git("status", "--porcelain", "data")) {
    console.log("Nada mudou no catálogo. Site já está atualizado.");
    return;
  }
  git("commit", "-m", "Atualiza músicas do Drive");
  git("push");
  console.log("Publicado! O site atualiza em cerca de 1 minuto.");
})().catch(error => {
  console.error(`Falhou: ${error.message}`);
  process.exitCode = 1;
});
