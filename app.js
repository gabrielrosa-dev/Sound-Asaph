const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_NAMES = { "C#": "Db", "D#": "Eb", "F#": "Gb", "G#": "Ab", "A#": "Bb" };
const CHORD_PATTERN = /\[([A-G](?:#|b)?(?:[^/\]\s]+)?(?:\/[A-G](?:#|b)?)?)\]/g;
const CHORD_TOKEN_PATTERN = /^[A-G](?:#|b)?(?:[^/\]\s]+)?(?:\/[A-G](?:#|b)?)?$/;
const KEY_PATTERN = /^[A-G](?:#|b)?(?:m|min|maj|sus|dim|aug)?$/i;

const songList = document.querySelector("#song-list");
const lyricsElement = document.querySelector("#lyrics");
const searchInput = document.querySelector("#song-search");
const capoSelect = document.querySelector("#capo-select");
let songs = [];
let bundledFolderSongs = [];
let selectedSongId = null;
let activeCategory = "all";
let currentRole = null;
let audioAssets = [];
let transposeSteps = 0;
let fontSize = 17;
let scrollTimer = null;
let scrollDirection = 1;
let toastTimer = null;
let audioDatabasePromise;
let activeAudioObjectUrls = [];
let sundaySongIds = loadSundaySetlist();
let hasDriveCatalog = false;
let driveAccessToken = null;
let googleIdentityScript;
const DRIVE_SONGS_CACHE_KEY = "sound-asaph-drive-songs";
const LOCAL_SONGS_CACHE_KEY = "sound-asaph-local-songs";
const SONG_EDITS_CACHE_KEY = "sound-asaph-song-edits";
const DEMO_ROLE_CACHE_KEY = "sound-asaph-demo-role";
const DELETED_SONGS_CACHE_KEY = "sound-asaph-demo-deleted-songs";
const AUDIO_SETTINGS_CACHE_KEY = "sound-asaph-audio-settings";
const STAGE_MODE_CACHE_KEY = "sound-asaph-stage-mode";
const DEMO_PASSWORD = "123";
const ROLE_LABELS = { admin: "Admin", musico: "Músico", vocal: "Vocal" };
const AUDIO_DATABASE_NAME = "sound-asaph-audio-library";
const AUDIO_STORE_NAME = "tracks";
const MAX_LOCAL_AUDIO_SIZE = 100 * 1024 * 1024;
currentRole = loadDemoRole();
const SONG_CATEGORIES = {
  all: "Todas as músicas",
  sunday: "Louvor de Domingo",
  hinario: "Hinário",
  "datas-especiais": "Datas Especiais",
  preparacao: "Músicas em Preparação",
  repertorio: "Músicas"
};
const GOOGLE_DOCUMENT_MIME = "application/vnd.google-apps.document";
const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";
const SUPPORTED_DRIVE_EXTENSIONS = new Set([".txt", ".md", ".pdf", ".doc", ".docx"]);
const MAX_DRIVE_FILE_SIZE = 20 * 1024 * 1024;
const MAX_DRIVE_AUDIO_SIZE = 100 * 1024 * 1024;
const SUPPORTED_DRIVE_AUDIO_EXTENSIONS = new Set([".mp3", ".mp4", ".mpeg", ".ogg", ".wav", ".m4a"]);

function noteIndex(note) {
  const normalized = note.replace("b", "#");
  const enharmonic = { "Db": "C#", "Eb": "D#", "Gb": "F#", "Ab": "G#", "Bb": "A#", "Cb": "B", "Fb": "E", "E#": "F", "B#": "C" };
  const canonical = enharmonic[note] || normalized;
  return NOTES.indexOf(canonical);
}

function formatNote(index, preferFlats) {
  const note = NOTES[(index % 12 + 12) % 12];
  return preferFlats && FLAT_NAMES[note] ? FLAT_NAMES[note] : note;
}

function transposeChord(chord, steps) {
  const parts = chord.split("/");
  const root = chord.match(/^[A-G](?:#|b)?/)?.[0];
  const preferFlats = chord.includes("b") || (steps === 0 && ["F", "Bb", "Eb", "Ab", "Db", "Gb"].includes(root));
  const transposePart = part => part.replace(/^([A-G](?:#|b)?)/, (root) => {
    const index = noteIndex(root);
    return index < 0 ? root : formatNote(index + steps, preferFlats);
  });
  return parts.map(transposePart).join("/");
}

function currentSong() {
  return songs.find(song => song.id === selectedSongId);
}

function cleanToneFromTitle(title) {
  return title.normalize("NFC")
    .replace(/\s*\(\s*(?:d[oó]|r[eé]|m[ií]|f[aá]|sol|l[aá]|si|[a-g](?:#|b)?m?)\s*\)/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function normalizeIntroChords(lyrics) {
  const lines = lyrics.split("\n");
  let pendingIntro = false;
  const wrapChordTokens = line => line.split(/(\s+)/).map(token => {
    if (!token || /^\s+$/.test(token)) return token;
    let start = 0;
    let end = token.length;
    while (start < end && /[([{|]/.test(token[start])) start++;
    while (end > start && /[,;:.)\]}|]/.test(token[end - 1])) end--;
    const chord = token.slice(start, end);
    if (!CHORD_TOKEN_PATTERN.test(chord)) return token;
    return `${token.slice(0, start)}[${chord}]${token.slice(end)}`;
  }).join("");

  return lines.map(line => {
    const intro = line.match(/^(\s*intro(?:du[cç][aã]o)?\s*:?\s*)(.*)$/i);
    if (intro) {
      if (!intro[2].trim()) {
        pendingIntro = true;
        return line;
      }
      pendingIntro = false;
      return `${intro[1]}${wrapChordTokens(intro[2])}`;
    }
    if (pendingIntro && line.trim()) {
      pendingIntro = false;
      const tokens = line.trim().split(/\s+/);
      const isChordSequence = tokens.length > 0 && tokens.every(token => {
        const trimmed = token.replace(/^[([{|]+|[,;:.)\]}|]+$/g, "");
        return CHORD_TOKEN_PATTERN.test(trimmed) || /^\(?\d+x\)?$/i.test(trimmed) || /^x\d+$/i.test(trimmed);
      });
      if (isChordSequence && ![...line.matchAll(CHORD_PATTERN)].length) return wrapChordTokens(line);
    }
    return line;
  }).join("\n");
}

function displayKey(song, steps = transposeSteps) {
  const key = song.key || "";
  if (!key) return "—";
  const index = noteIndex(key);
  return index < 0 ? key : formatNote(index + steps, key.includes("b"));
}

function renderLyrics() {
  const song = currentSong();
  if (!song) return;
  const isVocalRole = currentRole === "vocal";
  const capo = Number(capoSelect.value);
  const transpose = transposeSteps - capo;
  lyricsElement.replaceChildren();
  for (const line of normalizeIntroChords(song.lyrics).split("\n")) {
    const lineElement = document.createElement("div");
    lineElement.className = "lyric-line";
    if (isVocalRole) {
      const lyricsOnly = line.replace(CHORD_PATTERN, "").replace(/\s+$/g, "");
      if (!lyricsOnly.trim() && line.trim()) continue;
      lineElement.textContent = lyricsOnly || "\u00a0";
      lyricsElement.append(lineElement);
      continue;
    }
    let lastIndex = 0;
    for (const match of line.matchAll(CHORD_PATTERN)) {
      const [token, chord] = match;
      const start = match.index;
      if (start > lastIndex) lineElement.append(document.createTextNode(line.slice(lastIndex, start)));
      const chordElement = document.createElement("span");
      chordElement.className = "chord";
      chordElement.textContent = transposeChord(chord, transpose);
      lineElement.append(chordElement);
      lastIndex = start + token.length;
    }
    if (lastIndex < line.length) lineElement.append(document.createTextNode(line.slice(lastIndex)));
    if (!line) lineElement.append(document.createTextNode("\u00a0"));
    lyricsElement.append(lineElement);
  }
  const desiredKey = displayKey(song);
  const shapeKey = displayKey(song, transpose);
  document.querySelector(".song-toolbar").hidden = isVocalRole;
  document.querySelector("#key-summary").hidden = isVocalRole;
  document.querySelector("#song-original-key").hidden = isVocalRole;
  const toplineLabel = document.querySelector(".lyrics-topline-label");
  toplineLabel.replaceChildren();
  if (!isVocalRole) {
    const statusDot = document.createElement("span");
    statusDot.className = "status-dot";
    toplineLabel.append(statusDot, document.createTextNode(" CIFRA"));
  } else {
    toplineLabel.textContent = "LETRA";
  }
  document.querySelector("#copy-button").setAttribute("aria-label", isVocalRole ? "Copiar letra" : "Copiar cifra");
  document.querySelector("#copy-button").title = isVocalRole ? "Copiar letra" : "Copiar cifra";
  renderVoiceAudio(song);
  document.querySelector("#current-key").textContent = capo ? shapeKey : desiredKey;
  document.querySelector("#song-original-key").textContent = `TOM ORIGINAL ${song.key || "—"}`;
  const keySummary = document.querySelector("#key-summary");
  keySummary.replaceChildren();
  const addSummaryText = text => keySummary.append(document.createTextNode(text));
  const addSummaryKey = key => {
    const strong = document.createElement("strong");
    strong.textContent = key;
    keySummary.append(strong);
  };
  if (capo) {
    addSummaryText("Tom desejado: ");
    addSummaryKey(desiredKey);
    addSummaryText(" · Formas com capo: ");
    addSummaryKey(shapeKey);
    addSummaryText(` · Capo na casa ${capo}`);
  } else {
    addSummaryText("Tom atual: ");
    addSummaryKey(desiredKey);
    if (transposeSteps) addSummaryText(` · ${transposeSteps > 0 ? "+" : ""}${transposeSteps} semitom${Math.abs(transposeSteps) === 1 ? "" : "s"} do original`);
  }
}

function renderVoiceAudio(song) {
  const section = document.querySelector("#voice-audio");
  const list = document.querySelector("#voice-audio-list");
  const showAudio = currentRole === "vocal" || currentRole === "admin";
  const isAdmin = currentRole === "admin";
  for (const objectUrl of activeAudioObjectUrls) URL.revokeObjectURL(objectUrl);
  activeAudioObjectUrls = [];
  section.hidden = !showAudio;
  document.querySelector("#voice-audio-title").textContent = isAdmin ? "GERENCIAR ÁUDIOS VOCAIS" : "ÁUDIOS PARA TREINO VOCAL";
  document.querySelector("#voice-audio-note").textContent = isAdmin
    ? "Alterações ficam salvas somente neste navegador."
    : "Reprodução sem alteração de tom";
  const addButton = document.querySelector("#add-voice-audio");
  addButton.hidden = !isAdmin;
  addButton.onclick = () => document.querySelector("#voice-audio-file-input").click();
  list.replaceChildren();
  if (!showAudio) return;

  const settings = loadAudioSettings();
  const tracks = audioAssets.filter(track =>
    track.folderId === song.folderId || (song.audioKey && track.audioKey === song.audioKey)
  ).filter(track => !settings.hiddenIds.includes(track.local ? track.id : bundledAudioId(track)));
  if (!tracks.length) {
    const empty = document.createElement("span");
    empty.className = "voice-audio-empty";
    empty.textContent = isAdmin
      ? "Nenhum áudio para esta música. Use “Adicionar áudio” para incluir um arquivo."
      : "Nenhum áudio vocal cadastrado para esta música.";
    list.append(empty);
    return;
  }

  for (const track of tracks) {
    const card = document.createElement("div");
    card.className = "voice-audio-track";
    const heading = document.createElement("div");
    heading.className = "voice-audio-track-heading";
    const label = document.createElement("strong");
    const trackId = track.local ? track.id : bundledAudioId(track);
    label.textContent = settings.labels[trackId] || track.label;
    heading.append(label);
    const extension = track.local
      ? audioFileExtension(track.fileName)
      : audioFileExtension(track.path);
    const player = document.createElement(extension === ".mp4" ? "video" : "audio");
    player.controls = !track.drive;
    player.preload = "none";
    player.setAttribute("aria-label", `Reproduzir áudio ${label.textContent} de ${song.title}`);
    if (track.local && track.blob instanceof Blob) {
      const objectUrl = URL.createObjectURL(track.blob);
      activeAudioObjectUrls.push(objectUrl);
      player.src = objectUrl;
    } else if (track.drive) {
      const playDriveAudio = document.createElement("button");
      playDriveAudio.className = "voice-audio-action";
      playDriveAudio.type = "button";
      playDriveAudio.textContent = "Baixar e reproduzir";
      playDriveAudio.addEventListener("click", async () => {
        if (!driveAccessToken) {
          showToast("Conecte e sincronize o Google Drive novamente para reproduzir este áudio.");
          return;
        }
        if (Number(track.size) > MAX_DRIVE_AUDIO_SIZE) {
          showToast("Este áudio excede o limite de 100 MB para reprodução no navegador.");
          return;
        }
        playDriveAudio.disabled = true;
        playDriveAudio.textContent = "Carregando áudio...";
        try {
          const response = await driveFetch(
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(track.id)}?alt=media`,
            driveAccessToken
          );
          const objectUrl = URL.createObjectURL(await response.blob());
          activeAudioObjectUrls.push(objectUrl);
          player.src = objectUrl;
          player.controls = true;
          playDriveAudio.hidden = true;
          await player.play();
        } catch (error) {
          console.error("Não foi possível carregar o áudio do Google Drive.", error);
          playDriveAudio.disabled = false;
          playDriveAudio.textContent = "Tentar reproduzir novamente";
          showToast(error.message || "Não foi possível carregar o áudio do Drive.");
        }
      });
      card.append(heading, playDriveAudio, player);
    } else {
      player.src = `musicas/${track.path.split("/").map(encodeURIComponent).join("/")}`;
    }
    if (!track.drive) card.append(heading, player);
    if (isAdmin) {
      const actions = document.createElement("div");
      actions.className = "voice-audio-track-actions";
      actions.append(
        createVoiceAudioAction("Renomear", () => renameVoiceAudio(track, label.textContent)),
        createVoiceAudioAction("Substituir arquivo", () => {
          const input = document.querySelector("#voice-audio-replace-input");
          input.dataset.trackId = trackId;
          input.click();
        }),
        createVoiceAudioAction("Apagar", () => deleteVoiceAudio(track))
      );
      card.append(actions);
    }
    list.append(card);
  }
}

function loadStageMode() {
  try {
    return localStorage.getItem(STAGE_MODE_CACHE_KEY) === "true";
  } catch (error) {
    console.error("Não foi possível carregar a preferência de modo palco.", error);
    return false;
  }
}

function setStageMode(enabled, persist = false) {
  document.body.classList.toggle("stage-mode", enabled);
  const toggle = document.querySelector("#stage-toggle");
  toggle.setAttribute("aria-pressed", String(enabled));
  document.querySelector("#stage-toggle-label").textContent = enabled ? "Modo claro" : "Modo palco";
  if (persist) localStorage.setItem(STAGE_MODE_CACHE_KEY, String(enabled));
}

let pendingInstallPrompt = null;

function setInstallButtonState(installed) {
  const button = document.querySelector("#install-app-button");
  button.hidden = installed;
}

function openInstallDialog() {
  const dialog = document.querySelector("#install-dialog");
  const installButton = document.querySelector("#install-confirm-button");
  const status = document.querySelector("#install-status");
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

  installButton.hidden = !pendingInstallPrompt;
  status.textContent = isStandalone
    ? "O Sound-Asaph já está instalado neste dispositivo."
    : isIOS
      ? "No iOS, use o Safari e siga os passos acima; o iPhone não oferece instalação pelo botão desta página."
      : pendingInstallPrompt
        ? "Seu navegador permite instalar diretamente pelo botão abaixo."
        : "Se não aparecer a opção de instalação do navegador, siga as instruções do seu dispositivo.";
  dialog.showModal();
}

async function installSoundAsaph() {
  if (!pendingInstallPrompt) return;
  const promptEvent = pendingInstallPrompt;
  pendingInstallPrompt = null;
  document.querySelector("#install-confirm-button").hidden = true;
  try {
    await promptEvent.prompt();
    const choice = await promptEvent.userChoice;
    document.querySelector("#install-status").textContent = choice.outcome === "accepted"
      ? "Instalação solicitada. Procure o Sound-Asaph na tela inicial ou na lista de aplicativos."
      : "Instalação cancelada. Você pode tentar novamente pelo menu do navegador.";
  } catch (error) {
    console.error("Não foi possível iniciar a instalação do aplicativo.", error);
    document.querySelector("#install-status").textContent = "O navegador não concluiu a instalação. Use o menu do navegador ou siga as instruções acima.";
  }
}

function setupInstallableApp() {
  const button = document.querySelector("#install-app-button");
  const dialog = document.querySelector("#install-dialog");
  const installed = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  setInstallButtonState(installed);
  button.addEventListener("click", openInstallDialog);
  document.querySelector("#install-confirm-button").addEventListener("click", installSoundAsaph);
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    pendingInstallPrompt = event;
    if (dialog.open) openInstallDialog();
  });
  window.addEventListener("appinstalled", () => {
    pendingInstallPrompt = null;
    setInstallButtonState(true);
    if (dialog.open) dialog.close();
    showToast("Sound-Asaph instalado neste dispositivo.");
  });
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
    navigator.serviceWorker.register(new URL("./service-worker.js", location.href), { scope: new URL("./", location.href).pathname })
      .catch(error => {
        console.error("Não foi possível preparar o Sound-Asaph para uso offline.", error);
      });
  }
}

function setRoleInterface() {
  document.body.dataset.role = currentRole || "";
  document.querySelector("#profile-label").textContent = ROLE_LABELS[currentRole] || "Perfil";
  document.querySelector("#song-import-button").hidden = currentRole !== "admin";
  document.querySelector("#drive-sync-button").hidden = currentRole !== "admin";
  document.querySelector("#welcome-drive-button").hidden = currentRole !== "admin";
  document.querySelector("#edit-song-button").hidden = !currentRole;
  document.querySelector("#delete-song-button").hidden = currentRole !== "admin";
  if (currentRole && currentSong()) {
    renderCatalog(searchInput.value);
    renderLyrics();
  }
}

function loadDemoRole() {
  try {
    const savedRole = localStorage.getItem(DEMO_ROLE_CACHE_KEY);
    return Object.hasOwn(ROLE_LABELS, savedRole) ? savedRole : null;
  } catch (error) {
    console.error("Não foi possível carregar o perfil de demonstração.", error);
    return null;
  }
}

function loadDeletedSongIds() {
  try {
    const stored = localStorage.getItem(DELETED_SONGS_CACHE_KEY);
    if (stored === null) return [];
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed) || parsed.some(id => typeof id !== "string")) {
      throw new Error("A lista de músicas ocultas na demonstração não é válida.");
    }
    return [...new Set(parsed)];
  } catch (error) {
    console.error("Não foi possível carregar músicas removidas da demonstração.", error);
    return [];
  }
}

function visibleSongs() {
  const deletedIds = new Set(loadDeletedSongIds());
  return songs.filter(song => !deletedIds.has(song.id) && !/\bmelodia\b/i.test(song.title));
}

function loginDemoRole(event) {
  event.preventDefault();
  const role = document.querySelector("#login-role").value;
  const password = document.querySelector("#login-password").value;
  const error = document.querySelector("#login-error");
  if (!Object.hasOwn(ROLE_LABELS, role) || password !== DEMO_PASSWORD) {
    error.textContent = "Perfil ou senha incorretos.";
    error.hidden = false;
    return;
  }
  try {
    localStorage.setItem(DEMO_ROLE_CACHE_KEY, role);
  } catch (storageError) {
    console.error("Não foi possível salvar o perfil neste navegador.", storageError);
    error.textContent = "Não foi possível guardar o perfil neste navegador.";
    error.hidden = false;
    return;
  }
  currentRole = role;
  document.querySelector("#login-password").value = "";
  error.hidden = true;
  document.querySelector("#login-dialog").close();
  setRoleInterface();
  showToast(`Perfil ${ROLE_LABELS[role]} da demonstração ativado.`);
}

function logoutDemoRole() {
  currentRole = null;
  try {
    localStorage.removeItem(DEMO_ROLE_CACHE_KEY);
  } catch (error) {
    console.error("Não foi possível remover o perfil salvo.", error);
    showToast("Não foi possível remover o perfil salvo neste navegador.");
  }
  setRoleInterface();
  document.querySelector("#login-dialog").showModal();
}

async function deleteCurrentSong() {
  if (currentRole !== "admin") return;
  const song = currentSong();
  if (!song || !window.confirm(song.driveFileId
    ? `Apagar "${song.title}" do Google Drive compartilhado e deste catálogo?`
    : `Remover "${song.title}" deste navegador? A mudança não afeta os outros dispositivos.`)) return;
  if (song.driveFileId) {
    const { googleClientId } = window.SOUND_ASAPH_CONFIG || {};
    if (!googleClientId) {
      showToast("Configure o Client ID para apagar esta música do Drive.");
      return;
    }
    try {
      const accessToken = await requestDriveAccessToken(googleClientId);
      const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(song.driveFileId)}?supportsAllDrives=true`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (!response.ok) throw new Error(`O Google Drive recusou a exclusão (erro ${response.status}).`);
    } catch (error) {
      console.error("Não foi possível apagar a música do Google Drive.", error);
      showToast(error.message || "Não foi possível apagar a música do Drive.");
      return;
    }
  }
  const deletedIds = new Set(loadDeletedSongIds());
  deletedIds.add(song.id);
  try {
    localStorage.setItem(DELETED_SONGS_CACHE_KEY, JSON.stringify([...deletedIds]));
  } catch (error) {
    console.error("Não foi possível remover a música da demonstração.", error);
    showToast("Não foi possível guardar a remoção neste navegador.");
    return;
  }
  sundaySongIds = sundaySongIds.filter(id => id !== song.id);
  saveSundaySetlist();
  const nextSong = visibleSongs().find(item => item.id !== song.id);
  if (nextSong) selectSong(nextSong.id);
  else {
    selectedSongId = null;
    document.querySelector("#song-title").textContent = "Nenhuma música disponível";
    document.querySelector("#breadcrumb-title").textContent = "Catálogo vazio";
    lyricsElement.replaceChildren();
  }
  renderCatalog(searchInput.value);
  showToast(song.driveFileId ? "Música apagada do Google Drive compartilhado." : "Música removida somente deste navegador.");
}

function renderCatalog(filter = "") {
  const normalizedFilter = filter.trim().toLocaleLowerCase("pt-BR");
  const catalogSongs = visibleSongs();
  const sundaySongs = sundaySongIds.map(id => catalogSongs.find(song => song.id === id)).filter(Boolean);
  const categorySongs = activeCategory === "sunday"
    ? sundaySongs
    : activeCategory === "all"
      ? catalogSongs
      : catalogSongs.filter(song => (song.category || "repertorio") === activeCategory);
  const filteredSongs = categorySongs.filter(song => {
    const searchable = `${song.title} ${song.artist || ""}`.toLocaleLowerCase("pt-BR");
    return searchable.includes(normalizedFilter);
  });
  document.querySelector("#song-count").textContent = `${filteredSongs.length} ${filteredSongs.length === 1 ? "música" : "músicas"}`;
  document.querySelector("#hinario-count").textContent = String(catalogSongs.filter(song => song.category === "hinario").length);
  document.querySelector("#datas-especiais-count").textContent = String(catalogSongs.filter(song => song.category === "datas-especiais").length);
  document.querySelector("#preparacao-count").textContent = String(catalogSongs.filter(song => song.category === "preparacao").length);
  document.querySelector("#repertorio-count").textContent = String(catalogSongs.filter(song => (song.category || "repertorio") === "repertorio").length);
  document.querySelector("#sunday-category").setAttribute("aria-pressed", String(activeCategory === "sunday"));
  for (const button of document.querySelectorAll(".sidebar-category[data-category]")) {
    button.setAttribute("aria-pressed", String(button.dataset.category === activeCategory));
  }
  renderSundaySetlist();
  songList.innerHTML = "";
  if (activeCategory === "sunday" && !normalizedFilter) {
    songList.innerHTML = '<div class="empty-search">As músicas selecionadas aparecem em Louvor de Domingo.</div>';
    return;
  }
  if (!filteredSongs.length) {
    const emptyMessage = activeCategory === "datas-especiais" && !normalizedFilter
      ? "Nenhuma cifra reconhecida nesta categoria. Adicione uma cifra compatível pelo botão Importar Músicas."
      : "Nenhuma música encontrada.<br>Experimente outro nome.";
    songList.innerHTML = `<div class="empty-search">${emptyMessage}</div>`;
    return;
  }

  if (activeCategory === "all" || activeCategory === "sunday") {
    for (const song of filteredSongs) songList.append(createSongRow(song, false));
    return;
  }

  const groups = new Map();
  for (const song of filteredSongs) {
    const groupName = song.folder || "Outras músicas";
    if (!groups.has(groupName)) groups.set(groupName, []);
    groups.get(groupName).push(song);
  }
  for (const [groupName, groupSongs] of groups) {
    const heading = document.createElement("div");
    heading.className = "song-group-heading";
    heading.textContent = groupName;
    songList.append(heading);
    for (const song of groupSongs) songList.append(createSongRow(song, false));
  }
}

function createSongRow(song, isSetlist) {
  const row = document.createElement("div");
  row.className = "song-row";
  const button = document.createElement("button");
  button.type = "button";
  button.className = `song-link${song.id === selectedSongId ? " active" : ""}`;
  button.setAttribute("aria-current", song.id === selectedSongId ? "true" : "false");
  const initial = document.createElement("span");
  initial.className = "song-initial";
  initial.textContent = song.title.trim().charAt(0).toLocaleUpperCase("pt-BR");
  const copy = document.createElement("span");
  copy.className = "song-link-copy";
  const title = document.createElement("span");
  title.className = "song-link-title";
  title.textContent = song.title;
  const artist = document.createElement("span");
  artist.className = "song-link-artist";
  artist.textContent = song.artist || "Ministério de louvor";
  copy.append(title, artist);
  button.append(initial, copy);
  button.addEventListener("click", () => selectSong(song.id));
  row.append(button);

  if (song.id === selectedSongId && !isSetlist) {
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "song-action edit-action";
    editButton.textContent = "✎";
    editButton.setAttribute("aria-label", `Editar cifra: ${song.title}`);
    editButton.title = "Editar cifra";
    editButton.addEventListener("click", () => openSongEditor(song));
    row.append(editButton);
  }

  const action = document.createElement("button");
  action.type = "button";
  action.className = "song-action";
  action.textContent = isSetlist ? "−" : "+";
  action.setAttribute("aria-label", `${isSetlist ? "Remover do" : "Adicionar ao"} louvor de domingo: ${song.title}`);
  action.title = isSetlist ? "Remover do louvor de domingo" : "Adicionar ao louvor de domingo";
  action.addEventListener("click", () => toggleSundaySong(song.id));
  row.append(action);
  return row;
}

function loadSundaySetlist() {
  try {
    const stored = localStorage.getItem("sound-asaph-sunday-setlist");
    if (stored === null) return [];
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed) || parsed.some(id => typeof id !== "string")) {
      throw new Error("O formato da lista de louvor de domingo não é válido.");
    }
    return [...new Set(parsed)];
  } catch (error) {
    console.error("Não foi possível carregar a lista de louvor de domingo.", error);
    return [];
  }
}

function saveSundaySetlist() {
  try {
    localStorage.setItem("sound-asaph-sunday-setlist", JSON.stringify(sundaySongIds));
  } catch (error) {
    console.error("Não foi possível salvar a lista de louvor de domingo.", error);
    showToast("Não foi possível salvar a lista neste navegador.");
  }
}

function renderSundaySetlist() {
  const setlist = document.querySelector("#setlist-list");
  setlist.replaceChildren();
  const availableSongs = visibleSongs();
  const selectedSongs = sundaySongIds.map(id => availableSongs.find(song => song.id === id)).filter(Boolean);
  document.querySelector("#setlist-count").textContent = String(selectedSongs.length);
  if (!selectedSongs.length) {
    const empty = document.createElement("div");
    empty.className = "setlist-empty";
    empty.textContent = "Adicione músicas pelo + no catálogo abaixo.";
    setlist.append(empty);
    return;
  }
  for (const song of selectedSongs) setlist.append(createSongRow(song, true));
}

function toggleSundaySong(id) {
  const alreadyAdded = sundaySongIds.includes(id);
  sundaySongIds = alreadyAdded ? sundaySongIds.filter(songId => songId !== id) : [...sundaySongIds, id];
  saveSundaySetlist();
  renderCatalog(searchInput.value);
  showToast(alreadyAdded ? "Música removida do louvor de domingo" : "Música adicionada ao louvor de domingo");
}

function selectSong(id) {
  const song = songs.find(item => item.id === id);
  if (!song) return;
  selectedSongId = id;
  transposeSteps = 0;
  capoSelect.value = "0";
  stopAutoScroll();
  document.querySelector("#song-title").textContent = song.title;
  document.querySelector("#song-artist").textContent = song.artist || "Ministério de louvor";
  document.querySelector("#song-category").textContent = SONG_CATEGORIES[song.category] || "REPERTÓRIO";
  document.querySelector("#song-subtitle").textContent = song.subtitle || "Suas cifras para acompanhar cada momento.";
  document.querySelector("#breadcrumb-title").textContent = song.title;
  renderCatalog(searchInput.value);
  renderLyrics();
  lyricsElement.scrollTop = 0;
  setCatalogOpen(false);
}

function setCatalogOpen(open) {
  document.querySelector("#catalog").classList.toggle("open", open);
  document.querySelector("#mobile-menu").setAttribute("aria-expanded", String(open));
  document.querySelector("#mobile-menu").setAttribute("aria-label", open ? "Fechar catálogo" : "Abrir catálogo");
  document.querySelector("#sidebar-backdrop").classList.toggle("visible", open);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2200);
}

function openAudioDatabase() {
  if (!("indexedDB" in window)) return Promise.reject(new Error("Este navegador não oferece armazenamento local de áudios."));
  if (audioDatabasePromise) return audioDatabasePromise;
  audioDatabasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(AUDIO_DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(AUDIO_STORE_NAME)) {
        request.result.createObjectStore(AUDIO_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Não foi possível abrir o armazenamento local de áudios."));
    request.onblocked = () => reject(new Error("O armazenamento de áudios está bloqueado por outra aba do aplicativo."));
  });
  audioDatabasePromise.catch(() => { audioDatabasePromise = null; });
  return audioDatabasePromise;
}

async function audioStoreRequest(mode, method, value) {
  const database = await openAudioDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(AUDIO_STORE_NAME, mode);
    const store = transaction.objectStore(AUDIO_STORE_NAME);
    const request = value === undefined ? store[method]() : store[method](value);
    let result;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error || new Error("Não foi possível acessar o áudio salvo."));
    transaction.onerror = () => reject(transaction.error || new Error("Não foi possível salvar o áudio neste navegador."));
    transaction.onabort = () => reject(transaction.error || new Error("A operação de áudio foi cancelada."));
    transaction.oncomplete = () => resolve(result);
  });
}

function loadAudioSettings() {
  try {
    const stored = localStorage.getItem(AUDIO_SETTINGS_CACHE_KEY);
    if (stored === null) return { hiddenIds: [], labels: {} };
    const settings = JSON.parse(stored);
    if (!settings || !Array.isArray(settings.hiddenIds) || !settings.labels ||
        typeof settings.labels !== "object" || Array.isArray(settings.labels) ||
        settings.hiddenIds.some(id => typeof id !== "string") ||
        Object.values(settings.labels).some(label => typeof label !== "string")) {
      throw new Error("O formato dos ajustes de áudio salvos não é válido.");
    }
    return settings;
  } catch (error) {
    console.error("Não foi possível carregar os ajustes de áudio.", error);
    return { hiddenIds: [], labels: {} };
  }
}

function saveAudioSettings(settings) {
  try {
    localStorage.setItem(AUDIO_SETTINGS_CACHE_KEY, JSON.stringify(settings));
  } catch (error) {
    console.error("Não foi possível salvar os ajustes de áudio.", error);
    showToast("Não foi possível salvar os ajustes de áudio neste navegador.");
    throw error;
  }
}

function bundledAudioId(track) {
  return `bundled:${track.path}`;
}

function localAudioLabel(filename) {
  const name = filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  if (/contralto/i.test(name)) return "Contralto";
  if (/tenor/i.test(name)) return "Tenor";
  if (/melodia.*feminin|feminin.*melodia/i.test(name)) return "Melodia feminina";
  if (/melodia.*masculin|masculin.*melodia/i.test(name)) return "Melodia masculina";
  if (/melodia|melody/i.test(name)) return "Melodia";
  return name || "Áudio vocal";
}

function audioFileExtension(filename) {
  return filename.slice(filename.lastIndexOf(".")).toLowerCase();
}

async function loadLocalAudioAssets() {
  const storedTracks = await audioStoreRequest("readonly", "getAll");
  return storedTracks.map(track => ({ ...track, local: true }));
}

function createVoiceAudioAction(label, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "voice-audio-action";
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

async function renameVoiceAudio(track, currentLabel) {
  if (currentRole !== "admin") return;
  const label = window.prompt("Nome exibido para este áudio:", currentLabel);
  if (label === null) return;
  const trimmedLabel = label.trim();
  if (!trimmedLabel) {
    showToast("Informe um nome para o áudio.");
    return;
  }
  try {
    if (track.local) {
      const updatedTrack = { ...track, label: trimmedLabel };
      await audioStoreRequest("readwrite", "put", updatedTrack);
      audioAssets = audioAssets.map(item => item.id === track.id ? updatedTrack : item);
    } else {
      const settings = loadAudioSettings();
      settings.labels[bundledAudioId(track)] = trimmedLabel;
      saveAudioSettings(settings);
    }
    renderVoiceAudio(currentSong());
    showToast("Nome do áudio atualizado neste navegador.");
  } catch (error) {
    console.error("Não foi possível editar o áudio.", error);
    showToast(error.message || "Não foi possível editar o áudio.");
  }
}

async function deleteVoiceAudio(track) {
  if (currentRole !== "admin") return;
  const settings = loadAudioSettings();
  const id = track.local ? track.id : bundledAudioId(track);
  if (!window.confirm(`Apagar o áudio "${settings.labels[id] || track.label}" deste navegador?`)) return;
  try {
    if (track.local) {
      await audioStoreRequest("readwrite", "delete", track.id);
      audioAssets = audioAssets.filter(item => item.id !== track.id);
    } else {
      settings.hiddenIds = [...new Set([...settings.hiddenIds, id])];
      delete settings.labels[id];
      saveAudioSettings(settings);
    }
    renderVoiceAudio(currentSong());
    showToast("Áudio removido deste navegador.");
  } catch (error) {
    console.error("Não foi possível apagar o áudio.", error);
    showToast(error.message || "Não foi possível apagar o áudio.");
  }
}

async function saveLocalVoiceAudios(files, replacedTrack = null) {
  if (currentRole !== "admin") throw new Error("Somente o perfil Admin pode adicionar áudios.");
  const song = currentSong();
  if (!song) throw new Error("Selecione uma música antes de adicionar áudios.");
  if (replacedTrack && files.length !== 1) throw new Error("Selecione apenas um arquivo para substituir o áudio.");
  const supportedExtensions = new Set([".mp3", ".mp4", ".mpeg", ".ogg", ".wav", ".m4a"]);
  const tracks = [];
  for (const file of files) {
    if (!supportedExtensions.has(audioFileExtension(file.name))) {
      throw new Error(`${file.name}: formato não suportado. Use MP3, MP4, MPEG, OGG, WAV ou M4A.`);
    }
    if (file.size > MAX_LOCAL_AUDIO_SIZE) {
      throw new Error(`${file.name}: o limite por áudio é 100 MB.`);
    }
    const id = replacedTrack?.local ? replacedTrack.id : `local-${crypto.randomUUID()}`;
    tracks.push({
      id,
      folderId: song.folderId || "",
      audioKey: song.audioKey || song.title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      label: replacedTrack
        ? loadAudioSettings().labels[bundledAudioId(replacedTrack)] || replacedTrack.label
        : localAudioLabel(file.name),
      fileName: file.name,
      type: file.type,
      blob: file,
      local: true
    });
  }
  const database = await openAudioDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(AUDIO_STORE_NAME, "readwrite");
    const store = transaction.objectStore(AUDIO_STORE_NAME);
    for (const track of tracks) store.put(track);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("Não foi possível salvar os áudios neste navegador."));
    transaction.onabort = () => reject(transaction.error || new Error("O salvamento dos áudios foi cancelado."));
  });
  if (replacedTrack && !replacedTrack.local) {
    const settings = loadAudioSettings();
    settings.hiddenIds = [...new Set([...settings.hiddenIds, bundledAudioId(replacedTrack)])];
    saveAudioSettings(settings);
  }
  const replacedIds = replacedTrack?.local ? new Set([replacedTrack.id]) : new Set();
  audioAssets = [...audioAssets.filter(track => !replacedIds.has(track.id)), ...tracks];
  renderVoiceAudio(song);
  showToast(replacedTrack ? "Áudio substituído neste navegador." : `${tracks.length} áudio(s) adicionado(s) a ${song.title}.`);
}

function loadSongEdits() {
  try {
    const stored = localStorage.getItem(SONG_EDITS_CACHE_KEY);
    if (stored === null) return {};
    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("O formato das edições de cifras salvas não é válido.");
    }
    return parsed;
  } catch (error) {
    console.error("Não foi possível carregar as edições locais das cifras.", error);
    return {};
  }
}

function applySongEdits(catalogSongs) {
  const edits = loadSongEdits();
  return catalogSongs.map(song => {
    const editedSong = edits[song.id];
    return {
      ...song,
      ...editedSong,
      title: cleanToneFromTitle(editedSong?.title || song.title)
    };
  });
}

function openSongEditor(song) {
  document.querySelector("#edit-song-name").value = song.title;
  document.querySelector("#edit-song-artist").value = song.artist || "";
  document.querySelector("#edit-song-key").value = song.key || "";
  document.querySelector("#edit-song-lyrics").value = song.lyrics;
  document.querySelector("#edit-song-dialog").showModal();
  document.querySelector("#edit-song-name").focus();
}

async function saveSongEdit(event) {
  event.preventDefault();
  const song = currentSong();
  if (!song) return;
  const title = cleanToneFromTitle(document.querySelector("#edit-song-name").value.trim());
  const artist = document.querySelector("#edit-song-artist").value.trim();
  const key = document.querySelector("#edit-song-key").value.trim();
  const lyrics = document.querySelector("#edit-song-lyrics").value.replace(/\r\n?/g, "\n").trim();
  const chords = [...lyrics.matchAll(/\[([^\]]*)\]/g)];
  const textWithoutChords = lyrics.replace(/\[[^\]]*\]/g, "");
  if (!title || !lyrics) {
    showToast("Informe o título e a letra/cifra.");
    return;
  }
  if (!chords.length || chords.some(([, chord]) => !CHORD_TOKEN_PATTERN.test(chord)) ||
      /[\[\]]/.test(textWithoutChords)) {
    showToast("Confira os acordes entre colchetes, por exemplo [G] ou [D/F#].");
    return;
  }
  if (key && !KEY_PATTERN.test(key)) {
    showToast("Tom inválido. Informe uma nota como G, F# ou Bb.");
    return;
  }

  let updatedSong = { ...song, title, artist, key, lyrics };
  try {
    const edits = loadSongEdits();
    edits[song.id] = { title, artist, key, lyrics };
    localStorage.setItem(SONG_EDITS_CACHE_KEY, JSON.stringify(edits));
  } catch (error) {
    console.error("Não foi possível salvar as alterações da cifra.", error);
    showToast("Não foi possível salvar neste navegador. Libere espaço e tente novamente.");
    return;
  }

  songs = songs.map(item => item.id === song.id ? updatedSong : item);
  document.querySelector("#edit-song-dialog").close();
  selectSong(song.id);
  let driveSaveError;
  const { googleClientId, driveFolderId } = window.SOUND_ASAPH_CONFIG || {};
  if (currentRole === "admin" && googleClientId && driveFolderId) {
    try {
      const accessToken = await requestDriveAccessToken(googleClientId);
      updatedSong = await saveSongToDrive(updatedSong, accessToken, driveFolderId);
      songs = songs.map(item => item.id === song.id ? updatedSong : item);
      if (song.id.startsWith("local-")) {
        const localSongs = loadCachedLocalSongs().map(item => item.id === song.id ? updatedSong : item);
        localStorage.setItem(LOCAL_SONGS_CACHE_KEY, JSON.stringify(localSongs));
      } else {
        const cachedSongs = loadCachedDriveSongs() || [];
        saveCachedDriveSongs(cachedSongs.map(item => item.id === song.id ? updatedSong : item));
      }
      hasDriveCatalog = true;
      document.querySelector("#drive-status").textContent = "Sincronizado com Google Drive";
      document.querySelector("#drive-sync-label").textContent = "Sincronizar Google Drive";
      selectSong(song.id);
    } catch (error) {
      driveSaveError = error;
      console.error("A cifra foi salva localmente, mas não foi sincronizada com o Drive.", error);
    }
  }
  showToast(driveSaveError
    ? `Cifra salva neste dispositivo; falha na sincronização: ${driveSaveError.message}`
    : hasDriveCatalog ? "Cifra salva e sincronizada com o Google Drive." : "Cifra salva neste dispositivo.");
}

function loadCachedDriveSongs() {
  try {
    const stored = localStorage.getItem(DRIVE_SONGS_CACHE_KEY);
    if (stored === null) return null;
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed) || parsed.some(song =>
      !song || typeof song.id !== "string" || typeof song.title !== "string" || typeof song.lyrics !== "string"
    )) {
      throw new Error("O catálogo sincronizado salvo neste dispositivo não é válido.");
    }
    return parsed;
  } catch (error) {
    console.error("Não foi possível carregar o catálogo sincronizado.", error);
    return null;
  }
}

function loadCachedLocalSongs() {
  try {
    const stored = localStorage.getItem(LOCAL_SONGS_CACHE_KEY);
    if (stored === null) return [];
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed) || parsed.some(song =>
      !song || typeof song.id !== "string" || typeof song.title !== "string" || typeof song.lyrics !== "string"
    )) {
      throw new Error("As músicas importadas salvas neste dispositivo não são válidas.");
    }
    return parsed;
  } catch (error) {
    console.error("Não foi possível carregar as músicas importadas neste dispositivo.", error);
    return [];
  }
}

