/**
 * tests/scan-classify.test.js — Node thuần (không cần GAS)
 * Test: classifyScan, computeCounters, buildExtraRow (ScanLogic.gs)
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const ScanLogic = require('../ScanLogic.gs');

const CFG = {
  STATUS: { PRESENT: 'Có mặt', ABSENT: 'Vắng', EXTRA: 'Dư', PENDING: '-' },
  TASK_STATUS: { OPEN: 'open', ATTEND: 'attend', DONE: 'done' },
};

function makeRow(overrides) {
  return Object.assign({
    taskId: 'R20260802-0730',
    staffId: 'OPS000001',
    staffName: 'NhanVien Mau 001',
    slotCode: '08:00-17:00',
    station: 'HN2 SOC',
    team: 'Outbound',
    workstation: 'OBLoading',
    cardIn: '7:57:01',
    cardOut: '',
    listedAt: new Date('2026-08-02T07:30:00'),
    scannedAt: null,
    scannedAtEpoch: 0,   // P2: epoch là nguồn sự thật — scanned khi >0
    status: CFG.STATUS.ABSENT,
  }, overrides || {});
}

test('classifyScan: task closed → reject task-closed', () => {
  const task = { taskId: 'R1', status: CFG.TASK_STATUS.DONE };
  const res = ScanLogic.classifyScan(CFG, task, [makeRow()], 'OPS000001');
  assert.equal(res.action, 'reject');
  assert.equal(res.reason, 'task-closed');
});

test('classifyScan: empty staffId → reject', () => {
  const task = { taskId: 'R1', status: CFG.TASK_STATUS.OPEN };
  const res = ScanLogic.classifyScan(CFG, task, [makeRow()], '');
  assert.equal(res.action, 'reject');
  assert.equal(res.reason, 'empty-staff-id');
});

test('classifyScan (phase2): NV trong log + chưa quét → update PRESENT', () => {
  const task = { taskId: 'R1', status: CFG.TASK_STATUS.ATTEND };
  const res = ScanLogic.classifyScan(CFG, task, [makeRow()], 'ops000001');
  assert.equal(res.action, 'update');
  assert.equal(res.field, 'scannedAt');
  assert.equal(res.status, CFG.STATUS.PRESENT);
  assert.equal(res.row.staffId, 'OPS000001');
});

test('classifyScan (phase2): NV trong log + đã quét → reject already-scanned', () => {
  const task = { taskId: 'R1', status: CFG.TASK_STATUS.ATTEND };
  const scanned = makeRow({ scannedAt: new Date('2026-08-02T07:45:00'), scannedAtEpoch: 1783082700000, status: CFG.STATUS.PRESENT });
  const res = ScanLogic.classifyScan(CFG, task, [scanned], 'OPS000001');
  assert.equal(res.action, 'reject');
  assert.equal(res.reason, 'already-scanned');
});

test('classifyScan: NV không trong log → append EXTRA (khớp tổ hợp nhưng chưa pre-fill)', () => {
  const task = { taskId: 'R1', status: CFG.TASK_STATUS.OPEN };
  const rows = [makeRow()]; // chỉ có OPS000001
  const res = ScanLogic.classifyScan(CFG, task, rows, 'OPS000099');
  assert.equal(res.action, 'append');
  assert.equal(res.status, CFG.STATUS.PENDING);
});

test('classifyScan: NV không trong log + khác tổ hợp → append PENDING (phase1)', () => {
  const task = { taskId: 'R1', status: CFG.TASK_STATUS.OPEN };
  const res = ScanLogic.classifyScan(CFG, task, [makeRow()], 'OPS000050');
  assert.equal(res.action, 'append');
  assert.equal(res.status, CFG.STATUS.PENDING);
});

test('findLogRow: case-insensitive', () => {
  const rows = [makeRow()];
  assert.ok(ScanLogic.findLogRow(rows, 'ops000001'));
  assert.ok(ScanLogic.findLogRow(rows, 'OPS000001'));
  assert.equal(ScanLogic.findLogRow(rows, 'OPS999999'), null);
});

test('computeCounters: quy ước đã chốt', () => {
  const rows = [
    makeRow({ staffId: 'OPS000001', scannedAtEpoch: 1700000000000, status: CFG.STATUS.PRESENT }), // scanned
    makeRow({ staffId: 'OPS000002', scannedAtEpoch: 0, status: CFG.STATUS.ABSENT }),       // absent
    makeRow({ staffId: 'OPS000003', scannedAtEpoch: 1700000000001, status: CFG.STATUS.EXTRA }), // scanned + extra
    makeRow({ staffId: 'OPS000004', scannedAtEpoch: 0, status: CFG.STATUS.ABSENT }),       // absent
  ];
  const c = ScanLogic.computeCounters(CFG, rows);
  assert.equal(c.scanned, 2);   // Có mặt + Dư
  assert.equal(c.absent, 2);    // pre-fill chưa quét
  assert.equal(c.extra, 1);     // status EXTRA
  assert.equal(c.total, 4);
});

test('computeCounters: PENDING + có timeScan (data-repair) → đếm scanned, KHÔNG absent', () => {
  // Insurance path (markUnscannedAbsent_): dòng có timeScan nhưng status còn '-'
  // (data legacy/sửa tay) → chuẩn hóa thành Có mặt, KHÔNG đánh Vắng.
  // computeCounters dùng scannedAtEpoch > 0 làm nguồn sự thật duy nhất.
  const rows = [
    makeRow({ staffId: 'OPS000001', scannedAtEpoch: 1700000000000, status: CFG.STATUS.PENDING }), // quét rồi nhưng status chưa cập nhật
    makeRow({ staffId: 'OPS000002', scannedAtEpoch: 0, status: CFG.STATUS.PENDING }),       // chưa quét (đúng)
  ];
  const c = ScanLogic.computeCounters(CFG, rows);
  assert.equal(c.scanned, 1);   // chỉ dòng có timeScan
  assert.equal(c.absent, 1);    // dòng còn PENDING + chưa quét
  assert.equal(c.extra, 0);     // không phải EXTRA
  assert.equal(c.total, 2);
});


