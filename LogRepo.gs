/**
 * LogRepo.gs — Đọc/ghi sheet AttendanceLog (tách từ Database.gs 2026-08-11).
 *
 * - logFromRow_/readLogRows_: map dòng sheet → object log (text + epoch — không Date).
 * - Đường quét dùng readLogRowsCached_ (cache 30s + incremental qua updateLogRowCache_).
 * - Batch helpers: batchInsertLogRows_/batchAppendLogRows_/batchUpdateLogRows_/
 *   transformLogStatuses_ — 1 setValues cho nhiều dòng, KHÔNG loop.
 * - Mọi ghi log → invalidateTaskDetailCache_ + invalidateTaskListCache_.
 */

/** Đặt trạng thái mới cho 1 update (newStatus ưu tiên, fallback keepStatus). */
function resolvedStatus_(u) {
  if (u.newStatus !== undefined) return u.newStatus;
  if (u.keepStatus !== undefined) return u.keepStatus;
  console.warn('resolvedStatus_: thiếu newStatus AND keepStatus — ghi cell status rỗng', JSON.stringify(u));
  return '';
}

/** Map 1 dòng sheet → object log (theo LOG_COLS). */
function logFromRow_(taskId, row) {
  const timeRef = row[LOG_COLS.LISTED_AT] || null;
  const timeScan = row[LOG_COLS.SCANNED_AT] || null;
  // Parse 1 lần duy nhất — tránh gọi safeDate_ + Date.parse 3-4 lần/dòng.
  const dRef = safeDate_(timeRef);
  const dScan = safeDate_(timeScan);
  return {
    taskId: taskId,
    staffId: String(row[LOG_COLS.STAFF_ID] || '').trim(),
    staffName: String(row[LOG_COLS.STAFF_NAME] || ''),
    slotCode: String(row[LOG_COLS.SLOT_CODE] || ''),
    station: String(row[LOG_COLS.STATION] || ''),
    team: String(row[LOG_COLS.TEAM] || ''),
    workstation: String(row[LOG_COLS.WORKSTATION] || ''),
    // KHÔNG trả Date qua google.script.run (serialize lỗi → null toàn bộ).
    // Chỉ trả text đã format theo TZ script — client hiển thị trực tiếp.
    listedAtText: formatTime_(timeRef),
    scannedAtText: formatTime_(timeScan),
    // Sort key số (epoch ms) — text "HH:mm:ss" mất ngày → sort chuỗi sai khi task
    // xuyên nửa đêm. Client sort theo con số này (chính xác tuyệt đối).
    listedAtEpoch: dRef ? dRef.getTime() : 0,
    scannedAtEpoch: dScan ? dScan.getTime() : 0,
    status: String(row[LOG_COLS.STATUS] || ''),
    // Date = ngay vao lam (copy tu StaffData) — format yyyy-MM-dd (ISO) cho hien thi
    dateText: formatDateShort_(row[LOG_COLS.DATE]),
  };
}

/** Đọc toàn bộ dòng log của task (đọc tươi từ sheet — không cache). */
function readLogRows_(taskId) {
  const sheet = getSheet_(SHEETS.ATTENDANCE_LOG);
  const values = sheet.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][LOG_COLS.TASK_ID] || '').trim() === taskId) {
      const row = logFromRow_(taskId, values[i]);
      row._rowIndex = i + 1; // 1-based cho update
      out.push(row);
    }
  }
  return out;
}

/**
 * Tìm kiếm log của 1 mã NV (Opsxxxxx) XUYÊN TASK — cho tính năng search header.
 * Đọc ATTENDANCE_LOG toàn bộ (filter STAFF_ID), join thông tin task từ readTaskList_()
 * (cache 30s). Logic lọc/join/sort/limit do matchLogsByStaff (ScanLogic.gs, pure) thực hiện —
 * test được Node mà không cần mock sheet.
 *
 * LƯU Ý: chỉ trả GIÁ TRỊ GỐC (taskStatus, createdBy nguyên email). Các label
 * (Đối chiếu/Tự do, Mở/Điểm danh/Xong, displayName) do CLIENT tính — tránh phụ thuộc hàm
 * client-only (displayName) vào server (ReferenceError trong GAS).
 *
 * @param {string} rawStaffId — mã NV người dùng nhập (có thể có case/space)
 * @returns {Array<Object>} — kết quả từ matchLogsByStaff
 */
