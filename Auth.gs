/**
 * Auth.gs — Định danh người dùng & quyền (tách từ Code.gs 2026-08-11).
 *
 * Deploy "Execute as: User accessing the web app" → Session.getActiveUser() trả
 * email người đăng nhập (rỗng khi anonymous). MỌI lấy email PHẢI qua
 * getActiveEmail_() — 1 nguồn duy nhất, try/catch — KHÔNG lặp khối Session ở
 * nhiều file (trước đây lặp 5 chỗ ở Code/TaskService/ScanService).
 *
 * Quyền hiện tại:
 * - admin (isEditor_): email trùng DEPLOYER_EMAIL (Script Properties).
 * - task-owner (canScanOpen_ ở ScanLogic.gs, pure): chủ task khi phase OPEN.
 * Khi mở rộng role (manager/operator/viewer) → mở rộng getCurrentUser() +
 * mapping role theo Config sheet (SettingsService).
 */

/** Email người đang truy cập webapp ('' khi anonymous / không lấy được). */
function getActiveEmail_() {
  try {
    return Session.getActiveUser().getEmail() || '';
  } catch (e) {
    return '';
  }
}

/**
 * Người dùng hiện tại + quyền — seam cho role system tương lai.
 * @returns {{email: string, isAdmin: boolean}}
 */
function getCurrentUser() {
  return { email: getActiveEmail_(), isAdmin: isEditor_() };
}

/**
 * Gate editor-only — chỉ thao tác QUẢN LÝ (tạo/kết thúc/mở lại task + debug/sync/setup).
 * Deploy "Execute as: User accessing the web app" → getEffectiveUser() = user đó
 * (KHÔNG phải deployer), nên so sánh active===effective là SAI và dễ bị bypass.
 * Đúng: editor = user truy cập đã đăng nhập VÀ email trùng DEPLOYER_EMAIL
 * (lấy từ Script Properties — KHÔNG hardcode).
 * Bối cảnh: máy cá nhân của manager → chỉ cần định danh tài khoản, KHÔNG cần PIN.
 */
function isEditor_() {
  try {
    const active = Session.getActiveUser().getEmail();
    const deployer = getDeployerEmail_();
    // fail-closed: phải có active user VÀ trùng deployer email
    return !!(active && deployer && active.toLowerCase() === deployer.toLowerCase());
  } catch (e) {
    return false; // lỗi quyền → chặn (không fail-open)
  }
}

/** Email deployer (owner của script) — từ Script Properties (không hardcode). */
function getDeployerEmail_() {
  try {
    return PropertiesService.getScriptProperties().getProperty('DEPLOYER_EMAIL') || '';
  } catch (e) {
    return '';
  }
}
