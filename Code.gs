/**
 * Code.gs — Entry point + API endpoints (google.script.run).
 * Debug URL (?debug=1 / ?debug=createTask) xử lý trong Debug.gs (editor-gated);
 * quyền/định danh trong Auth.gs.
 *
 * API (gọi từ client index.html — 19 endpoint, tên chuẩn hậu tố *Api):
 *   getMetaApi()                 → { ok, appTitle, userEmail }
 *   getFilterOptionsApi()        → { ok, stationGroups }
 *   previewStaffApi(input)       → { ok, matched, missing, count } — preview tạo task
 *   getStaffStatsApi()           → { ok, counts } — thống kê StaffData
 *   getSettingsApi()             → { ok, settings } — editor-only (trang Config Admin)
 *   saveSettingsApi(patch)       → { ok, saved, ignored, message } — editor-only
 *   getAuditLogApi(limit)        → { ok, rows } — nhật ký hoạt động viewAdmin (admin+)
 *   createReconcileTaskApi(input) → { ok, taskId, count, message }
 *   getTaskListApi()             → [{ taskId, station, slotCode, team, status, createdAt }]
 *   getTaskDetailApi(taskId)     → { ok, task, log, counters }
 *   scanStaffApi(taskId, staffId) → { ok, message, status, counters }
 *   completeTaskApi(taskId)      → { ok, message }
 *   cancelTaskApi(taskId)        → { ok, message } — hủy task Mở rỗng (xóa hẳn)
 *   transitionToAttendApi(taskId) → { ok, message, counters } — task open → attend
 *   reopenTaskApi(taskId)         → { ok, message } — task done → open (quét bổ sung)
 *   pasteCodesApi(taskId, lines)  → { ok, total, success, failed, results } — dán mã hàng loạt
 *   searchLogsByStaffApi(staffId) → { ok, rows } — manager+ (báo cáo tháng theo mail)
 *   getReportsApi()               → { ok, rows, email, opsId } — báo cáo chấm công tháng theo mail đăng nhập (StaffAttendance × StaffInfo)
 *   searchTasksByQueryApi(q)      → { ok, rows } — tìm task theo mã NV / mã task
 *   warmStaffCacheApi()          → { ok, index } — preload staffIndex cache (fire-and-forget)
 * Editor tools (không phải *Api — chạy tay trong GAS editor): syncFromCsv(), setupSheets()
 */

