/**
 * SettingsService.gs — Đọc/ghi cấu hình Config sheet (nền tảng trang Config Admin).
 *
 * Model:
 * - Defaults = SETTINGS_DEFAULTS (Config.gs) — ship cùng code, nguồn sự thật giá trị mặc định.
 * - Config sheet chỉ lưu OVERRIDE (delta) — 2 cột [Key, Value], Value = JSON string.
 * - getSettings_() merge defaults + override → cache versioned (CACHE_KEYS.SETTINGS, TTL 60s);
 *   saveSettings_() invalidate cache sau khi ghi → reader nhận giá trị mới ngay.
 * - saveSettings_(patch) — whitelist key CÓ trong SETTINGS_DEFAULTS (chặn hàng rác), ghi
 *   row mới hoặc update row cũ, gate editor (isEditor_, fail-closed như syncFromCsv).
 * - P1 (kiến trúc): chưa hỗ trợ 'spreadsheetId' (chỉ định data sheet khác) — cần tách
 *   getSpreadsheet_ thành config-spreadsheet vs data-spreadsheet trước khi thêm key này
 *   (tránh config chết / đệ quy khi đọc Config sheet từ chính spreadsheet cấu hình).
 */

/** Đọc toàn bộ settings (defaults + override Config sheet) — cache 60s.
 * KHÔNG chứa roleMap: settings này operator path (getFilterOptionsApi/getSetting_) dùng
 * được — bản đồ quyền lộ ra là rò rỉ P0 → tách riêng getRoleMap_() (Auth.getRole_ đọc).
 * @returns {Object<string, *>} merged settings (mọi key SETTINGS_DEFAULTS có mặt, trừ roleMap)
 */
function getSettings_() {
  return cachedJson_(CACHE_KEYS.SETTINGS, function () {
    const merged = {};
    Object.keys(SETTINGS_DEFAULTS).forEach(function (k) { merged[k] = SETTINGS_DEFAULTS[k]; });
    const sheet = getSheet_(SHEETS.CONFIG);  // header ['Key','Value'] do ensureSheets_ đặt
    const values = sheet.getDataRange().getValues();
    values.forEach(function (row, i) {
      if (i === 0) return; // bỏ header
      const key = String(row[0] || '').trim();
      if (!key) return;
      // Chỉ merge key CÓ trong defaults — hàng rác / key lạ trong sheet bị bỏ qua
      if (!(key in merged)) return;
      merged[key] = parseSettingValue_(row[1]);
    });
    delete merged.roleMap; // P0: settings public không lộ bản đồ quyền
    return merged;
  }, CACHE_TTL.SETTINGS);
}

/** Đọc roleMap (map email → role) — tách riêng settings, cache riêng (CACHE_KEYS.ROLE_MAP).
 * getRole_ (Auth) đọc mỗi lần xác thực; editor lấy qua getSettingsApi (merge riêng bên
 * Code.gs — client Config không gọi thẳng getSettings_). Invalidate cùng saveSettings_. */
function getRoleMap_() {
  return cachedJson_(CACHE_KEYS.ROLE_MAP, function () {
    const sheet = getSheet_(SHEETS.CONFIG);
    const values = sheet.getDataRange().getValues();
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][0] || '').trim() === 'roleMap') {
        const v = parseSettingValue_(values[i][1]);
        return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
      }
    }
    return {};
  }, CACHE_TTL.SETTINGS);
}

/** Đọc 1 setting — thuận tiện cho caller (P1: scan/task đọc defaultStation...). */
function getSetting_(key) {
  const all = getSettings_();
  return (all && key in all) ? all[key] : undefined;
}

/** Đọc 1 setting dạng danh sách (JSON array như stations/teams/slotcodes) — luôn trả array.
 * Settings sheet có thể chứa JSON string lệch kiểu (sửa tay) → parse an toàn, fallback []. */
function settingsList_(key) {
  const v = getSetting_(key);
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v) {
    try {
      const p = JSON.parse(v);
      if (Array.isArray(p)) return p;
    } catch (e) { /* rơi xuống fallback */ }
  }
  return [];
}

/** Ghi patch settings vào Config sheet — editor-only (fail-closed).
 * @param {Object<string, *>} patch — key phải nằm trong SETTINGS_DEFAULTS (whitelist)
 * @returns {{ok: boolean, saved: string[], ignored: string[], message: string}}
 */
function saveSettings_(patch) {
  if (!isEditor_()) {
    return { ok: false, saved: [], ignored: [], message: 'Chỉ editor (DEPLOYER_EMAIL) mới chỉnh cấu hình' };
  }
  const sheet = getSheet_(SHEETS.CONFIG);
  const saved = [];
  const ignored = [];
  // Lock TRƯỚC khi đọc values — 2 editor save đồng thời cùng đọc rowByKey rồi cùng append
  // sẽ tạo row trùng (pattern như createReconcileTask: lock trước mọi đọc).
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const values = sheet.getDataRange().getValues();
    // Map key → row index (1-based, tính cả header) — update row cũ, không append trùng
    const rowByKey = {};
    values.forEach(function (row, i) {
      if (i === 0) return;
      const key = String(row[0] || '').trim();
      if (key) rowByKey[key] = i + 1;
    });
    Object.keys(patch || {}).forEach(function (key) {
      if (patch[key] === undefined) { ignored.push(key); return; }  // value thiếu → không ghi
      if (!(key in SETTINGS_DEFAULTS)) { ignored.push(key); return; }  // whitelist — chặn key lạ
      const serialized = JSON.stringify(patch[key]);
      if (rowByKey[key]) {
        sheet.getRange(rowByKey[key], 1, 1, 2).setValues([[key, serialized]]);
      } else {
        sheet.appendRow([key, serialized]);
        rowByKey[key] = sheet.getLastRow();
      }
      saved.push(key);
    });
  } finally {
    lock.releaseLock();
  }
  if (saved.length) invalidateSettingsCache_();
  if (saved.length) audit_('settings', '', { saved: saved });
  return {
    ok: true,
    saved: saved,
    ignored: ignored,
    message: 'Đã lưu ' + saved.length + ' cấu hình' + (ignored.length ? ' — bỏ qua ' + ignored.length + ' key không hợp lệ' : ''),
  };
}

/** Xóa cache settings — gọi sau khi ghi Config sheet (reader không thấy giá trị cũ). */
function invalidateSettingsCache_() {
  cache_().remove(CACHE_KEYS.SETTINGS);
  cache_().remove(CACHE_KEYS.ROLE_MAP);  // roleMap cache riêng — saveSettings_({roleMap}) phải clear cùng
  cache_().remove(CACHE_KEYS.FILTER_OPTIONS);  // lists settings feed getFilterOptionsApi
}

/** Parse giá trị Config sheet → kiểu thật (JSON string). Cell rác / không phải JSON → trả nguyên. */
function parseSettingValue_(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return raw;  // cell number/boolean (GAS đọc kiểu gốc) — giữ nguyên
  if (raw === '') return '';
  try { return JSON.parse(raw); } catch (e) { return raw; }
}
