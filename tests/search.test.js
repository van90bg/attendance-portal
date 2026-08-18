/**
 * tests/search.test.js — Unit test cho matchLogsByStaff (F-search, ScanLogic.gs).
 *
 * matchLogsByStaff là hàm THUẦN (chỉ nhận logRows + tasks + staffId), nên test trực tiếp
 * qua vm mà không cần mock sheet. Backend Database.searchLogsByStaff (wrapper đọc sheet)
 * chỉ gọi thẳng hàm này — chức năng join/sort/limit được bảo toàn bởi test này.
 *
 * LƯU Ý cross-realm: vm sandbox có Array prototype riêng → assert.deepEqual so sánh 2 mảng
 * từ realm khác nhau sẽ FAIL (prototype mismatch). Do đó test chỉ dùng assert.equal trên
 * giá trị nguyên-primitive (.length, field string) — tuân chuẫn test file khác (scanservice).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadScanLogic() {
  const ctx = vm.createContext({ console, Date, Math });
  const code = fs.readFileSync(path.join(__dirname, '..', 'ScanLogic.gs'), 'utf8');
  vm.runInContext(code, ctx, { filename: 'ScanLogic.gs' });
  return ctx;
}

// task shape = taskFromRow_ (Database.gs) + counters (readTaskList_).
function mkTask(id, over) {
  return Object.assign({
    taskId: id, station: 'HN2', slotCode: '13:00-22:00',
    team: 'Inbound', contractType: '', status: 'done', phase: 'done',
    createdBy: 'a@spx.vn', createdAtText: '2026-08-07 10:00:00', completedAtText: '',
    total: 0, scanned: 0, extra: 0,
  }, over || {});
}

// logRow shape = logFromRow_ (Database.gs). matchLogsByStaff đọc: staffId, staffName,
// status (scan status NV), taskId, timeRefText, timeScanText.
function mkLog(taskId, staffId, over) {
  return Object.assign({
    taskId: taskId, staffId: staffId, staffName: 'NV ' + staffId, slotCode: '',
    station: '', team: '', workstation: '',
    timeRefText: '09:00:00', timeRefEpoch: 0, timeScanText: '09:05:00', timeScanEpoch: 0,
    status: 'Có mặt', dateText: '', _rowIndex: 0,
  }, over || {});
}

test('matchLogsByStaff: lọc theo mã NV (case-insensitive), join task', () => {
  const ctx = loadScanLogic();
  const tasks = [
    mkTask('T1', { status: 'done', createdAtText: '2026-08-07 10:00:00', createdBy: 'a@spx.vn' }),
    mkTask('T2', { status: 'attend', createdAtText: '2026-08-08 09:00:00', createdBy: 'b@spx.vn' }),
  ];
  const logRows = [
    mkLog('T1', 'ops001', { staffName: 'Nguyen A', status: 'Có mặt' }),
    mkLog('T2', 'OPS001', { staffName: 'Nguyen A', status: 'Có mặt' }), // case khác
    mkLog('T1', 'ops002', { staffName: 'Tran B', status: 'Vắng' }),    // phải loại
  ];
  const res = ctx.matchLogsByStaff(logRows, tasks, 'ops001');
  assert.equal(res.length, 2, 'phải trả 2 dòng (ops001 ở T1+T2), loại trừ ops002');
  assert.equal(res[0].staffId, 'OPS001', 'staffId normalize uppercase');
  // T2 (08-08) TRƯỚC T1 (08-07) — sort giảm dần
  assert.equal(res[0].taskId, 'T2');
  assert.equal(res[1].taskId, 'T1');
  // join task metadata cho res[0]=T2
  assert.equal(res[0].station, 'HN2');
  assert.equal(res[0].team, 'Inbound');
  assert.equal(res[0].slotCode, '13:00-22:00');
  assert.equal(res[0].taskStatus, 'attend');
  assert.equal(res[0].createdAtText, '2026-08-08 09:00:00');
  assert.equal(res[0].createdBy, 'b@spx.vn');
  // join task metadata cho res[1]=T1
  assert.equal(res[1].taskStatus, 'done');
  assert.equal(res[1].createdAtText, '2026-08-07 10:00:00');
  assert.equal(res[1].createdBy, 'a@spx.vn');
  // log fields giữ nguyên (không bị ghi đè bởi task)
  assert.equal(res[0].staffName, 'Nguyen A');
  assert.equal(res[0].status, 'Có mặt', 'status = scan status NV, không phải task status');
  assert.equal(res[0].timeRefText, '09:00:00');
  assert.equal(res[0].timeScanText, '09:05:00');
});

test('matchLogsByStaff: mã NV trống/null/undefined → []', () => {
  const ctx = loadScanLogic();
  const logRows = [mkLog('T1', 'ops1')];
  assert.equal(ctx.matchLogsByStaff(logRows, [], '').length, 0);
  assert.equal(ctx.matchLogsByStaff(logRows, [], null).length, 0);
  assert.equal(ctx.matchLogsByStaff(logRows, [], undefined).length, 0);
});

test('matchLogsByStaff: không match mã NV → []', () => {
  const ctx = loadScanLogic();
  const logRows = [mkLog('T1', 'ops1')];
  assert.equal(ctx.matchLogsByStaff(logRows, [], 'ops2').length, 0);
});

test('matchLogsByStaff: log row không có task tương ứng (orphan) → vẫn trả, task field rỗng', () => {
  const ctx = loadScanLogic();
  const logRows = [mkLog('T99', 'ops005', { staffName: 'Orphan' })];
  const res = ctx.matchLogsByStaff(logRows, [], 'ops005');
  assert.equal(res.length, 1);
  assert.equal(res[0].taskId, 'T99');
  assert.equal(res[0].taskStatus, '');
  assert.equal(res[0].createdAtText, '');
  assert.equal(res[0].staffName, 'Orphan');
});

test('matchLogsByStaff: trùng staffId giữa task — trả đủ, sort giảm dần theo createdAtText', () => {
  const ctx = loadScanLogic();
  const tasks = [
    mkTask('T_old', { createdAtText: '2026-08-01 08:00:00' }),
    mkTask('T_new', { createdAtText: '2026-08-09 12:00:00' }),
    mkTask('T_mid', { createdAtText: '2026-08-05 08:00:00' }),
  ];
  const logRows = [
    mkLog('T_old', 'ops7'), mkLog('T_new', 'ops7'), mkLog('T_mid', 'ops7'),
  ];
  const res = ctx.matchLogsByStaff(logRows, tasks, 'ops7');
  assert.equal(res.length, 3);
  // Dùng join thành chuỗi (cross-realm-safe) để so sánh thứ tự
  assert.equal(res.map(function (r) { return r.taskId; }).join(','), 'T_new,T_mid,T_old');
});

test('matchLogsByStaff: limit 200', () => {
  const ctx = loadScanLogic();
  const tasks = [mkTask('T', { createdAtText: '2026-08-09 12:00:00' })];
  var rows = [];
  for (var i = 0; i < 250; i++) rows.push(mkLog('T', 'ops999'));
  const res = ctx.matchLogsByStaff(rows, tasks, 'ops999');
  assert.equal(res.length, 200, 'phải cắt ở 200 để bảo vệ sheet lớn');
});

test('matchLogsByStaff: so sánh staffId case-insensitive (server normalizeStaffId trim+upper trước khi gọi)', () => {
  const ctx = loadScanLogic();
  // Nhật quy: Log row staffId luôn đã normalize (trim+upper) qua logFromRow_ ở server.
  // matchLogsByStaff so sánh case-insensitive (toUpperCase) — server truyền needle đã normalize.
  const logRows = [mkLog('T1', 'OPS123', { staffName: 'Trim Test' })];
  const res = ctx.matchLogsByStaff(logRows, [mkTask('T1', { createdAtText: '2026-08-09 12:00:00' })], 'ops123');
  assert.equal(res.length, 1, 'phải match dù truyền lowercase — so sánh case-insensitive');
  assert.equal(res[0].staffId, 'OPS123');
});

test('matchTasksByQuery: lọc task theo mã (contains, case-insensitive), limit 50', () => {
  const ctx = loadScanLogic();
  const tasks = [
    mkTask('R20260801-2352', { createdAtText: '2026-08-01 23:52:01' }),
    mkTask('R20260801-2327', { createdAtText: '2026-08-01 23:27:02' }),
    mkTask('X20260802-0001', { createdAtText: '2026-08-02 00:01:00' }),
  ];
  // empty -> []
  assert.equal(ctx.matchTasksByQuery(tasks, '').length, 0);
  assert.equal(ctx.matchTasksByQuery(tasks, '  ').length, 0);
  // prefix/contains, giữ thứ tự tasks truyền vào
  assert.equal(ctx.matchTasksByQuery(tasks, 'R202608').map(function (t) { return t.taskId; }).join(','), 'R20260801-2352,R20260801-2327');
  // contains giữa chuỗi
  assert.equal(ctx.matchTasksByQuery(tasks, '2352').length, 1);
  // case-insensitive
  assert.equal(ctx.matchTasksByQuery(tasks, 'r20260801-23').length, 2);
  // không match
  assert.equal(ctx.matchTasksByQuery(tasks, 'ZZZ').length, 0);
  // null tasks
  assert.equal(ctx.matchTasksByQuery(null, 'R').length, 0);
  // limit 50
  var many = [];
  for (var i = 0; i < 60; i++) many.push(mkTask('R20260801-' + ('0000' + i).slice(-4)));
  assert.equal(ctx.matchTasksByQuery(many, 'R2026').length, 50, 'phải cắt ở 50');
});
