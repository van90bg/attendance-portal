/**
 * Cache.gs — Cache wrapper + format thời gian (tách từ Database.gs 2026-08-11).
 *
 * - cachedJson_: đọc/ghi JSON cache version-key (CACHE_KEYS.*_vN), miss → load() + put.
 * - getTimeZone_ memo 1 lần — KHÔNG gọi Session.getScriptTimeZone() trong loop.
 * - safeDate_/formatTime_/formatDateTime_: cell thời gian (Date HOẶC string legacy) → text theo TZ.
 */

function cache_() {
  return CacheService.getScriptCache();
}

/**
 * Đọc/ghi JSON cache theo key (version-key).
 * @param {string} key
 * @param {Function} load — trả về value khi cache miss
 * @param {number} ttlSeconds
 */
function cachedJson_(key, load, ttlSeconds) {
  const cached = cache_().get(key);
  if (cached !== null) {
    try { return JSON.parse(cached); }
    catch (e) { console.warn('cache parse fail', key, e.message); }  // F8: cache hỏng → rebuild, log để biết nếu lặp
  }
  const value = load();
  try { cache_().put(key, JSON.stringify(value), ttlSeconds); }
  catch (e) { console.warn('cache put fail', key, e.message); }  // F3: put >100KB/entry throw — log để biết cache đang miss âm thầm
  return value;
}

/** Cache timezone 1 lần (tránh gọi trong loop).
 * P2 (review): memo theo invocation — formatTime_ gọi mọi dòng log (2 lần/dòng × N NV);
 * getTimeZone_() trước đây mỗi lần gọi lại CacheService.get (đã cache 24h nhưng vẫn hit store).
 * Với 500-1000 NV/task = 1000-2000 cache GET mỗi lần load detail — memo module cắt về 1 lần.
 */
var _tzCache_ = null;
function getTimeZone_() {
  if (_tzCache_ !== null) return _tzCache_;
  _tzCache_ = cachedJson_(CACHE_KEYS.TZ, function () {
    return Session.getScriptTimeZone();
  }, CACHE_TTL.TZ);
  return _tzCache_;
}

/** Format Date theo timezone script — dùng cho hiển thị/ghi cột giờ. */
/** Major#1 (audit 2026-08-07): chuyển cell thời gian (Date object HOẶC string legacy,
 * vd "Mon Aug 03 2026 00:00:00 GMT+0700") về Date hợp lệ — KHÔNG throw nếu cell rác.
 * Utilities.formatDate/.getTime() sẽ throw khi nhận string → trước đây 1 cell string
 * trong timeRef/timeScan/createdAt làm toàn bộ getTaskDetail bricked.
 */
function safeDate_(v) {
  if (v === null || v === undefined || v === '') return null;
  try {
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    const t = Date.parse(v); // string "Mon Aug ..." / "8/1/2026" / ISO
    return isNaN(t) ? null : new Date(t);
  } catch (e) {
    return null;
  }
}

function formatTime_(date) {
  const d = safeDate_(date);
  if (!d) return '';
  return Utilities.formatDate(d, getTimeZone_(), 'HH:mm:ss');
}

/** P2: format có ngày (dd/MM HH:mm:ss) — danh sách task nhiều ngày phân biệt được. */
function formatDateTime_(date) {
  const d = safeDate_(date);
  if (!d) return '';
  // yyyy-MM-dd HH:mm:ss (đủ năm — task list Tạo lúc/Kết thúc); trước là dd/MM thiếu
  // năm → "30/12 12:48" gây nhầm (bug 2026-07-29). Giờ quét (formatTime_) vẫn HH:mm:ss.
  // Major#1 (audit re-check): phải format `d` (đã qua safeDate_) — format `date` gốc
  // vẫn throw khi cell là string legacy → taskFromRow_ lại brick đúng lỗi cũ.
  return Utilities.formatDate(d, getTimeZone_(), 'yyyy-MM-dd HH:mm:ss');
}

/** Date = ngày vào làm (StaffData) — format yyyy-MM-dd (ISO — sort string đúng thứ tự). */
function formatDateShort_(date) {
  if (!date) return '';
  // Ủy quyền cho normalizeStaffDate_ (CsvUtil) — xử lý cả Date object thật (dữ liệu
  // cũ trong sheet: "Mon Aug 03 2026 00:00:00 GMT+0700") lẫn string "8/1/2026".
  // 1 nguồn sự thật — tránh 2 bộ regex lệch nhau.
  return normalizeStaffDate_(date);
}
