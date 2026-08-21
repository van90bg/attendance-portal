/**
 * StaffDataRepo.gs — Đọc/ghi sheet StaffData (tách từ Database.gs 2026-08-11).
 *
 * - readStaffList_/readStaffFullList_: danh sách objects (create-modal / thống kê).
 * - readStaffIndex_: index { staffId: staff } derive TỪ readStaffList_ (1 sheet read,
 *   không cache riêng — list cache 5m là nguồn sự thật duy nhất).
 * - Mọi parser qua buildStaffIndex/buildStaffListFromValues (CsvUtil) — 1 nguồn duy nhất.
 * - invalidateStaffList_/invalidateStaffFullList_: gọi sau syncFromCsv (index derive từ list — xóa list là đủ).
 */


/**
 * Đọc TOÀN BỌ StaffData dạng list objects — FULL 20 field (view thống kê StaffData).
 * Cache riêng (STAFF_STATS, 1h) — KHÔNG chung STAFF_LIST để không phình cache dùng cho
 * create-modal. Dùng buildStaffListFromValues (CsvUtil — giữ mọi dòng, không dedupe).
 */
function readStaffFullList_() {
  if (!requireRole_('manager')) return [];
  return cachedJson_(CACHE_KEYS.STAFF_STATS, function () {
    return buildStaffListFromValues(getSheet_(SHEETS.STAFF_DATA).getDataRange().getValues(), getSpreadsheet_().getSpreadsheetTimeZone());
  }, CACHE_TTL.STAFF_STATS);
}

/**
 * Đọc toàn bộ StaffData dạng mảng objects (cache 5m — version-key STAFF_LIST).
 * Dùng buildStaffListFromValues (CsvUtil) — 1 parser duy nhất cho StaffData.
 * ĐÂY là nguồn sự thật duy nhất cho staff data — readStaffIndex_ derive từ đây
 * (không cache riêng, không đọc sheet lần 2).
 */
function readStaffList_() {
  if (!requireRole_('operator')) return [];  // M1: StaffData full 20 field — chỉ operator+ (create-modal/filter/roster)
  return cachedJson_(CACHE_KEYS.STAFF_LIST, function () {
    if (!requireRole_('operator')) return [];  // M1: gate trước khi đọc sheet
    return buildStaffListFromValues(getSheet_(SHEETS.STAFF_DATA).getDataRange().getValues(), getSpreadsheet_().getSpreadsheetTimeZone());
  }, CACHE_TTL.STAFF_LIST);
}

/**
 * Đọc StaffData → index { staffId: staff } (derive từ readStaffList_, không cache riêng).
 * Field slim: chỉ giữ field UI cần (ten/Ca/Station/Team/Agency/Ngày) — bỏ cardIn/cardOut.
 * @returns {Object<string, Object>}
 */
function readStaffIndex_() {
  if (!requireRole_('operator')) return {};  // M1: staff index = dữ liệu nhân sự — viewer không xem
  const list = readStaffList_();  // cache 5m — list là nguồn, index derive
  const index = {};
  (list || []).forEach(function (s) {
    const key = String(s.staffId || '').trim().toUpperCase();
    if (!key) return;
    index[key] = {
      staffId: key,
      staffName: s.staffName || '',
      slotCode: s.slotCode || '',
      station: s.station || '',
      team: s.team || '',
      workstation: s.workstation || '',
      agency: s.agency || '',
      date: s.date || '',
    };
  });
  return index;
}


/** Xóa cache staff list (gọi sau syncFromCsv). */
function invalidateStaffList_() {
  try { cache_().remove(CACHE_KEYS.STAFF_LIST); }
  catch (e) { console.warn('invalidateStaffList_ fail', e.message); }
  bumpCacheGen_();
}

/** Xóa cache staff full (viewStats — gọi sau syncFromCsv). */
function invalidateStaffFullList_() {
  try { cache_().remove(CACHE_KEYS.STAFF_STATS); }
  catch (e) { console.warn('invalidateStaffFullList_ fail', e.message); }
  bumpCacheGen_();
}

/** Ghi đè toàn bộ StaffData từ dữ liệu csv đã parse (syncFromCsv). */
function overwriteStaffData_(staffList) {
  if (!isEditor_()) return 0;
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
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
    invalidateStaffList_();
    invalidateStaffFullList_();
    return rows.length;
  } finally {
    lock.releaseLock();
  }
}
