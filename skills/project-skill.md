# Project Skill — Attendance Portal (RollCall v2)

> Bản skill đóng gói đầy đủ cho AI agent làm việc trong repo `RollCall_2_deploy` (GitHub: `van90bg/rollcall-kiosk-v2x`).
> Dùng khi: bất kỳ edit nào với repo này (UI, server, tests, docs).
> Nguồn: skill Hermes `rollcall-kiosk`. Nếu mâu thuẫn, Hermes skill là nguồn mới nhất.
> References: xem `skills/references/` — `architecture-gotchas.md`, `deterministic-batch-runner.md`, `slot-fueled-classification.md`.

## 1. Repo facts

- Local: `C:\Users\Van90BG\Documents\AppScript\RollCall_2_deploy` · Remote `main` (CI self-clasp).
- **User rule: agent commit+push GitHub — KHÔNG tự clasp push/deploy.** CI deploy trễ → luôn check SHA thật trước khi kết luận bug (`gh run list --limit 5`, đối chiếu `.head_sha`).
- Test: `npm run test` = 98 tests (node:test — pure logic ScanLogic.gs/CsvUtil.gs + smoke test `tests/all-gs-load.test.js`/`tests/settings-service.test.js` load toàn bộ .gs với mock GAS dùng chung `tests/gas-sandbox.js`).
- File chính: `index.html` (toàn bộ UI, ~198KB, UTF-8 + **CRLF**). Server: Code/Config/CsvUtil/Spreadsheet/Cache/StaffDataRepo/TaskRepo/LogRepo/ScanLogic/ScanService/TaskService/Auth/Debug/SettingsService `.gs` (Database.gs đã tách 2026-08-11).

## 2. Shell: Attendance Portal (2026-08-09)

App scope mở rộng: quản lý chấm công, không chỉ điểm danh. Layout: `<header>` (controls: userEmail · net-dot · 🔊 · ⟳ — ĐÃ BỎ 📋/ⓘ) > `.app-shell` (flex) = `#sidebar` (240↔48px, icon SVG đơn sắc currentColor, KHÔNG side-head, nút thu gọn `☰`) + `#main-content`.

Router: `selectPage(page)` + `PAGE_VIEWS = { home:'viewHome', stats:'viewStats', attendance:'viewList', data:'viewStaff', about:'aboutView' }`. `initSidebar()` + `selectPage('home')` trong DOMContentLoaded. ⚠️ `showSection` ẩn **danh sách cố định** — thêm view mới phải thêm vào đó.

- viewHome: hero logo local (`sea-logo.svg`/`spx-express.svg`) + tên + đồng hồ realtime (`renderHomeClock`, Intl Asia/Ho_Chi_Minh).
- viewStats: pivot fullscreen (tabs Team×Ca · BPO · OS + station filter `#statsStation`). viewStaff (page key `data`): bảng StaffData fullscreen (search+count).
- View mới phải vào mảng `repairViewParents()` — `['viewHome','viewStats','viewStaff','aboutView','viewScan','viewList']`.

## 3. Architecture mental model (đọc TRƯỚC mọi fix)

- **Task 2-phase**: `task.status` = `open` (ghi Giờ có mặt / timeRef) → `attend` (ghi Giờ quét / timeScan) → `done`.
- `logRow.status`: `PENDING`(-/Chưa điểm danh) · `PRESENT`(Có mặt) · `ABSENT`(Vắng) · `EXTRA`(Dư).
- **Epoch là nguồn sự thật** cho counters/sort: `timeRefEpoch`/`timeScanEpoch` (text `HH:mm:ss` mất ngày qua đêm). `computeCounters` đếm theo epoch.
- `classifyScan(cfg,task,logRows,staffId)` → `{action:update|append|reject, phase, field, status}`.
- Layers: `scanStaffApi`(Code) → `scanStaff`(ScanService) → `classifyScan`(ScanLogic) + `appendLogRow_`/`updateLogRowScan_`(Database). LockService + try/catch — không throw client, trả `ok:false`.
- `reopenTask` → ATTEND (KHÔNG quay OPEN); client recompute phase từ `task.status`.
- ROSTER reconcile → created với `status: ATTEND` (pre-fill log); FREE (noList) → `status:OPEN`.
- **NO LIST phase2 rule**: NV lạ scanned trong phase2 → **EXTRA (Dư)**, KHÔNG phải PRESENT. Client `optimistic status` phải mirror server (`target.status === EXTRA ? EXTRA : PRESENT`).

## 4. Recurring gotchas (đã fix — đừng regress)