function searchLogsByStaff(rawStaffId) {
  const sid = normalizeStaffId(rawStaffId);
  if (!sid) return [];
  if (!requireRole_('manager')) return [];  // M1: gate service-layer — google.script.run gọi trực tiếp hàm global phải bị chặn (không chỉ ở wrapper)
  // Cache 15s theo staffId — tìm cùng mã liên tiếp không quét lại toàn sheet log
  // (sheet lớn = vài giây GAS); kết quả join task meta từ readTaskList_ (cache 30s).
  return cachedJson_(CACHE_KEYS.SEARCH_STAFF + sid, function () {
    try {
      const logSheet = getSheet_(SHEETS.ATTENDANCE_LOG);
      const values = logSheet.getDataRange().getValues();
      // Map toán bộ dòng log (cross-task) thành đối tượng — tái dùng logFromRow_.
      const logRows = [];
      for (let i = 1; i < values.length; i++) {
        const tid = String(values[i][LOG_COLS.TASK_ID] || '').trim();
        if (!tid) continue;
        // S1 (perf audit): chỉ format date khi đúng staffId — tránh logFromRow_ chạy
        // 2× formatDate cho mọi dòng sheet log vài chục nghìn dòng.
        if (normalizeStaffId(String(values[i][LOG_COLS.STAFF_ID] || '')) !== sid) continue;
        logRows.push(logFromRow_(tid, values[i]));
      }
      var tasks = [];
      try { tasks = readTaskList_() || []; } catch (e) { console.warn('searchLogsByStaff readTaskList_ fail', e.message); }
      return matchLogsByStaff(logRows, tasks, sid);
    } catch (e) {
      console.error({ bench: 'searchLogsByStaff', staffId: sid, error: e && e.message });
      return [];
    }
  }, CACHE_TTL.SEARCH_STAFF);
}

/**
 * Đọc log rows của task có cache (30s) — dành cho ĐƯỜNG QUÉT (U2/scanStaff).
 * V2 khác v1: update-in-place (không append-only) nên không áp dynamic tail-rows;
 * thay bằng cache ngắn hạn + INCREMENTAL update (updateLogRowCache_) — scan chạy
 * liên tiếp không chạm sheet log, chỉ 1 setValues cho dòng được quét.
 * F2 (simplify): cache SLIM — chỉ giữ field đường quét cần (staffId/staffName/
 * scannedAtText/scannedAtEpoch/status/_rowIndex), KHÔNG nhét 12 field: 66KB→32KB
 * (tránh chạm giới hạn 100KB/key khi task lớn, giảm eviction 500KB script cache).
 * _rowIndex giữ nguyên (cần cho update) — KHÔNG dùng bản này cho UI (dùng riêng
 * readTaskDetailCached_).
 */
function readLogRowsCached_(taskId) {
  return cachedJson_(CACHE_KEYS.LOG_ROWS + taskId, function () {
    return readLogRows_(taskId).map(function (r) {
      return {
        taskId: taskId,          // update log row write cần (invalidate detail/update cache)
        staffId: r.staffId,
        staffName: r.staffName,
        slotCode: r.slotCode,
        station: r.station,
        team: r.team,
        listedAtText: r.listedAtText,
        listedAtEpoch: r.listedAtEpoch,
        scannedAtText: r.scannedAtText,
        scannedAtEpoch: r.scannedAtEpoch,
        status: r.status,
        dateText: r.dateText,
        _rowIndex: r._rowIndex,
      };
    });
  }, CACHE_TTL.LOG_ROWS);
}

