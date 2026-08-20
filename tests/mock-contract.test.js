/**
 * tests/mock-contract.test.js — Contract mock ↔ server API (chống drift).
 *
 * Sinh từ bài học 2026-08-11:
 * - mock trả `labels`/`tableHeaders` mà client KHÔNG dùng (grep index.html = 0) và
 *   server getMetaApi KHÔNG trả → ~40 dòng code chết + contract lệch server.
 * - mock thiếu `warmStaffCacheApi` — client gọi nhưng run.xxx = undefined → try/catch
 *   nuốt lỗi âm thầm (warm cache không bao giờ chạy khi test local).
 *
 * Assert:
 *  1. Mọi handler mock là API server thật (không orphan handler).
 *  2. Mọi API client gọi (index.html .XxxApi() có mock handler) — mock không thiếu.
 *  3. Shape getMetaApi khớp server: { ok, appTitle, userEmail, isEditor } — KHÔNG labels/tableHeaders.
 *  4. Shape getSettingsApi khớp: { ok, settings }.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

/** Tên API server: function XxxApi( khai trong mọi file .gs. */
function serverApiNames() {
  const names = new Set();
  for (const f of fs.readdirSync(ROOT).filter((x) => x.endsWith('.gs'))) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/function\s+([A-Za-z_]\w*Api)\s*\(/g)) names.add(m[1]);
  }
  return names;
}

