/**
 * ScanLogic.gs — Logic THUẦN phân loại quét + đếm counters.
 *
 * KHÔNG gọi GAS API — test được trên Node (`node --test tests/scan-classify.test.js`).
 * ScanService.gs (wrapper GAS) gọi các hàm này sau khi lấy dữ liệu từ Database.
 *
 * Dùng hằng số STATUS/TASK_STATUS từ Config.gs (global trong GAS).
 * Để Node test chạy được, file này KHÔNG require Config — các hằng số được
 * truyền vào qua tham số `cfg` (xem chữ ký hàm).
 */

/** Regex mã barcode NV — 'Ops' + số (KHỚP isValidBarcodeId trong CsvUtil.gs — đừng để lệch). */
const BARCODE_ID_RE = /^OPS\d+$/i;

/**
 * Phân loại 1 lần quét (2-phase attendance).
 *
 * @param {Object} cfg — { STATUS: {...}, TASK_STATUS: {...} } (từ Config.gs)
 * @param {Object} task — { taskId, status } (status: open=phase1, attend=phase2, done)
 * @param {Array<Object>} logRows — các dòng AttendanceLog của task (đã map theo LOG_COLS;
 *   mỗi row cần field timeRefEpoch / timeScanEpoch để làm nguồn sự thật)
 * @param {string} staffId — mã NV đã normalize
 * @returns {{action: 'update'|'append'|'reject', phase: 'present'|'attend', field: 'timeRef'|'timeScan'|null, status: string|null, reason: string|null, row: Object|null}}
 *   - phase 'present' (task.status=open): ghi GIỜ CÓ MẶT (TIME_REF).
 *       update: NV trong log + chưa có Giờ có mặt → ghi timeRef, status giữ PENDING.
 *       append: NV không trong log → dòng mới EXTRA + timeRef (ghi nhận có mặt, chưa điểm danh).
 *   - phase 'attend' (task.status=attend): ghi GIỜ QUÉT (TIME_SCAN) = điểm danh.
 *       update: NV trong log + chưa quét → ghi timeScan, status PRESENT.
 *       append: NV không trong log → dòng mới EXTRA + timeScan (Dư, có mặt + quét).
 *   - reject 'task-closed': task done (hoặc không xác định).
 *   - reject 'already-present': phase1, NV đã có Giờ có mặt.
 *   - reject 'already-scanned': phase2, NV đã quét.
 */