/** Xoá cache log rows của task (gọi khi ghi batch/append mới — không cần cho scan update). */
function invalidateLogRows_(taskId) {
  try { cache_().remove(CACHE_KEYS.LOG_ROWS + taskId); }
  catch (e) { console.warn('invalidateLogRows_ fail', taskId, e.message); }  // F6: không giấu lỗi âm thầm (cache sống tiếp → duplicate Dư)
  bumpCacheGen_();
}

/**
 * Pre-fill log batch 1 lần (createTask A3 — nạp roster lúc tạo task) — KHÔNG appendRow trong loop.
 * @param {string} taskId
 * @param {Array<Object>} staffList — NV khớp tổ hợp
 * @param {Date} createdAt
 */
function batchInsertLogRows_(taskId, staffList, createdAt, opts) {
  if (!requireRole_('operator')) return 0;  // M1: repo mutator global — chặn gọi trực tiếp qua google.script.run (không chỉ ở *Api wrapper)
  if (!staffList || !staffList.length) return 0;
  const sheet = getSheet_(SHEETS.ATTENDANCE_LOG);
  const startRow = sheet.getLastRow() + 1;
  const rows = staffList.map(function (s) {
    return [
      taskId, s.staffId, s.staffName, s.slotCode, s.station, s.team, s.workstation,
      opts && opts.noListedAt ? '' : createdAt, '', STATUS.PENDING, s.date || '',
    ];
  });
  sheet.getRange(startRow, 1, rows.length, LOG_COL_COUNT).setValues(rows);
  invalidateLogRows_(taskId);
  invalidateTaskCaches_(taskId);
  return rows.length;
}

/**
 * T-2: Batch append log rows for paste feature.
 * 1 setValues for N new rows + 1 LOG_ROWS cache update (not per-row).
 * Each row in `rows` should be a full LOG_COL_COUNT array.
 * Returns { startRow, count, rowIndices[] } for cache update.
 */
function batchAppendLogRows_(rows) {
  if (!requireRole_('operator')) return { startRow: 0, count: 0, rowIndices: [] };
  if (!rows || !rows.length) return { startRow: 0, count: 0, rowIndices: [] };
  const sheet = getSheet_(SHEETS.ATTENDANCE_LOG);
  const startRow = sheet.getLastRow() + 1;
  // FIX: hoist const taskId len dau ham — truoc do khai ben trong try (block-scoped)
  // nen cac goi catch/ngoai try (invalidateLogRows_/invalidateTaskDetailCache_) throw
  // ReferenceError: taskId is not defined SAU khi setValues da ghi xong -> sheet co data
  // nếu ghi fail sau setValues: client không loadTaskDetail -> danh sách không refresh.
  const taskIds = {}; rows.forEach(function(r){ var tid=String(r[0]||'').trim(); if(tid) taskIds[tid]=true; });
  const taskId = String(rows[0][0] || '').trim(); // taskId is first column (primary)
  sheet.getRange(startRow, 1, rows.length, LOG_COL_COUNT).setValues(rows);
  // Build row indices for cache update
  const rowIndices = [];
  for (let i = 0; i < rows.length; i++) {
    rowIndices.push(startRow + i);
  }
  // Update LOG_ROWS cache in ONE put (not per-row pushLogRowToCache_)
    try {
      const key = CACHE_KEYS.LOG_ROWS + taskId;
      const cached = cacheGet_(key);
      if (cached !== null) {
        const cachedRows = JSON.parse(cached);
        // Append slim versions of new rows
        rows.forEach(function (row, idx) {
          const timeRef = row[LOG_COLS.LISTED_AT];
          const timeScan = row[LOG_COLS.SCANNED_AT];
          // Parse 1 lần duy nhất — tránh gọi safeDate_ nhiều lần.
          const dRef = timeRef ? safeDate_(timeRef) : null;
          const dScan = timeScan ? safeDate_(timeScan) : null;
          cachedRows.push({
            taskId: taskId,
            staffId: row[LOG_COLS.STAFF_ID],
            staffName: row[LOG_COLS.STAFF_NAME],
            slotCode: row[LOG_COLS.SLOT_CODE],
            station: row[LOG_COLS.STATION],
            team: row[LOG_COLS.TEAM],
            listedAtText: timeRef ? formatTime_(timeRef) : '',
            listedAtEpoch: dRef ? dRef.getTime() : 0,
            scannedAtText: timeScan ? formatTime_(timeScan) : '',
            scannedAtEpoch: dScan ? dScan.getTime() : 0,
            status: row[LOG_COLS.STATUS],
            dateText: formatDateShort_(row[LOG_COLS.DATE]),
            _rowIndex: rowIndices[idx],
          });
        });
        cachePut_(key, JSON.stringify(cachedRows), CACHE_TTL.LOG_ROWS);
      }
    } catch (e) {
    console.warn('batchAppendLogRows_ cache update fail', e.message);
    invalidateLogRows_(taskId); // force rebuild
  }
  if (Object.keys(taskIds).length === 1) {
    invalidateTaskDetailCache_(taskId);
  } else {
    Object.keys(taskIds).forEach(function(tid){ try{invalidateTaskDetailCache_(tid);}catch(e){} try{invalidateLogRows_(tid);}catch(e){} });
  }
  invalidateTaskListCache_();
  return { startRow: startRow, count: rows.length, rowIndices: rowIndices };
}

