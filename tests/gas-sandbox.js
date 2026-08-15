/**
 * tests/gas-sandbox.js — Mock GAS in-memory + loader dùng chung cho smoke tests.
 *
 * Tách từ tests/all-gs-load.test.js (2026-08-11) — all-gs-load + settings-service dùng
 * chung 1 bộ mock (tránh 2 bản drift). Mock tối thiểu: SpreadsheetApp/CacheService/
 * PropertiesService/Session/Utilities/LockService/HtmlService/ContentService.
 *
 * - makeSandbox(opts): trả { ctx, ss } — ctx = globals cho vm; ss = spreadsheet in-memory.
 *   opts.activeEmail: email Session.getActiveUser() trả về (mặc định 'admin@spx.com' = editor).
 * - loadAll(ctx): load TẤT CẢ file .gs (Config → Code) vào 1 vm context, trả sandbox.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeRange(sheet, row, col, numRows, numCols) {
  return {
    getValues() {
      const out = [];
      for (let i = 0; i < numRows; i++) {
        const r = [];
        for (let j = 0; j < numCols; j++) r.push(sheet.data[row - 1 + i] ? sheet.data[row - 1 + i][col - 1 + j] : '');
        out.push(r);
      }
      return out;
    },
    setValues(vals) {
      (vals || []).forEach((v, i) => {
        const ri = row - 1 + i;
        while (sheet.data.length <= ri) sheet.data.push([]);
        (v || []).forEach((c, j) => { sheet.data[ri][col - 1 + j] = c; });
      });
      return this;
    },
    setValue(v) { (sheet.data[row - 1] || (sheet.data[row - 1] = []))[col - 1] = v; return this; },
    setFontWeight() { return this; },
    clearContent() { return this; },
  };
}

function makeSheet(name) {
  const sheet = {
    name: name,
    data: [],
    getLastRow: () => sheet.data.length,
    getLastColumn: () => (sheet.data[0] ? sheet.data[0].length : 0),
    getDataRange: () => makeRange(sheet, 1, 1, sheet.getLastRow(), Math.max(1, sheet.getLastColumn())),
    getRange: (r, c, nr, nc) => makeRange(sheet, r, c, nr === undefined ? 1 : nr, nc === undefined ? 1 : nc),
    appendRow: (vals) => { sheet.data.push(vals.slice()); },
    insertColumnAfter: () => {},
  };
  return sheet;
}

function makeSpreadsheet() {
  const sheets = {};
  return {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => { const s = makeSheet(n); sheets[n] = s; return s; },
    getId: () => 'test-spreadsheet-id',
    sheets: sheets,
  };
}

function makeCache() {
  const m = new Map();
  return {
    get: (k) => (m.has(k) ? m.get(k) : null),
    put: (k, v) => { m.set(k, v); },
    remove: (k) => { m.delete(k); },
  };
}

function makeSandbox(opts) {
  const o = opts || {};
  const activeEmail = o.activeEmail === undefined ? 'admin@spx.com' : o.activeEmail;
  const ss = makeSpreadsheet();
  const props = new Map([['DEPLOYER_EMAIL', 'admin@spx.com']]);
  // 1 cache dùng chung (như CacheService thật) — nếu tạo Map mới mỗi lần gọi thì
  // không phát hiện lỗi invalidation (bài học từ code-review 2026-08-11)
  const scriptCache = makeCache();
  const pad = (n) => String(n).padStart(2, '0');
  const ctx = {
    console: console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      openById: () => ss,
      create: () => ss,
    },
    CacheService: { getScriptCache: () => scriptCache },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => { props.set(k, v); },
      }),
    },
    Session: {
      getActiveUser: () => ({ getEmail: () => activeEmail }),
      getScriptTimeZone: () => 'Asia/Ho_Chi_Minh',
    },
    Utilities: {
      formatDate: (d, tz, fmt) => {
        const s = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
        return fmt === 'HH:mm:ss' ? s : d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + s;
      },
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    HtmlService: {
      createHtmlOutputFromFile: (f) => ({ filename: f, setTitle() { return this; }, addMetaTag() { return this; }, setXFrameOptionsMode() { return this; }, kind: 'html' }),
      createTemplateFromFile: (f) => ({ evaluate: () => ({ filename: f, setTitle() { return this; }, addMetaTag() { return this; }, setXFrameOptionsMode() { return this; }, kind: 'html' }) }),
      XFrameOptionsMode: { DEFAULT: 'DEFAULT' },
    },
    ContentService: {
      createTextOutput: (txt) => ({ content: String(txt), setMimeType() { return this; }, kind: 'text' }),
      MimeType: { JSON: 'application/json' },
    },
  };
  return { ctx, ss };
}

function loadAll(ctx) {
  const files = [
    'Config.gs', 'CsvUtil.gs', 'Spreadsheet.gs', 'Cache.gs', 'StaffDataRepo.gs',
    'TaskRepo.gs', 'LogRepo.gs', 'ScanLogic.gs', 'ScanService.gs', 'TaskService.gs',
    'Auth.gs', 'Debug.gs', 'SettingsService.gs', 'ReportRepo.gs', 'ReportService.gs', 'Code.gs',
  ];
  const sandbox = vm.createContext(ctx);
  files.forEach((f) => {
    const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    vm.runInContext(code, sandbox, { filename: f });
  });
  return sandbox;
}

module.exports = { makeSandbox, loadAll };