function classifyScan(cfg, task, logRows, staffId) {
  // Phase từ task.status: open=1 (ghi Giờ có mặt), attend=2 (ghi Giờ quét).
  const phase = task && task.status === cfg.TASK_STATUS.ATTEND ? 'attend' : 'present';
  if (!task || (task.status !== cfg.TASK_STATUS.OPEN && task.status !== cfg.TASK_STATUS.ATTEND)) {
    return { action: 'reject', phase: phase, field: null, status: null, reason: 'task-closed', row: null };
  }
  if (!staffId) {
    return { action: 'reject', phase: phase, field: null, status: null, reason: 'empty-staff-id', row: null };
  }
  const row = findLogRow(logRows, staffId);
  if (row) {
    if (phase === 'present') {
      // Đã ghi Giờ có mặt cho lần 1 → không ghi lại (client cũng chặn, đây là defense).
      if (Number(row.timeRefEpoch) > 0) {
        return { action: 'reject', phase: 'present', field: null, status: null, reason: 'already-present', row: row };
      }
      // Ghi Giờ có mặt (TIME_REF), giữ status PENDING (chưa điểm danh).
      return { action: 'update', phase: 'present', field: 'timeRef', status: cfg.STATUS.PENDING, reason: null, row: row };
    }
    // phase 'attend' — chỉ quét lần 2 mới là điểm danh.
    // P2: epoch là nguồn sự thật duy nhất (khớp computeCounters) — text mất ngày.
    if (Number(row.timeScanEpoch) > 0) {
      return { action: 'reject', phase: 'attend', field: null, status: null, reason: 'already-scanned', row: row };
    }
    // NV lạ (Dư/EXTRA từ phase1) quét lại phase2 → VẪN là Dư (EXTRA), KHÔNG đổi thành
    // Có mặt (PRESENT). Chỉ NV trong danh sách (status PENDING) quét phase2 mới = PRESENT.
    if (row.status === cfg.STATUS.EXTRA) {
      return { action: 'update', phase: 'attend', field: 'timeScan', status: cfg.STATUS.EXTRA, reason: null, row: row };
    }
    return { action: 'update', phase: 'attend', field: 'timeScan', status: cfg.STATUS.PRESENT, reason: null, row: row };
  }
  // NV không có trong log.
  // - Roster (taskType != 'free'): NV quét lạ là Dư (EXTRA) — ghi nhận ngoài danh sách chốt.
  //   phase1 Giờ có mặt, phase2 Giờ quét.
  // - Quét tự do (taskType FREE / noList): KHÔNG có danh sách chốt → NV lạ là hợp lệ,
  //   KHÔNG phải Dư. Quét đầu (phase1) = PENDING (chưa điểm danh), phase2 = PRESENT.
  //   (Fix Dư sai 2026-08-05)
  const isFree = task && task.taskType === cfg.TASK_TYPE.FREE;
  if (isFree) {
    // FREE 2-phase (noList): phase1 quét đầu = danh sách (PENDING, có mặt
    // nhưng chưa điểm danh). phase2: NV quét lần 2 → điểm danh. NV quét phase2
    // mà không có trong danh sách phase1 → Dư (EXTRA) — ghi Giờ quét, tính Dư.
    return {
      action: 'append', phase: phase, field: (phase === 'present' ? 'timeRef' : 'timeScan'),
      status: phase === 'present' ? cfg.STATUS.PENDING : cfg.STATUS.EXTRA, reason: null, row: null,
    };
  }
  if (phase === 'present') {
    return { action: 'append', phase: 'present', field: 'timeRef', status: cfg.STATUS.EXTRA, reason: null, row: null };
  }
  return { action: 'append', phase: 'attend', field: 'timeScan', status: cfg.STATUS.EXTRA, reason: null, row: null };
}

/**
 * Tìm dòng NV trong log theo staffId (staffId đã normalize trước).
 * @param {Array<Object>} logRows
 * @param {string} staffId
 * @returns {Object|null}
 */
function findLogRow(logRows, staffId) {
  if (!logRows || !staffId) return null;
  const needle = String(staffId).trim().toUpperCase();
  for (let i = 0; i < logRows.length; i++) {
    if (String(logRows[i].staffId || '').trim().toUpperCase() === needle) return logRows[i];
  }
  return null;
}

/**
 * Tính counters từ danh sách dòng log của task.
 * Quy ước (đã chốt): Đã quét = timeScanEpoch > 0 (PRESENT + EXTRA); Vắng = pre-fill chưa quét;
 * Dư = status EXTRA.
 * 2-phase: có mặt = timeRefEpoch>0 (Giờ có mặt, phase1); quét = timeScanEpoch>0 (Giờ quét, phase2).
 *
 * @param {Object} cfg — { STATUS: {...} }
 * @param {Array<Object>} logRows
 * @returns {{scanned: number, absent: number, extra: number, total: number}}
 */
function computeCounters(cfg, logRows) {
  let scanned = 0;   // Giờ quét có (timeScanEpoch>0) — điểm danh xong
  let presentAt = 0; // Giờ có mặt (timeRefEpoch>0) — phase1
  let absent = 0;
  let extra = 0;
  const total = logRows ? logRows.length : 0;
  (logRows || []).forEach(function (row) {
    // P2: epoch là nguồn sự thật duy nhất (text mất ngày xuyên nửa đêm; slim cache
    // không còn field timeScan Date) — khớp hướng scanCard/restoreScanCard.
    var hasScan = Number(row.timeScanEpoch) > 0;
    var hasRef = Number(row.timeRefEpoch) > 0;
    if (hasScan) scanned++;
    if (hasRef) presentAt++;
    if (row.status === cfg.STATUS.EXTRA) extra++;
    else if (!hasScan) absent++; // chưa quét (phase2) → Vắng khi kết thúc
  });
  return { scanned: scanned, presentAt: presentAt, absent: absent, extra: extra, total: total };
}