1. **buildExtraRow status param**: tham số `status` tồn tại vì từng hardcode EXTRA. Nếu "mọi quét tự do hiện Dư" → check `scanStaff` set `extraRow.status = result.status || EXTRA` (noList phase1 cần PENDING override).

2. **staffIndex lazy cache**: `scanStaff` đọc `readStaffIndex_()` lazy + cache 5 phút → lần quét đầu sau cold cache mất tên. Fix: `warmStaffCacheApi()` preload khi mở app + sau tạo FREE task. ⚠️ **Slim index (P1-2)**: client payload chỉ `{staffId, staffName, slotCode, station, team, workstation}` — đã strip agency/cardIn/cardOut/date. Khi thêm cột client cần các field này → phải thêm lại vào slim object, KHÔNG tin "client không cần".

3. **warmStaffCacheApi trả OBJECT index**: `index[string]` = object `{staffName,...}` KHÔNG phải string — đọc `rec.staffName`, nếu gán thẳng vào `staffName` sẽ hiển `[object Object]`. Key đã `normalizeStaffId()` uppercase → client `toUpperCase()`.

4. **Optimistic status mirror server**: re-scan EXTRA giữ EXTRA (chỉ PENDING→PRESENT). Client never hardcode `PRESENT` cho bất kỳ target nào (flash "Có mặt" 2-3s rồi server flip "Dư").

5. **Spinner success handler**: mọi `google.script.run` success handler bắt buộc `hideLoadingOverlay()` (dispatch cả hideModalSpin) CẢ success lẫn failure — nếu chỉ ẩn trong failure → spinner không bao giờ tắt.

6. **Toast `-` (PENDING)**: không bao giờ show raw `-`; thay bằng human label `'Chưa điểm danh'`.

7. **Topbar live-button states (2026-08-08)**: order `←Danh sách | title | Dán danh sách mã | Chuyển điểm danh | Kết thúc`. `updateFinishBtnState()` disable **cả `btnToAttend`** như `btnFinish` khi `scanBusy()` (disabled + busy tooltip, restore bởi `processScanQueue`).

8. **Paste modal auto-closes success**: `submitPaste` success → toast aggregate → `closePasteModal()` SAU `loadTaskDetail(silent)+renderCounters`.

9. **Duplicate toasts scan**: keep server-confirm toast là single source, bỏ toast optimistic (reduce noise).

## 5. UI labels & modal (2026-08-07/08)

- Counter OPEN phase label "Chờ có mặt" (KHÔNG "Chờ điểm danh"). Chain: OPEN → Chờ có mặt → ATTEND → Chưa điểm danh → DONE → Vắng.
- Table headers Vietnamese: Ngày · Mã NV · Tên NV · Ca · Team · Giờ có mặt · Giờ quét · Trạng thái. (StaffData table riêng — xem §9.)
- FREE description: "Quét lần 1 lấy danh sách, lần 2 điểm danh; NV lần 2 chưa có lần 1 → Dư."
- Task type badge: FREE → 'Quét tự do' (purple), RECONCILE → 'Đối chiếu' (blue). List order: STT, Mã task, Loại, Station, Team, Ca, Tổng NV, Đã quét, Dư, Trạng thái, Tạo lúc, Người tạo, Thao tác.
- Modal: với đổi màn tạo task → MUST làm HTML mockup trước (`sketches/00X`), user duyệt, mới implement (luật user — strict).
- Slot-based: FREE sends `slotCode:['Tự do']` thay `noList:true` (magic value `'Tự do'`, mutually exclusive với real slots; FREE hide Hình thức + disable Ngày). `classifyScan`/`pasteCodes` đọc `taskType` từ sheet — KHÔNG đổi.

## 6. Scan table column/sort coupling — PITFALL (2026-08-08: 11 col, Mã NV added)

`#scanTable` headers mang `data-sort="N"`; `filterAndSortScan()` map `col → field` **positionally**. Đổi cột phải sync LOCKSTEP 5 chỗ: ① `<th data-sort>` ② `scanRowCells` array (STT, staffId, staffName, agency, station, team, slotCode, dateText, timeRef, timeScan, badge = **11 cells**) ③ `filterAndSortScan` col branches ④ `phaseCol`/`SCAN_SORT.col`/`updateSortIndicators` effectiveCol ⑤ skeleton-cell count trong skeleton-row. Default phase sort positional: `phaseCol = phase===ATTEND ? 8 : 7`.

## 7. GAS batch/perf & cache (audit M1/M2, FIXED 2026-08-08 — đừng regress)

