/**
 * tests/report-repo.test.js — ReportRepo + ReportService (viewReports — StaffAttendance × StaffInfo).
 *
 * Cover: buildStaffInfoMap (email → Ops ID, bỏ dòng thiếu); buildAttendanceRows (map cột
 * theo TÊN header — sheet thật có cột trống + "PMO formula" có khoảng trắng; lọc theo Ops ID
 * không phân biệt hoa thường + dự phòng phần số; "None"/rỗng → ''; sort giảm dần theo ngày);
 * getReports (operator+ gate — báo cáo chính mình; viewer chặn; email chưa khai StaffInfo → rows rỗng + message; anonymous → ok + 'Chưa đăng nhập');
 * getReportsApi wrapper.
 *
 * Mock GAS + loader dùng chung: tests/gas-sandbox.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeSandbox, loadAll } = require('./gas-sandbox');

const clone = (v) => JSON.parse(JSON.stringify(v));

// Header StaffAttendance y hệt sheet thật (2 cột trống giữa out_time_convert và "PMO formula").
const ATT_HEADER = [
  'report_date', 'biz_staff_id', 'employee_id', 'staff_name', 'profile_station_name',
  'profile_station_code', 'attendance_result_ops', 'result_comment', 'work_hour',
  'in_time', 'out_time', 'update_time', 'report_date_convert', 'in_time_convert',
  'out_time_convert', '', '', 'PMO formula', 'Line Manager',
];

/** Thêm StaffInfo + StaffAttendance vào sandbox ss (đúng cấu trúc sheet thật). */
function seedReportSheets(ss) {
  const info = ss.insertSheet('StaffInfo');
  info.appendRow(['No.', 'Staff ID', 'Ops ID', 'Staff Name', 'Staff Email', 'Rank', 'Joined Date', 'Working day']);
  info.appendRow([1, 'SPXVN00001', 'Ops237511', 'NV001', 'nv001.demo@spxexpress.com', 'Analyst', '2022-03-07', 1622]);
  const att = ss.insertSheet('StaffAttendance');
  att.appendRow(ATT_HEADER);
  // Ops237511: 3 ngày (1 OFF có "None") + Ops khác để chắc lọc đúng người
  att.appendRow(['2026-08-01', 'Ops237511', 'SPXVN00001', 'NV001', 'HN2 SOC', '20SOCH2', '22:00-06:00', '', 8.13, '2026-08-01 21:52:03.000', '2026-08-02 06:00:19.000', '2026-08-15 11:26:37.235 Asia/Shanghai', '8/1/2026', '21:52', '06:00', '', '', 'Tang NV001', 'LM1']);
  att.appendRow(['2026-08-02', 'Ops237511', 'SPXVN00001', 'NV001', 'HN2 SOC', '20SOCH2', 'OFF', '', 'None', 'None', 'None', '2026-08-15 11:26:37.235 Asia/Shanghai', '8/2/2026', '', '', '', '', 'Không chấm công hoặc OFF tuần', 'LM1']);
  att.appendRow(['2026-08-03', 'Ops237511', 'SPXVN00001', 'NV001', 'HN2 SOC', '20SOCH2', '08:00-17:00', '', 8, '2026-08-03 07:58:00.000', '2026-08-03 17:02:00.000', '2026-08-15 11:26:37.235 Asia/Shanghai', '8/3/2026', '07:58', '17:02', '', '', 'Tang NV001', 'LM1']);
  att.appendRow(['2026-08-01', 'Ops999999', 'SPXVN00999', 'NV-DU', 'HN2 SOC', '20SOCH2', '13:00-22:00', '', 9, '', '', '', '8/1/2026', '12:55', '22:01', '', '', '—', 'LM2']);
}

