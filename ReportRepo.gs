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

/** Có >1 ID THẬT khác nhau cùng phần số với ID đang tra (vd OPS12345 + ABC12345) —
 * fallback phần số trong trường hợp này là AMBIGUOUS (trả nhầm dữ liệu người khác). */
function ambiguousOpsId_(rows, rawOpsId) {
  const wantDigits = opsDigits_(normOpsId_(rawOpsId));
  if (!wantDigits) return false;
  const owners = {};
  (rows || []).forEach(function (r) {
    const b = normOpsId_(r.bizStaffId);
    const d = opsDigits_(b);
    if (b && d && d === wantDigits) owners[b] = true;
  });
  return Object.keys(owners).length > 1;
}

/** Lọc rows theo 1 Ops ID (norm uppercase; dự phòng so phần số khi lệch tiền tố).
 * Review 2026-08-19: fallback phần số CHỈ khi suffix unique trong dữ liệu —
 * ambiguous (nhiều ID cùng phần số) → chỉ khớp chính xác, KHÔNG trả dữ liệu người khác. */
function filterAttendanceRows(rows, rawOpsId) {
  const want = normOpsId_(rawOpsId);
  const wantDigits = opsDigits_(want);
  const ambiguous = ambiguousOpsId_(rows, rawOpsId);
  return (rows || []).filter(function (r) {
    const biz = normOpsId_(r.bizStaffId);
    if (biz === want) return true;
    if (!wantDigits || ambiguous) return false;
    return opsDigits_(biz) === wantDigits;
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

/** Toàn bộ dòng StaffAttendance đã parse — cache CHUNG 60s, chia CHUNK theo dung
 * lượng (CacheService giới hạn 100KB/key — sheet tháng thật vượt 1 key → put fail
 * âm thầm + đọc lại sheet mỗi request). Meta '_all_n' = số chunk; '_all_i' = dữ liệu.
 * Mọi user dùng 1 bản — không mỗi user đọc lại full sheet.
 */
function readAttendanceRowsAll_() {
  const nKey = CACHE_KEYS.REPORTS + 'all_n';
  const nRaw = cache_().get(nKey);
  if (nRaw !== null) {
    try {
      const n = parseInt(nRaw, 10);
      let json = '';
      let ok = n > 0;
      for (let i = 0; i < n && ok; i++) {
        const part = cache_().get(CACHE_KEYS.REPORTS + 'all_' + i);
        if (part === null) { ok = false; break; }
        json += part;
      }
      if (ok) {
        try { return JSON.parse(json); } catch (e) { /* cache hỏng → rebuild */ }
      }
    } catch (e) { /* rơi xuống rebuild */ }
  }
  const sheet = getSpreadsheet_().getSheetByName(SHEETS.REPORT_ATTENDANCE);
  const rows = sheet ? buildAttendanceRowsAll(sheet.getDataRange().getValues()) : [];
  try {
    const json = JSON.stringify(rows);
    const CHUNK = 80000; // byte/key — dưới giới hạn 100KB của CacheService
    const n = Math.max(1, Math.ceil(json.length / CHUNK));
    for (let i = 0; i < n; i++) {
      cache_().put(CACHE_KEYS.REPORTS + 'all_' + i, json.slice(i * CHUNK, (i + 1) * CHUNK), CACHE_TTL.REPORTS);
    }
    cache_().put(nKey, String(n), CACHE_TTL.REPORTS);
  } catch (e) {
    console.warn('readAttendanceRowsAll_ cache put fail', e && e.message);
  }
  return rows;
}

/** Chấm công của 1 Ops ID — filter từ cache chung (không đọc lại sheet). */
function readAttendanceRows_(opsId) {
  if (!requireRole_('manager')) return [];
  return filterAttendanceRows(readAttendanceRowsAll_(), opsId);
}
