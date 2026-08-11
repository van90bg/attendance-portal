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
  defaultStation: '', defaultSlotCode: '', defaultTeam: '', roleMap: {},
  station: [], team: [], slotcode: [], department: [],
};

test('getSettings_ trả defaults khi Config sheet chưa có override', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  const got = clone(svc.getSettings_());
  assert.deepEqual(got, DEFAULTS);
  // Config sheet: header 4 cột [Key,Value,Group,Index] do ensureSheets_ đặt
  assert.deepEqual(ss.sheets.Config.data[0], ['Key', 'Value', 'Group', 'Index']);
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
  const s = clone(svc.getSettings_());
  assert.equal(s.defaultStation, 'HN2 SOC');
  assert.equal(s.defaultTeam, 'Outbound');
  assert.deepEqual(s.department, []); // group default rỗng
});

test('saveSettings_ update row cũ (không append trùng) — ghi 2 lần cùng key', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  svc.saveSettings_({ defaultStation: 'A' });
  svc.saveSettings_({ defaultStation: 'B', roleMap: { 'a@x.com': 'admin' } });
  assert.equal(ss.sheets.Config.getLastRow(), 3); // header + 2 row (update, không trùng)
  const s = clone(svc.getSettings_());
  assert.equal(s.defaultStation, 'B');
  assert.deepEqual(s.roleMap, { 'a@x.com': 'admin' });
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

test('group save: ghi 4 cột + getSettings_ gom theo Index (đọc lại, cache invalidate)', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  const res = svc.saveSettings_({ station: ['HN2 SOC', 'HN SOC'], team: ['Inbound', 'Outbound'], slotcode: ['08:00-17:00', '13:00-01:00'] });
  assert.equal(res.ok, true);
  assert.deepEqual(Array.from(res.saved).sort(), ['slotcode', 'station', 'team']);
  // Sheet: header + 6 row group (key station1..2, team1..2, slotcode1..2) — mỗi row đủ 4 cột
  assert.equal(ss.sheets.Config.getLastRow(), 7);
  const s = clone(svc.getSettings_());
  assert.deepEqual(s.station, ['HN2 SOC', 'HN SOC']);
  assert.deepEqual(s.team, ['Inbound', 'Outbound']);
  assert.deepEqual(s.slotcode, ['08:00-17:00', '13:00-01:00']);
  assert.deepEqual(s.department, []); // group chưa ghi → default []
});

test('group save: thêm/xoá giữa chừng → index được ghi lại đúng (xóa row cũ không sót)', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  svc.saveSettings_({ station: ['A', 'B', 'C'] });
  svc.saveSettings_({ station: ['X', 'C'] }); // bỏ B, đổi A→X — index mới 1..2
  assert.equal(ss.sheets.Config.getLastRow(), 3); // header + 2 row (không tích lũy)
  const s = clone(svc.getSettings_());
  assert.deepEqual(s.station, ['X', 'C']);
  const rows = clone(ss.sheets.Config.data.slice(1).map(function (r) { return r.slice(0, 4); }));
  assert.deepEqual(rows, [['station1', 'X', 'station', 1], ['station2', 'C', 'station', 2]]);
});

test('group save: item rỗng bị bỏ qua (không ghi row rác)', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  svc.saveSettings_({ team: ['Inbound', '', 'Outbound'] });
  assert.equal(ss.sheets.Config.getLastRow(), 3); // header + 2 row
  assert.deepEqual(clone(svc.getSettings_()).team, ['Inbound', 'Outbound']);
});

test('group save: value không phải mảng → ghi list rỗng (không crash)', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  const res = svc.saveSettings_({ station: 'HN2 SOC' }); // lệch kiểu — coi như bỏ hết
  assert.equal(res.ok, true);
  assert.deepEqual(clone(svc.getSettings_()).station, []);
});

test('group save: group lạ (không trong defaults) bị bỏ qua', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  const res = svc.saveSettings_({ hackerGroup: ['x'], station: ['HN2 SOC'] });
  assert.deepEqual(Array.from(res.ignored), ['hackerGroup']);
  assert.deepEqual(clone(svc.getSettings_()).station, ['HN2 SOC']);
});

test('migration: Config sheet cũ 2 cột (header Key/Value + data) → ensureSheets_ thêm cột Group/Index', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  // Tạo sheet cũ 2 cột: header + 1 row single
  const sh = ss.insertSheet('Config');
  sh.data = [['Key', 'Value'], ['defaultStation', '"HN2 SOC"']];
  svc.ensureSheets_();
  assert.equal(ss.sheets.Config.getLastColumn(), 4);
  assert.deepEqual(ss.sheets.Config.data[0], ['Key', 'Value', 'Group', 'Index']);
  const s = svc.getSettings_();
  assert.equal(s.defaultStation, 'HN2 SOC'); // row cũ vẫn đọc được (group rỗng → single)
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
  const w = svc.saveSettingsApi({ defaultTeam: 'Outbound' });
  assert.equal(w.ok, true);
  assert.equal(svc.getSettingsApi().settings.defaultTeam, 'Outbound');
  // non-editor → cả 2 API chặn
  const { ctx: ctx2 } = makeSandbox({ activeEmail: 'staff@spx.com' });
  const svc2 = loadAll(ctx2);
  svc2.ensureSheets_();
  assert.equal(svc2.getSettingsApi().ok, false);
  assert.equal(svc2.saveSettingsApi({ defaultTeam: 'X' }).ok, false);
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