/**
 * Tạo dòng mới cho NV quét lạ (append) — dùng dữ liệu từ staffIndex nếu có.
 * @param {Object} cfg — { STATUS: {...} }
 * @param {string} taskId
 * @param {string} staffId
 * @param {Object|null} staffInfo — từ staffIndex (có thể null nếu không tìm thấy)
 * @param {Date} now
 * @param {string} field — 'timeRef' (phase1: Giờ có mặt) | 'timeScan' (phase2: Giờ quét)
 * @param {string} status — status ghi cho dòng (mặc định EXTRA để roster lạ = Dư).
 *   noList QUÉT ĐẦU (phase1) truyền PENDING (Chưa điểm danh) — NV lạ chưa có
 *   Giờ quét nên KHÔNG gán Dư; chỉ phase2 (có Giờ quét) mới PRESENT. (Fix #3)
 * @returns {Object} row theo LOG_COLS
 */
function buildExtraRow(cfg, taskId, staffId, staffInfo, now, field, status) {
  var timeRef = null, timeScan = null, timeRefEpoch = 0, timeScanEpoch = 0;
  if (field === 'timeScan') {
    timeScan = now; timeScanEpoch = now ? now.getTime() : 0;
  } else {
    // mặc định phase1: ghi Giờ có mặt
    timeRef = now; timeRefEpoch = now ? now.getTime() : 0;
  }
  return {
    taskId: taskId,
    staffId: staffId,
    staffName: staffInfo ? staffInfo.staffName : '',
    slotCode: staffInfo ? staffInfo.slotCode : '',
    station: staffInfo ? staffInfo.station : '',
    team: staffInfo ? staffInfo.team : '',
    workstation: staffInfo ? staffInfo.workstation : '',
    timeRef: timeRef,
    timeScan: timeScan,
    timeRefEpoch: timeRefEpoch,
    // append phase2 cũng phải set timeScanEpoch (nguồn sự thật counters/sort).
    timeScanEpoch: timeScanEpoch,
    // 2026-08-07: FREE giữ staffInfo.date (ngày lên làm) cho cột Ngày — lấy từ StaffData,
    // không phải ngày quét. NV quét lạ không có trong StaffData → để rỗng.
    date: staffInfo ? (staffInfo.date || '') : '',
    // status do caller truyền (mặc định EXTRA giữ behaviour roster lạ = Dư);
    // noList quét đầu (phase1) truyền PENDING — Fix #3.
    status: status || cfg.STATUS.EXTRA,
  };
}

/**
 * Kiểm tra quyền quét khi task ở phase OPEN.
 * Quy tắc (A1/A3):
 * - Task không ở OPEN → cho phép (gate chỉ áp dụng phase OPEN).
 * - Admin (isEditor_) → bypass.
 * - createdBy là email hợp lệ (khác 'web', không rỗng, chứa '@') → chỉ owner (activeEmail === createdBy, case-insensitive) được quét.
 * - Ngược lại (owner không xác định: 'web', rỗng, không chứa '@') → cho phép tất cả (A1: fail-open cho task legacy).
 *
 * @param {Object} cfg — { TASK_STATUS: {...} }
 * @param {string} createdBy — email người tạo task (từ task.createdBy)
 * @param {string} activeEmail — email người đang quét (Session.getActiveUser().getEmail())
 * @param {boolean} isAdmin — true nếu là admin (isEditor_())
 * @returns {boolean} true = được quét, false = bị chặn
 */