/** Tên API client gọi: .XxxApi( trong app-*.html (JS tách module — call sites google.script.run). */
function clientApiNames() {
  const src = fs.readdirSync(ROOT)
    .filter((f) => /^app-.*\.html$/.test(f))
    .sort()
    .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'))
    .join('\n');
  const names = new Set();
  for (const m of src.matchAll(/\.([A-Za-z_]\w*Api)\s*\(/g)) names.add(m[1]);
  return names;
}

/** Load mock-google.js vào vm (window giả) → { handlers, call } — call chạy handler async như thật. */
function loadMock() {
  const ctx = { window: {}, console, setTimeout };
  vm.createContext(ctx);
  let src = fs.readFileSync(path.join(ROOT, 'mock', 'mock-google.js'), 'utf8');
  src = src.replace(/^\uFEFF/, ''); // bỏ BOM trước khi compile
  vm.runInContext(src, ctx);
  const run = ctx.window.google.script.run;
  const handlers = Object.keys(run).filter((n) => n !== 'withSuccessHandler' && n !== 'withFailureHandler');
  function call(name, ...args) {
    return new Promise((resolve, reject) => {
      run.withSuccessHandler(resolve).withFailureHandler(reject)[name](...args);
    });
  }
  return { handlers, call };
}

test('mock handlers ⊆ server API functions (không orphan handler)', () => {
  const { handlers } = loadMock();
  const api = serverApiNames();
  const orphan = handlers.filter((h) => !api.has(h));
  assert.deepEqual(orphan, [], 'mock handler không tồn tại ở server: ' + orphan.join(', '));
});

test('client-called APIs đều có mock handler (mock không thiếu)', () => {
  const { handlers } = loadMock();
  const client = clientApiNames();
  const missing = [...client].filter((c) => !handlers.includes(c));
  assert.deepEqual(missing, [], 'client gọi nhưng mock thiếu handler: ' + missing.join(', '));
});

test('getMetaApi shape khớp server: { ok, appTitle, userEmail, isEditor, role } — không labels/tableHeaders', async () => {
  const { call } = loadMock();
  const meta = await call('getMetaApi');
  assert.deepEqual(Object.keys(meta).sort(), ['appTitle', 'isEditor', 'ok', 'role', 'userEmail']);
});

test('getSettingsApi shape khớp server: { ok, settings }', async () => {
  const { call } = loadMock();
  const s = await call('getSettingsApi');
  assert.deepEqual(Object.keys(s).sort(), ['ok', 'settings']);
});

// Mock settings phải có ĐỦ key của server SETTINGS_DEFAULTS (Config.gs) — thêm setting mới
// ở server mà mock thiếu → test này bắt (ngăn mock drift như batch labels/tableHeaders).
test('getSettingsApi settings có đủ keys của server SETTINGS_DEFAULTS', async () => {
  const { call } = loadMock();
  const s = await call('getSettingsApi');
  const cfgSrc = fs.readFileSync(path.join(ROOT, 'Config.gs'), 'utf8');
  const block = cfgSrc.match(/const SETTINGS_DEFAULTS = \{([\s\S]*?)\n\};/);
  assert.ok(block, 'Config.gs phải có SETTINGS_DEFAULTS');
  const serverKeys = [...block[1].matchAll(/^\s*(\w+):/gm)].map((x) => x[1]);
  const mockKeys = Object.keys(s.settings || {});
  const missing = serverKeys.filter((k) => !mockKeys.includes(k));
  assert.deepEqual(missing, [], 'mock thiếu key settings so server: ' + missing.join(', '));
});

// getFilterOptionsApi kèm defaults (pre-select tạo task) + lists (danh sách Admin khai báo
// — client merge với distinct StaffData) — mock phải trả đủ shape khớp server.
test('getFilterOptionsApi shape khớp server: { ok, stationGroups, defaults, lists }', async () => {
  const { call } = loadMock();
  const f = await call('getFilterOptionsApi');
  assert.deepEqual(Object.keys(f).sort(), ['defaults', 'lists', 'ok', 'stationGroups']);
  assert.deepEqual(Object.keys(f.defaults || {}).sort(), ['slotCode', 'station', 'team']);
  assert.deepEqual(Object.keys(f.lists || {}).sort(), ['agencies', 'contractTypes', 'departments', 'slotcodes', 'stations', 'teams']);
  assert.ok(Array.isArray(f.lists.stations), 'lists.stations phải là mảng');
  assert.ok(Array.isArray(f.lists.teams), 'lists.teams phải là mảng');
  assert.ok(Array.isArray(f.lists.slotcodes), 'lists.slotcodes phải là mảng');
});

// searchLogsByStaffApi gate manager server-side → shape { ok, rows } (client phân biệt
// 'không đủ quyền' vs 'không có dữ liệu'). Mock mirror shape — test chặn drift.
test('searchLogsByStaffApi shape khớp server: { ok, rows }', async () => {
  const { call } = loadMock();
  const s = await call('searchLogsByStaffApi', 'Ops6219');
  assert.deepEqual(Object.keys(s).sort(), ['ok', 'rows']);
  assert.ok(Array.isArray(s.rows), 'rows phải là mảng');
});
// Server loadRoster (TaskService.gs) KHÔNG ghi LISTED_AT khi nạp roster (noListedAt:true —
// thời điểm đến ghi khi NV quét phase 1). Mock phải mirror — test chặn drift.
test('loadRosterApi không pre-fill LISTED_AT (khớp server noListedAt)', async () => {
  const { call } = loadMock();
  const r = await call('loadRosterApi', 'R20260802-0900', { station: 'HN2 SOC', team: ['Inbound'] });
  assert.ok(r.ok && r.added >= 1, 'nạp roster Inbound phải thêm NV: ' + (r && r.message));
  const d = await call('getTaskDetailApi', 'R20260802-0900');
  const inbound = d.log.filter((x) => ['Ops129481', 'Ops126503', 'Ops133754'].indexOf(x.staffId) >= 0);
  assert.equal(inbound.length, r.added, 'log có đủ NV Inbound mới nạp');
  inbound.forEach((row) => {
    assert.equal(row.listedAtText, '', 'LISTED_AT rỗng sau nạp roster: ' + row.staffId);
    assert.equal(row.listedAtEpoch, 0, 'listedAtEpoch 0 sau nạp roster: ' + row.staffId);
  });
});

