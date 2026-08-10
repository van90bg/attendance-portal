/**
 * StaffDataRepo.gs — Đọc/ghi sheet StaffData (tách từ Database.gs 2026-08-11).
 *
 * - readStaffIndex_: index { staffId: staff } cache 5m (đường quét — tên NV lạ).
 * - readStaffList_/readStaffFullList_: danh sách objects (create-modal / thống kê).
 * - Mọi parser qua buildStaffIndex/buildStaffListFromValues (CsvUtil) — 1 nguồn duy nhất.
 * - invalidateStaffIndex_: gọi sau syncFromCsv (STAFF_INDEX + STAFF_LIST + STAFF_STATS).
 */

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
  cache_().remove(CACHE_KEYS.STAFF_LIST);
  cache_().remove(CACHE_KEYS.STAFF_STATS);
}

/**
 * Đọc TOÀN BỘ StaffData dạng list objects — FULL 20 field (view thống kê StaffData).
 * Cache riêng (STAFF_STATS, 1h) — KHÔNG chung STAFF_LIST để không phình cache dùng cho
 * create-modal. Dùng buildStaffListFromValues (CsvUtil — giữ mọi dòng, không dedupe).
 */
function readStaffFullList_() {
  return cachedJson_(CACHE_KEYS.STAFF_STATS, function () {
    const sheet = getSheet_(SHEETS.STAFF_DATA);
    return buildStaffListFromValues(sheet.getDataRange().getValues());
  }, CACHE_TTL.STAFF_STATS);
}

/** Đọc toàn bộ StaffData dạng mảng objects (cache 5m — version-key STAFF_LIST).
 * Dùng buildStaffListFromValues (CsvUtil) — 1 parser duy nhất cho StaffData.
 * (readStaffListUncached_ cũ tự reimplement parser → drift field so với
 * buildStaffListFromValues, vd thiếu staffEmail/agency/department — đã xóa.) */
function readStaffList_() {
  return cachedJson_(CACHE_KEYS.STAFF_LIST, function () {
    const sheet = getSheet_(SHEETS.STAFF_DATA);
    return buildStaffListFromValues(sheet.getDataRange().getValues());
  }, CACHE_TTL.STAFF_LIST);
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
