/**
 * ScanLogic.gs — Logic THUẦN phân loại quét + đếm counters.
 *
 * KHÔNG gọi GAS API — test được trên Node (`node --test tests/scan-classify.test.js`).
 * ScanService.gs (wrapper GAS) gọi các hàm này sau khi lấy dữ liệu từ Database.
 *
 * Dùng hằng số STATUS/TASK_STATUS từ Config.gs (global trong GAS).
 * Để Node test chạy được, file này KHÔNG require Config — các hằng số được
 * truyền vào qua tham số `cfg` (xem chữ ký hàm).
 * Ngoại lệ DUY NHẤT: BARCODE_ID_RE (CsvUtil.gs) — global GAS; Node test standalone
 * require CsvUtil (xem planBatchScans).
 */

// Regex mã barcode NV — 1 nguồn sự thật: CsvUtil.gs. KHÔNG khai báo ở top-level
// (GAS gộp mọi file vào 1 scope — khai trùng const/var cùng tên = SyntaxError lúc load).
// planBatchScans lấy global BARCODE_ID_RE (GAS) hoặc require CsvUtil (Node standalone).

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
  // NV không có trong log — mọi task đều giống FREE (không phân biệt taskType):
  //   phase1: append PENDING (NV tham gia, chưa điểm danh); phase2: EXTRA (ngoài danh sách).
  return {
    action: 'append', phase: phase, field: (phase === 'present' ? 'timeRef' : 'timeScan'),
    status: phase === 'present' ? cfg.STATUS.PENDING : cfg.STATUS.EXTRA, reason: null, row: null,
  };
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
 * B (2026-08-12): planScanCommits — seam THUẦN gom quyết định COMMIT scan.
 * scanStaff + pasteCodes trước đây tự viết lại 3 thứ (duplicate logic — architecture review B):
 *   1. re-check race (2 thiết bị cùng staffId trong cửa sổ cache) → append biến update/skip
 *   2. enrich append bằng staffIndex
 *   3. gom update/append thành batch
 * Hàm này nhận actions đã plan + log rows RE-CHECK (caller đọc lại sau khi giữ lock)
 * và trả đúng shape 2 helper LogRepo tiêu thụ:
 *   updates: [{rowIndex, field, time, newStatus?, keepStatus?}] → batchUpdateLogRows_
 *   appends: [11 cột theo LOG_COL_COUNT]                            → batchAppendLogRows_
 *   outcomes: {STAFFID: {action, field, timeRefText, timeRefEpoch, timeScanText,
 *              timeScanEpoch, status, staffName, slotCode, station, team, workstation,
 *              dateText, rowIndex}} — payload response client (scanStaff) / results (pasteCodes).
 *
 * Race semantics (thống nhất theo hành vi scanStaff, bảo thủ hơn pasteCodes cũ):
 *  - append mà staffId ĐÃ có trong freshLogRows (thiết bị khác vừa ghi trong lock):
 *    + field 'timeScan' & chưa có timeScanEpoch → convert thành update timeScan
 *    + field 'timeRef'   & chưa có timeRefEpoch   → convert thành update timeRef
 *    + field đã có epoch (thiết bị khác xong phase này) → KHÔNG ghi (không đè thời gian),
 *      báo thông tin row hiện hữu.
 *
 * @param {Object} cfg — { STATUS, TASK_STATUS }
 * @param {Object} task — { taskId, status }
 * @param {Array} actions — [{ code?, action:'update'|'append', field, status, row? }]
 *   (classifyScan result / planBatchScans plan — cùng shape commit)
 * @param {Array} freshLogRows — log rows RE-CHECK (slim: staffId, text, epoch, status, _rowIndex)
 * @param {Object|null} staffIndex — map STAFFID → {staffName, slotCode, station, team, workstation, date}
 * @param {Date} now
 * @param {function(Date):string} fmtTime — formatTime_ (GAS); stub trong test
 * @returns {{updates:Array, appends:Array, outcomes:Object}}
 */
