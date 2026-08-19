/**
 * TaskRepo.gs — Đọc/ghi sheet AttendanceTask (tách từ Database.gs 2026-08-11).
 *
 * - taskFromRow_/readTask_/readTaskCached_: map dòng sheet → object task.
 * - Mọi write qua insertTask_/updateTaskStatus_ (gọi bởi TaskService dưới LockService)
 *   và invalidate toàn bộ cache task (invalidateTaskCaches_).
 * - readTaskList_ merge counters từ AttendanceLog 1 lần (taskCountersForList_) — không N+1.
 */

/** Map 1 dòng sheet → object task (theo TASK_COLS). */
function taskFromRow_(row) {
  const createdAt = row[TASK_COLS.CREATED_AT] || null;
  const completedAt = row[TASK_COLS.COMPLETED_AT] || null;
  return {
    taskId: String(row[TASK_COLS.TASK_ID] || ''),
    station: String(row[TASK_COLS.STATION] || ''),
    slotCode: String(row[TASK_COLS.SLOT_CODE] || ''),
    team: String(row[TASK_COLS.TEAM] || ''),
    contractType: String(row[TASK_COLS.CONTRACT_TYPE] || ''),
    status: String(row[TASK_COLS.STATUS] || ''),
    date: String(row[TASK_COLS.DATE] || ''),
    // phase derived từ status cho client dễ render UI (Mở/Điểm danh/Xong).
    // open=phase1 (ghi LISTED_AT), attend=phase2 (ghi SCANNED_AT), done=Xong.
    phase: (function (st) {
      if (st === TASK_STATUS.ATTEND) return 'attend';
      if (st === TASK_STATUS.DONE) return 'done';
      return 'open';
    })(String(row[TASK_COLS.STATUS] || '')),
    // KHÔNG trả Date qua google.script.run (serialize lỗi → null toàn bộ).
    // Chỉ trả text đã format; createdBy/createdAtText đủ cho UI.
    createdBy: String(row[TASK_COLS.CREATED_BY] || ''),
    createdAtText: formatDateTime_(createdAt),
    completedAtText: formatDateTime_(completedAt),
  };
}

/** Đọc 1 task theo taskId (scan toàn bộ cột taskId — Phase 0 đơn giản). */
function readTask_(taskId) {
  const sheet = getSheet_(SHEETS.ATTENDANCE_TASK);
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][TASK_COLS.TASK_ID] || '').trim() === taskId) {
      const task = taskFromRow_(values[i]);
      task._rowIndex = i + 1; // 1-based cho update
      return task;
    }
  }
  return null;
}

/**
 * m3 (audit): đọc task theo taskId CÓ CACHE ngắn (TTL 60s) — dành cho ĐƯỜNG QUÉT
 * (scanStaff đọc mỗi lượt, không getDataRange full AttendanceTask mỗi scan).
 * AN TOÀN: mọi write vào AttendanceTask đều qua insertTask_/updateTaskStatus_
 * (cùng LockService) và invalidate key này → cache không bao giờ stale lâu hơn
 * khoảng giữa 2 write; status đọc ra luôn là trạng thái mới nhất đã ghi.
 * Đường quyết định trạng thái (complete/transition/reopen) vẫn dùng readTask_ tươi.
 * @param {string} taskId
 * @returns {Object|null}
 */
function readTaskCached_(taskId) {
  return cachedJson_(CACHE_KEYS.TASK + taskId, function () {
    return readTask_(taskId);
  }, CACHE_TTL.TASK);
}

/** Xoá task cache 1 task (gọi sau insertTask_/updateTaskStatus_). */
function invalidateTaskCache_(taskId) {
  if (!taskId) return;
  try { cache_().remove(CACHE_KEYS.TASK + taskId); }
  catch (e) { console.warn('invalidateTaskCache_ fail', taskId, e.message); }
  bumpCacheGen_();
}

/** Xoá mọi cache task sau khi ghi AttendanceTask — thêm TASK cache chỉ đổi ở 1 chỗ. */
function invalidateTaskCaches_(taskId) {
  invalidateTaskListCache_();
  invalidateTaskDetailCache_(taskId);
  invalidateTaskCache_(taskId);
}

