/**
 * tests/create-free.test.js — commit 2026-08-08: slotCode 'Tự do' → task FREE.
 * Pure: isFreeSlotSelection_ (CsvUtil) 3 case.
 * VM   : createReconcileTask với CsvUtil thật + fake GAS (LockService/Session/IO).
 *        Case FREE  → taskType FREE, status OPEN, log=0 (KHÔNG pre-fill)
 *        Case RECONCILE → taskType RECONCILE, status ATTEND, log pre-fill >0
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const STAFF = [
  { staffId: 'OPS001', station: 'HN2', slotCode: '08:00-17:00', team: 'Inbound', contractType: 'Chính thức', date: '2026-08-02' },
  { staffId: 'OPS002', station: 'HN2', slotCode: '17:00-01:00', team: 'QA', contractType: 'Thời vụ', date: '2026-08-02' },
];

function loadPure() {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'CsvUtil.gs'), 'utf8'), ctx, { filename: 'CsvUtil.gs' });
  return ctx;
}

test('pure: isFreeSlotSelection_(["Tự do"]) → true', () => {
  assert.equal(loadPure().isFreeSlotSelection_(['Tự do']), true);
});
test('pure: isFreeSlotSelection_(["08:00-17:00"]) → false', () => {
  assert.equal(loadPure().isFreeSlotSelection_(['08:00-17:00']), false);
});
test('pure: isFreeSlotSelection_(["Tự do","08:00-17:00"]) → false (fail-safe)', () => {
  assert.equal(loadPure().isFreeSlotSelection_(['Tự do', '08:00-17:00']), false);
});
test('pure: isFreeSlotSelection_("Tự do") string → true (tương thích cũ)', () => {
  assert.equal(loadPure().isFreeSlotSelection_('Tự do'), true);
});

function makeCtx() {
  const inserted = [];
  const ctx = {
    console,
    Date,
    Math,
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Session: { getActiveUser: () => ({ getEmail: () => 'web' }) },
    getActiveEmail_: () => 'web', // TaskService giờ dùng Auth.getActiveEmail_ (không load Auth.gs ở đây)
    requireRole_: () => true,      // M1 gate (review 2026-08-11): stub — role logic đã test riêng (role-service.test.js)
    audit_: () => {},                // AuditRepo không load trong harness này
    TASK_TYPE: { RECONCILE: 'reconcile', FREE: 'free' },
    TASK_STATUS: { OPEN: 'open', ATTEND: 'attend', DONE: 'done' },
    UI_LABELS: { CREATE_FAILED_EMPTY: 'Không có nhân viên nào trong tổ hợp đã chọn' },
    readStaffList_: () => STAFF.slice(),
    readTask_: () => null,               // tránh vòng suffix makeTaskId_
    insertTask_: (t) => { inserted.push(t); },
    batchInsertLogRows_: (taskId, rows) => rows.length,  // không thực ghi sheet
  };
  const sandbox = vm.createContext(ctx);
  ['CsvUtil.gs', 'TaskService.gs'].forEach((f) => {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f });
  });
  return { ctx, inserted };
}

test('vm: slotCode=["Tự do"] → FREE task, OPEN, log=0', () => {
  const { ctx, inserted } = makeCtx();
  const res = ctx.createReconcileTask({ station: 'HN2', slotCode: ['Tự do'], team: ['Inbound'] });
  assert.equal(res.ok, true, res.message);
  assert.equal(inserted[0].taskType, 'free', 'taskType phải FREE');
  assert.equal(inserted[0].status, 'open', 'FREE phải mở phase1');
  assert.equal(inserted[0].slotCode, 'Tự do', 'Ca lưu = Tự do');
  assert.equal(res.count, 0, 'KHÔNG pre-fill');
});

test('VM: slotCode=["08:00-17:00"] → RECONCILE task, ATTEND, log pre-fill>0', () => {
  const { ctx, inserted } = makeCtx();
  const res = ctx.createReconcileTask({ station: 'HN2', slotCode: ['08:00-17:00'], team: ['Inbound'] });
  assert.equal(res.ok, true, res.message);
  assert.equal(inserted[0].taskType, 'reconcile');
  assert.equal(inserted[0].status, 'attend', 'reconcile vào thẳng phase2');
  assert.equal(res.count, 1, 'pre-fill 1 NV (OPS001)');
});

test('VM: noList cũ (input.noList=true) vẫn tương thích', () => {
  const { ctx, inserted } = makeCtx();
  const res = ctx.createReconcileTask({ station: 'HN2', slotCode: ['08:00-17:00'], team: ['Inbound'], noList: true });
  assert.equal(res.ok, true, res.message);
  assert.equal(inserted[0].taskType, 'free', 'noList cũ vẫn FREE');
});
