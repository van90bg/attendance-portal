/**
 * Database.gs — Lớp truy cập GAS (Spreadsheet + CacheService).
 *
 * Gọi GAS API — KHÔNG test Node trực tiếp (logic thuần nằm ở CsvUtil/ScanLogic).
 * Patterns (v1 lesson):
 * - Batch setValues() — KHÔNG appendRow trong loop
 * - Cache version-key (CACHE_KEYS.*_v1) để invalidate dễ
 * - Timezone cache 1 lần — KHÔNG gọi Session.getScriptTimeZone() trong loop
 */

/** Lấy sheet theo tên, tạo mới nếu chưa có (kèm header nếu chỉ định). */
function getSheet_(name, header) {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    // P2: sheet dữ liệu bị xóa tay → tạo lại trống, dữ liệu cũ mất. Cache vẫn sống → UI sai.
    // Log rõ tên sheet để QA/operator phát hiện sớm.
    if (name === SHEETS.ATTENDANCE_LOG || name === SHEETS.ATTENDANCE_TASK || name === SHEETS.STAFF_DATA) {
      console.error('SHEET MISSING — vừa tạo lại sheet "' + name + '" (bị xóa tay?). Dữ liệu cũ KHÔNG khôi phục.');
    }
  }
  // Tự set header CHỈ khi sheet hoàn toàn trống (chưa có dữ liệu).
  // LƯU Ý: sheet cũ có data nhưng thiếu header sẽ KHÔNG được vá tự động ở đây
  // (tránh ghi đè header lên dòng 1 đang là data) — xem ensureSheets_ migration.
  if (header && header.length && sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  }
  return sheet;
}

/**
 * Spreadsheet chứa dữ liệu.
 * Thứ tự ưu tiên: DEFAULT_SPREADSHEET_ID (Config) → Script Properties 'SPREADSHEET_ID'
 * → spreadsheet bind → tạo mới 'RollCall v2 DB'.
 */
function getSpreadsheet_() {
  if (DEFAULT_SPREADSHEET_ID) {
    try { return SpreadsheetApp.openById(DEFAULT_SPREADSHEET_ID); } catch (e) { /* fallthrough */ }
  }
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SPREADSHEET_ID');
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (e) { /* fallthrough */ }
  }
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  // Standalone + chưa set ID → tạo sheet mới, lưu ID để dùng tiếp.
  const created = SpreadsheetApp.create('RollCall v2 DB');
  props.setProperty('SPREADSHEET_ID', created.getId());
  return created;
}

/** Đảm bảo toàn bộ sheet tồn tại (dùng khi khởi tạo). */
function ensureSheets_() {
  getSheet_(SHEETS.CONFIG, ['Key', 'Value']);
  getSheet_(SHEETS.STAFF_DATA, []); // header giữ nguyên như csv — syncFromCsv() sẽ ghi
  getSheet_(SHEETS.ATTENDANCE_TASK, [
    'taskId', 'taskType', 'station', 'slotCode', 'team', 'contractType', 'status', 'createdAt', 'createdBy', 'completedAt',
  ]);
  const logSheet = getSheet_(SHEETS.ATTENDANCE_LOG, [
    'taskId', 'staffId', 'staffName', 'slotCode', 'station', 'team', 'workstation',
    'timeRef', 'timeScan', 'status', 'date',
  ]);
  // Migration an toàn: sheet cũ tạo trước khi có cột date (LOG_COL_COUNT=11) vẫn còn
  // 10 cột → getSheet_ chỉ set header khi sheet trống, không tự thêm cột. Nếu thiếu,
  // thêm cột cuối + đặt header, nếu không batchInsertLogRows_ ghi 11 giá trị sẽ vỡ.
  // Migration an toàn: sheet cũ (8-10 cột) thiếu cột date → thêm cột tới đủ LOG_COL_COUNT
  // (while loop, không chỉ 1 cột — nếu thiếu nhiều cột thì batchInsertLogRows_ vỡ).
  // Minor#5 (audit): header cột mới phải tường minh theo index — trước đây luôn
  // đặt 'date' nên sheet cũ 9 cột bị đặt nhầm header cột status (10) thành 'date'.
  // Cột 1-based: STATUS=10 ('status'), DATE=11 ('date').
  const LOG_HEADER_BY_COL = { '10': 'status', '11': 'date' };
  while (logSheet.getLastColumn() < LOG_COL_COUNT) {
    const colIdx = logSheet.getLastColumn() + 1; // cột mới (1-based)
    logSheet.insertColumnAfter(logSheet.getLastColumn());
    logSheet.getRange(1, colIdx).setValue(LOG_HEADER_BY_COL[String(colIdx)] || '');
  }
}