/** Ghi task mới (append — tần suất thấp, chấp nhận appendRow). */
function insertTask_(task) {
  if (!requireRole_('operator')) return;  // M1: repo mutator global — chặn gọi trực tiếp qua google.script.run
  getSheet_(SHEETS.ATTENDANCE_TASK).appendRow([
    task.taskId, task.station, task.slotCode, task.team,
    task.contractType || '', task.status, task.createdAt, task.createdBy, task.completedAt || '',
    task.date || '',
  ]);
  // F5 + m3: phá negative cache (readTaskDetailCached_/readTaskCached_ cache null 15s/60s
  // nếu RPC đọc trước khi task tồn tại — taskId dạng giờ-tạo có thể trùng giữa 2 create).
  invalidateTaskCaches_(task.taskId);
}

/** Ghi 1 dòng task: sửa 3 cell trong memory rồi setValues 1 lần (idempotent cột không đụng). */
function writeTaskRow_(sheet, r, vals, status, completedAt, contractType) {
  vals[TASK_COLS.CONTRACT_TYPE] = contractType || '';
  vals[TASK_COLS.STATUS] = status;
  vals[TASK_COLS.COMPLETED_AT] = completedAt || '';
  sheet.getRange(r, 1, 1, TASK_COL_COUNT).setValues([vals]);
}

/** Cập nhật trạng thái task (status, completedAt). */
function updateTaskStatus_(taskId, status, completedAt, rowIndex, contractType) {
  if (!requireRole_('operator')) return false;  // M1: đổi trạng thái task — chỉ operator+
  const sheet = getSheet_(SHEETS.ATTENDANCE_TASK);
  // m3 (audit): ghi 1 setValues cho cả dòng — CONTRACT_TYPE=4, STATUS=5, COMPLETED_AT=8
  // KHÔNG liền nhau (CREATED_AT=7/CREATED_BY=8 xen giữa) nên phải đọc dòng → sửa trong
  // memory → ghi cả dòng (idempotent cột không đụng, chống lỗi v1 completedAt đè CREATED_AT).
  // 2 nhánh dùng CHUNG writeTaskRow_ — trước có 2 bản copy (rủi ro drift).
  // F4: rowIndex optional — CẢ 3 caller (completeTask/transitionToAttend/reopenTask) đều
  // truyền _rowIndex (đã readTask_ tươi), nhánh loop chỉ là fallback legacy thủ công.
  if (rowIndex) {
    const rowVals = sheet.getRange(rowIndex, 1, 1, TASK_COL_COUNT).getValues()[0];
    // Row-integrity (review 2026-08-19): rowIndex phải thuộc taskId — gọi sai (rowIndex
    // của task khác) fallback quét theo taskId thay vì ghi nhầm dòng dữ liệu người khác.
    if (String(rowVals[TASK_COLS.TASK_ID] || '').trim() !== taskId) {
      console.error('updateTaskStatus_ rowIndex mismatch', taskId, rowIndex, String(rowVals[TASK_COLS.TASK_ID] || ''));
      return updateTaskStatus_(taskId, status, completedAt, 0, contractType);
    }
    writeTaskRow_(sheet, rowIndex, rowVals, status, completedAt, contractType);
    invalidateTaskCaches_(taskId);
    return true;
  }
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][TASK_COLS.TASK_ID] || '').trim() === taskId) {
      writeTaskRow_(sheet, i + 1, values[i].slice(), status, completedAt, contractType);
      invalidateTaskCaches_(taskId);
      return true;
    }
  }
  return false;
}