/** WebApp: template index.html — <?!= include() ?> nạp CSS/JS từ styles.html + app-*.html (7 module). */
function doGet(e) {
  // Tự khởi tạo mọi sheet (kèm header) — không cần chạy setupSheets() tay.
  // getSheet_() chỉ set header khi sheet trống, nên gọi mỗi lần load rất rẻ.
  ensureSheets_();
  // Debug: URL?debug=... — xử lý trong Debug.gs (editor-gated). null = không phải debug.
  const debugOut = handleDebugRequest_(e);
  if (debugOut) return debugOut;
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle(WEB_APP.PAGE_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/** GAS template helper: include('styles') / include('app') — nạp file .html con. */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** Meta cho UI: title + user email (hiển thị header). */
function getMetaApi() {
  // Deploy (appsscript.json): executeAs USER_DEPLOYING + access DOMAIN → getActiveUser()
  // có email user truy cập (login Google trong @spxexpress.com). Anonymous (không login)
  // → rỗng. Hiển thị ở header như v1.
  return {
    ok: true,
    appTitle: UI_LABELS.APP_TITLE,
    userEmail: getActiveEmail_(),
    // #10: role cho client placeholder/gate. Fallback ROLES.DEFAULT nếu getRole_ ném
    // (Config sheet lỗi) — KHÔNG để boot RPC getMetaApi sập → markServerFail mỗi lần mở app.
    role: (function () { try { return getRole_(getActiveEmail_()); } catch (e) { return ROLES.DEFAULT; } })(),
    isEditor: isEditor_(),  // client ẩn/hiện trang Cấu hình (viewConfig)
  };
}

/** Distinct values cho dropdown + cây nhóm cho modal tạo task. */
function getFilterOptionsApi() {
  // Gate operator TRONG hàm (M1): google.script.run gọi được global trực tiếp — chặn
  // viewer đọc cây station/slot/team/date (dữ liệu StaffData). DEFENSE: gate TRONG try.
  // Client skip sớm cho viewer (app-tasks loadFilterOptions) → không toast mỗi refresh.
  try {
    if (!requireRole_('operator')) {
      return { ok: false, stationGroups: [], defaults: null, lists: null, message: 'Không đủ quyền (cần role operator trở lên)' };
    }
    // Cache 60s (FILTER_OPTIONS) — stationGroups + lists + defaults hiếm đổi; modal tạo
    // task / roster mở NGAY, không chờ đọc StaffData mỗi lần. Invalidate khi saveSettings
    // (SettingsService.invalidateSettingsCache_) + overwriteStaffData (StaffDataRepo).
    return cachedJson_(CACHE_KEYS.FILTER_OPTIONS, function () {
      const staffList = readStaffList_();
      return {
        ok: true,
        // Cây 4 cột: stationGroups = [{ station, slotCodes: [{slotCode, teams}], dates }]
        // — modal tạo task render checkbox, cascade theo station. 1 nguồn duy nhất.
        stationGroups: buildStationGroups(staffList),
        // defaults (Config sheet qua SettingsService) — pre-select modal tạo task cho MỌI user
        // (operator không phải editor vẫn được pre-select; getSettings_ không gate).
        defaults: {
          station: getSetting_('defaultStation'),
          slotCode: getSetting_('defaultSlotCode'),
          team: getSetting_('defaultTeam'),
        },
        // lists (Config sheet qua SettingsService) — danh sách lựa chọn Admin khai báo.
        // Client MERGE với distinct StaffData (union, dedup) để không mất giá trị thực
        // có trong dữ liệu NV mà Admin chưa kịp khai báo. getSettings_ không gate → operator OK.
        lists: {
          stations: settingsList_('stations'),
          teams: settingsList_('teams'),
          slotcodes: settingsList_('slotcodes'),
          departments: settingsList_('departments'),
          agencies: settingsList_('agencies'),
          contractTypes: settingsList_('contractTypes'),
        },
      };
    }, CACHE_TTL.FILTER_OPTIONS);
  } catch (e) {
    return { ok: false, stationGroups: [], defaults: null, lists: null, message: e && e.message ? e.message : 'getFilterOptions fail' };
  }
}

/** Xem truoc so NV khop bo loc truoc khi tao task (modal) — khong tao gi ca. */
function previewStaffApi(input) {
  // Gate operator TRONG hàm (M1) — preview đếm theo StaffData (dữ liệu HR), chặn gọi
  // trực tiếp qua console. Client chỉ gọi từ modal tạo task (operator+).
  try {
    if (!requireRole_('operator')) {
      return { ok: false, count: 0, message: 'Không đủ quyền (cần role operator trở lên)' };
    }
    const staffList = readStaffList_();
    const filtered = filterStaffByGroup(staffList, {
      station: input && input.station,
      slotCode: input && input.slotCode,
      team: input && input.team,
      date: input && input.date,
      contractType: input && input.contractType,
      department: input && input.department,
    });
    // Tái dùng dedupeStaffByGroup (đã test) — đảm bảo count preview khớp count tạo task thật.
    const deduped = dedupeStaffByGroup(filtered);
    return {
      ok: true,
      count: deduped.length,  // chi tra count — khong gui sample (user bo hien thi 10 NV dau)
    };
  } catch (e) {
    return { ok: false, count: 0, message: e && e.message ? e.message : 'previewStaff fail' };
  }
}

/** View StaffData: trả toàn bộ StaffData (full 20 field) cho bảng danh sách + thống kê.
 * Gate: requireRole_('manager') — viewStats/viewStaff chỉ cho manager+ (2026-08-17).
 * Chỉ đọc — cache 30s (STAFF_STATS). */
function getStaffStatsApi() {
  // Gate requireRole_('operator') đặt TRONG try (pattern DEFENSE như pasteCodes):
  // nếu requireRole_ → getSetting_ → getSheet_/getSpreadsheet_ throw (chưa cấu hình)
  // thì trả ok:false thay vì ném ra client.
  try {
    if (!requireRole_('manager')) {
      return { ok: false, message: 'Không đủ quyền (cần role manager trở lên)' };
    }
    const staff = readStaffFullList_();
    // P2 (review 2026-08-19): theo dõi ngưỡng — full StaffData về client + phân trang 100
    // client-side; trên ngưỡng cần server-side pagination/filter (network + parse + memory).
    if (staff.length > 2000) {
      console.warn({ bench: 'getStaffStatsApi', staff: staff.length, warning: 'full-payload-threshold-2000' });
    }
    return { ok: true, staff: staff };
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
    // roleMap tách khỏi getSettings_ (P0: settings public operator dùng) — editor merge
    // riêng cho trang Config Admin qua getRoleMap_ (cache riêng, invalidate cùng save).
    const settings = getSettings_() || {};
    settings.roleMap = getRoleMap_();
    return { ok: true, settings: settings };
  } catch (e) {
    return { ok: false, settings: null, message: e && e.message ? e.message : 'getSettings fail' };
  }
}

/** Settings Admin: ghi patch cấu hình — whitelist key trong SETTINGS_DEFAULTS (gate trong saveSettings_). */
function saveSettingsApi(patch) {
  try {
    return saveSettings_(patch);
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : 'saveSettings fail' };
  }
}

/** Nhật ký hoạt động (audit). Gate admin TRONG try (DEFENSE). */
function getAuditLogApi(limit) {
  try {
    if (!requireRole_('admin')) return { ok: false, rows: [], message: 'Không đủ quyền (cần role admin)' };
    return { ok: true, rows: getAuditLog_(limit), message: '' };
  } catch (e) {
    return { ok: false, rows: [], message: e && e.message ? e.message : 'getAuditLog fail' };
  }
}

/** Tạo task mới (A2 — luôn FREE + rỗng, không pre-fill). Gate requireRole_('operator') đặt TRONG createReconcileTask
 *  (TaskService) — chống bypass google.script.run gọi global; wrapper chỉ DEFENSE. */
function createReconcileTaskApi(input) {
  // Gate quyền THẬT nằm TRONG createReconcileTask (TaskService) — google.script.run gọi được hàm global
  // trực tiếp nên gate ở wrapper không chặn bypass. Wrapper chỉ giữ DEFENSE: catch mọi
  // lỗi (kể cả requireRole_ → getSetting_ sheet chưa cấu hình) → ok:false thay vì ném ra client.
  try {
    return createReconcileTask(input);
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : 'createReconcileTask fail' };
  }
}

