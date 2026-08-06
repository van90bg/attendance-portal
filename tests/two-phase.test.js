/**
 * tests/two-phase.test.js — Node thuần. Test 2-phase attendance (ScanLogic.gs).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const ScanLogic = require('../ScanLogic.gs');

const CFG = {
  STATUS: { PENDING: '-', PRESENT: 'Có mặt', ABSENT: 'Vắng', EXTRA: 'Dư' },
  TASK_STATUS: { OPEN: 'open', ATTEND: 'attend', DONE: 'done' },
  TASK_TYPE: { RECONCILE: 'reconcile', FREE: 'free' },
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

test('computeCounters: có Giờ có mặt nhưng chưa quét → Vắng (không phải Có mặt)', () => {
  const rows = [
    makeRow({ staffId: 'OPS1', timeRefEpoch: 1700000000000, timeScanEpoch: 0, status: CFG.STATUS.PENDING }),
    makeRow({ staffId: 'OPS2', timeRefEpoch: 1700000000001, timeScanEpoch: 1700000000002, status: CFG.STATUS.PRESENT }),
    makeRow({ staffId: 'OPS3', timeRefEpoch: 0, timeScanEpoch: 0, status: CFG.STATUS.PENDING }),
  ];
  const c = ScanLogic.computeCounters(CFG, rows);
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

test('noList/RECONCILE: NV Dư (EXTRA) quét phase2 GIỮ Dư — KHÔNG đổi thành Có mặt', () => {
  // Mô phỏng: NV lạ quét phase1 = Dư (EXTRA, có timeRef). Phase2 quét lại →
  // vẫn là Dư (EXTRA), KHÔNG đổi thành PRESENT. Chỉ NV trong danh sách (PENDING)
  // quét phase2 mới = Có mặt. (Fix 2026-08-06: trước đây Dư phase2 bị ghi nhầm Có mặt)
  const row = makeRow({ staffId: 'OPS000777', timeRef: new Date('2026-08-02T07:00:00'), timeRefEpoch: 1783078800000, status: CFG.STATUS.EXTRA });
  const taskAttend = { taskId: 'R-NL', status: CFG.TASK_STATUS.ATTEND };
  const res = ScanLogic.classifyScan(CFG, taskAttend, [row], 'OPS000777');
  assert.equal(res.action, 'update');
  assert.equal(res.field, 'timeScan');
  assert.equal(res.status, CFG.STATUS.EXTRA);
});

// ===== Fix #3: noList QUÉT ĐẦU (phase1) phải ghi PENDING (Chưa điểm danh), KHÔNG Dư =====
test('buildExtraRow: status truyền vào được giữ (mặc định EXTRA fallback)', () => {
  const now = new Date('2026-08-02T08:00:00');
  const rDef = ScanLogic.buildExtraRow(CFG, 'R1', 'OPS1', null, now, 'timeRef');
  assert.equal(rDef.status, CFG.STATUS.EXTRA);
  const rPen = ScanLogic.buildExtraRow(CFG, 'R1', 'OPS1', null, now, 'timeRef', CFG.STATUS.PENDING);
  assert.equal(rPen.status, CFG.STATUS.PENDING);
  const rPre = ScanLogic.buildExtraRow(CFG, 'R1', 'OPS1', null, now, 'timeScan', CFG.STATUS.PRESENT);
  assert.equal(rPre.status, CFG.STATUS.PRESENT);
});

test('noList (FREE) phase1 quét đầu: append PENDING — KHÔNG Dư', () => {
  // Quét tự do (taskType FREE) KHÔNG có danh sách → NV lạ hợp lệ, quét đầu
  // (phase1) ghi Giờ có mặt + PENDING (Chưa điểm danh), KHÔNG phải Dư.
  const task = { taskId: 'R-NL', status: CFG.TASK_STATUS.OPEN, taskType: CFG.TASK_TYPE.FREE };
  const cls = ScanLogic.classifyScan(CFG, task, [], 'OPS000999');
  assert.equal(cls.action, 'append');
  assert.equal(cls.field, 'timeRef');
  assert.equal(cls.status, CFG.STATUS.PENDING);
});

test('noList (FREE) phase2 quét NV lạ → append EXTRA — Dư', () => {
  // Quét tự do phase2 (Điểm danh), NV lạ → append Giờ quét + PRESENT.
  const task = { taskId: 'R-NL', status: CFG.TASK_STATUS.ATTEND, taskType: CFG.TASK_TYPE.FREE };
  const cls = ScanLogic.classifyScan(CFG, task, [], 'OPS000999');
  assert.equal(cls.action, 'append');
  assert.equal(cls.field, 'timeScan');
  // FREE phase2: NV chưa trong danh sách phase1 → Dư (EXTRA), không còn PRESENT.
  assert.equal(cls.status, CFG.STATUS.EXTRA);
});

test('roster (RECONCILE) NV lạ vẫn EXTRA (Dư) — không đổi behaviour', () => {
  // Có danh sách (RECONCILE): NV quét không có trong roster → Dư (EXTRA).
  const task = { taskId: 'R1', status: CFG.TASK_STATUS.OPEN, taskType: CFG.TASK_TYPE.RECONCILE };
  const cls = ScanLogic.classifyScan(CFG, task, [], 'OPS000999');
  assert.equal(cls.action, 'append');
  assert.equal(cls.status, CFG.STATUS.EXTRA);
});