- **Batch-mutation helpers gọi 1 lần, không per-row**: `collect updateBatch[]` → `batchUpdateLogRows_(taskId, updateBatch)` MỘT lần (sort, group runs, setValues mỗi run 3 cột timeRef/timeScan/status, 1 invalidate + 1 cache get/put). Helpers có cache calls ≈ 6/lần — per-row = ~900 calls/spam timeout.
- `planBatchScans` mô phỏng CẢ append LẪN update trong paste duplicate (edit simulated row cho occurrence tiếp) — không thì dedup sai + ghi 2 lần.
- **Slim trước khi cache task detail**: map log rows `logRow` text+epoch-only trước `JSON.stringify`; payload ≤ ~90KB (CacheService limit 100KB/key); CacheService put throw bị nuốt + console.warn → cache miss silent. Never trust silent-worried put.
- **`transformLogStatuses_` chỉ ghi range task**: track `firstRow`/`lastRow`, `getRange(firstRow, statusCol, len, 1)` — không `getRange(2, statusCol, values.length-1, 1)` (O(cả que) 50K rows = huge idempotent write).
- **Null-check `task` trước deref** (readTask_ null khi id thiếu): paste & scan trả `ok:false,'Không tìm thấy task'`.
- **`Array.isArray(rawLines)` guard** paste payload (string payload = slice-by-char).
- **REJECT reason `already-present`** (phase1 dup): map `'Đã có mặt'` — đừng rơi về STAFF_NOT_FOUND.
- **`getSpreadsheet_` KHÔNG tự tạo DB**: Config `ALLOW_DB_AUTO_CREATE=false` → throw `'Chưa cấu hình spreadsheet…'` (fail loudly, đừng phân mảnh).
- StaffData header: cấu hình 20 cột tên đúng CSV (bao gồm `'No.'` — không `'No'`) — `STAFF_DATA_HEADER` trong Config; `ensureSheets_` set header chỉ khi empty.

## 8. Deterministic editing (bắt buộc trên index.html)

- Fuzzy patch BANNED; sed/echo trong bash làm hỏng VN+CRLF -> dùng script Python/Node deterministic (xem `skills/references/deterministic-batch-runner.md` + `scripts` pattern).
- Python pattern: read/write with `newline=''`, `encoding='utf-8-sig'`, anchor literal `\r\n`; mọi replace `assert count==1`.
- Khối lớn: block new sang `.txt` tạm rồi ghép bằng index (tránh tool-call >8K token).
- Sau mọi edit: verify `CRLF` (`data.replace(b'\r\n',b'\n').replace(b'\n',b'\r\n')` if LF-only>0) + JS parse `new Function` + CSS balance (`{}`=0).
- **Parse trước write** — assert fail → DỪNG, không ghi (giữ file nguyên). Multi-module: gom reps theo file → apply → parse → write LAST (write-last-wins pitfall).
- Template-literal escape: `\'` trong backtick render `'` → hỏng; dùng `\\'` hoặc `addEventListener` thay inline onclick.
- Helper patch ghi bool return — `if (!app(...)) process.exit(1)` guard chạy EARLY nếu helper không return true.

## 9. StaffData table = sheet column names + Clock format (2026-08-09)

`STAFF_TABLE_HEAD` = 20 sheet tên: `['No.','Date','Staff ID','Staff Name','Staff Email','Agency','Contract Type','Event ID','Matching Type','Gender','Department','Clock In Time','Clock Out Time','Actual Hours','Clock In Remark','Clock Out Remark','Slot Code','Workstation','Team','Station']`. Render order khớp header 1:1; `No.` = `r.no || (i+1)`; Clock columns: `fmtClockHMS(r.cardIn)`/`(r.cardOut)` → `H:mm:ss` (giờ không pad: 7:05:30; mock '20:15' → '20:15:00').

## App title sync (2026-08-09)

Đổi tên app phải đổi CẢ 4 chỗ: ① `<title>` ② brand span `#brandTitle` ③ `Config.gs UI_LABELS.APP_TITLE` ④ `mock/mock-google.js` BOTH `meta.appTitle` + `labels.APP_TITLE`. CDP-check document.title + brandTitle.textContent.

## About page + README sync

- `#aboutView`: content Portal-oriented (5 mục), back → `selectPage('home')`.
- README giữ sync (test counts, sidebar, app). Update cùng commit UI change.

## Pitfall checklist (2026-08-09)

