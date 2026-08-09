# Audit Report — RollCall v2 (GAS WebApp)

> **Ngày:** 2026-08-07
> **Loại:** Full-base audit (không git diff — đọc toàn bộ mã nguồn)
> **Skill:** `gas-apps-script-webapp-review` (stage-based review + failure-mode checklist)
> **Baseline:** `npm test` → **47/47 pass** ✅ (4 test files, zero fail)
> **Phương pháp:** Review 2 lớp — host review + pass đánh giá độc lập (independent reviewer)

---

## Tổng quan hệ thống

| Thành phần | Công nghệ |
| :--------- | :-------- |
| Frontend | Vanilla HTML/CSS/JS — `index.html` (~2.700 dòng, 1 file) |
| Backend | Google Apps Script V8 — `Code.gs` · `Config.gs` · `Database.gs` · `ScanLogic.gs` · `ScanService.gs` · `TaskService.gs` · `CsvUtil.gs` |
| Database | Google Sheets (4 sheets: Config / StaffData / AttendanceTask / AttendanceLog) |
| Manifest | `executeAs: USER_DEPLOYING` · `access: DOMAIN` (chỉ user @spxexpress.com) |
| Test | Node `node:test` — 47 tests |

**Kiến trúc:** Logic thuần (CsvUtil/ScanLogic) tách khỏi GAS API để test Node; wrapper (Database/ScanService/TaskService/Code) lo GAS side-effects. Cache version-key + LockService trên mọi đường ghi.

---

## 1. Requirements — Spec so với hiện thực

| Yêu cầu (Spec v2.1.0) | Hiện thực (code) | Kết luận |
| :-- | :-- | :-- |
| State máy 2 trạng thái `open ⇄ done` (§4.3) | Code có **3 trạng thái** `open/attend/done` (2-phase attendance: `transitionToAttend`, `reopenTask`) | 🔶 **Doc stale** — Spec viết trước khi triển khai 2-phase |
| `access: ANYONE_ANONYMOUS` (§8.3, README) | Manifest thật: **`access: DOMAIN`** (git log xác nhận đổi có chủ đích) | 🔶 **Doc stale** — kiosk giờ yêu cầu đăng nhập @domain |
| `isEditor_` so active vs effective (§8.2) | Code so active vs **`DEPLOYER_EMAIL`** (Script Properties, fail-closed) | ✅ Code đúng — cơ chế cũ trong Spec lỗi thời |
| `getMeta()` → `{ok, appTitle}` (§8.1); header comment nói `{appTitle, labels, tableHeaders}` | Thực tế `{ok, appTitle, userEmail}` | 🔶 Comment + Spec stale (Nit) |
| `getFilterOptions()` → `{stations[], slotCodes[]…}` (§8.1) | Thực tế trả **`stationGroups`** (cây 4 cột checkbox) | 🔶 Doc stale (Nit) |

**Scope creep:** không phát hiện tính năng thừa. Các nhánh `noList` (Quét tự do) và 2-phase là mở rộng có thiết kế rõ ràng.

---

## 2. Correctness

### 🔴 MAJOR (điều kiện — dữ liệu cũ/sửa tay) — Parse Date không guard → vỡ màn chi tiết task

- **Vị trí:** `Database.gs` — `logFromRow_()` (gọi `formatTime_(timeRef)` + `timeRef.getTime()`), `taskFromRow_()` (gọi `formatDateTime_(createdAt)`).
- **Vấn đề:** Các lời gọi này nằm trong `cachedJson_`'s `load()` **không try/catch**. `Utilities.formatDate` / `.getTime()` **throw** khi cell là string. Bản thân codebase thừa nhận dữ liệu cũ có string date ("Mon Aug 03 2026…GMT+0700" trong comment `normalizeStaffDate_`).
- **Tác động:** Một cell không phải Date trong `timeRef/timeScan/createdAt` → toàn bộ `getTaskDetailApi` fail → màn quét của task đó bị **bricked** (lỗi mỗi lần load, không recovery; negative-cache không kịp ghi).
- **Fix đề xuất:** helper `safeDate_()` (try/catch → `''`/`0`) cho mọi cell thời gian, hoặc wrap từng extraction.

### 🟡 MINOR — Nhánh race bỏ ghi khi row hiện hữu thiếu thời gian

