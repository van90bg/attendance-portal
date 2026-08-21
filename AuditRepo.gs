/**
 * AuditRepo.gs — Nhật ký hoạt động quản trị (audit log).
 * Ghi mọi mutation quan trọng: ai (email) làm gì (action) với đối tượng nào
 * (targetId) lúc nào (timestamp) + chi tiết (detail JSON). Sheet RIÊNG (AuditLog)
 * — không trộn với AttendanceLog (dữ liệu chấm công). Đọc ngược (mới nhất trước).
 * audit_ KHÔNG gate — caller đã gate; lỗi ghi audit chỉ log console, KHÔNG làm
 * gãy nghiệp vụ chính (audit là phụ, scan/complete phải chạy được dù audit fail).
 */

/** Whitelist action hợp lệ (review 2026-08-19) — audit_ là hàm global gọi được qua
 * google.script.run; action lạ (doạ dòng junk) bị BỎ, không làm phình AuditLog.
 * Thêm action mới phải vào đây — KHÔNG audit action chưa đăng ký. */
const AUDIT_ACTIONS_ = {
  createTask: true, completeTaskForceClose: true,
  completeTask: true, transitionToAttend: true, reopenTask: true, cancelTask: true,
  fixLogRowStatus: true, settings: true,
  loadRoster: true,  // S1 (2026-08-21): appendRoster_ nạp roster vào task rỗng
};

/** Ghi 1 dòng audit (append + LockService — append row không lock có thể interleave
 * khi 2 execution ghi cùng lúc; lock re-entrant nên an toàn với caller đã giữ lock). */
function audit_(action, targetId, detail) {
  try {
    const act = String(action || '');
    if (!AUDIT_ACTIONS_[act]) {
      console.warn('audit_ bỏ qua action ngoài whitelist:', act);
      return;
    }
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const sheet = getSheet_(SHEETS.AUDIT_LOG);
      const row = [
        new Date().toISOString(),
        getActiveEmail_() || 'web',
        act,
        String(targetId || ''),
        JSON.stringify(detail || {}),
      ];
      sheet.appendRow(row);
    } finally {
      lock.releaseLock();
    }
  } catch (e) {
    console.error('audit_ fail:', e && e.message ? e.message : e);
  }
}

/** Đọc audit gần nhất — mới nhất trước. limit 1..200, mặc định 50. */
function getAuditLog_(limit) {
  if (!requireRole_('admin')) return [];
  const sheet = getSheet_(SHEETS.AUDIT_LOG);
  const max = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];
  // Chỉ đọc cửa sổ max dòng mới nhất — getDataRange full sheet mỗi lần mở
  // viewAdmin chậm dần khi AuditLog phình (mutation quản trị vẫn tích lũy).
  const startRow = Math.max(2, lastRow - max + 1);
  const values = sheet.getRange(startRow, 1, lastRow - startRow + 1, sheet.getLastColumn()).getValues();
  const rows = [];
  for (let i = 0; i < values.length; i++) {
    rows.push({
      timestamp: String(values[i][AUDIT_LOG_COLS.TIMESTAMP] || ''),
      email: String(values[i][AUDIT_LOG_COLS.EMAIL] || ''),
      action: String(values[i][AUDIT_LOG_COLS.ACTION] || ''),
      targetId: String(values[i][AUDIT_LOG_COLS.TARGET_ID] || ''),
      detail: String(values[i][AUDIT_LOG_COLS.DETAIL] || ''),
    });
  }
  rows.reverse();
  return rows.slice(0, max);
}
