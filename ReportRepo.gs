/**
 * ReportRepo.gs — Đọc sheet StaffInfo + StaffAttendance cho viewReports (2026-08-16).
 *
 * - StaffInfo:      Staff Email → Ops ID (1 dòng/NV) — map email (lowercase) → { opsId, name }.
 * - StaffAttendance: chấm công tháng theo ngày (1 dòng/NV/ngày, nguồn ngoài upload).
 *   Đọc cột THEO TÊN HEADER (không theo index — sheet ngoài thêm bớt cột không vỡ),
 *   lọc theo Ops ID, "None"/rỗng → '' (hiển thị '—').
 * - KHÔNG tự tạo 2 sheet này (dữ liệu nguồn ngoài do user đổ vào — getSheetByName,
 *   không qua getSheet_ kẻo insertSheet tạo sheet trống mất dữ liệu ngầm).
 * - Mọi parser pure (buildStaffInfoMap/buildAttendanceRows) — test Node được.
 */

/** "None"/rỗng → '' (sheet ngoài dùng chữ "None" cho ô trống). */
function normCell_(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).trim();
  return (!s || s.toLowerCase() === 'none') ? '' : s;
}

/** Normalize mã Ops cho so khớp: trim + uppercase. */
function normOpsId_(v) {
  return String(v || '').trim().toUpperCase();
}

/** Rút phần số của mã Ops ("Ops103487" → "103487") — so khớp dự phòng khi 2 nguồn lệch tiền tố. */
function opsDigits_(v) {
  return String(v || '').replace(/[^0-9]/g, '');
}

/**
 * Parse StaffInfo values (2D, dòng 1 = header) → { emailLower: { opsId, name } }.
 * Bỏ dòng thiếu email hoặc Ops ID. Email lowercase + trim (so khớp không phân biệt hoa thường).
 */
function buildStaffInfoMap(values) {
  const map = {};
  if (!values || values.length < 2) return map;
  const hdr = {};
  (values[0] || []).forEach(function (h, i) {
    const name = String(h || '').trim();
    if (name) hdr[name] = i;
  });
  for (let i = 1; i < values.length; i++) {
    const row = values[i] || [];
    const email = String(row[hdr['Staff Email']] !== undefined ? row[hdr['Staff Email']] : '').trim().toLowerCase();
    const opsRaw = String(row[hdr['Ops ID']] !== undefined ? row[hdr['Ops ID']] : '').trim();
    if (!email || !opsRaw) continue;
    map[email] = { opsId: opsRaw, name: String(row[hdr['Staff Name']] !== undefined ? row[hdr['Staff Name']] : '').trim() };
  }
  return map;
}

/**
 * Parse toàn bộ StaffAttendance values (2D, dòng 1 = header) → rows (mọi Ops).
 * - Map cột theo tên header (trim) — sheet thêm/bớt cột không vỡ; cột thiếu → ''.
 * - Sort giảm dần theo report_date (ISO yyyy-MM-dd sort string được).
 * - Trả { reportDate, bizStaffId, employeeId, staffName, station, result, workHour, inTime, outTime, pmo }.
 * Tách riêng khỏi lọc — readAttendanceRows_ cache bản parse này 1 lần cho mọi user.
 */
function buildAttendanceRowsAll(values) {
  const out = [];
  if (!values || values.length < 2) return out;
  const hdr = {};
  (values[0] || []).forEach(function (h, i) {
    const name = String(h || '').trim();
    if (name) hdr[name] = i;
  });
  const cell = function (row, name) {
    const idx = hdr[name];
    return idx === undefined ? '' : normCell_(row[idx]);
  };
  for (let i = 1; i < values.length; i++) {
    const row = values[i] || [];
    const bizRaw = cell(row, 'biz_staff_id').trim();
    if (!bizRaw) continue;  // dòng trống
    out.push({
      reportDate: cell(row, 'report_date'),
      bizStaffId: bizRaw,
      employeeId: cell(row, 'employee_id'),
      staffName: cell(row, 'staff_name'),
      station: cell(row, 'profile_station_name'),
      result: cell(row, 'attendance_result_ops'),
      workHour: cell(row, 'work_hour'),
      inTime: cell(row, 'in_time_convert'),
      outTime: cell(row, 'out_time_convert'),
      pmo: cell(row, 'PMO formula'),
    });
  }
  out.sort(function (a, b) {
    return (a.reportDate < b.reportDate) ? 1 : (a.reportDate > b.reportDate) ? -1 : 0;
  });
  return out;
}

/** Lọc rows theo 1 Ops ID (norm uppercase; dự phòng so phần số khi lệch tiền tố). */
function filterAttendanceRows(rows, rawOpsId) {
  const want = normOpsId_(rawOpsId);
  const wantDigits = opsDigits_(want);
  return (rows || []).filter(function (r) {
    const biz = normOpsId_(r.bizStaffId);
    const bizDigits = opsDigits_(biz);
    if (biz !== want && (bizDigits !== wantDigits || !wantDigits)) return false;
    return true;
  });
}

/** Parse + lọc theo Ops ID (wrapper — giữ chữ ký cũ cho test/client). */
function buildAttendanceRows(values, rawOpsId) {
  return filterAttendanceRows(buildAttendanceRowsAll(values), rawOpsId);
}

/** StaffInfo map email→Ops (cache 1h — version-key REPORT_INFO). */
function readStaffInfoMap_() {
  return cachedJson_(CACHE_KEYS.REPORT_INFO, function () {
    const sheet = getSpreadsheet_().getSheetByName(SHEETS.STAFF_INFO);
    if (!sheet) return {};
    return buildStaffInfoMap(sheet.getDataRange().getValues());
  }, CACHE_TTL.REPORT_INFO);
}

/** Toàn bộ dòng StaffAttendance đã parse — cache CHUNG 60s (mọi user dùng 1 bản,
 * không mỗi user đọc lại full sheet). Sheet ngoài update trong ngày → TTL ngắn.
 */
function readAttendanceRowsAll_() {
  return cachedJson_(CACHE_KEYS.REPORTS + 'all', function () {
    const sheet = getSpreadsheet_().getSheetByName(SHEETS.REPORT_ATTENDANCE);
    if (!sheet) return [];
    return buildAttendanceRowsAll(sheet.getDataRange().getValues());
  }, CACHE_TTL.REPORTS);
}

/** Chấm công của 1 Ops ID — filter từ cache chung (không đọc lại sheet). */
function readAttendanceRows_(opsId) {
  return filterAttendanceRows(readAttendanceRowsAll_(), opsId);
}
