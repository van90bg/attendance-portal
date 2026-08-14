# Spec — RollCall v2: Hệ thống Điểm danh Đối chiếu Nhân viên Kho

> **Version:** 2.2.0 | **Status:** Final | **Cập nhật:** 2026-08-07
>
> **Ghi chú viết lại:** Spec viết lại **hoàn toàn theo codebase thực tế**.
> v2.2 (2026-08-07): thêm **2 loại task (reconcile — đối chiếu, free — quét tự do)**, **3 trạng thái `open`/`attend`/`done` (2-phase quét)**, **role owner** cho scan phase Mở, **pasteCodesApi (dán danh sách mã)**, **view Giới thiệu (aboutView)**.
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
[Chọn tổ hợp (Station + Ca + Team + [Date]) → task Đối chiếu (tạo ở Điểm danh, pre-fill log)
 | Chế độ Quét tự do (FREE) → task Mở (log rỗng, quét lần 1 xây danh sách)]
→ Quét barcode NV → phase Mở: ghi Giờ có mặt · phase Điểm danh: ghi Giờ quét (Có mặt / Dư / reject)
→ Chuyển điểm danh (FREE) → Kết thúc task → NV chưa quét gán Vắng
→ (tuỳ chọn) Mở lại task (về Điểm danh) → quét tiếp
```

---

## 2. Kiến trúc

```
index.html (toàn bộ UI, 1 file)
    │  google.script.run (async, callback-based)
    ▼