/** Danh sách task. Error contract (review 2026-08-19): [] CHỈ khi danh sách thực sự rỗng;
 * lỗi hạ tầng (sheet/quota/cache) → { ok:false, message } — client phân biệt được
 * "chưa có task" với "hệ thống lỗi", không tạo task trùng khi tưởng danh sách rỗng. */
function getTaskListApi() {
  try {
    return listTasks();
  } catch (e) {
    console.error('getTaskListApi fail', e && e.message);
    return { ok: false, message: e && e.message ? e.message : 'Lỗi tải danh sách task' };
  }
}

/** Chi tiết task + log + counters. */
function getTaskDetailApi(taskId) {
  try {
    return getTaskDetail(taskId);
  } catch (e) {
    return detailError_(e && e.message ? e.message : 'getTaskDetail fail');
  }
}

/** Quét NV. Mở cho operator — KHÔNG cần editor (luồng vận hành hàng ngày). */
function scanStaffApi(taskId, staffId, clientEpoch) {
  return scanStaff(taskId, staffId, clientEpoch);
}

/** Kết thúc task. Gate requireRole_('operator') — mọi user hiện tại là operator+ (DEFAULT)
 *  nên không đổi hành vi quét; bịt lỗ fail-open: trước đây ai cũng gọi transition→ATTEND
 *  để vô hiệu owner-gate phase OPEN (canScanOpen_) rồi thao tác task người khác. */
function completeTaskApi(taskId) {
  // Gate quyền THẬT nằm TRONG completeTask (TaskService) — google.script.run gọi được hàm global
  // trực tiếp nên gate ở wrapper không chặn bypass. Wrapper chỉ giữ DEFENSE: catch mọi
  // lỗi (kể cả requireRole_ → getSetting_ sheet chưa cấu hình) → ok:false thay vì ném ra client.
  try {
    return completeTask(taskId);
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : 'completeTask fail' };
  }
}

/** Hủy task phase Mở với log rỗng (tạo nhầm / bỏ dở) — xóa hẳn task. Gate requireRole_('operator')
 *  + canScanOpen_ bên trong cancelTask (TaskService) — đồng gate transitionToAttend.
 */