function saveCachedDriveSongs(driveSongs) {
  try {
    localStorage.setItem(DRIVE_SONGS_CACHE_KEY, JSON.stringify(driveSongs));
  } catch (error) {
    console.error("Não foi possível salvar o catálogo sincronizado neste dispositivo.", error);
    showToast("Drive sincronizado, mas não foi possível guardar uma cópia neste navegador.");
  }
}

function loadGoogleIdentity() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (googleIdentityScript) return googleIdentityScript;
  googleIdentityScript = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => window.google?.accounts?.oauth2
      ? resolve()
      : reject(new Error("A biblioteca de login do Google não foi carregada."));
    script.onerror = () => reject(new Error("Não foi possível carregar o login do Google. Verifique a conexão."));
    document.head.append(script);
  });
  googleIdentityScript = googleIdentityScript.catch(error => {
    googleIdentityScript = null;
    throw error;
  });
  return googleIdentityScript;
}

function requestDriveAccessToken(clientId) {
  if (!window.google?.accounts?.oauth2) {
    return loadGoogleIdentity().then(() => {
      throw new Error("O login do Google foi carregado. Clique novamente em Conectar para autorizar.");
    });
  }
  return new Promise((resolve, reject) => {
    let timeout;
    const tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: "https://www.googleapis.com/auth/drive",
      callback: response => {
        clearTimeout(timeout);
        if (response.error || !response.access_token) {
          const description = response.error_description || response.error || "O Google não autorizou o acesso ao Drive.";
          reject(new Error(description.includes("access_denied")
            ? "O Google bloqueou o acesso. Confira se esta conta foi adicionada como usuária de teste e se a pasta foi compartilhada com ela."
            : description));
          return;
        }
        resolve(response.access_token);
      },
      error_callback: error => {
        clearTimeout(timeout);
        reject(new Error(error.message || "O login do Google foi cancelado ou bloqueado."));
      }
    });
    timeout = setTimeout(() => reject(new Error("A autorização do Google não foi concluída. Feche a janela de login, confira se pop-ups estão liberados e tente novamente.")), 120000);
    tokenClient.requestAccessToken({ prompt: "" });
  });
}