Code.gs        — doGet (WebApp) + API endpoints + isEditor_() + syncFromCsv/setupSheets + debugState
TaskService.gs — nghiệp vụ task: createTask (reconcile/free) / transitionToAttend / completeTask / reopenTask / listTasks / getTaskDetail (+permission)
ScanService.gs — nghiệp vụ quét: scanStaff (guard Ops + owner gate + LockService + update/append + benchmark) + pasteCodes (dán danh sách mã)
Database.gs    — truy cập GAS: SpreadsheetApp + CacheService (wrapper cache, batch read/write)
ScanLogic.gs   — logic THUẦN: classifyScan 2-phase + computeCounters + canScanOpen_ (owner gate) + planBatchScans (paste) — KHÔNG gọi GAS API → test Node được
CsvUtil.gs     — logic THUẦN parse/normalize CSV + lọc/dedupe/distinct + isValidBarcodeId
Config.gs      — mọi hằng số: sheet names, cột, trạng thái, cache keys/TTL, UI labels
```

**Nguyên tắc kiến trúc:**

- **Tách logic thuần khỏi GAS API**: `ScanLogic.gs` + `CsvUtil.gs` không gọi `SpreadsheetApp`/`CacheService`/`Session` — chạy được trên Node (`node --test`). Các wrapper (`Database`/`ScanService`/`TaskService`/`Code`) mỏng, chỉ lo GAS side-effects.
- **Batch read/write**: `getValues()`/`setValues()` theo khối; không `getValue()`/`setValue()`/`appendRow()` trong loop.
- **Hằng số tập trung tại `Config.gs`** — không hardcode rải rác; client mirror `STATUS_C`/`TASK_STATUS_C` trong `index.html` (1 nguồn mỗi phía).

---

## 3. Dữ liệu — Google Sheets (4 sheets)

Spreadsheet: Script Property `SPREADSHEET_ID` — không hardcode ID production vào repo (Config `DEFAULT_SPREADSHEET_ID`; nếu rỗng + chưa set Script Property `SPREADSHEET_ID` → `getSpreadsheet_` **THROW** — `ALLOW_DB_AUTO_CREATE=false` (m7): không tự tạo DB rỗng, tránh phân mảnh dữ liệu sang DB mới âm thầm).

### 3.1 Config

`Key` | `Value` — cấu hình (tối thiểu, Phase 0 gần như không dùng).

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
- Cache: index 5 phút (`STAFF_INDEX`) + list 5 phút (`FILTER_OPTIONS`).
- **1 dòng = 1 NV–1 ca–1 station** (NV có thể nhiều dòng khác ca).

### 3.3 AttendanceTask (9 cột)

| Cột | Field | Ghi chú |
| :-- | :---- | :------ |
| 1 | `taskId` | `RYYYYMMDD-HHMM` (+ `-2`, `-3`… nếu trùng phút) |
| 2 | `taskType` | `reconcile` (đối chiếu) / `free` (quét tự do) |
| 3 | `station` | Station đã chọn (1) |
| 4 | `slotCode` | Ca đã chọn — multi-select nối `", "` để hiển thị |
| 5 | `team` | Team đã chọn — multi-select nối `", "` |
| 6 | `status` | `open` (Mở) / `attend` (Điểm danh) / `done` (Xong) |
| 7 | `createdAt` | thời điểm tạo |
| 8 | `createdBy` | email người tạo (webapp đăng nhập); task legacy tạo cũ = `'web'` — dùng cho owner gate (§5.5) |
| 9 | `completedAt` | thời điểm kết thúc (rỗng khi open) |

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
| 8 | `timeRef` | **ngày tạo task** (pre-fill batch lúc tạo task) |
| 9 | `timeScan` | giờ quét đối chiếu (rỗng = chưa quét) |
| 10 | `status` | `-` / `Có mặt` / `Vắng` / `Dư` |
| 11 | `date` | **ngày vào làm** (copy từ StaffData) — hiển thị cột Date; khác `timeRef` (ngày task) |

> **Đã bỏ cardIn/cardOut (2026-08-03):** log không copy 2 cột Clock In/Out từ StaffData nữa — StaffData giữ nguyên, chỉ hiển thị.

---

## 4. Mô hình Task

### 4.1 Loại task

2 loại (`TASK_TYPE` trong Config.gs):

- `reconcile` (Đối chiếu danh sách) — tạo từ tổ hợp StaffData; **pre-fill AttendanceLog 1 lần** (`timeRef = createdAt`, `status='-'`) và task tạo ra ở trạng thái **Điểm danh** (`attend`) — quét ngay là Giờ quét.
- `free` (Quét tự do / noList) — **không cần tổ hợp**, log rỗng; task tạo ra ở trạng thái **Mở** (`open`). Quét lần 1 xây danh sách (ghi Giờ có mặt, `PENDING` — chưa điểm danh), bấm **Chuyển điểm danh** rồi quét lần 2 (Giờ quét).

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
| `open` | 1 — Mở | Quét ghi **Giờ có mặt** (TIME_REF); **chỉ owner/admin** quét được (§5.5) |
| `attend` | 2 — Điểm danh | Quét ghi **Giờ quét** (TIME_SCAN); mọi người quét được |
| `done` | — | Đã kết thúc — quét reject `task-closed` |

Đặc điểm tạo task:
- `reconcile` (có danh sách): **sinh ra ở `attend`** — đã pre-fill Giờ có mặt = giờ tạo task, quét ngay là Giờ quét.
- `free` (noList): **sinh ra ở `open`** — quét lần 1 = Giờ có mặt, chuyển Điểm danh mới quét lần 2.

`transitionToAttend(taskId)` — `open → attend`, guard `status === OPEN`; không sửa log (NV đã có Giờ có mặt giữ nguyên), mở nút Kết thúc. Mở cho mọi user (không gate role).

### 4.4 Tạo task (`createReconcileTask`)

1. Validate: đủ `station` (1) + `slotCode` (≥1) + `team` (≥1); thiếu → `{ok:false, message:'Thiếu station/slotCode/team'}`. Chế độ Quét tự do (noList) **bỏ qua validate tổ hợp** — không cần group.
2. `filterStaffByGroup` trên StaffData: khớp station **và** slot (bất kỳ slot chọn) **và** team (bất kỳ team chọn) **và** date (tuỳ chọn).
3. `dedupeStaffByGroup`: **dedupe theo staffId trong cùng tổ hợp, giữ dòng đầu** (Att.csv thật có NV 2 dòng cùng ca → tránh phantom absent + row-key client lệch). Không dedupe toàn cục (NV nhiều ca hợp lệ phải giữ).
4. Tổ hợp rỗng → `{ok:false, message:'Không có nhân viên nào trong tổ hợp đã chọn'}`.
5. `insertTask_` (append 1 dòng) + (nếu có list) `batchInsertLogRows_` — **pre-fill log 1 lần** (`timeRef=createdAt`, `status='-'`), batch `setValues` 1 lần (không appendRow trong loop). `TIME_REF = Giờ có mặt` (breaking 2026-08-05).
6. Status khởi tạo: `noList ? OPEN : ATTEND` (§4.3).
7. Toàn bộ nằm trong `LockService.waitLock(10000)`.

### 4.5 Kết thúc task (`completeTask`)

- Guard: task phải `attend` (phase 2); còn `open` → `UI_LABELS.COMPLETE_BLOCKED` ('Chỉ kết thúc khi ở Điểm danh'); `done` → 'Task đã kết thúc'.
- **Thứ tự fail-safe**: `markUnscannedAbsent_` TRƯỚC → `updateTaskStatus_(DONE, completedAt)` SAU.
  - `markUnscannedAbsent_`: `transformLogStatuses_` — batch ghi 1 lần cả cột status; dòng `timeScan` rỗng + status `-` → `Vắng`; dòng có `timeScan` nhưng status `-` (legacy/sửa tay) → **chuẩn hóa `Có mặt`** (không đánh Vắng).
  - Nếu mark fail (quota/timeout): task vẫn `attend` → retry được. Nếu status-update fail: vẫn `attend`, mark idempotent → retry an toàn.

### 4.6 Mở lại task (`reopenTask`)

- Guard: task phải `done`; `open` → 'Task đang mở — không cần mở lại'.
- `resetAbsentToPending_`: ABSENT → PENDING (NV Có mặt giữ nguyên timeScan/status) — batch 1 lần, rồi `updateTaskStatus_(ATTEND)` — **về Điểm danh** (không về Mở), quét tiếp được ngay. Thứ tự fail-safe giống completeTask.

### 4.7 Đọc dữ liệu

- `listTasks()` → mới nhất lên đầu; merge counters (`total/scanned/extra`) từ AttendanceLog 1 lần + cache (`TASK_COUNTS` 30s) — không N+1.
- `getTaskDetail(taskId)` → `{ok, task, log, counters}` qua cache `TASK_DETAIL` 15s. **`task.permission = {isAdmin, isOwner, canScanOpen}`** tính TƯƠI cho người đọc (sau cache, không lưu chung) — cache detail dùng chung mọi user nên không thể chứa permission theo email.

---

## 5. Mô hình quét (Scan)

### 5.1 Mã barcode

- **Chỉ chấp nhận "Ops" + số** (case-insensitive): `isValidBarcodeId` = `/^ops\d+$/i`.
- Client check `/^ops\d+$/i` chạy **trước queue** (0ms, không gọi server); server có guard lại (chống bypass qua console).

### 5.2 Pipeline `scanStaff` (ScanService)

```
normalizeStaffId (trim + UPPERCASE)
  → isValidBarcodeId?  (sai format → reject 'Mã phải bắt đầu bằng "Ops" và chỉ chứa số')
  → LockService.waitLock(10000)
  → readTask_ (không tồn tại → reject)
  → owner gate (T-1): task status === open && !canScanOpen_() → reject UI_LABELS.SCAN_OPEN_OWNER_ONLY
  → readLogRowsCached_ (cache 30s + incremental — không getDataRange full sheet mỗi scan)
  → classifyScan (ScanLogic — thuần, 2-phase theo task.status)
  → update: phase open → updateLogRowRef_ (timeRef) · phase attend → updateLogRowScan_ (1 setValues: timeScan + status)
  → append: buildExtraRow (lazy readStaffIndex_ — chỉ đọc khi NV lạ) + appendRow (batch 1 dòng)
  → computeCounters → return {ok, message, status, timeScanText, timeScanEpoch, staffName, counters}
  → finally: lock.releaseLock()
