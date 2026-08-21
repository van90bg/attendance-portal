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
    listedAt: null,
    listedAtEpoch: 0,
    scannedAt: null,
    scannedAtEpoch: 0,
    status: CFG.STATUS.PENDING,
  }, overrides || {});
}

test('phase1 (Mở): NV trong log chưa có LISTED_AT → update timeRef', () => {
  const task = { taskId: 'R1', status: CFG.TASK_STATUS.OPEN };
  const row = makeRow({ listedAt: null, listedAtEpoch: 0, status: CFG.STATUS.PENDING });
  const res = ScanLogic.classifyScan(CFG, task, [row], 'OPS000001');
  assert.equal(res.action, 'update');
  assert.equal(res.phase, 'present');
  assert.equal(res.field, 'listedAt');
  assert.equal(res.status, CFG.STATUS.PENDING);
});

test('phase1: NV đã có LISTED_AT → reject already-present', () => {
  const task = { taskId: 'R1', status: CFG.TASK_STATUS.OPEN };
  const row = makeRow({ listedAt: new Date('2026-08-02T07:30:00'), listedAtEpoch: 1783081800000 });
  const res = ScanLogic.classifyScan(CFG, task, [row], 'OPS000001');
  assert.equal(res.action, 'reject');
  assert.equal(res.reason, 'already-present');
});

test('phase1: NV không trong log → append PENDING + field timeRef', () => {
  const task = { taskId: 'R1', status: CFG.TASK_STATUS.OPEN };
  const res = ScanLogic.classifyScan(CFG, task, [], 'OPS000999');
  assert.equal(res.action, 'append');
  assert.equal(res.phase, 'present');
  assert.equal(res.field, 'listedAt');
  assert.equal(res.status, CFG.STATUS.PENDING);
});

test('phase2 (Điểm danh): NV trong log chưa quét → update timeScan/PRESENT', () => {
  const task = { taskId: 'R1', status: CFG.TASK_STATUS.ATTEND };
  const row = makeRow({ listedAt: new Date('2026-08-02T07:30:00'), listedAtEpoch: 1783081800000 });
  const res = ScanLogic.classifyScan(CFG, task, [row], 'OPS000001');
  assert.equal(res.action, 'update');
  assert.equal(res.phase, 'attend');
  assert.equal(res.field, 'scannedAt');
  assert.equal(res.status, CFG.STATUS.PRESENT);
});

test('phase2: NV đã quét → reject already-scanned', () => {
  const task = { taskId: 'R1', status: CFG.TASK_STATUS.ATTEND };
  const row = makeRow({ scannedAt: new Date('2026-08-02T08:00:00'), scannedAtEpoch: 1783083600000 });
  const res = ScanLogic.classifyScan(CFG, task, [row], 'OPS000001');
  assert.equal(res.action, 'reject');
  assert.equal(res.reason, 'already-scanned');
});

test('phase2: NV không trong log → append EXTRA + field timeScan', () => {
  const task = { taskId: 'R1', status: CFG.TASK_STATUS.ATTEND };
  const res = ScanLogic.classifyScan(CFG, task, [], 'OPS000999');
  assert.equal(res.action, 'append');
  assert.equal(res.phase, 'attend');
  assert.equal(res.field, 'scannedAt');
  assert.equal(res.status, CFG.STATUS.EXTRA);
});

test('computeCounters: có LISTED_AT nhưng chưa quét → Vắng (không phải Có mặt)', () => {
  const rows = [
    makeRow({ staffId: 'OPS1', listedAtEpoch: 1700000000000, scannedAtEpoch: 0, status: CFG.STATUS.PENDING }),
    makeRow({ staffId: 'OPS2', listedAtEpoch: 1700000000001, scannedAtEpoch: 1700000000002, status: CFG.STATUS.PRESENT }),
    makeRow({ staffId: 'OPS3', listedAtEpoch: 0, scannedAtEpoch: 0, status: CFG.STATUS.PENDING }),
  ];
  const c = ScanLogic.computeCounters(CFG, rows);
  assert.equal(c.scanned, 1);   // OPS2: quét SCANNED_AT
  assert.equal(c.absent, 2);    // OPS1 (có mặt chưa quét) + OPS3 (chưa gì) → Vắng
  assert.equal(c.extra, 0);
  assert.equal(c.total, 3);
});