async function driveFetch(url, accessToken) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) {
    let detail = "";
    try {
      const result = await response.json();
      detail = result.error?.message || result.error_description || "";
    } catch (error) {
      console.warn("Não foi possível ler os detalhes do erro retornado pelo Google Drive.", error);
    }
    throw new Error(detail
      ? `Google Drive (${response.status}): ${detail}`
      : `O Google Drive respondeu com erro ${response.status}. Confira a pasta e as permissões.`);
  }
  return response;
}

async function listDriveFolder(folderId, accessToken) {
  const files = [];
  let pageToken;
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken,files(id,name,mimeType,size,parents,version,modifiedTime)",
      pageSize: "1000",
      orderBy: "name",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true"
    });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await driveFetch(`https://www.googleapis.com/drive/v3/files?${params}`, accessToken);
    const page = await response.json();
    if (!Array.isArray(page.files)) throw new Error("A resposta do Google Drive não contém uma lista de arquivos válida.");
    files.push(...page.files);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return files;
}

async function listDriveSongs(folderId, accessToken, onProgress = () => {}) {
  const files = [];
  const folders = [{ id: folderId, path: [] }];
  const visited = new Set();
  while (folders.length) {
    const folder = folders.shift();
    if (visited.has(folder.id)) continue;
    visited.add(folder.id);
    onProgress(`Procurando arquivos no Drive (${visited.size} pasta(s) examinada(s))...`);
    const items = await listDriveFolder(folder.id, accessToken);
    for (const item of items) {
      if (item.mimeType === GOOGLE_FOLDER_MIME) {
        folders.push({ id: item.id, path: [...folder.path, item.name] });
      } else {
        files.push({ ...item, driveParentId: folder.id, drivePath: folder.path });
      }
    }
  }
  return files;
}