function planScanCommits(cfg, task, actions, freshLogRows, staffIndex, now, fmtTime) {
  const STATUS = cfg.STATUS;
  const fmt = fmtTime || function () { return ''; };
  const num = function (v) { return Number(v) || 0; };
  const updates = [];
  const appends = [];
  const outcomes = {};
  const existingMap = {};
  (freshLogRows || []).forEach(function (r) {
    existingMap[String(r.staffId || '').trim().toUpperCase()] = r;
  });
  (actions || []).forEach(function (a) {
    const sid = String(a.code !== undefined && a.code !== null ? a.code : '').trim().toUpperCase();
    if (!sid) return;
    if (a.action === 'update' && a.row) {
      const isScan = a.field === 'timeScan';
      outcomes[sid] = {
        action: 'update', field: a.field,
        timeScanText: isScan ? fmt(now) : '',
        timeScanEpoch: isScan ? now.getTime() : 0,
        timeRefText: isScan ? '' : fmt(now),
        timeRefEpoch: isScan ? 0 : now.getTime(),
        status: a.status || STATUS.EXTRA,
        staffName: a.row.staffName || null,
        slotCode: a.row.slotCode || '', station: a.row.station || '',
        team: a.row.team || '', workstation: a.row.workstation || '',
        dateText: (a.row && a.row.dateText) || '',
        rowIndex: a.row._rowIndex || 0,
      };
      const u = { rowIndex: a.row._rowIndex, field: a.field, time: now, newStatus: a.status };
      // timeScan: ghi STATUS (khớp updateLogRowScan_ cũ); timeRef: chỉ TIME_REF (khớp updateLogRowRef_)
      if (isScan) u.keepStatus = a.row.status;
      updates.push(u);
      return;
    }
    if (a.action === 'append') {
      const ex = existingMap[sid];
      if (ex) {
        // RACE: thiết bị khác vừa append trong lock → chỉ ghi nếu phase CHƯA hoàn thành
        if (a.field === 'timeScan' && !num(ex.timeScanEpoch)) {
          updates.push({ rowIndex: ex._rowIndex, field: 'timeScan', time: now, newStatus: a.status || STATUS.EXTRA, keepStatus: ex.status });
          outcomes[sid] = {
            action: 'update', field: 'timeScan',
            timeScanText: ex.timeScanText || fmt(now), timeScanEpoch: now.getTime(),
            timeRefText: '', timeRefEpoch: 0,
            status: a.status || STATUS.EXTRA,
            staffName: ex.staffName || null,
            slotCode: ex.slotCode || '', station: ex.station || '',
            team: ex.team || '', workstation: ex.workstation || '',
            dateText: (ex && ex.dateText) || '',
            rowIndex: ex._rowIndex || 0,
          };
        } else if (a.field === 'timeRef' && !num(ex.timeRefEpoch)) {
          updates.push({ rowIndex: ex._rowIndex, field: 'timeRef', time: now });
          outcomes[sid] = {
            action: 'update', field: 'timeRef',
            timeRefText: ex.timeRefText || fmt(now), timeRefEpoch: now.getTime(),
            timeScanText: '', timeScanEpoch: 0,
            status: ex.status || STATUS.EXTRA,
            staffName: ex.staffName || null,
            slotCode: ex.slotCode || '', station: ex.station || '',
            team: ex.team || '', workstation: ex.workstation || '',
            dateText: (ex && ex.dateText) || '',
            rowIndex: ex._rowIndex || 0,
          };
        } else {
          // phase đã xong (thiết bị khác) → KHÔNG ghi, báo row hiện hữu (không đè thời gian)
          outcomes[sid] = {
            action: 'update', field: a.field,
            timeScanText: a.field === 'timeScan' ? (ex.timeScanText || fmt(now)) : '',
            timeScanEpoch: a.field === 'timeScan' ? num(ex.timeScanEpoch) : 0,
            timeRefText: a.field === 'timeRef' ? (ex.timeRefText || fmt(now)) : '',
            timeRefEpoch: a.field === 'timeRef' ? num(ex.timeRefEpoch) : 0,
            status: ex.status || STATUS.EXTRA,
            staffName: ex.staffName || null,
            slotCode: ex.slotCode || '', station: ex.station || '',
            team: ex.team || '', workstation: ex.workstation || '',
            dateText: (ex && ex.dateText) || '',
            rowIndex: ex._rowIndex || 0,
          };
        }
        return;
      }
      // append thật — enrich staffIndex (nếu có)
      const info = staffIndex ? staffIndex[sid] : null;
      const isScan = a.field === 'timeScan';
      appends.push([
        task.taskId, sid,
        info ? String(info.staffName || '') : '',
        info ? String(info.slotCode || '') : '',
        info ? String(info.station || '') : '',
        info ? String(info.team || '') : '',
        info ? String(info.workstation || '') : '',
        isScan ? '' : now,
        isScan ? now : '',
        a.status || STATUS.EXTRA,
        info ? String(info.date || '') : '',
      ]);
      outcomes[sid] = {
        action: 'append', field: a.field,
        timeScanText: isScan ? fmt(now) : '', timeScanEpoch: isScan ? now.getTime() : 0,
        timeRefText: isScan ? '' : fmt(now), timeRefEpoch: isScan ? 0 : now.getTime(),
        status: a.status || STATUS.EXTRA,
        staffName: info ? info.staffName || null : null,
        slotCode: info ? String(info.slotCode || '') : '',
        station: info ? String(info.station || '') : '',
        team: info ? String(info.team || '') : '',
        workstation: info ? String(info.workstation || '') : '',
        dateText: info ? String(info.date || '') : '',  // cột Ngày (StaffData Date) — bảng quét hiện ngay
        rowIndex: 0, // gán sau batchAppendLogRows_ (caller đối chiếu rowIndices)
      };
    }
  });
  return { updates: updates, appends: appends, outcomes: outcomes };
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
 * @param {Object} cfg — { STATUS, TASK_STATUS }
 * @param {Object} task — { taskId, status }
 * @param {Array<Object>} logRows — current log rows (with timeRefEpoch/timeScanEpoch)
 * @param {Array<string>} codes — array of raw codes from paste (one per line)
 * @returns {{plans: Array<{code, action, phase, field, status, reason, row}>, invalid: Array<{code, reason}>}}
 */
function planBatchScans(cfg, task, logRows, codes) {
  const plans = [];
  const invalid = [];
  // Regex barcode — 1 nguồn: CsvUtil.gs. GAS: global BARCODE_ID_RE (const CsvUtil, scope chung).
  // Node test (require('../ScanLogic.gs') standalone) không thấy global → require CsvUtil.
  const barcodeRe = typeof BARCODE_ID_RE !== 'undefined' ? BARCODE_ID_RE : require('./CsvUtil.gs').BARCODE_ID_RE;
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
    if (!barcodeRe.test(staffId)) {
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
 * @param {Array<Object>} tasks — danh sách task (taskFromRow_: taskId, station,
 *   slotCode, team, status, createdAtText, createdBy, ...). Map nhanh theo taskId.
 * @param {string} staffId — mã NV đã normalize (uppercase) để so khớp.
 * @returns {Array<Object>} — [{ taskId, staffId, staffName, status, station,
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
    canScanOpen_: canScanOpen_,
    planScanCommits: planScanCommits,
    planBatchScans: planBatchScans,
    matchLogsByStaff: matchLogsByStaff,
    matchTasksByQuery: matchTasksByQuery,
  };
}
