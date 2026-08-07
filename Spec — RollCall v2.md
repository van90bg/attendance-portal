# Spec — RollCall v2: Hệ thống Điểm danh Đối chiếu Nhân viên Kho

> **Version:** 2.1.0 | **Status:** Final | **Cập nhật:** 2026-08-04
>
> **Ghi chú viết lại:** Spec này được viết lại **hoàn toàn theo codebase thực tế**.
> Bản 2.0.0 (2026-07-31) mô tả nhiều tính năng **không tồn tại trong code** và đã bị loại bỏ khi viết lại (xem [§14](#14-thay-đổi-so-với-spec-200)).

---

## 1. Tổng quan

**Tên dự án:** RollCall v2 — Điểm danh kho (warehouse)
**Repo:** `van90bg/rollcall-kiosk-v2x` (private)
**Loại:** WebApp Google Apps Script (standalone) + Google Sheets

| Thuộc tính | Giá trị |
| :--------- | :------ |
| Đối tượng | Nhân viên kho (warehouse staff) |
| Mục đích | **Đối chiếu** danh sách NV làm việc theo tổ hợp Station / Ca (Slot Code) / Team bằng barcode |
| Thiết bị | PC/Laptop kiosk đặt tại kho, màn hình rộng; responsive tới mobile |
| Ngôn ngữ | Code/cột sheet: tiếng Anh · Giao diện web: tiếng Việt |
| Stack | GAS (V8) backend + Vanilla HTML/CSS/JS frontend (**không framework, không Bootstrap**) + Google Sheets + Node `node:test` + clasp |

**Luồng nghiệp vụ cốt lõi (1 vòng khép kín):**

```
Chọn tổ hợp (Station + Ca + Team + [Date]) → Tạo task → pre-fill AttendanceLog 1 lần
→ Quét barcode NV (1 lần = 1 NV) → Có mặt / Đã điểm danh / Dư
→ Kết thúc task → NV chưa quét gán Vắng → (tuỳ chọn) Mở lại task → quét tiếp
```

---

## 2. Kiến trúc

```
index.html (toàn bộ UI, 1 file)
    │  google.script.run (async, callback-based)
    ▼
Code.gs        — doGet (WebApp) + API endpoints + isEditor_() + syncFromCsv/setupSheets + debugState
TaskService.gs — nghiệp vụ task: createReconcileTask / completeTask / reopenTask / listTasks / getTaskDetail
ScanService.gs — nghiệp vụ quét: scanStaff (guard Ops + LockService + update/append + benchmark)
Database.gs    — truy cập GAS: SpreadsheetApp + CacheService (wrapper cache, batch read/write)
ScanLogic.gs   — logic THUẦN phân loại quét + counters (KHÔNG gọi GAS API → test Node được)
CsvUtil.gs     — logic THUẦN parse/normalize CSV + lọc/dedupe/distinct + isValidBarcodeId
Config.gs      — mọi hằng số: sheet names, cột, trạng thái, cache keys/TTL, UI labels
```

**Nguyên tắc kiến trúc:**

- **Tách logic thuần khỏi GAS API**: `ScanLogic.gs` + `CsvUtil.gs` không gọi `SpreadsheetApp`/`CacheService`/`Session` — chạy được trên Node (`node --test`). Các wrapper (`Database`/`ScanService`/`TaskService`/`Code`) mỏng, chỉ lo GAS side-effects.
- **Batch read/write**: `getValues()`/`setValues()` theo khối; không `getValue()`/`setValue()`/`appendRow()` trong loop.
- **Hằng số tập trung tại `Config.gs`** — không hardcode rải rác; client mirror `STATUS_C`/`TASK_STATUS_C` trong `index.html` (1 nguồn mỗi phía).

---

## 3. Dữ liệu — Google Sheets (4 sheets)

Spreadsheet: `1NQQnLnVDITrUIII59ibk6vVfuDnMHKqsDtfGmHgjNYo` (Config `DEFAULT_SPREADSHEET_ID`; nếu rỗng, Database tự tạo `RollCall v2 DB` khi chạy lần đầu).

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
| 2 | `taskType` | hiện chỉ `reconcile` |
| 3 | `station` | Station đã chọn (1) |
| 4 | `slotCode` | Ca đã chọn — multi-select nối `", "` để hiển thị |
| 5 | `team` | Team đã chọn — multi-select nối `", "` |
| 6 | `status` | `open` / `done` |
| 7 | `createdAt` | thời điểm tạo |
| 8 | `createdBy` | mặc định `'web'` |
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

Phase 0 chỉ có **1 loại duy nhất**: `reconcile` (đối chiếu) — `TASK_TYPE.RECONCILE`.

### 4.2 Task ID

```
R + yyyyMMdd-HHmm   →  R20260802-0730
```
- Đọc được, sắp xếp tự nhiên theo giờ tạo.
- Trùng taskId cùng phút → suffix số tăng dần `-2`, `-3`, … (không phải `-x-x`).

### 4.3 Trạng thái task (2 trạng thái — KHÔNG state machine 4 bước)

```
open  ⇄  done
```
| Status | Ý nghĩa |
| :----- | :------ |
| `open` | Đang quét được |
| `done` | Đã kết thúc — quét bị reject `task-closed` |

### 4.4 Tạo task (`createReconcileTask`)

1. Validate: đủ `station` (1) + `slotCode` (≥1) + `team` (≥1); thiếu → `{ok:false, message:'Thiếu station/slotCode/team'}`.
2. `filterStaffByGroup` trên StaffData: khớp station **và** slot (bất kỳ slot chọn) **và** team (bất kỳ team chọn) **và** date (tuỳ chọn).
3. `dedupeStaffByGroup`: **dedupe theo staffId trong cùng tổ hợp, giữ dòng đầu** (Att.csv thật có NV 2 dòng cùng ca → tránh phantom absent + row-key client lệch). Không dedupe toàn cục (NV nhiều ca hợp lệ phải giữ).
4. Tổ hợp rỗng → `{ok:false, message:'Không có nhân viên nào trong tổ hợp đã chọn'}`.
5. `insertTask_` (append 1 dòng) + `batchInsertLogRows_` — **pre-fill log 1 lần** (`timeRef=createdAt`, `status='-'`), batch `setValues` 1 lần (không appendRow trong loop).
6. Toàn bộ nằm trong `LockService.waitLock(10000)`.

### 4.5 Kết thúc task (`completeTask`)

- Guard: task phải `open`, nếu `done` → `'Task đã kết thúc'`.
- **Thứ tự fail-safe**: `markUnscannedAbsent_` TRƯỚC → `updateTaskStatus_(DONE, completedAt)` SAU.
  - `markUnscannedAbsent_`: `transformLogStatuses_` — batch ghi 1 lần cả cột status; dòng `timeScan` rỗng + status `-` → `Vắng`; dòng có `timeScan` nhưng status `-` (legacy/sửa tay) → **chuẩn hóa `Có mặt`** (không đánh Vắng).
  - Nếu mark fail (quota/timeout): task vẫn `open` → retry được. Nếu status-update fail: vẫn `open`, mark idempotent → retry an toàn.

### 4.6 Mở lại task (`reopenTask`)

- Guard: task phải `done`; `open` → `'Task đang mở — không cần mở lại'`.
- `resetAbsentToPending_`: ABSENT → PENDING (NV Có mặt giữ nguyên timeScan/status) — batch 1 lần, rồi `updateTaskStatus_(OPEN)`. Thứ tự fail-safe giống completeTask.

### 4.7 Đọc dữ liệu

- `listTasks()` → mới nhất lên đầu; merge counters (`total/scanned/extra`) từ AttendanceLog 1 lần + cache (`TASK_COUNTS` 30s) — không N+1.
- `getTaskDetail(taskId)` → `{ok, task, log, counters}` qua cache `TASK_DETAIL` 15s.

---

## 5. Mô hình quét (Scan)

### 5.1 Mã barcode

- **Chỉ chấp nhận prefix `Ops`** (case-insensitive): `isValidBarcodeId` = `/^ops/i`.
- Client check `/^ops/i` chạy **trước queue** (0ms, không gọi server); server có guard lại (chống bypass qua console).

### 5.2 Pipeline `scanStaff` (ScanService)

```
normalizeStaffId (trim + UPPERCASE)
  → isValidBarcodeId?  (sai format → reject 'Mã phải bắt đầu bằng "Ops"')
  → LockService.waitLock(10000)
  → readTask_ (không tồn tại → reject)
  → readLogRowsCached_ (cache 30s + incremental — không getDataRange full sheet mỗi scan)
  → classifyScan (ScanLogic — thuần)
  → update: updateLogRowScan_ (1 setValues: timeScan + status) + update cache incremental
  → append: buildExtraRow (lazy readStaffIndex_ — chỉ đọc khi NV lạ) + appendRow
  → computeCounters → return {ok, message, status, timeScanText, timeScanEpoch, staffName, counters}
  → finally: lock.releaseLock()
```

### 5.3 Phân loại quét (`classifyScan`)

| Điều kiện | Action | Status | Lý do reject |
| :-------- | :----- | :----- | :----------- |
| Task không `open` | `reject` | — | `task-closed` |
| `staffId` rỗng | `reject` | — | `empty-staff-id` |
| NV **trong log** + `timeScanEpoch > 0` | `reject` | — | `already-scanned` |
| NV **trong log** + chưa quét | `update` | `Có mặt` | — |
| NV **không trong log** | `append` | `Dư` | — (NV khác tổ hợp và NV không có trong StaffData **gộp chung EXTRA** — danh sách chốt là tham chiếu cố định) |

- **1 lần quét = 1 NV được điểm danh** — KHÔNG có check-in/check-out 2 lần quét.
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

- Script-level lock, `waitLock(10000)`, **release trong `finally`** — mọi luồng ghi: `createReconcileTask`, `completeTask`, `reopenTask`, `scanStaff`.
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
| `getTaskDetailApi(taskId)` | `{ ok, task, log[], counters }` |
| `scanStaffApi(taskId, staffId)` | `{ ok, message, status, timeScanText, timeScanEpoch, staffName, counters }` |
| `completeTaskApi(taskId)` | `{ ok, message }` |
| `reopenTaskApi(taskId)` | `{ ok, message }` |

> `google.script.run` **không trả `Date`** (serialize → null) → server trả text đã format; client check cả `xxx` + `xxxText`.

### 8.2 Debug URL (QA/verify — KHÔNG dùng production)

- `?debug=1` → JSON cấu trúc sheet + taskId + probe detail.
- `?debug=createTask&station=..&slotCode=..&team=..` → tạo task thật + trả detail (end-to-end không qua UI).

**Cả 2 đều gate editor-only** qua `isEditor_()` (fail-closed):
- So sánh `Session.getActiveUser().getEmail()` (người truy cập webapp — rỗng khi anonymous) với `Session.getEffectiveUser().getEmail()` (deployer, vì `executeAs: USER_DEPLOYING`).
- Chỉ deployer được chạy; exception → `false` (không fail-open). Dùng chung cho `debugState()`, `syncFromCsv()`, `setupSheets()` (kiosk anonymous gọi được qua console nếu không gate).

### 8.3 WebApp manifest

- `executeAs: USER_DEPLOYING`, `access: DOMAIN` — chỉ user @spxexpress.com (môi trường máy tính đăng nhập, không kiosk).
- `doGet` tự `ensureSheets_()` mỗi lần load (chỉ set header khi sheet trống — rẻ).

---

## 9. Giao diện & UX (`index.html` — 1 file, ~2200 dòng)

### 9.1 Hai view

**View 1 — Danh sách task (`#viewList`):**
- Header: logo SPX + title + net-dot/Online + 🔊 + ⟳ Làm mới + ⓘ.
- Card "ĐỐI CHIẾU DANH SÁCH": nút **+ Tạo task** (disabled khi chưa có station/slot/team trong StaffData).
- Card "DANH SÁCH TASK": bảng STT / Mã task / Station / Ca / Team / Tổng NV / Đã quét / Dư / Trạng thái / Tạo lúc / Người tạo / Thao tác.
  - Task `open` → nút **Quét**; task `done` → nút **Xem** + **Mở lại**.
  - Skeleton loading; empty state.

**View 2 — Màn quét (`#viewScan`):**
- **Scan topbar (sticky)**: `← Danh sách task` · tiêu đề `taskId` + meta (loại · station · ca · team · Đang mở/Đã kết thúc) · nút **Kết thúc** (danger).
- **Cột trái**: 3 counters (Đã quét / Chưa điểm danh / Dư) · ô quét to (laser-line animation khi focus) + nút Quét (chỉ mobile <992px) · **scan card projector** (ok/err/extra, stamp animation, nhìn từ 1–2m).
- **Cột phải**: bảng NV — toolbar tìm kiếm (mã/tên) + lọc trạng thái + ✕ xoá lọc; 9 cột sortable (mặc định Giờ quét mới nhất lên đầu, sort theo epoch); dòng Dư nền cam; keyed row-diff (chỉ update cell thay đổi — chống flicker).

### 9.2 Modal tạo task

- Station (select 1) · Ca Slot Code (**multiple**) · Team (**multiple**) · Date (optional, "Tất cả ngày").
- **Preview số NV khớp** (`previewStaffApi`, debounce 400ms) trước khi tạo.
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
- Responsive: ≤991px layout 2 cột về 1 cột; ≤600px header wrap + topbar hết sticky; ≥1280px phóng to cho kiosk touch.
- SWR client: task vừa xem <15s → render NGAY từ bộ nhớ + RPC nền silent (TTL khớp server TASK_DETAIL).

### 9.7 Mock local

- Mở `file://` trực tiếp (không có `google.script`) → tự nạp `mock/mock-google.js` (mock tự nạp khi không có `google.script.run`); verify UI bằng `scripts/cdp-helper.js`.

---

## 10. Testing

| Hạng mục | Giá trị |
| :------- | :------ |
| Runner | Node `node:test` (`npm test`) |
| Files | `tests/csv-normalize.test.js` + `tests/scan-classify.test.js` |
| **Kết quả** | **47/47 pass** |
| Mock | `mock/mock-google.js` |
| Fixture | `test-fixtures/Att.sample.csv` |
| Verify UI | `scripts/cdp-helper.js` (open/eval/shot) |

Nhóm test: `distinctValues` · `isValidBarcodeId` · `dedupeStaffByGroup` · `filterStaffByGroup` (multi-select) · `normalizeStaffDate_` (Date object + string) · `buildStaffIndex/buildStaffListFromValues` · `classifyScan` (task-closed / empty / update PRESENT / already-scanned / append EXTRA) · `findLogRow` (case-insensitive) · `computeCounters` · `buildExtraRow`.

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
- Client check mã Ops `/^ops/i` trước queue (0ms); server guard `isValidBarcodeId()` chống bypass.
- Modal pattern `.about-overlay` + dialog; `anyModalOpen()` cho Escape + focus trap + autofocus loop.
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
| Kiosk anonymous gọi `syncFromCsv`/`setupSheets`/`debug` | Gate `isEditor_()` fail-closed (chỉ deployer) |
| Sheet cũ thiếu cột `date` (migration) | `ensureSheets_` tự thêm cột + header nếu `getLastColumn() < 11` |

---

## 14. Thay đổi so với Spec 2.0.0

Bản 2.0.0 (2026-07-31) mô tả nhiều tính năng **không tồn tại trong code thực tế** — đã loại bỏ/đính chính:

| Mục | Spec 2.0.0 (cũ — ảo) | Thực tế (code) |
| :-- | :-------------------- | :------------- |
| Attendance | Check-in + Check-out (2 lần quét riêng) | **1 lần quét / NV** — Có mặt / Đã điểm danh / Dư / Vắng |
| Task state | 4 states `Created→CheckIn→CheckOut→Closed` + phase restriction | **2 states `open`/`done`**, không phase |
| Loại task | Handover + Attendance | Chỉ **`reconcile`** |
| Task ID | `T-YYYYMMDD-XXXX` (random 4 số) | `RYYYYMMDD-HHMM` (+ `-2` nếu trùng phút) |
| Offline mode | Queue localStorage 50–100, retry, flush on reconnect | **Không có** — queue client chỉ trong-bộ-nhớ, RPC fail = rollback |
| Paste batch | 100 items/chunk, retry | **Không có** |
| Phân quyền | Admin/User 2 cấp | Chỉ gate editor-only `isEditor_()` cho thao tác nguy hiểm (debug/sync/setup) |
| Frontend | Vanilla + **Bootstrap 5.3** | Vanilla thuần, **không Bootstrap** |
| Storage | localStorage + **IndexedDB** (24h) + SWR staggered | localStorage (âm thanh) + cache trong-bộ-nhớ (SWR 15s scan view); không IndexedDB |
| Sound | Base64 embedded | **Web Audio API** (beep 880Hz / buzz 200Hz) |
| Testing | Jest + Playwright, coverage >80% | **Node `node:test`**, 47/47, mock `mock-google.js` |
| Sheets | 3 sheets (`AttendanceData`/`Task`/`Log`) | **4 sheets** (Config, StaffData giữ header Att.csv 20 cột, AttendanceTask 9 cột, AttendanceLog 11 cột) |
| Log | Batch flush 10 records/20s, append-only | Pre-fill 1 lần + **update-in-place** + cache log rows 30s |
| Audit log | Sheet riêng, 3 actions, vĩnh viễn | **Không có** (Phase 0 không cần) |
| Cooldown 15s | Có | **Không có** (chỉ chặn duplicate scan) |
| URL deep-linking / bottom nav / phase switch button | Có | **Không có** |
| Pipeline 5 bước | Validate→Cooldown→Find→Execute→Flush | `classifyScan` 3 nhánh (update/append/reject) + LockService |

---

## 15. Scope & lộ trình

### Đã hoàn thành (MVP — khớp code)

```plain
✅ Tạo task đối chiếu theo tổ hợp Station / Ca (Slot Code, multi) / Team (multi) / Date (optional)
✅ Preview số NV khớp trước khi tạo
✅ Pre-fill AttendanceLog 1 lần (dedupe staffId giữ dòng đầu)
✅ Quét barcode Ops (case-insensitive): Có mặt / Đã điểm danh / Dư / Task đã kết thúc
✅ Kết thúc task → NV chưa quét gán Vắng (batch 1 lần); Mở lại task → reset Vắng về Chưa điểm danh
✅ Counters tức thì (optimistic + queue nền + rollback)
✅ Scan card projector + toast + Web Audio (beep/buzz) + toggle âm thanh
✅ Bảng NV: tìm kiếm, lọc trạng thái, sort 9 cột (sort/đếm theo epoch)
✅ Cache versioned (7 keys) + LockService + batch read/write
✅ Gate editor-only cho debug/sync/setup (fail-closed)
✅ A11y: skip-link, focus trap, aria-live, prefers-reduced-motion/contrast
✅ Test Node 47/47 · Deploy clasp (chỉ clasp deploy — không PUT deployments)
```

### Post-MVP (chưa làm — KHÔNG nằm trong code hiện tại)

```plain
⏳ Đồng bộ HR tự động (Phase 2: trigger từ Drive/URL thay vì syncFromCsv tay)
⏳ Dashboard thống kê real-time
⏳ Index/log tối ưu khi AttendanceLog lớn (hiện đọc full sheet mỗi task detail/list)
⏳ Nhiều loại task ngoài reconcile
⏳ PWA / offline thực sự
```