- `.hidden { display:none !important }` — thắng ID rule (chồng view).
- `--header-h: 59px` đo thật (53 → scroll 6px).
- `taskListTable` KHÔNG trong `#taskSkeleton` — parent chain check (`table.parentElement.id === 'taskSkeleton'` → table height 0).
- Card stretch tạo trắng — card auto height; `.table-wrap` scroll `max-height: calc(100vh - 320px)`.
- Scan layout chuẩn `.scan-layout > .scan-col-left(480)+.scan-col-right` — card bảng phải trong col-right (2026-08-09 fixed rớt chân).
- **Duplicate id sau split**: `statsStation` vs `statsStation2` — grep ids + label for.
- Role gate phase OPEN: `permission` tươi từ `getTaskDetail` (không nhét cache); `applyScanPermission()` chạy CUỐI `renderScanView` + `scanOwnerLocked` cờ — nguồn quyết định disabled/placeholder/ẩn nút.
- Spinner: mọi success handler gọi `hideLoadingOverlay()` khi dùng overlay.

## 10. GAS HtmlService — KHÔNG viết wrapper HTML trong index.html (2026-08-10)

- **Root cause khoảng trống trên header (đã fix commit `89462c0`)**: `Code.gs` dùng `HtmlService.createHtmlOutputFromFile('index')` + `setTitle(WEB_APP.PAGE_TITLE)` + `addMetaTag(...)` — GAS TỰ dựng head/body riêng rồi nhét toàn bộ nội dung file index.html (kể cả `<!DOCTYPE>`, `<html>`, `<head>`, `<body>` tự viết) làm text thô vào body GAS tạo. Parser HTML5 gặp `<head>` thứ 2 trong body → bỏ qua thẻ head nhưng meta/base/title/style con vẫn chèn thẳng vào body trước `<header>` thật → cấu trúc lệch, khoảng trống phía trên header. Mở local thì parse chuẩn nên KHÔNG thấy lỗi — bug chỉ xuất hiện trên GAS.
- **Chuẩn**: index.html chỉ chứa `<style>` + nội dung, KHÔNG có `<!DOCTYPE>/<html>/<head>/<body>/<base>/<title>/<meta>`. Title/meta phải khai qua Code.gs: `.setTitle(...)` + `.addMetaTag(...)`.
- **GAS addMetaTag whitelist (fix commit `a2fbaa0`)**: chỉ chấp nhận một số meta nhất định — `viewport` OK; `color-scheme`/`theme-color` bị từ chối (lỗi runtime `The meta tag you specified is not allowed in this context`). Thay thế: `color-scheme` → CSS `:root { color-scheme: light }` (tương đương, không cần API); `theme-color` bỏ (cosmetic).
- Khi thêm meta/title mới: khai qua Code.gs hoặc CSS, KHÔNG viết trong index.html.

## 11. Line endings — index.html CRLF 100% từ 2026-08-10 (normalize qua commit upload a96381b)

- Working tree (git `core.autocrlf=true`): MỌI file — kể cả `.gs` — là **CRLF trên disk** (git lưu LF trong repo, checkout tự chuyển CRLF). Đo thật 2026-08-11: Code.gs CRLF=334/LF-only=0, index.html CRLF=4046.
- Sau normalize của user: `index.html` = **CRLF 100%** (4011 CRLF, 0 LF-only).
- Edit index.html: Python pattern mục 8 bắt buộc (anchor có `\r\n`), write với `newline=''` — KHÔNG dùng edit tool trực tiếp nếu làm mất CRLF.
- Verify sau edit: `data.count(b'\r\n')` giữ nguyên 4011; nếu LF-only > 0 → normalize `data.replace(b'\r\n',b'\n').replace(b'\n',b'\r\n')`.
- `.gs` files: KHÔNG normalize sang LF — giữ CRLF như checkout (nếu LF-only > 0 → normalize về CRLF; tránh diff khổng lồ).

## Verify workflow

- Logic changes → `npm run test` (98/98). UI-only → parse+CRLF đủ.
- CDP: `node scripts/cdp-helper.js open "file:///.../index.html?t=N"` — geometry `getBoundingClientRect` là truth; check `scrollHeight` vs `innerHeight`, `section.parentElement` (repair), table parents.
- Production bug: `gh run list --limit 5` TRƯỚC khi kết luận — CI trễ → user test GAS build cũ.

## References (repo)

- `skills/references/architecture-gotchas.md` — 2-phase model, Dư/PENDING timeline, staffIndex fixes.
- `skills/references/deterministic-batch-runner.md` — known-good multi-file/multi-module runner skeleton + undo module pattern.
- `skills/references/slot-fueled-classification.md` — approved plan modal redesign (magic 'Tự do', delete tabs, edge cases).