function canScanOpen_(cfg, createdBy, activeEmail, isAdmin) {
  // Gate chỉ áp dụng khi task ở phase OPEN — task status check do caller thực hiện.
  if (isAdmin) return true;
  const cb = String(createdBy || '').trim().toLowerCase();
  const ae = String(activeEmail || '').trim().toLowerCase();
  // Email hợp lệ: có '@' và khác 'web'/''
  const isValidEmail = cb.includes('@') && cb !== 'web' && cb !== '';
  if (!isValidEmail) return true; // A1: owner không xác định → cho phép
  return ae === cb;
}

/**
 * Plan batch scans for paste feature (T-2).
 * Pure function - no side effects, testable on Node.
 * For each code: normalize, validate format, then classifyScan against current logRows.
 * Deduplicates naturally within the batch (second occurrence of same code in paste will be rejected).
 *
 * @param {Object} cfg — { STATUS, TASK_STATUS, TASK_TYPE }
 * @param {Object} task — { taskId, status, taskType }
 * @param {Array<Object>} logRows — current log rows (with timeRefEpoch/timeScanEpoch)
 * @param {Array<string>} codes — array of raw codes from paste (one per line)
 * @returns {{plans: Array<{code, action, phase, field, status, reason, row}>, invalid: Array<{code, reason}>}}
 */
function planBatchScans(cfg, task, logRows, codes) {
  const plans = [];
  const invalid = [];
  // Clone logRows so we can simulate appends/updates for dedup within batch
  // Fix 2 (audit 2): shallow [...logRows] vẫn dùng CHUNG object phần tử với caller —
  // nhánh update (timeRefEpoch/timeRef) mut bản gốc. Deep copy phần tử → pure,
  // nếu ghi sheet throw thì chỉ ảnh hưởng simulated local, không lệch logRows caller.
  const simulatedLogRows = logRows ? logRows.map(function (r) { return Object.assign({}, r, { timeRef: r.timeRef ? new Date(r.timeRef) : r.timeRef }); }) : [];
  
  for (let i = 0; i < codes.length; i++) {
    const rawCode = codes[i];
    const code = String(rawCode || '').trim();
    
    if (!code) continue; // skip empty lines
    
    // Normalize
    const staffId = code.toUpperCase();
    
    // Validate format (must start with OPS followed by digits only)
    if (!BARCODE_ID_RE.test(staffId)) {
      invalid.push({ code: code, ok: false, reason: 'invalid-format' });
      continue;
    }
    
    // Classify against simulated log (includes previous appends in this batch)
    const result = classifyScan(cfg, task, simulatedLogRows, staffId);
    
    const plan = {
      code: code,
      action: result.action,
      phase: result.phase,
      field: result.field,
      status: result.status,
      reason: result.reason,
      row: result.row,
    };
    plans.push(plan);
    
    // m4 (audit): simulate update trong batch — trước chỉ append được simulate nên mã
    // trùng (plan đầu = update) ra 2 update + success sai. Giờ update cũng cập nhật
    // simulated log để lượt kế classify ra already-*. 
    if (result.action === 'update' && result.row) {
      const nowU = new Date();
      if (result.field === 'timeScan') {
        result.row.timeScanEpoch = nowU.getTime();
        result.row.timeScan = nowU;
        result.row.status = result.status;
      } else {
        result.row.timeRefEpoch = nowU.getTime();
        result.row.timeRef = nowU;
      }
    }
    
    // If append, add to simulated log for subsequent codes in same batch
    if (result.action === 'append') {
      // Build a minimal row object for simulation
      const now = new Date();
      const newRow = {
        taskId: task.taskId,
        staffId: staffId,
        staffName: '',
        slotCode: '',
        station: '',
        team: '',
        workstation: '',
        timeRef: result.field === 'timeRef' ? now : null,
        timeScan: result.field === 'timeScan' ? now : null,
        timeRefEpoch: result.field === 'timeRef' ? now.getTime() : 0,
        timeScanEpoch: result.field === 'timeScan' ? now.getTime() : 0,
        status: result.status,
        date: '',
      };
      simulatedLogRows.push(newRow);
    }
  }
  
  return { plans: plans, invalid: invalid };
}