- **Vị trí:** `ScanService.gs` — branch `existing` trong `scanStaff`.
- **Vấn đề:** Khi re-check tìm thấy `existing` nhưng `existing.timeScanEpoch === 0` (kiosk A mới ghi timeRef ở phase1; kiosk B đang phase2), B trả `formatTime_(now)` **nhưng không ghi vào sheet**.
- **Tác động:** Client B hiển thị "Giờ quét" rồi revert khi reload → lượt quét phase2 hợp lệ bị rơi, NV phải quét lại.
- **Fix:** trong nhánh `existing`, nếu field cần còn trống → vẫn gọi `updateLogRowScan_`/`updateLogRowRef_` thay vì bỏ qua ghi.

### 🟡 MINOR — SWR reload nền race với optimistic scan đang bay

- **Vị trí:** `index.html` — `openScan` SWR path + `loadTaskDetail(taskId, true)` (silent).
- **Vấn đề:** Nếu user quét trước khi RPC silent trả về, success handler `renderScanView(res)` **thay thế `CURRENT_LOG` bằng array mới** → `item.target` trong `processScanQueue` trỏ vào object cũ → dòng vừa quét "biến mất" đến lần refresh sau.
- **Tác động:** Chỉ UI transient; server an toàn.
- **Fix:** gate silent reload sau `!scanBusy()`, hoặc merge thay vì replace.

### 🟡 MINOR — Counter list không invalidate khi quét

- **Vị trí:** `Database.gs` — `taskCountersForList_` (`rc2_taskCounts_v1_all`, TTL 30s); `scanStaff` không gọi `invalidateTaskListCache_`.
- **Tác động:** Cột Đã quét/Dư trong danh sách task **lag tới 30s** sau mỗi lượt quét (chỉ ảnh hưởng hiển thị).

### 🟡 MINOR — Migration `ensureSheets_` đặt sai header khi thiếu ≥2 cột

- **Vị trí:** `Database.gs` — vòng `while (getLastColumn() < LOG_COL_COUNT)`.
- **Vấn đề:** Sheet cũ 9 cột → cả 2 cột mới đều được đặt header `'date'` (cột status bị đặt nhầm). Sheet 10 cột (trường hợp thường gặp) thì đúng.
- **Fix:** map header còn thiếu tường minh (`['status','date'].slice(...)`).

### 🟡 MINOR — `console.log` benchmark mỗi lượt quét (Stackdriver quota)

- **Vị trí:** `ScanService.gs` — `scanStaff` log benchmark mỗi lượt thành công + mỗi reject format.
- **Tác động:** ~1400 log/giờ/tab ở nhịp kiosk → tốn Stackdriver quota/chi phí.
- **Fix:** sample (log khi `readMs`/`writeMs` vượt ngưỡng) thay vì log mọi lượt.

---

## 3. Code quality

**Tốt:**
- Hằng số tập trung tại `Config.gs` — không hardcode rải rác; client mirror `STATUS_C`/`TASK_STATUS_C`.
- Tách logic thuần (CsvUtil/ScanLogic) khỏi GAS API → test Node được.
- Cache version-key (`rc2_*_vN`); batch read/write; comment ghi rõ lý do + bài học v1.

**Nit:**
- Comment trong `classifyScan` nhánh FREE bị lỗi văn bản ("quét NVavtrong danh sách = đánh giá x.s.") — khó đọc.
- Thụt lề lệch trong `classifyScan` (nhánh row-not-found cùng cấp với if/else).
- `updateTaskStatus_`/`updateLogRowRef_` dùng 3 lần `setValue` rời — chấp nhận được (tần suất thấp, 1 dòng) nhưng có thể gộp `setValues`.
- `getMeta()` comment header không khớp payload thật.
- `mock/mock-google.js` trả `labels`/`tableHeaders` mà server thật không trả — chỉ mock drift, client không dùng.

---

## 4. Testing

| Hạng mục | Kết quả |
| :-- | :-- |
| Runner | Node `node:test`, 4 files, **47/47 pass** |
| Logic thuần | CsvUtil (parse/filter/dedupe/date) + ScanLogic (classify/counters) — **phủ tốt** |
| ScanService | Integration qua `vm` mock — phủ nhánh append/update/reject, FREE vs RECONCILE |
| **Lỗ hổng** | Không test: `Database.gs` (invalidation, `transformLogStatuses_`, migration `ensureSheets_`), `TaskService` (create/complete/reopen state machine), `Code.gs` (`isEditor_` fail-closed, debug gate), client JS (queue/rollback/optimistic) |

