/**
 * tests/settings-service.test.js — SettingsService (đọc/ghi Config sheet).
 *
 * Cover: defaults từ SETTINGS_DEFAULTS khi sheet chưa có override; save → merge override;
 * cache invalidation sau save (shared cache mock — nếu thiếu invalidate test fail);
 * update row cũ (không append trùng); whitelist key lạ; gate editor (fail-closed);
 * API getSettingsApi/saveSettingsApi (Code.gs) — editor OK, non-editor chặn.
 *
 * Mock GAS + loader dùng chung: tests/gas-sandbox.js (cùng bộ với all-gs-load).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeSandbox, loadAll } = require('./gas-sandbox');

// Cross-realm: object trả từ vm sandbox có prototype khác — deepEqual strict fail
// dù nội dung giống. Clone qua JSON (đúng như google.script.run serialize) trước khi so.
const clone = (v) => JSON.parse(JSON.stringify(v));

const DEFAULTS = { defaultStation: '', defaultSlotCode: '', defaultTeam: '', department: '', roleMap: {} };

test('getSettings_ trả defaults khi Config sheet chưa có override', () => {
  const { ctx } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  assert.deepEqual(clone(svc.getSettings_()), DEFAULTS);
});

test('saveSettings_ ghi Config sheet + getSettings_ merge override (cache invalidate)', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  const res = svc.saveSettings_({ defaultStation: 'HN2 SOC', defaultTeam: 'Outbound' });
  assert.equal(res.ok, true);
  assert.deepEqual(Array.from(res.saved).sort(), ['defaultStation', 'defaultTeam']);
  // Config sheet: header + 2 row override
  assert.equal(ss.sheets.Config.getLastRow(), 3);
  // Cache bị invalidate sau save → đọc lại từ sheet (shared cache: nếu không invalidate, fail)
  const s = svc.getSettings_();
  assert.equal(s.defaultStation, 'HN2 SOC');
  assert.equal(s.defaultTeam, 'Outbound');
  assert.equal(s.department, ''); // default giữ nguyên
});

test('saveSettings_ update row cũ (không append trùng) — ghi 2 lần cùng key', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  svc.saveSettings_({ defaultStation: 'A' });
  svc.saveSettings_({ defaultStation: 'B', department: 'SOC' });
  assert.equal(ss.sheets.Config.getLastRow(), 3); // header + 2 row (update, không trùng)
  const s = svc.getSettings_();
  assert.equal(s.defaultStation, 'B');
  assert.equal(s.department, 'SOC');
});

test('whitelist: key không trong SETTINGS_DEFAULTS bị bỏ qua (không ghi sheet)', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  const res = svc.saveSettings_({ hackerKey: 'x', defaultStation: 'HN2 SOC' });
  assert.deepEqual(Array.from(res.ignored), ['hackerKey']);
  assert.deepEqual(Array.from(res.saved), ['defaultStation']);
  assert.equal(ss.sheets.Config.getLastRow(), 2); // chỉ ghi defaultStation
  const s = svc.getSettings_();
  assert.equal('hackerKey' in s, false);
  // value undefined → bỏ qua (không ghi, không saved)
  const res2 = svc.saveSettings_({ defaultStation: undefined });
  assert.deepEqual(Array.from(res2.ignored), ['defaultStation']);
  assert.equal(ss.sheets.Config.getLastRow(), 2); // vẫn chỉ 1 row
});

test('gate editor: saveSettings_ fail-closed khi user thường', () => {
  const { ctx } = makeSandbox({ activeEmail: 'staff@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  const res = svc.saveSettings_({ defaultStation: 'X' });
  assert.equal(res.ok, false);
  assert.equal(svc.getSettings_().defaultStation, ''); // không ghi được
});

test('API getSettingsApi/saveSettingsApi (Code.gs): editor OK, non-editor chặn', () => {
  const { ctx } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  const g = svc.getSettingsApi();
  assert.equal(g.ok, true);
  assert.equal(g.settings.defaultStation, '');
  const w = svc.saveSettingsApi({ department: 'SOC' });
  assert.equal(w.ok, true);
  assert.equal(svc.getSettingsApi().settings.department, 'SOC');
  // non-editor → cả 2 API chặn
  const { ctx: ctx2 } = makeSandbox({ activeEmail: 'staff@spx.com' });
  const svc2 = loadAll(ctx2);
  svc2.ensureSheets_();
  assert.equal(svc2.getSettingsApi().ok, false);
  assert.equal(svc2.saveSettingsApi({ department: 'X' }).ok, false);
});

test('getSetting_ đọc 1 key sau khi save; key lạ → undefined', () => {
  const { ctx } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  assert.equal(svc.getSetting_('defaultStation'), '');
  svc.saveSettings_({ defaultStation: 'HN2 SOC' });
  assert.equal(svc.getSetting_('defaultStation'), 'HN2 SOC');
  assert.equal(svc.getSetting_('not-exist'), undefined);
});