function categoryFromDrivePath(path) {
  const normalized = path.join(" ").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR");
  if (normalized.includes("hinario")) return "hinario";
  if (normalized.includes("data") && normalized.includes("especial")) return "datas-especiais";
  if (normalized.includes("preparacao")) return "preparacao";
  return "repertorio";
}

function driveSlug(value) {
  return value.normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function driveAudioGroup(path) {
  const parentFolders = path.filter(name => !/^(vocal|vocais|audio|audios)$/i.test(
    name.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  ));
  const songFolder = parentFolders.length > 1 ? parentFolders[1] : parentFolders[0] || "";
  return {
    folderId: parentFolders.length > 1 ? driveSlug(`${parentFolders[0]}-${songFolder}`) : driveSlug(songFolder),
    audioKey: driveSlug(songFolder.replace(/\([^)]*\)/g, " ").replace(/\b(?:tom|tonalidade)\b.*$/i, ""))
  };
}

function parseDriveAudio(file) {
  const group = driveAudioGroup(file.drivePath || []);
  return {
    id: file.id,
    drive: true,
    folderId: group.folderId,
    audioKey: group.audioKey,
    label: localAudioLabel(file.name),
    fileName: file.name,
    type: file.mimeType,
    size: file.size,
    path: file.name
  };
}