**Khuyến nghị:** thêm test cho MAJOR + MINOR #2 (string-date cell, race append), và test migration `ensureSheets_` với sheet 9 cột.

---

## 5. Security & performance

### Security
- **`executeAs: USER_DEPLOYING` + `access: DOMAIN`:** mọi mutator (`createReconcileTaskApi`, `completeTaskApi`, `reopenTaskApi`, `transitionToAttendApi`, `scanStaffApi`) mở cho **mọi user @domain** — đúng thiết kế (luồng vận hành kiosk), nhưng là **rủi ro chấp nhận**: user domain có thể spam tạo task, hoàn tất/mở lại task bất kỳ, chèn EXTRA tùy ý; nhận toàn bộ roster nhân sự (tên + mã + station) qua `warmStaffCacheApi`/`stationGroups`. Không có leo quyền tới hàm editor-gated.
- **`isEditor_` fail-closed** ✅ (so `Session.getActiveUser().getEmail()` vs `DEPLOYER_EMAIL` Script Property; exception → `false`). Gate cho `debug=1`/`debug=createTask`/`syncFromCsv`/`setupSheets`.
- **XSS:** mọi `innerHTML` đều qua `esc()`/`escAttr()` (scan card, meta, task list) ✅.
- Không hardcode secret/spreadsheet ID trong code (`DEFAULT_SPREADSHEET_ID = ''` → Script Properties) ✅.

### Performance
- Log rows cache **slim + incremental** — scan liên tiếp không chạm sheet ✅.
- `getTimeZone_` memo theo invocation (cắt 1000-2000 cache GET) ✅.
- `readTaskList_` merge counters 1 lần — không N+1 ✅.
- `previewStaffCountsApi` O(options × staffList) — chấp nhận được với kích thước hiện tại.
- 🟡 Benchmark `console.log` mỗi scan (xem §2).

---

## 6. Đã verify sạch (không có vấn đề)

- **Lock:** không deadlock (1 lock, không lồng, release trong `finally`); `waitLock` throw → TaskService propagate lên failure handler (không nuốt lỗi âm thầm); release trên lock chưa giữ là harmless.
- **Cache RMW race:** `updateLogRowCache_`/`pushLogRowToCache_` đều chạy trong lock → không mất ghi đồng thời.
- **Thứ tự flush:** `invalidateLogRows_` sau `setValues` thành công ✅; `appendLogRow_` set `_rowIndex` từ `getLastRow()` thật (không suy từ cache).
- **Thứ tự completeTask/reopenTask** fail-safe (mark/reset trước, status sau), idempotent ✅.
- **`transformLogStatuses_`:** bỏ header, batch 1 lần ✅.
- **Rollback client:** splice theo index (không pop), restore status+time đúng phase ✅.
- **Empty input guard:** `if (!staffId) return` sau trim ✅.
- **Cooldown:** vắng mặt **có chủ đích** — server là nguồn sự thật duy nhất (reject duplicate) ✅.
- **A11y cơ bản:** `th scope="col"`, `aria-sort` sort headers, `aria-live` trên scan card/toast, `prefers-reduced-motion`/`prefers-contrast` ✅. (Nit: `#loadingOverlay` là overlay tĩnh nhưng vẫn khai báo `aria-live` — xem §8.)

---

## 7. Tổng hợp & VERDICT

### Tóm tắt findings

| # | Severity | Finding | Vị trí |
| :- | :-- | :-- | :-- |
| 1 | 🔴 **Major** (điều kiện) | Parse Date không guard → vỡ `getTaskDetail` nếu cell là string | `Database.gs` |
| 2 | 🟡 Minor | Race append bỏ ghi khi row hiện hữu thiếu thời gian | `ScanService.gs` |
| 3 | 🟡 Minor | SWR silent reload race với optimistic scan | `index.html` |
| 4 | 🟡 Minor | Counter list không invalidate khi quét (lag 30s) | `Database.gs` |
| 5 | 🟡 Minor | Migration `ensureSheets_` sai header khi thiếu ≥2 cột | `Database.gs` |
| 6 | 🟡 Minor | Benchmark `console.log` mỗi scan → Stackdriver quota | `ScanService.gs` |
| 7 | 🔶 Nit | Spec/README stale (DOMAIN, 3-state, `stationGroups`, `userEmail`) | `Spec — RollCall v2.md`, `README.md` |
| 8 | 🔶 Nit | Comment hỏng/indent lệch trong `classifyScan`; comment `getMeta` stale | `ScanLogic.gs`, `Code.gs` |

