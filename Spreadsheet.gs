/**
 * Spreadsheet.gs — Khởi tạo & truy cập spreadsheet (tách từ Database.gs 2026-08-11).
 *
 * Gọi GAS API (SpreadsheetApp) — KHÔNG test Node trực tiếp.
 * Quy tắc bất biến (v1 lesson):
 * - getSpreadsheet_ KHÔNG tự tạo DB khi chưa cấu hình (ALLOW_DB_AUTO_CREATE=false) — fail loud.
 * - getSheet_ chỉ set header khi sheet trống; migration cột log trong ensureSheets_.
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
  // m7 (audit): fail cứng thay vì tự tạo DB mới rỗng âm thầm. Deploy sai cấu hình
  // (chưa set DEFAULT_SPREADSHEET_ID + Script Properties, không có active) phải ném
  // lỗi rõ ràng để operator sửa ngay — tránh phân mảnh dữ liệu sang DB mới.
  if (!ALLOW_DB_AUTO_CREATE) {
    throw new Error('[m7] Chưa cấu hình spreadsheet. Đặt DEFAULT_SPREADSHEET_ID (Config.gs) '
      + 'hoặc Script Property SPREADSHEET_ID. Để tránh tự tạo DB rỗng.');
  }
  const created = SpreadsheetApp.create('RollCall v2 DB');
  props.setProperty('SPREADSHEET_ID', created.getId());
  return created;
}

/** Đảm bảo toàn bộ sheet tồn tại (dùng khi khởi tạo). */
function ensureSheets_() {
  getSheet_(SHEETS.CONFIG, ['Key', 'Value']);
  // Header chuẩn Att.csv (20 cột) — getSheet_ chỉ set khi sheet trống; syncFromCsv()
  // ghi đè dữ liệu từ dòng 2 (header dòng 1 giữ nguyên).
  getSheet_(SHEETS.STAFF_DATA, STAFF_DATA_HEADER);
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
