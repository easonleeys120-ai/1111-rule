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
      return { time: row[0], log_id: row[1], user: row[2], task: row[3], status: row[4], iso: row[5] };
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
      return { time: row[0], log_id: row[1], title: row[2], decision: row[3], owner: row[4], status: row[5], iso: row[6] };
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
      return { time: row[0], log_id: row[1], title: row[2], category: row[3], summary: row[4], iso: row[5] };
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
    if (action === 'search') {
      const key = String(params.sheet || '');
      if (!SHEET_DEFS[key]) return json_({ ok: false, error: 'UNKNOWN_SHEET' });
      const q = String(params.q || '').toLowerCase().trim();
      const rows = listRecords_(key, 500);
      const filtered = q ? rows.filter(function (r) {
        return Object.keys(r).some(function (k) {
          return String(r[k] == null ? '' : r[k]).toLowerCase().indexOf(q) >= 0;
        });
      }) : rows;
      return json_({ ok: true, sheet: key, rows: filtered.slice(0, 100) });
    }
    return json_({ ok: false, error: 'UNKNOWN_ACTION' });
  } catch (err) {
    return json_({ ok: false, error: message_(err) });
  }
}

function doPost(e) {
  try {
    const body = parseBody_(e);

    // LINE Messaging API webhook（自動捕捉加好友者的 userId）
    if (Array.isArray(body.events)) {
      handleLineWebhook_(body);
      return json_({ ok: true });
    }

    verifyToken_(body.token);

    const action = body.action || 'submit';
    if (action === 'submit') {
      const key = String(body.sheet || '');
      if (!SHEET_DEFS[key]) return json_({ ok: false, error: 'UNKNOWN_SHEET' });
      return json_({ ok: true, sheet: key, record: appendRecord_(key, body.payload || {}) });
    }
    if (action === 'update') {
      const key = String(body.sheet || '');
      if (!SHEET_DEFS[key]) return json_({ ok: false, error: 'UNKNOWN_SHEET' });
      if (!body.id) return json_({ ok: false, error: 'MISSING_ID' });
      return json_({ ok: true, sheet: key, record: updateRecord_(key, String(body.id), body.payload || {}) });
    }
    if (action === 'search') {
      const key = String(body.sheet || '');
      if (!SHEET_DEFS[key]) return json_({ ok: false, error: 'UNKNOWN_SHEET' });
      const q = String(body.q || '').toLowerCase().trim();
      const rows = listRecords_(key, 500);
      const filtered = q ? rows.filter(function (r) {
        return Object.keys(r).some(function (k) {
          return String(r[k] == null ? '' : r[k]).toLowerCase().indexOf(q) >= 0;
        });
      }) : rows;
      return json_({ ok: true, sheet: key, rows: filtered.slice(0, 100) });
    }
    return json_({ ok: false, error: 'UNKNOWN_ACTION' });
  } catch (err) {
    return json_({ ok: false, error: message_(err) });
  }
}

function handleLineWebhook_(body) {
  const props = PropertiesService.getScriptProperties();
  const existing = (props.getProperty('LINE_RECIPIENT_IDS') || '')
    .split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  const set = {};
  existing.forEach(function (id) { set[id] = true; });

  (body.events || []).forEach(function (ev) {
    const uid = ev && ev.source && ev.source.userId;
    if (uid && !set[uid]) { set[uid] = true; existing.push(uid); }
  });

  if (existing.length) {
    props.setProperty('LINE_RECIPIENT_IDS', existing.join(','));
  }
  Logger.log('LINE webhook: ' + (body.events || []).length + ' events; recipients=' + existing.join(','));
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
      .addItem('0. 填入範例資料（日期/提醒/會議/情報）', 'seedSampleData')
      .addItem('1. 初始化工作表', 'setup')
      .addItem('2. 設定每日 08:00 LINE 推播', 'setupDailyPush')
      .addItem('3. 顯示 LINE Webhook 網址', 'showWebhookInfo')
      .addItem('4. 測試新聞抓取', 'testNewsFetch')
      .addItem('5. 顯示部署設定', 'showDeployInfo')
      .addToUi();
  } catch (err) {
    Logger.log(err);
  }
}

