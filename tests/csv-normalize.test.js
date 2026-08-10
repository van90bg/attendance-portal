/**
 * tests/csv-normalize.test.js — Node thuần (không cần GAS)
 * Test: normalizeStaffName/Id, buildStaffListFromValues, buildStaffIndex, filterStaffByGroup, distinctValues
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CsvUtil = require('../CsvUtil.gs');

const FIXTURE = path.join(__dirname, '..', 'test-fixtures', 'Att.sample.csv');

/** Đọc fixture dạng mảng 2D (mô phỏng getValues() của sheet). */
function fixtureValues() {
  const csvText = fs.readFileSync(FIXTURE, 'utf8');
  return csvText.split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => CsvUtil.splitCsvLine(l));
}

/** Staff list từ fixture (giống readStaffListUncached_ — buildStaffListFromValues). */
function fixtureStaff() {
  return CsvUtil.buildStaffListFromValues(fixtureValues());
}

test('normalizeStaffName: trim + gộp double-space', () => {
  assert.equal(CsvUtil.normalizeStaffName('  Đào   Quang  Hà  '), 'Đào Quang Hà');
  assert.equal(CsvUtil.normalizeStaffName(undefined), '');
  assert.equal(CsvUtil.normalizeStaffName(null), '');
});

test('normalizeStaffId: trim + uppercase', () => {
  assert.equal(CsvUtil.normalizeStaffId('  ops237511 '), 'OPS237511');
  assert.equal(CsvUtil.normalizeStaffId(undefined), '');
});

test('splitCsvLine: cơ bản + quoted', () => {
  assert.deepEqual(CsvUtil.splitCsvLine('a,b,"c,d",e'), ['a', 'b', 'c,d', 'e']);
  assert.deepEqual(CsvUtil.splitCsvLine('"a""b",c'), ['a"b', 'c']);
});

test('buildStaffIndex: map theo header sheet', () => {
  const index = CsvUtil.buildStaffIndex(fixtureValues());
  assert.equal(Object.keys(index).length, 12);
  assert.equal(index['OPS000001'].staffName, 'NhanVien Mau 001');
  assert.equal(index['OPS000001'].station, 'HN2 SOC');
});

test('filterStaffByGroup: lọc theo station+slotCode+team', () => {
  const staff = fixtureStaff();
  const morning = CsvUtil.filterStaffByGroup(staff, { station: 'HN2 SOC', slotCode: '08:00-17:00', team: 'Outbound' });
  assert.equal(morning.length, 6); // dòng 1-6 (Ops000001..000006)
  const night = CsvUtil.filterStaffByGroup(staff, { station: 'HN2 SOC', slotCode: '22:00-06:00', team: 'Outbound' });
  assert.equal(night.length, 3); // dòng 8-10 (000008..000010) — dòng 7 (000007) team rỗng
  const receiving = CsvUtil.filterStaffByGroup(staff, { station: 'HN2 SOC', slotCode: '13:00-22:00', team: 'Inbound' });
  assert.equal(receiving.length, 2); // dòng 11-12
  const empty = CsvUtil.filterStaffByGroup(staff, { station: 'HN SOC', slotCode: '08:00-17:00', team: 'Outbound' });
  assert.equal(empty.length, 0);
});

