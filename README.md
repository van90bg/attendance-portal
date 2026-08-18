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

1. **Tạo task** theo Station / Ca / Team (hoặc quét tự do không cần danh sách).
2. **Quét Giờ có mặt** (pha Mở) — ghi nhận nhân viên vào ca.
3. **Chuyển điểm danh** (pha Điểm danh) — quét lần 2 ghi Giờ quét.
4. **Kết thúc** — nhân viên chưa quét lần 2 tự tính là Vắng; có thể Mở lại để quét bổ sung.

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

- **Tạo task 2 chế độ** — modal dropdown Station · Ca · Team · Ngày; badge số NV; **Quét tự do (FREE)** không cần danh sách sẵn.
- **Quy trình 2 pha** — pha **Mở** ghi Giờ có mặt, pha **Điểm danh** ghi Giờ quét:
  - Task Đối chiếu: pre-fill Giờ có mặt, quét = Có mặt / Đã điểm danh / Dư.
  - Task FREE: quét lần 1 xây danh sách, bấm **Chuyển điểm danh** → quét lần 2; NV lạ → Dư.
- **Phân quyền (role gate)** — viewer < operator < manager < admin:
  - Task `open` chỉ owner + admin quét được; legacy `createdBy='web'` fail-open.
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
- **Dán danh sách mã** — dán hàng loạt mã NV, 1 `setValues` batch, dedupe, clamp 1000, báo mã lỗi.
- **Kết thúc task** → NV chưa quét gán **Vắng** (modal confirm); **Mở lại** → về Điểm danh.
- **Counters tức thì** — Đã quét / Chưa / Dư, queue nền + optimistic.
- **A11y** — skip-link, focus trap, `prefers-contrast`, phản hồi không dùng `alert()`.

## Kiến trúc & cấu trúc dự án

```
RollCall_2/
├── appsscript.json         # manifest + webapp block
├── Code.gs                # doGet (template) + 19 API endpoint *Api + editor tools
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
├── tests/                 # 145 unit tests node --test
├── scripts/               # build-local.js, cdp-helper.js, audit-* (css/gs/style/ui)
├── skills/                # skill chuẩn SKILL.md — project-skill · ui-ux-audit · audit-webapp-optimize · review-gas-failure-modes · debug-systematic
└── docs/                  # deploy-codespace-actions.md
```

**Luồng dữ liệu:** Client (`app-*.html`) gọi `google.script.run` → Server (`Code.gs` + các `*Service`/`*Repo`) đọc/ghi 4 sheet qua `Spreadsheet.gs` + cache versioned.

## Chạy & kiểm thử

```bash
npm test                        # 145/145 unit tests (node:test)
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
- ✅ 145/145 unit tests + 11/11 CDP local mock.
- ✅ Mobile nhất quán: task/scan/staff/reports thành thẻ card 2 cột đồng bộ; a11y AA (contrast token, touch ≥44px); skill `ui-ux-audit` — audit UI/UX toàn diện 1 lần (design language + WCAG + perf + verify tự động).

---

**Spec chi tiết:** [`Spec — RollCall v2.md`](Spec%20—%20RollCall%20v2.md) · **Repo:** `van90bg/attendance-portal` · **Deploy guide:** [docs/deploy-codespace-actions.md](docs/deploy-codespace-actions.md)