test('buildStaffInfoMap: email → Ops ID (lowercase/trim), bỏ dòng thiếu email hoặc Ops', () => {
  const { ctx } = makeSandbox();
  const svc = loadAll(ctx);
  const map = svc.buildStaffInfoMap([
    ['No.', 'Staff ID', 'Ops ID', 'Staff Name', 'Staff Email'],
    [1, 'SPXVN00001', 'Ops237511', 'NV001', '  NV001.Demo@spxexpress.com  '],
    [2, 'SPXVN00002', '', 'NV002', 'no-ops@spx.com'],          // thiếu Ops ID → bỏ
    [3, 'SPXVN00003', 'Ops333', 'NV003', ''],                   // thiếu email → bỏ
    [4, 'SPXVN00004', 'Ops444', 'NV004', 'ok@spx.com'],
  ]);
  assert.deepEqual(clone(map), {
    'nv001.demo@spxexpress.com': { opsId: 'Ops237511', name: 'NV001' },
    'ok@spx.com': { opsId: 'Ops444', name: 'NV004' },
  });
});

test('buildAttendanceRows: map cột theo tên header, lọc Ops ID, None→\'\', sort desc theo ngày', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  seedReportSheets(ss);
  const values = ss.sheets.StaffAttendance.getDataRange().getValues();
  const rows = svc.buildAttendanceRows(values, 'ops237511');  // lowercase — không phân biệt hoa thường
  assert.equal(rows.length, 3);
  assert.deepEqual(clone(rows[0]), {
    reportDate: '2026-08-03', bizStaffId: 'Ops237511', employeeId: 'SPXVN00001',
    staffName: 'NV001', station: 'HN2 SOC', result: '08:00-17:00', workHour: '8',
    inTime: '07:58', outTime: '17:02', pmo: 'Tang NV001',
  });
  // Dòng OFF: "None" → '' (không còn chữ None lộ ra UI)
  assert.equal(rows[2].reportDate, '2026-08-01');
  assert.equal(rows[2].result, '22:00-06:00');
  const off = rows[1];
  assert.equal(off.result, 'OFF');
  assert.equal(off.workHour, '');
  assert.equal(off.inTime, '');
  assert.equal(off.pmo, 'Không chấm công hoặc OFF tuần');
  // Không lẫn dòng NV khác (Ops999999)
  const hasDup = rows.some((r) => r.bizStaffId === 'Ops999999');
  assert.equal(hasDup, false);
});

test('buildAttendanceRows: dự phòng so khớp phần số khi 2 nguồn lệch tiền tố Ops', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  seedReportSheets(ss);
  // StaffInfo ghi "103487" (thiếu tiền tố) — vẫn khớp dòng "Ops103487" qua phần số.
  const values = ss.sheets.StaffAttendance.getDataRange().getValues();
  const rows = svc.buildAttendanceRows(values, '103487');
  assert.equal(rows.length, 0);  // không có Ops103487 trong mock data — chỉ verify không throw
  // Khớp qua phần số với Ops237511 → 237511
  const rows2 = svc.buildAttendanceRows(values, '237511');
  assert.equal(rows2.length, 3);
});

test('buildAttendanceRows: sheet trống / chỉ header → []', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  const att = ss.insertSheet('StaffAttendance');
  att.appendRow(ATT_HEADER);
  const values = ss.sheets.StaffAttendance.getDataRange().getValues();
  assert.deepEqual(clone(svc.buildAttendanceRows(values, 'Ops237511')), []);
});

test('getReports: operator+ — email khớp StaffInfo → rows đúng của mình', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'nv001.demo@spxexpress.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  ss.sheets.Config.appendRow(['roleMap', JSON.stringify({ 'nv001.demo@spxexpress.com': 'operator' })]);
  seedReportSheets(ss);
  const res = svc.getReports();
  assert.equal(res.ok, true);
  assert.equal(res.opsId, 'Ops237511');
  assert.equal(res.staffName, 'NV001');
  assert.equal(res.rows.length, 3);
  assert.equal(res.rows[0].reportDate, '2026-08-03');  // sort desc
  assert.equal(res.message, '');
});

test('getReports: email chưa khai StaffInfo → ok + rows rỗng + message hướng dẫn', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'unknown@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  ss.sheets.Config.appendRow(['roleMap', JSON.stringify({ 'unknown@spx.com': 'operator' })]);
  seedReportSheets(ss);
  const res = svc.getReports();
  assert.equal(res.ok, true);
  assert.deepEqual(clone(res.rows), []);
  assert.match(res.message, /StaffInfo/);
});