```

**Paste danh sách mã (`pasteCodes`, T-2)** — cùng gate + lock, khác đường ghi:

```
pasteCodesApi(taskId, lines) → clamp 1000 dòng (A4) → lock 1 lần
  → gate: taskType === FREE && status === open && canScanOpen_ (A5)
  → readLogRowsCached_ 1 lần → planBatchScans (pure ScanLogic — dedupe trong batch nhờ simulate log)
  → append: batchAppendLogRows_ — 1 setValues N dòng + update LOG_ROWS cache 1 lần (300 RPC → 1)
  → update dòng đã có: updateLogRowRef_/updateLogRowScan_ từng mã (số ít — giới hạn ghi chú)
  → computeCounters → {ok, total, success, failed, results[], counters}
```

### 5.3 Phân loại quét (`classifyScan` — 2-phase theo `task.status`)

| Phase (status) | Điều kiện | Action | Status | Ghi chú |
| :-------- | :-------- | :----- | :----- | :------ |
| `staffId` rỗng | — (mọi phase) | `reject` | — | `empty-staff-id` |
| `open` — Mở | NV trong log + chưa có Giờ có mặt | `update` | `-` (PENDING) | ghi TIME_REF (Giờ có mặt) |
| | NV trong log + đã có Giờ có mặt | `reject` | — | `already-present` |
| | NV không trong log (reconcile) | `append` | `Dư` | ghi TIME_REF |
| | NV không trong log (free) | `append` | `-` (PENDING) | hợp lệ — xây danh sách, KHÔNG Dư |
| `attend` — Điểm danh | NV trong log + chưa quét (PENDING) | `update` | `Có mặt` | ghi TIME_SCAN |
| | NV trong log + status `Dư` (EXTRA) | `update` | `Dư` | ghi TIME_SCAN — **GIỮ Dư**, không đổi Có mặt |
| | NV trong log + đã quét | `reject` | — | `already-scanned` |
| | NV không trong log | `append` | `Dư` | ghi TIME_SCAN (reconcile & free đều Dư) |
| `done` / khác | — | `reject` | — | `task-closed` |

- **2 phase quét riêng biệt** — KHÔNG check-in/check-out 2 lần trong cùng phase; mỗi phase NV quét 1 lần.
- **Update-in-place**: NV đã có trong log được cập nhật tại dòng hiện tại (không append dòng mới, không append-only).
- `findLogRow` so khớp case-insensitive theo `staffId` chuẩn hóa.

### 5.4 Counters (`computeCounters`)

| Counter | Công thức |
| :------ | :-------- |
| `scanned` (Đã quét) | số dòng `timeScanEpoch > 0` (gồm PRESENT + EXTRA) |
| `absent` (Chưa điểm danh / Vắng) | số dòng `timeScanEpoch == 0` và status ≠ EXTRA |
| `extra` (Dư) | số dòng status = EXTRA |
| `total` | tổng số dòng log |

> **`timeScanEpoch` là nguồn sự thật duy nhất** cho counters + sort (text `HH:mm:ss` mất ngày — sort sai khi task xuyên nửa đêm). Client mirror đúng quy ước này (optimistic bump / rollback / sync đều recount theo epoch).
> 2-phase: `timeRefEpoch` = Giờ có mặt (phase Mở) — chỉ dùng ghi/nhận diện `already-present`; counters **chỉ đếm theo `timeScanEpoch`** (Giờ quét).

### 5.5 Role — quyền quét phase Mở & paste (T-1, T-2)

Pure helper `canScanOpen_(cfg, createdBy, activeEmail, isAdmin)` (ScanLogic — Node-test được):

- Task KHÔNG ở `open` → cho phép (gate chỉ áp dụng phase Mở).
- `isAdmin` (= `isEditor_()`, deployer) → bypass.
- `createdBy` là **email hợp lệ** (không rỗng, ≠ `'web'`, chứa `@`) → chỉ chủ sở hữu (`activeEmail === createdBy`, case-insensitive) được quét.
- `createdBy` **không xác định** (`'web'`/rỗng — task legacy) → ai cũng quét được (**A1 fail-open** — tương thích task cũ, đổi 1 dòng nếu muốn chặt).

Server tính `permission = {isAdmin, isOwner, canScanOpen}` **tươi (mới)** trong `getTaskDetail` (sau cache — không lưu vào cache 15s vì cache dùng chung mọi user). Client `applyScanPermission()` (gọi CUỐI `renderScanView` — nguồn quyết định cuối, cờ `scanOwnerLocked`):
- `!canScanOpen` + phase Mở → `scanInput.disabled = true` + banner "Chỉ owner mới quét được ở phase Mở" + ẩn nút **Chuyển điểm danh** + ẩn nút **Dán danh sách mã**; `submitScan` guard lại (defense barcode vật lý).
- `updateFinishBtnState` / `updateQueueFullState` tôn trọng `scanOwnerLocked` (không vô tình bật lại).

**Paste (T-2)** gate cùng rule (A5): `taskType === FREE` + `status === open` + `canScanOpen` — `pasteCodes` server reject nếu không thoả.

---

## 6. Trạng thái đối chiếu (badge)

| Hằng số | Giá trị (UI) | Khi nào gán |
| :------ | :----------- | :---------- |
| `PENDING` | `-` (badge "Chưa điểm danh") | pre-fill lúc tạo task; reset lại khi reopen |
| `PRESENT` | `Có mặt` | quét NV trong log + chưa quét |
| `ABSENT` | `Vắng` | **chỉ khi kết thúc task** (dòng chưa quét) |
| `EXTRA` | `Dư` | quét NV không có trong log |

- Task đang mở: badge `-` hiển thị "Chưa điểm danh" (chưa quét **≠** vắng); task kết thúc: label counter đổi thành "Vắng".
- UI chỉ đổi label, không đổi logic (dùng `STATUS_C` mirror — đổi chuỗi hiển thị không vỡ logic).

---

## 7. Cache & Lock

### 7.1 Cache keys (versioned `rc2_*_vN` — bump version để invalidate toàn bộ)

| Key | TTL | Mục đích | Invalidate |
| :-- | :-: | :------- | :--------- |
| `rc2_staffIndex_v1` | 5m | index StaffData `{staffId → staff}` | `syncFromCsv` |
| `rc2_filterOptions_v1` | 5m | toàn bộ staff list (dropdown/filter) | `syncFromCsv` |
| `rc2_taskList_v1` | 30s | danh sách task | mọi ghi task |
| `rc2_taskCounts_v1_all` | 30s | counters cho list (đọc log 1 lần) | mọi ghi task |
| `rc2_taskDetail_v1_{taskId}` | 15s | chi tiết task + log + counters | **mọi đường ghi log/đổi status** |
| `rc2_logRows_v1_{taskId}` | 30s | log rows đường quét — **cache SLIM** (chỉ field scan cần, ~32KB) + **incremental update** (scan kế không chạm sheet) | ghi batch/append |
| `rc2_tz_v2` | 24h | timezone script (1 lần — không gọi `Session.getScriptTimeZone()` trong loop) | — |

- `CacheService` giới hạn **100KB/key** → log rows dùng cache slim; `put` fail/`parse` fail đều `console.warn` (không giấu lỗi — cache miss âm thầm).
- Negative-cache: `readTaskDetailCached_` cache `null` 15s → `insertTask_` phải invalidate detail của taskId để phá.

### 7.2 LockService

- Script-level lock, `waitLock(10000)`, **release trong `finally`** — mọi luồng ghi: `createReconcileTask`, `transitionToAttend`, `completeTask`, `reopenTask`, `scanStaff`, `pasteCodes`.
- `transformLogStatuses_` (kết thúc / mở lại): batch `setValues` 1 lần cả cột status — không `setValue` trong loop (241 NV = 1 RPC thay vì ~240).

---

## 8. API (google.script.run + debug URL)

### 8.1 Endpoints client

| API | Trả về |
| :-- | :----- |
| `getMeta()` | `{ ok, appTitle }` |
| `getFilterOptions()` | `{ ok, stations[], slotCodes[], teams[], dates[] }` — distinct từ StaffData |
| `previewStaffApi(input)` | `{ ok, count }` — số NV khớp tổ hợp (đã dedupe, khớp count tạo task thật) — không tạo gì |
| `createReconcileTaskApi(input)` | `{ ok, taskId, count, message }` |
| `getTaskListApi()` | `[{ taskId, station, slotCode, team, status, total, scanned, extra, createdAtText, createdBy }]` |
| `getTaskDetailApi(taskId)` | `{ ok, task, log[], counters }` — `task.permission = {isAdmin, isOwner, canScanOpen}` (§5.5) |
| `scanStaffApi(taskId, staffId)` | `{ ok, message, status, timeScanText, timeScanEpoch, staffName, counters }` |
| `transitionToAttendApi(taskId)` | `{ ok, message }` — `open → attend` |
| `completeTaskApi(taskId)` | `{ ok, message }` |
| `reopenTaskApi(taskId)` | `{ ok, message }` — `done → attend` |
| `pasteCodesApi(taskId, lines)` | `{ ok, total, success, failed, results[{code, ok, status, message}], counters }` — FREE + open + owner; clamp 1000 |

> `google.script.run` **không trả `Date`** (serialize → null) → server trả text đã format; client check cả `xxx` + `xxxText`.

### 8.2 Debug URL (QA/verify — KHÔNG dùng production)

- `?debug=1` → JSON cấu trúc sheet + taskId + probe detail.
- `?debug=createTask&station=..&slotCode=..&team=..` → tạo task thật + trả detail (end-to-end không qua UI).

**Cả 2 đều gate editor-only** qua `isEditor_()` (fail-closed):
- So sánh `Session.getActiveUser().getEmail()` (người truy cập webapp — rỗng khi anonymous) với `Session.getEffectiveUser().getEmail()` (deployer, vì `executeAs: USER_DEPLOYING`).
- Chỉ deployer được chạy; exception → `false` (không fail-open). Dùng chung cho `debugState()`, `syncFromCsv()`, `setupSheets()` (anonymous gọi được qua console nếu không gate).

### 8.3 WebApp manifest

- `executeAs: USER_DEPLOYING`, `access: DOMAIN` — chỉ user @spxexpress.com (môi trường máy tính đăng nhập).
- `doGet` tự `ensureSheets_()` mỗi lần load (chỉ set header khi sheet trống — rẻ).

---

## 9. Giao diện & UX (`index.html` — 1 file, ~3000 dòng)

### 9.1 Ba view

**View 1 — Danh sách task (`#viewList`):**
- Header: logo SPX + title + net-dot/Online + 🔊 + ⟳ Làm mới + **ⓘ (mở view Giới thiệu)**.
- Card "TẠO TASK": nút **+ Tạo task** — modal 5 dropdown, chọn Ca = **'Tự do'** → chế độ **Quét tự do (không cần danh sách)**; ngược lại là **Đối chiếu (có danh sách)**.
- Card "DANH SÁCH TASK": bảng STT / Mã task / Station / Ca / Team / Tổng NV / Đã quét / Dư / Trạng thái / Tạo lúc / Người tạo / Thao tác.
  - Task `open` → nút **Quét** (và **Chuyển điểm danh** trong màn quét); task `attend` → **Quét**; task `done` → **Xem** + **Mở lại**.
  - Skeleton loading; empty state.

