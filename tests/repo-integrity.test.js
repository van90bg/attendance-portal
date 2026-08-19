/**
 * tests/repo-integrity.test.js — Review 2026-08-19 findings:
 *  #1  Repo mutators kiểm tra row thuộc taskId (không ghi nhầm dòng task khác).
 *  #3  cachedJson_ gen guard — writer bump gen giữa load → KHÔNG put dữ liệu cũ (stale resurrection).
 *  #4  ensureSheets_ strict — header đổi tên/reorder → throw fail-closed.
 *  #6  getTaskListApi error contract — lỗi hạ tầng trả { ok:false, message }, [] chỉ khi rỗng thật.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeSandbox, loadAll } = require('./gas-sandbox');

const ST = { PENDING: '-', PRESENT: 'Có mặt', ABSENT: 'Vắng', EXTRA: 'Dư' };

/** 2 task (R1 row 2, R2 row 3) + 2 log rows (R1 row 2, R2 row 3) — header row 1. */
function setupTwoTasks(svc) {
  svc.ensureSheets_();
  const t = svc.getSheet_('AttendanceTask');
  t.appendRow(['R1', 'HN SOC', '08:00-17:00', 'TeamA', 'FREE', 'open', new Date(), 'owner@spx.com', '', '2026-08-01']);
  t.appendRow(['R2', 'HN2 SOC', '13:00-22:00', 'TeamB', 'FREE', 'open', new Date(), 'owner@spx.com', '', '2026-08-01']);
  const l = svc.getSheet_('AttendanceLog');
  l.appendRow(['R1', 'Ops1', 'NV1', '08:00-17:00', 'HN SOC', 'TeamA', 'WH1', '', '', ST.PENDING, '2026-08-01']);
  l.appendRow(['R2', 'Ops2', 'NV2', '13:00-22:00', 'HN2 SOC', 'TeamB', 'WH2', '', '', ST.PENDING, '2026-08-01']);
}

// ===== #1: repo mutators row/task integrity =====

test('#1 updateTaskStatus_: rowIndex thuộc task khác → fallback tìm theo taskId, không ghi nhầm', () => {
  const { ctx } = makeSandbox({ activeEmail: 'owner@spx.com' });
  const svc = loadAll(ctx);
  setupTwoTasks(svc);
  const ok = svc.updateTaskStatus_('R2', 'done', new Date(), 2 /* row của R1 */, 'FREE');
  assert.equal(ok, true);
  const rows = svc.getSheet_('AttendanceTask').getDataRange().getValues();
  assert.equal(rows[1][5], 'open', 'R1 (row 2) không được đè');
  assert.equal(rows[2][5], 'done', 'R2 (row 3) cập nhật đúng qua fallback');
});

test('#1 updateTaskStatus_: rowIndex hợp lệ vẫn ghi nhanh (không fallback)', () => {
  const { ctx } = makeSandbox({ activeEmail: 'owner@spx.com' });
  const svc = loadAll(ctx);
  setupTwoTasks(svc);
  const ok = svc.updateTaskStatus_('R1', 'attend', null, 2, 'FREE');
  assert.equal(ok, true);
  const rows = svc.getSheet_('AttendanceTask').getDataRange().getValues();
  assert.equal(rows[1][5], 'attend');
  assert.equal(rows[2][5], 'open');
});

test('#1 setLogRowStatus_: rowIndex thuộc task khác → chặn, không ghi nhầm', () => {
  const { ctx } = makeSandbox({ activeEmail: 'owner@spx.com' });
  const svc = loadAll(ctx);
  setupTwoTasks(svc);
  svc.setLogRowStatus_('R1', 3 /* row của R2 */, ST.PRESENT, null, false, false);
  const rows = svc.getSheet_('AttendanceLog').getDataRange().getValues();
  assert.equal(rows[2][9], ST.PENDING, 'status dòng R2 không đổi');
});

test('#1 setLogRowStatus_: row thuộc đúng task vẫn ghi', () => {
  const { ctx } = makeSandbox({ activeEmail: 'owner@spx.com' });
  const svc = loadAll(ctx);
  setupTwoTasks(svc);
  svc.setLogRowStatus_('R1', 2, ST.PRESENT, new Date(), false, false);
  const rows = svc.getSheet_('AttendanceLog').getDataRange().getValues();
  assert.equal(rows[1][9], ST.PRESENT);
});

