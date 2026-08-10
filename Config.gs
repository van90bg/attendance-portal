/**
 * Config.gs — Hằng số toàn cục RollCall v2
 * Cột sheet/file: tiếng Anh · Hiển thị web: tiếng Việt (UI_LABELS)
 * KHÔNG hardcode string rải rác — mọi hằng số tập trung tại đây.
 */

// ===== Sheet names =====
const SHEETS = {
  CONFIG: 'Config',
  STAFF_DATA: 'StaffData',
  ATTENDANCE_TASK: 'AttendanceTask',
  ATTENDANCE_LOG: 'AttendanceLog',
};

/**
 * Spreadsheet chứa dữ liệu.
 * ⚠️ BẢO MẬT: KHÔNG hardcode ID production vào repo (dù private, vẫn lộ cho
 * collaborator + lịch sử git). Chuyển ID vào Script Properties 'SPREADSHEET_ID'
 * (File → Project settings → Script Properties). Database.getSpreadsheet_() ưu
 * tiên DEFAULT_SPREADSHEET_ID → Script Properties → spreadsheet bind → tạo mới.
 * Để rỗng ('') để BẮT BUỘC dùng Script Properties (không còn ID production trong code).
 * Giữ giá trị placeholder này chỉ để local mock/test chạy được; production phải rỗng.
 */
const DEFAULT_SPREADSHEET_ID = '';
/**
 * m7 (audit): cấm tự tạo DB mới rỗng khi chưa cấu hình spreadsheet.
 * Mặc định FALSE → getSpreadsheet_ sẽ THROW thay vì SpreadsheetApp.create() —
 * deploy sai cấu hình (quên set SPREADSHEET_ID) phải fail rõ ràng, KHÔNG tạo
 * DB rỗng phân mảnh dữ liệu âm thầm. Chỉ bật true khi cần bootstrap lần đầu.
 */
const ALLOW_DB_AUTO_CREATE = false;

// ===== Header StaffData (giữ đúng header Att.csv — index theo thứ tự cột) =====
// Sheet StaffData lưu nguyên cấu trúc csv hệ thống (1 dòng = 1 NV–1 ca–1 station).
const STAFF_DATA_COLS = {
  NO: 0,
  DATE: 1,
  STAFF_ID: 2,
  STAFF_NAME: 3,
  STAFF_EMAIL: 4,
  AGENCY: 5,
  CONTRACT_TYPE: 6,
  EVENT_ID: 7,
  MATCHING_TYPE: 8,
  GENDER: 9,
  DEPARTMENT: 10,
  CARD_IN: 11,        // Clock In Time (csv) — chỉ hiển thị, không sửa
  CARD_OUT: 12,       // Clock Out Time (csv) — chỉ hiển thị, không sửa
  ACTUAL_HOURS: 13,
  CARD_IN_REMARK: 14,
  CARD_OUT_REMARK: 15,
  SLOT_CODE: 16,      // text "08:00-17:00"
  WORKSTATION: 17,
  TEAM: 18,
  STATION: 19,
};
const STAFF_DATA_COL_COUNT = 20;
// Header sheet StaffData — giữ đúng tên cột Att.csv (map qua CSV_HEADER_FIELD →
// buildStaffIndex/buildStaffListFromValues đọc theo TÊN, không theo index). Đặt header
// này khi setupSheets tạo sheet StaffData mới để syncFromCsv parse được ngay.
const STAFF_DATA_HEADER = [
  'No.', 'Date', 'Staff ID', 'Staff Name', 'Staff Email', 'Agency', 'Contract Type',
  'Event ID', 'Matching Type', 'Gender', 'Department', 'Clock In Time', 'Clock Out Time',
  'Actual Hours', 'Clock In Remark', 'Clock Out Remark', 'Slot Code', 'Workstation',
  'Team', 'Station',
];

// ===== Cột AttendanceTask =====
const TASK_COLS = {
  TASK_ID: 0,
  TASK_TYPE: 1,
  STATION: 2,
  SLOT_CODE: 3,
  TEAM: 4,
  CONTRACT_TYPE: 5,
  STATUS: 6,
  CREATED_AT: 7,
  CREATED_BY: 8,
  COMPLETED_AT: 9,
};
const TASK_COL_COUNT = 10;

// ===== Cột AttendanceLog (1 dòng / NV) =====
// Lưu ý: bỏ cardIn/cardOut (2026-08-03) — StaffData GIỮ NGUYÊN; log không copy 2 cột này nữa.
const LOG_COLS = {
  TASK_ID: 0,
  STAFF_ID: 1,
  STAFF_NAME: 2,
  SLOT_CODE: 3,
  STATION: 4,
  TEAM: 5,
  WORKSTATION: 6,
  TIME_REF: 7,    // GIỜ CÓ MẶT (breaking 2026-08-05): luồng có list = giờ tạo task;
                   // luồng không list = giờ quét lần 1. Tái dùng cột cũ (trước = pre-fill time).
  TIME_SCAN: 8,   // GIỜ QUÉT — điểm danh (quét lần 2, hoặc lần 1 với list có sẵn)
  STATUS: 9,
  DATE: 10,       // ngày vào làm (copy từ StaffData) — hiển thị cột Date, khác TIME_REF (ngày task)
};
const LOG_COL_COUNT = 11;

