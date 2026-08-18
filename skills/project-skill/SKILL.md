---
name: project-skill
description: SPX Điểm Danh (RollCall v2) — project skill. Use for ANY edit in this repo (UI, server, tests, docs): architecture mental model, gotchas, deterministic edit + batch runner, perf, pitfalls.
---

# Project Skill — SPX Điểm Danh (RollCall v2)

> Bản skill đóng gói đầy đủ cho AI agent làm việc trong repo `RollCall_2_deploy` (GitHub: `van90bg/attendance-portal`).
> Dùng khi: bất kỳ edit nào với repo này (UI, server, tests, docs).
> Nguồn: skill Hermes `rollcall`. Nếu mâu thuẫn, Hermes skill là nguồn mới nhất.
> References: xem `references/` — `architecture-gotchas.md`, `deterministic-batch-runner.md`, `slot-fueled-classification.md`, `mockup-design-language.md`.

## 1. Repo facts

- Local: `C:\Users\Van90BG\Documents\AppScript\RollCall_2_deploy` · Remote `main` (CI self-clasp).
- **User rule: agent commit+push GitHub — KHÔNG tự clasp push/deploy.** CI deploy trễ → luôn check SHA thật trước khi kết luận bug (`gh run list --limit 5`, đối chiếu `.head_sha`).
- Test: `npm run test` = 155 tests (node:test — 17 files, gồm admin-audit; pure logic ScanLogic.gs/CsvUtil.gs + smoke `tests/all-gs-load.test.js`/`tests/settings-service.test.js`/`tests/role-service.test.js` load toàn bộ .gs với mock GAS dùng chung `tests/gas-sandbox.js` + contract mock↔server `tests/mock-contract.test.js`).
- Frontend (tách module 2026-08-13): `index.html` (HTML + `<?!= include() ?>` GAS template) + `styles.html` (CSS) + 9 module JS `app-*.html` (core/stats/staff/modals/config/tasks/scan/reports/admin — thay app.html 3665 dòng) — cả nguồn GAS CRLF. Server: Code/Config/CsvUtil/Spreadsheet/Cache/StaffDataRepo/TaskRepo/LogRepo/ScanLogic/ScanService/TaskService/Auth/Debug/SettingsService/AuditRepo/ReportRepo/ReportService `.gs`. Test local: `node scripts/build-local.js` → `index.local.html` (trình duyệt không render template).

## 2. Shell: SPX Điểm Danh (2026-08-09)

App scope mở rộng: quản lý chấm công, không chỉ điểm danh. Layout: `<header>` (controls: userEmail · net-dot · 🔊 · ⟳ — ĐÃ BỎ 📋/ⓘ) > `.app-shell` (flex) = `#sidebar` (240↔48px, icon SVG đơn sắc currentColor, KHÔNG side-head, nút thu gọn `☰`) + `#main-content`.

Router: `selectPage(page)` + `PAGE_VIEWS = { home:'viewHome', stats:'viewStats', attendance:'viewTasks', data:'viewStaff', config:'viewConfig', reports:'viewReports', admin:'viewAdmin', about:'viewAbout' }`. `initSidebar()` + `selectPage('home')` trong DOMContentLoaded. ⚠️ `showSection` ẩn **danh sách cố định** — thêm view mới phải thêm vào đó.

- viewHome: hero logo SPX — URL remote `https://spx.vn/new_static/assets/images/sea-logo.svg` (`onerror` ẩn khi không tải được, KHÔNG dùng file svg local — đã xóa 2026-08-11) + tên + đồng hồ realtime (`renderHomeClock`, Intl Asia/Ho_Chi_Minh).
- viewStats: pivot fullscreen — 2 bảng Contract×Ca + Agency×Ca, MỖI TEAM 1 bảng (Ca dọc), filter Station · Ngày · Department. viewStaff (page key `data`): bảng StaffData fullscreen (search `#staffSearch` + count `#staffCount`).
- View mới phải vào mảng `repairViewParents()` — `['viewHome','viewStats','viewStaff','viewAbout','viewScan','viewTasks','viewConfig','viewReports','viewAdmin']`.
- **Phân quyền view (2026-08-17)**: viewer+ = viewTasks/viewScan/viewHome/viewAbout; manager+ = viewStats/viewStaff/viewReports (`getStaffStatsApi`/`getReportsApi` gate manager — nav ẩn theo `canManager_`); admin = viewAdmin (`getAuditLogApi` gate admin — `canAdmin_`); editor = viewConfig. Server gate `requireRole_` là nguồn quyết định cuối.