test('#1 batchUpdateLogRows_: update lẫn rowIndex task khác → chỉ ghi row thuộc task', () => {
  const { ctx } = makeSandbox({ activeEmail: 'owner@spx.com' });
  const svc = loadAll(ctx);
  setupTwoTasks(svc);
  const n = svc.batchUpdateLogRows_('R1', [
    { rowIndex: 2, field: 'listedAt', time: new Date('2026-08-01T01:00:00Z') },
    { rowIndex: 3, field: 'listedAt', time: new Date('2026-08-01T02:00:00Z') },  // row R2 — bỏ
  ]);
  assert.equal(n, 1, 'chỉ đếm update hợp lệ');
  const rows = svc.getSheet_('AttendanceLog').getDataRange().getValues();
  assert.ok(rows[1][7] instanceof Date, 'R1 LISTED_AT được ghi');
  assert.equal(rows[2][7], '', 'R2 LISTED_AT không đụng');
});

// ===== #3: cache gen guard =====

test('#3 cachedJson_: writer bump gen giữa load → KHÔNG put dữ liệu cũ', () => {
  const { ctx } = makeSandbox();
  const svc = loadAll(ctx);
  const cache = ctx.CacheService.getScriptCache();
  cache.remove('rc2_test_v1');
  const v = svc.cachedJson_('rc2_test_v1', function () {
    svc.bumpCacheGen_();  // writer ghi sheet + invalidate trong lúc load
    return 'stale';
  }, 60);
  assert.equal(v, 'stale', 'request này vẫn nhận dữ liệu');
  assert.equal(cache.get('rc2_test_v1'), null, 'cache KHÔNG bị ô nhiễm dữ liệu cũ');
  // Ngược lại: không có bump → put bình thường
  cache.remove('rc2_test_v1');
  const v2 = svc.cachedJson_('rc2_test_v1', function () { return 'fresh'; }, 60);
  assert.equal(v2, 'fresh');
  assert.equal(cache.get('rc2_test_v1'), JSON.stringify('fresh'));
});

test('#3 invalidate*_ đều bump gen — cachedJson_ phát hiện writer', () => {
  const { ctx } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  const cache = ctx.CacheService.getScriptCache();
  const g0 = cache.get('rc2_gen_v1');
  svc.invalidateTaskListCache_();
  assert.notEqual(cache.get('rc2_gen_v1'), g0);
  const g1 = cache.get('rc2_gen_v1');
  svc.invalidateTaskDetailCache_('R1');
  assert.notEqual(cache.get('rc2_gen_v1'), g1);
  const g2 = cache.get('rc2_gen_v1');
  svc.invalidateLogRows_('R1');
  assert.notEqual(cache.get('rc2_gen_v1'), g2);
  const g3 = cache.get('rc2_gen_v1');
  svc.invalidateStaffIndex_();
  assert.notEqual(cache.get('rc2_gen_v1'), g3);
  const g4 = cache.get('rc2_gen_v1');
  svc.invalidateSettingsCache_();
  assert.notEqual(cache.get('rc2_gen_v1'), g4);
});

// ===== #4: header schema validation =====

test('#4 ensureSheets_ strict: header đổi tên → throw fail-closed; non-strict chỉ log', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  ss.sheets.AttendanceTask.data[0][1] = 'stationX';  // đổi tên header cột 2
  assert.throws(function () { svc.ensureSheets_(true); }, /HEADER MISMATCH/);
  svc.ensureSheets_();  // non-strict (doGet) không throw
});

test('#4 ensureSheets_ strict: header đúng → không throw', () => {
  const { ctx } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_(true);
});

// ===== #6: getTaskListApi error contract =====

test('#6 getTaskListApi: lỗi hạ tầng → { ok:false, message } — KHÔNG giả danh [] (rỗng thật)', () => {
  const { ctx } = makeSandbox();
  const svc = loadAll(ctx);
  svc.listTasks = function () { throw new Error('sheet boom'); };
  const res = svc.getTaskListApi();
  assert.equal(res.ok, false);
  assert.match(res.message, /sheet boom/);
});

test('#6 getTaskListApi: danh sách rỗng thật vẫn trả [] (contract giữ nguyên)', () => {
  const { ctx } = makeSandbox();
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  const res = svc.getTaskListApi();
  assert.equal(Array.isArray(res), true);
  assert.equal(res.length, 0);
});