**View 2 — Màn quét (`#viewScan`):**
- **Scan topbar (sticky)**: `← Danh sách task` · tiêu đề `taskId` + meta · nút **Chuyển điểm danh** (chỉ phase `open`) + **Kết thúc** (chỉ phase `attend`) — ẩn theo role (T-1).
- **Cột trái**: 3 counters (Đã quét / Chưa điểm danh / Dư) · ô quét to (laser-line animation khi focus) + nút Quét (mobile <992px) · **scan card projector** (ok/err/extra, nhìn 1–2m) · nút **Dán danh sách mã** (chỉ FREE + open + owner).
- **Cột phải**: bảng NV — tìm kiếm + lọc trạng thái + sort; cột Giờ có mặt / Giờ quét theo phase; dòng Dư nền cam; row-diff (chống flicker).
- **Khoá theo role (T-1)**: `!canScanOpen` + phase Mở → input disabled + banner cam "Chỉ owner mới quét được ở phase Mở" + ẩn nút Chuyển điểm danh / Dán mã.

**View 3 — Giới thiệu (`#aboutView`, thay modal cũ — T-3):**
- Mở từ nút **ⓘ** (header) — `showSection('aboutView')` quản 3 view (`viewList` / `viewScan` / `aboutView`) + lưu `lastViewBeforeAbout` để nút `← Quay lại` trả đúng view trước.
- Nội dung 3 mục: **Giới thiệu** (2 chế độ RECONCILE / FREE) · **Hướng dẫn từng bước** (7 bước) · **Quy tắc phân quyền (Role)** (bảng Owner/Admin/Khác theo rule §5.5 + ghi chú task legacy `web` không áp dụng gate).