function showWebhookInfo() {
  const url = ScriptApp.getService().getUrl();
  const text = url
    ? 'LINE Webhook 網址（貼到 LINE Developers → Webhook URL）：\n' + url +
      '\n\n步驟：\n1. LINE Developers Console → 你的 channel → Messaging API 分頁\n' +
      '2. Webhook URL 貼上上面網址 → Verify\n' +
      '3. Use webhook：開啟\n' +
      '4. 用 LINE 加 Bot 為好友，你的 userId 會自動寫入指令碼屬性 LINE_RECIPIENT_IDS\n' +
      '5. 到 Apps Script → 專案設定 → 指令碼屬性 確認 LINE_RECIPIENT_IDS 已出現'
    : '尚未部署。請先「部署 → 新增部署作業 → 網頁應用程式」。';
  try {
    SpreadsheetApp.getUi().alert('LINE Webhook', text, SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) {
    Logger.log(text);
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

function updateRecord_(key, id, payload) {
  const def = SHEET_DEFS[key];
  const sheet = ensureSheet_(key);
  const lock = LockService.getScriptLock();

  lock.waitLock(10000);
  try {
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) throw new Error('NOT_FOUND');

    const ids = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
    let targetRow = -1;
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === id) { targetRow = i + 2; break; }
    }
    if (targetRow < 0) throw new Error('NOT_FOUND');

    const now = new Date();
    const base = {
      time: Utilities.formatDate(now, TZ, 'HH:mm:ss'),
      iso: Utilities.formatDate(now, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"),
      log_id: id,
      status: def.defaultStatus
    };
    const values = def.write(payload, base);
    sheet.getRange(targetRow, 1, 1, values.length).setValues([values]);
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

/* ============================ 08:00 每日 LINE 推播 ============================ */

function fetchNews_(query, maxItems) {
  maxItems = maxItems || 8;
  const props = PropertiesService.getScriptProperties();
  const geminiKey = props.getProperty('GEMINI_API_KEY');

  // 優先：用 Gemini + Google Search grounding 取得真實可開啟連結
  if (geminiKey) {
    const geminiNews = fetchNewsWithGemini_(geminiKey, maxItems);
    if (geminiNews.length > 0) return geminiNews;
  }

  // 備援：直接 RSS 來源（Digitimes 等，連結可直接開啟）
  const directNews = fetchNewsFromDirectSources_(maxItems);
  if (directNews.length > 0) return directNews;

  // 最後手段：Google News RSS（連結可能無法在 LINE 內開啟，建議設定 GEMINI_API_KEY）
  return fetchNewsFromGoogleNews_(maxItems);
}

function fetchNewsFromDirectSources_(maxItems) {
  const items = [];
  const seen = {};
  const sources = [
    { name: 'DIGITIMES', url: 'https://www.digitimes.com/rss/daily.xml' }
  ];
  const keywords = ['鋰電', '儲能', '電池', 'battery', 'lithium', 'BESS', '電動車', '能源', '充電', 'solar', '光電', 'AI', '伺服器'];

  sources.forEach(function (src) {
    try {
      const res = UrlFetchApp.fetch(src.url, { muteHttpExceptions: true, followRedirects: true });
      if (res.getResponseCode() !== 200) return;
      const doc = XmlService.parse(res.getContentText());
      const channel = doc.getRootElement().getChild('channel');
      if (!channel) return;
      const rssItems = channel.getChildren('item');
      for (let i = 0; i < rssItems.length && items.length < maxItems; i++) {
        const it = rssItems[i];
        const title = textOf_(it, 'title');
        const link = textOf_(it, 'link');
        if (!title || !link) continue;
        const lower = (title + ' ' + textOf_(it, 'description')).toLowerCase();
        const match = keywords.some(function (k) { return lower.indexOf(k.toLowerCase()) >= 0; });
        if (!match) continue;
        const key = title.slice(0, 40);
        if (seen[key]) continue;
        seen[key] = true;
        items.push({ title: title, link: link, source: src.name });
      }
    } catch (e) {
      Logger.log('fetchNewsFromDirectSources_ ' + src.name + ' failed: ' + e);
    }
  });

  return items.slice(0, maxItems);
}

function fetchNewsWithGemini_(apiKey, maxItems) {
  const items = [];
  const seen = {};
  try {
    const prompt = '請搜尋最近 3 天關於「鋰電池、儲能系統、BESS、lithium battery」的最新新聞，' +
      '優先 CNN、BBC、UDN、Digitimes 等來源。輸出 JSON 陣列，每項含 title（標題）、url（原文連結）、source（媒體名稱），' +
      '共 ' + maxItems + ' 筆，不要其他文字。';

    const res = UrlFetchApp.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + apiKey,
      {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }]
        }),
        muteHttpExceptions: true
      }
    );
    if (res.getResponseCode() !== 200) {
      Logger.log('Gemini news failed: ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
      return items;
    }
    const j = JSON.parse(res.getContentText());
    const text = j && j.candidates && j.candidates[0] && j.candidates[0].content &&
      j.candidates[0].content.parts && j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text;
    if (text) {
      // 嘗試解析 JSON
      const jsonMatch = String(text).match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          parsed.forEach(function (n) {
            if (!n || !n.title) return;
            const key = String(n.title).slice(0, 40);
            if (seen[key]) return;
            seen[key] = true;
            items.push({
              title: String(n.title),
              link: String(n.url || ''),
              source: String(n.source || 'Gemini')
            });
          });
        } catch (e) { Logger.log('Gemini JSON parse failed: ' + e); }
      }
    }
    // 也從 groundingMetadata 取得來源連結（備援）
    const chunks = j && j.candidates && j.candidates[0] && j.candidates[0].groundingMetadata &&
      j.candidates[0].groundingMetadata.groundingChunks;
    if (chunks && items.length === 0) {
      chunks.forEach(function (c) {
        if (c.web && c.web.uri) {
          items.push({ title: c.web.title || c.web.uri, link: c.web.uri, source: 'Gemini' });
        }
      });
    }
  } catch (e) {
    Logger.log('fetchNewsWithGemini_ failed: ' + e);
  }
  return items.slice(0, maxItems);
}