## 3. Architecture mental model (đọc TRƯỚC mọi fix)

- **Task 2-phase**: `task.status` = `open` (ghi LISTED_AT / timeRef) → `attend` (ghi SCANNED_AT / timeScan) → `done`.
- `logRow.status`: `PENDING`(-/Chưa điểm danh) · `PRESENT`(Có mặt) · `ABSENT`(Vắng) · `EXTRA`(Dư).
- **Epoch là nguồn sự thật** cho counters/sort: `listedAtEpoch`/`scannedAtEpoch` (text `HH:mm:ss` mất ngày qua đêm). `computeCounters` đếm theo epoch.
- `classifyScan(cfg,task,logRows,staffId)` → `{action:update|append|reject, phase, field, status}`.
- Layers: `scanStaffApi`(Code) → `scanStaff`(ScanService) → `classifyScan`(ScanLogic) + `appendLogRow_`/`updateLogRowScan_`/`batchUpdateLogRows_`(LogRepo). LockService + try/catch — không throw client, trả `ok:false`.
- `reopenTask` → ATTEND (KHÔNG quay OPEN); client recompute phase từ `task.status`.
- A2 (2026-08-18): task mới luôn FREE + `status:OPEN` + log RỖNG — KHÔNG pre-fill roster khi tạo (kể cả ca thật; server ép noList); roster nạp sau qua `loadRosterApi` (nút "Lấy danh sách theo ca" — menu ⋯ trong màn quét). Phase 1 không Dư — Dư chỉ khi quét phase 2 ngoài danh sách. `reconcile` chỉ còn cho task cũ.
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
10. **KHÔNG trả Date qua google.script.run** — serialize Date lỗi → toàn bộ response thành null. Chỉ trả text đã format (`createdAtText`/`completedAtText` qua `formatDateTime_`) + epoch number; client không `new Date()` từ response.
11. **Comment code: KHÔNG ghi date/marker vòng fix** (`FIX(2026-08-XX):` `P1/P2:` `B3:` `I5:`) hay restatement — lỗi thời khi có fix/tính năng mới; lịch sử ở git log. Chỉ comment có giá trị: rationale "tại sao", gotcha "đừng regress", khớp wire/server (quy tắc AGENTS.md §2.7).

12. **Mobile card — rule desktop rò rỉ xuống thẻ (2026-08-16)**: rule cột desktop (`#reportsTable td:nth-child(5-9) { text-align:center }` = specificity 1,1,1) thắng base mobile (`#reportsTable tbody td` = 1,0,2) BẤT KỂ thứ tự khai báo → card lệch tông. Ép override bằng selector cao hơn `tbody td:nth-child(n)` (1,2,1) + `text-align:left`; không tin thứ tự, phải thắng về specificity. Kiểm tra mọi rule cột desktop khi thêm view card mobile.

## 5. UI labels & modal (2026-08-07/08)