Modal còn lại: tạo task · confirm dùng chung · **pasteModal** (dán danh sách mã, T-2) — tất cả dùng lớp `.about-overlay` + `anyModalOpen()` (Escape/focus trap/autofocus loop).

**Chuyển view:** `showSection(name)` — ẩn cả 3, dừng/kích auto-focus theo view (`viewScan` → `startAutoFocusLoop()`; khác → dừng).

### 9.2 Modal tạo task

- **5 field dạng dropdown** (gọn thay cây checkbox 3 cấp cũ): Station (single) · Ca · Team · Hình thức (multi-select checkbox + chips) · Ngày (single, optional).
- **Ca mở đầu optional 'Tự do'** — chọn = chế độ FREE: ẩn field Hình thức, disable Ngày (`slotCode:["Tự do"]` quyết định, không cần nút chế độ riêng).
- **Badge số NV từng option** (`previewStaffCountsApi` → fetchOptCounts) hiển thị trong menu dropdown; 'Tự do' không count.
- **Số NV khớp trên nút Tạo** (`previewStaffApi`, debounce 200ms) — không còn vùng preview riêng trong modal.
- Menu dropdown: `position:absolute` + `overflow visible` của dialog (không bị cắt, modal không tự dãn theo menu); click ngoài hoặc Escape đóng menu (Escape ưu tiên menu trước modal).
- Reset select mỗi lần mở (tránh tạo nhầm task). Modal confirm dùng chung thay `confirm()`/`alert()` trình duyệt.