function driveCategoryFolderName(category) {
  return {
    hinario: "Hinário",
    "datas-especiais": "Datas Especiais",
    preparacao: "Músicas em Preparação",
    repertorio: "Músicas"
  }[category] || "Músicas";
}

async function findOrCreateDriveFolder(folderId, folderName, accessToken) {
  const normalizeFolderName = name => name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR");
  const existing = (await listDriveFolder(folderId, accessToken))
    .find(file => file.mimeType === GOOGLE_FOLDER_MIME && normalizeFolderName(file.name) === normalizeFolderName(folderName));
  if (existing) return existing.id;
  const response = await fetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: folderName, mimeType: GOOGLE_FOLDER_MIME, parents: [folderId] })
  });
  if (!response.ok) throw new Error(`Não foi possível criar a pasta "${folderName}" no Drive (erro ${response.status}).`);
  const created = await response.json();
  if (!created.id) throw new Error(`O Google Drive não retornou o ID da pasta "${folderName}".`);
  return created.id;
}

async function uploadDriveText(parentId, fileName, contents, accessToken, fileId) {
  const metadata = { name: fileName };
  if (!fileId) metadata.parents = [parentId];
  const boundary = `sound-asaph-${crypto.randomUUID()}`;
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    JSON.stringify(metadata),
    `\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n`,
    contents,
    `\r\n--${boundary}--`
  ]);
  const endpoint = fileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=multipart&supportsAllDrives=true&fields=id,name,version`
    : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,version";
  const response = await fetch(endpoint, {
    method: fileId ? "PATCH" : "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body
  });
  if (!response.ok) throw new Error(`Não foi possível salvar "${fileName}" no Drive (erro ${response.status}).`);
  const saved = await response.json();
  if (!saved.id) throw new Error(`O Google Drive não confirmou o salvamento de "${fileName}".`);
  return saved;
}

function songAsText(song) {
  return `Title: ${song.title}\nArtist: ${song.artist || ""}\nKey: ${song.key || ""}\n\n${song.lyrics}\n`;
}

async function saveSongToDrive(song, accessToken, folderId) {
  const supportedFile = song.driveFileId && /\.(txt|md)$/i.test(song.driveName || "");
  if (song.driveFileId && !supportedFile) {
    throw new Error("Esta música veio de PDF/Word/Google Docs. Para evitar substituir o original com um formato incompatível, a edição foi salva apenas neste dispositivo.");
  }
  const parentId = song.driveParentId || await findOrCreateDriveFolder(folderId, driveCategoryFolderName(song.category), accessToken);
  const safeName = `${song.title.replace(/[\\/:*?"<>|]/g, "-")}.txt`;
  const result = await uploadDriveText(parentId, safeName, songAsText(song), accessToken, supportedFile ? song.driveFileId : null);
  return { ...song, driveFileId: result.id, driveName: safeName, driveParentId: parentId, driveVersion: result.version };
}

function supportedDriveFiles(files) {
  return files.filter(file => {
    if (file.mimeType === GOOGLE_DOCUMENT_MIME) return true;
    return SUPPORTED_DRIVE_EXTENSIONS.has(file.name.slice(file.name.lastIndexOf(".")).toLowerCase());
  });
}

async function downloadDriveText(file, accessToken) {
  const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  let text;
  if (file.mimeType === GOOGLE_DOCUMENT_MIME) {
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/export?mimeType=text%2Fplain`;
    text = await (await driveFetch(url, accessToken)).text();
  } else if (extension === ".pdf" || extension === ".doc" || extension === ".docx") {
    if (!["localhost", "127.0.0.1"].includes(location.hostname)) {
      throw new Error("A extração de PDF/Word exige o servidor local ou uma API de extração publicada. No GitHub Pages, use .txt, .md ou Google Docs.");
    }
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`;
    const document = await driveFetch(url, accessToken);
    const response = await fetch("/api/extract-text", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Sound-Asaph-Filename": encodeURIComponent(file.name)
      },
      body: await document.arrayBuffer()
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Falha ao extrair ${file.name}.`);
    text = result.text;
  } else {
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`;
    text = await (await driveFetch(url, accessToken)).text();
  }
  if (!text.trim()) throw new Error("O documento está vazio ou não contém texto legível.");
  return text;
}

function convertChordLines(lines) {
  return lines.map((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.includes("[") || trimmed.includes("]")) return line;
    const tokens = trimmed.split(/\s+/).map(token => token.replace(/^[|,;]+|[|,;]+$/g, "")).filter(Boolean);
    if (!tokens.length) return line;
    const allChords = tokens.every(token => new RegExp(CHORD_PATTERN.source).test(`[${token.replace(/[|,;]+$/g, "")}]`));
    const hasAdjacentLyrics = [lines[index - 1], lines[index + 1]].some(neighbor =>
      neighbor && neighbor.replace(/[\s\p{P}]/gu, "").length > 8
    );
    const hasDistinctiveChord = tokens.length > 1 || tokens.some(token => /[#b/0-9]/.test(token)) || hasAdjacentLyrics;
    return allChords && hasDistinctiveChord ? tokens.map(token => `[${token.replace(/[|,;]+$/g, "")}]`).join("   ") : line;
  });
}

function parseDriveSong(file, contents, songId = `drive-${file.id}`) {
  const baseName = file.name.replace(/\.(?:txt|md|pdf|docx?)$/i, "");
  const song = {
    id: songId,
    title: baseName.replace(/[-_]+/g, " ").trim(),
    artist: "",
    key: "",
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
      else song.key = metadata[2];
      continue;
    }
    if (!readingLyrics && line.trim() === "" && lyrics.length === 0) continue;
    readingLyrics = true;
    lyrics.push(line);
  }
  song.lyrics = convertChordLines(lyrics).join("\n").trim();
  const chords = [...song.lyrics.matchAll(/\[([^\]]*)\]/g)];
  const lyricsWithoutChords = song.lyrics.replace(/\[[^\]]*\]/g, "");
  if (!song.title || !song.lyrics || !chords.length ||
      chords.some(([, chord]) => !new RegExp(CHORD_PATTERN.source).test(`[${chord}]`)) ||
      /[\[\]]/.test(lyricsWithoutChords)) {
    throw new Error("A cifra não pôde ser reconhecida. Use acordes como [G] junto à letra ou em linhas separadas.");
  }
  if (song.key && !KEY_PATTERN.test(song.key)) {
    throw new Error(`O tom "${song.key}" não é válido. Informe uma nota como G, F# ou Bb.`);
  }
  return song;
}