test('buildStaffListFromValues: parse trực tiếp mảng 2D, giữ mọi dòng NV nhiều ca', () => {
  const header = ['No.', 'Date', 'Staff ID', 'Staff Name', 'Staff Email', 'Agency', 'Contract Type', 'Event ID', 'Matching Type', 'Gender', 'Department', 'Clock In Time', 'Clock Out Time', 'Actual Hours', 'Clock In Remark', 'Clock Out Remark', 'Slot Code', 'Workstation', 'Team', 'Station'];
  const values = [
    header,
    ['1', '8/1/2026', 'ops000001', 'Nguyen  Van A', '', 'GRG', 'OS', 'EV1', '', '', 'SOC', '7:57:01', '', '7.6', '', '', '08:00-17:00', 'OBLoading', 'Outbound', 'HN2 SOC'],
    ['2', '8/1/2026', 'OPS000001', 'Nguyen, Van A (2)', '', 'GRG', 'OS', 'EV2', '', '', 'SOC', '13:00:00', '', '7.6', '', '', '13:00-22:00', 'IBReceiving', 'Inbound', 'HN2 SOC'],
    ['3', '8/1/2026', '', 'NoId', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ];
  const list = CsvUtil.buildStaffListFromValues(values);
  assert.equal(list.length, 2); // dòng thiếu staffId bị bỏ
  // staffId normalize uppercase, tên chuẩn hóa
  assert.equal(list[0].staffId, 'OPS000001');
  assert.equal(list[0].staffName, 'Nguyen Van A');
  // Dòng 2 cùng staffId nhưng ca khác — KHÔNG bị mất (khác buildStaffIndex dedupe)
  assert.equal(list[1].staffId, 'OPS000001');
  assert.equal(list[1].slotCode, '13:00-22:00');
  assert.equal(list[1].team, 'Inbound');
  // Giá trị chứa dấu phẩy trong tên không làm hỏng parse
  assert.equal(list[1].staffName, 'Nguyen, Van A (2)');
});

test('buildStaffListFromValues: header sai → trả []', () => {
  assert.equal(CsvUtil.buildStaffListFromValues([['Wrong', 'Header']]).length, 0);
  assert.equal(CsvUtil.buildStaffListFromValues(null).length, 0);
});

test('distinctValues: distinct + sort + filter theo field', () => {
  const staff = fixtureStaff();
  const stations = CsvUtil.distinctValues(staff, 'station');
  assert.deepEqual(stations, ['HN2 SOC']);
  const slotCodes = CsvUtil.distinctValues(staff, 'slotCode');
  assert.deepEqual(slotCodes, ['08:00-17:00', '13:00-22:00', '22:00-06:00']);
  const teams = CsvUtil.distinctValues(staff, 'team', 'slotCode', '08:00-17:00');
  assert.deepEqual(teams, ['Outbound']);
});

test('isValidBarcodeId: chỉ chấp nhận "Ops" + số nguyên (không ký tự khác)', () => {
  assert.equal(CsvUtil.isValidBarcodeId('ops229444'), true);
  assert.equal(CsvUtil.isValidBarcodeId('OPS229444'), true);
  assert.equal(CsvUtil.isValidBarcodeId('Ops6219'), true);   // 4 chữ số
  assert.equal(CsvUtil.isValidBarcodeId('  ops229444  '), true); // leading/trailing whitespace bị trim
  // F1: ký tự khác (kể cả khoảng trắng giữa Ops và số) → sai
  assert.equal(CsvUtil.isValidBarcodeId('Ops 229444'), false);
  assert.equal(CsvUtil.isValidBarcodeId('OpsABC'), false);   // Ops + chữ
  assert.equal(CsvUtil.isValidBarcodeId('Ops'), false);      // Ops không có số
  assert.equal(CsvUtil.isValidBarcodeId('Ops12a3'), false);   // hỗn hợp số + chữ
  assert.equal(CsvUtil.isValidBarcodeId('229444'), false);
  assert.equal(CsvUtil.isValidBarcodeId('NV003'), false);
  assert.equal(CsvUtil.isValidBarcodeId(''), false);
  assert.equal(CsvUtil.isValidBarcodeId(null), false);
  assert.equal(CsvUtil.isValidBarcodeId(undefined), false);
});

test('dedupeStaffByGroup: dedupe theo staffId trong cùng tổ hợp, giữ dòng đầu', () => {
  const list = [
    { staffId: 'OPS196935', staffName: 'A', slotCode: '08:00-17:00', team: 'Outbound', station: 'HN2 SOC' },
    { staffId: 'OPS196935', staffName: 'A (dòng 2)', slotCode: '08:00-17:00', team: 'Outbound', station: 'HN2 SOC' },
    { staffId: 'OPS229444', staffName: 'B', slotCode: '08:00-17:00', team: 'Outbound', station: 'HN2 SOC' },
    { staffId: 'OPS229444', staffName: 'B (dòng 2)', slotCode: '08:00-17:00', team: 'Outbound', station: 'HN2 SOC' },
    { staffId: 'OPS127281', staffName: 'C', slotCode: '08:00-17:00', team: 'Outbound', station: 'HN2 SOC' },
  ];
  const deduped = CsvUtil.dedupeStaffByGroup(list);
  assert.equal(deduped.length, 3);
  assert.equal(deduped[0].staffId, 'OPS196935');
  assert.equal(deduped[0].staffName, 'A'); // giữ dòng đầu tiên
  assert.equal(deduped[1].staffId, 'OPS229444');
  assert.equal(deduped[2].staffId, 'OPS127281');
});

test('dedupeStaffByGroup: giữ NV nhiều ca khác nhau (không dedupe toàn cục)', () => {
  const list = [
    { staffId: 'OPS000001', slotCode: '08:00-17:00', team: 'Outbound', station: 'HN2 SOC' },
    { staffId: 'OPS000001', slotCode: '13:00-22:00', team: 'Inbound', station: 'HN2 SOC' },
    { staffId: 'OPS000002', slotCode: '08:00-17:00', team: 'Outbound', station: 'HN2 SOC' },
  ];
  // Flow thật: filterStaffByGroup trước (1 tổ hợp) → dedupe sau. NV 2 ca khác nhau
  // qua filter chỉ còn dòng đúng tổ hợp → dedupe không gộp nhầm ca khác.
  const filtered = CsvUtil.filterStaffByGroup(list, { station: 'HN2 SOC', slotCode: '08:00-17:00', team: 'Outbound' });
  assert.equal(filtered.length, 2);
  const deduped = CsvUtil.dedupeStaffByGroup(filtered);
  assert.equal(deduped.length, 2);
});

test('dedupeStaffByGroup: input null/empty → []', () => {
  assert.equal(CsvUtil.dedupeStaffByGroup(null).length, 0);
  assert.equal(CsvUtil.dedupeStaffByGroup([]).length, 0);
});

test('filterStaffByGroup: MULTI-select teams+slots (mảng)', () => {
  const staff = [
    { staffId: 'OPS000001', slotCode: '08:00-17:00', team: 'Inbound', station: 'HN2 SOC' },
    { staffId: 'OPS000002', slotCode: '13:00-22:00', team: 'Outbound', station: 'HN2 SOC' },
    { staffId: 'OPS000003', slotCode: '08:00-17:00', team: 'Outbound', station: 'HN2 SOC' },
    { staffId: 'OPS000004', slotCode: '18:00-02:00', team: 'Inbound', station: 'HN2 SOC' },
  ];
  const r = CsvUtil.filterStaffByGroup(staff, { station: 'HN2 SOC', slotCode: ['08:00-17:00', '13:00-22:00'], team: ['Inbound', 'Outbound'] });
  // Loại OPS000004 (slot 18:00 không chọn) — còn 3
  assert.equal(r.length, 3);
  // Chỉ team Inbound + cả slot
  const r2 = CsvUtil.filterStaffByGroup(staff, { station: 'HN2 SOC', slotCode: ['08:00-17:00', '18:00-02:00'], team: ['Inbound'] });
  assert.equal(r2.length, 2); // OPS000001 + OPS000004
});

test('filterStaffByGroup: MULTI-select contractType', () => {
  const staff = [
    { staffId: 'OPS000001', slotCode: '08:00-17:00', team: 'Outbound', station: 'HN2 SOC', contractType: 'GRG' },
    { staffId: 'OPS000002', slotCode: '08:00-17:00', team: 'Outbound', station: 'HN2 SOC', contractType: 'OS' },
    { staffId: 'OPS000003', slotCode: '08:00-17:00', team: 'Inbound', station: 'HN2 SOC', contractType: 'GRG' },
    { staffId: 'OPS000004', slotCode: '13:00-22:00', team: 'Outbound', station: 'HN2 SOC', contractType: 'VN' },
  ];
  // Chọn GRG → OPS000001 + OPS000003
  const r = CsvUtil.filterStaffByGroup(staff, { station: 'HN2 SOC', contractType: ['GRG'] });
  assert.equal(r.length, 2);
  // Chọn GRG + OS → 3 người
  const r2 = CsvUtil.filterStaffByGroup(staff, { station: 'HN2 SOC', contractType: ['GRG', 'OS'] });
  assert.equal(r2.length, 3);
  // Chọn VN → chỉ OPS000004
  const r3 = CsvUtil.filterStaffByGroup(staff, { station: 'HN2 SOC', contractType: ['VN'] });
  assert.equal(r3.length, 1);
  // Không chọn contractType → tất cả
  const r4 = CsvUtil.filterStaffByGroup(staff, { station: 'HN2 SOC' });
  assert.equal(r4.length, 4);
});

test('normalizeStaffDate_: raw dd/mm/yyyy → yyyy-MM-dd (ISO)', () => {
  assert.equal(CsvUtil.normalizeStaffDate_('8/1/2026'), '2026-01-08');
  assert.equal(CsvUtil.normalizeStaffDate_('26-07-2026'), '2026-07-26');
  assert.equal(CsvUtil.normalizeStaffDate_('13/12/2026'), '2026-12-13');
  assert.equal(CsvUtil.normalizeStaffDate_(''), '');
  assert.equal(CsvUtil.normalizeStaffDate_(null), '');
  // đã chuẩn rồi → giữ nguyên (idempotent)
  assert.equal(CsvUtil.normalizeStaffDate_('2026-01-08'), '2026-01-08');
  // không match → trả nguyên
  assert.equal(CsvUtil.normalizeStaffDate_('abc'), 'abc');
});

test('buildStaffIndex/buildStaffListFromValues: date chuẩn hóa yyyy-MM-dd', () => {
  const values = [
    ['No.', 'Date', 'Staff ID', 'Staff Name', 'Slot Code', 'Team', 'Station'],
    ['1', '8/1/2026', 'OPS000001', 'Nguyen Van A', '08:00-17:00', 'Inbound', 'HN2 SOC'],
    ['2', '26-07-2026', 'OPS000002', 'Tran Thi B', '13:00-22:00', 'Outbound', 'HN2 SOC'],
  ];
  const idx = CsvUtil.buildStaffIndex(values);
  assert.equal(idx['OPS000001'].date, '2026-01-08');
  assert.equal(idx['OPS000002'].date, '2026-07-26');
  const list = CsvUtil.buildStaffListFromValues(values);
  assert.equal(list[0].date, '2026-01-08');
  assert.equal(list[1].date, '2026-07-26');
});

test('buildStationGroups: cây 3 cấp Station → Ca → Team + dates + contractTypes', () => {
  const staff = [
    { station: 'HN2 SOC', slotCode: '08:00-17:00', team: 'Outbound', date: '2026-08-01', contractType: 'GRG' },
    { station: 'HN2 SOC', slotCode: '08:00-17:00', team: 'Outbound', date: '2026-08-01', contractType: 'GRG' }, // dup
    { station: 'HN2 SOC', slotCode: '08:00-17:00', team: 'Inbound', date: '2026-08-02', contractType: 'OS' },
    { station: 'HN2 SOC', slotCode: '13:00-22:00', team: 'Inbound', date: '2026-08-01', contractType: 'GRG' },
    { station: 'HCM SOC', slotCode: '18:00-02:00', team: 'Shipping', date: '2026-08-03', contractType: 'VN' },
    { station: 'HN2 SOC', slotCode: '', team: 'NoSlot', date: '', contractType: 'CP' }, // thiếu slot → bỏ node ca, vẫn có contractType
    { station: '', slotCode: '08:00-17:00', team: 'NoStation', date: '', contractType: 'GRG' }, // thiếu station → bỏ
    { station: 'HN2 SOC', slotCode: '08:00-17:00', team: '', date: '2026-08-04', contractType: 'OS' }, // thiếu team → bỏ node ca
  ];
  const groups = CsvUtil.buildStationGroups(staff);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].station, 'HCM SOC');
  assert.equal(groups[1].station, 'HN2 SOC');
  const hn2 = groups[1];
  // contractTypes: GRG + OS + CP (HN2 SOC có 3 loại — CP thu thập từ dòng thiếu slot+team)
  assert.deepEqual(hn2.contractTypes, ['CP', 'GRG', 'OS']);
  // Thực tế: CP có station=HN2 SOC nhưng thiếu slot+team → không tạo node ca,
  // nhưng contractType vẫn được collect vào byStation[st].contracts
  // => HCM SOC chỉ có VN
  const hcm = groups[0];
  assert.deepEqual(hcm.contractTypes, ['VN']);
  // HN2 SOC: GRG (dòng 1,4) + OS (dòng 3,8) + CP (dòng 6 - thiếu slot+team nhưng vẫn collect) = 3 loại
  assert.deepEqual(hn2.contractTypes.sort(), ['CP', 'GRG', 'OS'].sort());
  // dates: HN2 có 01, 02, 04
  assert.deepEqual(hn2.dates, ['2026-08-01', '2026-08-02', '2026-08-04']);
  assert.deepEqual(hcm.dates, ['2026-08-03']);
});

