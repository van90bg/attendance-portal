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
 * @returns {{ok: boolean, message: string, status: string|null, counters: Object}}
 */
function scanStaff(taskId, rawStaffId) {
  // P2 benchmark (QA prod): đo latency thật từng giai đoạn → Stackdriver.
  // Kiosk queue 2.5s/item — cần số liệu thật trước khi tối ưu thêm.
  const t0 = Date.now();
  const staffId = normalizeStaffId(rawStaffId);
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
  // ReferenceError extraRow) trả ok:false thay vì ném ra → kiosk hiện toast, KHÔNG "Server lỗi".
  try {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const t1 = Date.now();
    const task = readTask_(taskId);
    // m1 (audit): null-check task — taskId không tồn tại → message sạch thay vì TypeError.
    if (!task) {
      console.log({ bench: 'scanStaff', taskId: taskId, staffId: staffId, phase: 'reject-no-task', ms: Date.now() - t0 });
      return { ok: false, message: 'Không tìm thấy task', status: null, counters: { scanned: 0, absent: 0, extra: 0, total: 0 } };
    }
    // T-1: Owner gate cho scan khi task ở phase OPEN
    // Chỉ áp dụng khi task.status === OPEN. Admin bypass, owner match, legacy 'web'/rỗng cho phép.
    let activeEmail = '';
    try { activeEmail = Session.getActiveUser().getEmail() || ''; } catch (e) { activeEmail = ''; }
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
          { STATUS: STATUS, TASK_STATUS: TASK_STATUS, TASK_TYPE: TASK_TYPE },
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

    let timeScanText = '';
    let timeScanEpoch = 0;
    let timeRefText = '';
    let timeRefEpoch = 0;
    let scannedName = null;
    let extraRow = null;
    // field do classifyScan chỉ định: 'timeRef' (phase1: Giờ có mặt) | 'timeScan' (phase2: Giờ quét)
    const field = result.field;
    if (result.action === 'update') {
      const now = new Date();
      if (field === 'timeScan') {
        updateLogRowScan_(result.row, now, result.status);
        result.row.timeScan = now;
        result.row.timeScanEpoch = now.getTime();
        timeScanText = formatTime_(now);
        timeScanEpoch = now.getTime();
      } else {
        // phase1: ghi Giờ có mặt (TIME_REF), giữ status PENDING (chưa điểm danh)
        updateLogRowRef_(result.row, now);
        result.row.timeRef = now;
        result.row.timeRefEpoch = now.getTime();
        timeRefText = formatTime_(now);
        timeRefEpoch = now.getTime();
      }
      result.row.status = result.status;
      scannedName = result.row.staffName || null;
    } else if (result.action === 'append') {
      // P2-6: re-check cache (có thể kiosk khác vừa push dòng này trong lock) trước khi append
      // → tránh Dư TRÙNG LẶP khi 2 kiosk quét CÙNG staffId lạ trong cửa sổ cache TTL.
      let existing = null;
      try { existing = findLogRow(readLogRowsCached_(taskId), staffId); } catch (e) { console.warn('recheck cache fail', e.message); }
      const now = new Date();
      // Đọc staffIndex CHỈ khi thực sự cần append (lazy). G: wrap try/catch — nếu
      // StaffData lỗi vẫn ghi Dư (staffInfo=null) thay vì "Server lỗi".
      let staffInfo = null;
      if (!existing) {
        try { staffInfo = (readStaffIndex_())[staffId] || null; } catch (e) { console.warn('readStaffIndex fail', staffId, e.message); staffInfo = null; }
      }
      // Gán (không khai báo lại) — extraRow đã hoist lên scope hàm để return đọc được.
      extraRow = existing ? {
        slotCode: existing.slotCode || '',
        station: existing.station || '',
        team: existing.team || '',
        workstation: existing.workstation || '',
      } : buildExtraRow({ STATUS: STATUS }, taskId, staffId, staffInfo, now, field);
      if (existing) {
        // Đã có (race) → commit thời gian vào row hiện hữu thay vì chỉ trả local.
        // Minor#2 (audit): trước đây chỉ set local text/epoch, KHÔNG ghi sheet → nếu
        // kiosk B quét phase2 khi A mới ghi phase1, thời gian hợp lệ bị rơi (NV phải quét lại).
        if (field === 'timeScan') {
          timeScanText = existing.timeScanText || formatTime_(now);
          timeScanEpoch = Number(existing.timeScanEpoch) || now.getTime();
          if (!existing.timeScanEpoch) {  // chưa có Giờ quét → GHI VÀO sheet (not skip)
            updateLogRowScan_(existing, now, result.status || STATUS.EXTRA);
            existing.timeScanText = timeScanText;
            existing.timeScanEpoch = timeScanEpoch;
            existing.status = result.status || STATUS.EXTRA;
          }
        } else {
          timeRefText = existing.timeRefText || formatTime_(now);
          timeRefEpoch = Number(existing.timeRefEpoch) || now.getTime();
          if (!existing.timeRefEpoch) {  // chưa có Giờ có mặt — GHI vào sheet
            updateLogRowRef_(existing, now);
            existing.timeRefText = timeRefText;
            existing.timeRefEpoch = timeRefEpoch;
          }
        }
        scannedName = existing.staffName || null;
        result.status = existing.status || STATUS.EXTRA;
      } else {
        // status ghi phải theo classifyScan trả (result.status) — KHÔNG hardcode EXTRA.
        // noList quét đầu (phase1) = PENDING (Chưa điểm danh), phase2 = PRESENT.
        // Fix #3: buildExtraRow giờ nhận status param (mặc định EXTRA).
        extraRow.status = result.status || STATUS.EXTRA;
        appendLogRow_(extraRow);
        logRows.push(extraRow);
        if (field === 'timeScan') {
          timeScanText = formatTime_(now);
          timeScanEpoch = now.getTime();
        } else {
          timeRefText = formatTime_(now);
          timeRefEpoch = now.getTime();
        }
        scannedName = extraRow.staffName || null;
        // KHÔNG hardcode EXTRA ở đây — result.status đã do classifyScan trả đúng
        // (free task = PENDING/PRESENT, roster lạ = EXTRA). Hardcode sẽ ghi nhầm "Dư"
        // cho quét tự do (Fix 2026-08-05).
      }
    }

    const counters = computeCounters({ STATUS: STATUS }, logRows);
    // P2 benchmark: tổng + tách giai đoạn — QA prod đọc Stackdriver biết ngay
    // bottleneck (read sheet vs write). Phân tích: t1→t2 = đọc task+log (full sheet),
    // t2→t3 = classify + write. Nếu read > 1.5s → cần index log (xem Database.gs).
    const t3 = Date.now();
    // Minor#6 (audit): log benchmark CHỈ khi bất thường (> ngưỡng) — trước đây log
    // mọi lượt thể hiện, ở nhịp kiosk ~1400 log/h/tab → tốn Stackdriver quota/chi phí.
    // Ngưỡng: total > 400ms (bất thường) HOẶC read/write > 300ms (bottleneck tiềm ẩn).
    const __dt = { totalMs: t3 - t0, readMs: t2 - t1, writeMs: t3 - t2 };
    if (__dt.totalMs > 400 || __dt.readMs > 300 || __dt.writeMs > 300) {
      console.log({ bench: 'scanStaff', taskId: taskId, staffId: staffId, action: result.action, totalMs: __dt.totalMs, readMs: __dt.readMs, writeMs: __dt.writeMs });
    }
    return {
      ok: true,
      message: result.status,
      status: result.status,
      phase: result.phase,
      field: field,
      timeScanText: timeScanText,
      timeScanEpoch: timeScanEpoch,
      timeRefText: timeRefText,
      timeRefEpoch: timeRefEpoch,
      staffName: scannedName,
      slotCode: result.action === 'append' ? (extraRow ? extraRow.slotCode : '') : (result.row ? result.row.slotCode : ''),
      station: result.action === 'append' ? (extraRow ? extraRow.station : '') : (result.row ? result.row.station : ''),
      team: result.action === 'append' ? (extraRow ? extraRow.team : '') : (result.row ? result.row.team : ''),
      workstation: result.action === 'append' ? (extraRow ? extraRow.workstation : '') : (result.row ? result.row.workstation : ''),
      counters: counters,
    };
  } finally {
    lock.releaseLock();
  }
  } catch (e) {
    // DEFENSE: bất kỳ lỗi runtime → trả ok:false (kiosk toast) thay vì crash "Server lỗi".
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
  // DEFENSE: bọc toàn bộ logic — bất kỳ lỗi nào (kể cả ReferenceError) trả ok:false
  // thay vì ném ra → client hiện toast gọn, KHÔNG "Server lỗi" chung (pattern scanStaff).
  try {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const task = readTask_(taskId);
    if (!task) return { ok: false, message: 'Không tìm thấy task', total: 0, success: 0, failed: 0, results: [], counters: null };
    
    // Gate: FREE + OPEN + canScanOpen
    let activeEmail = '';
    try { activeEmail = Session.getActiveUser().getEmail() || ''; } catch (e) { activeEmail = ''; }
    const isAdmin = isEditor_();
    
    if (task.taskType !== TASK_TYPE.FREE) {
      return { ok: false, message: 'Chỉ áp dụng quét tự do (FREE)', total: 0, success: 0, failed: 0, results: [], counters: null };
    }
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
      { STATUS: STATUS, TASK_STATUS: TASK_STATUS, TASK_TYPE: TASK_TYPE },
      task,
      logRows,
      lines
    );
    
    const now = new Date();
    const appendRows = []; // rows to batch append
    const results = [];
    let success = 0;
    let failed = 0;
    
    // Process invalid format codes
    invalid.forEach(function (inv) {
      results.push({ code: inv.code, ok: false, status: null, message: 'Sai định dạng (phải bắt đầu bằng Ops)' });
      failed++;
    });
        // M1 (audit): gom update plans → 1 batch (không N setValues + N cache invalidation riêng lẻ).
    const updateBatch = [];
    
    // Process each plan
    plans.forEach(function (plan) {
      if (plan.action === 'reject') {
        var msg = plan.reason === 'already-present' ? 'Đã có mặt' :
                  plan.reason === 'already-scanned' ? 'Đã điểm danh' :
                  plan.reason === 'task-closed' ? 'Task đã kết thúc' :
                  'Không thể quét';
        results.push({ code: plan.code, ok: false, status: null, message: msg });
        failed++;
      } else if (plan.action === 'append') {
        // Build row for batch append
        const newRow = [
          taskId,
          plan.code.toUpperCase(),
          '', // staffName - will be filled from staffIndex if available
          '', '', '', '', // slotCode, station, team, workstation
          plan.field === 'timeRef' ? now : '',
          plan.field === 'timeScan' ? now : '',
          plan.status,
          '', // date
        ];
        appendRows.push(newRow);
        results.push({ code: plan.code, ok: true, status: plan.status, message: plan.status });
        success++;
      } else if (plan.action === 'update') {
        // M1: gom vào batch — ghi 1 đợt sau loop thay vì N setValues riêng biệt.
        updateBatch.push({
          rowIndex: plan.row._rowIndex, field: plan.field, time: now,
          newStatus: plan.status,
          keepStatus: plan.row.status,
        });
        results.push({ code: plan.code, ok: true, status: plan.status, message: plan.status });
        success++;
      }
    });
    if (updateBatch.length > 0) {
      batchUpdateLogRows_(taskId, updateBatch);
    }
    
    // Batch append new rows
    if (appendRows.length > 0) {
      // Try to fill staffInfo from staffIndex for appended rows
      let staffIndex = null;
      try { staffIndex = readStaffIndex_(); } catch (e) { console.warn('readStaffIndex fail', e.message); }
      if (staffIndex) {
        appendRows.forEach(function (row) {
          const info = staffIndex[row[1]]; // staffId is column 1
          if (info) {
            row[2] = info.staffName || '';
            row[3] = info.slotCode || '';
            row[4] = info.station || '';
            row[5] = info.team || '';
            row[6] = info.workstation || '';
            row[10] = info.date || '';
          }
        });
      }
      batchAppendLogRows_(appendRows);
    }
    
    // Read updated log for fresh counters
    const updatedLogRows = readLogRowsCached_(taskId);
    const counters = computeCounters({ STATUS: STATUS }, updatedLogRows);
    
    const t3 = Date.now();
    if (t3 - t0 > 400) {
      console.log({ bench: 'pasteCodes', taskId: taskId, totalLines: lines.length, success: success, failed: failed, totalMs: t3 - t0 });
    }
    
    return { ok: true, total: lines.length, success: success, failed: failed, results: results, counters: counters, taskId: taskId };
    
  } finally {
    lock.releaseLock();
  }
  } catch (e) {
    return { ok: false, message: 'Lỗi server: ' + (e && e.message ? e.message : 'unknown'), total: 0, success: 0, failed: 0, results: [], counters: null };
  }
}
