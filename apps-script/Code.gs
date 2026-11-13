/**
 * 1111-rule 後台：Google Sheets + Apps Script
 * ------------------------------------------------------------
 * 提供兩個端點給 index.html 使用（同一個 Web App 網址）：
 *   GET  {url}?action=ping&token=xxx
 *   GET  {url}?action=list&sheet=daily|meeting|report&limit=20&token=xxx
 *   POST {url}   body: {"action":"submit","sheet":"daily","payload":{...},"token":"xxx"}
 *
 * 首次使用：在編輯器執行 setup() 一次即可建立三張工作表。
 * 部署：部署 → 新增部署作業 → 網頁應用程式
 *       執行身分：我　存取權：任何人
 */

const TZ = 'Asia/Taipei';
const MAX_TEXT = 500;

const SHEET_DEFS = {
  daily: {
    sheetName: '每日提醒',
    prefix: 'REM',
    headers: ['時間戳', 'log_id', '成員', '關鍵任務', '狀態', '建立時間(ISO)'],
    widths: [110, 150, 170, 420, 130, 210],
    write: function (payload, base) {
      return [
        base.time,
        base.log_id,
        requireText_(payload.user, '成員'),
        requireText_(payload.task, '關鍵任務'),
        base.status,
        base.iso
      ];
    },
    record: function (row) {
      return { time: row[0], log_id: row[1], user: row[2], task: row[3], status: row[4] };
    },
    defaultStatus: 'Submitted_On_Time'
  },

  meeting: {
    sheetName: '會議紀錄',
    prefix: 'MTG',
    headers: ['時間戳', 'log_id', '會議主題', '關鍵決策', '負責人', '狀態', '建立時間(ISO)'],
    widths: [110, 150, 260, 380, 140, 110, 210],
    write: function (payload, base) {
      return [
        base.time,
        base.log_id,
        requireText_(payload.title, '會議主題'),
        requireText_(payload.decision, '關鍵決策'),
        requireText_(payload.owner, '負責人'),
        base.status,
        base.iso
      ];
    },
    record: function (row) {
      return { time: row[0], log_id: row[1], title: row[2], decision: row[3], owner: row[4], status: row[5] };
    },
    defaultStatus: 'Open'
  },

  report: {
    sheetName: '市場情報',
    prefix: 'RPT',
    headers: ['時間戳', 'log_id', '報告主題', '市場分類', '戰略結論', '建立時間(ISO)'],
    widths: [110, 150, 300, 200, 420, 210],
    write: function (payload, base) {
      return [
        base.time,
        base.log_id,
        requireText_(payload.title, '報告主題'),
        requireText_(payload.category, '市場分類'),
        requireText_(payload.summary, '戰略結論'),
        base.iso
      ];
    },
    record: function (row) {
      return { time: row[0], log_id: row[1], title: row[2], category: row[3], summary: row[4] };
    },
    defaultStatus: ''
  }
};

/* ============================ 入口 ============================ */

function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    verifyToken_(params.token);

    const action = params.action || 'ping';
    if (action === 'ping') {
      return json_({ ok: true, service: '1111-rule-backend', time: new Date().toISOString() });
    }
    if (action === 'list') {
      const key = String(params.sheet || '');
      if (!SHEET_DEFS[key]) return json_({ ok: false, error: 'UNKNOWN_SHEET' });
      return json_({ ok: true, sheet: key, rows: listRecords_(key, params.limit) });
    }
    return json_({ ok: false, error: 'UNKNOWN_ACTION' });
  } catch (err) {
    return json_({ ok: false, error: message_(err) });
  }
}

function doPost(e) {
  try {
    const body = parseBody_(e);
    verifyToken_(body.token);

    const action = body.action || 'submit';
    if (action !== 'submit') return json_({ ok: false, error: 'UNKNOWN_ACTION' });

    const key = String(body.sheet || '');
    if (!SHEET_DEFS[key]) return json_({ ok: false, error: 'UNKNOWN_SHEET' });

    return json_({ ok: true, sheet: key, record: appendRecord_(key, body.payload || {}) });
  } catch (err) {
    return json_({ ok: false, error: message_(err) });
  }
}

/* ========================= 初始化 / 選單 ========================= */