// ===== Cache wrapper =====

function cache_() {
  return CacheService.getScriptCache();
}

/**
 * Đọc/ghi JSON cache theo key (version-key).
 * @param {string} key
 * @param {Function} load — trả về value khi cache miss
 * @param {number} ttlSeconds
 */
function cachedJson_(key, load, ttlSeconds) {
  const cached = cache_().get(key);
  if (cached !== null) {
    try { return JSON.parse(cached); }
    catch (e) { console.warn('cache parse fail', key, e.message); }  // F8: cache hỏng → rebuild, log để biết nếu lặp
  }
  const value = load();
  try { cache_().put(key, JSON.stringify(value), ttlSeconds); }
  catch (e) { console.warn('cache put fail', key, e.message); }  // F3: put >100KB/entry throw — log để biết cache đang miss âm thầm
  return value;
}

/** Cache timezone 1 lần (tránh gọi trong loop).
 * P2 (review): memo theo invocation — formatTime_ gọi mọi dòng log (2 lần/dòng × N NV);
 * getTimeZone_() trước đây mỗi lần gọi lại CacheService.get (đã cache 24h nhưng vẫn hit store).
 * Với 500-1000 NV/task = 1000-2000 cache GET mỗi lần load detail — memo module cắt về 1 lần.
 */
var _tzCache_ = null;
function getTimeZone_() {
  if (_tzCache_ !== null) return _tzCache_;
  _tzCache_ = cachedJson_(CACHE_KEYS.TZ, function () {
    return Session.getScriptTimeZone();
  }, CACHE_TTL.TZ);
  return _tzCache_;
}

/** Format Date theo timezone script — dùng cho hiển thị/ghi cột giờ. */
/** Major#1 (audit 2026-08-07): chuyển cell thời gian (Date object HOẶC string legacy,
 * vd "Mon Aug 03 2026 00:00:00 GMT+0700") về Date hợp lệ — KHÔNG throw nếu cell rác.
 * Utilities.formatDate/.getTime() sẽ throw khi nhận string → trước đây 1 cell string
 * trong timeRef/timeScan/createdAt làm toàn bộ getTaskDetail bricked.
 */
function safeDate_(v) {
  if (v === null || v === undefined || v === '') return null;
  try {
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    const t = Date.parse(v); // string "Mon Aug ..." / "8/1/2026" / ISO
    return isNaN(t) ? null : new Date(t);
  } catch (e) {
    return null;
  }
}
function formatTime_(date) {
  const d = safeDate_(date);
  if (!d) return '';
  return Utilities.formatDate(d, getTimeZone_(), 'HH:mm:ss');
}

/** P2: format có ngày (dd/MM HH:mm:ss) — danh sách task nhiều ngày phân biệt được. */
function formatDateTime_(date) {
  const d = safeDate_(date);
  if (!d) return '';
  // yyyy-MM-dd HH:mm:ss (đủ năm — task list Tạo lúc/Kết thúc); trước là dd/MM thiếu
  // năm → "30/12 12:48" gây nhầm (bug 2026-07-29). Giờ quét (formatTime_) vẫn HH:mm:ss.
  return Utilities.formatDate(date, getTimeZone_(), 'yyyy-MM-dd HH:mm:ss');
}