/**
 * Đọc chi tiết task + log có cache (giảm đọc sheet khi chuyển task qua lại).
 * Invalidate bằng invalidateTaskDetailCache_(taskId) mỗi khi ghi log/đổi status.
 * Lưu ý: task/log chỉ chứa text (formatTime_) — cache JSON an toàn (không Date).
 */
function readTaskDetailCached_(taskId) {
  return cachedJson_(CACHE_KEYS.TASK_DETAIL + taskId, function () {
    const task = readTask_(taskId);
    if (!task) return null;
    // m6 (audit): slim log TRƯỚC khi cache — trước đây ném full 12-field (readLogRows_)
    // → task 1000 NV JSON >100KB/key → cache_().put throw + warn → miss âm thầm →
    // mỗi lần load lại đọc cả sheet. Cùng schema slim như readLogRowsCached_ (text+epoch,
    // không Date) để giữ dưới 100KB khi task lớn.
    const log = readLogRows_(taskId).map(function (r) {
      return {
        taskId: r.taskId,
        staffId: r.staffId,
        staffName: r.staffName,
        slotCode: r.slotCode,
        station: r.station,
        team: r.team,
        workstation: r.workstation,
        listedAtText: r.listedAtText,
        listedAtEpoch: r.listedAtEpoch,
        scannedAtText: r.scannedAtText,
        scannedAtEpoch: r.scannedAtEpoch,
        status: r.status,
        dateText: r.dateText,
      };
    });
    const counters = computeCounters({ STATUS: STATUS }, log);
    // P3: strip _rowIndex + phase khỏi cache — khách cache miss client tính phase lại.
    delete task._rowIndex;
    delete task.phase;
    return { task: task, log: log, counters: counters };
  }, CACHE_TTL.TASK_DETAIL);
}

/** Xoá cache chi tiết task — gọi sau mọi ghi log/đổi status. */
function invalidateTaskDetailCache_(taskId) {
  try { cache_().remove(CACHE_KEYS.TASK_DETAIL + taskId); }
  catch (e) { console.warn('cache remove fail', CACHE_KEYS.TASK_DETAIL + taskId, e.message); }
  bumpCacheGen_();
}

/**
 * Chuyển status hàng loạt cho 1 task — batch setValues 1 lần cả cột status.
 * Dùng chung cho markUnscannedAbsent_ (kết thúc) và resetAbsentToPending_ (mở lại).
 * P1: batch setValues — KHÔNG setValue trong loop (241 NV = 241 calls → timeout risk).
 * P1: gom run liên tiếp — 1 setValues/run (worst case 241 NV quét xen kẽ = ~240 RPC → 12-24s).
 * m6 (audit 2026-08-11): CHỈ ghi dòng task bị đổi (trước: cả dải firstRow..lastRow — task có
 * dòng append ở cuối sheet, dải trùm dòng task khác → rewrite thừa giá trị cũ trên phạm vi rộng).
 * Không đụng dòng ngoài task. An toàn vì caller giữ LockService.
 * @param {string} taskId
 * @param {function(string, any): string|null} mutate — (status, timeScan) => status mới
 *   hoặc null (không đổi)
 * @returns {number} số dòng đã đổi
 */
