/**
 * tests/two-phase.test.js — Node thuần. Test 2-phase attendance (ScanLogic.gs).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const ScanLogic = require('../ScanLogic.gs');

const CFG = {
  STATUS: { PENDING: '-', PRESENT: 'Có mặt', ABSENT: 'Vắng', EXTRA: 'Dư' },
  TASK_STATUS: { OPEN: 'open', ATTEND: 'attend', DONE: 'done' },
};

function makeRow(overrides) {
  return Object.assign({
    taskId: 'R1',
    staffId: 'OPS000001',
    staffName: 'NV 001',
    slotCode: '08:00-17:00',
    station: 'HN2',
    team: 'Outbound',
    workstation: 'OB',
    timeRef: null,
    timeRefEpoch: 0,
    timeScan: null,
    timeScanEpoch: 0,
    status: CFG.STATUS.PENDING,
  }, overrides || {});
}

test('phase1 (Mở): NV trong log chưa có Giờ có mặt → update timeRef', () => {
  const task = { taskId: 'R1', status: CFG.TASK_STATUS.OPEN };
  const row = makeRow({ timeRef: null, timeRefEpoch: 0, status: CFG.STATUS.PENDING });
  const res = ScanLogic.classifyScan(CFG, task, [row], 'OPS000001');
  assert.equal(res.action, 'update');
  assert.equal(res.phase, 'present');
  assert.equal(res.field, 'timeRef');
  assert.equal(res.status, CFG.STATUS.PENDING);
});

test('phase1: NV đã có Giờ có mặt → reject already-present', () => {
  const task = { taskId: 'R1', status: CFG.TASK_STATUS.OPEN };
  const row = makeRow({ timeRef: new Date('2026-08-02T07:30:00'), timeRefEpoch: 1783081800000 });
  const res = ScanLogic.classifyScan(CFG, task, [row], 'OPS000001');
  assert.equal(res.action, 'reject');
  assert.equal(res.reason, 'already-present');
});

test('phase1: NV không trong log → append EXTRA + field timeRef', () => {
  const task = { taskId: 'R1', status: CFG.TASK_STATUS.OPEN };
  const res = ScanLogic.classifyScan(CFG, task, [], 'OPS000999');
  assert.equal(res.action, 'append');
  assert.equal(res.phase, 'present');
  assert.equal(res.field, 'timeRef');
  assert.equal(res.status, CFG.STATUS.EXTRA);
});

test('phase2 (Điểm danh): NV trong log chưa quét → update timeScan/PRESENT', () => {
  const task = { taskId: 'R1', status: CFG.TASK_STATUS.ATTEND };
  const row = makeRow({ timeRef: new Date('2026-08-02T07:30:00'), timeRefEpoch: 1783081800000 });
  const res = ScanLogic.classifyScan(CFG, task, [row], 'OPS000001');
  assert.equal(res.action, 'update');
  assert.equal(res.phase, 'attend');
  assert.equal(res.field, 'timeScan');
  assert.equal(res.status, CFG.STATUS.PRESENT);
});

test('phase2: NV đã quét → reject already-scanned', () => {
  const task = { taskId: 'R1', status: CFG.TASK_STATUS.ATTEND };
  const row = makeRow({ timeScan: new Date('2026-08-02T08:00:00'), timeScanEpoch: 1783083600000 });
  const res = ScanLogic.classifyScan(CFG, task, [row], 'OPS000001');
  assert.equal(res.action, 'reject');
  assert.equal(res.reason, 'already-scanned');
});

test('phase2: NV không trong log → append EXTRA + field timeScan', () => {
  const task = { taskId: 'R1', status: CFG.TASK_STATUS.ATTEND };
  const res = ScanLogic.classifyScan(CFG, task, [], 'OPS000999');
  assert.equal(res.action, 'append');
  assert.equal(res.phase, 'attend');
  assert.equal(res.field, 'timeScan');
  assert.equal(res.status, CFG.STATUS.EXTRA);
});

test('computeCounters: presentAt (Giờ có mặt) ≠ scanned (Giờ quét)', () => {
  const rows = [
    makeRow({ staffId: 'OPS1', timeRefEpoch: 1700000000000, timeScanEpoch: 0, status: CFG.STATUS.PENDING }),
    makeRow({ staffId: 'OPS2', timeRefEpoch: 1700000000001, timeScanEpoch: 1700000000002, status: CFG.STATUS.PRESENT }),
    makeRow({ staffId: 'OPS3', timeRefEpoch: 0, timeScanEpoch: 0, status: CFG.STATUS.PENDING }),
  ];
  const c = ScanLogic.computeCounters(CFG, rows);
  assert.equal(c.presentAt, 2); // OPS1 + OPS2: có Giờ có mặt
  assert.equal(c.scanned, 1);   // OPS2: quét Giờ quét
  assert.equal(c.absent, 2);    // OPS1 (có mặt chưa quét) + OPS3 (chưa gì) → Vắng
  assert.equal(c.extra, 0);
  assert.equal(c.total, 3);
});

test('buildExtraRow: field=timeScan ghi timeScan, field=timeRef ghi timeRef', () => {
  const now = new Date('2026-08-02T08:00:00');
  const rScan = ScanLogic.buildExtraRow(CFG, 'R1', 'OPS1', null, now, 'timeScan');
  assert.equal(rScan.timeScan, now);
  assert.equal(rScan.timeScanEpoch, now.getTime());
  assert.equal(rScan.timeRef, null);
  assert.equal(rScan.timeRefEpoch, 0);
  const rRef = ScanLogic.buildExtraRow(CFG, 'R1', 'OPS2', null, now, 'timeRef');
  assert.equal(rRef.timeRef, now);
  assert.equal(rRef.timeRefEpoch, now.getTime());
  assert.equal(rRef.timeScan, null);
  assert.equal(rRef.timeScanEpoch, 0);
});

// ===== Nhánh "Quét tự do" (noList) — tạo task KHÔNG danh sách, quét 2 lần =====
test('noList: createReconcileTask không cần group → log rỗng, status Mở', () => {
  // Giả lập các dependency bằng stub nhẹ (TaskService dùng global GAS API).
  // Vì TaskService require GAS, test này chỉ kiểm tra classifyScan behaviour cho
  // task noList: task Mở + log rỗng → lần 1 append EXTRA(timeRef), lần 2 append EXTRA(timeScan).
  const taskOpen = { taskId: 'R-NL', status: CFG.TASK_STATUS.OPEN };
  const r1 = ScanLogic.classifyScan(CFG, taskOpen, [], 'OPS000777');
  assert.equal(r1.action, 'append');
  assert.equal(r1.phase, 'present');
  assert.equal(r1.field, 'timeRef');
  assert.equal(r1.status, CFG.STATUS.EXTRA);

  const taskAttend = { taskId: 'R-NL', status: CFG.TASK_STATUS.ATTEND };
  const r2 = ScanLogic.classifyScan(CFG, taskAttend, [], 'OPS000777');
  assert.equal(r2.action, 'append');
  assert.equal(r2.phase, 'attend');
  assert.equal(r2.field, 'timeScan');
  assert.equal(r2.status, CFG.STATUS.EXTRA);
});

test('noList: 2-phase cho NV lạ — phase1 rồi phase2 trên cùng 1 dòng', () => {
  // Mô phỏng: sau quét lần 1 (timeRef), dòng đã có trong log, quét lần 2 ghi timeScan.
  const row = makeRow({ staffId: 'OPS000777', timeRef: new Date('2026-08-02T07:00:00'), timeRefEpoch: 1783078800000, status: CFG.STATUS.EXTRA });
  const taskAttend = { taskId: 'R-NL', status: CFG.TASK_STATUS.ATTEND };
  // Khi NV lạ đã có Giờ có mặt (phase1) → quét lần 2 (phase2) ghi Giờ quét và
  // chuyển status EXTRA → PRESENT (điểm danh xong). Behaviour này đúng cho cả
  // roster lẫn noList: append phase1 = Dư, update phase2 = Có mặt.
  const res = ScanLogic.classifyScan(CFG, taskAttend, [row], 'OPS000777');
  assert.equal(res.action, 'update');
  assert.equal(res.field, 'timeScan');
  assert.equal(res.status, CFG.STATUS.PRESENT);
});