function fetchNewsFromGoogleNews_(maxItems) {
  const items = [];
  const seen = {};
  try {
    const res = UrlFetchApp.fetch(
      'https://news.google.com/rss/search?q=' + encodeURIComponent('鋰電池 OR lithium battery OR 儲能 OR BESS') +
      '&hl=zh-TW&gl=TW&ceid=TW:zh-Hant',
      { muteHttpExceptions: true }
    );
    if (res.getResponseCode() === 200) {
      const doc = XmlService.parse(res.getContentText());
      const channel = doc.getRootElement().getChild('channel');
      if (channel) {
        const rssItems = channel.getChildren('item');
        for (let i = 0; i < rssItems.length && items.length < maxItems; i++) {
          const it = rssItems[i];
          const title = textOf_(it, 'title');
          const link = textOf_(it, 'link');
          if (!title || !link) continue;
          const key = title.slice(0, 40);
          if (seen[key]) continue;
          seen[key] = true;
          items.push({ title: title, link: link, source: textOf_(it, 'source') || 'Google News' });
        }
      }
    }
  } catch (e) { Logger.log('fetchNewsFromGoogleNews_ failed: ' + e); }
  return items;
}

function aiSummarizeNews_(news) {
  if (!news || !news.length) return '';
  const props = PropertiesService.getScriptProperties();
  const geminiKey = props.getProperty('GEMINI_API_KEY');
  const openaiKey = props.getProperty('OPENAI_API_KEY');

  const headlines = news.map(function (n, i) {
    return (i + 1) + '. ' + n.title + (n.source ? ' [' + n.source + ']' : '');
  }).join('\n');

  const prompt = '你是新能源產業分析師。以下是最新的鋰電池/儲能產業新聞標題，請用繁體中文寫一段 80-120 字的重點摘要，指出市場趨勢與對行銷團隊的啟示。只輸出摘要段落，不要條列：\n' + headlines;

  // 優先用 Gemini
  if (geminiKey) {
    try {
      const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + geminiKey;
      const res = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        muteHttpExceptions: true
      });
      if (res.getResponseCode() === 200) {
        const j = JSON.parse(res.getContentText());
        const t = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text;
        if (t) return String(t).trim();
      }
    } catch (e) { Logger.log('Gemini failed: ' + e); }
  }

  // 備援：ChatGPT
  if (openaiKey) {
    try {
      const res = UrlFetchApp.fetch('https://api.openai.com/v1/chat/completions', {
        method: 'post',
        headers: { 'Authorization': 'Bearer ' + openaiKey, 'Content-Type': 'application/json' },
        payload: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 200
        }),
        muteHttpExceptions: true
      });
      if (res.getResponseCode() === 200) {
        const j = JSON.parse(res.getContentText());
        const t = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
        if (t) return String(t).trim();
      }
    } catch (e) { Logger.log('OpenAI failed: ' + e); }
  }

  return '';
}

