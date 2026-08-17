/**
 * AuditRepo.gs — Nhật ký hoạt động quản trị (audit log).
 * Ghi mọi mutation quan trọng: ai (email) làm gì (action) với đối tượng nào
 * (targetId) lúc nào (timestamp) + chi tiết (detail JSON). Sheet RIÊNG (AuditLog)
 * — không trộn với AttendanceLog (dữ liệu chấm công). Đọc ngược (mới nhất trước).
 * audit_ KHÔNG gate — caller đã gate; lỗi ghi audit chỉ log console, KHÔNG làm
 * gãy nghiệp vụ chính (audit là phụ, scan/complete phải chạy được dù audit fail).
 */

/** Ghi 1 dòng audit (append — không lock, sheet nhỏ). */
function audit_(action, targetId, detail) {
  try {
    const sheet = getSheet_(SHEETS.AUDIT_LOG);
    const row = [
      new Date().toISOString(),
      getActiveEmail_() || 'web',
      String(action || ''),
      String(targetId || ''),
      JSON.stringify(detail || {}),
    ];
    sheet.appendRow(row);
  } catch (e) {
    console.error('audit_ fail:', e && e.message ? e.message : e);
  }
}

/** Đọc audit gần nhất — mới nhất trước. limit 1..200, mặc định 50. */
function getAuditLog_(limit) {
  const sheet = getSheet_(SHEETS.AUDIT_LOG);
  const values = sheet.getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    rows.push({
      timestamp: String(values[i][AUDIT_LOG_COLS.TIMESTAMP] || ''),
      email: String(values[i][AUDIT_LOG_COLS.EMAIL] || ''),
      action: String(values[i][AUDIT_LOG_COLS.ACTION] || ''),
      targetId: String(values[i][AUDIT_LOG_COLS.TARGET_ID] || ''),
      detail: String(values[i][AUDIT_LOG_COLS.DETAIL] || ''),
    });
  }
  rows.reverse();
  const max = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  return rows.slice(0, max);
}