test('buildStationGroups: input rỗng → []', () => {
  assert.deepEqual(CsvUtil.buildStationGroups([]), []);
  assert.deepEqual(CsvUtil.buildStationGroups(null), []);
});

// ===== Clock In/Out Time: cell time-only → getValues trả Date (1899-12-30 = epoch Excel) =====
// String(Date) ra "Sat Dec 30 1899 08:12:05 GMT+0706 (Indochina Time)" — phải chuẩn HH:mm:ss
// (giống scanTable/fmtDate), chứ không phải toString() của Date.

test('normalizeClockTime_: Date sheet → HH:mm:ss; giữ chuỗi chuẩn', () => {
  const d = new Date(1899, 11, 30, 8, 12, 5);
  assert.equal(CsvUtil.normalizeClockTime_(d), '08:12:05');
  assert.equal(CsvUtil.normalizeClockTime_(new Date(1899, 11, 30, 17, 30, 0)), '17:30:00');
  assert.equal(CsvUtil.normalizeClockTime_('07:12:05'), '07:12:05');
  assert.equal(CsvUtil.normalizeClockTime_('7:12:05'), '07:12:05');
  assert.equal(CsvUtil.normalizeClockTime_('7:05'), '07:05:00');
  assert.equal(CsvUtil.normalizeClockTime_(''), '');
  assert.equal(CsvUtil.normalizeClockTime_(null), '');
  assert.equal(CsvUtil.normalizeClockTime_(undefined), '');
  assert.equal(CsvUtil.normalizeClockTime_('abc'), 'abc');
});