/** Date = ngày vào làm (StaffData) — format yyyy-MM-dd (ISO — sort string đúng thứ tự). */
function formatDateShort_(date) {
  if (!date) return '';
  // Ủy quyền cho normalizeStaffDate_ (CsvUtil) — xử lý cả Date object thật (dữ liệu
  // cũ trong sheet: "Mon Aug 03 2026 00:00:00 GMT+0700") lẫn string "8/1/2026".
  // 1 nguồn sự thật — tránh 2 bộ regex lệch nhau.
  return normalizeStaffDate_(date);
}

// ===== Config =====

// ===== StaffData =====

/**
 * Đọc StaffData → index { staffId: staff } (cache 5m, version-key).
 * @returns {Object<string, Object>}
 */
function readStaffIndex_() {
  return cachedJson_(CACHE_KEYS.STAFF_INDEX, function () {
    const sheet = getSheet_(SHEETS.STAFF_DATA);
    const values = sheet.getDataRange().getValues();
    return buildStaffIndex(values);
  }, CACHE_TTL.STAFF_INDEX);
}

/** Xóa cache StaffData (gọi sau syncFromCsv). */
function invalidateStaffIndex_() {
  cache_().remove(CACHE_KEYS.STAFF_INDEX);
  cache_().remove(CACHE_KEYS.FILTER_OPTIONS);
}

/** Đọc toàn bộ StaffData dạng mảng objects (cache 5m — version-key FILTER_OPTIONS). */
function readStaffList_() {
  return cachedJson_(CACHE_KEYS.FILTER_OPTIONS, function () {
    return readStaffListUncached_();
  }, CACHE_TTL.FILTER_OPTIONS);
}

/** Đọc StaffData trực tiếp từ sheet — bỏ qua cache (chỉ dùng khi cần data mới). */
function readStaffListUncached_() {
  const sheet = getSheet_(SHEETS.STAFF_DATA);
  const values = sheet.getDataRange().getValues();
  const header = values[0].map(function (h) { return String(h || '').trim(); });
  const fieldOf = {};
  for (let c = 0; c < header.length; c++) {
    const f = CSV_HEADER_FIELD[header[c]];
    if (f !== undefined) fieldOf[f] = c;
  }
  const out = [];
  for (let r = 1; r < values.length; r++) {
    const v = values[r];
    const staffId = normalizeStaffId(v[fieldOf.staffId]);
    if (!staffId) continue;
    out.push({
      staffId: staffId,
      staffName: normalizeStaffName(v[fieldOf.staffName]),
      station: String(v[fieldOf.station] || '').trim(),
      slotCode: String(v[fieldOf.slotCode] || '').trim(),
      team: String(v[fieldOf.team] || '').trim(),
      workstation: String(v[fieldOf.workstation] || '').trim(),
      cardIn: String(v[fieldOf.cardIn] || '').trim(),
      cardOut: String(v[fieldOf.cardOut] || '').trim(),
      date: normalizeStaffDate_(v[fieldOf.date]),  // ngay vao lam (StaffData Date) — chuẩn yyyy-MM-dd
      contractType: String(v[fieldOf.contractType] || '').trim(),
    });
  }
  return out;
}

// ===== AttendanceTask =====

