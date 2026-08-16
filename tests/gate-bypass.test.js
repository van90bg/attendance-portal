/**
 * tests/gate-bypass.test.js — Gate service-layer chặn bypass trực tiếp google.script.run.
 *
 * M1: searchLogsByStaff phải tự gate requireRole_('manager') (không chỉ ở wrapper
 *     searchLogsByStaffApi) — gọi trực tiếp từ console với role < manager phải trả [].
 * M2: scanStaff phải tự gate requireRole_('operator') — viewer gọi trực tiếp phải trả ok:false.
 *
 * Dùng gas-sandbox inject activeEmail = viewer (role viewer qua roleMap Config sheet).
 */
const test = require('node:test');
const assert = require('node:assert');
const { makeSandbox, loadAll } = require('./gas-sandbox');

function sandboxWithRole(role) {
  const email = role + '@spx.com';
  const { ctx, ss } = makeSandbox({ activeEmail: email });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  // Ghi roleMap: email này → role tương ứng (getRole_ đọc qua getSetting_).
  ss.sheets.Config.appendRow(['roleMap', JSON.stringify({ [email]: role })]);
  return svc;
}

test('M1 searchLogsByStaff trả [] khi role < manager (bypass-proof)', () => {
  const svc = sandboxWithRole('viewer');
  const rows = svc.searchLogsByStaff('Ops123');
  assert.deepEqual(rows, [], 'viewer gọi trực tiếp searchLogsByStaff phải bị chặn ([])');
});

test('M2 scanStaff trả ok:false khi role < operator (bypass-proof)', () => {
  const svc = sandboxWithRole('viewer');
  const res = svc.scanStaff('taskX', 'Ops123');
  assert.strictEqual(res.ok, false, 'viewer gọi trực tiếp scanStaff phải bị chặn');
  assert.match(res.message, /quyền/);
});