async function readLocalSongFile(file) {
  const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  if (!SUPPORTED_DRIVE_EXTENSIONS.has(extension)) {
    throw new Error("Formato não compatível. Use .txt, .md, .pdf, .doc ou .docx.");
  }
  if (file.size > MAX_DRIVE_FILE_SIZE) {
    throw new Error("O arquivo excede o limite de 20 MB.");
  }

  if (extension === ".txt" || extension === ".md") {
    const contents = await file.text();
    if (!contents.trim()) throw new Error("O arquivo está vazio.");
    return contents;
  }

  const response = await fetch("/api/extract-text", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Sound-Asaph-Filename": encodeURIComponent(file.name)
    },
    body: await file.arrayBuffer()
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Falha ao extrair ${file.name}.`);
  if (typeof result.text !== "string" || !result.text.trim()) {
    throw new Error("O documento está vazio ou não contém texto legível.");
  }
  return result.text;
}

async function importLocalSongs(files) {
  if (currentRole !== "admin") {
    throw new Error("Somente o perfil Admin pode importar músicas.");
  }
  const importedSongs = [];
  const failures = [];
  for (const file of files) {
    try {
      const baseName = file.name.replace(/\.(?:txt|md|pdf|docx?)$/i, "");
      const id = `local-${baseName.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
      const song = parseDriveSong({ name: file.name }, await readLocalSongFile(file), id);
      song.category = ["hinario", "datas-especiais", "preparacao"].includes(activeCategory) ? activeCategory : "preparacao";
      song.folder = "Importadas";
      if (songs.some(existing => existing.id === song.id) || importedSongs.some(existing => existing.id === song.id)) {
        throw new Error(`Já existe uma música com o id "${song.id}". Renomeie o arquivo para importar outra versão.`);
      }
      importedSongs.push(song);
    } catch (error) {
      failures.push(`${file.name}: ${error.message}`);
    }
  }

  if (!importedSongs.length) {
    throw new Error(failures.length ? failures.join(" | ") : "Selecione pelo menos um arquivo de música.");
  }

  const localSongs = [...loadCachedLocalSongs(), ...importedSongs];
  localStorage.setItem(LOCAL_SONGS_CACHE_KEY, JSON.stringify(localSongs));
  let driveFailures = [];
  let importedToDrive = false;
  const { googleClientId, driveFolderId } = window.SOUND_ASAPH_CONFIG || {};
  if (currentRole === "admin" && googleClientId && driveFolderId) {
    try {
      const accessToken = await requestDriveAccessToken(googleClientId);
      const savedSongs = [];
      for (const song of importedSongs) {
        try {
          savedSongs.push(await saveSongToDrive(song, accessToken, driveFolderId));
        } catch (error) {
          driveFailures.push(`${song.title}: ${error.message}`);
        }
      }
      if (savedSongs.length) {
        importedToDrive = true;
        const savedById = new Map(savedSongs.map(song => [song.id, song]));
        const updatedLocalSongs = localSongs.map(song => savedById.get(song.id) || song);
        localStorage.setItem(LOCAL_SONGS_CACHE_KEY, JSON.stringify(updatedLocalSongs));
        importedSongs.splice(0, importedSongs.length, ...importedSongs.map(song => savedById.get(song.id) || song));
        hasDriveCatalog = true;
        document.querySelector("#drive-status").textContent = "Sincronizado com Google Drive";
        document.querySelector("#drive-sync-label").textContent = "Sincronizar Google Drive";
      }
    } catch (error) {
      console.error("As músicas foram importadas localmente, mas não foi possível conectar ao Drive.", error);
      driveFailures.push(error.message || "Não foi possível conectar ao Drive.");
    }
  }
  songs = applySongEdits([...songs, ...importedSongs]);
  renderCatalog(searchInput.value);
  selectSong(importedSongs[0].id);

  if (failures.length || driveFailures.length) {
    const notices = [...failures.map(message => `Importação: ${message}`), ...driveFailures.map(message => `Drive: ${message}`)];
    console.warn("Resultado parcial da importação de músicas.", notices);
    showToast(`${importedSongs.length} música(s) importada(s); ${notices.length} aviso(s).`);
  } else {
    showToast(`${importedSongs.length} música(s) ${importedToDrive ? "salva(s) no Drive e neste dispositivo." : "importada(s) neste dispositivo."}`);
  }
}

