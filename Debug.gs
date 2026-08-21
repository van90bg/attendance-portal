/**
 * Debug.gs — Nhánh debug URL (?debug=1 / ?debug=createTask) + debugState_.
 * Tách khỏi Code.gs 2026-08-11 — doGet giữ production entry sạch.
 *
 * TẤT CẢ nhánh này editor-gated (isEditor_) — anonymous không gọi được.
 * ?debug=1          → JSON cấu trúc toàn bộ sheet (QA/verify).
 * ?debug=createTask → tạo task thật + trả detail (QA end-to-end không qua UI).
 */

/**
 * Xử lý query param debug. Trả ContentService output NẾU là request debug,
 * ngược lại trả null (doGet tiếp tục serve index.html bình thường).
 * @param {Object} e — event doGet
 * @returns {TextOutput|null}
 */
function handleDebugRequest_(e) {
  // Debug: URL?debug=1 → trả JSON cấu trúc sheet (QA/verify — KHÔNG dùng production).
  // P2: gate editor-only — anonymous, ai cũng gọi URL này → leak cấu trúc
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
  // P1: gate editor-only — anonymous, ai cũng gọi URL này → tạo task rác.
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
      const created = createTask(input);
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
  return null;
}

/** Debug: cấu trúc toàn bộ sheet (chạy qua ?debug=1). PRIVATE — không public qua google.script.run. */
function debugState_() {
  // Gate editor-only — tên private (_) nên không gọi được từ client.
  if (!isEditor_()) {
    return { error: 'debugState chỉ chạy từ Script Editor' };
  }
  const ss = getSpreadsheet_();
  const out = { spreadsheetId: ss.getId(), sheets: {} };
  [SHEETS.CONFIG, SHEETS.STAFF_DATA, SHEETS.ATTENDANCE_TASK, SHEETS.ATTENDANCE_LOG].forEach(function (name) {
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
