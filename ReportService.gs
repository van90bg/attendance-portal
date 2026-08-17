/**
 * ReportService.gs — Service viewReports (Báo cáo chấm công tháng theo email đăng nhập).
 *
 * - Gate requireRole_('manager') TRONG service (pattern DEFENSE — google.script.run
 *   gọi được hàm global trực tiếp, gate ở wrapper *Api bị bypass). viewReports manager+ (2026-08-17).
 * - user = email đăng nhập (getActiveEmail_) → StaffInfo map email→Ops ID →
 *   lọc StaffAttendance theo Ops ID → rows cache per-user 60s (REPORTS + email).
 * - KHÔNG trả dữ liệu người khác: thiếu email / chưa khai StaffInfo → rows rỗng + message.
 * - Chỉ đọc — không ghi sheet nguồn.
 */
function getReports() {
  try {
    if (!requireRole_('manager')) {
      return { ok: false, rows: [], message: 'Không đủ quyền (cần role manager trở lên)' };
    }
    const email = String(getActiveEmail_() || '').trim().toLowerCase();
    if (!email) {
      return { ok: true, rows: [], email: '', message: 'Chưa đăng nhập — không xác định được nhân viên' };
    }
    const info = readStaffInfoMap_();
    const me = info[email];
    if (!me || !me.opsId) {
      return { ok: true, rows: [], email: email, message: 'Không tìm thấy mã nhân viên (StaffInfo) cho email này' };
    }
    const rows = cachedJson_(CACHE_KEYS.REPORTS + email, function () {
      return readAttendanceRows_(me.opsId);
    }, CACHE_TTL.REPORTS);
    return {
      ok: true,
      rows: rows,
      email: email,
      opsId: me.opsId,
      staffName: me.name || '',
      message: rows.length ? '' : 'Chưa có dữ liệu chấm công (StaffAttendance) cho nhân viên này',
    };
  } catch (e) {
    return { ok: false, rows: [], message: e && e.message ? e.message : 'getReports fail' };
  }
}
