/**
 * Code.gs — Entry point + API endpoints (google.script.run).
 *
 * API (gọi từ client index.html):
 *   getMeta()                    → { appTitle, labels, tableHeaders }
 *   getFilterOptions()           → { stations, slotCodes, teams }
 *   createReconcileTask(input)   → { ok, taskId, count, message }
 *   getTaskList()                → [{ taskId, station, slotCode, team, status, createdAt }]
 *   getTaskDetail(taskId)        → { ok, task, log, counters }
 *   scanStaff(taskId, staffId)   → { ok, message, status, counters }
 *   completeTask(taskId)         → { ok, message }
 *   syncFromCsv()                → { ok, count, message } — gọi từ editor (Phase 0)
 */

/** WebApp: trả về index.html. */
function doGet(e) {
  // Tự khởi tạo mọi sheet (kèm header) — không cần chạy setupSheets() tay.
  // getSheet_() chỉ set header khi sheet trống, nên gọi mỗi lần load rất rẻ.
  ensureSheets_();
  // Debug: URL?debug=1 → trả JSON cấu trúc sheet (QA/verify — KHÔNG dùng production)
  // P2: gate editor-only — kiosk anonymous, ai cũng gọi URL này → leak cấu trúc
  // sheet + taskId + mẫu log. Session.getActiveUser() rỗng khi anonymous truy cập.
  if (e && e.parameter && e.parameter.debug === '1') {
    if (!isEditor_()) {
      return ContentService.createTextOutput(JSON.stringify({
        error: 'debug=1 chỉ chạy từ Script Editor',
      })).setMimeType(ContentService.MimeType.JSON);
    }
    return ContentService.createTextOutput(JSON.stringify(debugState_()))
      .setMimeType(ContentService.MimeType.JSON);
  }
  // Debug: URL?debug=createTask&station=..&slotCode=..&team=.. → tạo task thật + trả detail
  // (CHỈ dùng QA — mở khóa khi cần test luồng end-to-end không qua UI)
  // P1: gate editor-only — kiosk anonymous, ai cũng gọi URL này → tạo task rác.
  // Session.getActiveUser() rỗng khi anonymous truy cập webapp.
  if (e && e.parameter && e.parameter.debug === 'createTask') {
    if (!isEditor_()) {
      return ContentService.createTextOutput(JSON.stringify({
        error: 'debug=createTask chỉ chạy từ Script Editor',
      })).setMimeType(ContentService.MimeType.JSON);
    }
    try {
      const input = {
        station: e.parameter.station || '',
        slotCode: e.parameter.slotCode || '',
        team: e.parameter.team || '',
      };
      const created = createReconcileTask(input);
      const detail = created.ok ? getTaskDetail(created.taskId) : null;
      return ContentService.createTextOutput(JSON.stringify({
        create: created,
        detail: detail ? {
          ok: detail.ok,
          taskId: detail.task ? detail.task.taskId : null,
          logLen: detail.log ? detail.log.length : 0,
          logFirst: detail.log && detail.log.length ? detail.log[0] : null,
          counters: detail.counters,
        } : null,
      })).setMimeType(ContentService.MimeType.JSON);
    } catch (err) {
      return ContentService.createTextOutput(JSON.stringify({ error: String(err) }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle(WEB_APP.PAGE_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/** Debug: cấu trúc toàn bộ sheet (chạy qua ?debug=1). PRIVATE — không public qua google.script.run. */
function debugState_() {
  // Gate editor-only — tên private (_) nên không gọi được từ client.
  if (!isEditor_()) {
    return { error: 'debugState chỉ chạy từ Script Editor' };
  }
  const ss = getSpreadsheet_();
  const out = { spreadsheetId: ss.getId(), sheets: {} };
  ['Config', 'StaffData', 'AttendanceTask', 'AttendanceLog'].forEach(function (name) {
    const s = ss.getSheetByName(name);
    if (!s) { out.sheets[name] = 'MISSING'; return; }
    const v = s.getDataRange().getValues();
    const rows = [];
    for (let i = 0; i < Math.min(v.length, 4); i++) {
      rows.push((v[i] || []).map(function (c) {
        return String(c === undefined ? '' : c).slice(0, 18);
      }).join(' | ').slice(0, 220));
    }
    out.sheets[name] = {
      rows: v.length,
      cols: v[0] ? v[0].length : 0,
      first: rows[0] || '',
      sample: rows,
    };
  });
  // Test getTaskDetail trực tiếp (verify API không throw)
  const tlist = readTaskList_();
  out.tasks = tlist.map(function (t) { return t.taskId; });
  if (tlist.length) {
    try {
      out.taskDetailProbe = getTaskDetail(tlist[0].taskId);
      const td = out.taskDetailProbe;
      out.taskDetailProbe.task = td.task ? { taskId: td.task.taskId, status: td.task.status } : null;
      out.taskDetailProbe.logLen = td.log ? td.log.length : 0;
      if (td.log && td.log.length) {
        out.taskDetailProbe.logFirst = td.log[0];
      }
    } catch (e) {
      out.taskDetailProbeError = String(e);
    }
  }
  return out;
}

/** Meta cho UI: title. */
function getMeta() {
  // Deploy "Anyone within @spxexpress.com" → getActiveUser() có email (user đăng nhập Google).
  // Anonymous thật (không login) → rỗng. Hiển thị ở header như v1.
  let userEmail = '';
  try { userEmail = Session.getActiveUser().getEmail() || ''; } catch (e) { userEmail = ''; }
  return {
    ok: true,
    appTitle: UI_LABELS.APP_TITLE,
    userEmail: userEmail,
  };
}

/** Distinct values cho dropdown + cây nhóm cho modal tạo task. */
function getFilterOptions() {
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

/** Preload staffIndex vào cache sớm (khi mở app / tạo xong task). Fix #1: tên NV lạ
 *  hiện NGAY khi quét đầu thay vì về sau mới có (do StaffData index bị lazy + cache 5p).
 *  MỞ cho mọi nhân viên — chỉ đọc (KHÔNG ghi) nên an toàn kiosk. */
function warmStaffCacheApi() {
  try {
    readStaffIndex_(); // gây cache (nếu chưa có) — các scan kế đọc từ cache, trả tên tức thì
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : 'warm failed' };
  }
}

/**
 * Gate editor-only — chỉ thao tác QUẢN LÝ (tạo/kết thúc/mở lại task + debug/sync/setup).
 * Deploy "Execute as: User accessing the web app" → getEffectiveUser() = user đó
 * (KHÔNG phải deployer), nên so sánh active===effective là SAI và dễ bị bypass.
 * Đúng: editor = user truy cập đã đăng nhập VÀ email trùng DEPLOYER_EMAIL
 * (lấy từ Script Properties — KHÔNG hardcode).
 * Bối cảnh: máy cá nhân của manager → chỉ cần định danh tài khoản, KHÔNG cần PIN.
 */
function isEditor_() {
  try {
    const active = Session.getActiveUser().getEmail();
    const deployer = getDeployerEmail_();
    // fail-closed: phải có active user VÀ trùng deployer email
    return !!(active && deployer && active.toLowerCase() === deployer.toLowerCase());
  } catch (e) {
    return false; // lỗi quyền → chặn (không fail-open)
  }
}

/** Email deployer (owner của script) — từ Script Properties (không hardcode). */
function getDeployerEmail_() {
  try {
    return PropertiesService.getScriptProperties().getProperty('DEPLOYER_EMAIL') || '';
  } catch (e) {
    return '';
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
