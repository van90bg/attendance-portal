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
  OPS999999: { staffName: 'NV Lạ', slotCode: '13:00-22:00', station: 'HN2 SOC', team: 'Inbound', workstation: 'IB', date: '2026-08-02' },
};

function makeCtx(overrides) {
  const ctx = {
    console,
    Date,
    Math,
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Session: { getActiveUser: () => ({ getEmail: () => 'web' }) },
    // ScanService giờ dùng getActiveEmail_ (Auth.gs) — mock 1 nguồn tại đây
    getActiveEmail_: () => 'web',
    STATUS: { PENDING: '-', PRESENT: 'Có mặt', ABSENT: 'Vắng', EXTRA: 'Dư' },
    TASK_STATUS: { OPEN: 'open', ATTEND: 'attend', DONE: 'done' },
    UI_LABELS: { TASK_CLOSED: 'Task đã kết thúc', ALREADY_SCANNED: 'Đã điểm danh', STAFF_NOT_FOUND: 'Không tìm thấy nhân viên', SCAN_OPEN_OWNER_ONLY: 'Chỉ owner mới quét được ở phase Mở (task này)' },
    // helpers (default no-op — ghi đè tuỳ test)
    normalizeStaffId: (s) => (s || '').trim().toUpperCase(),
    isValidBarcodeId: (s) => /^OPS\d+$/i.test(s || ''),
    formatTime_: () => '00:00:00',
    readTask_: () => overrides.readTask_ ? overrides.readTask_() : null,
    // m3: scanStaff giờ đọc task QUA cache — mock delegate về readTask_ (hành vi tương đương).
    // Test có thể override riêng readTaskCached_ để khóa đường dùng cache.
    readTaskCached_: () => overrides.readTaskCached_ ? overrides.readTaskCached_() : (overrides.readTask_ ? overrides.readTask_() : null),
    readLogRowsCached_: () => overrides.logRows || [],
    batchUpdateLogRows_: () => 0,
    batchAppendLogRows_: () => ({ startRow: 0, count: 0, rowIndices: [] }),
    readStaffIndex_: () => STAFF_INDEX,
    computeCounters: () => ({ scanned: 0, absent: 0, extra: 0, total: 0 }),
    isEditor_: () => false,
    // M2: scanStaff giờ tự gate requireRole_('operator') — loader này không load Auth.gs
    // nên stub (user 'web' = operator mặc định → qua gate, giữ focus test logic quét).
    requireRole_: () => true,
    audit_: () => {},  // AuditRepo không load trong harness này
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

function freshTask(status) {
  return { taskId: 'R1', status: status };
}

test('scanStaff: NV lạ phase1 — KHÔNG ReferenceError, trả ok + tên NV', () => {
  const ctx = makeCtx({ readTask_: () => freshTask('open'), logRows: [] });
  const svc = loadScanService(ctx);
  const res = svc.scanStaff('R1', 'ops999999');
  assert.equal(res.ok, true, 'phải ok (không crash extraRow) — message=' + res.message);
  assert.equal(res.status, ctx.STATUS.PENDING, 'NV lạ phase1 = PENDING (khong con Dư)');
  assert.equal(res.staffName, 'NV Lạ', 'phải trả tên NV từ staffIndex');
});

test('scanStaff: quét tự do (FREE) phase1 — KHÔNG ghi Dư, trả PENDING', () => {
  const ctx = makeCtx({ readTask_: () => freshTask('open'), logRows: [] });
  const svc = loadScanService(ctx);
  const res = svc.scanStaff('R1', 'ops999999');
  assert.equal(res.ok, true);
  assert.equal(res.status, ctx.STATUS.PENDING, 'free quét đầu = Chưa điểm danh, KHÔNG Dư');
  assert.equal(res.message, ctx.STATUS.PENDING, 'toast message không được là "Dư"');
});

test('scanStaff: ĐỌC task QUA readTaskCached_', () => {
  const ctx = makeCtx({
    // Nếu scanStaff quay lại đọc thẳng readTask_ là TEST THẤT BẠI (đập cache tiết kiệm)
    readTask_: () => { throw new Error('readTask_ trực tiếp bị gọi — scanStaff phải đi qua cache'); },
    readTaskCached_: () => freshTask('open'),
    logRows: [],
  });
  const svc = loadScanService(ctx);
  const res = svc.scanStaff('R1', 'ops999999');
  assert.equal(res.ok, true, 'phải ok qua cache — ' + res.message);
  assert.equal(res.status, ctx.STATUS.PENDING, 'NV lạ phase1 = PENDING (vẫn đi qua cache)');
});

test('scanStaff: quét tự do (FREE) phase2 — NV lạ ngoài danh sách phase1 → Dư / EXTRA', () => {
  const ctx = makeCtx({ readTask_: () => freshTask('attend'), logRows: [] });
  const svc = loadScanService(ctx);
  const res = svc.scanStaff('R1', 'ops999999');
  assert.equal(res.ok, true);
  // FREE phase2: NV chưa trong danh sách phase1 → Dư (EXTRA) — ghi Giờ quét, đếm Dư.
  assert.equal(res.status, ctx.STATUS.EXTRA, 'free phase2 NV lạ = Dư');
  assert.equal(res.message, ctx.STATUS.EXTRA, 'toast hiện "Dư"');
});

test('scanStaff: mã "Ops" + chữ cái (OpsABC) → reject format', () => {
  const ctx = makeCtx({ readTask_: () => freshTask('open'), logRows: [] });
  const svc = loadScanService(ctx);
  const res = svc.scanStaff('R1', 'OpsABC');
  assert.equal(res.ok, false, ' không được là Ops + chữ');
  assert.equal(res.message, 'Mã phải bắt đầu bằng "Ops"');
});

test('scanStaff: mã "Ops" không có số (Ops) → reject format', () => {
  const ctx = makeCtx({ readTask_: () => freshTask('open'), logRows: [] });
  const svc = loadScanService(ctx);
  const res = svc.scanStaff('R1', 'Ops');
  assert.equal(res.ok, false, 'Ops không có số phải bị từ chối');
});

test('scanStaff: mã hỗn hợp số + chữ (Ops12a3) → reject format', () => {
  const ctx = makeCtx({ readTask_: () => freshTask('open'), logRows: [] });
  const svc = loadScanService(ctx);
  const res = svc.scanStaff('R1', 'Ops12a3');
  assert.equal(res.ok, false, 'Ops12a3 phải bị từ chối (có chữ a)');
});

// WYSIWYG (2026-08-18): client gửi epoch chụp lúc quét → server ghi ĐÚNG giờ hiển thị trên
// app, không đè bằng giờ xử lý (queue 2.5s/item + đồng hồ thiết bị lệch → nhảy giờ sau ~1s).
test('scanStaff: clientEpoch → timeRefEpoch = giờ client (không phải giờ server)', () => {
  const clientNow = new Date(Date.now() - 3000);  // 3s ago — within 15min clamp
  const ctx = makeCtx({ readTask_: () => freshTask('open'), logRows: [] });
  const svc = loadScanService(ctx);
  const res = svc.scanStaff('R1', 'ops999999', clientNow.getTime());
  assert.equal(res.ok, true, res.message);
  assert.equal(res.phase, 'present');
  assert.equal(res.field, 'timeRef');
  assert.equal(res.timeRefEpoch, clientNow.getTime(), 'epoch = giờ client chụp lúc quét');
  assert.equal(res.timeRefText, '00:00:00');  // formatTime_ stub — epoch mới là nguồn sự thật
  assert.equal(res.dateText, '2026-08-02', 'dateText từ staffIndex → cột Ngày hiện ngay');
});

test('scanStaff: clientEpoch thiếu/rác → fallback giờ server (không crash, không dùng 0)', () => {
  const ctx = makeCtx({ readTask_: () => freshTask('open'), logRows: [] });
  const svc = loadScanService(ctx);
  const before = Date.now();
  const res = svc.scanStaff('R1', 'ops999999');  // không gửi clientEpoch
  assert.equal(res.ok, true, res.message);
  assert.ok(res.timeRefEpoch >= before && res.timeRefEpoch > 0, 'fallback = giờ server hiện tại');
});
