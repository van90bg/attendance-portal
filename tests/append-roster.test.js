/** tests/append-roster.test.js — S1 (2026-08-21): nạp roster vào task rỗng sau khi tạo.
 * appendRosterApi — chỉ OPEN + log rỗng (né merge, giữ invariant scanned+absent==total).
 * Cover: (a) insert đúng khi OPEN + log rỗng · (b) reject non-OPEN · (c) reject log đã quét
 * · (d) double-call an toàn (lần 2 thất bại) · (e) thiếu Station · (f) filter rỗng → ok:false
 * · (g) gate viewer. Mock GAS + loader: tests/gas-sandbox.js.
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
function lastTask(ss) {
  return ss.sheets.AttendanceTask.data[ss.sheets.AttendanceTask.data.length - 1];
}

function createEmpty(ss, svc) {
  const r = svc.createTaskApi({});
  assert.equal(r.ok, true, r.message);
  assert.equal(r.count, 0);
  return r.taskId;
}

test('appendRosterApi: nạp roster vào task rỗng (OPEN + log rỗng) → insert PENDING', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  seedStaff(ss);
  const taskId = createEmpty(ss, svc);
  const res = svc.appendRosterApi({ taskId: taskId, filter: { station: 'HN2', slotCode: ['08:00-17:00'], team: ['Inbound'] } });
  assert.equal(res.ok, true, res.message);
  assert.equal(res.count, 2, 'Ops001 + Ops002 khớp ca 08:00-17:00');
  const rows = logRows(ss, taskId);
  assert.equal(rows.length, 2);
  rows.forEach(function (r) {
    assert.equal(r[9], '-', 'PENDING');
    assert.equal(String(r[7]).length > 0, true, 'LISTED_AT = thời điểm nạp');
    assert.equal(String(r[8]).length, 0, 'chưa SCANNED_AT');
  });
});

test('appendRosterApi: reject khi task không OPEN (đã ATTEND)', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  seedStaff(ss);
  const taskId = createEmpty(ss, svc);
  const tr = svc.transitionToAttend(taskId);
  assert.equal(tr.ok, true, tr.message);
  const res = svc.appendRosterApi({ taskId: taskId, filter: { station: 'HN2' } });
  assert.equal(res.ok, false);
  assert.match(res.message, /Mở/);
});

test('appendRosterApi: reject khi log đã có dòng (đã quét)', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  seedStaff(ss);
  const taskId = createEmpty(ss, svc);
  svc.scanStaff(taskId, 'Ops001', Date.now());
  const res = svc.appendRosterApi({ taskId: taskId, filter: { station: 'HN2' } });
  assert.equal(res.ok, false);
  assert.match(res.message, /đã có dữ liệu quét/);
});

test('appendRosterApi: double-call an toàn — lần 2 thất bại (log đã có PENDING)', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  seedStaff(ss);
  const taskId = createEmpty(ss, svc);
  const r1 = svc.appendRosterApi({ taskId: taskId, filter: { station: 'HN2' } });
  assert.equal(r1.ok, true, r1.message);
  const r2 = svc.appendRosterApi({ taskId: taskId, filter: { station: 'HN2' } });
  assert.equal(r2.ok, false);
  assert.match(r2.message, /đã có dữ liệu quét/);
});

test('appendRosterApi: thiếu Station → reject', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  seedStaff(ss);
  const taskId = createEmpty(ss, svc);
  const res = svc.appendRosterApi({ taskId: taskId, filter: {} });
  assert.equal(res.ok, false);
  assert.match(res.message, /Station/);
});

test('appendRosterApi: filter rỗng → ok:false, không đổi task (vẫn log 0)', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  seedStaff(ss);
  const taskId = createEmpty(ss, svc);
  const res = svc.appendRosterApi({ taskId: taskId, filter: { station: 'XYZ' } });
  assert.equal(res.ok, false);
  assert.equal(logRows(ss, taskId).length, 0);
});

test('appendRosterApi: gate viewer → reject (requireRole_ operator)', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'v@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  ss.sheets.Config.appendRow(['roleMap', JSON.stringify({ 'v@spx.com': 'viewer' })]);
  ss.sheets.AttendanceTask.appendRow(['R-viewer', 'HN2', '08:00-17:00', 'Inbound', 'Chính thức', 'open', '2026-08-17 08:00', 'admin@spx.com', '']);
  const res = svc.appendRosterApi({ taskId: 'R-viewer', filter: { station: 'HN2' } });
  assert.equal(res.ok, false);
  assert.match(res.message, /quyền/);
});

test('appendRosterApi: gate non-owner phase Mở → reject (requireOwnerOrAdmin_)', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'op2@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  seedStaff(ss);
  ss.sheets.AttendanceTask.appendRow(['R-other', 'HN2', '08:00-17:00', 'Inbound', 'Chính thức', 'open', '2026-08-17 08:00', 'owner@spx.com', '']);
  const res = svc.appendRosterApi({ taskId: 'R-other', filter: { station: 'HN2' } });
  assert.equal(res.ok, false);
  assert.match(res.message, /owner/i);
});

test('appendRosterApi: audit row được ghi (action=loadRoster, detail count)', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  seedStaff(ss);
  const taskId = createEmpty(ss, svc);
  const res = svc.appendRosterApi({ taskId: taskId, filter: { station: 'HN2' } });
  assert.equal(res.ok, true, res.message);
  const rows = ss.sheets.AuditLog.data;
  const last = rows[rows.length - 1];
  assert.equal(last[2], 'loadRoster');
  assert.equal(last[3], taskId);
});

test('appendRosterApi: cập nhật task metadata (station/slotCode/team) — không còn rỗng/Tự do', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  seedStaff(ss);
  const taskId = createEmpty(ss, svc);
  // Task rỗng ban đầu: station='', slotCode='Tự do', team=''
  const res = svc.appendRosterApi({ taskId: taskId, filter: { station: 'HN2', slotCode: ['08:00-17:00'], team: ['Inbound'] } });
  assert.equal(res.ok, true, res.message);
  // Đọc dòng task cuối
  const tasks = ss.sheets.AttendanceTask.data;
  const row = tasks.filter(function (r) { return r && r[0] === taskId; })[0];
  assert.equal(row[1], 'HN2', 'station được ghi');
  assert.equal(row[2], '08:00-17:00', 'slotCode được ghi (thay Tự do)');
  assert.equal(row[3], 'Inbound', 'team được ghi');
});
