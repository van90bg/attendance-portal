/** tests/create-roster.test.js — A3 (2026-08-20): danh sách NV nạp NGAY lúc tạo task
 * (createTaskApi — theo ca / dán mã / task rỗng). Thay cho roster-load.test.js
 * (loadRosterApi đã xóa) + paste-batch.test.js (pasteCodes đã xóa).
 *
 * Cover: pre-fill PENDING + LISTED_AT ghi createdAt (tình huống 2,3) · quét phase 1
 * · dedupe nội bộ · filter rỗng → ok:false · dán mã (mã lạ/trùng → skipped)
 * · task rỗng count 0 · gate viewer · audit. Mock GAS + loader: tests/gas-sandbox.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeSandbox, loadAll } = require('./gas-sandbox');

const STAFF_HEAD = ['No.', 'Date', 'Staff ID', 'Staff Name', 'Staff Email', 'Agency', 'Contract Type',
  'Event ID', 'Matching Type', 'Gender', 'Department', 'Clock In Time', 'Clock Out Time', 'Actual Hours',
  'Clock In Remark', 'Clock Out Remark', 'Slot Code', 'Workstation', 'Team', 'Station'];

function seedStaff(ss) {
  ss.sheets.StaffData.appendRow(STAFF_HEAD);
  ss.sheets.StaffData.appendRow([1, '2026-08-02', 'Ops001', 'NV001', 'a@spx.com', 'GRG', 'Chính thức', '', '', '', '', '', '', '', '', '', '08:00-17:00', 'OB1', 'Inbound', 'HN2']);
  ss.sheets.StaffData.appendRow([2, '2026-08-02', 'Ops002', 'NV002', 'b@spx.com', 'FEX', 'Thời vụ', '', '', '', '', '', '', '', '', '', '08:00-17:00', 'OB2', 'Inbound', 'HN2']);
  ss.sheets.StaffData.appendRow([3, '2026-08-02', 'Ops003', 'NV003', 'c@spx.com', 'SKT', 'Chính thức', '', '', '', '', '', '', '', '', '', '17:00-01:00', 'IB1', 'Inbound', 'HN2']);
}

function logRows(ss, taskId) {
  return ss.sheets.AttendanceLog.data.filter(function (r) { return r && r[0] === taskId; });
}
function taskRows(ss) {
  return ss.sheets.AttendanceTask.data;
}

test('createTaskApi theo ca: pre-fill PENDING + LISTED_AT = createdAt (danh sách đã sẵn)', () => {
  const { ctx, ss } = makeSandbox();  // admin (DEPLOYER_EMAIL) → editor
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  seedStaff(ss);
  const res = svc.createTaskApi({ station: 'HN2', slotCode: ['08:00-17:00'], team: ['Inbound'] });
  assert.equal(res.ok, true, res.message);
  assert.equal(res.count, 2, 'Ops001 + Ops002 khớp ca 08:00-17:00');
  const rows = logRows(ss, res.taskId);
  assert.equal(rows.length, 2);
  assert.equal(rows[0][9], '-', 'status PENDING');
  assert.equal(String(rows[0][7]).length > 0, true, 'LISTED_AT = createdAt — danh sách đã sẵn tại thời điểm tạo');
  const t = taskRows(ss)[taskRows(ss).length - 1];
  assert.equal(t[2], '08:00-17:00', 'ca lưu = ca chọn (không ép Tự do)');
});

test('createTaskApi: quét phase 1 sau khi tạo kèm roster → reject already-present (đã có LISTED_AT)', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  seedStaff(ss);
  const res = svc.createTaskApi({ station: 'HN2', slotCode: ['08:00-17:00'], team: ['Inbound'] });
  assert.equal(res.ok, true, res.message);
  assert.ok(String(logRows(ss, res.taskId)[0][7]).length > 0, 'tạo task ghi LISTED_AT = createdAt');
  const sc = svc.scanStaffApi(res.taskId, 'Ops001');
  assert.equal(sc.ok, false, 'quét phase 1 → reject already-present (đã có LISTED_AT)');
});

test('createTaskApi: dedupe nội bộ — NV 2 dòng StaffData → 1 dòng', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  seedStaff(ss);
  ss.sheets.StaffData.appendRow([1, '2026-08-02', 'Ops001', 'NV001', 'a@spx.com', 'GRG', 'Chính thức', '', '', '', '', '', '', '', '', '', '08:00-17:00', 'OB1', 'Inbound', 'HN2']);  // Ops001 dòng 2
  const res = svc.createTaskApi({ station: 'HN2', slotCode: ['08:00-17:00'], team: ['Inbound'] });
  assert.equal(res.ok, true, res.message);
  assert.equal(res.count, 2, 'dedupe giữ 1 dòng/NV');
  assert.equal(logRows(ss, res.taskId).length, 2);
});

test('createTaskApi: filter rỗng → ok:false (CREATE_FAILED_EMPTY)', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  seedStaff(ss);
  const res = svc.createTaskApi({ station: 'XYZ' });
  assert.equal(res.ok, false);
  assert.match(res.message, /Không có nhân viên/i);
  assert.equal(taskRows(ss).slice(1).filter(function (t) { return t[0]; }).length, 0, 'không tạo task khi roster rỗng');
});

test('createTaskApi dán mã: mã hợp lệ → pre-fill + LISTED_AT = createdAt, mã lạ/trùng → skipped', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  seedStaff(ss);
  const res = svc.createTaskApi({ codes: ['Ops001', 'ops001', 'OPS999', 'Ops003'] });
  assert.equal(res.ok, true, res.message);
  assert.equal(res.count, 2, 'Ops001 (trùng tính 1) + Ops003');
  assert.equal(res.skippedCodes, 1, 'OPS999 không có trong dữ liệu');
  const rows = logRows(ss, res.taskId);
  assert.deepEqual(rows.map(function (r) { return r[1]; }), ['OPS001', 'OPS003'], 'đúng thứ tự + không trùng (staffId chuẩn hóa UPPER)');
  rows.forEach(function (r) {
    assert.equal(String(r[7]).length > 0, true, 'dán mã ghi LISTED_AT = createdAt — danh sách đã sẵn');
    assert.equal(r[9], '-', 'PENDING');
  });
  const t = taskRows(ss)[taskRows(ss).length - 1];
  assert.equal(t[1], '', 'dán mã → task rỗng station');
  assert.equal(t[2], 'Tự do', 'dán mã → FREE');
});

test('createTaskApi dán mã: toàn bộ mã lạ → ok:false, không tạo task', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  seedStaff(ss);
  const res = svc.createTaskApi({ codes: ['OPS999', 'OPS888'] });
  assert.equal(res.ok, false);
  assert.equal(res.skippedCodes, 2);
  assert.equal(taskRows(ss).slice(1).filter(function (t) { return t[0]; }).length, 0);
});

test('createTaskApi task rỗng (không station + không codes) → FREE, OPEN, log=0', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  seedStaff(ss);
  const res = svc.createTaskApi({});
  assert.equal(res.ok, true, res.message);
  assert.equal(res.count, 0);
  const t = taskRows(ss)[taskRows(ss).length - 1];
  assert.equal(t[2], 'Tự do', 'task rỗng → FREE');
  assert.equal(logRows(ss, res.taskId).length, 0);
});

test('createTaskApi gate: viewer → reject (requireRole_)', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'v@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  ss.sheets.Config.appendRow(['roleMap', JSON.stringify({ 'v@spx.com': 'viewer' })]);
  seedStaff(ss);
  const res = svc.createTaskApi({ station: 'HN2' });
  assert.equal(res.ok, false);
  assert.match(res.message, /quyền/);
});

test('createTaskApi: audit row được ghi (action=createTask, detail count)', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  seedStaff(ss);
  const res = svc.createTaskApi({ station: 'HN2', slotCode: ['08:00-17:00'] });
  assert.equal(res.ok, true, res.message);
  const rows = ss.sheets.AuditLog.data;
  const last = rows[rows.length - 1];
  assert.equal(last[2], 'createTask');
  assert.equal(last[3], res.taskId);
  assert.ok(String(last[4]).includes('count'), 'detail chứa count');
});

test('transitionToAttend gate: non-owner phase Mở → reject (canScanOpen_)', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'op@spx.com' });  // operator, non-editor
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  seedStaff(ss);
  ss.sheets.AttendanceTask.appendRow(['R1', 'HN2', '08:00-17:00', 'Inbound', 'Chính thức', 'open', '2026-08-17 08:00', 'owner@spx.com', '']);
  const res = svc.transitionToAttend('R1');
  assert.equal(res.ok, false);
  assert.match(res.message, /owner/i);
  const rows = ss.sheets.AttendanceTask.data;
  assert.equal(rows[rows.length - 1][5], 'open', 'task vẫn OPEN — phase không bị lật');
});

test('transitionToAttend: owner quyền → ok, chuyển sang Điểm danh (attend)', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'owner@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  seedStaff(ss);
  ss.sheets.AttendanceTask.appendRow(['R1', 'HN2', '08:00-17:00', 'Inbound', 'Chính thức', 'open', '2026-08-17 08:00', 'owner@spx.com', '']);
  const res = svc.transitionToAttend('R1');
  assert.equal(res.ok, true, res.message);
  const rows = ss.sheets.AttendanceTask.data;
  assert.equal(rows[rows.length - 1][5], 'attend');
});
