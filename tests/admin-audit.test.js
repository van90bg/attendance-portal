/**
 * tests/admin-audit.test.js — Audit log + Admin console (mở rộng phân quyền).
 *
 * Cover: audit_ ghi row AuditLog đúng cột; getAuditLogApi gate (operator chặn /
 * manager nhận rows, mới nhất trước); getAllTasksApi gate (operator chặn /
 * manager nhận tasks); scanStaff + completeTask ghi audit vào sheet.
 *
 * Mock GAS + loader dùng chung: tests/gas-sandbox.js (loadAll: toàn bộ .gs).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeSandbox, loadAll } = require('./gas-sandbox');

test('audit_: ghi row AuditLog đúng cột (timestamp/email/action/targetId/detail)', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'manager@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  svc.audit_('completeTask', 'R2026', { absentCount: 2 });
  const rows = ss.sheets.AuditLog.data;
  assert.equal(rows.length, 2); // header + 1 row
  assert.ok(rows[1][0], 'timestamp');            // ISO
  assert.equal(rows[1][1], 'manager@spx.com');   // email
  assert.equal(rows[1][2], 'completeTask');      // action
  assert.equal(rows[1][3], 'R2026');             // targetId
  assert.ok(rows[1][4].includes('absentCount')); // detail JSON
});

test('getAuditLogApi: operator bị chặn (ok:false) — gate manager+', () => {
  const { ctx } = makeSandbox({ activeEmail: 'op@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  // op@spx.com chưa cấu hình roleMap → operator mặc định → bị chặn
  const blocked = svc.getAuditLogApi(50);
  assert.equal(blocked.ok, false);
});

test('getAuditLogApi: manager nhận rows, mới nhất trước', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'mgr@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  ss.sheets.Config.appendRow(['roleMap', JSON.stringify({ 'mgr@spx.com': 'manager' })]);
  svc.audit_('scan', 'R2026', { staffId: 'Ops1' });
  svc.audit_('createTask', 'R2027', {});
  const res = svc.getAuditLogApi(50);
  assert.equal(res.ok, true);
  assert.equal(res.rows.length, 2);
  assert.equal(res.rows[0].action, 'createTask'); // mới nhất đứng trước
  assert.equal(res.rows[0].email, 'mgr@spx.com');
});

test('getAuditLogApi: nâng role operator→manager giữa phiên vẫn qua (invalidate cache)', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'op@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  svc.audit_('settings', '', { saved: ['roleMap'] });
  assert.equal(svc.getAuditLogApi(50).ok, false); // operator — cache settings (chưa có roleMap)
  ss.sheets.Config.appendRow(['roleMap', JSON.stringify({ 'op@spx.com': 'manager' })]);
  svc.invalidateSettingsCache_();                 // cache 60s — bỏ để đọc roleMap mới
  const res = svc.getAuditLogApi(50);
  assert.equal(res.ok, true);
  assert.equal(res.rows.length, 1);
});

test('getAllTasksApi: operator bị chặn, manager nhận danh sách task', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'op@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  ss.sheets.AttendanceTask.appendRow(['R2026', 'reconcile', 'HN SOC', '08:00-17:00', 'Inbound', 'Full', 'open', '2026-08-17 08:00', 'owner@spx.com', '']);
  assert.equal(svc.getAllTasksApi().ok, false);   // operator
  ss.sheets.Config.appendRow(['roleMap', JSON.stringify({ 'op@spx.com': 'manager' })]);
  svc.invalidateSettingsCache_();
  const res = svc.getAllTasksApi();
  assert.equal(res.ok, true);
  assert.ok(Array.isArray(res.tasks));
  assert.equal(res.tasks.length, 1);
  assert.equal(res.tasks[0].taskId, 'R2026');
});

test('scanStaff KHÔNG ghi audit — bỏ audit tần suất cao (chống phình AuditLog)', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'web@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  // task FREE phase attend — NV lạ → Dư (ok:true)
  ss.sheets.AttendanceTask.appendRow(['R2026', 'free', 'HN SOC', 'Tự do', '', '', 'attend', '2026-08-17 08:00', 'web@spx.com', '']);
  const res = svc.scanStaff('R2026', 'Ops6219');
  assert.equal(res.ok, true);
  // AuditLog chỉ còn header — scan không thêm dòng (mutation quản trị vẫn audit)
  const rows = ss.sheets.AuditLog.data;
  assert.equal(rows.length, 1);
});

test('completeTask ghi audit (action=completeTask)', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'owner@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  ss.sheets.AttendanceTask.appendRow(['R2026', 'reconcile', 'HN SOC', '08:00-17:00', 'Inbound', 'Full', 'attend', '2026-08-17 08:00', 'owner@spx.com', '']);
  const res = svc.completeTask('R2026');
  assert.equal(res.ok, true);
  const rows = ss.sheets.AuditLog.data;
  assert.equal(rows[rows.length - 1][2], 'completeTask');
  assert.equal(rows[rows.length - 1][3], 'R2026');
});
