/**
 * Backend gratuito da escala do Sound-Asaph (Google Apps Script).
 * Guarda a escala no arquivo escala.json dentro da pasta do Drive.
 *
 * Propriedades do script (Configurações do projeto > Propriedades do script):
 *   FOLDER_ID       ID da pasta do Drive onde escala.json será guardado
 *   ADMIN_PASSWORD  senha do Líder para alterar membros, datas e a escala
 *
 * Publicação: Implantar > Nova implantação > App da Web
 *   Executar como: Eu | Quem tem acesso: Qualquer pessoa
 */
var FILE_NAME = "escala.json";
var DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function doGet() {
  return respond_(readSchedule_());
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var body = JSON.parse(e.postData.contents);
    var schedule = readSchedule_();
    if (body.action === "availability") {
      var exists = schedule.members.some(function (member) { return member.id === body.memberId; });
      if (!exists) return respond_({ error: "Membro não encontrado." });
      // Só aceita marcações de meses com o período de preenchimento aberto.
      var today = Utilities.formatDate(new Date(), "America/Sao_Paulo", "yyyy-MM-dd");
      var isOpen = function (date) {
        var period = schedule.periods[date.slice(0, 7)];
        return Boolean(period) && !period.locked && period.start <= today && today <= period.end;
      };
      var kept = (schedule.availability[body.memberId] || []).filter(function (date) { return !isOpen(date); });
      var accepted = cleanDates_(body.dates).filter(isOpen);
      schedule.availability[body.memberId] = cleanDates_(kept.concat(accepted));
    } else if (body.action === "save") {
      var password = PropertiesService.getScriptProperties().getProperty("ADMIN_PASSWORD");
      if (!password || body.password !== password) return respond_({ error: "Senha incorreta." });
      schedule = sanitize_(body.schedule || {});
    } else {
      return respond_({ error: "Ação inválida." });
    }
    writeSchedule_(schedule);
    return respond_(schedule);
  } catch (error) {
    return respond_({ error: String(error) });
  } finally {
    lock.releaseLock();
  }
}

function respond_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function cleanDates_(dates) {
  var seen = {};
  return (Array.isArray(dates) ? dates : []).filter(function (date) {
    if (typeof date !== "string" || !DATE_PATTERN.test(date) || seen[date]) return false;
    seen[date] = true;
    return true;
  }).sort().slice(0, 400);
}

function text_(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max || 80) : "";
}

function sanitize_(input) {
  var members = (Array.isArray(input.members) ? input.members : []).slice(0, 100)
    .filter(function (member) { return member && text_(member.id, 40) && text_(member.name); })
    .map(function (member) { return { id: text_(member.id, 40), name: text_(member.name), role: text_(member.role, 40) }; });
  var ids = {};
  members.forEach(function (member) { ids[member.id] = true; });
  var availability = {};
  Object.keys(input.availability || {}).forEach(function (id) {
    if (ids[id]) availability[id] = cleanDates_(input.availability[id]);
  });
  var assignments = {};
  Object.keys(input.assignments || {}).forEach(function (date) {
    if (!DATE_PATTERN.test(date) || !Array.isArray(input.assignments[date])) return;
    assignments[date] = input.assignments[date].filter(function (id, index, list) {
      return ids[id] && list.indexOf(id) === index;
    });
  });
  var teamSize = Math.min(30, Math.max(1, Math.round(Number(input.teamSize)) || 5));
  var periods = {};
  Object.keys(input.periods || {}).forEach(function (key) {
    var period = input.periods[key];
    if (/^\d{4}-\d{2}$/.test(key) && period && DATE_PATTERN.test(period.start) && DATE_PATTERN.test(period.end) && period.start <= period.end) {
      periods[key] = { start: period.start, end: period.end, locked: period.locked === true };
    }
  });
  return { members: members, dates: cleanDates_(input.dates), availability: availability, assignments: assignments, teamSize: teamSize, periods: periods };
}

function findFile_() {
  var folder = DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty("FOLDER_ID"));
  var files = folder.getFilesByName(FILE_NAME);
  return { folder: folder, file: files.hasNext() ? files.next() : null };
}

function readSchedule_() {
  var found = findFile_();
  if (!found.file) return sanitize_({});
  try {
    return sanitize_(JSON.parse(found.file.getBlob().getDataAsString("UTF-8")));
  } catch (error) {
    return sanitize_({});
  }
}

function writeSchedule_(schedule) {
  var found = findFile_();
  var content = JSON.stringify(schedule, null, 2);
  if (found.file) found.file.setContent(content);
  else found.folder.createFile(FILE_NAME, content, MimeType.PLAIN_TEXT);
}
