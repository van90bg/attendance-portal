/**
 * Auth.gs — Định danh người dùng & quyền (tách từ Code.gs 2026-08-11).
 *
 * Deploy (appsscript.json): executeAs USER_DEPLOYING + access DOMAIN → getActiveUser()
 * trả email người truy cập TRONG domain (đã login Google); anonymous/ngoài
 * domain → rỗng. MỌI lấy email PHẢI qua
 * getActiveEmail_() — 1 nguồn duy nhất, try/catch — KHÔNG lặp khối Session ở
 * nhiều file (trước đây lặp 5 chỗ ở Code/TaskService/ScanService).
 *
 * Quyền:
 * - admin (isEditor_): email trùng DEPLOYER_EMAIL (Script Properties).
 * - task-owner (canScanOpen_ ở ScanLogic.gs, pure): chủ task khi phase OPEN.
 * - Role mở rộng (2026-08-11): viewer<operator<manager<admin — ROLES (Config.gs),
 *   roleMap lưu Config sheet (SettingsService), đọc qua getRole_; gate chuẩn
 *   requireRole_(min). operator là MẶC ĐỊNH (giữ hành vi quét); gate quản trị
 *   áp qua requireRole_ — KHÔNG fail-closed anonymous thành viewer.
 */

// Memo per-invocation: scanStaff/getTaskDetail gọi getActiveEmail_ 3-5 lần/request qua
// requireRole_ -> getRole_ -> isEditor_; GAS reset module-var mỗi request nên không stale.
var _activeEmailCache_ = null;
var _activeEmailCached_ = false;
/** Email người đang truy cập webapp ('' khi anonymous / không lấy được). */
function getActiveEmail_() {
  if (_activeEmailCached_) return _activeEmailCache_;
  try {
    _activeEmailCache_ = Session.getActiveUser().getEmail() || '';
  } catch (e) {
    _activeEmailCache_ = '';
  }
  _activeEmailCached_ = true;
  return _activeEmailCache_;
}

/**
 * Người dùng hiện tại + quyền.
 * @returns {{email: string, role: string, isAdmin: boolean}} — role từ roleMap (Config sheet)
 */
function getCurrentUser() {
  const email = getActiveEmail_();
  return { email: email, role: getRole_(email), isAdmin: isEditor_() };
}

/** Bậc role (viewer<operator<manager<admin) — role không biết → viewer (fail-closed). */
function roleRank_(role) {
  const r = String(role || '').toLowerCase();
  if (r === ROLES.ADMIN) return 4;
  if (r === ROLES.MANAGER) return 3;
  if (r === ROLES.OPERATOR) return 2;
  return 1; // viewer + role lạ
}

/**
 * Role của email: roleMap (Config sheet qua SettingsService) > ROLES.DEFAULT.
 * Editor (isEditor_) luôn admin (override map). Anonymous (email rỗng) → operator
 * (anonymous giữ hành vi quét hiện tại — KHÔNG fail-closed thành viewer).
 * @param {string} email
 * @returns {string}
 */
function getRole_(email) {
  if (isEditor_()) return ROLES.ADMIN;
  const em = String(email || '').trim().toLowerCase();
  if (!em) return ROLES.DEFAULT;
  const map = getRoleMap_();
  const entry = map && typeof map === 'object' ? map[em] : undefined;
  if (entry === undefined) return ROLES.DEFAULT; // không cấu hình → operator mặc định (giữ hành vi quét)
  const role = String(entry || '').trim().toLowerCase();
  const valid = role === ROLES.VIEWER || role === ROLES.OPERATOR
    || role === ROLES.MANAGER || role === ROLES.ADMIN;
  if (!valid) {
    // roleMap có nhưng gõ sai → fail-closed viewer (KHÔNG nâng nhầm lên operator).
    console.warn('getRole_: role không hợp lệ trong roleMap cho ' + em + ' (' + role + ') → viewer');
    return ROLES.VIEWER;
  }
  return role;
}

/** Gate role tối thiểu — fail-closed cả 2 phía:
 * - user role thấp hơn yêu cầu → false;
 * - minRole KHÔNG thuộc ROLES (gõ sai) → false (KHÔNG fail-open thành viewer-rank).
 */
function requireRole_(minRole) {
  const min = String(minRole || '').toLowerCase();
  if (min !== ROLES.VIEWER && min !== ROLES.OPERATOR && min !== ROLES.MANAGER && min !== ROLES.ADMIN) {
    return false; // minRole lạ → chặn
  }
  return roleRank_(getRole_(getActiveEmail_())) >= roleRank_(min);
}

/**
 * Gate editor-only — chỉ thao tác QUẢN LÝ (tạo/kết thúc/mở lại task + debug/sync/setup).
 * Manifest executeAs USER_DEPLOYING → getEffectiveUser() LUÔN = deployer (script chạy với quyền
 * deployer) — KHÔNG dùng so sánh active===effective để xác định editor.
 * Đúng: editor = user truy cập đã đăng nhập VÀ email trùng DEPLOYER_EMAIL
 * (lấy từ Script Properties — KHÔNG hardcode).
 * Bối cảnh: máy cá nhân của manager → chỉ cần định danh tài khoản, KHÔNG cần PIN.
 */
function isEditor_() {
  try {
    const active = getActiveEmail_();
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
