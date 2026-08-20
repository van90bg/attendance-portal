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
const vm = require('node:vm');
const { makeSandbox, loadAll } = require('./gas-sandbox');

test('load toàn bộ .gs + ensureSheets_ tạo 5 sheet đúng header (gồm AuditLog)', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  assert.doesNotThrow(() => svc.ensureSheets_());
  assert.deepEqual(Object.keys(ss.sheets).sort(), ['AttendanceLog', 'AttendanceTask', 'AuditLog', 'Config', 'StaffData'].sort());
  // AuditLog: header 5 cột (timestamp/email/action/targetId/detail)
  assert.equal(ss.sheets.AuditLog.data[0].length, 5);
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
    taskId: taskId, station: 'HN2 SOC', slotCode: '08:00-17:00',
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
    taskId: taskId, station: 'HN2 SOC', slotCode: '08:00-17:00',
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

test('markUnscannedAbsent_: timeScan junk (không parse được) → ABSENT, không phải PRESENT (B-P1-6)', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  const taskId = 'R20260811-1001';
  svc.insertTask_({
    taskId: taskId, station: 'HN2 SOC', slotCode: '08:00-17:00',
    team: 'Outbound', contractType: '', status: 'attend', createdAt: new Date(), createdBy: 'web', completedAt: null,
  });
  // Dòng PENDING có SCANNED_AT là chuỗi rác (legacy/sửa tay) — KHÔNG tính là đã quét
  ss.sheets.AttendanceLog.appendRow(['R20260811-1001', 'OPS000001', 'A', '', 'HN2 SOC', 'Outbound', 'OB', '', 'garbage-value', '-', '']);
  const n = svc.markUnscannedAbsent_(taskId);
  assert.equal(n, 1);
  const detail = svc.readTaskDetailCached_(taskId);
  assert.equal(detail.log[0].status, 'Vắng');
});

test('batchInsertLogRows_ invalidate task detail cache — insert thêm dòng vẫn thấy đủ (B-P1-1)', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  const taskId = 'R20260811-1002';
  const now = new Date('2026-08-11T10:00:00');
  svc.insertTask_({ taskId: taskId, station: 'HN2 SOC', slotCode: '', team: '', contractType: '', status: 'attend', createdAt: now, createdBy: 'web', completedAt: null });
  svc.batchInsertLogRows_(taskId, [{ staffId: 'OPS000001', staffName: 'A', slotCode: '', station: 'HN2 SOC', team: '', workstation: '', date: '' }], now);
  assert.equal(svc.readTaskDetailCached_(taskId).log.length, 1);
  // Ghi tiếp 1 batch nữa — detail cache phải bị invalidate (trước chỉ invalidate LOG_ROWS)
  svc.batchInsertLogRows_(taskId, [{ staffId: 'OPS000002', staffName: 'B', slotCode: '', station: 'HN2 SOC', team: '', workstation: '', date: '' }], now);
  assert.equal(svc.readTaskDetailCached_(taskId).log.length, 2);
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

test('Clock In/Out Time: cell time-only format theo TZ bang tinh (sheet TZ != script TZ khong lech LMT 1899)', () => {
  // GAS dung Date cell theo TZ BANG TINH. Sheet TZ = Asia/Bangkok (LMT +06:42:04),
  // wall-clock 12:43:53 -> UTC 1899-12-30T06:01:49Z. Script TZ van Asia/Ho_Chi_Minh.
  // Bug cu: format theo getHours (TZ script HCM +07:06:40) -> 13:08:19 (lech +24:26).
  const rowOf = (d) => ['1', '8/1/2026', 'Ops000001', 'NV A', 'a@spx.com', 'GRG', 'OS', 'EV1', '', '', 'SOC', d, d, '7.6', '', '', '08:00-17:00', 'OB', 'Outbound', 'HN2 SOC'];
  const { ctx, ss } = makeSandbox({ sheetTz: 'Asia/Bangkok' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  // Date phai tao TRONG vm (cung realm) — Date o realm test file khong qua instanceof Date
  const d1 = vm.runInContext("new Date('1899-12-30T06:01:49.000Z')", ctx);
  ss.sheets.StaffData.data.push(rowOf(d1));
  const list = svc.readStaffFullList_();
  assert.equal(list.length, 1);
  assert.equal(list[0].cardIn, '12:43:53');   // = wall-clock sheet hien thi (TZ bang tinh)
  assert.equal(list[0].cardOut, '12:43:53');
  // Control: sheet TZ = HCM -> cung Date hien thi theo TZ HCM (13:08:19)
  const sandbox2 = makeSandbox();
  const svc2 = loadAll(sandbox2.ctx);
  svc2.ensureSheets_();
  const d2 = vm.runInContext("new Date('1899-12-30T06:01:49.000Z')", sandbox2.ctx);
  sandbox2.ss.sheets.StaffData.data.push(rowOf(d2));
  const list2 = svc2.readStaffFullList_();
  assert.equal(list2[0].cardIn, '13:08:19');
});

test('getTaskDetail (TaskService + isEditor_) trả permission đúng sau tách file', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  const taskId = 'R20260811-1000';
  svc.insertTask_({
    taskId: taskId, station: 'HN2 SOC', slotCode: '08:00-17:00',
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
    taskId: taskId, station: 'HN2 SOC', slotCode: '08:00-17:00',
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
  // Scan: update dòng OPS000001 → Có mặt (qua batchUpdateLogRows_ — seam B 2026-08-12 thay updateLogRowScan_ cũ)
  const rows = svc.readLogRows_(taskId);
  const row1 = rows.find((r) => r.staffId === 'OPS000001');
  assert.ok(row1, 'có row OPS000001');
  svc.batchUpdateLogRows_(taskId, [{ rowIndex: row1._rowIndex, field: 'scannedAt', time: new Date(), newStatus: 'Có mặt', keepStatus: row1.status }]);
  const detail = svc.readTaskDetailCached_(taskId);
  const updated = detail.log.find((r) => r.staffId === 'OPS000001');
  assert.equal(updated.status, 'Có mặt');
  assert.ok(Number(updated.scannedAtEpoch) > 0);
  // Search xuyên task
  const hits = svc.searchLogsByStaff('ops000001');
  assert.equal(hits.length >= 1, true);
  assert.equal(hits[0].staffId, 'OPS000001');
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

test('createReconcileTaskApi dùng UI_LABELS global trong vm shared context', () => {
  // A3: tổ hợp rỗng → message = UI_LABELS.CREATE_FAILED_EMPTY (chứng minh global
  // từ Config.gs nạp chung 1 vm context — file .gs không cần require).
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  const res = svc.createReconcileTaskApi({ station: 'KHÔNG CÓ', slotCode: ['08:00-17:00'] });
  assert.equal(res.ok, false);
  assert.equal(res.message, 'Không có nhân viên nào trong tổ hợp đã chọn');
});