function textOf_(parent, tag) {
  const el = parent.getChild(tag);
  return el ? String(el.getText() || '').trim() : '';
}

function dailyPush() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('LINE_CHANNEL_TOKEN');
  const recipientsRaw = props.getProperty('LINE_RECIPIENT_IDS') || '';
  const recipients = recipientsRaw.split(',').map(function (s) { return s.trim(); }).filter(Boolean);

  if (!token || !recipients.length) {
    Logger.log('dailyPush skipped: LINE_CHANNEL_TOKEN / LINE_RECIPIENT_IDS not set');
    return;
  }

  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const dailyRows = listRecords_('daily', 100).filter(function (r) {
    return String(r.iso || '').slice(0, 10) === today;
  });
  const reportRows = listRecords_('report', 5);

  // 自動抓取新聞（Google News 聚合 CNN/BBC/UDN/Digitimes 等，含可點連結）
  const news = fetchNews_('鋰電池 OR lithium battery OR 儲能 OR BESS', 8);

  // 選用：用 Gemini / ChatGPT 產生摘要（需在指令碼屬性設定 GEMINI_API_KEY 或 OPENAI_API_KEY）
  const aiSummary = aiSummarizeNews_(news);

  let text = '【行銷團隊每日晨報】' + today + '\n\n';

  text += '📋 今日提醒（' + dailyRows.length + ' 筆）\n';
  if (dailyRows.length) {
    dailyRows.slice(0, 12).forEach(function (r) {
      text += '• ' + (r.user || '') + '：' + (r.task || '') + '\n';
    });
  } else {
    text += '（尚無人填報）\n';
  }

  text += '\n📊 最新鋰電市場情報\n';
  if (reportRows.length) {
    reportRows.slice(0, 3).forEach(function (r) {
      text += '• ' + (r.title || '') + '（' + (r.category || '') + '）\n';
      if (r.summary) text += '  ' + r.summary + '\n';
    });
  } else {
    text += '（尚無報告）\n';
  }

  text += '\n📰 產業新聞（CNN / BBC / UDN / Digitimes 等，點連結可開啟）\n';
  if (aiSummary) {
    text += aiSummary + '\n\n';
  }
  if (news.length) {
    news.slice(0, 5).forEach(function (n) {
      text += '• ' + n.title + (n.source ? '  [' + n.source + ']' : '') + '\n';
      if (n.link) text += n.link + '\n';
    });
  } else {
    text += '（暫無新聞）\n';
  }

  text += '\n後台試算表：' + getSpreadsheet_().getUrl();

  // 組成 LINE 訊息：文字 + 新聞 Flex Message（按鈕可開啟）
  const messages = [];
  messages.push({ type: 'text', text: text });

  // 新聞用 Flex Message 附按鈕，確保連結可開啟
  if (news.length) {
    const newsContents = news.slice(0, 5).map(function (n) {
      return {
        type: 'box',
        layout: 'vertical',
        margin: 'md',
        contents: [
          {
            type: 'text',
            text: n.title + (n.source ? '  [' + n.source + ']' : ''),
            wrap: true,
            size: 'sm',
            weight: 'bold',
            color: '#111111'
          },
          {
            type: 'button',
            style: 'link',
            height: 'sm',
            action: { type: 'uri', label: '開啟新聞 ➔', uri: n.link }
          }
        ]
      };
    });

    messages.push({
      type: 'flex',
      altText: '產業新聞（' + news.length + ' 則）',
      contents: {
        type: 'bubble',
        size: 'giga',
        header: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: '📰 產業新聞', weight: 'bold', size: 'md', color: '#ffffff' },
            { type: 'text', text: 'CNN / BBC / UDN / Digitimes 等', size: 'xs', color: '#ffffff', margin: 'sm' }
          ],
          backgroundColor: '#1e3a5f',
          paddingAll: '12px'
        },
        body: {
          type: 'box',
          layout: 'vertical',
          contents: newsContents,
          spacing: 'sm',
          paddingAll: '12px'
        }
      }
    });
  }

  recipients.forEach(function (to) {
    try {
      const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
        method: 'post',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json'
        },
        payload: JSON.stringify({ to: to, messages: messages }),
        muteHttpExceptions: true
      });
      Logger.log('push ' + to + ' => ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
    } catch (e) {
      Logger.log('push failed for ' + to + ': ' + e);
    }
  });
}