async function syncGoogleDrive(onProgress = () => {}) {
  if (currentRole !== "admin") {
    throw new Error("Somente o perfil Admin pode sincronizar músicas.");
  }
  const { googleClientId, driveFolderId } = window.SOUND_ASAPH_CONFIG || {};
  if (!googleClientId || !driveFolderId) {
    throw new Error("Preencha googleClientId e driveFolderId em drive-config.js antes de conectar.");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(driveFolderId)) {
    throw new Error("O ID da pasta no drive-config.js não parece válido.");
  }

  onProgress("Aguardando autorização do Google...");
  const accessToken = await requestDriveAccessToken(googleClientId);
  driveAccessToken = accessToken;
  onProgress("Acesso autorizado. Procurando arquivos e subpastas...");
  const files = await listDriveSongs(driveFolderId, accessToken, onProgress);
  const candidates = supportedDriveFiles(files);
  const driveAudios = files
    .filter(file => SUPPORTED_DRIVE_AUDIO_EXTENSIONS.has(file.name.slice(file.name.lastIndexOf(".")).toLowerCase()))
    .map(parseDriveAudio);
  if (!candidates.length && !driveAudios.length) {
    throw new Error(`O Drive foi acessado, mas não encontrei cifras ou áudios compatíveis na pasta configurada (${files.length} arquivo(s) analisado(s)). Confira o ID da pasta e os formatos dos arquivos.`);
  }
  const importedSongs = [];
  const tooLargeFiles = candidates.filter(file => Number(file.size) > MAX_DRIVE_FILE_SIZE);
  const filesToImport = candidates.filter(file => Number(file.size) <= MAX_DRIVE_FILE_SIZE || !file.size);
  const failures = tooLargeFiles.map(file => `${file.name}: excede o limite de 20 MB`);
  for (let index = 0; index < filesToImport.length; index += 5) {
    const batch = filesToImport.slice(index, index + 5);
    onProgress(`Lendo cifras do Drive (${Math.min(index + batch.length, filesToImport.length)}/${filesToImport.length})...`);
    const results = await Promise.allSettled(batch.map(async file => parseDriveSong(file, await downloadDriveText(file, accessToken))));
    results.forEach((result, batchIndex) => {
      if (result.status === "fulfilled") {
        const song = result.value;
        song.driveFileId = batch[batchIndex].id;
        song.driveName = batch[batchIndex].name;
        song.driveParentId = batch[batchIndex].driveParentId;
        song.driveVersion = batch[batchIndex].version;
        const drivePath = batch[batchIndex].drivePath || [];
        const audioGroup = driveAudioGroup(drivePath);
        song.category = categoryFromDrivePath(drivePath);
        song.folder = drivePath.join("/");
        song.folderId = audioGroup.folderId;
        song.audioKey = audioGroup.audioKey;
        importedSongs.push(song);
      }
      else failures.push(`${batch[batchIndex].name}: ${result.reason.message}`);
    });
  }
  const oversizedAudios = driveAudios.filter(track => Number(track.size) > MAX_DRIVE_AUDIO_SIZE);
  const playableDriveAudios = driveAudios.filter(track => Number(track.size) <= MAX_DRIVE_AUDIO_SIZE || !track.size);
  audioAssets = [...audioAssets.filter(track => !track.drive), ...playableDriveAudios];
  const previousDriveSongs = loadCachedDriveSongs() || [];
  const previousById = new Map(previousDriveSongs.map(song => [song.driveFileId, song]));
  const edits = loadSongEdits();
  let discardedEdits = false;
  for (const song of importedSongs) {
    const previous = previousById.get(song.driveFileId);
    if (previous && previous.driveVersion !== song.driveVersion && /\.(txt|md)$/i.test(song.driveName || "")) {
      discardedEdits = delete edits[song.id] || discardedEdits;
    }
  }
  if (discardedEdits) {
    try {
      localStorage.setItem(SONG_EDITS_CACHE_KEY, JSON.stringify(edits));
    } catch (error) {
      console.error("Não foi possível atualizar as edições após sincronizar mudanças feitas no Drive.", error);
      showToast("A sincronização foi carregada, mas edições antigas deste navegador podem continuar visíveis.");
    }
  }
  const localOnlySongs = loadCachedLocalSongs().filter(song => !song.driveFileId);
  songs = applySongEdits([...importedSongs, ...bundledFolderSongs, ...localOnlySongs]);
  sundaySongIds = sundaySongIds.filter(id => songs.some(song => song.id === id));
  saveSundaySetlist();
  hasDriveCatalog = true;
  document.querySelector("#drive-status").textContent = "Sincronizado com Google Drive";
  document.querySelector("#drive-sync-label").textContent = "Sincronizar Google Drive";
  saveCachedDriveSongs(importedSongs);
  renderCatalog(searchInput.value);
  if (songs.length) selectSong(songs[0].id);

  const unsupported = files.length - candidates.length - driveAudios.length;
  const notices = [];
  if (oversizedAudios.length) notices.push(`${oversizedAudios.length} áudio(s) excedem 100 MB e não poderão ser reproduzidos no navegador.`);
  if (failures.length) notices.push(`${failures.length} arquivo(s) não importado(s): ${failures.join(" | ")}`);
  if (unsupported) notices.push(`${unsupported} arquivo(s) em formato não compatível foram ignorados.`);
  if (notices.length) {
    console.warn("Resultado parcial da sincronização do Drive.", notices);
    showToast(`Sincronizadas ${importedSongs.length} músicas e ${playableDriveAudios.length} áudios; ${failures.length + unsupported} arquivo(s) precisam de atenção.`);
  } else showToast(`${importedSongs.length} música(s) e ${playableDriveAudios.length} áudio(s) sincronizados do Google Drive.`);
  document.querySelector("#drive-status").textContent = `${importedSongs.length} cifras e ${playableDriveAudios.length} áudios do Drive`;
}

function stopAutoScroll() {
  if (scrollTimer !== null) {
    clearInterval(scrollTimer);
    scrollTimer = null;
  }
  document.querySelector("#autoscroll-toggle").setAttribute("aria-pressed", "false");
  scrollDirection = 1;
}

function startAutoScroll() {
  stopAutoScroll();
  document.querySelector("#autoscroll-toggle").setAttribute("aria-pressed", "true");
  scrollTimer = setInterval(() => {
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    if (window.scrollY >= maxScroll - 2) scrollDirection = -1;
    if (window.scrollY <= 1) scrollDirection = 1;
    window.scrollBy({ top: scrollDirection, behavior: "auto" });
  }, 35);
}

async function copySong() {
  const song = currentSong();
  if (!song) return;
  if (currentRole === "vocal") {
    const lyricsOnly = normalizeIntroChords(song.lyrics).replace(CHORD_PATTERN, "").replace(/\s+$/gm, "");
    try {
      await navigator.clipboard.writeText(`${song.title}\n\n${lyricsOnly}`);
      showToast("Letra copiada para a área de transferência");
    } catch (error) {
      console.error("Não foi possível copiar a letra.", error);
      showToast("Não foi possível copiar. Verifique a permissão do navegador.");
    }
    return;
  }
  const capo = Number(capoSelect.value);
  const lyrics = normalizeIntroChords(song.lyrics)
    .replace(CHORD_PATTERN, (_, chord) => `[${transposeChord(chord, transposeSteps - capo)}]`);
  try {
    await navigator.clipboard.writeText(`${song.title}\nTom: ${displayKey(song)}${capo ? ` | Formas com capo: ${displayKey(song, transposeSteps - capo)} (casa ${capo})` : ""}\n\n${lyrics}`);
    showToast("Cifra copiada para a área de transferência");
  } catch (error) {
    console.error("Não foi possível copiar a cifra.", error);
    showToast("Não foi possível copiar. Verifique a permissão do navegador.");
  }
}

