/**
 * tests/role-service.test.js — Role / phân quyền (Auth.gs + roleMap Config sheet).
 *
 * Cover: anonymous → operator (kiosk giữ hành vi); roleMap theo email (lowercase);
 * admin override; requireRole_ theo bậc + fail-closed role lạ; getCurrentUser trả
 * { email, role, isAdmin }; gate getStaffStatsApi (viewer bị chặn — role mới P1,
 * operator+ hiện tại không đổi hành vi).
 *
 * Mock GAS + loader dùng chung: tests/gas-sandbox.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeSandbox, loadAll } = require('./gas-sandbox');

test('getRole_: anonymous (email rỗng) → operator (kiosk giữ hành vi)', () => {
  const { ctx } = makeSandbox({ activeEmail: '' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  assert.equal(svc.getRole_(''), 'operator');
});

test('getRole_: roleMap cấu hình theo email; email chưa cấu hình → default operator', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'manager@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  // Ghi TRỰC TIẾP Config sheet — saveSettings_ gate editor, sandbox này non-editor.
  ss.sheets.Config.appendRow(['roleMap', JSON.stringify({ 'manager@spx.com': 'manager' })]);
  assert.equal(svc.getRole_('manager@spx.com'), 'manager');
  assert.equal(svc.getRole_('staff@spx.com'), 'operator'); // chưa cấu hình → default
});

test('getRole_: admin (DEPLOYER_EMAIL) override mọi roleMap', () => {
  const { ctx } = makeSandbox({ activeEmail: 'admin@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  svc.saveSettings_({ roleMap: { 'admin@spx.com': 'viewer' } });
  assert.equal(svc.getRole_('admin@spx.com'), 'admin');
});

test('requireRole_: bậc quyền đúng (manager ≥ operator/viewer, < admin)', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'manager@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  ss.sheets.Config.appendRow(['roleMap', JSON.stringify({ 'manager@spx.com': 'manager' })]);
  assert.equal(svc.requireRole_('viewer'), true);
  assert.equal(svc.requireRole_('operator'), true);
  assert.equal(svc.requireRole_('manager'), true);
  assert.equal(svc.requireRole_('admin'), false);
});

test('role lạ trong roleMap → default operator; requireRole_ minRole lạ → fail-closed false', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'x@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  ss.sheets.Config.appendRow(['roleMap', JSON.stringify({ 'x@spx.com': 'superuser', 'y@spx.com': 'viewer' })]);
  assert.equal(svc.getRole_('x@spx.com'), 'operator'); // role không hợp lệ → default
  assert.equal(svc.getRole_('y@spx.com'), 'viewer');
  assert.equal(svc.requireRole_('operatr'), false);     // minRole gõ sai → chặn (fail-closed)
  assert.equal(svc.requireRole_('operator'), true);
});

test('getCurrentUser trả { email, role, isAdmin } — operator mặc định, admin khi editor', () => {
  const { ctx } = makeSandbox({ activeEmail: 'staff@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  const u = svc.getCurrentUser();
  assert.equal(u.email, 'staff@spx.com');
  assert.equal(u.role, 'operator');
  assert.equal(u.isAdmin, false);
  const { ctx: ctx2 } = makeSandbox({ activeEmail: 'admin@spx.com' });
  const svc2 = loadAll(ctx2);
  svc2.ensureSheets_();
  assert.equal(svc2.getCurrentUser().role, 'admin');
});

test('getStaffStatsApi gate: operator OK, viewer (role P1) bị chặn', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'viewer@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  ss.sheets.Config.appendRow(['roleMap', JSON.stringify({ 'viewer@spx.com': 'viewer' })]);
  assert.equal(svc.getStaffStatsApi().ok, false);
  // operator (mặc định) vẫn xem được — không đổi hành vi hiện tại
  const { ctx: ctx2 } = makeSandbox({ activeEmail: 'staff@spx.com' });
  const svc2 = loadAll(ctx2);
  svc2.ensureSheets_();
  assert.equal(svc2.getStaffStatsApi().ok, true);
});

test('getCurrentUser anonymous: role operator, isAdmin false (kiosk)', () => {
  const { ctx } = makeSandbox({ activeEmail: '' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  const u = svc.getCurrentUser();
  assert.equal(u.email, '');
  assert.equal(u.role, 'operator');
  assert.equal(u.isAdmin, false);
});