// ===== Nhánh "Quét tự do" (noList) — tạo task KHÔNG danh sách, quét 2 lần =====
test('noList: createTask không cần group → log rỗng, status Mở', () => {
  // Giả lập các dependency bằng stub nhẹ (TaskService dùng global GAS API).
  // Vì TaskService require GAS, test này chỉ kiểm tra classifyScan behaviour cho
  // task rỗng: task Mở + log rỗng → lần 1 append PENDING(timeRef), lần 2 append EXTRA(timeScan).
  const taskOpen = { taskId: 'R-NL', status: CFG.TASK_STATUS.OPEN };
  const r1 = ScanLogic.classifyScan(CFG, taskOpen, [], 'OPS000777');
  assert.equal(r1.action, 'append');
  assert.equal(r1.phase, 'present');
  assert.equal(r1.field, 'listedAt');
  assert.equal(r1.status, CFG.STATUS.PENDING);

  const taskAttend = { taskId: 'R-NL', status: CFG.TASK_STATUS.ATTEND };
  const r2 = ScanLogic.classifyScan(CFG, taskAttend, [], 'OPS000777');
  assert.equal(r2.action, 'append');
  assert.equal(r2.phase, 'attend');
  assert.equal(r2.field, 'scannedAt');
  assert.equal(r2.status, CFG.STATUS.EXTRA);
});

test('noList/RECONCILE: NV Dư (EXTRA) quét phase2 GIỮ Dư — KHÔNG đổi thành Có mặt', () => {
  // Mô phỏng: NV lạ quét phase1 = Dư (EXTRA, có timeRef). Phase2 quét lại →
  // vẫn là Dư (EXTRA), KHÔNG đổi thành PRESENT. Chỉ NV trong danh sách (PENDING)
  // quét phase2 mới = Có mặt. (Fix 2026-08-06: trước đây Dư phase2 bị ghi nhầm Có mặt)
  const row = makeRow({ staffId: 'OPS000777', listedAt: new Date('2026-08-02T07:00:00'), listedAtEpoch: 1783078800000, status: CFG.STATUS.EXTRA });
  const taskAttend = { taskId: 'R-NL', status: CFG.TASK_STATUS.ATTEND };
  const res = ScanLogic.classifyScan(CFG, taskAttend, [row], 'OPS000777');
  assert.equal(res.action, 'update');
  assert.equal(res.field, 'scannedAt');
  assert.equal(res.status, CFG.STATUS.EXTRA);
});

// ===== Fix #3: noList QUÉT ĐẦU (phase1) phải ghi PENDING (Chưa điểm danh), KHÔNG Dư =====


test('noList (FREE) phase1 quét đầu: append PENDING — KHÔNG Dư', () => {
  // KHÔNG có danh sách → NV lạ hợp lệ, quét đầu
  // (phase1) ghi LISTED_AT + PENDING (Chưa điểm danh), KHÔNG phải Dư.
  const task = { taskId: 'R-NL', status: CFG.TASK_STATUS.OPEN };
  const cls = ScanLogic.classifyScan(CFG, task, [], 'OPS000999');
  assert.equal(cls.action, 'append');
  assert.equal(cls.field, 'listedAt');
  assert.equal(cls.status, CFG.STATUS.PENDING);
});

test('noList (FREE) phase2 quét NV lạ → append EXTRA — Dư', () => {
  // Quét tự do phase2 (Điểm danh), NV lạ → append SCANNED_AT + PRESENT.
  const task = { taskId: 'R-NL', status: CFG.TASK_STATUS.ATTEND };
  const cls = ScanLogic.classifyScan(CFG, task, [], 'OPS000999');
  assert.equal(cls.action, 'append');
  assert.equal(cls.field, 'scannedAt');
  // FREE phase2: NV chưa trong danh sách phase1 → Dư (EXTRA), không còn PRESENT.
  assert.equal(cls.status, CFG.STATUS.EXTRA);
});

test('NV lạ trong log rổng → PENDING phase1', () => {
  const task = { taskId: 'R1', status: CFG.TASK_STATUS.OPEN };
  const cls = ScanLogic.classifyScan(CFG, task, [], 'OPS000999');
  assert.equal(cls.action, 'append');
  assert.equal(cls.status, CFG.STATUS.PENDING);
});