/** Danh sách task (cache 30s) — mới nhất lên đầu. */
function readTaskList_() {
  return cachedJson_(CACHE_KEYS.TASK_LIST, function () {
    const sheet = getSheet_(SHEETS.ATTENDANCE_TASK);
    const values = sheet.getDataRange().getValues();
    const out = [];
    for (let i = 1; i < values.length; i++) {
      const task = taskFromRow_(values[i]);
      if (task.taskId) out.push(task);
    }
    // Merge counters (total/scanned/extra) từ AttendanceLog — 1 lần đọc log + group,
    // không N+1 đọc log riêng từng task. (User yêu cầu cột đếm ở danh sách task.)
    const counters = taskCountersForList_();
    out.forEach(function (t) {
      const c = counters[t.taskId] || { total: 0, scanned: 0, extra: 0 };
      t.total = c.total; t.scanned = c.scanned; t.extra = c.extra;
    });
    // Fix (audit 2026-08-11): sort taskId desc thay vì out.reverse() — reverse() giả định
    // sheet append-only; user sort tay AttendanceTask trong Sheets UI → thứ tự hiển thị sai.
    // taskId = RyyyyMMdd-HHmm (+suffix -2/-3) — sort chuỗi desc đúng newest-first kể cả trùng phút.
    out.sort(function (a, b) { return (a.taskId < b.taskId) ? 1 : (a.taskId > b.taskId ? -1 : 0); });
    return out;
  }, CACHE_TTL.TASK_LIST);
}

/** Đếm total/scanned/extra theo taskId cho DANH SÁCH task (cache 30s).
 * Đọc AttendanceLog 1 lần rồi group — tránh N+1. scanned theo epoch
 * (nguồn sự thật — khớp computeCounters). */
function taskCountersForList_() {
  return cachedJson_(CACHE_KEYS.TASK_COUNTS + 'all', function () {
    const sheet = getSheet_(SHEETS.ATTENDANCE_LOG);
    const values = sheet.getDataRange().getValues();
    const out = {};
    for (let i = 1; i < values.length; i++) {
      const row = values[i];
      const taskId = String(row[LOG_COLS.TASK_ID] || '').trim();
      if (!taskId) continue;
      const st = String(row[LOG_COLS.STATUS] || '');
      // S3/D1 (review 2026-08-11): epoch là nguồn sự thật — khớp computeCounters
      // (Number(scannedAtEpoch)>0, ScanLogic.gs:124). Trước dùng !!cell — cell junk/
      // string legacy (safeDate_ parse fail) vẫn tính scanned → list lệch detail.
      const dScan = safeDate_(row[LOG_COLS.SCANNED_AT]);
      const hasScan = dScan ? dScan.getTime() > 0 : false;
      if (!out[taskId]) out[taskId] = { total: 0, scanned: 0, extra: 0 };
      out[taskId].total++;
      if (hasScan) out[taskId].scanned++;
      if (st === STATUS.EXTRA) out[taskId].extra++;
    }
    return out;
  }, CACHE_TTL.TASK_COUNTS);
}

function invalidateTaskListCache_() {
  cache_().remove(CACHE_KEYS.TASK_LIST);
  // P3: counters list đọc 1 lần + cache riêng — phải xóa cùng TASK_LIST, nếu không
  // task mới/reopen hiển thị total/scanned sai đến 30s (2 key độc lập không sync).
  cache_().remove(CACHE_KEYS.TASK_COUNTS + 'all');
  bumpCacheGen_();
}

/**
 * Tìm kiếm task theo mã (prefix/contains, case-insensitive) — cho ô tìm header mở rộng.
 * Dùng readTaskList_ (đã cache 30s + counters) → KHÔNG đọc sheet riêng. Logic lọc do
 * matchTasksByQuery (ScanLogic.gs, pure) — test Node được.
 *
 * @param {string} rawQ — chuỗi nhập (mã task, ví dụ "R202608" / "2352")
 * @returns {Array<Object>} — tasks khớp (giữ counters từ readTaskList_), limit 50
 */
function searchTasksByQuery(rawQ) {
  if (!requireRole_('viewer')) return [];
  const q = String(rawQ || '').trim();
  if (!q) return [];
  try {
    const tasks = readTaskList_() || [];
    return matchTasksByQuery(tasks, q);
  } catch (e) {
    console.error({ bench: 'searchTasksByQuery', q: q, error: e && e.message });
    return [];
  }
}
