/**
 * tests/scanservice.test.js — Integration test cho ScanService.scanStaff (GAS wrapper).
 *
 * Mock các hàm GAS phụ thuộc (Database/Config helpers), load thật ScanService.gs
 * + ScanLogic.gs để chạy end-to-end path quét Dư / quét tự do.
 * Chặn tái phạm:
 *  - Lỗi 1: ReferenceError "extraRow is not defined" tại return (extraRow hoist scope hàm)
 *  - Lỗi 2: quét tự do (FREE) bị hardcode EXTRA → message "Dư" sai
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ---- Fake GAS globals ----
const STAFF_INDEX = {
  OPS999999: { staffName: 'NV Lạ', slotCode: '13:00-22:00', station: 'HN2 SOC', team: 'Inbound', workstation: 'IB' },
};

function makeCtx(overrides) {
  const ctx = {
    console,
    Date,
    Math,
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Session: { getActiveUser: () => ({ getEmail: () => 'web' }) },
    STATUS: { PENDING: '-', PRESENT: 'Có mặt', ABSENT: 'Vắng', EXTRA: 'Dư' },
    TASK_STATUS: { OPEN: 'open', ATTEND: 'attend', DONE: 'done' },
    TASK_TYPE: { RECONCILE: 'reconcile', FREE: 'free' },
    UI_LABELS: { TASK_CLOSED: 'Task đã kết thúc', ALREADY_SCANNED: 'Đã điểm danh', STAFF_NOT_FOUND: 'Không tìm thấy nhân viên', SCAN_OPEN_OWNER_ONLY: 'Chỉ owner mới quét được ở phase Mở (task này)' },
    // helpers (default no-op — ghi đè tuỳ test)
    normalizeStaffId: (s) => (s || '').trim().toUpperCase(),
    isValidBarcodeId: (s) => /^OPS\d+$/i.test(s || ''),
    formatTime_: () => '00:00:00',
    readTask_: () => overrides.readTask_ ? overrides.readTask_() : null,
    readLogRowsCached_: () => overrides.logRows || [],
    appendLogRow_: () => {},
    updateLogRowScan_: () => {},
    updateLogRowRef_: () => {},
    findLogRow: (rows, id) => {
      const n = String(id).trim().toUpperCase();
      return (rows || []).find((r) => String(r.staffId || '').trim().toUpperCase() === n) || null;
    },
    readStaffIndex_: () => STAFF_INDEX,
    computeCounters: () => ({ scanned: 0, absent: 0, extra: 0, total: 0 }),
    isEditor_: () => false,
    canScanOpen_: (cfg, createdBy, activeEmail, isAdmin) => {
      if (isAdmin) return true;
      const cb = String(createdBy || '').trim().toLowerCase();
      const ae = String(activeEmail || '').trim().toLowerCase();
      const isValidEmail = cb.includes('@') && cb !== 'web' && cb !== '';
      if (!isValidEmail) return true;
      return ae === cb;
    },
  };
  return ctx;
}

function loadScanService(ctx) {
  const files = ['ScanLogic.gs', 'ScanService.gs'];
  const sandbox = vm.createContext(ctx);
  files.forEach((f) => {
    const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    vm.runInContext(code, sandbox, { filename: f });
  });
  return sandbox;
}

function freshTask(taskType, status) {
  return { taskId: 'R1', taskType: taskType, status: status };
}

test('scanStaff: quét Dư (RECONCILE NV lạ) — KHÔNG ReferenceError, trả ok + tên NV', () => {
  const ctx = makeCtx({ readTask_: () => freshTask('reconcile', 'open'), logRows: [] });
  const svc = loadScanService(ctx);
  const res = svc.scanStaff('R1', 'ops999999');
  assert.equal(res.ok, true, 'phải ok (không crash extraRow) — message=' + res.message);
  assert.equal(res.status, ctx.STATUS.EXTRA, 'roster lạ = Dư');
  assert.equal(res.staffName, 'NV Lạ', 'phải trả tên NV từ staffIndex');
});

test('scanStaff: quét tự do (FREE) phase1 — KHÔNG ghi Dư, trả PENDING', () => {
  const ctx = makeCtx({ readTask_: () => freshTask('free', 'open'), logRows: [] });
  const svc = loadScanService(ctx);
  const res = svc.scanStaff('R1', 'ops999999');
  assert.equal(res.ok, true);
  assert.equal(res.status, ctx.STATUS.PENDING, 'free quét đầu = Chưa điểm danh, KHÔNG Dư');
  assert.equal(res.message, ctx.STATUS.PENDING, 'toast message không được là "Dư"');
});

test('scanStaff: quét tự do (FREE) phase2 — NV lạ ngoài danh sách phase1 → Dư / EXTRA', () => {
  const ctx = makeCtx({ readTask_: () => freshTask('free', 'attend'), logRows: [] });
  const svc = loadScanService(ctx);
  const res = svc.scanStaff('R1', 'ops999999');
  assert.equal(res.ok, true);
  // FREE phase2: NV chưa trong danh sách phase1 → Dư (EXTRA) — ghi Giờ quét, đếm Dư.
  assert.equal(res.status, ctx.STATUS.EXTRA, 'free phase2 NV lạ = Dư');
  assert.equal(res.message, ctx.STATUS.EXTRA, 'toast hiện "Dư"');
});

test('scanStaff: mã "Ops" + chữ cái (OpsABC) → reject format', () => {
  const ctx = makeCtx({ readTask_: () => freshTask('free', 'open'), logRows: [] });
  const svc = loadScanService(ctx);
  const res = svc.scanStaff('R1', 'OpsABC');
  assert.equal(res.ok, false, ' không được là Ops + chữ');
  assert.equal(res.message, 'Mã phải bắt đầu bằng "Ops"');
});

test('scanStaff: mã "Ops" không có số (Ops) → reject format', () => {
  const ctx = makeCtx({ readTask_: () => freshTask('free', 'open'), logRows: [] });
  const svc = loadScanService(ctx);
  const res = svc.scanStaff('R1', 'Ops');
  assert.equal(res.ok, false, 'Ops không có số phải bị từ chối');
});

test('scanStaff: mã hỗn hợp số + chữ (Ops12a3) → reject format', () => {
  const ctx = makeCtx({ readTask_: () => freshTask('free', 'open'), logRows: [] });
  const svc = loadScanService(ctx);
  const res = svc.scanStaff('R1', 'Ops12a3');
  assert.equal(res.ok, false, 'Ops12a3 phải bị từ chối (có chữ a)');
});