// ===== Trạng thái đối chiếu (badge — tiếng Việt) =====
const STATUS = {
  PENDING: '-',      // pre-fill khi tạo task — chưa xác định (chưa quét, task đang mở)
  PRESENT: 'Có mặt',
  ABSENT: 'Vắng',    // chỉ gán khi kết thúc task (dòng chưa quét)
  EXTRA: 'Dư',
};

// ===== Trạng thái task (state machine 2-phase attendance) =====
// MỞ (open): phase 1 — quét Giờ có mặt. Có list: roster sẵn, TIME_REF đã ghi giờ tạo.
//                         Không list: quét lần 1 ghi TIME_REF + tạo dòng.
// ĐIỂM DANH (attend): phase 2 — quét Giờ quét (TIME_SCAN). Nút "Kết thúc" chỉ hiện ở đây.
// XONG (done): đã kết thúc — NV chưa quét (TIME_SCAN rỗng) đánh Vắng.
const TASK_STATUS = {
  OPEN: 'open',       // phase 1: chờ điểm danh / ghi Giờ có mặt
  ATTEND: 'attend',   // phase 2: đang điểm danh (quét Giờ quét)
  DONE: 'done',       // đã kết thúc
};

// ===== Loại task =====
const TASK_TYPE = {
  RECONCILE: 'reconcile', // đối chiếu từ csv (CÓ danh sách NV)
  FREE: 'free',           // Quét tự do — KHÔNG danh sách (noList), quét 2 lần
};

// ===== Cache TTL (giây) =====
const CACHE_TTL = {
  STAFF_INDEX: 5 * 60,       // 5m — index StaffData
  FILTER_OPTIONS: 5 * 60,    // 5m — distinct station/slotCode/team
  TASK_LIST: 30,             // 30s — danh sách task
  TASK_DETAIL: 15,           // 15s — chi tiết task + log (invalidate khi ghi log/đổi status)
  TASK: 60,                  // m3: task-by-id cho ĐƯỜNG QUÉT (scanStaff đọc mỗi lượt) —
                             // invalidate mọi write (insertTask_/updateTaskStatus_) → 60s không stale
  LOG_ROWS: 30,              // 30s — log rows theo taskId (đường quét — cập nhật incremental, không invalidate mỗi scan)
  TASK_COUNTS: 30,
  SEARCH_STAFF: 15,          // 15s — kết quả tìm NV xuyên task (on-demand, TTL ngắn — đủ tránh quét sheet lớn lặp lại khi tìm cùng mã)
  STAFF_STATS: 3600,        // 1h — danh sách StaffData full cho view thống kê (chỉ đọc; StaffData đổi theo khung giờ nên cache dài, invalidate khi syncFromCsv)
  TZ: 24 * 60 * 60,          // 24h — timezone (cache 1 lần, KHÔNG gọi trong loop)
};

// ===== Cache keys (version-key để invalidate dễ — v1 lesson) =====
const CACHE_KEYS = {
  STAFF_INDEX: 'rc2_staffIndex_v1',
  FILTER_OPTIONS: 'rc2_filterOptions_v1',
  TASK_LIST: 'rc2_taskList_v1',
  TASK_DETAIL: 'rc2_taskDetail_v1_',  // prefix + taskId
  TASK: 'rc2_task_v1_',                   // prefix + taskId — m3: task cache đường quét (TTL 60s, invalidate mọi write)
  LOG_ROWS: 'rc2_logRows_v1_',          // prefix + taskId — đường quét (incremental update)
  TASK_COUNTS: 'rc2_taskCounts_v1_',      // prefix — counters theo taskId cho list (đếm 1 lần + cache 30s)
  SEARCH_STAFF: 'rc2_search_staff_v1_',   // prefix + staffId — kết quả tìm NV xuyên task (TTL 15s)
  STAFF_STATS: 'rc2_staffStats_v1',     // toàn bộ StaffData (list full) — view thống kê, TTL 30s
  TZ: 'rc2_tz_v2',  // v2: bump sau khi sửa manifest timeZone NY→Asia/Ho_Chi_Minh (invalidate cache 24h)
};

// ===== Label UI (tiếng Việt) — CHỈ các message server trả về =====
// Text giao diện khác đã hardcode trong index.html (client tự quản lý).
const UI_LABELS = {
  APP_TITLE: 'Attendance Portal',
  ALREADY_SCANNED: 'Đã điểm danh',
  ALREADY_PRESENT: 'Đã có mặt',
  TASK_CLOSED: 'Task đã kết thúc',
  STAFF_NOT_FOUND: 'Không tìm thấy nhân viên',
  CREATE_FAILED_EMPTY: 'Không có nhân viên nào trong tổ hợp đã chọn',
  // 2-phase attendance labels (server trả về task.status === TASK_STATUS.*)
  TASK_PHASE_OPEN: 'Mở',          // phase 1: chờ điểm danh / ghi Giờ có mặt
  TASK_PHASE_ATTEND: 'Điểm danh',  // phase 2: đang quét Giờ quét
  TASK_PHASE_DONE: 'Xong',        // đã kết thúc
  TRANSITION_BLOCKED: 'Chỉ chuyển sang điểm danh khi task đang ở trạng thái Mở',
  COMPLETE_BLOCKED: 'Chỉ kết thúc task khi đang ở trạng thái Điểm danh',
  SCAN_OPEN_OWNER_ONLY: 'Chỉ owner mới quét được ở phase Mở (task này)',
};

// ===== Cấu hình WebApp =====
const WEB_APP = {
  PAGE_TITLE: 'RollCall v2 — Điểm danh kho',
};

