/**
 * ReportService.gs — Service viewReports (Báo cáo chấm công tháng theo email đăng nhập).
 *
 * - Gate requireRole_('operator') TRONG service (pattern DEFENSE — google.script.run
 *   gọi được hàm global trực tiếp, gate ở wrapper *Api bị bypass). viewReports operator+ — báo cáo chính mình (2026-08-20).
 * - user = email đăng nhập (getActiveEmail_) → StaffInfo email→Ops ID →
 *   lọc StaffAttendance theo Ops ID → rows cache per-user 60s (REPORTS + email).
 * - Operator đọc qua readStaffInfoByEmail_/readAttendanceRowsSelf_ (self-only, không probe);
 *   reader manager+ (readStaffInfoMap_/readAttendanceRowsAll_) giữ gate manager — map email→Ops
 *   + toàn bộ chấm công không rò xuống operator.
 * - KHÔNG trả dữ liệu người khác: thiếu email / chưa khai StaffInfo → rows rỗng + message.
 * - Chỉ đọc — không ghi sheet nguồn.
 */
function getReports() {
  try {
    if (!requireRole_('operator')) {
      return { ok: false, rows: [], message: 'Không đủ quyền (cần role operator trở lên)' };
    }
    const email = String(getActiveEmail_() || '').trim().toLowerCase();
    if (!email) {
      return { ok: true, rows: [], email: '', message: 'Chưa đăng nhập — không xác định được nhân viên' };
    }
    const isManager = requireRole_('manager');
    // Operator: self-only reader (session email → opsId → rows của mình), không đụng
    // reader manager+ (map email→Ops + toàn bộ chấm công vẫn gate manager).
    const me = isManager ? (readStaffInfoMap_()[email] || null) : readStaffInfoByEmail_(email);
    if (!me || !me.opsId) {
      return { ok: true, rows: [], email: email, message: 'Không tìm thấy mã nhân viên (StaffInfo) cho email này' };
    }
    const rows = cachedJson_(CACHE_KEYS.REPORTS + email, function () {
      return isManager ? readAttendanceRows_(me.opsId) : readAttendanceRowsSelf_();
    }, CACHE_TTL.REPORTS);
    // Ambiguous phần số (OPS12345 vs ABC12345 cùng suffix) → rows đã lọc exact-only ở
    // filterAttendanceRows; báo rõ để user/admin kiểm tra StaffInfo (review 2026-08-19).
    // Operator không check ambiguous (cần toàn bộ dữ liệu — reader manager+) — chỉ manager.
    const ambiguous = !rows.length && isManager && ambiguousOpsId_(readAttendanceRowsAll_(), me.opsId);
    return {
      ok: true,
      rows: rows,
      email: email,
      opsId: me.opsId,
      staffName: me.name || '',
      message: rows.length ? ''
        : (ambiguous ? 'Mã ' + me.opsId + ' trùng phần số với nhân viên khác trong StaffAttendance — báo admin kiểm tra StaffInfo'
          : 'Chưa có dữ liệu chấm công (StaffAttendance) cho nhân viên này'),
    };
  } catch (e) {
    return { ok: false, rows: [], message: e && e.message ? e.message : 'getReports fail' };
  }
}