function transformLogStatuses_(taskId, mutate, logRows) {
  if (!requireRole_('operator')) return 0;  // M1: dùng chung markUnscannedAbsent_/resetAbsentToPending_ — chặn gọi trực tiếp
  const sheet = getSheet_(SHEETS.ATTENDANCE_LOG);
  // F3 (perf): nhận logRows đã đọc (từ completeTask) thay vì getDataRange().getValues() toàn
  // sheet lần 2. Không truyền → fallback readLogRows_. Epoch là nguồn sự thật cho hasScan.
  const rows = logRows || readLogRows_(taskId);
  const changed = [];
  rows.forEach(function (row) {
    if (String(row.taskId || '').trim() !== taskId) return;
    const timeScan = Number(row.scannedAtEpoch) || 0;
    const status = String(row.status || '');
    const next = mutate(status, timeScan);
    if (next !== null && next !== status) changed.push({ r: row._rowIndex, v: next });
  });
  if (!changed.length) return 0;
  const statusCol = LOG_COLS.STATUS + 1;
  const runs = [];
  changed.forEach(function (c2) {
    const lastRun = runs[runs.length - 1];
    if (lastRun && lastRun.end === c2.r - 1) { lastRun.end = c2.r; }
    else runs.push({ start: c2.r, end: c2.r });
  });
  let ci = 0;
  runs.forEach(function (run) {
    const col = [];
    for (let r = run.start; r <= run.end; r++) { col.push([changed[ci].v]); ci++; }
    sheet.getRange(run.start, statusCol, col.length, 1).setValues(col);
  });
  invalidateLogRows_(taskId);
  invalidateTaskDetailCache_(taskId);
  return changed.length;
}

/** Khi kết thúc task: chuyển dòng chưa quét (timeScan rỗng, status '-') thành 'Vắng'. */
function markUnscannedAbsent_(taskId, logRows) {
  return transformLogStatuses_(taskId, function (status, timeScan) {
    // Epoch là nguồn sự thật — timeScan truyền vào là scannedAtEpoch (number). cell junk
    // parse fail → epoch 0 → KHÔNG tính là đã quét (trước dùng truthiness cell lạ → nhầm PRESENT).
    const hasScan = Number(timeScan) > 0;
    if (hasScan && status === STATUS.PENDING) {
      // Insurance data-repair — dòng có timeScan nhưng status còn '-' (data legacy/sửa tay;
      // mọi write path ghi 2 cột atomic dưới LockService → luồng bình thường không sinh state này).
      // KHÔNG đánh Vắng — chuẩn hóa thành Có mặt.
      return STATUS.PRESENT;
    }
    if (!hasScan && status === STATUS.PENDING) return STATUS.ABSENT;
    return null;
  }, logRows);
}

/** Mở lại task: reset NV Vắng (ABSENT) về Chưa điểm danh (PENDING). NV Có mặt giữ nguyên. */
function resetAbsentToPending_(taskId) {
  const n = transformLogStatuses_(taskId, function (status) {
    return status === STATUS.ABSENT ? STATUS.PENDING : null;
  });
  // Reopen đổi status task → danh sách cần refresh counters (khác mark: completeTask
  // tự gọi updateTaskStatus_ → invalidateTaskListCache_ kế đó, nên mark không cần ở đây).
  if (n > 0) invalidateTaskListCache_();
  return n;
}




