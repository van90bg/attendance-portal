/**
 * SettingsService.gs — Đọc/ghi cấu hình Config sheet (nền tảng trang Config Admin).
 *
 * Model:
 * - Defaults = SETTINGS_DEFAULTS (Config.gs) — ship cùng code, nguồn sự thật giá trị mặc định.
 * - Config sheet 4 cột [Key, Value, Group, Index] (2026-08-11) — 2 loại key:
 *   + SINGLE (group rỗng): defaultStation/roleMap... — Value = JSON string (delta như cũ).
 *   + GROUP (group='station'|'team'|'slotcode'|'department'): mỗi dòng 1 giá trị có thứ tự
 *     (key station1..N, index=1..N) — danh sách lựa chọn cho dropdown tạo task / filter.
 * - getSettings_() merge defaults + override → cache versioned (CACHE_KEYS.SETTINGS, TTL 60s);
 *   saveSettings_() invalidate cache sau khi ghi → reader nhận giá trị mới ngay.
 * - saveSettings_(patch) — whitelist key CÓ trong SETTINGS_DEFAULTS (chặn hàng rác);
 *   single: ghi row mới / update row cũ; group: XÓA toàn bộ row của group rồi ghi lại
 *   theo index (đơn giản, tránh index lệch khi thêm/xoá giữa chừng); gate editor.
 * - roleMap GIỮ dạng JSON single key (map email→role — không phải list thuần).
 * - P1 (kiến trúc): chưa hỗ trợ 'spreadsheetId' (chỉ định data sheet khác) — cần tách
 *   getSpreadsheet_ thành config-spreadsheet vs data-spreadsheet trước khi thêm key này
 *   (tránh config chết / đệ quy khi đọc Config sheet từ chính spreadsheet cấu hình).
 */

/** Đọc toàn bộ settings (defaults + override từ Config sheet) — cache 60s.
 * @returns {Object<string, *>} merged settings (mọi key của SETTINGS_DEFAULTS đều có mặt)
 */
function getSettings_() {
  return cachedJson_(CACHE_KEYS.SETTINGS, function () {
    const merged = {};
    Object.keys(SETTINGS_DEFAULTS).forEach(function (k) {
      merged[k] = Array.isArray(SETTINGS_DEFAULTS[k]) ? [] : SETTINGS_DEFAULTS[k];
    });
    const sheet = getSheet_(SHEETS.CONFIG);  // header ['Key','Value','Group','Index'] do ensureSheets_ đặt
    const values = sheet.getDataRange().getValues();
    values.forEach(function (row, i) {
      if (i === 0) return; // bỏ header
      const key = String(row[0] || '').trim();
      if (!key) return;
      const group = String(row[2] || '').trim();
      if (group) {
        // GROUP key: gom vào merged[group] theo Index (1-based). Chỉ group CÓ trong defaults
        // (whitelist) — group lạ trong sheet bị bỏ. Index thiếu/trùng → chèn theo index thật.
        if (!Array.isArray(merged[group])) return;
        const idx = parseInt(row[3], 10);
        if (!idx || idx < 1) return;
        // Group value là chuỗi thường (tên station/team...) — KHÔNG parse JSON
        // (parseSettingValue_ biến '123'→number, 'true'→boolean — sai cho danh sách tên).
        merged[group][idx - 1] = String(row[1] === null || row[1] === undefined ? '' : row[1]);
        return;
      }
      // SINGLE key: chỉ merge key CÓ trong defaults — hàng rác / key lạ bị bỏ qua
      if (!(key in merged) || Array.isArray(merged[key])) return;
      merged[key] = parseSettingValue_(row[1]);
    });
    // Group: loại bỏ lỗ hổng (index thiếu → undefined) — trả list liền mạch
    Object.keys(merged).forEach(function (g) {
      if (Array.isArray(merged[g])) merged[g] = merged[g].filter(function (v) { return v !== undefined && v !== null && v !== ''; });
    });
    return merged;
  }, CACHE_TTL.SETTINGS);
}

/** Đọc 1 setting — thuận tiện cho caller (P1: scan/task đọc defaultStation...). */
function getSetting_(key) {
  const all = getSettings_();
  return (all && key in all) ? all[key] : undefined;
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
    const rowByGroup = {}; // group → danh sách row index (1-based)
    values.forEach(function (row, i) {
      if (i === 0) return;
      const key = String(row[0] || '').trim();
      const group = String(row[2] || '').trim();
      if (key) rowByKey[key] = i + 1;
      if (group) {
        if (!rowByGroup[group]) rowByGroup[group] = [];
        rowByGroup[group].push(i + 1);
      }
    });
    Object.keys(patch || {}).forEach(function (key) {
      if (patch[key] === undefined) { ignored.push(key); return; }  // value thiếu → không ghi
      if (!(key in SETTINGS_DEFAULTS)) { ignored.push(key); return; }  // whitelist — chặn key lạ
      const isGroup = Array.isArray(SETTINGS_DEFAULTS[key]);
      if (isGroup) {
        // GROUP key: xóa toàn bộ row cũ của group (từ CUỐI lên — tránh lệch index khi xóa),
        // rồi ghi lại theo index 1..N. Patch value phải là mảng (client gửi cả list mới).
        const items = Array.isArray(patch[key]) ? patch[key] : [];
        const oldRows = rowByGroup[key] || [];
        oldRows.sort(function (a, b) { return b - a; });  // xóa từ dưới lên
        oldRows.forEach(function (r) { sheet.deleteRow(r); });
        items.forEach(function (v, i) {
          if (v === undefined || v === null || String(v).trim() === '') return; // bỏ item rỗng
          sheet.appendRow([key + (i + 1), String(v).trim(), key, i + 1]);
        });
        saved.push(key);
        return;
      }
      // SINGLE key: update row cũ / append mới
      const serialized = JSON.stringify(patch[key]);
      if (rowByKey[key]) {
        sheet.getRange(rowByKey[key], 1, 1, 2).setValues([[key, serialized]]);
      } else {
        sheet.appendRow([key, serialized, '', '']);
        rowByKey[key] = sheet.getLastRow();
      }
      saved.push(key);
    });
  } finally {
    lock.releaseLock();
  }
  if (saved.length) invalidateSettingsCache_();
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
}

/** Parse giá trị Config sheet → kiểu thật (JSON string). Cell rác / không phải JSON → trả nguyên. */
function parseSettingValue_(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return raw;  // cell number/boolean (GAS đọc kiểu gốc) — giữ nguyên
  if (raw === '') return '';
  try { return JSON.parse(raw); } catch (e) { return raw; }
}