function cancelTaskApi(taskId) {
  // Gate quyền THẬT nằm TRONG cancelTask (TaskService) — google.script.run gọi được hàm global
  // trực tiếp nên gate ở wrapper không chặn bypass. Wrapper chỉ giữ DEFENSE: catch mọi
  // lỗi (kể cả requireRole_ → getSetting_ sheet chưa cấu hình) → ok:false thay vì ném ra client.
  try {
    return cancelTask(taskId);
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : 'cancelTask fail' };
  }
}

/** Chuyển task Mở (phase1) → Điểm danh (phase2). Gate requireRole_('operator') — không đổi
 *  hành vi hiện tại (DEFAULT=operator), chặn viewer dùng transition để bypass owner-gate. */
function transitionToAttendApi(taskId) {
  // Gate quyền THẬT nằm TRONG transitionToAttend (TaskService) — google.script.run gọi được hàm global
  // trực tiếp nên gate ở wrapper không chặn bypass. Wrapper chỉ giữ DEFENSE: catch mọi
  // lỗi (kể cả requireRole_ → getSetting_ sheet chưa cấu hình) → ok:false thay vì ném ra client.
  try {
    return transitionToAttend(taskId);
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : 'transitionToAttend fail' };
  }
}

/** Mở lại task đã đóng (reset NV Vắng → Chưa điểm danh, cho quét tiếp). Gate requireRole_
 *  ('operator') — reset ABSENT→PENDING ảnh hưởng dữ liệu chấm công, không cho viewer làm. */
function reopenTaskApi(taskId) {
  // Gate quyền THẬT nằm TRONG reopenTask (TaskService) — google.script.run gọi được hàm global
  // trực tiếp nên gate ở wrapper không chặn bypass. Wrapper chỉ giữ DEFENSE: catch mọi
  // lỗi (kể cả requireRole_ → getSetting_ sheet chưa cấu hình) → ok:false thay vì ném ra client.
  try {
    return reopenTask(taskId);
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : 'reopenTask fail' };
  }
}

/** T-2: Dán danh sách mã (batch paste). Gate requireRole_('operator') — operator vẫn dùng
 *  (DEFAULT=operator); paste vẫn giữ owner-gate canScanOpen_ ở phase OPEN bên trong. */
function pasteCodesApi(taskId, lines) {
  // Gate quyền THẬT nằm TRONG pasteCodes (ScanService) — google.script.run gọi được hàm global
  // trực tiếp nên gate ở wrapper không chặn bypass. Wrapper chỉ giữ DEFENSE: catch mọi
  // lỗi (kể cả requireRole_ → getSetting_ sheet chưa cấu hình) → ok:false thay vì ném ra client.
  try {
    return pasteCodes(taskId, lines);
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : 'pasteCodes fail' };
  }
}

/** Nạp danh sách theo ca (roster) — Phase A (docs/roster-load-design.md). Gate thật TRONG
 *  loadRoster (TaskService): operator + status OPEN + canScanOpen_ (owner/admin). */
function loadRosterApi(taskId, filters) {
  // Gate quyền THẬT nằm TRONG loadRoster (TaskService) — google.script.run gọi được hàm global
  // trực tiếp nên gate ở wrapper không chặn bypass. Wrapper chỉ giữ DEFENSE: catch mọi
  // lỗi (kể cả requireRole_ → getSetting_ sheet chưa cấu hình) → ok:false thay vì ném ra client.
  try {
    return loadRoster(taskId, filters);
  } catch (e) {
    return { ok: false, total: 0, added: 0, skipped: 0, message: e && e.message ? e.message : 'loadRoster fail', counters: null };
  }
}

/** Sửa trạng thái 1 dòng log (fix thủ công - owner/admin, audit). Gate thật TRONG
 *  updateLogRowStatus (TaskService) - wrapper chỉ giữ DEFENSE: catch mọi lỗi → ok:false. */
function updateLogRowStatusApi(taskId, staffId, newStatus) {
  try {
    return updateLogRowStatus(taskId, staffId, newStatus);
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : 'updateLogRowStatus fail', counters: null };
  }
}