/** Map 1 dòng sheet → object task (theo TASK_COLS). */
function taskFromRow_(row) {
  const createdAt = row[TASK_COLS.CREATED_AT] || null;
  const completedAt = row[TASK_COLS.COMPLETED_AT] || null;
  return {
    taskId: String(row[TASK_COLS.TASK_ID] || ''),
    taskType: String(row[TASK_COLS.TASK_TYPE] || ''),
    station: String(row[TASK_COLS.STATION] || ''),
    slotCode: String(row[TASK_COLS.SLOT_CODE] || ''),
    team: String(row[TASK_COLS.TEAM] || ''),
    contractType: String(row[TASK_COLS.CONTRACT_TYPE] || ''),
    status: String(row[TASK_COLS.STATUS] || ''),
    // phase derived từ status cho client dễ render UI (Mở/Điểm danh/Xong).
    // open=phase1 (ghi Giờ có mặt), attend=phase2 (ghi Giờ quét), done=Xong.
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

/** Ghi task mới (append — tần suất thấp, chấp nhận appendRow). */
function insertTask_(task) {
  getSheet_(SHEETS.ATTENDANCE_TASK).appendRow([
    task.taskId, task.taskType, task.station, task.slotCode, task.team,
    task.contractType || '', task.status, task.createdAt, task.createdBy, task.completedAt || '',
  ]);
  invalidateTaskListCache_();
  // F5: phá negative-cache (readTaskDetailCached_ cache null 15s nếu getTaskDetail gọi
  // trước khi task tồn tại — taskId dạng giờ-tạo có thể trùng giữa 2 lần create gần nhau).
  invalidateTaskDetailCache_(task.taskId);
}

/** Cập nhật trạng thái task (status, completedAt). */
function updateTaskStatus_(taskId, status, completedAt, rowIndex, contractType) {
  const sheet = getSheet_(SHEETS.ATTENDANCE_TASK);
  const write = function (r) {
    // P0 FIX: ghi 3 cột rời nhau (CONTRACT_TYPE cột 5, STATUS cột 6, COMPLETED_AT cột 9 — KHÔNG liền nhau,
    // TASK_COLS: CONTRACT_TYPE=5, STATUS=6, CREATED_AT=7, CREATED_BY=8, COMPLETED_AT=9).
    // Lỗi cũ (v1): getRange(r, STATUS+1, 1, 2) ghi [status, completedAt] vào cột 6,7
    // → completedAt ĐÈ LÊN CREATED_AT (phá hủy thời điểm tạo), COMPLETED_AT không bao giờ ghi.
    sheet.getRange(r, TASK_COLS.CONTRACT_TYPE + 1).setValue(contractType || '');
    sheet.getRange(r, TASK_COLS.STATUS + 1).setValue(status);
    sheet.getRange(r, TASK_COLS.COMPLETED_AT + 1).setValue(completedAt || '');
  };
  // F4: rowIndex optional — completeTask đã đọc task (có _rowIndex) → bỏ 1 lần
  // getDataRange + scan lại sheet (chỉ 1 caller duy nhất: TaskService.completeTask).
  if (rowIndex) {
    write(rowIndex);
    invalidateTaskListCache_();
    invalidateTaskDetailCache_(taskId);
    return true;
  }
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][TASK_COLS.TASK_ID] || '').trim() === taskId) {
      write(i + 1);
      invalidateTaskListCache_();
      invalidateTaskDetailCache_(taskId);
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
    return out.reverse(); // dòng mới nhất thường ở cuối → đưa lên đầu
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
      const hasScan = !!row[LOG_COLS.TIME_SCAN];
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
}

// ===== AttendanceLog =====

/** Map 1 dòng sheet → object log (theo LOG_COLS). */
function logFromRow_(taskId, row) {
  const timeRef = row[LOG_COLS.TIME_REF] || null;
  const timeScan = row[LOG_COLS.TIME_SCAN] || null;
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
    timeRefText: formatTime_(timeRef),
    timeScanText: formatTime_(timeScan),
    // Sort key số (epoch ms) — text "HH:mm:ss" mất ngày → sort chuỗi sai khi task
    // xuyên nửa đêm. Client sort theo con số này (chính xác tuyệt đối).
    timeRefEpoch: (safeDate_(timeRef) || {}).getTime ? safeDate_(timeRef).getTime() : 0,
    timeScanEpoch: (safeDate_(timeScan) || {}).getTime ? safeDate_(timeScan).getTime() : 0,
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
 * Đọc log rows của task có cache (30s) — dành cho ĐƯỜNG QUÉT (U2/scanStaff).
 * V2 khác v1: update-in-place (không append-only) nên không áp dynamic tail-rows;
 * thay bằng cache ngắn hạn + INCREMENTAL update (updateLogRowCache_) — scan chạy
 * liên tiếp không chạm sheet log, chỉ 1 setValues cho dòng được quét.
 * F2 (simplify): cache SLIM — chỉ giữ field đường quét cần (staffId/staffName/
 * timeScanText/timeScanEpoch/status/_rowIndex), KHÔNG nhét 12 field: 66KB→32KB
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
        timeRefText: r.timeRefText,
        timeRefEpoch: r.timeRefEpoch,
        timeScanText: r.timeScanText,
        timeScanEpoch: r.timeScanEpoch,
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
}