/**
 * matchLogsByStaff — logic THUẦN: lọc log rows theo mã NV (xuyên task) + join task meta.
 * Dùng cho tính năng search header (F-search). Server (Database.searchLogsByStaff) chỉ
 * đọc sheet rồi gọi hàm này — tránh duplicate logic, test được Node mà không cần mock sheet.
 *
 * @param {Array<Object>} logRows — toàn bộ dòng log (đã map logFromRow_: staffId, staffName,
 *   status (scan status NV), taskId, timeRefText, timeScanText, ...).
 * @param {Array<Object>} tasks — danh sách task (taskFromRow_: taskId, taskType, station,
 *   slotCode, team, status, createdAtText, createdBy, ...). Map nhanh theo taskId.
 * @param {string} staffId — mã NV đã normalize (uppercase) để so khớp.
 * @returns {Array<Object>} — [{ taskId, staffId, staffName, status, taskType, station,
 *   team, slotCode, taskStatus, createdAtText, createdBy, timeRefText, timeScanText }],
 *   sort Tạo lúc giảm dần, limit 200.
 */
function matchLogsByStaff(logRows, tasks, staffId) {
  if (!staffId) return [];
  const needle = String(staffId).toUpperCase();
  const taskMap = {};
  if (tasks) {
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      if (t && t.taskId != null) taskMap[String(t.taskId)] = t;
    }
  }
  const rows = logRows || [];
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    if (String(r.staffId || '').toUpperCase() !== needle) continue;
    const taskId = String(r.taskId || '').trim();
    if (!taskId) continue;
    const t = taskMap[taskId] || null;
    out.push({
      taskId: taskId,
      staffId: r.staffId,
      staffName: r.staffName || '',
      status: r.status || '',                   // scan status NV trong task (Có mặt/Vắng/Dư/-) — giữ nguyên để client quyết định có hiện không
      taskType: t ? t.taskType : '',
      station: t ? t.station : '',
      team: t ? t.team : '',
      slotCode: t ? t.slotCode : '',
      taskStatus: t ? t.status : '',
      createdAtText: t ? t.createdAtText : '',
      createdBy: t ? t.createdBy : '',
      timeRefText: r.timeRefText || '',
      timeScanText: r.timeScanText || '',
    });
  }
  // Tạo lúc giảm dần (yyyy-MM-dd HH:mm:ss — sort chuỗi được). limit 200 bảo vệ sheet lớn.
  out.sort(function (a, b) {
    return b.createdAtText < a.createdAtText ? -1 : (b.createdAtText > a.createdAtText ? 1 : 0);
  });
  return out.slice(0, 200);
}

/**
 * matchTasksByQuery — logic THUẦN: lọc danh sách task theo mã task (prefix/contains,
 * case-insensitive). Dùng cho tìm kiếm task ở header (F-search mở rộng): người dùng nhập
 * "R202608" hoặc "2352" → trả các task khớp. KHÔNG join log — chỉ filter task meta.
 *
 * @param {Array<Object>} tasks — danh sách task (taskFromRow_ + counters, đã có từ readTaskList_).
 * @param {string} q — chuỗi tìm (đã normalize uppercase ở caller, có thể kèm space).
 * @returns {Array<Object>} — tasks khớp, giữ nguyên thứ tự (mới nhất trước), limit 50.
 */
function matchTasksByQuery(tasks, q) {
  if (!q) return [];
  const needle = String(q).trim().toUpperCase();
  if (!needle) return [];
  const out = [];
  (tasks || []).forEach(function (t) {
    if (!t || !t.taskId) return;
    if (String(t.taskId).toUpperCase().indexOf(needle) >= 0) out.push(t);
  });
  return out.slice(0, 50);
}

// ===== Node test support (GAS bỏ qua) =====
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    classifyScan: classifyScan,
    findLogRow: findLogRow,
    computeCounters: computeCounters,
    buildExtraRow: buildExtraRow,
    canScanOpen_: canScanOpen_,
    planBatchScans: planBatchScans,
    matchLogsByStaff: matchLogsByStaff,
    matchTasksByQuery: matchTasksByQuery,
  };
}