test('buildStaffListFromValues/buildStaffIndex: Clock In/Out Time Date → HH:mm:ss (KHÔNG phải toString Date)', () => {
  const header = ['No.', 'Date', 'Staff ID', 'Staff Name', 'Staff Email', 'Agency', 'Contract Type', 'Event ID', 'Matching Type', 'Gender', 'Department', 'Clock In Time', 'Clock Out Time', 'Actual Hours', 'Clock In Remark', 'Clock Out Remark', 'Slot Code', 'Workstation', 'Team', 'Station'];
  const values = [
    header,
    ['1', '8/1/2026', 'OPS000001', 'Nguyen Van A', '', 'GRG', 'OS', 'EV1', '', '', 'SOC', new Date(1899, 11, 30, 8, 12, 5), new Date(1899, 11, 30, 17, 30, 0), '7.6', '', '', '08:00-17:00', 'OBLoading', 'Outbound', 'HN2 SOC'],
  ];
  const list = CsvUtil.buildStaffListFromValues(values);
  assert.equal(list[0].cardIn, '08:12:05');
  assert.equal(list[0].cardOut, '17:30:00');
  const idx = CsvUtil.buildStaffIndex(values);
  assert.equal(idx['OPS000001'].cardIn, '08:12:05');
  assert.equal(idx['OPS000001'].cardOut, '17:30:00');
});