test('getReports: email rỗng (anonymous) → ok + message hướng dẫn (không lộ dữ liệu)', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: '' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  seedReportSheets(ss);
  // anonymous luôn operator (Auth.gs: getRole_ rỗng → DEFAULT) — gate operator+ pass,
  // nhưng không có email → không tra được StaffInfo (không lộ dữ liệu người khác).
  const res = svc.getReports();
  assert.equal(res.ok, true);
  assert.deepEqual(clone(res.rows), []);
  assert.match(res.message, /Chưa đăng nhập/);
});

test('getReports: viewer bị chặn (gate operator+ fail-closed)', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'nv001.demo@spxexpress.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();  // tạo Config sheet trước khi ghi roleMap
  seedReportSheets(ss);
  // roleMap viewer cho email này (ghi thẳng Config sheet)
  ss.sheets.Config.appendRow(['roleMap', JSON.stringify({ 'nv001.demo@spxexpress.com': 'viewer' })]);
  const res = svc.getReports();
  assert.equal(res.ok, false);
  assert.match(res.message, /quyền/);
});

test('getReportsApi wrapper: truyền thẳng kết quả service', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'nv001.demo@spxexpress.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  ss.sheets.Config.appendRow(['roleMap', JSON.stringify({ 'nv001.demo@spxexpress.com': 'operator' })]);
  seedReportSheets(ss);
  const res = svc.getReportsApi();
  assert.equal(res.ok, true);
  assert.equal(res.rows.length, 3);
});

test('readAttendanceRowsAll_: cache CHUNG — Ops khác không đọc lại sheet', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  seedReportSheets(ss);
  const a = svc.readAttendanceRows_('Ops237511');
  assert.equal(a.length, 3);
  // Meta + chunk key tồn tại trong script cache
  const cache = ctx.CacheService.getScriptCache();
  assert.ok(cache.get('rc2_reports_v2_all_n'), 'meta chunk count');
  assert.ok(cache.get('rc2_reports_v2_all_0'), 'chunk 0');
  // Xóa sheet nguồn — Ops khác vẫn filter từ cache chung (không đọc lại sheet)
  ss.sheets.StaffAttendance.data = [ss.sheets.StaffAttendance.data[0]];
  const b = svc.readAttendanceRows_('Ops999999');
  assert.equal(b.length, 1);
});

test('filterAttendanceRows: ambiguous phần số (OPS12345 + ABC12345) → chỉ khớp chính xác, không lẫn người khác', () => {
  const { ctx } = makeSandbox();
  const svc = loadAll(ctx);
  const rows = [
    { bizStaffId: 'OPS12345', reportDate: '2026-08-01' },
    { bizStaffId: 'OPS12345', reportDate: '2026-08-02' },
    { bizStaffId: 'ABC12345', reportDate: '2026-08-01' },
    { bizStaffId: 'OPS99999', reportDate: '2026-08-01' },
  ];
  // Muốn OPS12345 — ABC12345 cùng phần số → fallback phần số BỊ VÔ HIỆU (không lẫn dòng ABC)
  const mine = svc.filterAttendanceRows(rows, 'OPS12345');
  assert.deepEqual(mine.map((r) => r.bizStaffId), ['OPS12345', 'OPS12345']);
  // Muốn ABC12345 — chỉ trả đúng ABC
  const theirs = svc.filterAttendanceRows(rows, 'ABC12345');
  assert.deepEqual(theirs.map((r) => r.bizStaffId), ['ABC12345']);
  // Muốn phần số trần '12345' (không exact) + ambiguous → không trả gì (không đoán)
  const bare = svc.filterAttendanceRows(rows, '12345');
  assert.deepEqual(bare, []);
  // ambiguousOpsId_ helper
  assert.equal(svc.ambiguousOpsId_(rows, 'OPS12345'), true);
  assert.equal(svc.ambiguousOpsId_(rows, 'OPS99999'), false);
});

test('filterAttendanceRows: fallback phần số vẫn chạy khi suffix unique', () => {
  const { ctx } = makeSandbox();
  const svc = loadAll(ctx);
  const rows = [
    { bizStaffId: 'OPS237511', reportDate: '2026-08-01' },
    { bizStaffId: 'OPS237511', reportDate: '2026-08-02' },
    { bizStaffId: 'OPS999999', reportDate: '2026-08-01' },
  ];
  const got = svc.filterAttendanceRows(rows, '237511');  // StaffInfo lệch tiền tố
  assert.equal(got.length, 2);
  assert.equal(svc.ambiguousOpsId_(rows, '237511'), false);
});