/**
 * M1 (audit): ghi 1 đợt update log rows — gom (row, field, time, status) + invalidate
 * CHUNG 1 lần + LOG_ROWS cache updated trong cùng get/put 1 pass.
 * Audit 2 (ghi THEO FIELD): timeRef → chỉ cột TIME_REF (1 cột); timeScan →
 * TIME_SCAN + STATUS (2 cột) — KHÔNG setValues cả 3 cột, tránh ghi '' vào cột không
 * đụng tới → xóa giá trị hiện hữu (legacy v1 / sửa tay). Khớp updateLogRowRef_/updateLogRowScan_.
 * @param {string} taskId
 * @param {Array<{rowIndex:number, field:'listedAt'|'scannedAt', time:Date, newStatus?:string, keepStatus?:string}>} updates
 */
function batchUpdateLogRows_(taskId, updates) {
  if (!requireRole_('operator')) return 0;
  if (!updates || !updates.length) return 0;
  const sheet = getSheet_(SHEETS.ATTENDANCE_LOG);
  // Row-integrity (review 2026-08-19): bỏ update có rowIndex KHÔNG thuộc taskId — gọi sai
  // (rowIndex task khác) không được ghi nhầm dòng dữ liệu người khác. Đọc 1 dải cột
  // TASK_ID (min..max rowIndex) rồi lọc — không đọc full sheet.
  let minRow = updates[0].rowIndex, maxRow = updates[0].rowIndex;
  updates.forEach(function (u) {
    if (u.rowIndex < minRow) minRow = u.rowIndex;
    if (u.rowIndex > maxRow) maxRow = u.rowIndex;
  });
  const idCells = sheet.getRange(minRow, LOG_COLS.TASK_ID + 1, maxRow - minRow + 1, 1).getValues();
  const okRows = {};
  idCells.forEach(function (c, i) { if (String(c[0] || '').trim() === taskId) okRows[minRow + i] = true; });
  const valid = updates.filter(function (u) { return !!okRows[u.rowIndex]; });
  if (!valid.length) return 0;
  // Fix 1 (audit 2): ghi CHỈ đúng cột của field — trước đây setValues cả 3 cột
  // (timeRef/timeScan/status) nên update timeRef ghi '' vào TIME_SCAN → xoá sạch giá
  // trị hiện hữu (legacy v1 / sửa tay). Tách: timeRef → 1 cột TIME_REF,
  // timeScan → 2 cột TIME_SCAN+STATUS (khớp updateLogRowRef_/updateLogRowScan_ cũ).
  writeBatchRuns_(sheet, valid, 'listedAt');
  writeBatchRuns_(sheet, valid, 'scannedAt');
  invalidateTaskCaches_(taskId);
  try {
    const key = CACHE_KEYS.LOG_ROWS + taskId;
    const cached = cacheGet_(key);
    if (cached !== null) {
      const rows = JSON.parse(cached);
      const idxMap = {};
      for (let k = 0; k < rows.length; k++) idxMap[rows[k]._rowIndex] = k;
      valid.forEach(function (u) {
        const k = idxMap[u.rowIndex];
        if (k === undefined) return;
        if (u.field === 'scannedAt') {
          rows[k].scannedAtText = formatTime_(u.time);
          rows[k].scannedAtEpoch = u.time.getTime();
          // n2: resolve status 1 nguồn, cache khớp sheet (resolvedStatus_: newStatus → keepStatus)
          rows[k].status = resolvedStatus_(u);
        } else {
          rows[k].listedAtText = formatTime_(u.time);
          rows[k].listedAtEpoch = u.time.getTime();
          if (u.keepStatus !== undefined) rows[k].status = u.keepStatus;
        }
      });
      cachePut_(key, JSON.stringify(rows), CACHE_TTL.LOG_ROWS);
    }
  } catch (e) {
    console.warn('batchUpdateLogRows_ cache fail', taskId, e.message);
    invalidateLogRows_(taskId);
  }
  return valid.length;
}

/**
 * Helper ghi batch theo field — mỗi field chỉ đụng đúng cột mình cần.
 * timeRef: cột TIME_REF (1 cột); timeScan: TIME_SCAN + STATUS (2 cột).
 * Nhóm dòng liên tiếp (contiguous run) để tối đa 1 setValues/run.
 */
