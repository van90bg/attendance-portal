# SPX Điểm Danh (RollCall v2)

> Hệ thống quản lý chấm công và điểm danh cho kho SPX Express — chạy trên **Google Apps Script WebApp** + **Google Sheets**.

**SPX Điểm Danh** là cổng làm việc tập trung thay thế màn hình điểm danh đơn lẻ: một sidebar 8 trang, dữ liệu nhân sự lấy từ sheet **StaffData** (20 cột chuẩn Att.csv), lịch sử chấm công lưu tại **AttendanceTask** / **AttendanceLog**.

---

## Mục lục

- [Tổng quan](#tổng-quan)
- [Thiết bị hỗ trợ](#thiết-bị-hỗ-trợ)
- [Điều hướng](#điều-hướng)
- [Tính năng](#tính-năng)
- [Kiến trúc & cấu trúc dự án](#kiến-trúc--cấu-trúc-dự-án)
- [Chạy & kiểm thử](#chạy--kiểm-thử)
- [Triển khai (deploy)](#triển-khai-deploy)
- [Quy ước viết code](#quy-ước-viết-code)
- [Trạng thái phát triển](#trạng-thái-phát-triển)

---

## Tổng quan

Hệ thống giúp quản lý viên kho thực hiện toàn bộ quy trình điểm danh trong ngày:

1. **Tạo task** (luôn mở phase 1, log rỗng) — chọn Station / Team / Ngày (metadata hiển thị); danh sách nạp sau qua **Nạp danh sách** (tab Theo ca / Dán mã) hoặc quét.
2. **Quét LISTED_AT** (pha Mở) — ghi nhận nhân viên vào ca.
3. **Bắt đầu điểm danh** (pha Điểm danh) — quét lần 2 ghi SCANNED_AT.
4. **Chốt ca** (chỉ owner/admin của task) — nhân viên chưa điểm danh sẽ tính là Vắng; có thể Mở lại để quét bổ sung.

Mọi luồng thao tác được trên máy tính, máy tính bảng và điện thoại — không cần thiết bị chuyên dụng.

## Thiết bị hỗ trợ

| Thiết bị | Trải nghiệm |
| :------- | :---------- |
| **Máy tính** | Bảng đầy đủ 13–20 cột; quét bằng barcode scanner (Enter) hoặc nhập tay |
| **Máy tính bảng** | Layout co lại, touch target ≥ 44px, nút Quét hiển thị |
| **Điện thoại** | Thẻ gọn 3 dòng cho task/NV, bottom nav, toggle mở rộng danh sách NV |

## Điều hướng

Sidebar trái thu gọn được (240px ↔ 48px), gồm 8 trang:

| Mục | Chức năng |
| :--- | :-------- |
| **Trang chủ** | Logo + tên app + đồng hồ thời gian thực (Asia/Ho_Chi_Minh) — màn hình chiếu/điểm danh |
| **Thống kê** | Pivot StaffData theo Team × Contract × Ca (Inbound/Outbound), tab lọc BPO / OS — fullscreen |
| **Điểm danh** | Danh sách task đối chiếu — tạo task, quét giờ có mặt, điểm danh, bàn giao, kết thúc |
| **Báo cáo** | Báo cáo chấm công tháng theo email đăng nhập — bảng 10 cột (desktop/tablet), thẻ card mobile |
| **Quản trị** | Nhật ký hoạt động (AuditLog, chỉ admin) — lọc theo ngày; danh sách task mọi owner đã gộp vào Điểm danh (2026-08-17) |
| **Dữ liệu chấm công** | Toàn bộ StaffData — 20 cột khớp tên sheet, Clock In/Out định dạng `H:mm:ss`, tìm mã/tên/agency |
| **Cấu hình** | Trang Config Admin (chỉ editor) — đọc/ghi settings qua SettingsService: Station/Ca/Team/Department mặc định + roleMap phân quyền |
| **Giới thiệu** | Hướng dẫn sử dụng và thông tin kỹ thuật |

## Tính năng

- **Tạo task 2 nhóm (dropdown + Task mới)** — task mới **Mở (phase 1) + log RỖNG** (KHÔNG pre-fill roster): nút **+ Task mới** là dropdown 2 lựa chọn — **Nạp danh sách** (chọn Station trong modal → task có station, nạp roster theo ca ngay) hoặc **Task rỗng** (tạo ngay, quét tự do); nút **Nạp danh sách** (tab Theo ca / Dán mã) **CHỈ hiện ở task có station** — task rỗng không có modal nạp, danh sách xây bằng quét.
- **Quy trình 2 pha** — pha **Mở** ghi LISTED_AT (**phase 1 KHÔNG có Dư**), pha **Điểm danh** ghi SCANNED_AT:
  - Task tạo xong rỗng: quét / dán / nạp roster theo ca xây danh sách ở phase 1, bấm **Bắt đầu điểm danh** → quét lần 2; NV lạ phase 2 → Dư.
    - Nạp roster theo ca (tab **Theo ca** trong **Nạp danh sách**): append PENDING — LISTED_AT rỗng (thời điểm đến ghi khi NV quét phase 1); quét phase 2 = Có mặt / Dư.
    - **Đã đến ≠ Có mặt** — phase 1 ghi LISTED_AT hiện **Đã đến**; quét lần 2 ghi Giờ quét mới là **Có mặt** (điểm danh thật). Banner phase trong màn quét nhắc rõ 2 bước; đóng task khi **chưa ai quét lần 2** → confirm cảnh báo "tất cả sẽ tính Vắng" (không chặn cứng — Mở lại cứu được).
- **Hủy task rỗng** — task phase Mở chưa có dữ liệu quét (tạo nhầm / bỏ dở): nút **Hủy** (owner/admin, hiện khi log rỗng) xóa hẳn task khỏi AttendanceTask; task đã có dữ liệu phải Bắt đầu điểm danh → Chốt ca bình thường.
- **Phân quyền (role gate)** — viewer < operator < manager < admin:
  - Task `open` chỉ owner + admin quét được; legacy `createdBy='web'` fail-open.
  - **Bắt đầu điểm danh** (OPEN→ATTEND) chỉ owner/admin — non-owner gọi thẳng server bị chặn (M1 service-layer, đồng gate scan/paste/nạp roster).
  - **Chốt ca / Mở lại / Sửa trạng thái log** chỉ owner/admin — gate **fail-closed `canMutateTask_`** (khác `canScanOpen_` fail-open): task legacy `createdBy='web'` không ai đóng/mở lại/sửa được ngoài admin. `warmStaffCacheApi` (index nhân sự) giờ gate operator+.
  - **Repo mutator gate (M1 2026-08-19)** — mọi hàm ghi/đọc StaffData-task-log (`batchInsertLogRows_`/`batchAppendLogRows_`/`batchUpdateLogRows_`/`transformLogStatuses_`/`setLogRowStatus_`/`writeBatchRuns_`/`insertTask_`/`updateTaskStatus_`/`readStaffList_`/`readStaffIndex_`) tự `requireRole_('operator')` (google.script.run gọi được global trực tiếp — gate *Api wrapper bị bypass); `getFilterOptionsApi`/`previewStaffApi` gate operator+; `roleMap` tách khỏi `getSettings_` → `getRoleMap_` (bản đồ quyền không lộ qua settings public).
  - `getStaffStatsApi` (viewStats/viewStaff) + `getReportsApi` (viewReports) + `searchLogsByStaffApi` (lịch sử chấm công cá nhân) chỉ manager+; `getAuditLogApi` (viewAdmin) chỉ admin; settings editor-only (viewConfig).
  - **Phân quyền theo view (2026-08-17):**

| View | viewer | operator | manager | admin |
| :--- | :----: | :------: | :-----: | :---: |
| viewTasks (Điểm danh) | ✅ | ✅ | ✅ | ✅ |
| viewScan (Quét) | ✅ | ✅ | ✅ | ✅ |
| viewHome (Trang chủ) | ✅ | ✅ | ✅ | ✅ |
| viewAbout (Giới thiệu) | ✅ | ✅ | ✅ | ✅ |
| viewStats (Thống kê) | | | ✅ | ✅ |
| viewStaff (Dữ liệu chấm công) | | | ✅ | ✅ |
| viewReports (Báo cáo) | | | ✅ | ✅ |
| viewConfig (Cấu hình) | | | | ✅ (editor) |
| viewAdmin (Quản trị) | | | | ✅ |
- **Sidebar 8 mục** — thu gọn icon `☰` (48px), mặc định mở; mục Cấu hình (chỉ editor) ẩn theo `meta.isEditor`.
- **Dán danh sách mã** — dán hàng loạt mã NV, 1 `setValues` batch, dedupe, clamp 200, báo mã lỗi.
- **Nạp danh sách** (1 nút — modal 2 tab Theo ca / Dán mã thay menu Thêm; tab Theo ca: phase 1 + 2, owner): lọc StaffData theo Station/Ca/Team/**Hình thức**/Ngày, append PENDING — LISTED_AT rỗng (thời điểm đến ghi khi NV quét phase 1), **bỏ qua NV đã có** (idempotent).
- **Thời gian quét WYSIWYG** — app gửi epoch chụp lúc quét (`scanStaffApi(..., clientEpoch)`): sheet ghi đúng giờ hiển thị trên app, server không đè giờ riêng → hết nhảy giờ sau ~1s khi đồng hồ thiết bị lệch / queue xử lý chậm.
- **Cột Ngày bảng quét** — hiện ngay khi quét (optimistic từ staffIndex + response `dateText`), không chờ reload; `getFilterOptionsApi` cache 60s → modal tạo task mở nhanh.
- **Chốt ca** → NV chưa quét gán **Vắng** (modal confirm); **Mở lại** → về Điểm danh.
- **Counters tức thì** — Đã quét / Chưa / Dư, queue nền + optimistic.
- **A11y** — skip-link, focus trap, `prefers-contrast`, phản hồi không dùng `alert()`.

## Kiến trúc & cấu trúc dự án

```
RollCall_2/
├── appsscript.json         # manifest + webapp block
├── Code.gs                # doGet (template) + 20 API endpoint *Api + editor tools
├── Config.gs              # hằng số sheet/cột/cache/status/labels
├── Auth.gs                # getActiveEmail_/isEditor_ — MỌI lấy email qua đây
├── Debug.gs               # ?debug=1 (editor-gated)
├── Cache.gs               # cache wrapper version-key + format thời gian
├── CsvUtil.gs             # parse CSV + isValidBarcodeId (pure)
├── Spreadsheet.gs         # getSheet_/getSpreadsheet_/ensureSheets_ (bootstrap)
├── StaffDataRepo.gs       # đọc/ghi StaffData (index/list/overwrite)
├── TaskRepo.gs            # đọc/ghi AttendanceTask + cache task
├── LogRepo.gs             # đọc/ghi AttendanceLog + cache log (batch)
├── ScanLogic.gs           # phân loại scan 2-phase (pure)
├── ScanService.gs         # scanStaff — guard + LockService
├── TaskService.gs         # task CRUD + transition + kết thúc
├── SettingsService.gs     # đọc/ghi Config sheet (versioned cache) — nền trang Cấu hình Admin
├── index.html             # GAS template — HTML + <?!= include() ?> (KHÔNG BOM)
├── styles.html            # CSS — include vào index
├── app-core.html          # JS client (module 1/9) — state, utils, boot, nav, clock
├── app-stats.html         # JS client (module 2/9) — viewStats
├── app-staff.html         # JS client (module 3/9) — viewStaff + funnel
├── app-modals.html        # JS client (module 4/9) — paste/create/confirm modals
├── app-config.html        # JS client (module 5/9) — viewConfig admin
├── app-tasks.html         # JS client (module 6/9) — task list + search + create
├── app-scan.html          # JS client (module 7/9) — scan view + queue + actions
├── app-reports.html       # JS client (module 8/9) — viewReports (báo cáo chấm công tháng)
├── app-admin.html         # JS client (module 9/9) — viewAdmin (nhật ký hoạt động, manager+)
├── mock/mock-google.js    # mock GAS cho dev local
├── test-fixtures/         # CSV mẫu cho test
├── tests/                 # 194 unit tests node --test
├── scripts/               # build-local.js, cdp-helper.js, audit-* (css/gs/style/ui)
├── skills/                # skill chuẩn SKILL.md — project-skill · ui-ux-audit · audit-webapp-optimize · review-gas-failure-modes · debug-systematic
└── docs/                  # deploy-codespace-actions.md
```

**Luồng dữ liệu:** Client (`app-*.html`) gọi `google.script.run` → Server (`Code.gs` + các `*Service`/`*Repo`) đọc/ghi 4 sheet qua `Spreadsheet.gs` + cache versioned.

## Chạy & kiểm thử

```bash
npm test                        # 194/194 unit tests (node:test)
node scripts/test-local-mock.js # UI test local mock qua CDP (11/11)
```

Trình duyệt không render GAS template → gộp trước rồi mở local:

```bash
node scripts/build-local.js     # → index.local.html
node scripts/audit-css.js       # rà dead CSS (exit 1 nếu có dead; --full xem dynamic)
node scripts/audit-gs.js        # rà dead .gs / API treo (exit 1 nếu có dead/treo)
node scripts/audit-style.js --strict # rà computed style class chung (cần Chrome)
node scripts/audit-ui.js        # audit CDP 7 view × 4 viewport (exit 1 nếu FAIL; --quick)
```

Mở `index.local.html` bằng browser — mock tự nạp khi không có `google.script.run`.

## Triển khai (deploy)

```bash
clasp login
clasp push -f
clasp deploy
```

> **⚠️ Lưu ý:** `PUT /deployments/{id}` đứt `entryPoints` → `/exec` 404. Chỉ dùng `clasp deploy`; sau đó verify URL `/exec` bằng curl. CI tự động deploy qua GitHub Actions nhưng có độ trễ — khi báo bug, kiểm tra SHA GAS đang chạy (`gh run list`) đối chiếu git HEAD.

## Quy ước viết code

- **Cột sheet:** tiếng Anh · **UI:** tiếng Việt · **Constants:** gom ở `Config.gs`.
- **Cache:** versioned (`rc2_*_vN`) — thay đổi có invalidate; mọi ghi log/đổi status → `invalidateTaskDetailCache_(taskId)`.
- **Frontend GAS template:** `index.html` + `styles.html` + **9 module JS `app-*.html`** (include tuần tự, chung global scope). `doGet` dùng `createTemplateFromFile` + `include()`.
- **Line ending:** mọi file trên disk dùng **CRLF**; `index.html` **KHÔNG BOM** (BOM sinh khoảng trống phía trên header trên GAS). Sửa file có tiếng Việt + CRLF chỉ qua script deterministic (đọc `utf-8-sig`, ghi `utf-8`, không sig).
- **Commit:** `type(scope): mô tả` — 1 issue = 1 commit = 1 push; không commit secrets (`.clasp.json`, `.clasprc.json`).
- **Comment:** chỉ ghi khi CÓ GIÁ TRỊ (rationale "tại sao", gotcha "đừng regress", khớp wire/server) — cấm comment rác dạng `FIX(date)` / `P1-P3 (date)` / marker vòng fix (`B3/I5/F7`) / restatement; lịch sử fix nằm ở git log (AGENTS.md §2.7).

## Trạng thái phát triển

- ✅ Portal shell: sidebar 8 trang; trang chủ logo + đồng hồ; viewReports — báo cáo chấm công tháng (bảng 10 cột + thẻ card mobile); viewAdmin — nhật ký hoạt động (manager+, lọc ngày).
- ✅ Tách frontend (index/styles + 9 module `app-*.html`) + `build-local.js` cho test local.
- ✅ Cấu hình Admin (SettingsService) + role gate + pre-select mặc định.
- ✅ 194/194 unit tests + 11/11 CDP local mock.
- ✅ Đợt 1 (2026-08-19): force-close admin (completeTask counter lệch) · loadRoster ở phase Điểm danh (chặn DONE) · sửa trạng thái dòng log (updateLogRowStatusApi + cột Sửa bảng quét) · chống gian lận giờ quét (±60s + không sớm hơn tạo task) · cảnh báo mã quét không có trong StaffData (staffUnknown) · **L1 fix** (đổi ngược PRESENT→ABSENT/PENDING clear TIME_SCAN — counter đúng; về PENDING clear LISTED_AT; EXTRA giữ SCANNED_AT — partition invariant).
- ✅ Đợt 2 (2026-08-19): **hủy task Mở rỗng** (cancelTaskApi + nút Hủy — owner/admin, log rỗng mới hủy được, audit cancelTask) · **nạp roster KHÔNG ghi LISTED_AT** (thời điểm đến ghi khi NV quét phase 1 — counter 'Đã đến' không còn thổi phồng) · label phase 1 'Đã có mặt' → 'Đã đến' (khớp 2-phase: đến ≠ điểm danh).
- ✅ Đợt 3 (2026-08-19): thuật ngữ operator — **Bắt đầu điểm danh** / **Chốt ca** / **Đang ghi danh sách** / **Đã chốt điểm danh** / **Đã điểm danh** (bỏ "quét lần 2") · gộp Dán mã + Lấy theo ca → **1 nút "Nạp danh sách"** (modal 2 tab — bỏ menu "Thêm" + CSS topbar-more) · ẩn cột Tạo lúc/Người tạo bảng task (list + F-search) · nudge quên chuyển phase (quét trùng phase Mở → toast gợi ý) · Dư → "Dư — không có trong danh sách".
- ✅ Đợt 2 (2026-08-19): queue quét 2→8 + toast queue ≥3 · tab sync (quay lại tab → silent reload task đang mở) · confirm Kết thúc hiện số NV chưa điểm danh sẽ Vắng · scanner ngoài theo task (đổi task → đóng scanner + từ chối mã task cũ) · lọc PENDING phase Mở theo listedAt (chỉ NV đã đến) · non-owner phase Mở ẩn nút camera · transitionToAttend re-check queue full · waitLock 30s cho pasteCodes/loadRoster.
- ✅ Mobile nhất quán: task/scan/staff/reports thành thẻ card 2 cột đồng bộ; a11y AA (contrast token, touch ≥44px); skill `ui-ux-audit` — audit UI/UX toàn diện 1 lần (design language + WCAG + perf + verify tự động).
- ✅ Đợt 4 (2026-08-19): security hardening — **repo mutator gates** (M1: `requireRole_('operator')` ở LogRepo/TaskRepo/StaffDataRepo — chống bypass gọi global trực tiếp) · **`getFilterOptionsApi`/`previewStaffApi` gate operator+** + client skip `loadFilterOptions` cho viewer · **`roleMap` tách `getSettings_` → `getRoleMap_`** (P0: bản đồ quyền không lộ qua settings public) · DEFENSE `getTaskListApi`/`getTaskDetailApi`.
- ✅ Đợt 5 (2026-08-19): backend logic P1 — **`canMutateTask_` fail-closed** (complete/reopen/updateLogRowStatus — task legacy `'web'` chỉ admin; scan/paste/loadRoster/transition vẫn `canScanOpen_` fail-open vì cần vận hành) · **PENDING→EXTRA tự fill TIME_SCAN** (partition invariant — task không kẹt "counter-mismatch") · **`batchInsertLogRows_` invalidate detail+list cache** · **`markUnscannedAbsent_` dùng epoch** (timeScan junk → Vắng đúng) · **AttendanceTask thêm cột `date`** (header + migration 9→10 cột khớp `TASK_COL_COUNT`).

---

**Spec chi tiết:** [`Spec — RollCall v2.md`](Spec%20—%20RollCall%20v2.md) · **Repo:** `van90bg/attendance-portal` · **Deploy guide:** [docs/deploy-codespace-actions.md](docs/deploy-codespace-actions.md)