/** F-search: tìm log của 1 mã NV (Ops) XUYÊN TASK — DỮ LIỆU CHẤM CÔNG CÁ NHÂN.
 *  Trả danh sách task mà NV đó từng hiện hữu, kèm thông tin NV trong từng task.
 *  Gate requireRole_('manager') — nền cho báo cáo tháng theo mail (chỉ manager+ xem
 *  lịch sử chấm công của người khác). pattern DEFENSE: gate TRONG try (như getStaffStatsApi)
 *  — requireRole_ → getSetting_ → sheet chưa cấu hình throw → trả ok:false thay vì ném ra client. */
function searchLogsByStaffApi(rawStaffId) {
  try {
    if (!requireRole_('manager')) {
      return { ok: false, rows: [], message: 'Không đủ quyền (cần role manager trở lên)' };
    }
    return { ok: true, rows: searchLogsByStaff(rawStaffId) };
  } catch (e) {
    return { ok: false, rows: [], message: e && e.message ? e.message : 'searchLogsByStaff fail' };
  }
}

/** F-search mở rộng: tìm task theo mã (prefix/contains). Mở cho operator — chỉ đọc
 *  (dùng readTaskList_ cache + counters, không đọc sheet riêng). */
function searchTasksByQueryApi(rawQ) {
  return searchTasksByQuery(rawQ);
}

/** Báo cáo chấm công tháng theo email đăng nhập (viewReports — StaffAttendance × StaffInfo).
 *  Gate requireRole_('manager') nằm TRONG getReports (ReportService) — chống bypass;
 *  wrapper chỉ giữ DEFENSE: catch mọi lỗi (kể cả sheet nguồn chưa có) → ok:false. */
function getReportsApi() {
  try {
    return getReports();
  } catch (e) {
    return { ok: false, rows: [], message: e && e.message ? e.message : 'getReportsApi fail' };
  }
}

/** Preload staffIndex vào cache sớm (khi mở app / tạo xong task). Fix #1: tên NV lạ
 *  hiện NGAY khi quét đầu thay vì về sau mới có (do StaffData index bị lazy + cache 5p).
 *  GATED operator+ (was open to all staff; read-only) - staff index is HR
 *  personnel data (name/Ca/Station/Team); only operator+ may warm it (viewers get ok:false). */
function warmStaffCacheApi() {
  try {
    // M1: gate at service layer - staff index exposes personnel data (name/Ca/Station/Team);
    // any role (incl. viewer) used to receive it, bypassing the manager+ gate of viewStaff/viewStats.
    if (!requireRole_('operator')) {
      return { ok: false, message: 'Không đủ quyền (cần role operator trở lên)' };
    }
    const index = readStaffIndex_(); // warm cache + tra index cho client
    // P1-2: chi tra field UI can (ten/Ca/Station/Team/Agency/Ngày) — boc cardIn/cardOut
    // (recon schedule nhan su) khoi payload; server van giu full index trong cache.
    // date: cột Ngày bảng quét hiện NGAY khi quét NV lạ (optimistic — khong cho server).
    const slim = {};
    Object.keys(index).forEach(function (id) {
      const s = index[id];
      slim[id] = { staffId: s.staffId, staffName: s.staffName, slotCode: s.slotCode, station: s.station, team: s.team, workstation: s.workstation, agency: s.agency || '', date: s.date || '' };
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
  // P1: anonymous — KHÔNG cho chạy từ webapp (ai cũng gọi được qua
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
  const staff = buildStaffListFromValues(values, ss.getSpreadsheetTimeZone());
  if (!staff.length) {
    return { ok: false, count: 0, message: 'Không parse được dữ liệu — kiểm tra header khớp Att.csv (20 cột)' };
  }
  const overwritten = overwriteStaffData_(staff);
  return { ok: true, count: overwritten, message: 'Đã đồng bộ ' + overwritten + ' nhân viên' };
}

/** Khởi tạo sheet lần đầu (chạy 1 lần từ editor sau khi deploy). */
function setupSheets() {
  // P3: gate editor-only — anonymous, không cho gọi qua google.script.run console
  if (!isEditor_()) return 'Chỉ chạy từ Script Editor';
  // strict: header lệch schema → THROW fail-closed (review 2026-08-19) — editor sửa
  // header/migration tay trước khi vận hành, không để writer ghi sai cột âm thầm.
  ensureSheets_(true);
  return 'OK: sheets đã sẵn sàng';
}
