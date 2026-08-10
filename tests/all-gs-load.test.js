/**
 * tests/all-gs-load.test.js — Smoke test toàn bộ .gs (sau khi tách Database.gs 2026-08-11).
 *
 * Load TẤT CẢ file .gs (Config, CsvUtil, Spreadsheet, Cache, StaffDataRepo, TaskRepo,
 * LogRepo, ScanLogic, ScanService, TaskService, Code) vào 1 vm sandbox với mock GAS
 * tối thiểu (SpreadsheetApp/CacheService/PropertiesService/Session/Utilities/LockService).
 * Mục đích:
 *  1. Bắt lỗi load-time / thiếu global / wiring xuyên file sau khi tách file.
 *  2. Chạy 1 luồng integration repo mini: ensureSheets_ → insertTask_ + batchInsertLogRows_
 *     → readTaskList_/readTaskDetailCached_ → markUnscannedAbsent_ → overwriteStaffData_ →
 *     getTaskDetail (permission) — chứng minh repo layer gọi nhau xuyên file đúng.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ===== Mock GAS tối thiểu (in-memory) =====

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

function makeSandbox() {
  const ss = makeSpreadsheet();
  const props = new Map([['DEPLOYER_EMAIL', 'admin@spx.com']]);
  const scriptCache = makeCache(); // 1 cache dùng chung (như CacheService thật) — nếu tạo Map mới mỗi lần gọi thì không phát hiện lỗi invalidation
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
      getActiveUser: () => ({ getEmail: () => 'admin@spx.com' }),
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
    'Auth.gs', 'Debug.gs', 'Code.gs',
  ];
  const sandbox = vm.createContext(ctx);
  files.forEach((f) => {
    const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    vm.runInContext(code, sandbox, { filename: f });
  });
  return sandbox;
}

test('load toàn bộ .gs + ensureSheets_ tạo 4 sheet đúng header (sau tách Database.gs)', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  assert.doesNotThrow(() => svc.ensureSheets_());
  assert.deepEqual(Object.keys(ss.sheets).sort(), ['AttendanceLog', 'AttendanceTask', 'Config', 'StaffData'].sort());
  // StaffData: header 20 cột
  assert.equal(ss.sheets.StaffData.data[0].length, 20);
  // Log: đủ 11 cột (LOG_COL_COUNT)
  assert.equal(ss.sheets.AttendanceLog.getLastColumn(), 11);
});

test('luồng repo: insertTask_ + batchInsertLogRows_ → readTaskList_/readTaskDetailCached_ đúng counters', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  const taskId = 'R20260811-1000';
  const now = new Date('2026-08-11T10:00:00');
  svc.insertTask_({
    taskId: taskId, taskType: 'reconcile', station: 'HN2 SOC', slotCode: '08:00-17:00',
    team: 'Outbound', contractType: 'GRG', status: 'attend', createdAt: now, createdBy: 'web', completedAt: null,
  });
  const count = svc.batchInsertLogRows_(taskId, [
    { staffId: 'OPS000001', staffName: 'A', slotCode: '08:00-17:00', station: 'HN2 SOC', team: 'Outbound', workstation: 'OB', date: '2026-08-01' },
    { staffId: 'OPS000002', staffName: 'B', slotCode: '08:00-17:00', station: 'HN2 SOC', team: 'Outbound', workstation: 'OB', date: '2026-08-01' },
  ], now);
  assert.equal(count, 2);
  assert.equal(ss.sheets.AttendanceTask.getLastRow(), 2); // header + 1 task
  assert.equal(ss.sheets.AttendanceLog.getLastRow(), 3);  // header + 2 NV

  const list = svc.readTaskList_();
  assert.equal(list.length, 1);
  assert.equal(list[0].taskId, taskId);
  assert.equal(list[0].total, 2);
  assert.equal(list[0].scanned, 0);

  const detail = svc.readTaskDetailCached_(taskId);
  assert.equal(detail.task.status, 'attend');
  assert.equal(detail.log.length, 2);
  assert.equal(detail.counters.total, 2);
  assert.equal(detail.counters.absent, 2);
});

test('markUnscannedAbsent_: PENDING chưa quét → ABSENT (Vắng)', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  const taskId = 'R20260811-1000';
  svc.insertTask_({
    taskId: taskId, taskType: 'reconcile', station: 'HN2 SOC', slotCode: '08:00-17:00',
    team: 'Outbound', contractType: '', status: 'attend', createdAt: new Date(), createdBy: 'web', completedAt: null,
  });
  svc.batchInsertLogRows_(taskId, [
    { staffId: 'OPS000001', staffName: 'A', slotCode: '08:00-17:00', station: 'HN2 SOC', team: 'Outbound', workstation: 'OB', date: '' },
    { staffId: 'OPS000002', staffName: 'B', slotCode: '08:00-17:00', station: 'HN2 SOC', team: 'Outbound', workstation: 'OB', date: '' },
  ], new Date());
  const n = svc.markUnscannedAbsent_(taskId);
  assert.equal(n, 2);
  const detail = svc.readTaskDetailCached_(taskId);
  assert.equal(detail.log[0].status, 'Vắng');
  assert.equal(detail.log[1].status, 'Vắng');
});

test('overwriteStaffData_ ghi đè + readStaffList_ đọc lại qua CsvUtil parser', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  const staff = [{
    no: '1', date: '8/1/2026', staffId: 'ops000001', staffName: 'Nguyen  Van A',
    staffEmail: 'a@spx.com', agency: 'GRG', contractType: 'OS', eventId: 'EV1',
    matchingType: '', gender: '', department: 'SOC', cardIn: '07:57:01', cardOut: '',
    actualHours: '7.6', cardInRemark: '', cardOutRemark: '', slotCode: '08:00-17:00',
    workstation: 'OBLoading', team: 'Outbound', station: 'HN2 SOC',
  }];
  assert.equal(svc.overwriteStaffData_(staff), 1);
  assert.equal(ss.sheets.StaffData.getLastRow(), 2);
  const list = svc.readStaffList_();
  assert.equal(list.length, 1);
  assert.equal(list[0].staffId, 'OPS000001');          // normalize uppercase
  assert.equal(list[0].staffName, 'Nguyen Van A');     // normalize double-space
  assert.equal(list[0].contractType, 'OS');
  assert.equal(list[0].date, '2026-01-08');            // normalizeStaffDate_
});

test('getTaskDetail (TaskService + isEditor_) trả permission đúng sau tách file', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  const taskId = 'R20260811-1000';
  svc.insertTask_({
    taskId: taskId, taskType: 'reconcile', station: 'HN2 SOC', slotCode: '08:00-17:00',
    team: 'Outbound', contractType: '', status: 'attend', createdAt: new Date(), createdBy: 'admin@spx.com', completedAt: null,
  });
  svc.batchInsertLogRows_(taskId, [
    { staffId: 'OPS000001', staffName: 'A', slotCode: '08:00-17:00', station: 'HN2 SOC', team: 'Outbound', workstation: 'OB', date: '' },
  ], new Date());
  const d = svc.getTaskDetail(taskId);
  assert.equal(d.ok, true);
  assert.equal(d.task.permission.isAdmin, true);       // active email === DEPLOYER_EMAIL
  assert.equal(d.task.permission.isOwner, true);       // createdBy === active email
  assert.equal(d.log.length, 1);
});

test('batchAppendLogRows_ + updateLogRowScan_ + searchLogsByStaff/searchTasksByQuery (đường paste/quét)', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  const taskId = 'R20260811-1000';
  svc.insertTask_({
    taskId: taskId, taskType: 'reconcile', station: 'HN2 SOC', slotCode: '08:00-17:00',
    team: 'Outbound', contractType: '', status: 'attend', createdAt: new Date(), createdBy: 'web', completedAt: null,
  });
  svc.batchInsertLogRows_(taskId, [
    { staffId: 'OPS000001', staffName: 'A', slotCode: '08:00-17:00', station: 'HN2 SOC', team: 'Outbound', workstation: 'OB', date: '' },
    { staffId: 'OPS000002', staffName: 'B', slotCode: '08:00-17:00', station: 'HN2 SOC', team: 'Outbound', workstation: 'OB', date: '' },
  ], new Date());
  // Paste: append 1 dòng Dư (11 cột theo LOG_COLS)
  const res = svc.batchAppendLogRows_([
    [taskId, 'OPS000003', 'NV Lạ', '', '', '', '', null, new Date(), 'Dư', ''],
  ]);
  assert.equal(res.count, 1);
  assert.equal(ss.sheets.AttendanceLog.getLastRow(), 4); // header + 2 + 1
  // Scan: update dòng OPS000001 → Có mặt
  const rows = svc.readLogRows_(taskId);
  const row1 = rows.find((r) => r.staffId === 'OPS000001');
  assert.ok(row1, 'có row OPS000001');
  svc.updateLogRowScan_(row1, new Date(), 'Có mặt');
  const detail = svc.readTaskDetailCached_(taskId);
  const updated = detail.log.find((r) => r.staffId === 'OPS000001');
  assert.equal(updated.status, 'Có mặt');
  assert.ok(Number(updated.timeScanEpoch) > 0);
  // Search xuyên task
  const hits = svc.searchLogsByStaff('ops000001');
  assert.equal(hits.length >= 1, true);
  assert.equal(hits[0].staffId, 'OPS000001');
  const taskHits = svc.searchTasksByQuery('R20260811');
  assert.equal(taskHits.length, 1);
});

test('doGet wiring: khong debug → tra HtmlOutput index; debug=1 editor → tra JSON TextOutput', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  // Không debug → serve index.html
  const html = svc.doGet({ parameter: {} });
  assert.equal(html.kind, 'html');
  assert.equal(html.filename, 'index');
  assert.ok(ss.sheets.AttendanceTask, 'ensureSheets_ da chay trong doGet');
  // debug=1 + editor (mock Session tra admin@spx.com = DEPLOYER_EMAIL) → JSON
  const out = svc.doGet({ parameter: { debug: '1' } });
  assert.equal(out.kind, 'text');
  const parsed = JSON.parse(out.content);
  assert.ok(parsed.spreadsheetId, 'debugState_ tra cau truc');
  assert.equal(parsed.sheets.Config.rows >= 1, true);
});
