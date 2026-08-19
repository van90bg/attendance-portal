/**
 * tests/cancel-task.test.js — cancelTask: hủy task phase Mở với log rỗng (xóa hẳn).
 *
 * Cover: gate (viewer / non-owner / status != open) · log có dữ liệu → reject ·
 * thành công → xóa dòng task khỏi AttendanceTask + cache + audit. Mock GAS + loader
 * dùng chung: tests/gas-sandbox.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeSandbox, loadAll } = require('./gas-sandbox');

function seedTask(ss, taskId, status, createdBy) {
  ss.sheets.AttendanceTask.appendRow([taskId, 'HN2', '08:00-17:00', 'Inbound', 'Chính thức', status, '2026-08-17 08:00', createdBy, '']);
}

test('cancelTask: thành công — task OPEN + log rỗng → xóa khỏi sheet + cache + audit', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  seedTask(ss, 'R1', 'open', 'admin@spx.com');
  const res = svc.cancelTask('R1');
  assert.equal(res.ok, true, res.message);
  const tasks = ss.sheets.AttendanceTask.data.filter((r) => r && r[0] === 'R1');
  assert.equal(tasks.length, 0, 'dòng task đã xóa');
  assert.equal(svc.readTask_('R1'), null, 'readTask_ sau hủy = null');
  assert.equal(svc.readTaskList_().length, 0, 'danh sách task không còn R1');
  const rows = ss.sheets.AuditLog.data;
  assert.equal(rows[rows.length - 1][2], 'cancelTask');
  assert.equal(rows[rows.length - 1][3], 'R1');
});

test('cancelTask: status != open (attend) → reject, không xóa', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  seedTask(ss, 'R1', 'attend', 'admin@spx.com');
  const res = svc.cancelTask('R1');
  assert.equal(res.ok, false);
  assert.match(res.message, /phase Mở/);
  const tasks = ss.sheets.AttendanceTask.data.filter((r) => r && r[0] === 'R1');
  assert.equal(tasks.length, 1, 'task vẫn còn');
});

test('cancelTask: log có dữ liệu (quét phase 1) → reject, không xóa', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  seedTask(ss, 'R1', 'open', 'admin@spx.com');
  ss.sheets.AttendanceLog.appendRow(['R1', 'Ops001', 'NV001', '08:00-17:00', 'HN2', 'Inbound', 'OB1', '08:00:00', '', '-', '2026-08-02']);
  const res = svc.cancelTask('R1');
  assert.equal(res.ok, false);
  assert.match(res.message, /có dữ liệu quét/);
  const tasks = ss.sheets.AttendanceTask.data.filter((r) => r && r[0] === 'R1');
  assert.equal(tasks.length, 1, 'task vẫn còn');
  assert.equal(svc.readLogRows_('R1').length, 1, 'log giữ nguyên');
});

test('cancelTask gate: non-owner phase Mở → reject (canScanOpen_)', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'op@spx.com' });  // operator, non-editor
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  seedTask(ss, 'R1', 'open', 'owner@spx.com');
  const res = svc.cancelTask('R1');
  assert.equal(res.ok, false);
  assert.match(res.message, /owner/i);
});

test('cancelTask gate: viewer → reject (requireRole_)', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'v@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  ss.sheets.Config.appendRow(['roleMap', JSON.stringify({ 'v@spx.com': 'viewer' })]);
  seedTask(ss, 'R1', 'open', 'admin@spx.com');
  const res = svc.cancelTask('R1');
  assert.equal(res.ok, false);
  assert.match(res.message, /quyền/);
});

test('cancelTask: task không tồn tại → reject', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  const res = svc.cancelTask('R1');
  assert.equal(res.ok, false);
  assert.match(res.message, /Không tìm thấy task/);
});
