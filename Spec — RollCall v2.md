# Spec — RollCall v2: Hệ thống Điểm danh Đối chiếu Nhân viên Kho

> **Version:** 2.3.0 | **Status:** Final | **Cập nhật:** 2026-08-17
>
> **Ghi chú viết lại:** Spec viết lại **hoàn toàn theo codebase thực tế**.
> v2.2 (2026-08-07): task mới luôn **FREE + Open + log rỗng** (A2), **3 trạng thái `open`/`attend`/`done` (2-phase quét)**, **role owner** cho scan phase Mở, **pasteCodesApi (dán danh sách mã)**, **view Giới thiệu (`viewAbout`)**.
> v2.3 (2026-08-17): **shell UI 9 view** (viewHome/Stats/Tasks/Scan/Staff/Config/Reports/Admin/About — tách module `app-*.html`), **role 4 bậc viewer<operator<manager<admin** (roleMap qua Config sheet, gate `requireRole_` ở service layer), **viewReports** (báo cáo chấm công tháng theo email), **viewAdmin** (nhật ký hoạt động AuditLog — chỉ admin; bảng task mọi owner đã bỏ vì trùng viewTasks), **viewStats** (pivot StaffData), **AuditRepo/ReportRepo/ReportService**, **cache chunk StaffAttendance ≤100KB/key**.
> v2.4 (2026-08-19): **owner-gate Kết thúc/Mở lại task** (completeTask/reopenTask — đồng gate transitionToAttend, chống operator đóng/đổi trạng thái task người khác; legacy `createdBy='web'` fail-open), **warmStaffCacheApi gate operator+** (trước mở mọi role → rò index nhân sự), **fix counter partition completeTask** (`scanned+absent = total` — task có NV Dư quét phase 2 giờ đóng được), **bottom nav Điểm danh hiện cho mọi role trên mobile** (trước ẩn theo canManager_ đúng quyền view).
> v2.5 (2026-08-19): **force-close admin** (completeTask counter lệch — admin chốt được, audit `completeTaskForceClose`; non-admin vẫn chặn), **loadRoster cho phép phase Điểm danh** (NV đến trễ vẫn nạp vào danh sách — chỉ chặn DONE), **API `updateLogRowStatusApi`** (sửa trạng thái 1 dòng log — owner/admin, PRESENT tự fill TIME_SCAN, audit `fixLogRowStatus`, cột **Sửa** trong bảng quét), **chống gian lận giờ quét** (epoch client chỉ chấp nhận trong ±3 phút so server + không sớm hơn lúc tạo task), **cờ `staffUnknown`** (mã quét không có trong StaffData → card cảnh báo + toast).
> v2.6 (2026-08-19): **queue quét 2→8** (barcode nhanh hết bị chặn; toast cảnh báo khi queue ≥3), **tab sync** (quay lại tab → silent reload task đang mở — hết data stale khi NV khác quét ở tab khác), **confirm Kết thúc hiện số NV chưa điểm danh sẽ tính Vắng**, **scanner ngoài theo task** (đổi task giữa chừng → đóng scanner cũ + từ chối mã task cũ), **lọc 'Chưa điểm danh' phase Mở theo listedAt** (PENDING → chỉ NV đã đến có LISTED_AT), **non-owner phase Mở ẩn luôn nút camera**, **transitionToAttend re-check queue full**, **waitLock 30s cho pasteCodes/loadRoster** (10s dễ timeout khi lock bận).
> v2.7 (2026-08-19): **fix L1 updateLogRowStatus chiều ngược** — đổi PRESENT→ABSENT/PENDING giờ **clear SCANNED_AT** (trước giữ nguyên → dòng Vắng vẫn tính `scanned` trong computeCounters, counter lệch, phá luôn ý nghĩa partition `scanned+absent=total`); về PENDING clear luôn LISTED_AT (reset 'chưa đến'); **EXTRA giữ SCANNED_AT** (thiết kế partition — EXTRA chưa quét sẽ phá invariant); audit ghi thêm `clearScanTime`/`clearListedAt`; thêm 3 test chiều ngược.
> v2.8 (2026-08-19): **thu cửa sổ epoch client ±3 phút → ±60s** (V1 residual — queue tối đa 8 item × 2.5s ≈ 20s + latency nên 60s vẫn an toàn; ngoài cửa sổ fallback giờ server như cũ), **label filter phase Mở: 'Chưa đến' → 'Đã đến (chưa quét lần 2)'** (khớp thực tế — filter PENDING phase Mở hiện NV đã có LISTED_AT; trước label nghịch lý).
> v2.9 (2026-08-19): **hủy task Mở rỗng** (cancelTaskApi + nút Hủy màn quét — owner/admin, log rỗng mới hủy được; xóa hẳn dòng task + audit cancelTask) · **nạp roster KHÔNG ghi LISTED_AT** (append PENDING, thời điểm đến ghi khi NV quét phase 1 — counter 'Đã đến' không thổi phồng; khớp V2.6 lọc theo listedAt) · label phase 1 'Đã có mặt' → 'Đã đến' (2-phase: đến ≠ điểm danh).
> Bản 2.0.0 (2026-07-31) mô tả nhiều tính năng **không tồn tại trong code** và đã bị loại bỏ khi viết lại (xem [§14](#14-thay-đổi-so-với-spec-200)).

---

## 1. Tổng quan

**Tên dự án:** RollCall v2 — Điểm danh kho (warehouse)
**Repo:** `van90bg/attendance-portal` (private)
**Loại:** WebApp Google Apps Script (standalone) + Google Sheets

| Thuộc tính | Giá trị |
| :--------- | :------ |
| Đối tượng | Nhân viên kho (warehouse staff) |
| Mục đích | **Đối chiếu** danh sách NV làm việc theo tổ hợp Station / Ca (Slot Code) / Team bằng barcode |
| Thiết bị | PC/Laptop đặt tại kho + máy tính bảng + điện thoại; responsive — không cần thiết bị riêng |
| Ngôn ngữ | Code/cột sheet: tiếng Anh · Giao diện web: tiếng Việt |
| Stack | GAS (V8) backend + Vanilla HTML/CSS/JS frontend (**không framework, không Bootstrap**) + Google Sheets + Node `node:test` + clasp |

**Luồng nghiệp vụ cốt lõi (1 vòng khép kín):**

```
[Tạo task (A2): Station + Ngày → task FREE + Mở + log RỖNG (KHÔNG pre-fill khi tạo)
 | Danh sách xây sau ở phase 1: quét / dán / nạp roster theo ca (nút **Nạp danh sách**, loadRosterApi)]
→ Quét barcode NV → phase Mở: ghi LISTED_AT · phase Điểm danh: ghi SCANNED_AT (Có mặt / Dư / reject)
→ Bắt đầu điểm danh (FREE) → Chốt ca → NV chưa quét gán Vắng
→ (tuỳ chọn) Mở lại task (về Điểm danh) → quét tiếp
```

---

## 2. Kiến trúc

```
index.html + styles.html + 9 module app-*.html (GAS template, include tuần tự)
    │  google.script.run (async, callback-based)
    ▼
Code.gs           — doGet (WebApp) + 19 API endpoint *Api + editor tools (syncFromCsv/setupSheets)
Auth.gs           — getActiveEmail_/isEditor_/getRole_ — MỌI email/quyền qua đây
SettingsService.gs— đọc/ghi Config sheet (versioned cache) — nền trang Cấu hình Admin
TaskService.gs    — nghiệp vụ task: createReconcileTask (luôn FREE) / transitionToAttend / completeTask / reopenTask / listTasks / getTaskDetail (+permission)
ScanService.gs    — nghiệp vụ quét: scanStaff (guard Ops + owner gate + LockService + update/append + benchmark) + pasteCodes (dán danh sách mã)
ReportService.gs  — báo cáo chấm công tháng (getReports — StaffAttendance × StaffInfo)
StaffDataRepo.gs  — đọc/ghi StaffData (index/list/overwrite)
TaskRepo.gs       — đọc/ghi AttendanceTask + cache task
LogRepo.gs        — đọc/ghi AttendanceLog + cache log (batch)
AuditRepo.gs      — nhật ký hoạt động (audit_/getAuditLog_) — viewAdmin (admin)
ReportRepo.gs     — đọc StaffAttendance/StaffInfo cho báo cáo
Spreadsheet.gs    — getSheet_/getSpreadsheet_/ensureSheets_ (bootstrap)
Cache.gs          — cache wrapper version-key + format thời gian
Debug.gs          — ?debug=1 (editor-gated)
ScanLogic.gs      — logic THUẦN: classifyScan 2-phase + computeCounters + canScanOpen_ (owner gate) + planBatchScans (paste) — KHÔNG gọi GAS API → test Node được
CsvUtil.gs        — logic THUẦN parse/normalize CSV + lọc/dedupe/distinct + isValidBarcodeId
Config.gs         — mọi hằng số: sheet names, cột, trạng thái, cache keys/TTL, UI labels
```

**Nguyên tắc kiến trúc:**

- **Tách logic thuần khỏi GAS API**: `ScanLogic.gs` + `CsvUtil.gs` không gọi `SpreadsheetApp`/`CacheService`/`Session` — chạy được trên Node (`node --test`). Các wrapper (`*Repo`/`*Service`/`Code`) mỏng, chỉ lo GAS side-effects.
- **Batch read/write**: `getValues()`/`setValues()` theo khối; không `getValue()`/`setValue()`/`appendRow()` trong loop.
- **Hằng số tập trung tại `Config.gs`** — không hardcode rải rác; client mirror `STATUS_C`/`TASK_STATUS_C` trong `app-core.html` (1 nguồn mỗi phía).

---

## 3. Dữ liệu — Google Sheets (7 sheets)

Spreadsheet: Script Property `SPREADSHEET_ID` — không hardcode ID production vào repo (Config `DEFAULT_SPREADSHEET_ID`; nếu rỗng + chưa set Script Property `SPREADSHEET_ID` → `getSpreadsheet_` **THROW** — `ALLOW_DB_AUTO_CREATE=false` (m7): không tự tạo DB rỗng, tránh phân mảnh dữ liệu sang DB mới âm thầm).

### 3.1 Config

Bảng 2 cột `Key` | `Value` — lưu **override** cấu hình; defaults là nguồn sự thật (`SETTINGS_DEFAULTS` trong Config.gs). Đọc/ghi qua **SettingsService** (cache 60s, versioned):

- `defaultStation` / `defaultSlotCode` / `defaultTeam` — pre-select modal tạo task.
- `roleMap` — `{ email: role }` phân quyền (viewer/operator/manager/admin — §5.6).
- `stations` / `teams` / `slotcodes` / `departments` / `agencies` / `contractTypes` — JSON array danh sách lựa chọn Admin khai báo; client **merge** với distinct StaffData (không mất giá trị thực chưa khai).

### 3.2 StaffData — dữ liệu HR (20 cột, đọc-only)

Giữ **nguyên header chuẩn Att.csv** (ánh xạ header → field tại `CSV_HEADER_FIELD` trong CsvUtil.gs):

| # | Header (Att.csv) | Field | Ghi chú |
| :- | :--------------- | :---- | :------ |
| 1 | No. | `no` | |
| 2 | Date | `date` | ngày vào làm — chuẩn hóa `yyyy-MM-dd` |
| 3 | Staff ID | `staffId` | normalize: trim + UPPERCASE |
| 4 | Staff Name | `staffName` | normalize: gộp khoảng trắng |
| 5 | Staff Email | `staffEmail` | |
| 6 | Agency | `agency` | |
| 7 | Contract Type | `contractType` | |
| 8 | Event ID | `eventId` | |
| 9 | Matching Type | `matchingType` | |
| 10 | Gender | `gender` | |
| 11 | Department | `department` | |
| 12 | Clock In Time | `cardIn` | chỉ hiển thị (đã bỏ copy vào log) |
| 13 | Clock Out Time | `cardOut` | chỉ hiển thị |
| 14 | Actual Hours | `actualHours` | |
| 15 | Clock In Remark | `cardInRemark` | |
| 16 | Clock Out Remark | `cardOutRemark` | |
| 17 | Slot Code | `slotCode` | text `"08:00-17:00"` — chính là **Ca** |
| 18 | Workstation | `workstation` | |
| 19 | Team | `team` | |
| 20 | Station | `station` | |

- **Read-only** đối với app; HR tự đồng bộ (dán CSV / chạy `syncFromCsv` từ Script Editor).
- Cache: index 5 phút (`STAFF_INDEX`) + list 5 phút (`STAFF_LIST`) + staff full 1h cho viewStats (`STAFF_STATS`, invalidate khi `syncFromCsv`).
- **1 dòng = 1 NV–1 ca–1 station** (NV có thể nhiều dòng khác ca).

### 3.3 AttendanceTask (9 cột)

| Cột | Field | Ghi chú |
| :-- | :---- | :------ |
| 1 | `taskId` | `RYYYYMMDD-HHMM` (+ `-2`, `-3`… nếu trùng phút) |
| — | ~~`taskType`~~ | *(đã xóa — giữ indices compat)* |
| 3 | `station` | Station đã chọn (1) |
| 4 | `slotCode` | Ca đã chọn — multi-select nối `", "` để hiển thị |
| 5 | `team` | Team đã chọn — multi-select nối `", "` |
| 6 | `contractType` | Hình thức đã chọn (thêm 2026-08-16 — multi-select nối `", "`) |
| 7 | `status` | `open` (Mở) / `attend` (Điểm danh) / `done` (Xong) |
| 8 | `createdAt` | thời điểm tạo |
| 9 | `createdBy` | email người tạo (webapp đăng nhập); task legacy tạo cũ = `'web'` — dùng cho owner gate (§5.5) |
| 10 | `completedAt` | thời điểm kết thúc (rỗng khi open) |

### 3.4 AttendanceLog (11 cột, 1 dòng / NV)

| Cột | Field | Ghi chú |
| :-- | :---- | :------ |
| 1 | `taskId` | |
| 2 | `staffId` | |
| 3 | `staffName` | |
| 4 | `slotCode` | |
| 5 | `station` | |
| 6 | `team` | |
| 7 | `workstation` | |
| 8 | `timeRef` | **LISTED_AT** — ghi khi quét phase 1 / dán (thời điểm ghi dòng); **nạp roster KHÔNG ghi** — thời điểm đến ghi khi NV quét phase 1 |
| 9 | `timeScan` | giờ quét đối chiếu (rỗng = chưa quét) |
| 10 | `status` | `-` (PENDING) / `Có mặt` (PRESENT) / `Vắng` (ABSENT) / `Dư` (EXTRA) |
| 11 | `date` | **ngày vào làm** (copy từ StaffData) — hiển thị cột Date; khác `timeRef` (ngày task) |

> **Đã bỏ cardIn/cardOut (2026-08-03):** log không copy 2 cột Clock In/Out từ StaffData nữa — StaffData giữ nguyên, chỉ hiển thị.

### 3.5 AuditLog (5 cột)

Nhật ký hoạt động quản trị (viewAdmin — chỉ admin): mọi mutation quan trọng ghi 1 dòng (`audit_` trong AuditRepo).

| Cột | Field | Ghi chú |
| :-- | :---- | :------ |
| 1 | `timestamp` | ISO UTC (`new Date().toISOString()`) |
| 2 | `email` | email người thao tác (`getActiveEmail_()`; rỗng → `'web'`) |
| 3 | `action` | `createTask` / `completeTask` / `reopenTask` / `transitionToAttend` / `pasteCodes` / `settings` |
| 4 | `targetId` | taskId / '' (settings) |
| 5 | `detail` | JSON string chi tiết (count, absentCount, resetCount…) |

> Ghi audit **KHÔNG gate** (caller đã gate) và lỗi ghi chỉ `console.error` — audit là phụ, không làm gãy nghiệp vụ chính.

### 3.6 StaffInfo + StaffAttendance (báo cáo — viewReports)

- **StaffInfo** — map `staffEmail → { opsId, name }`: email đăng nhập → mã Ops cho báo cáo (cache 1h `REPORT_INFO`).
- **StaffAttendance** — chấm công tháng theo Ops ID (nguồn NGOÀI — KHÔNG tự tạo; thiếu sheet → viewReports báo rỗng). Cache chunked (`REPORTS` per-user 60s; `all_*` chia chunk ≤100KB/key).

---

## 4. Mô hình Task

### 4.1 Loại task

**A2 (docs/roster-load-design.md, 2026-08-18):** mọi task mới = **Mở** (`open`) + **log RỖNG** — KHÔNG pre-fill roster khi tạo. TaskType đã xóa — không còn phân biệt `reconcile`/`free`.

- `free` — task mới **rỗng** (0 dòng log): danh sách xây sau ở phase 1 qua **quét** / **dán** / **nạp roster theo ca** (`loadRosterApi` — nút **Nạp danh sách**, append PENDING, LISTED_AT rỗng — thời điểm đến ghi khi NV quét phase 1). Bấm **Bắt đầu điểm danh** rồi quét lần 2 (SCANNED_AT); NV lạ phase 2 = Dư.
- **Phase 1 KHÔNG có Dư** — Dư (EXTRA) chỉ khi quét phase 2 mà NV không có dòng PENDING trong log (bất kể nguồn: quét phase 1 · dán · roster).

### 4.2 Task ID

```
R + yyyyMMdd-HHmm   →  R20260802-0730
```
- Đọc được, sắp xếp tự nhiên theo giờ tạo.
- Trùng taskId cùng phút → suffix số tăng dần `-2`, `-3`, … (không phải `-x-x`).

### 4.3 Trạng thái task (3 trạng thái — 2-phase quét)

```
open  →  attend  →  done
         ▲           │
         └───────────┘ (reopen — về Điểm danh, không về Mở)
```
| Status | Phase | Ý nghĩa |
| :----- | :---- | :------ |
| `open` | 1 — Mở | Quét ghi **LISTED_AT** (TIME_REF); **chỉ owner/admin** quét được (§5.5) |
| `attend` | 2 — Điểm danh | Quét ghi **SCANNED_AT** (TIME_SCAN); mọi người quét được |
| `done` | — | Đã kết thúc — quét reject `task-closed` |

Đặc điểm tạo task (A2): **mọi task mới sinh ra ở `open` với log RỖNG** — KHÔNG pre-fill roster khi tạo; danh sách nạp sau qua quét / dán / **Lấy danh sách theo ca** (trong modal **Nạp danh sách**); bấm **Bắt đầu điểm danh** (cảnh báo nếu log rỗng) để sang `attend`.

`transitionToAttend(taskId)` - `open → attend`, guard `status === OPEN`; không sửa log (NV đã có LISTED_AT giữ nguyên), mở nút Kết thúc. Gate `requireRole_('operator')` + **owner-gate `canScanOpen_` (audit 2026-08-19)**: chuyển OPEN→ATTEND mở khoá quét phase 2 cho mọi người nên chỉ owner/admin được phép - chống non-owner gọi thẳng API qua console để vô hiệu owner-gate phase Mở.

### 4.4 Tạo task (`createReconcileTask`)

1. **A2:** server ép `noList = true` cho MỌI task mới — KHÔNG cần station/khác filter, KHÔNG đọc StaffData / KHÔNG pre-fill log (modal Station + Team + Ngày — station bắt buộc; danh sách nạp sau qua loadRosterApi).
2. Task lưu: `status='open'`, `slotCode='Tự do'` (`SLOT_FREE_MAGIC`) + `team`/`contractType` client gửi (metadata hiển thị).
3. `insertTask_` (append 1 dòng) — KHÔNG `batchInsertLogRows_` (log rỗng; roster nạp sau qua `loadRosterApi`).
4. Status khởi tạo: **luôn `OPEN`** (A2 — mọi task qua phase 1).
5. Toàn bộ nằm trong `LockService.waitLock(10000)`.

### 4.5 Kết thúc task (`completeTask`)

- Guard: task phải `attend` (phase 2); còn `open` → `UI_LABELS.COMPLETE_BLOCKED` ('Chỉ kết thúc khi ở Điểm danh'); `done` → 'Task đã kết thúc'.
- **Cảnh báo scanned===0 (audit 2026-08-19)**: client confirm mạnh "Chưa có ai quét lần 2 — tất cả sẽ tính Vắng" trước khi gọi completeTaskApi; server KHÔNG chặn cứng (reopenTask cứu được).
- **Thứ tự fail-safe**: `markUnscannedAbsent_` TRƯỚC → `updateTaskStatus_(DONE, completedAt)` SAU.
  - `markUnscannedAbsent_`: `transformLogStatuses_` — batch ghi 1 lần cả cột status; dòng `timeScan` rỗng + status `-` → `Vắng`; dòng có `timeScan` nhưng status `-` (legacy/sửa tay) → **chuẩn hóa `Có mặt`** (không đánh Vắng).
  - Nếu mark fail (quota/timeout): task vẫn `attend` → retry được. Nếu status-update fail: vẫn `attend`, mark idempotent → retry an toàn.

### 4.6 Mở lại task (`reopenTask`)

- Guard: task phải `done`; `open` → 'Task đang mở — không cần mở lại'.
- `resetAbsentToPending_`: ABSENT → PENDING (NV Có mặt giữ nguyên timeScan/status) — batch 1 lần, rồi `updateTaskStatus_(ATTEND)` — **về Điểm danh** (không về Mở), quét tiếp được ngay. Thứ tự fail-safe giống completeTask.

### 4.7 Đọc dữ liệu

- `listTasks()` → mới nhất lên đầu; merge counters (`total/scanned/extra`) từ AttendanceLog 1 lần + cache (`TASK_COUNTS` 30s) — không N+1.
- `getTaskDetail(taskId)` → `{ok, task, log, counters}` qua cache `TASK_DETAIL` 15s. **`task.permission = {isAdmin, isOwner, canScanOpen}`** tính TƯƠI cho người đọc (sau cache, không lưu chung) — cache detail dùng chung mọi user nên không thể chứa permission theo email.

### 4.8 Hủy task rỗng (`cancelTask`)

- Chỉ hủy được task **`open` + log RỖNG** (tạo nhầm / bỏ dở) — xóa hẳn dòng task khỏi AttendanceTask (`deleteRow`), invalidate cache + audit `cancelTask`.
- Gate: `requireRole_('operator')` + `canScanOpen_` (owner/admin — đồng gate transitionToAttend, §5.5).
- Task đã có dữ liệu quét → **chặn** ('Task đã có dữ liệu quét — không hủy được. Hãy Bắt đầu điểm danh rồi Chốt ca.') — dữ liệu chấm công không bao giờ bị xóa nhầm.
- Client: nút **Hủy** trong màn quét — hiện chỉ khi phase Mở + log rỗng + `permission.canScanOpen`; confirm trước khi gọi `cancelTaskApi`; thành công → `backToList()`.

---

## 5. Mô hình quét (Scan)

### 5.1 Mã barcode

- **Chỉ chấp nhận "Ops" + số** (case-insensitive): `isValidBarcodeId` = `/^ops\d+$/i`.
- Client check `/^ops\d+$/i` chạy **trước queue** (0ms, không gọi server); server có guard lại (chống bypass qua console).

### 5.2 Pipeline `scanStaff` (ScanService)

```
normalizeStaffId (trim + UPPERCASE)
  → requireRole_('operator') (M1 — gate service layer, bypass-proof)
  → isValidBarcodeId?  (sai format → reject 'Mã phải bắt đầu bằng "Ops" và chỉ chứa số')
  → LockService.waitLock(10000)
  → readTaskCached_ (cache 60s — không getDataRange full AttendanceTask mỗi scan; invalidate mọi write)
  → owner gate (T-1): task status === open && !canScanOpen_() → reject UI_LABELS.SCAN_OPEN_OWNER_ONLY
  → readLogRowsCached_ (cache 30s + incremental — không getDataRange full sheet log mỗi scan)
  → classifyScan (ScanLogic — thuần, 2-phase theo task.status)
  → planScanCommits (B 2026-08-12 — seam thuần gom: re-check race + enrich staffIndex + gom batch)
  → ghi: batchUpdateLogRows_ (nếu có updates) + batchAppendLogRows_ (nếu có appends, 1 setValues N dòng)
  → computeCounters → return {ok, message, status, phase, scannedAtText, scannedAtEpoch, listedAtText, listedAtEpoch, staffName, counters}
  → finally: lock.releaseLock()  (DEFENSE: catch mọi lỗi → ok:false)
```

**Paste danh sách mã (`pasteCodes`, T-2)** — cùng gate + lock, khác đường ghi:

```
pasteCodesApi(taskId, lines) → clamp 200 dòng (A4 — ScanService `slice(0, 200)`) → lock 1 lần
  → gate: status === open && canScanOpen_
  → readLogRowsCached_ 1 lần → planBatchScans (pure ScanLogic — dedupe trong batch nhờ simulate log)
  → append: batchAppendLogRows_ — 1 setValues N dòng + update LOG_ROWS cache 1 lần (300 RPC → 1)
  → update dòng đã có: updateLogRowRef_/updateLogRowScan_ từng mã (số ít — giới hạn ghi chú)
  → computeCounters → {ok, total, success, failed, results[], counters}
```

### 5.3 Phân loại quét (`classifyScan` — 2-phase theo `task.status`)

| Phase (status) | Điều kiện | Action | Status | Ghi chú |
| :-------- | :-------- | :----- | :----- | :------ |
| `staffId` rỗng | — (mọi phase) | `reject` | — | `empty-staff-id` |
| task không `open`/`attend` | — | `reject` | — | `task-closed` |
| `open` — Mở | NV trong log + chưa có LISTED_AT | `update` | `-` (PENDING) | ghi TIME_REF (LISTED_AT) |
| | NV trong log + đã có LISTED_AT | `reject` | — | `already-present` |
| | NV không trong log (free) | `append` | `-` (PENDING) | hợp lệ — xây danh sách, KHÔNG Dư |
| `attend` — Điểm danh | NV trong log + chưa quét (PENDING) | `update` | `Có mặt` | ghi TIME_SCAN |
| | NV trong log + status `Dư` (EXTRA) | `update` | `Dư` | ghi TIME_SCAN — **GIỮ Dư**, không đổi Có mặt |
| | NV trong log + đã quét | `reject` | — | `already-scanned` |
| | NV không trong log | `append` | `Dư` | ghi TIME_SCAN |
| `done` / khác | — | `reject` | — | `task-closed` |

- **2 phase quét riêng biệt** — KHÔNG check-in/check-out 2 lần trong cùng phase; mỗi phase NV quét 1 lần.
- **Update-in-place**: NV đã có trong log được cập nhật tại dòng hiện tại (không append dòng mới, không append-only).
- `findLogRow` so khớp case-insensitive theo `staffId` chuẩn hóa.

### 5.4 Counters (`computeCounters`)

| Counter | Công thức |
| :------ | :-------- |
| `scanned` (Đã quét) | số dòng `scannedAtEpoch > 0` (gồm PRESENT + EXTRA) |
| `presentAt` (Đã đến) | số dòng `listedAtEpoch > 0` - LISTED_AT phase1 (thêm 2026-08-17; đổi label "Đã đến" 2026-08-19 để phân biệt với Có mặt phase 2) |
| `absent` (Chưa điểm danh / Vắng) | số dòng `scannedAtEpoch == 0` và status ≠ EXTRA |
| `extra` (Dư) | số dòng status = EXTRA |
| `total` | tổng số dòng log |

> **`scannedAtEpoch` là nguồn sự thật** cho `scanned`/`absent` + sort (text `HH:mm:ss` mất ngày — sort sai khi task xuyên nửa đêm). Client mirror đúng quy ước này (optimistic bump / rollback / sync đều recount theo epoch).
> 2-phase: `listedAtEpoch` = LISTED_AT (phase Mở) — dùng ghi/nhận diện `already-present` + counter `presentAt`; `scanned`/`absent` đếm theo `scannedAtEpoch` (SCANNED_AT).

### 5.5 Role — quyền quét phase Mở & paste (T-1, T-2)

Pure helper `canScanOpen_(cfg, createdBy, activeEmail, isAdmin)` (ScanLogic — Node-test được):

- Task KHÔNG ở `open` → cho phép (gate chỉ áp dụng phase Mở).
- `isAdmin` (= `isEditor_()`, deployer) → bypass.
- `createdBy` là **email hợp lệ** (không rỗng, ≠ `'web'`, chứa `@`) → chỉ chủ sở hữu (`activeEmail === createdBy`, case-insensitive) được quét.
- `createdBy` **không xác định** (`'web'`/rỗng — task legacy) → ai cũng quét được (**A1 fail-open** — tương thích task cũ, đổi 1 dòng nếu muốn chặt).

Server tính `permission = {isAdmin, isOwner, canScanOpen}` **tươi (mới)** trong `getTaskDetail` (sau cache — không lưu vào cache 15s vì cache dùng chung mọi user). Client `applyScanPermission()` (gọi CUỐI `renderScanView` — nguồn quyết định cuối, cờ `scanOwnerLocked`):
- `!canScanOpen` + phase Mở → `scanInput.disabled = true` + banner "Chỉ owner mới quét được ở phase Mở" + ẩn nút **Chuyển điểm danh** + ẩn nút **Dán danh sách mã**; `submitScan` guard lại (defense barcode vật lý).
- `updateFinishBtnState` / `updateQueueFullState` tôn trọng `scanOwnerLocked` (không vô tình bật lại).
- **Bắt đầu điểm danh (`transitionToAttend`) cũng owner-gate `canScanOpen_` (audit 2026-08-19)** — OPEN→ATTEND mở khoá phase 2 cho mọi người; non-owner gọi thẳng API bị reject, chống bypass owner-gate phase Mở qua console.
- **Kết thúc (`completeTask`) / Mở lại (`reopenTask`) cũng owner-gate `canScanOpen_` (audit 2026-08-19)** — đóng task stamp Vắng cho toàn bộ NV chưa quét, mở lại reset Vắng → thay đổi trạng thái chấm công của task người khác nên chỉ owner/admin; non-owner gọi thẳng API bị reject `UI_LABELS.SCAN_OPEN_OWNER_ONLY`, legacy `createdBy='web'` fail-open.

**Paste (T-2)** gate cùng rule (A5): `status === open` + `canScanOpen` — `pasteCodes` server reject nếu không thoả.

### 5.6 Role hệ thống (viewer < operator < manager < admin — 2026-08-11)

Bậc quyền `ROLES` (Config.gs), role thật lưu Config sheet key `roleMap` (`{ email: role }`) qua SettingsService; đọc qua `getRole_` (Auth.gs), gate chuẩn `requireRole_(min)`:

- `admin` — `isEditor_` (email trùng `DEPLOYER_EMAIL` Script Properties): mọi thứ (settings/sync/debug).
- `manager` — xem StaffData/Thống kê (`getStaffStatsApi` viewStats/viewStaff) + Báo cáo (`getReportsApi` viewReports) + tìm lịch sử chấm công NV (`searchLogsByStaffApi`).
- `admin` — mọi view: thêm viewAdmin (nhật ký hoạt động `getAuditLogApi`) + viewConfig (editor).

**Phân quyền theo view (2026-08-17):** viewer+ = viewTasks/viewScan/viewHome/viewAbout; manager+ = viewStats/viewStaff/viewReports; admin = viewAdmin; editor = viewConfig. Client ẩn mục nav theo `meta.role` (canManager_/canAdmin_), server gate `requireRole_` là nguồn quyết định cuối.
- `operator` — vận hành điểm danh (quét/tạo task) — **MẶC ĐỊNH**: anonymous/logged-in chưa cấu hình đều operator → không phá luồng quét.
- `viewer` — chỉ xem (gate `requireRole_('operator')` cắn role này).

Gate đặt **TRONG service layer** (`requireRole_` ở đầu mỗi hàm nhận input client — M1): google.script.run gọi được hàm global trực tiếp nên gate chỉ ở `*Api` wrapper bị bypass. Pattern DEFENSE: gate + logic bọc trong try → lỗi sheet chưa cấu hình trả `{ok:false}` thay vì ném.

---

## 6. Trạng thái đối chiếu (badge)

| Hằng số | Giá trị (UI) | Khi nào gán |
| :------ | :----------- | :---------- |
| `PENDING` | `-` (badge "Chưa điểm danh") | append khi quét phase 1 / dán / nạp roster theo ca; reset lại khi reopen |
| `PRESENT` | `Có mặt` | quét NV trong log + chưa quét |
| `ABSENT` | `Vắng` | **chỉ khi kết thúc task** (dòng chưa quét) |
| `EXTRA` | `Dư` | quét NV không có trong log |

- Label **phase-aware** (đồng bộ counter/badge/filter — 2026-08-17; đổi label 2026-08-19): task `open` (FREE phase1) → `-` hiển thị "Đã đến" (đã ghi LISTED_AT — KHÔNG dùng "Có mặt" để tránh nhầm với điểm danh thật); task `attend` → `-` hiển thị "Chưa điểm danh" (chưa quét lần 2 **≠** vắng); task kết thúc → label counter đổi thành "Vắng".
- UI chỉ đổi label, không đổi logic (dùng `STATUS_C` mirror — đổi chuỗi hiển thị không vỡ logic).
- **Banner phase viewScan (audit 2026-08-19)**: hướng dẫn 2 bước nổi bật dưới topbar — OPEN → "Bấm Bắt đầu điểm danh khi xong", ATTEND → "đã quét X/N, người chưa quét sẽ Vắng khi Chốt ca — muốn điểm danh lại thì Chốt ca rồi Mở lại", DONE → kết quả. Render từ `renderPhaseBanner` trong mỗi `renderCounters`.

---

## 7. Cache & Lock

### 7.1 Cache keys (versioned `rc2_*_vN` — bump version để invalidate toàn bộ)

| Key | TTL | Mục đích | Invalidate |
| :-- | :-: | :------- | :--------- |
| `rc2_staffIndex_v1` | 5m | index StaffData `{staffId → staff}` | `syncFromCsv` |
| `rc2_staffList_v1` | 5m | toàn bộ staff list (dropdown/filter) | `syncFromCsv` |
| `rc2_staffStats_v1` | 1h | StaffData full cho viewStats | `syncFromCsv` |
| `rc2_taskList_v1` | 30s | danh sách task | mọi ghi task |
| `rc2_taskCounts_v1_all` | 30s | counters cho list (đọc log 1 lần) | mọi ghi task |
| `rc2_taskDetail_v1_{taskId}` | 15s | chi tiết task + log + counters | **mọi đường ghi log/đổi status** |
| `rc2_task_v1_{taskId}` | 60s | task-by-id đường QUÉT (m3 — không getDataRange mỗi scan) | mọi write (insertTask_/updateTaskStatus_) |
| `rc2_logRows_v1_{taskId}` | 30s | log rows đường quét — **cache SLIM** (chỉ field scan cần, ~32KB) + **incremental update** (scan kế không chạm sheet) | ghi batch/append |
| `rc2_search_staff_v1_{staffId}` | 5s | kết quả tìm NV xuyên task (manager+) | TTL ngắn (không track per-write) |
| `rc2_settings_v3` | 60s | cấu hình Config sheet (SettingsService) | `saveSettings_` |
| `rc2_reportInfo_v1` | 1h | StaffInfo map email→Ops (báo cáo) | — |
| `rc2_reports_v2_{email}` | 60s | báo cáo chấm công theo user — `all_*` chunked StaffAttendance ≤100KB/key | — |
| `rc2_tz_v2` | 24h | timezone script (1 lần — không gọi `Session.getScriptTimeZone()` trong loop) | — |

- `CacheService` giới hạn **100KB/key** → log rows dùng cache slim; `put` fail/`parse` fail đều `console.warn` (không giấu lỗi — cache miss âm thầm).
- Negative-cache: `readTaskDetailCached_` cache `null` 15s → `insertTask_` phải invalidate detail của taskId để phá.

### 7.2 LockService

- Script-level lock, `waitLock(10000)` (riêng `pasteCodes`/`loadRoster` dùng `waitLock(30000)` — xử lý khối lớn, 10s dễ timeout khi lock bận), **release trong `finally`** — mọi luồng ghi: `createReconcileTask`, `transitionToAttend`, `completeTask`, `reopenTask`, `scanStaff`, `pasteCodes`.
- `transformLogStatuses_` (kết thúc / mở lại): batch `setValues` 1 lần cả cột status — không `setValue` trong loop (241 NV = 1 RPC thay vì ~240).

---

## 8. API (google.script.run + debug URL)

### 8.1 Endpoints client

| API | Trả về | Gate |
| :-- | :----- | :--- |
| `getMetaApi()` | `{ ok, appTitle, userEmail, role, isEditor }` | — |
| `getFilterOptionsApi()` | `{ ok, stationGroups, defaults, lists }` — cây Station→Ca→Team + defaults/lists Config; **cache 60s** (FILTER_OPTIONS, invalidate khi saveSettings/overwriteStaffData) | — |
| `previewStaffApi(input)` | `{ ok, count }` — số NV khớp tổ hợp (đã dedupe, khớp count tạo task thật) — không tạo gì | operator (service) |
| `getStaffStatsApi()` | `{ ok, staff[] }` — StaffData full (viewStaff/viewStats) | **manager+** (TRONG try) |
| `getSettingsApi()` | `{ ok, settings }` — toàn bộ cấu hình (viewConfig) | editor |
| `saveSettingsApi(patch)` | `{ ok, saved, ignored, message }` — whitelist key | editor (saveSettings_) |
| `getAuditLogApi(limit)` | `{ ok, rows[{timestamp, email, action, targetId, detail}] }` — nhật ký hoạt động viewAdmin | **admin** (TRONG try) |
| `createReconcileTaskApi(input)` | `{ ok, taskId, count, message }` | operator (service) |
| `getTaskListApi()` | `[{ taskId, station, slotCode, team, status, total, scanned, extra, createdAtText, createdBy }]` | — |
| `getTaskDetailApi(taskId)` | `{ ok, task, log[], counters }` — `task.permission = {isAdmin, isOwner, canScanOpen}` (§5.5) | — |
| `scanStaffApi(taskId, staffId, clientEpoch?)` | `{ ok, message, status, phase, scannedAtText, scannedAtEpoch, listedAtText, listedAtEpoch, staffName, staffUnknown, dateText, counters }` — **clientEpoch**: thời gian quét = giờ client chụp lúc quét (WYSIWYG — sheet ghi đúng giờ app hiển thị; **chỉ chấp nhận ±60s so giờ server + không sớm hơn lúc tạo task** — fallback giờ server ngoài cửa sổ); **staffUnknown**: mã không có trong StaffData → client cảnh báo | operator (service) |
| `transitionToAttendApi(taskId)` | `{ ok, message }` — `open → attend` | operator + owner (service) |
| `completeTaskApi(taskId)` | `{ ok, message }` | operator + owner (service) |
| `cancelTaskApi(taskId)` | `{ ok, message }` — hủy task **phase Mở + log rỗng** (xóa hẳn dòng task khỏi AttendanceTask; task có dữ liệu quét bị chặn) | operator (cancelTask — OPEN + owner) |
| `reopenTaskApi(taskId)` | `{ ok, message }` — `done → attend` | operator + owner (service) |
| `pasteCodesApi(taskId, lines)` | `{ ok, total, success, failed, results[{code, ok, status, message}], counters }` — FREE + open + owner; clamp 200 | operator (service) |
| `loadRosterApi(taskId, filters)` | `{ ok, total, added, skipped, message, counters }` — nạp roster theo ca (Station/Ca/Team/Ngày) ở **phase Mở + Điểm danh** (NV đến trễ vẫn vào được danh sách — chỉ chặn DONE); append PENDING — LISTED_AT rỗng (thời điểm đến ghi khi NV quét phase 1), **bỏ qua NV đã có** (idempotent, không clamp) | operator (loadRoster — OPEN/ATTEND + owner) |
| `updateLogRowStatusApi(taskId, staffId, newStatus)` | `{ ok, message, counters }` — sửa trạng thái 1 dòng log theo mã NV (sửa Dư/Vắng nhầm, bổ sung người); **PRESENT trên dòng chưa quét tự fill TIME_SCAN = now**; **đổi ngược PRESENT→ABSENT/PENDING clear SCANNED_AT** (counter đúng — partition `scanned+absent=total`), về PENDING clear luôn LISTED_AT, **EXTRA giữ SCANNED_AT** (thiết kế partition); cùng status / NV không có / status không hợp lệ → ok:false; audit `fixLogRowStatus` (kèm fillScanTime/clearScanTime/clearListedAt) | operator + **owner/admin** (service — hoạt động cả task DONE) |
| `searchLogsByStaffApi(staffId)` | `{ ok, rows }` — lịch sử chấm công 1 NV xuyên task (F-search) | **manager+** (TRONG try) |
| `searchTasksByQueryApi(q)` | `{ ok, rows }` — tìm task theo mã NV / mã task | — |
| `getReportsApi()` | `{ ok, rows, email, opsId, staffName }` — báo cáo chấm công tháng theo email đăng nhập (viewReports) | **manager+** (service) |
| `warmStaffCacheApi()` | `{ ok, index }` — preload staffIndex cache + trả index slim (kèm `date` — cột Ngày bảng quét) cho client | **operator+** (service) |

> `google.script.run` **không trả `Date`** (serialize → null) → server trả text đã format; client check cả `xxx` + `xxxText`.
> **`getAllTasksApi` đã bỏ (2026-08-17)** — bảng task mọi owner trong viewAdmin trùng với viewTasks (cùng `listTasks()`, nút Kết thúc/Mở lại gate operator) → viewAdmin chỉ còn AuditLog; xem task qua `getTaskListApi()`/`searchTasksByQueryApi()`.

### 8.2 Debug URL (QA/verify — KHÔNG dùng production)

- `?debug=1` → JSON cấu trúc sheet + taskId + probe detail.
- `?debug=createTask&station=..&slotCode=..&team=..` → tạo task thật + trả detail (end-to-end không qua UI).

**Cả 2 đều gate editor-only** qua `isEditor_()` (fail-closed):
- `isEditor_` = user truy cập đã đăng nhập **VÀ** email trùng `DEPLOYER_EMAIL` (Script Properties) — KHÔNG so sánh active===effective (manifest `executeAs: USER_DEPLOYING` làm effective luôn = deployer).
- Chỉ deployer được chạy; exception → `false` (không fail-open). Dùng chung cho `debugState()`, `syncFromCsv()`, `setupSheets()` (anonymous gọi được qua console nếu không gate).

### 8.3 WebApp manifest

- `executeAs: USER_DEPLOYING`, `access: DOMAIN` — chỉ user @spxexpress.com (môi trường máy tính đăng nhập).
- `doGet` tự `ensureSheets_()` mỗi lần load (chỉ set header khi sheet trống — rẻ).

---

## 9. Giao diện & UX (shell UI — index.html + styles.html + 9 module app-*.html)

### 9.1 Shell UI — 9 view (sidebar 8 mục)

Layout chung: header (logo + userEmail + net-dot + âm thanh + ⟳ Làm mới) · sidebar trái collapsible `240px ↔ 48px` (icon SVG đơn sắc `currentColor`) · `<main>` chứa 9 section. Mỗi view có `.view-topbar` chung (sticky, đổ bóng khi `.stuck`).

Sidebar (8 mục, mục Quản trị ẩn non-manager, Cấu hình ẩn non-editor): Trang chủ · Thống kê · Điểm danh · Báo cáo · Quản trị · Dữ liệu chấm công · Cấu hình · Giới thiệu.

**viewTasks — Điểm danh (danh sách task):**
- Topbar: nút **+ Task mới** (modal tạo task §9.2) · ô tìm `.list-search` (`#listSearch`): mã Ops → tìm NV xuyên task (manager+), mã R2026 → tìm task (`runListSearch`).
- Bảng 13 cột: STT / Mã task / Loại / Station / Team / Ca / Tổng NV / Đã quét lần 2 / Dư / Trạng thái / Tạo lúc / Người tạo / Thao tác (nút **Quét** hoặc **Xem**).
- Funnel lọc 4 cột (Loại/Station/Team/Trạng thái) + phân trang 100 task/trang; skeleton + empty state; search NV đổi thead sang SEARCH_HEAD (thêm Mã NV/Tên NV/Điểm danh).

**viewScan — Màn quét:**
- Topbar: `← Danh sách task` · tiêu đề taskId + meta · nút **Nạp danh sách** (phase Mở + Điểm danh, owner — modal 2 tab Theo ca/Dán mã) + **Bắt đầu điểm danh** (chỉ phase open) + **Chốt ca** (chỉ phase attend) + **Mở lại** (chỉ done) + **Hủy** (phase Mở + log rỗng + owner).
- Cột trái (480px): 4 counter (Có mặt / Đã quét / Chưa điểm danh / Dư — phase-aware) · ô quét to (laser-line khi focus) · scan card projector · nút Quét (mobile).
- Cột phải: bảng NV — tìm kiếm + lọc trạng thái + sort theo epoch; cột LISTED_AT / SCANNED_AT theo phase; dòng Dư nền cam; row-diff chống flicker.
- Khoá theo role (T-1): `!canScanOpen` + phase Mở → input disabled + banner cam + ẩn nút Bắt đầu điểm danh / Nạp danh sách.

**viewHome — Trang chủ:** logo + đồng hồ thời gian thực (Asia/Ho_Chi_Minh) — màn hình chiếu/điểm danh.

**viewStats — Thống kê (manager+):** pivot StaffData theo Team × Contract × Ca; tab lọc BPO/OS; `ensureStaffData` nền (cache 1h) — fullscreen.

**viewStaff — Dữ liệu chấm công (manager+):** bảng StaffData 20 cột khớp `STAFF_TABLE_HEAD` (tiếng Anh), Clock In/Out `H:mm:ss`, tìm mã/tên/agency, funnel + phân trang 100 NV.

**viewReports — Báo cáo (manager+):** chấm công tháng theo email đăng nhập (StaffInfo → StaffAttendance, §3.6) — bảng 10 cột desktop/tablet, thẻ card mobile; gate manager (service).

**viewAdmin — Quản trị (chỉ admin):** nhật ký hoạt động AuditLog — bảng Thời gian / Email / Thao tác / Đối tượng + lọc theo ngày (`#auditFilters`). Lazy-load qua `selectPage('admin')`; nút ⟳ Cập nhật gọi lại `loadAdminView`. (Bảng task mọi owner đã bỏ 2026-08-17 — trùng viewTasks, cùng `listTasks()`.)

**viewConfig — Cấu hình (chỉ editor):** SettingsService đọc/ghi — defaults (Station/Ca/Team), roleMap phân quyền, danh sách lựa chọn (stations/teams/slotcodes/departments/agencies/contractTypes); nhóm card kéo thả + nút Lưu (dirty badge).

**viewAbout — Giới thiệu:** 3 mục — Giới thiệu · Hướng dẫn từng bước · Quy tắc phân quyền (Role).

**Chuyển view:** `selectPage(page)` → `showSection(name)` — ẩn CẢ 9 section, set active nav, lazy-load theo page; `showSection` list đủ mọi id (`['viewHome','viewStats','viewStaff','viewAbout','viewScan','viewTasks','viewConfig','viewReports','viewAdmin']`); `repairViewParents()` kéo section bị parser eject về `<main>`. Dừng/kích auto-focus theo view (`viewScan` → `startAutoFocusLoop()`).

Modal: tạo task · confirm dùng chung · **Nạp danh sách** (loadListModal — 2 tab Theo ca/Dán mã) · vềAbout không phải modal — dùng lớp `.about-overlay` + `anyModalOpen()` (Escape/focus trap/autofocus loop).

### 9.2 Modal tạo task (A2 — chỉ nút Tạo)

- **Modal tạo task (A2):** chỉ còn nút **Tạo** (Station / Ca / Team / Hình thức / Ngày ẩn, không cần chọn ở bước này). Task mới luôn FREE + rỗng; Station/Date nạp sau qua **Nạp danh sách** (tab Theo ca). `SEL.slots` giữ `SLOT_FREE_MAGIC`.
- **Ca 'Tự do'** (`SLOT_FREE_MAGIC`): server ép `noList = true` cho mọi task mới — KHÔNG pre-fill khi tạo; roster nạp sau qua **Lấy danh sách theo ca** (`loadRosterApi`).
- KHÔNG preview số NV khi tạo (log rỗng) — footer ghi "Tạo task rỗng — nạp danh sách theo ca sau trong màn quét (nút **Nạp danh sách**)".
- Pre-select defaults từ Config (`CFG_DEFAULTS`) khi mở lần đầu / modal mở trước khi options về; MERGE `CFG_LISTS` (Config) + distinct StaffData (`mergeOpts_`).
- 'Tất cả' chip = chọn hết / bỏ hết; rỗng = không lọc (server bỏ lọc mảng rỗng).
- Reset select mỗi lần mở (tránh tạo nhầm task). Modal confirm dùng chung thay `confirm()`/`alert()` trình duyệt.

### 9.3 Scan queue nền (client)

- Capture **0ms**: clear + focus + toast optimistic + scan card + counters recount NGAY; server xử lý nền tuần tự.
- Chặn sớm: mã không phải `Ops` → toast lỗi; đã quét (Có mặt/Dư) → "Đã điểm danh" (không gọi server); queue đầy (max 8 — SCAN_QUEUE_MAX) → chặn + viền đỏ pulse + disable input.
- **Rollback** an toàn: fail → trả status/timeScan cũ; dòng lạ → `splice` theo index (không `pop()` — pop xóa nhầm row khi queue có 2+ NV lạ).
- **Guards**: `SCAN_CARD_SEQ` (response cũ không đè scan card mới), capture `taskId` lúc enqueue (response task cũ không đụng UI), chặn **Kết thúc** và **backToList** khi còn scan đang xử lý.
- Counter đồng bộ cuối queue từ server (chuẩn nhất); exception → recount từ log.

### 9.4 Trạng thái mạng

- `navigator.onLine` **VÀ** `SERVER_OK` (bất kỳ RPC fail = server unreachable thật — business lỗi đã trả `{ok:false}` qua success handler).
- Hiển thị: Online / Offline / **Server lỗi** (deploy fail/timeout/quota không đổi `navigator.onLine`).

### 9.5 Âm thanh & phản hồi

- Web Audio API (không file): beep 880Hz (thành công) / buzz 200Hz (lỗi); toggle 🔊/🔇, lưu `localStorage.rc2_sound`.
- Toast bottom-center: ok 2.6s auto dismiss; error có nút ✕ đóng; `role=alert/status` + `aria-live`.
- Scan card `role=status aria-live=polite`; khôi phục từ log khi mở lại task (lượt quét mới nhất theo epoch).

### 9.6 A11y & responsive

- Skip-link, focus trap modal + Escape, `focus-visible` ring, focus restore khi đóng modal.
- `prefers-reduced-motion` (tắt animation), `prefers-contrast: more` (badge nền đặc, border đậm).
- Autofocus loop 3s giữ focus ô quét (dừng khi về danh sách / modal mở).
- Responsive: ≤991px layout 2 cột về 1 cột; ≤600px header wrap + topbar hết sticky; ≥1280px phóng to cho màn hình touch.
- SWR client: task vừa xem <15s → render NGAY từ bộ nhớ + RPC nền silent (TTL khớp server TASK_DETAIL).

### 9.7 Mock local

- Mở `file://` trực tiếp (không có `google.script`) → tự nạp `mock/mock-google.js` (mock tự nạp khi không có `google.script.run`); verify UI bằng `scripts/cdp-helper.js`.

### 9.8 Paste danh sách mã (T-2)

- Nút **Dán danh sách mã** cạnh ô quét — chỉ hiện khi `FREE + open + permission.canScanOpen`; bấm → `#pasteModal` (lớp `.about-overlay` — nằm trong `anyModalOpen()` nên autofocus loop không cướp textarea).

### 9.9 Nạp danh sách theo ca (roster — A2)

- Tab **Theo ca** trong modal **Nạp danh sách** (`#loadListModal`, lớp `.about-overlay`) — hiện khi `phase Mở/Điểm danh + permission.canScanOpen`; bấm → Station (bắt buộc) / Ca (chips đa chọn) / Team (chips đa chọn) / **Hình thức** (chips đa chọn — Contract Type) / Ngày — options từ `getFilterOptionsApi` (cache 1 lần/tab).
- Preview số NV khớp qua `previewStaffApi` khi đổi select → nút **Nạp danh sách** bật khi count > 0.
- Gọi `loadRosterApi(taskId, filters)` → append PENDING + `timeRef = now` cho NV CHƯA có trong log (**bỏ qua im lặng** — idempotent, khác paste báo "đã có mặt"); toast `added / skipped`; refresh counters + `loadTaskDetail` nền. Gate server: operator + (OPEN|ATTEND — chặn DONE) + `canScanOpen_`; KHÔNG reclassify dòng cũ.
- Textarea 1 dòng = 1 mã; bỏ dòng rỗng; giới hạn **200 dòng** (client + server clamp — A4).
- Gọi `pasteCodesApi` → hiện **summary** (xanh/đỏ: `success/total` thành công, `failed` thất bại) + liệt kê mã hỏng (sai format / đã có mặt / đã điểm danh / chặn) dạng danh sách; refresh `CURRENT_LOG`/`CURRENT_COUNTERS` từ response + `loadTaskDetail` nền.

---

## 10. Testing

| Hạng mục | Giá trị |
| :------- | :------ |
| Runner | Node `node:test` (`npm test`) |
| Files | **18 files** trong `tests/` (admin-audit · all-gs-load · create-free · csv-normalize · eol-bom · gate-bypass · index-html-parse · mock-contract · paste-batch · report-repo · role-service · roster-load · scan-classify · scan-commit · scanservice · search · settings-service · two-phase) |
| **Kết quả** | **186/186 pass** |
| Mock | `mock/mock-google.js` (contract test đối chiếu mock ↔ server: không orphan handler, không thiếu handler) |
| Fixture | `test-fixtures/Att.sample.csv` |
| Verify UI | `scripts/cdp-helper.js` (open/eval/shot) + `audit-ui.js` (7 view × 4 viewport) + `audit-style.js` |

Nhóm test: `distinctValues` · `isValidBarcodeId` · `dedupeStaffByGroup` · `filterStaffByGroup` (multi-select) · `normalizeStaffDate_` · `buildStaffIndex/buildStaffListFromValues` · `classifyScan` (2-phase) · `findLogRow` · `computeCounters` · `buildExtraRow` · `canScanOpen_` · `planBatchScans` · `planScanCommits` (scan-commit) · `scanStaff`/`pasteCodes` wrapper · **gate-bypass** (requireRole_ service layer chống bypass) · **role-service** (roleMap/getRole_/requireRole_) · **report-repo** (StaffInfo/StaffAttendance chunk ≤100KB) · **search** (matchTasksByQuery/searchLogsByStaff) · **settings-service** (defaults + lists) · **create-free** (FREE task) · **eol-bom** (CRLF + no BOM) · **index-html-parse** (template parse).

> Chỉ test **logic thuần** (CsvUtil/ScanLogic — không gọi GAS) + smoke-load toàn bộ .gs với mock GAS; GAS API thật không test được trong Node. Không Jest/Playwright.

---

## 11. Deploy (clasp)

```bash
clasp login
clasp push -f            # -f khi "Skipping push." do hash trùng
clasp deploy             # tạo version + deployment webapp MỚI — CÁCH DUY NHẤT ĐÚNG
curl -s https://script.google.com/macros/s/<deploymentId>/exec | head   # verify HTTP 200 + marker
```

> **⚠️ Bài học deploy:** `PUT /deployments/{id}` (đổi version) **luôn làm mất `entryPoints`** → URL `/exec` trả 404. API POST cũng không tạo entryPoint. **Chỉ `clasp deploy`** (đọc `webapp` block trong appsscript.json) tạo deployment hoạt động. Sau mọi thao tác: **curl verify** URL `/exec`.

---

## 12. Quy ước

- Cột sheet / file: tiếng Anh · Hiển thị web: tiếng Việt.
- Mọi hằng số tập trung tại `Config.gs` — không hardcode; client mirror `STATUS_C`/`TASK_STATUS_C` trong `app-core.html`.
- Cache key có version (`rc2_*_vN`) — bump để invalidate.
- `google.script.run` không trả `Date` → trả text, check cả `xxx` + `xxxText`.
- Client check mã Ops `/^ops\d+$/i` trước queue (0ms); server guard `isValidBarcodeId()` chống bypass.
- Modal pattern `.about-overlay` + dialog; `anyModalOpen()` cho Escape + focus trap + autofocus loop.
- **Role gate**: gate THẬT đặt TRONG service layer (`requireRole_` — M1, bypass-proof); `*Api` wrapper chỉ giữ DEFENSE (try/catch → `{ok:false}`). `permission` (owner) tính TƯƠI trong `getTaskDetail` (không nhét cache chung); client `applyScanPermission()` chạy cuối `renderScanView` → nguồn quyết định cuối (`scanOwnerLocked`).
- Mọi ghi log/đổi status phải gọi `invalidateTaskDetailCache_(taskId)` + `invalidateTaskCaches_` (list/detail/task).
- Thứ tự ghi fail-safe: dữ liệu phụ TRƯỚC, trạng thái chính SAU (completeTask: mark ABSENT → DONE; reopenTask: reset → ATTEND) — fail nửa chừng retry idempotent.
- Không `console.log` production (chỉ `console.error`/`console.warn` + benchmark `scanStaff` ngưỡng >400ms).
- Git: branch `main` là nguồn duy nhất; 1 issue / 1 commit / 1 push; không commit `.clasprc.json`, `codegraph.json`, file tạm verify.

---

## 13. Edge cases (đã xử lý trong code)

| Tình huống | Xử lý |
| :--------- | :---- |
| Quét NV không có trong log (khác tổ hợp / không có trong StaffData) | **Append dòng mới, status Dư** (lazy đọc staffIndex lấy tên nếu có) |
| Quét NV đã điểm danh | Reject `already-scanned` → "Đã điểm danh" (client chặn trước, server guard sau) |
| Task đã kết thúc, quét tiếp | Reject `task-closed` → "Task đã kết thúc" |
| Task tạo cùng phút | taskId suffix `-2`, `-3`, … |
| Att.csv NV 2 dòng cùng tổ hợp | `dedupeStaffByGroup` giữ dòng đầu (tránh phantom absent) |
| Dòng có timeScan nhưng status `-` (legacy/sửa tay) | `markUnscannedAbsent_` chuẩn hóa **Có mặt** — không đánh Vắng |
| Kết thúc fail giữa chừng (quota/timeout) | Thứ tự mark-trước/status-sau → task vẫn `open`, retry được, idempotent |
| Cache >100KB/key | Log rows cache **slim** (~32KB); put/parse fail → `console.warn` |
| `updateTaskStatus_` ghi nhầm cột (P0 cũ) | `writeTaskRow_` ghi CẢ dòng 9 cột từ memory (đọc dòng → sửa trong memory → setValues 1 lần) — idempotent cột không đụng |
| Response scan của task cũ về muộn | Guard `item.taskId === CURRENT_TASK.taskId` + `SCAN_CARD_SEQ` |
| RPC fail (mất mạng) | `markServerFail` → netDot "Server lỗi"; rollback optimistic; **không có offline queue bền** (chỉ trong-bộ-nhớ client) |
| Queue đầy (50) | Chặn scan + viền đỏ pulse + disable input |
| Task xuyên nửa đêm | Sort/count theo `scannedAtEpoch` (số) — không theo text |
| Kết thúc / quay lại khi còn scan đang xử lý | Chặn bằng `scanBusy()` (queue + processing) |
| Mở lại task | ABSENT → PENDING (quét tiếp); PRESENT giữ nguyên |
| Anonymous gọi `syncFromCsv`/`setupSheets`/`debug` | Gate `isEditor_()` fail-closed (chỉ deployer) |
| Sheet cũ thiếu cột `date` (migration) | `ensureSheets_` tự thêm cột + header nếu `getLastColumn() < 11` |
| Non-owner quét task phase Mở (T-1) | Reject `UI_LABELS.SCAN_OPEN_OWNER_ONLY` — client disable input + banner + ẩn nút Bắt đầu điểm danh/Nạp danh sách; server reject lần cuối |
| Task legacy `createdBy='web'`/rỗng | **KHÔNG gate** — ai cũng quét được phase Mở (A1 fail-open) |
| Dán mã lặp trong cùng 1 lần paste | `planBatchScans` simulate log → lần 2 reject `already-present`/`already-scanned` |
| Dán mã > 200 dòng | Clamp 200 dòng đầu (cả client lẫn server — A4) |
| Dán mã sai prefix | `invalid-format` — liệt kê lỗi nhưng KHÔNG dừng batch |
| Escape trong view Giới thiệu (viewAbout — không phải modal) | Quay về view trước (`lastViewBeforeAbout`), không tắt modal |
| Non-admin gọi `getAuditLogApi` / non-manager gọi `searchLogsByStaffApi` | Gate `requireRole_` ('admin'/'manager') TRONG try → `{ok:false}` (DEFENSE — sheet chưa cấu hình cũng không ném) |
| Non-operator gọi quét/tạo/complete/reopen/paste | Gate `requireRole_('operator')` ở service layer (M1 — chống bypass qua google.script.run) |
| StaffAttendance >100KB | Cache chunked (`all_*` nhiều key ≤100KB) — đọc gộp lại khi render báo cáo |
| Scan/Create RPC chồng nhau (bấm ⟳ liên tục) | `_refreshLock` + đếm `_refreshPending` — nhả khi CẢ 2 RPC xong; timeout 5s bảo hiểm |
| Task 2 thiết bị quét cùng lúc (race) | `planScanCommits` re-check freshLogRows sau lock: append biến update / không đè epoch có sẵn |

---

## 14. Thay đổi so với Spec 2.0.0

Bản 2.0.0 (2026-07-31) mô tả nhiều tính năng **không tồn tại trong code thực tế** — đã loại bỏ/đính chính:

| Mục | Spec 2.0.0 (cũ — ảo) | Thực tế (code) |
| :-- | :-------------------- | :------------- |
| Attendance | Check-in + Check-out (2 lần quét riêng) | **2-phase quét** — Mở: LISTED_AT (TIME_REF) · Điểm danh: SCANNED_AT (TIME_SCAN); mỗi phase quét 1 lần / NV |
| Task state | 4 states `Created→CheckIn→CheckOut→Closed` + phase restriction | **3 states `open`/`attend`/`done`** + `transitionToAttend` (`open→attend`) + `reopen` (`done→attend`) |
| Loại task | Handover + Attendance | **FREE** (mọi task — không còn reconcile) |
| Task ID | `T-YYYYMMDD-XXXX` (random 4 số) | `RYYYYMMDD-HHMM` (+ `-2` nếu trùng phút) |
| Offline mode | Queue localStorage 50–100, retry, flush on reconnect | **Không có** — queue client chỉ trong-bộ-nhớ, RPC fail = rollback |
| Paste batch | 100 items/chunk, retry | **Có** — `pasteCodesApi` batch 1 setValues + clamp 200 (A4), dedupe trong batch (T-2) |
| Phân quyền | Admin/User 2 cấp | **Role 4 bậc viewer<operator<manager<admin** (roleMap, §5.6) + role owner scan phase Mở (`canScanOpen_`, §5.5) + gate editor-only `isEditor_()` cho debug/sync/setup |
| Frontend | Vanilla + **Bootstrap 5.3** | Vanilla thuần, **không Bootstrap** |
| Storage | localStorage + **IndexedDB** (24h) + SWR staggered | localStorage (âm thanh) + cache trong-bộ-nhớ (SWR 15s scan view); không IndexedDB |
| Sound | Base64 embedded | **Web Audio API** (beep 880Hz / buzz 200Hz) |
| Testing | Jest + Playwright, coverage >80% | **Node `node:test`**, 186/186 (18 files), mock `mock-google.js` + contract test mock↔server |
| Sheets | 3 sheets (`AttendanceData`/`Task`/`Log`) | **7 sheets** (Config, StaffData 20 cột, AttendanceTask 9 cột, AttendanceLog 11 cột, AuditLog 5 cột, StaffInfo, StaffAttendance) |
| Log | Batch flush 10 records/20s, append-only | Pre-fill 1 lần + **update-in-place** + cache log rows 30s; `batchAppendLogRows_` (paste) |
| Audit log | Sheet riêng, 3 actions, vĩnh viễn | **Có** — AuditLog sheet 5 cột (`AuditRepo.audit_`), viewAdmin admin (2026-08-17) |
| Cooldown 15s | Có | **Không có** (chỉ chặn duplicate scan) |
| URL deep-linking / bottom nav | Có | **Có bottom nav mobile** (`#bottomNav` — Trang chủ/Điểm danh mọi role + Thống kê/Dữ liệu/Báo cáo manager+ + Cấu hình editor + Quản trị admin); KHÔNG có URL deep-linking |
| Pipeline 5 bước | Validate→cooldown→Find→Execute→Flush | `classifyScan` 3 nhánh (update/append/reject) 2-phase + LockService + owner gate |

---

## 15. Scope & lộ trình

### Đã hoàn thành (MVP — khớp code)

```plain
✅ Tạo task (A2): luôn FREE + Mở + log RỖNG — modal chỉ Station + Ngày; quét / dán / nạp roster xây danh sách
✅ A2 (2026-08-18): task mới KHÔNG pre-fill roster khi tạo (kể cả ca thật — server ép noList); nút "Lấy danh sách theo ca" (loadRosterApi — idempotent, phase 1 + owner); phase 1 không Dư; cảnh báo chuyển phase khi log rỗng
✅ Đợt 3 (2026-08-19): UI operator — thuật ngữ: **Bắt đầu điểm danh** / **Chốt ca** / **Đang ghi danh sách** / **Đã chốt điểm danh** / **Đã điểm danh** (bỏ "quét lần 2") · gộp Dán mã + Lấy theo ca → **1 nút "Nạp danh sách"** (modal 2 tab, bỏ menu Thêm + class topbar-more/scanMore*) · ẩn cột Tạo lúc/Người tạo bảng task (list + F-search) · nudge quên chuyển phase (quét trùng phase Mở → toast gợi ý, client-only — không thêm field server) · label Dư → "Dư — không có trong danh sách".
✅ Đợt 1 (2026-08-19): force-close admin completeTask (counter lệch — audit completeTaskForceClose, non-admin chặn) · loadRoster thêm phase Điểm danh (chặn DONE) · cột Sửa bảng quét + updateLogRowStatusApi (owner/admin, fill TIME_SCAN khi PRESENT, **L1: đổi ngược PRESENT→ABSENT/PENDING clear SCANNED_AT / PENDING thêm LISTED_AT / EXTRA giữ SCANNED_AT — partition invariant**, audit fixLogRowStatus kèm fillScanTime/clearScanTime/clearListedAt, mọi phase kể cả DONE) · chống gian lận giờ (epoch client ±3 phút + không sớm hơn tạo task) · cảnh báo staffUnknown (mã quét không có trong StaffData)
✅ Nạp roster theo ca: append AttendanceLog 1 lần (dedupe staffId giữ dòng đầu); TIME_REF = LISTED_AT = lúc nạp
✅ Thời gian quét WYSIWYG (2026-08-18): client gửi epoch lúc quét → sheet ghi đúng giờ hiển thị trên app (server không đè giờ xử lý — hết nhảy giờ sau ~1s); bảng quét cột Ngày hiện ngay (dateText từ response + staffIndex); roster modal thêm lọc Hình thức; getFilterOptionsApi cache 60s
✅ 2-phase: Mở (LISTED_AT, FREE) → Bắt đầu điểm danh → Điểm danh (SCANNED_AT) → Chốt ca
✅ Quét barcode Ops (case-insensitive): Có mặt / Đã điểm danh / Đã ghi LISTED_AT / Dư / Task đã kết thúc
✅ Kết thúc task → NV chưa quét gán Vắng (batch 1 lần); Mở lại task → về Điểm danh, reset Vắng
✅ Hủy task rỗng (2026-08-19): cancelTaskApi — phase Mở + log rỗng + owner/admin; xóa hẳn task khỏi AttendanceTask; task có dữ liệu bị chặn
✅ Role owner phase Mở (T-1): server gate `canScanOpen_` + permission tươi + client khoá input/banner
✅ Paste danh sách mã (T-2): pasteCodesApi batch (1 setValues + cache 1 put), clamp 200, dedupe trong batch
✅ Shell UI 9 view (viewHome/Stats/Tasks/Scan/Staff/Config/Reports/Admin/About) + sidebar 8 mục + showSection đủ 9 id + repairViewParents
✅ Counters tức thì (optimistic + queue nền + rollback)
✅ Scan card projector + toast + Web Audio (beep/buzz) + toggle âm thanh
✅ Bảng NV: tìm kiếm, lọc trạng thái, sort theo epoch
✅ Cache versioned (13 keys) + LockService + batch read/write
✅ Gate editor-only cho debug/sync/setup (fail-closed)
✅ Role 4 bậc + roleMap Config + gate service layer (M1) + gate-bypass test; phân quyền view: viewer+ (Tasks/Scan/Home/About) · manager+ (Stats/Staff/Reports) · admin (Admin) · editor (Config) — 2026-08-17
✅ viewReports (báo cáo chấm công tháng theo email) + viewStats (pivot) + viewStaff (20 cột)
✅ viewAdmin — nhật ký hoạt động AuditLog (chỉ admin, lọc ngày); bỏ bảng task trùng viewTasks (2026-08-17)
✅ A11y: skip-link, focus trap, aria-live, prefers-reduced-motion/contrast
✅ Test Node 179/179 (18 files) + audit CSS/GS/style/UI · Deploy clasp (chỉ clasp deploy — không PUT deployments)
```

**Rủi ro đã chấp nhận (biết rõ, cố tình bỏ qua):**
- Task legacy `createdBy='web'` không xác định owner → fail-open phase Mở (A1 — task cũ vẫn quét được).
- Role viewer chưa có giao diện riêng — gate `requireRole_('operator')` chỉ cắn khi cấu hình role viewer trong roleMap.

### Post-MVP (chưa làm — KHÔNG nằm trong code hiện tại)

```plain
⏳ Đồng bộ HR tự động (Phase 2: trigger từ Drive/URL thay vì syncFromCsv tay)
⏳ Dashboard thống kê real-time (viewStats hiện là snapshot pivot StaffData, chưa real-time)
⏳ Index/log tối ưu khi AttendanceLog lớn (hiện đọc full sheet mỗi task detail/list)
⏳ PWA / offline thực sự
```
