/**
 * Code.gs — Entry point + API endpoints (google.script.run).
 * Debug URL (?debug=1 / ?debug=createTask) xử lý trong Debug.gs (editor-gated);
 * quyền/định danh trong Auth.gs.
 *
 * API (gọi từ client index.html):
 *   getMetaApi()                 → { ok, appTitle, userEmail }
 *   getFilterOptionsApi()        → { ok, stationGroups }
 *   createReconcileTask(input)   → { ok, taskId, count, message }
 *   getTaskList()                → [{ taskId, station, slotCode, team, status, createdAt }]
 *   getTaskDetail(taskId)        → { ok, task, log, counters }
 *   scanStaff(taskId, staffId)   → { ok, message, status, counters }
 *   completeTask(taskId)         → { ok, message }
 *   syncFromCsv()                → { ok, count, message } — gọi từ editor (Phase 0)
 *   getSettingsApi()             → { ok, settings } — editor-only (trang Config Admin)
 *   saveSettingsApi(patch)       → { ok, saved, ignored, message } — editor-only
 */

/** WebApp: trả về index.html. */
function doGet(e) {
  // Tự khởi tạo mọi sheet (kèm header) — không cần chạy setupSheets() tay.
  // getSheet_() chỉ set header khi sheet trống, nên gọi mỗi lần load rất rẻ.
  ensureSheets_();
  // Debug: URL?debug=... — xử lý trong Debug.gs (editor-gated). null = không phải debug.
  const debugOut = handleDebugRequest_(e);
  if (debugOut) return debugOut;
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle(WEB_APP.PAGE_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/** Meta cho UI: title + user email (hiển thị header). */
function getMetaApi() {
  // Deploy "Anyone within @spxexpress.com" → getActiveUser() có email (user đăng nhập Google).
  // Anonymous thật (không login) → rỗng. Hiển thị ở header như v1.
  return {
    ok: true,
    appTitle: UI_LABELS.APP_TITLE,
    userEmail: getActiveEmail_(),
  };
}

/** Distinct values cho dropdown + cây nhóm cho modal tạo task. */
function getFilterOptionsApi() {
  const staffList = readStaffList_();
  return {
    ok: true,
    // Cây 4 cột: stationGroups = [{ station, slotCodes: [{slotCode, teams}], dates }]
    // — modal tạo task render checkbox, cascade theo station. 1 nguồn duy nhất.
    stationGroups: buildStationGroups(staffList),
  };
}

/** Xem truoc so NV khop bo loc truoc khi tao task (modal) — khong tao gi ca. */
function previewStaffApi(input) {
  const staffList = readStaffList_();
  const filtered = filterStaffByGroup(staffList, {
    station: input && input.station,
    slotCode: input && input.slotCode,
    team: input && input.team,
    date: input && input.date,
    contractType: input && input.contractType,
  });
  // Tái dùng dedupeStaffByGroup (đã test) — đảm bảo count preview khớp count tạo task thật.
  const deduped = dedupeStaffByGroup(filtered);
  return {
    ok: true,
    count: deduped.length,  // chi tra count — khong gui sample (user bo hien thi 10 NV dau)
  };
}

/**
 * Đếm số NV cho từng option trong 1 cột, CÓ tính ngữ cảnh các filter KHÁC đã chọn.
 * Client gửi `base` = tổ hợp filter hiện tại (station/slotCode/team/contractType/date),
 * `col` = cột đang đếm, `options` = danh sách option của cột đó.
 * Count mỗi option = filter với base, nhưng cột `col` bị ghi đè bằng [option] duy nhất.
 * @returns {{ok: boolean, counts: Object<string, number>}}
 */
function previewStaffCountsApi(input) {
  const staffList = readStaffList_();
  const base = (input && input.base) || {};
  const col = input && input.col;
  // P2-5: guard Array.isArray — client có thể gửi sai kiểu (I4 sót server)
  const options = Array.isArray(input && input.options) ? input.options : [];
  const bSlot = Array.isArray(base.slotCode) ? base.slotCode : [];
  const bTeam = Array.isArray(base.team) ? base.team : [];
  const bContract = Array.isArray(base.contractType) ? base.contractType : [];
  const counts = {};
  options.forEach(function (opt) {
    const f = {
      station: base.station,
      slotCode: (col === 'slot') ? [opt] : bSlot,
      team: (col === 'team') ? [opt] : bTeam,
      contractType: (col === 'contract') ? [opt] : bContract,
      date: (col === 'date') ? opt : base.date,
    };
    const filtered = filterStaffByGroup(staffList, f);
    counts[opt] = dedupeStaffByGroup(filtered).length;
  });
  return { ok: true, counts: counts };
}

/** View StaffData: trả toàn bộ StaffData (full 20 field) cho bảng danh sách + thống kê.
 * Gate: requireRole_('operator') — viewer (role P1) bị chặn. Hiện tại mọi user là
 * operator+ (mặc định) nên KHÔNG đổi hành vi. Chỉ đọc — cache 30s (STAFF_STATS). */
function getStaffStatsApi() {
  // Gate requireRole_('operator') đặt TRONG try (pattern DEFENSE như pasteCodes):
  // nếu requireRole_ → getSetting_ → getSheet_/getSpreadsheet_ throw (chưa cấu hình)
  // thì trả ok:false thay vì ném ra client.
  try {
    if (!requireRole_('operator')) {
      return { ok: false, message: 'Không đủ quyền (cần role operator trở lên)' };
    }
    return { ok: true, staff: readStaffFullList_() };
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : 'getStaffStats fail' };
  }
}

/** Settings Admin: đọc toàn bộ cấu hình (defaults + override Config sheet). Editor-only. */
function getSettingsApi() {
  if (!isEditor_()) {
    return { ok: false, settings: null, message: 'Chỉ editor (DEPLOYER_EMAIL) mới xem cấu hình' };
  }
  try {
    return { ok: true, settings: getSettings_() };
  } catch (e) {
    return { ok: false, settings: null, message: e && e.message ? e.message : 'getSettings fail' };
  }
}

/** Settings Admin: ghi patch cấu hình — whitelist key trong SETTINGS_DEFAULTS (gate trong saveSettings_). */
function saveSettingsApi(patch) {
  return saveSettings_(patch);
}

/** Tạo task đối chiếu + pre-fill. MỞ cho mọi nhân viên @spxexpress.com (luồng vận hành). */
function createReconcileTaskApi(input) {
  return createReconcileTask(input);
}

/** Danh sách task. */
function getTaskListApi() {
  return listTasks();
}

/** Chi tiết task + log + counters. */
function getTaskDetailApi(taskId) {
  return getTaskDetail(taskId);
}

/** Quét NV. Mở cho kiosk — KHÔNG cần editor (luồng vận hành hàng ngày). */
function scanStaffApi(taskId, staffId) {
  return scanStaff(taskId, staffId);
}

/** Kết thúc task. MỞ cho mọi nhân viên @spxexpress.com (luồng vận hành). */
function completeTaskApi(taskId) {
  return completeTask(taskId);
}

/** Chuyển task Mở (phase1) → Điểm danh (phase2). MỞ cho mọi nhân viên. */
function transitionToAttendApi(taskId) {
  return transitionToAttend(taskId);
}

/** Mở lại task đã đóng (reset NV Vắng → Chưa điểm danh, cho quét tiếp). MỞ cho mọi nhân viên. */
function reopenTaskApi(taskId) {
  return reopenTask(taskId);
}

/** T-2: Dán danh sách mã (batch paste). Mở cho kiosk — KHÔNG cần editor. */
function pasteCodesApi(taskId, lines) {
  return pasteCodes(taskId, lines);
}

/** F-search: tìm log của 1 mã NV (Ops) XUYÊN TASK. Mở cho kiosk — chỉ đọc.
 *  Trả danh sách task mà NV đó từng hiện hữu, kèm thông tin NV trong từng task.
 *  Gate: KHÔNG giới hạn role (chỉ đọc toàn bộ — tương như listTasksApi). */
function searchLogsByStaffApi(rawStaffId) {
  return searchLogsByStaff(rawStaffId);
}

/** F-search mở rộng: tìm task theo mã (prefix/contains). Mở cho kiosk — chỉ đọc
 *  (dùng readTaskList_ cache + counters, không đọc sheet riêng). */
function searchTasksByQueryApi(rawQ) {
  return searchTasksByQuery(rawQ);
}

/** Preload staffIndex vào cache sớm (khi mở app / tạo xong task). Fix #1: tên NV lạ
 *  hiện NGAY khi quét đầu thay vì về sau mới có (do StaffData index bị lazy + cache 5p).
 *  MỞ cho mọi nhân viên — chỉ đọc (KHÔNG ghi) nên an toàn kiosk. */
function warmStaffCacheApi() {
  try {
    const index = readStaffIndex_(); // warm cache + tra index cho client
    // P1-2: chi tra field UI can (ten/Ca/Station/Team/Agency) — boc cardIn/cardOut/date
    // (recon schedule nhan su) khoi payload; server van giu full index trong cache.
    const slim = {};
    Object.keys(index).forEach(function (id) {
      const s = index[id];
      slim[id] = { staffId: s.staffId, staffName: s.staffName, slotCode: s.slotCode, station: s.station, team: s.team, workstation: s.workstation, agency: s.agency || '' };
    });
    return { ok: true, index: slim };
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : 'warm failed' };
  }
}

