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
    const isAdmin = requireRole_('admin');
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
    // B7 (fix): chỉ đọc log rows 1 lần — lock đã giữ từ đầu hàm, không có
    // device nào khác có thể ghi giữa 2 lần read. logRows dùng chung cho classify + plan.
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
      const REJECT_MSG = {
        'task-closed': UI_LABELS.TASK_CLOSED,
        'already-scanned': UI_LABELS.ALREADY_SCANNED,
        'already-present': UI_LABELS.ALREADY_PRESENT,
      };
      return {
        ok: false,
        message: REJECT_MSG[result.reason] || UI_LABELS.STAFF_NOT_FOUND,
        status: null,
        counters: computeCounters({ STATUS: STATUS }, logRows),
      };
    }

    // B (2026-08-12): seam commit — mọi quyết định ghi (update/append/race/enrich) qua
    // planScanCommits (ScanLogic) — seam commit gom re-check race + enrich staffIndex + batch (architecture review B).
    const field = result.field;
    const needsAppend = result.action === 'append';
    // Race: logRows đã đọc trong lock — planScanCommits xử lý re-check bằng existingMap
    // (so sánh epoch hiện hữu với planned action, không đè giờ).
    let staffIndex = null;
    if (needsAppend) {
      // Đọc staffIndex CHỈ khi cần append (lazy). G: wrap try/catch — StaffData lỗi
      // vẫn ghi Dư (staffInfo=null) thay vì "Server lỗi".
      try { staffIndex = readStaffIndex_() || null; } catch (e) { console.warn('readStaffIndex fail', staffId, e.message); staffIndex = null; }
    }
    // scanNow = epoch client chup luc quet (WYSIWYG - user thay gio nao, sheet ghi gio do).
    // Chong gian lan gio: chi chap nhan epoch client trong cua so ±60s so voi server
    // (V1-2026-08-19: thu tu ±3 phut → 60s — queue toi da 8 item x 2.5s ≈ 20s + latency,
    // 60s van du an toan; hep hon = gio lui/tới tuong lai it hon); ngoai cua so, gio truoc khi tao
    // task (createdAtText), hoac gio tuong lai → server-authoritative (gio server hien tai).
    const drift = Date.now() - clientEpoch;
    // Cửa sổ ±60s ĐỐI XỨNG — client clock nhanh 30s (drift âm) trước đây bị bỏ dù trong
    // cửa sổ ghi chú (±60s so với server) → mất WYSIWYG cho thiết bị chạy nhanh.
    const clientEpochOk = typeof clientEpoch === 'number' && isFinite(clientEpoch) && clientEpoch > 0
      && drift >= -60000 && drift <= 60000;
    let scanNow = clientEpochOk ? new Date(clientEpoch) : new Date();
    const taskCreatedAt = safeDate_(task.createdAtText);
    // Chỉ fallback server khi NGOÀI cửa sổ: trước lúc tạo task, hoặc tương lai xa hơn 60s
    // (tương lai gần ≤60s = client clock nhanh trong cửa sổ — giữ WYSIWYG).
    if ((taskCreatedAt && scanNow.getTime() < taskCreatedAt.getTime())
        || (scanNow.getTime() - Date.now() > 60000)) {
      scanNow = new Date();
    }
    const commit = planScanCommits(
      { STATUS: STATUS, TASK_STATUS: TASK_STATUS },
      task,
      [{ code: staffId, action: result.action, field: result.field, status: result.status, row: result.row }],
      logRows, staffIndex, scanNow, formatTime_
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
    const scannedAtText = outcome ? outcome.scannedAtText : '';
    const scannedAtEpoch = outcome ? outcome.scannedAtEpoch : 0;
    const listedAtText = outcome ? outcome.listedAtText : '';
    const listedAtEpoch = outcome ? outcome.listedAtEpoch : 0;
    const scannedName = outcome ? outcome.staffName : null;
    const staffUnknown = outcome ? !!outcome.staffUnknown : false;
    let counters;
    try {
      const updatedRows = logRows.slice();
      if (outcome) {
        const needle = String(staffId).toUpperCase();
        let idx = -1;
        for (let i = 0; i < updatedRows.length; i++) { if (String(updatedRows[i].staffId || '').toUpperCase() === needle) { idx = i; break; } }
        if (idx >= 0) {
          const r = Object.assign({}, updatedRows[idx]);
          if (outcome.scannedAtText) { r.scannedAtText = outcome.scannedAtText; r.scannedAtEpoch = outcome.scannedAtEpoch; }
          if (outcome.listedAtText) { r.listedAtText = outcome.listedAtText; r.listedAtEpoch = outcome.listedAtEpoch; }
          if (outcome.status) r.status = outcome.status;
          if (outcome.staffName) r.staffName = outcome.staffName;
          updatedRows[idx] = r;
        } else {
          updatedRows.push({ staffId: staffId, staffName: outcome.staffName || '', slotCode: outcome.slotCode || '', station: outcome.station || '', team: outcome.team || '', workstation: outcome.workstation || '', listedAtText: outcome.listedAtText || '', listedAtEpoch: outcome.listedAtEpoch || 0, scannedAtText: outcome.scannedAtText || '', scannedAtEpoch: outcome.scannedAtEpoch || 0, status: outcome.status || STATUS.EXTRA, dateText: outcome.dateText || '' });
        }
      }
      counters = computeCounters({ STATUS: STATUS }, updatedRows);
    } catch (e) { counters = computeCounters({ STATUS: STATUS }, readLogRowsCached_(taskId)); }
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
      scannedAtText: scannedAtText,
      scannedAtEpoch: scannedAtEpoch,
      listedAtText: listedAtText,
      listedAtEpoch: listedAtEpoch,
      staffName: scannedName,
      staffUnknown: staffUnknown,
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
    // B10: lock timeout → message thân thiện (không báo "Lỗi server" gây hoảng loạn operator)
    var msg = e && e.message ? String(e.message) : '';
    var isLock = /timeout/i.test(msg) || /lock/i.test(msg) || /wait/i.test(msg);
    return { ok: false, message: isLock ? 'Hệ thống bận, thử lại sau 2s' : ('Lỗi server: ' + msg), status: null, counters: { scanned: 0, absent: 0, extra: 0, total: 0 } };
  }
}