document.querySelector("#transpose-down").addEventListener("click", () => { transposeSteps--; renderLyrics(); });
document.querySelector("#transpose-up").addEventListener("click", () => { transposeSteps++; renderLyrics(); });
capoSelect.addEventListener("change", renderLyrics);
document.querySelector("#font-down").addEventListener("click", () => {
  fontSize = Math.max(13, fontSize - 1);
  document.documentElement.style.setProperty("--lyrics-size", `${fontSize}px`);
});
document.querySelector("#font-up").addEventListener("click", () => {
  fontSize = Math.min(30, fontSize + 1);
  document.documentElement.style.setProperty("--lyrics-size", `${fontSize}px`);
});
document.querySelector("#stage-toggle").addEventListener("click", event => {
  const enabled = !document.body.classList.contains("stage-mode");
  try {
    setStageMode(enabled, true);
  } catch (error) {
    console.error("Não foi possível salvar a preferência de tema.", error);
    setStageMode(enabled);
    showToast("Tema alterado, mas não foi possível guardar a preferência neste navegador.");
  }
});
document.querySelector("#autoscroll-toggle").addEventListener("click", () => {
  if (scrollTimer === null) startAutoScroll();
  else stopAutoScroll();
});
document.querySelector("#copy-button").addEventListener("click", copySong);
document.querySelector("#edit-song-button").addEventListener("click", () => {
  const song = currentSong();
  if (song) openSongEditor(song);
});
document.querySelector("#edit-song-form").addEventListener("submit", saveSongEdit);
document.querySelector("#login-form").addEventListener("submit", loginDemoRole);
document.querySelector("#login-dialog").addEventListener("cancel", event => {
  if (!currentRole) event.preventDefault();
});
document.querySelector("#profile-toggle").addEventListener("click", logoutDemoRole);
document.querySelector("#delete-song-button").addEventListener("click", deleteCurrentSong);
document.querySelector("#close-edit-song").addEventListener("click", () => document.querySelector("#edit-song-dialog").close());
document.querySelector("#cancel-edit-song").addEventListener("click", () => document.querySelector("#edit-song-dialog").close());
document.querySelector("#sunday-category").addEventListener("click", () => {
  activeCategory = "sunday";
  searchInput.value = "";
  renderCatalog();
  setCatalogOpen(false);
});
for (const button of document.querySelectorAll(".sidebar-category[data-category]")) {
  button.addEventListener("click", () => {
    activeCategory = button.dataset.category;
    searchInput.value = "";
    renderCatalog();
    setCatalogOpen(false);
  });
}
document.querySelector("#song-import-button").addEventListener("click", () => {
  document.querySelector("#song-import-input").click();
});
document.querySelector("#song-import-input").addEventListener("change", async event => {
  const input = event.currentTarget;
  const button = document.querySelector("#song-import-button");
  const files = Array.from(input.files || []);
  if (!files.length) return;
  button.disabled = true;
  button.querySelector("span").textContent = "Importando músicas...";
  try {
    await importLocalSongs(files);
  } catch (error) {
    console.error("Não foi possível importar as músicas.", error);
    showToast(error.message || "Não foi possível importar as músicas.");
  } finally {
    input.value = "";
    button.disabled = false;
    button.querySelector("span").textContent = "Importar músicas";
  }
});
document.querySelector("#voice-audio-file-input").addEventListener("change", async event => {
  const input = event.currentTarget;
  const files = Array.from(input.files || []);
  if (!files.length) return;
  try {
    await saveLocalVoiceAudios(files);
  } catch (error) {
    console.error("Não foi possível adicionar os áudios vocais.", error);
    showToast(error.message || "Não foi possível adicionar os áudios.");
  } finally {
    input.value = "";
  }
});
document.querySelector("#voice-audio-replace-input").addEventListener("change", async event => {
  const input = event.currentTarget;
  const file = input.files?.[0];
  if (!file) return;
  try {
    const targetId = input.dataset.trackId;
    const replacedTrack = audioAssets.find(track =>
      (track.local ? track.id : bundledAudioId(track)) === targetId
    );
    if (!replacedTrack) throw new Error("O áudio selecionado não está mais disponível.");
    await saveLocalVoiceAudios([file], replacedTrack);
  } catch (error) {
    console.error("Não foi possível substituir o áudio vocal.", error);
    showToast(error.message || "Não foi possível substituir o áudio.");
  } finally {
    input.value = "";
    delete input.dataset.trackId;
  }
});
async function handleDriveSync(event) {
  if (currentRole !== "admin") return;
  document.querySelector("#drive-sync-button").disabled = true;
  document.querySelector("#welcome-drive-button").disabled = true;
  const syncLabel = document.querySelector("#drive-sync-label");
  const welcomeLabel = document.querySelector("#welcome-drive-button span");
  syncLabel.textContent = "Conectando ao Drive...";
  welcomeLabel.textContent = "Conectando ao repertório...";
  document.querySelector("#drive-status").textContent = "Aguardando autorização do Google...";
  try {
    await syncGoogleDrive(status => {
      syncLabel.textContent = status;
      welcomeLabel.textContent = status;
      document.querySelector("#drive-status").textContent = status;
    });
  } catch (error) {
    console.error("Não foi possível sincronizar o Google Drive.", error);
    document.querySelector("#drive-status").textContent = "Falha ao sincronizar com o Google Drive";
    welcomeLabel.textContent = "Tentar conectar novamente";
    showToast(error.message || "Não foi possível sincronizar o Google Drive.");
  } finally {
    document.querySelector("#drive-sync-label").textContent = hasDriveCatalog ? "Sincronizar Google Drive" : "Conectar Google Drive";
    if (document.querySelector("#drive-status").textContent !== "Falha ao sincronizar com o Google Drive") {
      welcomeLabel.textContent = "Conectar repertório compartilhado";
    }
    document.querySelector("#drive-sync-button").disabled = false;
    document.querySelector("#welcome-drive-button").disabled = false;
  }
}
document.querySelector("#drive-sync-button").addEventListener("click", handleDriveSync);
document.querySelector("#welcome-drive-button").addEventListener("click", handleDriveSync);
document.querySelector("#mobile-menu").addEventListener("click", event => {
  const open = !document.querySelector("#catalog").classList.contains("open");
  setCatalogOpen(open);
});
document.querySelector("#sidebar-close").addEventListener("click", () => setCatalogOpen(false));
document.querySelector("#sidebar-backdrop").addEventListener("click", () => setCatalogOpen(false));
searchInput.addEventListener("input", () => {
  if (searchInput.value.trim()) activeCategory = "all";
  renderCatalog(searchInput.value);
});
document.addEventListener("keydown", event => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) return;
  if (event.key === "/") {
    event.preventDefault();
    searchInput.focus();
  } else if (event.key === "+" || event.key === "=") {
    transposeSteps++;
    renderLyrics();
  } else if (event.key === "-") {
    transposeSteps--;
    renderLyrics();
  } else if (event.key.toLowerCase() === "s") {
    const button = document.querySelector("#stage-toggle");
    button.click();
  } else if (event.key.toLowerCase() === "a") {
    if (scrollTimer === null) startAutoScroll();
    else stopAutoScroll();
  } else if (event.key === "Escape") {
    setCatalogOpen(false);
  }
});
let touchStartY = 0;
window.addEventListener("touchstart", event => { touchStartY = event.touches[0].clientY; }, { passive: true });
window.addEventListener("touchend", event => {
  if (Math.abs(event.changedTouches[0].clientY - touchStartY) > 24 && scrollTimer !== null) stopAutoScroll();
}, { passive: true });

setupInstallableApp();
setRoleInterface();
setStageMode(loadStageMode());
if (!currentRole) document.querySelector("#login-dialog").showModal();

Promise.all([
  fetch("data/songs.json"),
  fetch("data/folder-songs.json"),
  fetch("data/folder-audio.json")
])
  .then(async ([catalogResponse, folderSongsResponse, audioResponse]) => {
    if (!catalogResponse.ok) throw new Error(`Falha ao carregar músicas (${catalogResponse.status})`);
    if (!folderSongsResponse.ok) throw new Error(`Falha ao carregar cifras da pasta musicas (${folderSongsResponse.status})`);
    if (!audioResponse.ok) throw new Error(`Falha ao carregar o índice de áudios (${audioResponse.status})`);
    const [data, folderSongs, voiceAudio] = await Promise.all([
      catalogResponse.json(),
      folderSongsResponse.json(),
      audioResponse.json()
    ]);
    if (!Array.isArray(data) || data.length === 0) throw new Error("O catálogo não contém músicas.");
    if (!Array.isArray(folderSongs)) throw new Error("O catálogo importado da pasta musicas não é válido.");
    if (!Array.isArray(voiceAudio) || voiceAudio.some(track =>
      !track || typeof track.folderId !== "string" || typeof track.audioKey !== "string" ||
      typeof track.label !== "string" || typeof track.path !== "string"
    )) throw new Error("O índice de áudios vocais não é válido. Execute npm run import:folder.");
    try {
      audioAssets = [...voiceAudio, ...await loadLocalAudioAssets()];
    } catch (error) {
      console.error("Não foi possível carregar os áudios salvos neste navegador.", error);
      audioAssets = voiceAudio;
      showToast(error.message || "Os áudios adicionados neste navegador não foram carregados.");
    }
    const cachedDriveSongs = loadCachedDriveSongs();
    bundledFolderSongs = folderSongs;
    songs = applySongEdits([...(cachedDriveSongs || data), ...bundledFolderSongs, ...loadCachedLocalSongs()]);
    hasDriveCatalog = cachedDriveSongs !== null;
    if (cachedDriveSongs !== null) {
      document.querySelector("#drive-status").textContent = "Cifras sincronizadas neste dispositivo";
      document.querySelector("#drive-sync-label").textContent = "Sincronizar Google Drive";
    }
    const availableSongs = visibleSongs();
    const currentSetlist = sundaySongIds.length;
    sundaySongIds = sundaySongIds.filter(id => availableSongs.some(song => song.id === id));
    if (sundaySongIds.length !== currentSetlist) saveSundaySetlist();
    renderCatalog();
    if (availableSongs.length) selectSong(availableSongs[0].id);
    else {
      document.querySelector("#song-title").textContent = "Nenhuma música disponível";
      document.querySelector("#song-subtitle").textContent = "Importe ou adicione cifras para começar.";
      document.querySelector("#breadcrumb-title").textContent = "Catálogo vazio";
      lyricsElement.replaceChildren();
    }
  })
  .catch(error => {
    console.error("Não foi possível carregar o catálogo.", error);
    document.querySelector("#song-title").textContent = "Não foi possível carregar as músicas";
    document.querySelector("#song-subtitle").textContent = "Confira se os índices em data estão disponíveis e inicie o servidor local pelo npm start.";
    document.querySelector("#breadcrumb-title").textContent = "Catálogo indisponível";
    songList.innerHTML = '<div class="empty-search">Confira os arquivos de catálogo em data e recarregue a página.</div>';
  });
