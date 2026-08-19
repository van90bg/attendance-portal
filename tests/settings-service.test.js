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

const DEFAULTS = {
  defaultStation: '', defaultSlotCode: '', defaultTeam: '',
  stations: ['HN2 SOC', 'HN SOC'], teams: ['Inbound', 'Outbound', 'Manual', 'TBS', 'Prep-WH'],
  slotcodes: ['08:00-17:00', '13:00-01:00', '13:00-22:00', '18:00-02:00', '18:00-05:00', '20:00-06:00', '22:00-06:00'],
  departments: ['SOC'],
  agencies: [],
  contractTypes: [],
};

test('getSettings_ trả defaults khi Config sheet chưa có override', () => {
  const { ctx } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  assert.deepEqual(clone(svc.getSettings_()), DEFAULTS);
});

test('getSettings_ không lộ roleMap (P0) + getRoleMap_ đọc riêng + getSettingsApi merge', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  // getSettings_ public — không chứa roleMap (kể cả khi chưa cấu hình)
  assert.equal('roleMap' in svc.getSettings_(), false);
  // roleMap cấu hình trong Config sheet → getRoleMap_ đọc được (cache riêng)
  ss.sheets.Config.appendRow(['roleMap', JSON.stringify({ 'op@spx.com': 'manager' })]);
  assert.deepEqual(clone(svc.getRoleMap_()), { 'op@spx.com': 'manager' });
  // getSettings_ VẪN không lộ roleMap sau khi cấu hình (chỉ delete, không merge)
  assert.equal('roleMap' in svc.getSettings_(), false);
  // getSettingsApi (editor) merge roleMap riêng cho trang Config Admin
  const g = svc.getSettingsApi();
  assert.equal(g.ok, true);
  assert.deepEqual(clone(g.settings.roleMap), { 'op@spx.com': 'manager' });
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
  assert.deepEqual(clone(s.teams), ['Inbound', 'Outbound', 'Manual', 'TBS', 'Prep-WH']); // array default giữ nguyên
});

test('saveSettings_ update row cũ (không append trùng) — ghi 2 lần cùng key', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  svc.saveSettings_({ defaultStation: 'A' });
  svc.saveSettings_({ defaultStation: 'B', defaultSlotCode: '08:00-17:00' });
  assert.equal(ss.sheets.Config.getLastRow(), 3); // header + 2 row (update, không trùng)
  const s = svc.getSettings_();
  assert.equal(s.defaultStation, 'B');
  assert.equal(s.defaultSlotCode, '08:00-17:00');
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
  const w = svc.saveSettingsApi({ teams: ['Inbound', 'Outbound'] });
  assert.equal(w.ok, true);
  assert.deepEqual(clone(svc.getSettingsApi().settings.teams), ['Inbound', 'Outbound']);
  // non-editor → cả 2 API chặn
  const { ctx: ctx2 } = makeSandbox({ activeEmail: 'staff@spx.com' });
  const svc2 = loadAll(ctx2);
  svc2.ensureSheets_();
  assert.equal(svc2.getSettingsApi().ok, false);
  assert.equal(svc2.saveSettingsApi({ teams: ['X'] }).ok, false);
});

test('group JSON: save array → 1 row JSON trong sheet + getSettings_ đọc lại đúng (cache invalidate)', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  // Config sheet 2 cột [Key, Value] — KHÔNG có cột Group/Index (model JSON)
  assert.deepEqual(ss.sheets.Config.data[0], ['Key', 'Value']);
  const res = svc.saveSettings_({ stations: ['HN2 SOC', 'HN SOC', 'HCM SOC'], slotcodes: ['08:00-17:00'] });
  assert.equal(res.ok, true);
  assert.deepEqual(Array.from(res.saved).sort(), ['slotcodes', 'stations']);
  // 1 key = 1 row, value = JSON array string (không tách nhiều dòng)
  assert.equal(ss.sheets.Config.getLastRow(), 3); // header + 2 row
  assert.equal(ss.sheets.Config.data[1][0], 'stations');
  assert.deepEqual(JSON.parse(ss.sheets.Config.data[1][1]), ['HN2 SOC', 'HN SOC', 'HCM SOC']);
  const s = clone(svc.getSettings_());
  assert.deepEqual(s.stations, ['HN2 SOC', 'HN SOC', 'HCM SOC']);
  assert.deepEqual(s.slotcodes, ['08:00-17:00']);
  assert.deepEqual(s.teams, DEFAULTS.teams); // group chưa override → default giữ nguyên
});

test('group JSON: ghi lại cả mảng (thêm/xoá) — update row cũ, không tích lũy', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  svc.saveSettings_({ stations: ['A', 'B', 'C'] });
  svc.saveSettings_({ stations: ['X', 'C'] }); // bỏ B, đổi A→X — ghi đè cả mảng
  assert.equal(ss.sheets.Config.getLastRow(), 2); // header + 1 row (update, không trùng)
  assert.deepEqual(clone(svc.getSettings_()).stations, ['X', 'C']);
});

test('group JSON: key lạ (không trong defaults) bị bỏ qua', () => {
  const { ctx } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  const res = svc.saveSettings_({ hackerGroup: ['x'], stations: ['HN2 SOC'] });
  assert.deepEqual(Array.from(res.ignored), ['hackerGroup']);
  assert.deepEqual(clone(svc.getSettings_()).stations, ['HN2 SOC']);
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