function setup() {
  const ss = getSpreadsheet_();
  ss.setSpreadsheetTimeZone(TZ);

  Object.keys(SHEET_DEFS).forEach(function (key) {
    ensureSheet_(key);
  });

  Logger.log('完成：已建立／確認 %s 張工作表於「%s」',
    Object.keys(SHEET_DEFS).length, ss.getName());
  return 'OK';
}

function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('⚙️ 1111-rule 後台')
      .addItem('1. 初始化工作表', 'setup')
      .addItem('2. 顯示部署設定', 'showDeployInfo')
      .addToUi();
  } catch (err) {
    Logger.log(err);
  }
}

function showDeployInfo() {
  const url = ScriptApp.getService().getUrl();
  const text = url
    ? 'Web App 網址：\n' + url + '\n\n把這個網址貼到 index.html 的 BACKEND.url。'
    : '尚未部署。請點「部署 → 新增部署作業 → 網頁應用程式」，\n執行身分選「我」，存取權選「任何人」。';
  try {
    SpreadsheetApp.getUi().alert('部署設定', text, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (err) {
    Logger.log(text);
  }
}

/* ============================ 商業邏輯 ============================ */

function appendRecord_(key, payload) {
  const def = SHEET_DEFS[key];
  const sheet = ensureSheet_(key);
  const lock = LockService.getScriptLock();

  lock.waitLock(10000);
  try {
    const now = new Date();
    const base = {
      time: Utilities.formatDate(now, TZ, 'HH:mm:ss'),
      iso: Utilities.formatDate(now, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"),
      log_id: nextLogId_(sheet, def, now),
      status: def.defaultStatus
    };
    const values = def.write(payload, base);
    sheet.appendRow(values);
    return def.record(values);
  } finally {
    lock.releaseLock();
  }
}

function listRecords_(key, limit) {
  const def = SHEET_DEFS[key];
  const sheet = ensureSheet_(key);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const max = Math.max(1, Math.min(Number(limit) || 20, 500));
  const startRow = Math.max(2, lastRow - max + 1);
  const rows = sheet.getRange(startRow, 1, lastRow - startRow + 1, def.headers.length).getValues();

  return rows.reverse().map(function (row) {
    return def.record(row);
  });
}

function nextLogId_(sheet, def, now) {
  const prefix = def.prefix + '-' + Utilities.formatDate(now, TZ, 'yyyyMMdd') + '-';
  const lastRow = sheet.getLastRow();
  let seq = 0;

  if (lastRow >= 2) {
    const ids = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i][0]).indexOf(prefix) === 0) seq++;
    }
  }
  return prefix + String(seq + 1).padStart(3, '0');
}

/* ============================ 工具函式 ============================ */

function getSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);

  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;

  throw new Error(
    '找不到試算表。請在 Apps Script「專案設定 → 指令碼屬性」新增 SPREADSHEET_ID（Google Sheet 網址中的那串 ID），或改為在該 Google Sheet 內開啟「擴充功能 → Apps Script」建立本指令碼。'
  );
}

function ensureSheet_(key) {
  const def = SHEET_DEFS[key];
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(def.sheetName);
  if (!sheet) sheet = ss.insertSheet(def.sheetName);
  if (sheet.getLastRow() === 0) fillHeader_(sheet, def);
  return sheet;
}

function fillHeader_(sheet, def) {
  const header = sheet.getRange(1, 1, 1, def.headers.length);
  header.setValues([def.headers]);
  header.setFontWeight('bold');
  header.setBackground('#0b1120');
  header.setFontColor('#38bdf8');
  sheet.setFrozenRows(1);
  sheet.setRowHeight(1, 32);

  def.headers.forEach(function (_, i) {
    sheet.setColumnWidth(i + 1, def.widths[i] || 150);
  });
}

function verifyToken_(token) {
  const expected = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (expected && String(token || '') !== expected) throw new Error('TOKEN_INVALID');
}

function parseBody_(e) {
  const raw = (e && e.postData && e.postData.contents) || '';
  if (!raw) throw new Error('EMPTY_BODY');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error('INVALID_JSON');
  }
}

function requireText_(value, label) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw new Error('缺少必填欄位：' + label);
  return text.slice(0, MAX_TEXT);
}

function message_(err) {
  return String((err && err.message) || err || 'UNKNOWN_ERROR').slice(0, 300);
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