- Counter/badge/filter label theo phase — đồng bộ (2026-08-17): OPEN → counter 1 "Có mặt" = presentAt
  (listedAtEpoch>0), counter 2 "Chưa có mặt" = total − presentAt − extra (FREE không roster → 0);
  ATTEND → counter 1 "Đã điểm danh" = scanned (scannedAtEpoch>0), counter 2 "Chưa điểm danh" = absent;
  DONE → "Đã điểm danh"/"Vắng" (đỏ). Badge cột Trạng thái cùng chain: OPEN: PENDING + timeRef → "Có mặt" (xanh),
  PENDING chưa timeRef → "Chưa có mặt"; ATTEND: PENDING → "Chưa điểm danh"; PRESENT → "Có mặt"; EXTRA → "Dư".
  Filter PENDING option = OPEN ? "Chưa có mặt" : "Chưa điểm danh".
  GOTCHA: renderCounters neo label bằng ID cha (#cAbsent/#cScanned → parentElement) — class absent↔waiting
  swap làm querySelector('.counter.absent') về null → bỏ qua cả khối phase-aware (counter hiện số raw sai phase).
- Table headers Vietnamese: Ngày · Mã NV · Tên NV · Ca · Team · Giờ vào DS · Giờ điểm danh · Trạng thái. (StaffData table riêng — xem §9.)
- FREE description: "Quét lần 1 lấy danh sách, lần 2 điểm danh; NV lần 2 chưa có lần 1 → Dư."
- Task type badge: FREE → 'Quét tự do' (purple), RECONCILE → 'Đối chiếu' (blue). List order: STT, Mã task, Loại, Station, Team, Ca, Tổng NV, Đã quét, Dư, Trạng thái, Tạo lúc, Người tạo, Thao tác.
- Modal: với đổi màn tạo task → MUST làm HTML mockup trước (thư mục mockup riêng — `sketches/` đã xóa 2026-08-11), user duyệt, mới implement (luật user — strict).
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

## 8. Deterministic editing (bắt buộc trên 3 file template index/styles/app)

- Fuzzy patch BANNED; sed/echo trong bash làm hỏng VN+CRLF -> dùng script Python/Node deterministic (xem `references/deterministic-batch-runner.md` + `scripts` pattern).
- Python pattern: read/write với `newline=''`; ĐỌC dùng `encoding='utf-8-sig'` (strip BOM), GHI dùng `encoding='utf-8'` (KHÔNG sig — utf-8-sig write THÊM BOM gây khoảng trống trên header khi GAS serve, lesson 9982293); anchor literal `\r\n`; mọi replace `assert count==1`.
- Verify BOM: sau edit chạy `head -c 3 <file> | xxd -p` — KHÔNG được ra `efbbbf` (file phải bắt đầu bằng `3c`/`2f`).
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

- `#viewAbout`: content Portal-oriented (5 mục), back → `selectPage('home')`.
- README giữ sync (test counts, sidebar, app). Update cùng commit UI change.

## Pitfall checklist (2026-08-09)

- `.hidden { display:none !important }` — thắng ID rule (chồng view).
- `--header-h: 59px` đo thật (53 → scroll 6px).
- **Chuẩn tên (2026-08-11)**: viewTasks (danh sách task) · viewScan · viewHome · viewStats · viewStaff · viewConfig · viewAbout (prefix `view*`). CẤM tên cũ: viewList · aboutView · headerSearch · globalSearch · runSearch · scan-topbar · view-toolbar.
- **Toolbar chung**: 1 class `.view-topbar` (+ `.view-topbar-title`) cho List/Scan/Stats/Staff/Config/Reports/Admin — sticky `--header-h`, `.stuck` đổ bóng, JS sync `querySelectorAll('.view-topbar')`.
- **Search dùng chung `.list-search` (d6b0516)**: `#listSearch` + `runListSearch()` trong `task-list-toolbar` (card DANH SÁCH TASK, ép phải `margin-left:auto`) — nhánh con giữ tên `runSearchStaff`/`runSearchTask`; Escape → `onListSearchKeydown` clear; `#staffSearch`/`#scanSearch` cũng dùng `.list-search` (hết `.att-search`).
- **Spinner**: `showModalSpin` guard — loadingOverlay đang hiện thì KHÔNG mở spinModal (2 spinner đè nhau; khởi động refreshAll mở spinModal khi overlay còn hiện — fix 2026-08-11).
- `taskListTable` KHÔNG trong `#taskSkeleton` — parent chain check (`table.parentElement.id === 'taskSkeleton'` → table height 0).
- Card stretch tạo trắng — card auto height; `.table-wrap` scroll `max-height: calc(100vh - 320px)`.
- Scan layout chuẩn `.scan-layout > .scan-col-left(480)+.scan-col-right` — card bảng phải trong col-right (2026-08-09 fixed rớt chân).
- **Duplicate id sau split**: `statsStation` vs `statsStation2` — grep ids + label for.
- Role gate phase OPEN: `permission` tươi từ `getTaskDetail` (không nhét cache); `applyScanPermission()` chạy CUỐI `renderScanView` + `scanOwnerLocked` cờ — nguồn quyết định disabled/placeholder/ẩn nút.
- Spinner: mọi success handler gọi `hideLoadingOverlay()` khi dùng overlay.

## 10. GAS HtmlService — KHÔNG viết wrapper HTML trong index.html (2026-08-10)

- **Root cause khoảng trống trên header (đã fix commit `89462c0`)**: `Code.gs` dùng `HtmlService.createHtmlOutputFromFile('index')` + `setTitle(WEB_APP.PAGE_TITLE)` + `addMetaTag(...)` — GAS TỰ dựng head/body riêng rồi nhét toàn bộ nội dung file index.html (kể cả `<!DOCTYPE>`, `<html>`, `<head>`, `<body>` tự viết) làm text thô vào body GAS tạo. Parser HTML5 gặp `<head>` thứ 2 trong body → bỏ qua thẻ head nhưng meta/base/title/style con vẫn chèn thẳng vào body trước `<header>` thật → cấu trúc lệch, khoảng trống phía trên header. Mở local thì parse chuẩn nên KHÔNG thấy lỗi — bug chỉ xuất hiện trên GAS.
- **Chuẩn**: index.html chỉ chứa `<?!= include('styles') ?>` + các `<?!= include('app-xxx') ?>` + nội dung, KHÔNG có `<!DOCTYPE>/<html>/<head>/<body>/<base>/<title>/<meta>`; CSS/JS nằm ở `styles.html`/`app-*.html`. Title/meta phải khai qua Code.gs: `.setTitle(...)` + `.addMetaTag(...)`.
- **BOM regression 2026-08-11**: BOM tái xuất hiện ở `673d01a` (script write `utf-8-sig`) → khoảng trống header trên GAS; đã xóa + thêm test guard '3 file template không BOM' (index-html-parse). Mọi batch sau BẮT BUỘC write `utf-8` (KHÔNG sig — AGENTS.md §3).
- **GAS addMetaTag whitelist (fix commit `a2fbaa0`)**: chỉ chấp nhận một số meta nhất định — `viewport` OK; `color-scheme`/`theme-color` bị từ chối (lỗi runtime `The meta tag you specified is not allowed in this context`). Thay thế: `color-scheme` → CSS `:root { color-scheme: light }` (tương đương, không cần API); `theme-color` bỏ (cosmetic).
- Khi thêm meta/title mới: khai qua Code.gs hoặc CSS, KHÔNG viết trong index.html.

## 11. Line endings — mọi nguồn GAS CRLF 100% + no-BOM (từ 2026-08-10; chuẩn hóa toàn repo 2026-08-13)

- Working tree: MỌI file nguồn GAS — kể cả `.gs` — là **CRLF trên disk**. `.gitattributes` pin `*.gs` + `index.html`/`styles.html`/`app-*.html` với `text eol=crlf` → index lưu LF, checkout ra CRLF trên mọi platform (không phụ thuộc `core.autocrlf`).
- Mọi file nguồn = **CRLF 100% + no-BOM** (BOM → khoảng trống header khi GAS serve — lesson 9982293; guard test `tests/eol-bom.test.js` + `index-html-parse` kiểm toàn bộ `.gs` + template). 2026-08-13 đã xóa BOM khỏi Code.gs/TaskService.gs/SettingsService.gs + README/AGENTS.
- Edit file nguồn: Python pattern mục 8 bắt buộc (anchor có `\r\n`), write với `newline=''` — KHÔNG dùng edit tool trực tiếp nếu làm mất CRLF.
- Verify sau edit: guard test nói trên (nếu LF-only > 0 → normalize `data.replace(b'\r\n',b'\n').replace(b'\n',b'\r\n')`).
- `.gs` files: KHÔNG normalize sang LF — giữ CRLF như checkout (nếu LF-only > 0 → normalize về CRLF; tránh diff khổng lồ).

## 12. viewConfig design language = mockup (2026-08-16 — BẮT BUỘC cho UI viewConfig)

- Nguồn: `C:\Users\Van90BG\Documents\AppScript\New folder\mockup.html` — user: "lấy đây là ngôn ngữ giao diện cho app" (commit fee929b).
- Pattern lõi: head card clickable (chevron ▾ xoay -90°, role=button + aria-expanded) · count badge pill · chip surface-muted + default primary-bg/primary xanh · chip-value ellipsis cap 220/140px + title tooltip · chip edit input transparent 140px + ✓/✕ 20px tròn (KHÔNG `.cfg-input`, placeholder "Giá trị mới" chỉ khi thêm) · + Thêm dashed pill cuối chips · role = card rows (KHÔNG bảng, head không click) · icon-btn 30×30 cả mobile · star 14px border/warning. Chi tiết + mapping cfg2-* → cfg-*: `references/mockup-design-language.md`.
- **Config state KHÔNG reload UI**: mọi thao tác = state cục bộ + dirty; Lưu = 1 patch diff vs CFG_SNAPSHOT; Huỷ thay đổi = khôi phục snapshot cục bộ (KHÔNG loadConfigView/fetch/skeleton); renderCfgList giữ card.scrollTop. Verify không-reload bằng CDP navigation type + skeleton display + scroll.
- Nút Lưu luôn hiện sau load — cờ hết dirty = disabled=true (không phải display:none).

## 13. Design token system (2026-08-17 — BẮT BUỘC khi sửa style)

- **92 token trong `:root`** (styles.html) — màu semantic (primary/danger/warning/success/amber-solid-text-hover-deep/badge status free/reconcile/net-err/dark-mode/surface) · `--space-1..8` = 4/8/12/16/20/24/28/32px (4pt grid) · `--text-3xs..8xl` = 10→72px px-exact · `--radius-2xs..full` = 4/6/8/12/20/999px · layout `--header-h`/`--bottom-nav-h`/`--card-radius` (= var(--radius-md)).
- **Invariant**: KHÔNG hardcode hex/px ngoài :root (cả inline style + JS). Ngoại lệ chủ đích: micro 1-3px trong component · `#fff`/`#000` · fallback `var(--x, #hex)` · px đo runtime (width/scroll/progress). Audit 2026-08-17: 0 rời rạc còn lại.
- **Spacing đã chuẩn hóa 4pt** (10px→8px, 6px→8px, 14px→16px, 18px→16px — UI chặt hơn ~2px; đã verify audit-ui 132/132). Đừng regress về 10px/6px cũ.
- **Tech debt ghi nhận — KHÔNG refactor**: hàm dài core (server: scanStaff 7.9k chars, pasteCodes 5.4k, createReconcileTask 5.7k, planScanCommits 5.3k; client: submitScan 9.2k, processScanQueue 6.0k, renderScanView 4.2k, submitPaste 4.5k). Đã qua nhiều vòng review (security gate/optimistic/race) — refactor rủi ro > lợi ích trên GAS.

## Verify workflow

- Logic changes → `npm run test` (155/155 — **tự chạy 2 guard audit trước**: `test:css` + `test:gs`; có dead → fail ngay). UI-only → parse+CRLF đủ.
- **Checklist 3 audit (2026-08-11) — chạy sau MỌI batch**:
  - `npm run test:css` — dead CSS class (styles.html vs index/app + JS render động); exit 1 nếu có dead.
  - `npm run test:gs` — hàm/const/API dead trong 17 file .gs (đối chiếu gs + index/app + mock + tests + scripts); exit 1 nếu dead/treo.
  - `npm run test:style` — computed style class chung qua CDP (--strict; cần Chrome); exit 1 nếu lệch ngoài ALLOWED_DRIFT (modal 44px touch / btn-sm / cfg-card / flabel 56px / card+table-wrap flex scan là chủ đích).
- CDP: `node scripts/build-local.js` trước rồi `node scripts/cdp-helper.js open "file:///.../index.local.html?t=N"` — geometry `getBoundingClientRect` là truth; check `scrollHeight` vs `innerHeight`, `section.parentElement` (repair), table parents.
- Production bug: `gh run list --limit 5` TRƯỚC khi kết luận — CI trễ → user test GAS build cũ.

## References (repo)

- `references/architecture-gotchas.md` — 2-phase model, Dư/PENDING timeline, staffIndex fixes.
- `references/deterministic-batch-runner.md` — known-good multi-file/multi-module runner skeleton + undo module pattern.
- `references/slot-fueled-classification.md` — approved plan modal redesign (magic 'Tự do', delete tabs, edge cases).
- `references/mockup-design-language.md` — viewConfig theo mockup: mapping cfg2-* → cfg-*, 9 pattern UI, config state không-reload + verify workflow.