function writeBatchRuns_(sheet, updates, field) {
  if (!requireRole_('operator')) return;  // M1: ghi batch 1 field — caller đã gate nhưng global vẫn gọi trực tiếp được
  const runData = updates.filter(function (u) { return u.field === field; });
  if (!runData.length) return;
  const sorted = runData.slice().sort(function (a, b) { return a.rowIndex - b.rowIndex; });
  const col = (field === 'listedAt' ? LOG_COLS.LISTED_AT : LOG_COLS.SCANNED_AT) + 1;
  const width = field === 'listedAt' ? 1 : 2;
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i].rowIndex;
    let end = start, j = i;
    while (j + 1 < sorted.length && sorted[j + 1].rowIndex === end + 1) { end++; j++; }
    const block = [];
    for (let r = start; r <= end; r++) {
      const up = sorted[i + (r - start)];
      if (field === 'listedAt') {
        block.push([up.time]);
      } else {
        // n2 (audit): KHÔNG bao giờ ghi '' vào STATUS khi thiếu newStatus — fallback
        // keepStatus (ghi lại giá trị hiện hữu = idempotent) thay vì xoá sạch cell.
        block.push([up.time, resolvedStatus_(up)]);
      }
    }
    sheet.getRange(start, col, block.length, width).setValues(block);
    i = j + 1;
  }
}

/**
 * Sua trang thai 1 dong log (fix thu cong - owner/admin qua TaskService.updateLogRowStatus).
 * newStatus PRESENT + scanTime != null → ghi TIME_SCAN + STATUS (2 cot lien nhau).
 * L1: clearScanned/clearListed — doi nguoc PRESENT→ABSENT/PENDING phai xoa SCANNED_AT
 * (computeCounters dem scanned theo scannedAtEpoch>0); ve PENDING xoa luon LISTED_AT.
 * Cot 7..9 (LISTED_AT..STATUS) lien nhau → 1 setValues. Caller giu LockService.
 */
function setLogRowStatus_(taskId, rowIndex, newStatus, scanTime, clearScanned, clearListed) {
  if (!requireRole_('operator')) return;  // M1: ghi trạng thái log — chỉ operator+
  const sheet = getSheet_(SHEETS.ATTENDANCE_LOG);
  // Row-integrity (review 2026-08-19): rowIndex phải thuộc taskId — gọi sai (rowIndex
  // task khác / taskId khác) chặn luôn, không ghi nhầm dòng người khác.
  const rowTaskId = String(sheet.getRange(rowIndex, LOG_COLS.TASK_ID + 1, 1, 1).getValues()[0][0] || '').trim();
  if (rowTaskId !== taskId) {
    console.error('setLogRowStatus_ row mismatch', taskId, rowIndex, rowTaskId);
    return;
  }
  if (clearScanned && clearListed) {
    sheet.getRange(rowIndex, LOG_COLS.LISTED_AT + 1, 1, 3).setValues([['', '', newStatus]]);
  } else if (clearScanned) {
    sheet.getRange(rowIndex, LOG_COLS.SCANNED_AT + 1, 1, 2).setValues([['', newStatus]]);
  } else if (clearListed) {
    // clearListed-only (ABSENT→PENDING — dòng không có scan): LISTED_AT + STATUS KHÔNG liền
    // (SCANNED_AT chen giữa) → 2 setValues riêng; SCANNED_AT giữ nguyên.
    sheet.getRange(rowIndex, LOG_COLS.LISTED_AT + 1, 1, 1).setValues([['']]);
    sheet.getRange(rowIndex, LOG_COLS.STATUS + 1, 1, 1).setValues([[newStatus]]);
  } else if (scanTime) {
    sheet.getRange(rowIndex, LOG_COLS.SCANNED_AT + 1, 1, 2).setValues([[scanTime, newStatus]]);
  } else {
    sheet.getRange(rowIndex, LOG_COLS.STATUS + 1, 1, 1).setValues([[newStatus]]);
  }
  invalidateLogRows_(taskId);
  invalidateTaskCaches_(taskId);
}
