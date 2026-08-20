/**
 * tests/create-free.test.js — commit 2026-08-08: slotCode 'Tự do' → task FREE.
 * Pure: isFreeSlotSelection_ (CsvUtil) 3 case.
 * VM   : createReconcileTask với CsvUtil thật + fake GAS (LockService/Session/IO).
 *        Case task rỗng → status OPEN, log=0 (FREE)
 *        Case ca thật (A3) → status OPEN, pre-fill roster NGAY lúc tạo
 *        Case dán mã (codes) → pre-fill NV có trong dữ liệu, mã lạ bỏ qua
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
    TASK_STATUS: { OPEN: 'open', ATTEND: 'attend', DONE: 'done' },
    UI_LABELS: { CREATE_FAILED_EMPTY: 'Không có nhân viên nào trong tổ hợp đã chọn' },
    readStaffList_: () => STAFF.slice(),
    readTask_: () => null,               // tránh vòng suffix makeTaskId_
    insertTask_: (t) => { inserted.push(t); },
    batchInsertLogRows_: (taskId, rows) => rows.length,  // không thực ghi sheet
    readStaffIndex_: () => ({ OPS001: STAFF[0], OPS002: STAFF[1] }),  // dán mã (A3)
  };
  const sandbox = vm.createContext(ctx);
  ['CsvUtil.gs', 'TaskService.gs'].forEach((f) => {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f });
  });
  return { ctx, inserted };
}

test('vm: task rỗng (không station + không codes) → FREE task, OPEN, log=0', () => {
  const { ctx, inserted } = makeCtx();
  const res = ctx.createReconcileTask({});
  assert.equal(res.ok, true, res.message);
  assert.equal(inserted[0].status, 'open', 'task mở phase1');
  assert.equal(inserted[0].slotCode, 'Tự do', 'Ca lưu = Tự do');
  assert.equal(res.count, 0, 'KHÔNG pre-fill');
});

test('VM: station + ca thật → pre-fill roster NGAY lúc tạo (A3), ca lưu ca thật', () => {
  const { ctx, inserted } = makeCtx();
  const res = ctx.createReconcileTask({ station: 'HN2', slotCode: ['08:00-17:00'], team: ['Inbound'] });
  assert.equal(res.ok, true, res.message);
  assert.equal(inserted[0].status, 'open', 'task mở phase1');
  assert.equal(inserted[0].slotCode, '08:00-17:00', 'A3: ca lưu = ca chọn');
  assert.equal(res.count, 1, 'A3: pre-fill 1 NV (OPS001)');
});

test('VM: dán mã (codes) → pre-fill NV có trong dữ liệu, mã lạ bỏ qua', () => {
  const { ctx, inserted } = makeCtx();
  const res = ctx.createReconcileTask({ codes: ['OPS001', 'OPS999', 'ops002'] });
  assert.equal(res.ok, true, res.message);
  assert.equal(res.count, 2, 'OPS001 + OPS002 (không phân biệt hoa thường)');
  assert.equal(res.skippedCodes, 1, 'OPS999 không có trong dữ liệu');
  assert.equal(inserted[0].station, '', 'dán mã → station rỗng');
  assert.equal(inserted[0].slotCode, 'Tự do', 'dán mã → FREE');
});

test('VM: station rỗng → task tạo được, station rỗng (task rỗng)', () => {
  const { ctx, inserted } = makeCtx();
  const res = ctx.createReconcileTask({});
  assert.equal(res.ok, true, res.message);
  assert.equal(inserted[0].station, '', 'station rỗng — quét tự do');
  assert.equal(res.count, 0, 'log rỗng');
});