/**
 * Pre-fill log batch 1 lần (createReconcileTask) — KHÔNG appendRow trong loop.
 * @param {string} taskId
 * @param {Array<Object>} staffList — NV khớp tổ hợp
 * @param {Date} createdAt
 */
function batchInsertLogRows_(taskId, staffList, createdAt) {
  if (!staffList || !staffList.length) return 0;
  const sheet = getSheet_(SHEETS.ATTENDANCE_LOG);
  const startRow = sheet.getLastRow() + 1;
  const rows = staffList.map(function (s) {
    return [
      taskId, s.staffId, s.staffName, s.slotCode, s.station, s.team, s.workstation,
      createdAt, '', STATUS.PENDING, s.date || '',
    ];
  });
  sheet.getRange(startRow, 1, rows.length, LOG_COL_COUNT).setValues(rows);
  invalidateLogRows_(taskId); // U2: pre-fill tạo dòng mới — xoá cache cũ nếu taskId tái sử dụng
  return rows.length;
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
    const log = readLogRows_(taskId);
    const counters = computeCounters({ STATUS: STATUS }, log);
    // P3: strip _rowIndex + phase khỏi cache — rowIndex chỉ dùng khi GHI; phase là
    // function closure (taskFromRow_) → JSON.stringify crash (throw "undefined") khi
    // cache miss → client bắt lỗi "unidentified". Client tính phase lại từ status.
    delete task._rowIndex;
    delete task.phase;
    log.forEach(function (r) { delete r._rowIndex; });
    return { task: task, log: log, counters: counters };
  }, CACHE_TTL.TASK_DETAIL);
}

/** Xoá cache chi tiết task — gọi sau mọi ghi log/đổi status. */
function invalidateTaskDetailCache_(taskId) {
  try { cache_().remove(CACHE_KEYS.TASK_DETAIL + taskId); }
  catch (e) { console.warn('cache remove fail', CACHE_KEYS.TASK_DETAIL + taskId, e.message); }
}

/**
 * Chuyển status hàng loạt cho 1 task — batch setValues 1 lần cả cột status.
 * Dùng chung cho markUnscannedAbsent_ (kết thúc) và resetAbsentToPending_ (mở lại).
 * P1: batch setValues — KHÔNG setValue trong loop (241 NV = 241 calls → timeout risk).
 * P1: ghi 1 lần CẢ CỘT status từ values đã sửa trong memory — thay vì N RPC setValues
 * (worst case 241 NV quét xen kẽ = ~240 RPC → 12-24s). Idempotent: dòng không thuộc
 * task được ghi lại đúng giá trị vừa đọc. An toàn vì caller giữ LockService.
 * @param {string} taskId
 * @param {function(string, any): string|null} mutate — (status, timeScan) => status mới
 *   hoặc null (không đổi)
 * @returns {number} số dòng đã đổi
 */
function transformLogStatuses_(taskId, mutate) {
  const sheet = getSheet_(SHEETS.ATTENDANCE_LOG);
  const values = sheet.getDataRange().getValues();
  let done = 0;
  let anyChanged = false;
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (String(row[LOG_COLS.TASK_ID] || '').trim() !== taskId) continue;
    const timeScan = row[LOG_COLS.TIME_SCAN];
    const status = String(row[LOG_COLS.STATUS] || '');
    const next = mutate(status, timeScan);
    if (next !== null && next !== status) {
      values[i][LOG_COLS.STATUS] = next;
      done++;
      anyChanged = true;
    }
  }
  if (anyChanged) {
    const statusCol = LOG_COLS.STATUS + 1;
    // P2: ghi từ row 2 — values[0] là header, không được ghi đè (dù idempotent hôm nay,
    // fragile nếu đổi tên header); col.slice(1) bỏ header khỏi payload.
    const col = [];
    for (let r = 1; r < values.length; r++) col.push([values[r][LOG_COLS.STATUS]]);
    sheet.getRange(2, statusCol, values.length - 1, 1).setValues(col);
    invalidateTaskDetailCache_(taskId);
    invalidateLogRows_(taskId); // U2: status hàng loạt đổi → cache log rows cũ lệch, xoá
  }
  return done;
}