### 9.3 Scan queue nền (client)

- Capture **0ms**: clear + focus + toast optimistic + scan card + counters recount NGAY; server xử lý nền tuần tự.
- Chặn sớm: mã không phải `Ops` → toast lỗi; đã quét (Có mặt/Dư) → "Đã điểm danh" (không gọi server); queue đầy (max 50) → chặn + viền đỏ pulse + disable input.
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
- Textarea 1 dòng = 1 mã; bỏ dòng rỗng; giới hạn 1000 dòng (client + server clamp).
- Gọi `pasteCodesApi` → hiện **summary** (xanh/đỏ: `success/total` thành công, `failed` thất bại) + liệt kê mã hỏng (sai format / đã có mặt / đã điểm danh / chặn) dạng danh sách; refresh `CURRENT_LOG`/`CURRENT_COUNTERS` từ response + `loadTaskDetail` nền.

---

## 10. Testing

| Hạng mục | Giá trị |
| :------- | :------ |
| Runner | Node `node:test` (`npm test`) |
| Files | `tests/csv-normalize.test.js` + `tests/scan-classify.test.js` + `tests/two-phase.test.js` + `tests/scanservice.test.js` + `tests/paste-batch.test.js` |
| **Kết quả** | **57/57 pass** |
| Mock | `mock/mock-google.js` |
| Fixture | `test-fixtures/Att.sample.csv` |
| Verify UI | `scripts/cdp-helper.js` (open/eval/shot) |

Nhóm test: `distinctValues` · `isValidBarcodeId` · `dedupeStaffByGroup` · `filterStaffByGroup` (multi-select) · `normalizeStaffDate_` · `buildStaffIndex/buildStaffListFromValues` · `classifyScan` (2-phase: task-closed / empty / update PRESENT / already-scanned / already-present / append EXTRA) · `findLogRow` · `computeCounters` (PENDING+timeScan repair) · `buildExtraRow` · `canScanOpen_` (admin bypass / owner case-insensitive / non-owner chặn / `createdBy='web'` fail-open) · `planBatchScans` (3 mã hợp lệ append · trùng trong batch · invalid-format không dừng · thuần) · `scanStaff` wrapper (FREE phase1/phase2, Dư giữ Dư).

