/**
 * tests/all-gs-load.test.js — Smoke test toàn bộ .gs (sau khi tách Database.gs 2026-08-11).
 *
 * Load TẤT CẢ file .gs (Config, CsvUtil, Spreadsheet, Cache, StaffDataRepo, TaskRepo,
 * LogRepo, ScanLogic, ScanService, TaskService, Auth, Debug, SettingsService, Code) vào
 * 1 vm sandbox với mock GAS tối thiểu — mock + loader dùng chung ở tests/gas-sandbox.js
 * (all-gs-load + settings-service cùng 1 bộ mock, tránh 2 bản drift).
 * Mục đích:
 *  1. Bắt lỗi load-time / thiếu global / wiring xuyên file sau khi tách file.
 *  2. Chạy 1 luồng integration repo mini: ensureSheets_ → insertTask_ + batchInsertLogRows_
 *     → readTaskList_/readTaskDetailCached_ → markUnscannedAbsent_ → overwriteStaffData_ →
 *     getTaskDetail (permission) — chứng minh repo layer gọi nhau xuyên file đúng.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeSandbox, loadAll } = require('./gas-sandbox');

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
