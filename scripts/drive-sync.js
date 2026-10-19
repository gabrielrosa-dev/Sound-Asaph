"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const MUSIC_DIR = path.join(ROOT, "musicas");
const MANIFEST_FILE = path.join(MUSIC_DIR, ".drive-manifest.json");
const CREDENTIALS_FILE = path.resolve(ROOT, process.env.GOOGLE_APPLICATION_CREDENTIALS || "credentials/service-account.json");
const FOLDER_MIME = "application/vnd.google-apps.folder";
const DOC_MIME = "application/vnd.google-apps.document";
const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";
const DOWNLOADABLE = new Set([".txt", ".md", ".pdf", ".doc", ".docx", ".mp3", ".mp4", ".mpeg", ".ogg", ".wav", ".m4a"]);
const MAX_FILE_SIZE = 200 * 1024 * 1024;

function readFolderId() {
  if (process.env.DRIVE_FOLDER_ID) return process.env.DRIVE_FOLDER_ID;
  return require("node:fs").readFileSync(path.join(ROOT, "drive-config.js"), "utf8").match(/driveFolderId:\s*"([^"]+)"/)?.[1] || "";
}

async function loadCredentials() {
  try {
    const credentials = JSON.parse(await fs.readFile(CREDENTIALS_FILE, "utf8"));
    if (!credentials.client_email || !credentials.private_key) throw new Error("incompleto");
    return credentials;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Arquivo de credenciais inválido (${path.relative(ROOT, CREDENTIALS_FILE)}). Baixe novamente a chave JSON da conta de serviço.`);
  }
}

async function hasCredentials() {
  try {
    return Boolean(await loadCredentials());
  } catch {
    return true;
  }
}

const base64url = value => Buffer.from(value).toString("base64url");

async function getAccessToken(credentials) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({
    iss: credentials.client_email,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  }));
  const signature = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), credentials.private_key).toString("base64url");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${signature}`
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Falha na autenticação com o Google: ${body.error_description || body.error || response.status}`);
  return body.access_token;
}

async function driveGet(url, token, asBuffer = false) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(`Google Drive (${response.status}): ${body.error?.message || "erro desconhecido"}`);
  }
  return asBuffer ? Buffer.from(await response.arrayBuffer()) : response.json();
}

async function listFolder(folderId, token) {
  const items = [];
  let pageToken;
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken,files(id,name,mimeType,size,version,modifiedTime,md5Checksum,shortcutDetails)",
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true"
    });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await driveGet(`https://www.googleapis.com/drive/v3/files?${params}`, token);
    items.push(...page.files);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return items;
}

async function walk(rootId, token) {
  const files = [];
  const queue = [{ id: rootId, parts: [] }];
  const visited = new Set();
  while (queue.length) {
    const folder = queue.shift();
    if (visited.has(folder.id)) continue;
    visited.add(folder.id);
    for (const item of await listFolder(folder.id, token)) {
      if (item.mimeType === FOLDER_MIME) queue.push({ id: item.id, parts: [...folder.parts, safeName(item.name)] });
      else if (item.mimeType !== SHORTCUT_MIME) files.push({ ...item, parts: folder.parts });
    }
  }
  return files;
}

function safeName(name) {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "").trim() || "_";
}

function targetFor(file) {
  let name = safeName(file.name);
  if (file.mimeType === DOC_MIME) return { name: `${name}.txt`, download: `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text%2Fplain` };
  const extension = path.extname(name).toLowerCase();
  if (!DOWNLOADABLE.has(extension)) return null;
  if (Number(file.size) > MAX_FILE_SIZE) return null;
  return { name, download: `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&supportsAllDrives=true` };
}

async function readManifest() {
  try {
    return JSON.parse(await fs.readFile(MANIFEST_FILE, "utf8"));
  } catch {
    return {};
  }
}

function runImport() {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(__dirname, "import-folder-songs.js")], { cwd: ROOT, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || stdout || error.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

async function syncFromDrive() {
  const credentials = await loadCredentials();
  if (!credentials) {
    throw new Error("Credenciais do Google não encontradas. Siga o passo a passo do README e salve a chave em credentials/service-account.json.");
  }
  const folderId = readFolderId();
  if (!folderId) throw new Error("ID da pasta do Drive não configurado em drive-config.js.");
  const token = await getAccessToken(credentials);
  let remoteFiles;
  try {
    remoteFiles = await walk(folderId, token);
  } catch (error) {
    if (/404/.test(error.message)) {
      throw new Error(`A pasta não foi encontrada. Compartilhe-a com ${credentials.client_email} (permissão de leitor). ${error.message}`);
    }
    throw error;
  }

  const previous = await readManifest();
  const manifest = {};
  const errors = [];
  let downloaded = 0;
  const seenPaths = new Set();
  for (const file of remoteFiles) {
    const target = targetFor(file);
    if (!target) continue;
    const relative = path.join(...file.parts, target.name);
    if (seenPaths.has(relative.toLowerCase())) continue;
    seenPaths.add(relative.toLowerCase());
    const fingerprint = file.md5Checksum || `${file.version}:${file.modifiedTime}`;
    const absolute = path.join(MUSIC_DIR, relative);
    manifest[file.id] = { path: relative, fingerprint };
    const unchanged = previous[file.id]?.fingerprint === fingerprint && previous[file.id]?.path === relative &&
      await fs.stat(absolute).then(() => true, () => false);
    if (unchanged) continue;
    try {
      const buffer = await driveGet(target.download, token, true);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, buffer);
      downloaded++;
      if (previous[file.id] && previous[file.id].path !== relative) {
        await fs.rm(path.join(MUSIC_DIR, previous[file.id].path), { force: true });
      }
    } catch (error) {
      delete manifest[file.id];
      errors.push(`${relative}: ${error.message}`);
    }
  }

  let removed = 0;
  for (const [id, entry] of Object.entries(previous)) {
    if (!manifest[id] && !errors.some(message => message.startsWith(`${entry.path}:`))) {
      await fs.rm(path.join(MUSIC_DIR, entry.path), { force: true });
      removed++;
    } else if (!manifest[id]) manifest[id] = entry;
  }
  await fs.mkdir(MUSIC_DIR, { recursive: true });
  await fs.writeFile(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
  const importLog = await runImport();
  return { remoteFiles: remoteFiles.length, downloaded, removed, errors, importLog };
}

module.exports = { syncFromDrive, runImport, hasCredentials, MUSIC_DIR };