> Chỉ test **logic thuần** (CsvUtil/ScanLogic — không gọi GAS). Không Jest/Playwright (bản spec 2.0.0 ghi sai).

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
- Mọi hằng số tập trung tại `Config.gs` — không hardcode; client mirror `STATUS_C`/`TASK_STATUS_C` trong `index.html`.
- Cache key có version (`rc2_*_vN`) — bump để invalidate.
- `google.script.run` không trả `Date` → trả text, check cả `xxx` + `xxxText`.
- Client check mã Ops `/^ops\d+$/i` trước queue (0ms); server guard `isValidBarcodeId()` chống bypass.
- Modal pattern `.about-overlay` + dialog; `anyModalOpen()` cho Escape + focus trap + autofocus loop.
- **Role gate**: `permission` tính TƯƠI trong `getTaskDetail` (không nhét cache chung); client `applyScanPermission()` chạy cuối `renderScanView` → nguồn quyết định cuối (`scanOwnerLocked`) — `updateFinishBtnState`/`updateQueueFullState` tôn trọng.
- Mọi ghi log/đổi status phải gọi `invalidateTaskDetailCache_(taskId)`.
- Không `console.log` production (chỉ `console.error`/`console.warn` + benchmark `scanStaff`).
- Git: branch `main` là nguồn duy nhất; 1 issue / 1 commit; không commit `.clasprc.json`, `codegraph.json`, file tạm verify.

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
| `updateTaskStatus_` ghi nhầm cột (P0 cũ) | Ghi 2 cột rời `STATUS` + `COMPLETED_AT` (không `getRange(r, s, 1, 2)` đè `CREATED_AT`) |
| Response scan của task cũ về muộn | Guard `item.taskId === CURRENT_TASK.taskId` + `SCAN_CARD_SEQ` |
| RPC fail (mất mạng) | `markServerFail` → netDot "Server lỗi"; rollback optimistic; **không có offline queue bền** (chỉ trong-bộ-nhớ client) |
| Queue đầy (50) | Chặn scan + viền đỏ pulse + disable input |
| Task xuyên nửa đêm | Sort/count theo `timeScanEpoch` (số) — không theo text |
| Kết thúc / quay lại khi còn scan đang xử lý | Chặn bằng `scanBusy()` (queue + processing) |
| Mở lại task | ABSENT → PENDING (quét tiếp); PRESENT giữ nguyên |
| Anonymous gọi `syncFromCsv`/`setupSheets`/`debug` | Gate `isEditor_()` fail-closed (chỉ deployer) |
| Sheet cũ thiếu cột `date` (migration) | `ensureSheets_` tự thêm cột + header nếu `getLastColumn() < 11` |
| Non-owner quét task phase Mở (T-1) | Reject `UI_LABELS.SCAN_OPEN_OWNER_ONLY` — client disable input + banner + ẩn nút Chuyển điểm danh/Dán mã; server reject lần cuối |
| Task legacy `createdBy='web'`/rỗng | **KHÔNG gate** — ai cũng quét được phase Mở (A1 fail-open) |
| Dán mã lặp trong cùng 1 lần paste | `planBatchScans` simulate log → lần 2 reject `already-present`/`already-scanned` |
| Dán mã > 1000 dòng | Clamp 1000 dòng đầu (cả client lẫn server — A4) |
| Dán mã sai prefix | `invalid-format` — liệt kê lỗi nhưng KHÔNG dừng batch |
| Escape trong view Giới thiệu (aboutView — không phải modal) | Quay về view trước (`lastViewBeforeAbout`), không tắt modal |

---

## 14. Thay đổi so với Spec 2.0.0

Bản 2.0.0 (2026-07-31) mô tả nhiều tính năng **không tồn tại trong code thực tế** — đã loại bỏ/đính chính:

| Mục | Spec 2.0.0 (cũ — ảo) | Thực tế (code) |
| :-- | :-------------------- | :------------- |
| Attendance | Check-in + Check-out (2 lần quét riêng) | **2-phase quét** — Mở: Giờ có mặt (TIME_REF) · Điểm danh: Giờ quét (TIME_SCAN); mỗi phase quét 1 lần / NV |
| Task state | 4 states `Created→CheckIn→CheckOut→Closed` + phase restriction | **3 states `open`/`attend`/`done`** + `transitionToAttend` (`open→attend`) + `reopen` (`done→attend`) |
| Loại task | Handover + Attendance | **`reconcile`** (đối chiếu) + **`free`** (quét tự do, không danh sách) |
| Task ID | `T-YYYYMMDD-XXXX` (random 4 số) | `RYYYYMMDD-HHMM` (+ `-2` nếu trùng phút) |
| Offline mode | Queue localStorage 50–100, retry, flush on reconnect | **Không có** — queue client chỉ trong-bộ-nhớ, RPC fail = rollback |
| Paste batch | 100 items/chunk, retry | **Có** — `pasteCodesApi` batch 1 setValues + clamp 1000 (A4), dedupe trong batch (T-2) |
| Phân quyền | Admin/User 2 cấp | **Role owner cho scan phase Mở** (`canScanOpen_`, §5.5) + gate editor-only `isEditor_()` cho debug/sync/setup |
| Frontend | Vanilla + **Bootstrap 5.3** | Vanilla thuần, **không Bootstrap** |
| Storage | localStorage + **IndexedDB** (24h) + SWR staggered | localStorage (âm thanh) + cache trong-bộ-nhớ (SWR 15s scan view); không IndexedDB |
| Sound | Base64 embedded | **Web Audio API** (beep 880Hz / buzz 200Hz) |
| Testing | Jest + Playwright, coverage >80% | **Node `node:test`**, 57/57 (5 files), mock `mock-google.js` |
| Sheets | 3 sheets (`AttendanceData`/`Task`/`Log`) | **4 sheets** (Config, StaffData giữ header Att.csv 20 cột, AttendanceTask 9 cột, AttendanceLog 11 cột) |
| Log | Batch flush 10 records/20s, append-only | Pre-fill 1 lần + **update-in-place** + cache log rows 30s; `batchAppendLogRows_` (paste) |
| Audit log | Sheet riêng, 3 actions, vĩnh viễn | **Không có** (Phase 0 không cần) |
| Cooldown 15s | Có | **Không có** (chỉ chặn duplicate scan) |
| URL deep-linking / bottom nav | Có | **Không có** — nhưng **có nút Chuyển điểm danh** (`transitionToAttend`) |
| Pipeline 5 bước | Validate→cooldown→Find→Execute→Flush | `classifyScan` 3 nhánh (update/append/reject) 2-phase + LockService + owner gate |

---

## 15. Scope & lộ trình

### Đã hoàn thành (MVP — khớp code)

```plain
✅ Tạo task: Đối chiếu (tổ hợp Station / Ca multi / Team multi / Date) + Quét tự do (FREE, không danh sách)
✅ Preview số NV khớp trước khi tạo
✅ Pre-fill AttendanceLog 1 lần (dedupe staffId giữ dòng đầu); TIME_REF = Giờ có mặt
✅ 2-phase: Mở (Giờ có mặt, FREE) → Chuyển điểm danh → Điểm danh (Giờ quét) → Kết thúc
✅ Quét barcode Ops (case-insensitive): Có mặt / Đã điểm danh / Đã ghi Giờ có mặt / Dư / Task đã kết thúc
✅ Kết thúc task → NV chưa quét gán Vắng (batch 1 lần); Mở lại task → về Điểm danh, reset Vắng
✅ Role owner phase Mở (T-1): server gate `canScanOpen_` + permission tươi + client khoá input/banner
✅ Paste danh sách mã (T-2): pasteCodesApi batch (1 setValues + cache 1 put), clamp 1000, dedupe trong batch
✅ View Giới thiệu (T-3): aboutView 3 mục (giới thiệu / hướng dẫn / role) + showSection 3 views
✅ Counters tức thì (optimistic + queue nền + rollback)
✅ Scan card projector + toast + Web Audio (beep/buzz) + toggle âm thanh
✅ Bảng NV: tìm kiếm, lọc trạng thái, sort theo epoch
✅ Cache versioned (7 keys) + LockService + batch read/write
✅ Gate editor-only cho debug/sync/setup (fail-closed)
✅ A11y: skip-link, focus trap, aria-live, prefers-reduced-motion/contrast
✅ Test Node 57/57 (5 files) · Deploy clasp (chỉ clasp deploy — không PUT deployments)
```

**Rủi ro đã chấp nhận (biết rõ, cố tình bỏ qua):**
- `transitionToAttend` / `completeTask` / `reopenTask` **KHÔNG gate role** — non-owner tự chuyển Mở→Điểm danh được (A2). Muốn chặt sau: gate transition = 1 dòng.
- Task legacy `createdBy='web'` không xác định owner → fail-open (A1).

### Post-MVP (chưa làm — KHÔNG nằm trong code hiện tại)

```plain
⏳ Đồng bộ HR tự động (Phase 2: trigger từ Drive/URL thay vì syncFromCsv tay)
⏳ Dashboard thống kê real-time
⏳ Index/log tối ưu khi AttendanceLog lớn (hiện đọc full sheet mỗi task detail/list)
⏳ Gate role cho transitionToAttend/complete/reopen (A2 — 1 dòng)
⏳ PWA / offline thực sự
```