/**
 * Đồng bộ StaffData từ csv (Phase 0: gọi từ editor; Phase 2+: trigger tự động).
 * Mở sheet StaffData, dán csv, chạy hàm này — sheet sẽ được ghi đè.
 * @returns {{ok: boolean, count: number, message: string}}
 */
function syncFromCsv() {
  // P1: kiosk anonymous — KHÔNG cho chạy từ webapp (ai cũng gọi được qua
  // google.script.run từ console → ghi đè/xóa StaffData).
  // Chỉ cho chạy từ Editor: Session.getActiveUser() rỗng khi anonymous truy cập.
  if (!isEditor_()) {
    return { ok: false, count: 0, message: 'syncFromCsv chỉ chạy từ Script Editor' };
  }
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(SHEETS.STAFF_DATA);
  if (!sheet) {
    return { ok: false, count: 0, message: 'Không tìm thấy sheet ' + SHEETS.STAFF_DATA };
  }
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) {
    return { ok: false, count: 0, message: 'Sheet ' + SHEETS.STAFF_DATA + ' không có dữ liệu (cần header + ít nhất 1 dòng)' };
  }
  // Parse trực tiếp từ mảng 2D — an toàn với dấu phẩy/nháy trong giá trị.
  const staff = buildStaffListFromValues(values);
  if (!staff.length) {
    return { ok: false, count: 0, message: 'Không parse được dữ liệu — kiểm tra header khớp Att.csv (20 cột)' };
  }
  const overwritten = overwriteStaffData_(staff);
  return { ok: true, count: overwritten, message: 'Đã đồng bộ ' + overwritten + ' nhân viên' };
}

/** Khởi tạo sheet lần đầu (chạy 1 lần từ editor sau khi deploy). */
function setupSheets() {
  // P3: gate editor-only — kiosk anonymous, không cho gọi qua google.script.run console
  if (!isEditor_()) return 'Chỉ chạy từ Script Editor';
  ensureSheets_();
  return 'OK: sheets đã sẵn sàng';
}