### VERDICT: **Comment** (không có Blocker)

Không có **Blocker**. Có **1 Major có điều kiện** (dữ liệu cũ/string-date → vỡ màn chi tiết) + **5 Minor** + vài Nit. Mọi đường ghi đều được Lock + batch an toàn; kiến trúc, cache invalidation, và bảo mật gốc đều vững.

> ⚠️ Nếu sheet production **có** cell thời gian dạng string (khả năng cao với dữ liệu legacy), Major #1 thành lỗi sống — **nên ưu tiên sửa trước khi deploy tiếp**.

### Thứ tự ưu tiên sửa

1. 🔴 `safeDate_()` guard parse Date (`Database.gs` `logFromRow_`/`taskFromRow_`)
2. 🟡 Race append: ghi thời gian vào row hiện hữu thay vì bỏ qua (`ScanService.gs`)
3. 🟡 Gate silent reload sau `!scanBusy()` (`index.html`)
4. 🟡 Invalidate `TASK_COUNTS` khi scan + migration header tường minh (`Database.gs`)
5. 📄 Cập nhật README/Spec (DOMAIN, 3-state, `stationGroups`, `userEmail`)

---

## 8. Phụ lục — Failure-mode checklist (đã check)

| Failure mode | Trạng thái |
| :-- | :-- |
| `getUserRole()` fail-open | N/A — không có role system |
| Lock helper nuốt lỗi timeout | ✅ Không — throw propagate |
| `genTaskId()` collision | ✅ Suffix số tăng dần + `readTask_` check trong lock |
| Client cooldown bypass | ✅ Không có cooldown — server reject duplicate |
| Batch cache metadata race | ✅ RMW trong lock |
| Offline sync mất item | N/A — không có offline queue bền |
| `getLogTail` header row | N/A — không có tail-read |
| `_ensureSS()` cache null module-scope | ✅ Dùng getter, không cache ở module |
| Task metadata helpers đọc sheet mỗi call | ✅ Cache log rows 30s + incremental |
| Pending-batch flush ordering | ✅ Invalidate sau `setValues` |
| Reset task trong lúc scan batch | ✅ `scanBusy()` chặn client; server lock |
| Cache invalidation chỉ 2 date key | ✅ Version-key pattern |
| Role-mutating API không invalidate | N/A — không có role API |
| Client timestamp trong write path | ✅ Server dùng `new Date()` |
| Deep link không check tồn tại | N/A — không có hash routing |
| Filter dropdown position trước render | N/A — layout chuẩn flex |
| `prefers-reduced-motion` | ✅ Đã có |
| `aria-live` trên static elements | 🔶 Nit — `#loadingOverlay` có `aria-live` (static) |
| Duplicate element IDs | ✅ Không phát hiện |
| Cooldown client/server lệch | N/A — không có cooldown |
| Empty input không guard | ✅ `if (!staffId) return` |
| `appendRow` lệch header | ✅ Đếm cột khớp (TASK_COL_COUNT/LOG_COL_COUNT) |
| Sheet counter drift | N/A — counter tính từ log |
| Signature mismatch call site | ✅ Cross-check mọi API client↔server |
| Fallback path không sync cache | ✅ Cả 2 path đều invalidate/update cache |
| `indexOf` -1 → undefined | ✅ Guard `toFilterArray_` + check trước |
| Batch flush lỗi xóa cache | ✅ Giữ batch cho retry |
| Normalize field server-side | ✅ `normalizeStaffId`/`normalizeStaffDate_` ở server |
| `_rebuildAttendanceIndex` thiếu pending | N/A — không có index như vậy |
| Unified cache invalidation | ✅ `invalidateTaskDetailCache_` mọi đường ghi (trừ #4 counters list) |
| Client flush gate thiếu | ✅ Queue + `SCAN_PROCESSING` gate |
| `Object.keys()` hot loop | N/A — không ở hot path |
| `executeAs` cần role gate mọi mutator | 🔶 Rủi ro chấp nhận (thiết kế) — xem §5 |
| Optimistic count bị server overwrite | ✅ `syncCounters` ưu tiên server khi hết queue |
| Deferred server create | N/A — không có local-only resource |
| Button jump phase transition | 🔶 Nit — dùng `style.display` thay `disabled`+opacity |
