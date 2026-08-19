/**
 * tests/paste-batch.test.js — Node thuần. Test planBatchScans (ScanLogic.gs) và related.
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
    taskId: 'R20260802-0730',
    staffId: 'OPS000001',
    staffName: 'NhanVien Mau 001',
    slotCode: '08:00-17:00',
    station: 'HN2 SOC',
    team: 'Outbound',
    workstation: 'OBLoading',
    listedAt: new Date('2026-08-02T07:30:00'),
    scannedAt: null,
    listedAtEpoch: 1783081800000,
    scannedAtEpoch: 0,
    status: CFG.STATUS.PENDING,
  }, overrides || {});
}

test('planBatchScans: 3 mã hợp lệ phase OPEN/FREE → 3 append PENDING', () => {
  const task = { taskId: 'R1', status: CFG.TASK_STATUS.OPEN };
  const logRows = [];
  const codes = ['Ops000001', 'Ops000002', 'Ops000003'];
  const res = ScanLogic.planBatchScans(CFG, task, logRows, codes);
  assert.equal(res.plans.length, 3);
  assert.equal(res.invalid.length, 0);
  res.plans.forEach((p, i) => {
    assert.equal(p.action, 'append');
    assert.equal(p.phase, 'present');
    assert.equal(p.field, 'listedAt');
    assert.equal(p.status, CFG.STATUS.PENDING);
    assert.equal(p.code, codes[i]);
  });
});

test('planBatchScans: mã lặp trong cùng paste → lần 2 reject already-present', () => {
  const task = { taskId: 'R1', status: CFG.TASK_STATUS.OPEN };
  const logRows = [];
  const codes = ['Ops000001', 'Ops000001', 'Ops000002'];
  const res = ScanLogic.planBatchScans(CFG, task, logRows, codes);
  assert.equal(res.plans.length, 3);
  assert.equal(res.plans[0].action, 'append');
  assert.equal(res.plans[0].status, CFG.STATUS.PENDING);
  assert.equal(res.plans[1].action, 'reject');
  assert.equal(res.plans[1].reason, 'already-present');
  assert.equal(res.plans[2].action, 'append');
  assert.equal(res.plans[2].status, CFG.STATUS.PENDING);
});

test('planBatchScans: mã sai prefix → invalid-format không dừng batch', () => {
  const task = { taskId: 'R1', status: CFG.TASK_STATUS.OPEN };
  const logRows = [];
  const codes = ['Ops000001', 'NV000002', 'Ops000003'];
  const res = ScanLogic.planBatchScans(CFG, task, logRows, codes);
  assert.equal(res.plans.length, 2); // chỉ 2 mã hợp lệ OPS
  assert.equal(res.invalid.length, 1);
  assert.equal(res.invalid[0].code, 'NV000002');
  assert.equal(res.invalid[0].reason, 'invalid-format');
});

test('planBatchScans: Ops + chữ (OpsABC) → invalid-format (phải là Ops + số)', () => {
  const task = { taskId: 'R1', status: CFG.TASK_STATUS.OPEN };
  const res = ScanLogic.planBatchScans(CFG, task, [], ['OpsABC']);
  assert.equal(res.plans.length, 0); // không có mã hợp lệ nào
  assert.equal(res.invalid.length, 1);
  assert.equal(res.invalid[0].code, 'OpsABC');
  assert.equal(res.invalid[0].reason, 'invalid-format');
});

test('planBatchScans: Ops không có số (Ops) → invalid-format', () => {
  const task = { taskId: 'R1', status: CFG.TASK_STATUS.OPEN };
  const res = ScanLogic.planBatchScans(CFG, task, [], ['Ops']);
  assert.equal(res.plans.length, 0);
  assert.equal(res.invalid.length, 1);
  assert.equal(res.invalid[0].reason, 'invalid-format');
});

test('planBatchScans: Ops12a3 (số + chữ hỗn hợp) → invalid-format', () => {
  const task = { taskId: 'R1', status: CFG.TASK_STATUS.OPEN };
  const res = ScanLogic.planBatchScans(CFG, task, [], ['Ops12a3']);
  assert.equal(res.plans.length, 0);
  assert.equal(res.invalid.length, 1);
  assert.equal(res.invalid[0].code, 'Ops12a3');
  assert.equal(res.invalid[0].reason, 'invalid-format');
});

test('planBatchScans: task FREE + OPEN vs ATTEND → đúng nhánh (ATTEND chặn ở service, pure chỉ classify)', () => {
  // Phase OPEN (present) → field timeRef
  const taskOpen = { taskId: 'R1', status: CFG.TASK_STATUS.OPEN };
  const resOpen = ScanLogic.planBatchScans(CFG, taskOpen, [], ['Ops000001']);
  assert.equal(resOpen.plans[0].phase, 'present');
  assert.equal(resOpen.plans[0].field, 'listedAt');

  // Phase ATTEND (attend) → field timeScan
  const taskAttend = { taskId: 'R1', status: CFG.TASK_STATUS.ATTEND };
  const resAttend = ScanLogic.planBatchScans(CFG, taskAttend, [], ['Ops000001']);
  assert.equal(resAttend.plans[0].phase, 'attend');
  assert.equal(resAttend.plans[0].field, 'scannedAt');
  // FREE phase2: NV lạ → EXTRA (Dư)
  assert.equal(resAttend.plans[0].status, CFG.STATUS.EXTRA);
});

test('planBatchScans: mã trùng khi row ĐÃ tồn tại (listedAtEpoch=0) → update rồi reject (m4)', () => {
  const task = { taskId: 'R1', status: CFG.TASK_STATUS.OPEN };
  // Row tồn tại nhưng chưa có timeRef (phase OPEN, chưa quét) → mã đầu = update
  const logRows = [makeRow({ staffId: 'OPS000001', listedAt: null, listedAtEpoch: 0 })];
  const originalRefEpoch = logRows[0].listedAtEpoch;
  const codes = ['Ops000001', 'Ops000001'];
  const res = ScanLogic.planBatchScans(CFG, task, logRows, codes);
  assert.equal(res.plans.length, 2);
  assert.equal(res.plans[0].action, 'update');          // lần 1: cập nhật timeRef
  assert.equal(res.plans[1].action, 'reject');       // lần 2: đã có mặt trong batch
  assert.equal(res.plans[1].reason, 'already-present');
  // Fix 2: pure — logRows gốc không bị mutate dù plan.simulate update
  assert.equal(logRows[0].listedAtEpoch, originalRefEpoch);
  // Test ATTEND + row đã quét scan → update timeScan rồi duplicate reject
  const taskAttend = { taskId: 'T2', status: CFG.TASK_STATUS.ATTEND };
  const logRows2 = [makeRow({ staffId: 'OPS000002', scannedAt: null, scannedAtEpoch: 0 })];
  const res2 = ScanLogic.planBatchScans(CFG, taskAttend, logRows2, ['Ops000002', 'Ops000002']);
  assert.equal(res2.plans[0].action, 'update');
  assert.equal(res2.plans[1].action, 'reject');
  assert.equal(res2.plans[1].reason, 'already-scanned');
});

test('planBatchScans: không đổi logRows gốc (thuần)', () => {
  const task = { taskId: 'R1', status: CFG.TASK_STATUS.OPEN };
  const logRows = [makeRow({ staffId: 'OPS000001' })];
  const originalLength = logRows.length;
  ScanLogic.planBatchScans(CFG, task, logRows, ['Ops000002', 'Ops000003']);
  assert.equal(logRows.length, originalLength); // logRows không bị mutate
});

test('canScanOpen_: admin bypass', () => {
  assert.equal(ScanLogic.canScanOpen_(CFG, 'owner@test.com', 'other@test.com', true), true);
});

test('canScanOpen_: owner đúng/case-insensitive', () => {
  assert.equal(ScanLogic.canScanOpen_(CFG, 'Owner@test.com', 'owner@test.com', false), true);
  assert.equal(ScanLogic.canScanOpen_(CFG, 'owner@test.com', 'OWNER@TEST.COM', false), true);
});

test('canScanOpen_: non-owner chặn', () => {
  assert.equal(ScanLogic.canScanOpen_(CFG, 'owner@test.com', 'other@test.com', false), false);
});

test('canScanOpen_: createdBy=web → cho phép (A1)', () => {
  assert.equal(ScanLogic.canScanOpen_(CFG, 'web', 'any@test.com', false), true);
  assert.equal(ScanLogic.canScanOpen_(CFG, '', 'any@test.com', false), true);
  assert.equal(ScanLogic.canScanOpen_(CFG, 'not-an-email', 'any@test.com', false), true);
});

test('canMutateTask_: fail-closed — admin bypass, owner đúng, non-owner chặn, legacy web chặn (B-P1-4)', () => {
  assert.equal(ScanLogic.canMutateTask_('owner@test.com', 'other@test.com', true), true);   // admin bypass
  assert.equal(ScanLogic.canMutateTask_('owner@test.com', 'owner@test.com', false), true);  // owner đúng
  assert.equal(ScanLogic.canMutateTask_('Owner@test.com', 'owner@test.com', false), true);  // case-insensitive
  assert.equal(ScanLogic.canMutateTask_('owner@test.com', 'other@test.com', false), false); // non-owner chặn
  assert.equal(ScanLogic.canMutateTask_('web', 'any@test.com', false), false);              // legacy web → CHẶN (khác canScanOpen_)
  assert.equal(ScanLogic.canMutateTask_('', 'any@test.com', false), false);                 // rỗng → chặn
  assert.equal(ScanLogic.canMutateTask_('not-an-email', 'any@test.com', false), false);     // không @ → chặn
});

test('canScanOpen_: task không OPEN → cho phép (gate chỉ phase OPEN)', () => {
  // canScanOpen_ không check task status — caller phải check trước
  // Nhưng function vẫn trả true khi isAdmin=true hoặc owner match
  assert.equal(ScanLogic.canScanOpen_(CFG, 'owner@test.com', 'owner@test.com', false), true);
});