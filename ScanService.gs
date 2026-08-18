/**
 * ScanService.gs — Nghiệp vụ quét (wrapper GAS quanh ScanLogic thuần).
 *
 * Quy trình: validate task open → lấy log + staffIndex → classifyScan →
 * update/append trên sheet (LockService) → tính counters → trả kết quả.
 */

/**
 * Xử lý 1 lần quét NV.
 * @param {string} taskId
 * @param {string} rawStaffId — mã từ barcode (chưa normalize)
 * @param {number|string} clientEpoch — epoch ms client chụp lúc quét (WYSIWYG: giờ hiển thị
 *   trên app = giờ ghi sheet); fallback giờ server nếu thiếu/rác (queue cũ, thiết bị lạ).
 * @returns {{ok: boolean, message: string, status: string|null, counters: Object}}
 */
function scanStaff(taskId, rawStaffId, clientEpoch) {
  // P2 benchmark (QA prod): đo latency thật từng giai đoạn → Stackdriver.
  // Queue quét 2.5s/item — cần số liệu thật trước khi tối ưu thêm.
  const t0 = Date.now();
  const staffId = normalizeStaffId(rawStaffId);
  if (!requireRole_('operator')) return { ok: false, message: 'Không đủ quyền (cần role operator trở lên)', status: null, counters: { scanned: 0, absent: 0, extra: 0, total: 0 } };  // M2: gate service-layer (bypass-proof)
  // Chỉ chấp nhận mã barcode NV bắt đầu "Ops" (case-insensitive).
  if (!isValidBarcodeId(staffId)) {
    console.log({ bench: 'scanStaff', taskId: taskId, staffId: staffId, phase: 'reject-format', ms: Date.now() - t0 });
    return {
      ok: false,
      message: 'Mã phải bắt đầu bằng "Ops"',
      status: null,
      counters: { scanned: 0, absent: 0, extra: 0, total: 0 },
    };
  }
  // DEFENSE: bọc toàn bộ logic trong try/catch — bất kỳ lỗi nào (kể cả
  // ReferenceError extraRow) trả ok:false thay vì ném ra → thiết bị hiện toast, KHÔNG "Server lỗi".
  try {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const t1 = Date.now();
    // m3 (audit): dùng task cache (TTL 60s, invalidate mọi write) — trước đây readTask_
    // getDataRange full AttendanceTask MỖI lượt quét. An toàn: complete/transition/reopen
    // vẫn readTask_ tươi + invalidate cache dưới cùng lock nên status không bao giờ stale.
    const task = readTaskCached_(taskId);
    // m1 (audit): null-check task — taskId không tồn tại → message sạch thay vì TypeError.
    if (!task) {
      console.log({ bench: 'scanStaff', taskId: taskId, staffId: staffId, phase: 'reject-no-task', ms: Date.now() - t0 });
      return { ok: false, message: 'Không tìm thấy task', status: null, counters: { scanned: 0, absent: 0, extra: 0, total: 0 } };
    }
    // T-1: Owner gate cho scan khi task ở phase OPEN
    // Chỉ áp dụng khi task.status === OPEN. Admin bypass, owner match, legacy 'web'/rỗng cho phép.
    const activeEmail = getActiveEmail_();
    const isAdmin = isEditor_();
    if (task.status === TASK_STATUS.OPEN) {
      const canScan = canScanOpen_({ TASK_STATUS: TASK_STATUS }, task.createdBy, activeEmail, isAdmin);
      if (!canScan) {
        console.log({ bench: 'scanStaff', taskId: taskId, staffId: staffId, phase: 'reject-owner-gate', ms: Date.now() - t0 });
        return {
          ok: false,
          message: UI_LABELS.SCAN_OPEN_OWNER_ONLY,
          status: null,
          counters: { scanned: 0, absent: 0, extra: 0, total: 0 },
        };
      }
    }
    // U2: dùng cache log rows (30s + incremental) — scan liên tiếp không getDataRange
    // full sheet log mỗi lần (v1 lesson: dynamic tail → v2 cache vì update-in-place).
    const logRows = readLogRowsCached_(taskId);
    const t2 = Date.now();
    // F1 (simplify): KHÔNG đọc staffIndex mỗi scan — chỉ cần ở nhánh append (NV lạ,
    // hiếm). 52KB JSON.parse + 1 full-read StaffData mỗi 5 phút là thừa với 99% scan.

    const result = classifyScan(
          { STATUS: STATUS, TASK_STATUS: TASK_STATUS },
          task,
          logRows,
          staffId
        );

    if (result.action === 'reject') {
      // F: lookup thay ternary 3 tầng — lý do reject → message (reason không có → STAFF_NOT_FOUND)
      const REJECT_MSG = {
        'task-closed': UI_LABELS.TASK_CLOSED,
        'already-scanned': UI_LABELS.ALREADY_SCANNED,
        'already-present': UI_LABELS.ALREADY_PRESENT,
      };
      // P2 benchmark: reject path KHÔNG log — quét trùng/task đóng chiếm phần lớn
      // lượt quét, log chúng sẽ drown các warn thật (cache fail) trong Stackdriver.
      return {
        ok: false,
        message: REJECT_MSG[result.reason] || UI_LABELS.STAFF_NOT_FOUND,
        status: null,
        counters: computeCounters({ STATUS: STATUS }, logRows),
      };
    }

    // B (2026-08-12): seam commit — mọi quyết định ghi (update/append/race/enrich) qua
    // planScanCommits (ScanLogic) — chung với pasteCodes, hết duplicate (architecture review B).
    const field = result.field;
    const needsAppend = result.action === 'append';
    // Re-check race: đọc lại cache sau lock (thiết bị khác có thể vừa ghi cùng staffId)
    const freshLogRows = needsAppend ? (readLogRowsCached_(taskId) || []) : logRows;
    let staffIndex = null;
    if (needsAppend) {
      // Đọc staffIndex CHỈ khi cần append (lazy). G: wrap try/catch — StaffData lỗi
      // vẫn ghi Dư (staffInfo=null) thay vì "Server lỗi".
      try { staffIndex = readStaffIndex_() || null; } catch (e) { console.warn('readStaffIndex fail', staffId, e.message); staffIndex = null; }
    }
    // scanNow = epoch client chụp lúc quét (WYSIWYG — user thấy giờ nào, sheet ghi giờ đó;
    // trước đây server ghi giờ XỬ LÝ, queue 2.5s/item + đồng hồ thiết bị lệch → sau ~1s
    // silent reload, cột Giờ có mặt/Giờ quét nhảy về giờ server). Fallback giờ server khi
    // client không gửi (thiết bị cũ / gọi tay) — chấp nhận epoch client vì gate operator+.
    const scanNow = (typeof clientEpoch === 'number' && isFinite(clientEpoch) && clientEpoch > 0)
      ? (Math.abs(clientEpoch - Date.now()) > 900000 ? new Date() : new Date(clientEpoch))
      : new Date();
    const commit = planScanCommits(
      { STATUS: STATUS, TASK_STATUS: TASK_STATUS },
      task,
      [{ code: staffId, action: result.action, field: result.field, status: result.status, row: result.row }],
      freshLogRows, staffIndex, scanNow, formatTime_
    );
    if (commit.updates.length) batchUpdateLogRows_(taskId, commit.updates);
    if (commit.appends.length) {
      const appendRes = batchAppendLogRows_(commit.appends);
      commit.appends.forEach(function (row, idx) {
        const o = commit.outcomes[String(row[1] || '').toUpperCase()];
        if (o) o.rowIndex = appendRes.rowIndices[idx] || 0;
      });
    }
    const outcome = commit.outcomes[String(staffId).toUpperCase()];
    const timeScanText = outcome ? outcome.timeScanText : '';
    const timeScanEpoch = outcome ? outcome.timeScanEpoch : 0;
    const timeRefText = outcome ? outcome.timeRefText : '';
    const timeRefEpoch = outcome ? outcome.timeRefEpoch : 0;
    const scannedName = outcome ? outcome.staffName : null;
    const counters = computeCounters({ STATUS: STATUS }, readLogRowsCached_(taskId));
    // P2 benchmark: tổng + tách giai đoạn — QA prod đọc Stackdriver biết ngay
    // bottleneck (read sheet vs write). Phân tích: t1→t2 = đọc task+log (full sheet),
    // t2→t3 = classify + write. Nếu read > 1.5s → cần index log (xem Database.gs).
    const t3 = Date.now();
    // Minor#6 (audit): log benchmark CHỈ khi bất thường (> ngưỡng) — trước đây log
    // mọi lượt thể hiện, ở nhịp quét ~1400 log/h/tab → tốn Stackdriver quota/chi phí.
    // Ngưỡng: total > 400ms (bất thường) HOẶC read/write > 300ms (bottleneck tiềm ẩn).
    const __dt = { totalMs: t3 - t0, readMs: t2 - t1, writeMs: t3 - t2 };
    if (__dt.totalMs > 400 || __dt.readMs > 300 || __dt.writeMs > 300) {
      console.log({ bench: 'scanStaff', taskId: taskId, staffId: staffId, action: result.action, totalMs: __dt.totalMs, readMs: __dt.readMs, writeMs: __dt.writeMs });
    }
    return {
      ok: true,
      message: outcome ? outcome.status : result.status,
      status: outcome ? outcome.status : result.status,
      phase: result.phase,
      field: field,
      timeScanText: timeScanText,
      timeScanEpoch: timeScanEpoch,
      timeRefText: timeRefText,
      timeRefEpoch: timeRefEpoch,
      staffName: scannedName,
      slotCode: outcome ? outcome.slotCode : '',
      station: outcome ? outcome.station : '',
      team: outcome ? outcome.team : '',
      workstation: outcome ? outcome.workstation : '',
      dateText: outcome ? (outcome.dateText || '') : '',  // cột Ngày hiện NGAY sau quét (không chờ reload)
      counters: counters,
    };
  } finally {
    lock.releaseLock();
  }
  } catch (e) {
    // DEFENSE: bất kỳ lỗi runtime → trả ok:false (toast) thay vì crash "Server lỗi".
    console.error({ bench: 'scanStaff', taskId: taskId, staffId: staffId, error: e && e.message, stack: e && e.stack });
    return { ok: false, message: 'Lỗi server: ' + (e && e.message ? e.message : 'unknown'), status: null, counters: { scanned: 0, absent: 0, extra: 0, total: 0 } };
  }
}