function setupDailyPush() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyPush') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyPush')
    .timeBased()
    .everyDays(1)
    .atHour(8)
    .nearMinute(0)
    .inTimezone(TZ)
    .create();
  try {
    SpreadsheetApp.getUi().alert('已設定每日 08:00 (' + TZ + ') 自動推播至 LINE');
  } catch (e) {
    Logger.log('trigger created');
  }
}

function seedSampleData() {
  const samples = {
    daily: [
      { user: 'Alex (行銷主管)', task: '確認 Q4 歐洲儲能展預算與攤位規劃' },
      { user: 'Elena (海外/儲能)', task: '追蹤歐洲展覽樣品清關與物流進度' },
      { user: 'Kevin (展覽/企劃)', task: '完成東南亞換電櫃型錄英文校對' },
      { user: 'Sarah (數位投放)', task: '檢查碳酸鋰降價議題相關關鍵字 CPC' }
    ],
    meeting: [
      { title: 'Q4 歐洲儲能展宣傳策略對齊會', decision: '確定採用液冷櫃作為展出核心視覺亮點', owner: 'Kevin (企劃)' },
      { title: '歐盟電池護照法規研商', decision: '委託第三方檢驗機構進行碳足跡認證', owner: 'Elena (海外/儲能)' },
      { title: 'AI 資料中心 BESS 方案推廣', decision: '完成 4C 快充倍率電芯白皮書初稿', owner: 'Alex (行銷主管)' }
    ],
    report: [
      { title: '印尼兩輪機車換電電芯標準分析', category: '東南亞兩輪電氣化', summary: '主攻耐高溫防水防爆規格電芯' },
      { title: '歐盟電池護照數位申報指引', category: '歐盟電池法規合規', summary: '需於 Q3 前完成全生命週期碳審核' },
      { title: '2026 北美微電網 LFP 儲能櫃需求預測', category: '工商業 C&I 儲能', summary: '鎖定加州微電網補貼，聯合當地 SI 系統整合商切入' }
    ]
  };

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    Object.keys(samples).forEach(function (key) {
      samples[key].forEach(function (payload) {
        try { appendRecord_(key, payload); } catch (e) { Logger.log('seed ' + key + ' failed: ' + e); }
      });
    });
  } finally {
    lock.releaseLock();
  }

  try {
    SpreadsheetApp.getUi().alert('已填入範例資料：每日提醒 4 筆、會議紀錄 3 筆、市場情報 3 筆');
  } catch (e) {
    Logger.log('seed done');
  }
}

function testNewsFetch() {
  const news = fetchNews_('test', 8);
  Logger.log('=== 新聞抓取測試：' + news.length + ' 則 ===');
  news.forEach(function (n, i) {
    Logger.log((i + 1) + '. ' + n.title + ' [' + n.source + ']');
    Logger.log('   ' + n.link);
  });
  if (news.length === 0) {
    Logger.log('沒有抓到新聞。若已設定 GEMINI_API_KEY，檢查 API key 是否有效。');
  }
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