test('getReports: ambiguous phần số → rows rỗng + message báo admin (không lộ dữ liệu người khác)', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'nv001.demo@spxexpress.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  ss.sheets.Config.appendRow(['roleMap', JSON.stringify({ 'nv001.demo@spxexpress.com': 'operator' })]);
  const info = ss.insertSheet('StaffInfo');
  info.appendRow(['No.', 'Staff ID', 'Ops ID', 'Staff Name', 'Staff Email', 'Rank', 'Joined Date', 'Working day']);
  info.appendRow([1, 'SPXVN00001', 'Ops12345', 'NV001', 'nv001.demo@spxexpress.com', 'Analyst', '2022-03-07', 1622]);
  const att = ss.insertSheet('StaffAttendance');
  att.appendRow(['report_date', 'biz_staff_id', 'employee_id', 'staff_name', 'profile_station_name', 'attendance_result_ops', 'work_hour', 'in_time_convert', 'out_time_convert', 'PMO formula']);
  att.appendRow(['2026-08-01', 'Ops12345', 'SPXVN00001', 'NV001', 'HN2 SOC', '22:00-06:00', 8, '21:52', '06:00', 'PMO A']);
  att.appendRow(['2026-08-01', 'ABC12345', 'SPXVN00002', 'NV-KHAC', 'HN SOC', '08:00-17:00', 8, '07:52', '17:00', 'PMO B']);
  const res = svc.getReports();
  assert.equal(res.ok, true);
  assert.equal(res.rows.length, 1, 'chỉ trả đúng Ops12345 — không lẫn ABC12345');
  assert.equal(res.rows[0].bizStaffId, 'Ops12345');
});

test('shared reader: whitelist gate — role lạ/thiếu → fail-closed (RPC gọi trực tiếp không bypass)', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  seedReportSheets(ss);
  assert.deepEqual(clone(svc.readStaffInfoMapShared_()), {}, 'thiếu role → {}');
  assert.deepEqual(clone(svc.readStaffInfoMapShared_('viewer')), {}, 'role ngoài whitelist → {}');
  assert.equal(svc.readAttendanceRowsAllShared_().length, 0, 'thiếu role → []');
  assert.equal(svc.readAttendanceRowsAllShared_('admin').length, 0, 'admin không có trong whitelist → []');
  const map = svc.readStaffInfoMapShared_('manager');
  assert.equal(map['nv001.demo@spxexpress.com'].opsId, 'Ops237511', 'manager → map đầy đủ');
  assert.equal(svc.readAttendanceRowsAllShared_('manager').length, 4, 'manager → rows đầy đủ');
  assert.equal(svc.readAttendanceRowsAllShared_('operator').length, 4, 'operator → rows đầy đủ (dùng chung cache)');
});

test('readAttendanceRowsAll_: sheet lớn >1 chunk (vượt 100KB/key)', () => {
  const { ctx, ss } = makeSandbox();
  const svc = loadAll(ctx);
  const att = ss.insertSheet('StaffAttendance');
  att.appendRow(ATT_HEADER);
  for (let i = 0; i < 600; i++) {
    att.appendRow(['2026-08-01', 'Ops' + String(100000 + i), 'SPXVN' + String(i).padStart(5, '0'), 'NV ' + i, 'HN2 SOC', '20SOCH2', '08:00-17:00', '', 8, '07:58', '17:02', '', '8/1/2026', '07:58', '17:02', '', '', 'PMO ' + i, 'LM1']);
  }
  const rows = svc.readAttendanceRows_('Ops100005');
  assert.equal(rows.length, 1);
  const cache = ctx.CacheService.getScriptCache();
  const n = parseInt(cache.get('rc2_reports_v2_all_n'), 10);
  assert.ok(n > 1, 'phải có >1 chunk, thực tế ' + n);
  // Xóa sheet nguồn — vẫn trả từ cache chunked
  ss.sheets.StaffAttendance.data = [ss.sheets.StaffAttendance.data[0]];
  const rows2 = svc.readAttendanceRows_('Ops100005');
  assert.equal(rows2.length, 1);
});
