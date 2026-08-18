/**
 * tests/roster-load.test.js — Phase A (docs/roster-load-design.md): loadRosterApi.
 *
 * Cover: gate (viewer / status != open / non-owner) · filter rỗng → ok:false ·
 * dedupe nội bộ · idempotent (nạp lại → added=0, skipped=N) · append PENDING + timeRef ·
 * counters · audit. Mock GAS + loader dùng chung: tests/gas-sandbox.js.
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

// AttendanceTask 9 cột (TASK_COLS): taskId, station, slotCode, team, contractType, status, createdAtText, createdBy, completedAt
function seedTask(ss, taskId, status, createdBy) {
  ss.sheets.AttendanceTask.appendRow([taskId, 'HN2', '08:00-17:00', 'Inbound', 'Chính thức', status, '2026-08-17 08:00', createdBy, '']);
}

function logRows(ss, taskId) {
  return ss.sheets.AttendanceLog.data.filter(function (r) { return r && r[0] === taskId; });
}

test('loadRosterApi: append PENDING + timeRef cho NV khớp tổ hợp (A1)', () => {
  const { ctx, ss } = makeSandbox();  // admin (DEPLOYER_EMAIL) → owner gate mở
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  seedStaff(ss);
  seedTask(ss, 'R1', 'open', 'admin@spx.com');
  const res = svc.loadRosterApi('R1', { station: 'HN2', slotCode: ['08:00-17:00'], team: ['Inbound'] });
  assert.equal(res.ok, true, res.message);
  assert.equal(res.added, 2, 'Ops001 + Ops002 khớp ca 08:00-17:00');
  assert.equal(res.skipped, 0);
  assert.equal(res.total, 2);
  const rows = logRows(ss, 'R1');
  assert.equal(rows.length, 2);
  assert.equal(rows[0][9], '-', 'status PENDING');
  assert.ok(String(rows[0][7]).length > 0, 'timeRef (LISTED_AT) đã ghi');
  assert.equal(res.counters.total, 2);
});

test('loadRosterApi: idempotent — nạp lại → added=0, skipped=2, không trùng dòng', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  seedStaff(ss);
  seedTask(ss, 'R1', 'open', 'admin@spx.com');
  const f = { station: 'HN2', slotCode: ['08:00-17:00'], team: ['Inbound'] };
  const r1 = svc.loadRosterApi('R1', f);
  assert.equal(r1.added, 2);
  const r2 = svc.loadRosterApi('R1', f);
  assert.equal(r2.ok, true, r2.message);
  assert.equal(r2.added, 0);
  assert.equal(r2.skipped, 2);
  assert.equal(logRows(ss, 'R1').length, 2, 'log không nhân đôi');
});

test('loadRosterApi: bỏ qua NV đã có dòng (quét phase 1) — thêm đúng NV còn thiếu', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  seedStaff(ss);
  seedTask(ss, 'R1', 'open', 'admin@spx.com');
  // Ops001 đã quét phase 1 (có dòng PENDING + timeRef)
  ss.sheets.AttendanceLog.appendRow(['R1', 'Ops001', 'NV001', '08:00-17:00', 'HN2', 'Inbound', 'OB1', '08:00:00', '', '-', '2026-08-02']);
  const res = svc.loadRosterApi('R1', { station: 'HN2', slotCode: ['08:00-17:00'], team: ['Inbound'] });
  assert.equal(res.ok, true, res.message);
  assert.equal(res.added, 1, 'chỉ thêm Ops002');
  assert.equal(res.skipped, 1, 'Ops001 đã có dòng → bỏ qua');
  assert.equal(logRows(ss, 'R1').length, 2);
});

test('loadRosterApi: dedupe nội bộ — NV 2 dòng StaffData → 1 dòng', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  seedStaff(ss);
  ss.sheets.StaffData.appendRow([1, '2026-08-02', 'Ops001', 'NV001', 'a@spx.com', 'GRG', 'Chính thức', '', '', '', '', '', '', '', '', '', '08:00-17:00', 'OB1', 'Inbound', 'HN2']);  // Ops001 dòng 2
  seedTask(ss, 'R1', 'open', 'admin@spx.com');
  const res = svc.loadRosterApi('R1', { station: 'HN2', slotCode: ['08:00-17:00'], team: ['Inbound'] });
  assert.equal(res.ok, true, res.message);
  assert.equal(res.total, 2, 'dedupe giữ 1 dòng/NV');
  assert.equal(res.added, 2);
  assert.equal(logRows(ss, 'R1').length, 2);
});

test('loadRosterApi: thiếu station → ok:false (guard server — P1)', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  seedStaff(ss);
  seedTask(ss, 'R1', 'open', 'admin@spx.com');
  const res = svc.loadRosterApi('R1', {});  // payload thiếu station → KHÔNG nạp toàn bộ staff
  assert.equal(res.ok, false);
  assert.match(res.message, /Thiếu station/);
  assert.equal(logRows(ss, 'R1').length, 0, 'không được nạp nhầm staff');
});

test('loadRosterApi: filter rỗng → ok:false (CREATE_FAILED_EMPTY)', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  seedStaff(ss);
  seedTask(ss, 'R1', 'open', 'admin@spx.com');
  const res = svc.loadRosterApi('R1', { station: 'XYZ' });
  assert.equal(res.ok, false);
  assert.match(res.message, /Không có nhân viên/i);
});

test('loadRosterApi gate: status != open → reject', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  seedStaff(ss);
  seedTask(ss, 'R1', 'attend', 'admin@spx.com');
  const res = svc.loadRosterApi('R1', { station: 'HN2' });
  assert.equal(res.ok, false);
  assert.match(res.message, /phase Mở/);
});

test('loadRosterApi gate: non-owner phase Mở → reject (canScanOpen_)', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'op@spx.com' });  // operator, non-editor
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  seedStaff(ss);
  seedTask(ss, 'R1', 'open', 'owner@spx.com');
  const res = svc.loadRosterApi('R1', { station: 'HN2' });
  assert.equal(res.ok, false);
  assert.match(res.message, /owner/i);
});

test('loadRosterApi gate: viewer → reject (requireRole_)', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'v@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  ss.sheets.Config.appendRow(['roleMap', JSON.stringify({ 'v@spx.com': 'viewer' })]);
  seedStaff(ss);
  seedTask(ss, 'R1', 'open', 'admin@spx.com');
  const res = svc.loadRosterApi('R1', { station: 'HN2' });
  assert.equal(res.ok, false);
  assert.match(res.message, /quyền/);
});

test('loadRosterApi: audit row được ghi (action=loadRoster)', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  seedStaff(ss);
  seedTask(ss, 'R1', 'open', 'admin@spx.com');
  const res = svc.loadRosterApi('R1', { station: 'HN2', slotCode: ['08:00-17:00'] });
  assert.equal(res.ok, true, res.message);
  const rows = ss.sheets.AuditLog.data;
  const last = rows[rows.length - 1];
  assert.equal(last[2], 'loadRoster');
  assert.equal(last[3], 'R1');
  assert.ok(String(last[4]).includes('added'), 'detail chứa added/skipped');
});