/** Khi kết thúc task: chuyển dòng chưa quét (timeScan rỗng, status '-') thành 'Vắng'. */
function markUnscannedAbsent_(taskId) {
  return transformLogStatuses_(taskId, function (status, timeScan) {
    if (timeScan && status === STATUS.PENDING) {
      // P1: insurance data-repair — dòng có timeScan nhưng status còn '-' (data legacy/
      // sửa tay; mọi write path đều ghi 2 cột trong 1 setValues atomic dưới LockService
      // nên luồng bình thường không sinh ra state này). KHÔNG đánh Vắng — chuẩn hóa
      // thành Có mặt.
      return STATUS.PRESENT;
    }
    if (!timeScan && status === STATUS.PENDING) return STATUS.ABSENT;
    return null;
  });
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
 * Cập nhật timeScan + status cho 1 dòng (theo _rowIndex) — 1 setValues batch.
 * @param {Object} row — từ readLogRows_/readLogRowsCached_ (luôn có _rowIndex, taskId)
 */
function updateLogRowScan_(row, timeScan, status) {
  const sheet = getSheet_(SHEETS.ATTENDANCE_LOG);
  sheet.getRange(row._rowIndex, LOG_COLS.TIME_SCAN + 1, 1, 2).setValues([[timeScan, status]]);
  invalidateTaskDetailCache_(row.taskId);
  invalidateTaskListCache_();  // Minor#4
  // U2: cập nhật row trong LOG_ROWS cache (incremental) — scan kế không chạm sheet.
  // KHÔNG nhét Date timeScan vào cache: JSON→string; schema slim chỉ có text+epoch.
  updateLogRowCache_(row.taskId, row._rowIndex, function (r) {
    r.status = status;
    r.timeScanText = formatTime_(timeScan);
    r.timeScanEpoch = timeScan.getTime();
  });
  return true;
}

/**
 * Cập nhật TIME_REF (Giờ có mặt) cho 1 dòng (phase1) — 1 setValues batch.
 * @param {Object} row — từ readLogRows_/readLogRowsCached_ (luôn có _rowIndex, taskId)
 */
function updateLogRowRef_(row, timeRef) {
  const sheet = getSheet_(SHEETS.ATTENDANCE_LOG);
  sheet.getRange(row._rowIndex, LOG_COLS.TIME_REF + 1, 1, 1).setValue(timeRef);
  invalidateTaskDetailCache_(row.taskId);
  invalidateTaskListCache_();  // Minor#4
  // U2: cập nhật row trong LOG_ROWS cache (incremental) — scan kế không chạm sheet.
  updateLogRowCache_(row.taskId, row._rowIndex, function (r) {
    r.timeRefText = formatTime_(timeRef);
    r.timeRefEpoch = timeRef.getTime();
  });
  return true;
}

/**
 * Cập nhật 1 dòng trong LOG_ROWS cache sau khi ghi sheet (incremental).
 * Chỉ chạm cache NẾU đang có (cache hit) — miss thì dòng sau sẽ rebuild. Tránh
 * getDataRange full sheet log mỗi scan liên tiếp.
 * @param {string} taskId
 * @param {number} rowIndex 1-based
 * @param {Function} mutate(r) — sửa object row trong cache tại chỗ
 */
function updateLogRowCache_(taskId, rowIndex, mutate) {
  try {
    const key = CACHE_KEYS.LOG_ROWS + taskId;
    const cached = cache_().get(key);
    if (cached === null) return; // miss — không xây cache trong luồng ghi
    const rows = JSON.parse(cached);
    for (let i = 0; i < rows.length; i++) {
      if (rows[i]._rowIndex === rowIndex) { mutate(rows[i]); break; }
    }
    cache_().put(key, JSON.stringify(rows), CACHE_TTL.LOG_ROWS);
  } catch (e) {
    console.warn('updateLogRowCache_ fail', taskId, e.message);
    invalidateLogRows_(taskId); // force rebuild lần sau — tránh cache stale gây classify sai
  }
}

/** Append dòng mới (quét lạ → Dư). */
function appendLogRow_(row) {
  const sheet = getSheet_(SHEETS.ATTENDANCE_LOG);
  sheet.appendRow([
    row.taskId, row.staffId, row.staffName, row.slotCode, row.station, row.team, row.workstation,
    row.timeRef || '', row.timeScan || '', row.status, row.date || '',
  ]);
  // P2-7: _rowIndex thật từ sheet (KHÔNG suy từ cache — cache chia sẻ giữa kiosk có thể lệch)
  row._rowIndex = sheet.getLastRow();
  // I3 FIX: chen dong moi vao LOG_ROWS cache (incremental) thay vi xoa.
  // Neu khong, thiet bi 2 quet CUNG staffId la trong cua so TTL (30s) se cache-miss
  // dong moi → classifyScan ra 'append' → ghi DONG 'Du' TRUNG LAP.
  // Chen vao cache giu nguyen incremental (khong bat rebuild full sheet).
  pushLogRowToCache_(row);
  invalidateTaskDetailCache_(row.taskId);
  invalidateTaskListCache_();  // Minor#4: scan xong counters list phải cập nhật ngay (không lag 30s)
}

/**
 * Chen 1 dòng mới vào LOG_ROWS cache (sau append) để thiết bị khác không đọc thiếu.
 * Chỉ chạm cache NẾU đang có (cache hit) — miss thì dòng sau rebuild từ sheet.
 * @param {Object} row — object dòng log (phải có taskId + _rowIndex)
 */
function pushLogRowToCache_(row) {
  try {
    const key = CACHE_KEYS.LOG_ROWS + row.taskId;
    const cached = cache_().get(key);
    if (cached === null) return; // miss — không xây cache trong luồng ghi
    const rows = JSON.parse(cached);
    // P2-7: _rowIndex lấy từ row._rowIndex (đã set = sheet.getLastRow() sau append)
    const slim = {
      taskId: row.taskId,
      staffId: row.staffId,
      staffName: row.staffName,
      slotCode: row.slotCode,
      station: row.station,
      team: row.team,
      timeRefText: row.timeRef ? formatTime_(row.timeRef) : '',
      timeRefEpoch: row.timeRef ? row.timeRef.getTime() : 0,
      timeScanText: row.timeScan ? formatTime_(row.timeScan) : '',
      timeScanEpoch: row.timeScan ? row.timeScan.getTime() : 0,
      status: row.status,
      dateText: row.date || '',
      _rowIndex: row._rowIndex || 0,
    };
    rows.push(slim);
    cache_().put(key, JSON.stringify(rows), CACHE_TTL.LOG_ROWS);
  } catch (e) {
    console.warn('pushLogRowToCache_ fail', row && row.taskId, e.message);
    invalidateLogRows_(row.taskId); // fail → xoá cache để lần sau rebuild đúng
  }
}

/** Ghi đè toàn bộ StaffData từ dữ liệu csv đã parse (syncFromCsv). */
function overwriteStaffData_(staffList) {
  const sheet = getSheet_(SHEETS.STAFF_DATA);
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, STAFF_DATA_COL_COUNT).clearContent();
  if (!staffList || !staffList.length) return 0;
  const rows = staffList.map(function (s) {
    return [
      s.no, s.date, s.staffId, s.staffName, s.staffEmail, s.agency, s.contractType, s.eventId,
      s.matchingType, s.gender, s.department, s.cardIn, s.cardOut, s.actualHours,
      s.cardInRemark, s.cardOutRemark, s.slotCode, s.workstation, s.team, s.station,
    ];
  });
  sheet.getRange(2, 1, rows.length, STAFF_DATA_COL_COUNT).setValues(rows);
  invalidateStaffIndex_();
  return rows.length;
}