/**
 * T-2: Paste multiple codes in batch (dán danh sách mã).
 * Gate: FREE + OPEN + canScanOpen_ (owner/admin).
 * Uses 1 LockService + 1 readLogRowsCached_ + batch write.
 * @param {string} taskId
 * @param {Array<string>} rawLines — array of raw code lines from paste
 * @returns {{ok, total, success, failed, results:[{code, ok, status, message}], counters}}
 */
function pasteCodes(taskId, rawLines) {
  const t0 = Date.now();
  // Clamp at 200 lines (A4) — yêu cầu 2026-08-07: giới hạn 200 mã/lần dán.
  // m3 (audit): guard array — payload string (lỗi client/bug tương lai) → xử lý như rỗng.
  const lines = Array.isArray(rawLines) ? rawLines.slice(0, 200) : [];
  // M1 (review 2026-08-11): gate THẬT ở service layer (chống bypass google.script.run gọi global).
  // Operator vẫn dùng được (ROLES.DEFAULT='operator'); paste giữ owner-gate canScanOpen_ bên trong.
  if (!requireRole_('operator')) {
    return { ok: false, message: 'Không đủ quyền (cần role operator trở lên)', total: 0, success: 0, failed: 0, results: [], counters: null };
  }
  // DEFENSE: bọc toàn bộ logic — bất kỳ lỗi nào (kể cả ReferenceError) trả ok:false
  // thay vì ném ra → client hiện toast gọn, KHÔNG "Server lỗi" chung (pattern scanStaff).
  try {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const task = readTask_(taskId);
    if (!task) return { ok: false, message: 'Không tìm thấy task', total: 0, success: 0, failed: 0, results: [], counters: null };
    
    // Gate: FREE + OPEN + canScanOpen
    const activeEmail = getActiveEmail_();
    const isAdmin = isEditor_();
    
    if (task.status !== TASK_STATUS.OPEN) {
      return { ok: false, message: 'Chỉ phase Mở mới dán mã được', total: 0, success: 0, failed: 0, results: [], counters: null };
    }
    const canScan = canScanOpen_({ TASK_STATUS: TASK_STATUS }, task.createdBy, activeEmail, isAdmin);
    if (!canScan) {
      return { ok: false, message: UI_LABELS.SCAN_OPEN_OWNER_ONLY, total: 0, success: 0, failed: 0, results: [], counters: null };
    }
    
    const logRows = readLogRowsCached_(taskId);
    
    // Plan batch using pure logic
    const { plans, invalid } = planBatchScans(
      { STATUS: STATUS, TASK_STATUS: TASK_STATUS },
      task,
      logRows,
      lines
    );
    
    const now = new Date();
    const results = [];
    let success = 0;
    let failed = 0;

    // Process invalid format codes
    invalid.forEach(function (inv) {
      results.push({ code: inv.code, ok: false, status: null, message: 'Sai định dạng (phải bắt đầu bằng Ops)' });
      failed++;
    });

    // B (2026-08-12): seam commit — gom re-check race + enrich staffIndex + gom batch vào
    // planScanCommits (ScanLogic) — scanStaff + pasteCodes dùng chung, hết duplicate.
    const commitActions = plans.filter(function (p) { return p.action !== 'reject'; });
    let staffIndex = null;
    if (commitActions.some(function (p) { return p.action === 'append'; })) {
      try { staffIndex = readStaffIndex_() || null; } catch (e) { console.warn('readStaffIndex fail', e.message); staffIndex = null; }
    }
    // Re-check race: đọc lại cache sau khi giữ lock (thiết bị khác có thể vừa ghi cùng mã)
    const freshLogRows = readLogRowsCached_(taskId) || [];
    const commit = planScanCommits(
      { STATUS: STATUS, TASK_STATUS: TASK_STATUS },
      task, commitActions, freshLogRows, staffIndex, now, formatTime_
    );
    // Results theo ĐÚNG thứ tự plans (reject/update/append xen kẽ như cũ)
    plans.forEach(function (plan) {
      if (plan.action === 'reject') {
        var msg = plan.reason === 'already-present' ? UI_LABELS.ALREADY_PRESENT :
                  plan.reason === 'already-scanned' ? UI_LABELS.ALREADY_SCANNED :
                  plan.reason === 'task-closed' ? UI_LABELS.TASK_CLOSED :
                  UI_LABELS.STAFF_NOT_FOUND;
        results.push({ code: plan.code, ok: false, status: null, message: msg });
        failed++;
        return;
      }
      const o = commit.outcomes[String(plan.code).trim().toUpperCase()];
      const st = o ? o.status : plan.status;
      results.push({ code: plan.code, ok: true, status: st, message: st });
      success++;
    });
    if (commit.updates.length > 0) {
      batchUpdateLogRows_(taskId, commit.updates);
    }
    if (commit.appends.length > 0) {
      const appendRes = batchAppendLogRows_(commit.appends);
      commit.appends.forEach(function (row, idx) {
        const o = commit.outcomes[String(row[1] || '').toUpperCase()];
        if (o) o.rowIndex = appendRes.rowIndices[idx] || 0;
      });
    }

    // Read updated log for fresh counters
    const updatedLogRows = readLogRowsCached_(taskId);
    const counters = computeCounters({ STATUS: STATUS }, updatedLogRows);
    
    const t3 = Date.now();
    if (t3 - t0 > 400) {
      console.log({ bench: 'pasteCodes', taskId: taskId, totalLines: lines.length, success: success, failed: failed, totalMs: t3 - t0 });
    }
    
    audit_('pasteCodes', taskId, { total: lines.length, success: success, failed: failed });
    return { ok: true, total: lines.length, success: success, failed: failed, results: results, counters: counters, taskId: taskId };
    
  } finally {
    lock.releaseLock();
  }
  } catch (e) {
    return { ok: false, message: 'Lỗi server: ' + (e && e.message ? e.message : 'unknown'), total: 0, success: 0, failed: 0, results: [], counters: null };
  }
}
