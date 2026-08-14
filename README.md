# SPX Điểm Danh (RollCall v2) — Quản lý chấm công & điểm danh

> Hệ thống quản lý thông tin chấm công + điểm danh nhân viên kho (warehouse) bằng barcode, chạy trên **Google Apps Script WebApp** + **Google Sheets**.
> Repo: `van90bg/attendance-portal` · Spec chi tiết: [`Spec — RollCall v2.md`](Spec%20—%20RollCall%20v2.md)

## Tổng quan

**SPX Điểm Danh** là cổng làm việc tập trung thay thế màn hình điểm danh đơn lẻ: sidebar điều hướng 7 trang, dữ liệu nhân sự lấy từ sheet **StaffData** (20 cột chuẩn Att.csv), dữ liệu chấm công lưu tại **AttendanceTask** / **AttendanceLog**.

## Môi trường hoạt động

| Thiết bị | Trải nghiệm |
| :------- | :---------- |
| **Máy tính** | Bảng đầy đủ 13–20 cột; quét bằng barcode scanner (Enter) hoặc nhập tay |
| **Máy tính bảng** | Layout co lại, touch target ≥44px, nút Quét hiển thị |
| **Điện thoại** | Thẻ gọn 3 dòng cho task/NV, bottom nav, toggle mở rộng danh sách NV |

Không cần thiết bị chuyên dụng riêng — mọi luồng (tạo task, quét, điểm danh, kết thúc) thao tác được trên cả 3 loại thiết bị.

## Điều hướng (sidebar trái, collapsible 240px ↔ 48px)

| Mục | Chức năng |
| :--- | :-------- |
| **Trang chủ** | Logo + tên app + đồng hồ thời gian thực (Asia/Ho_Chi_Minh) — màn hình chiếu/điểm danh |
| **Thống kê** | Pivot StaffData theo Team × Contract × Ca (Inbound/Outbound), tab lọc BPO / OS — fullscreen |
| **Điểm danh** | Danh sách task đối chiếu — tạo task, quét giờ có mặt, điểm danh, bàn giao, kết thúc |
| **Báo cáo** | Báo cáo chấm công theo tháng cho từng NV theo email đăng nhập — placeholder (đang xây) |
| **Dữ liệu chấm công** | Toàn bộ StaffData — 20 cột khớp tên sheet, Clock In/Out format `H:mm:ss`, tìm mã/tên/agency |
| **Cấu hình** | Trang Config Admin (chỉ editor) — đọc/ghi settings qua SettingsService: Station/Ca/Team/Department mặc định + roleMap phân quyền |
| **Giới thiệu** | Hướng dẫn sử dụng và thông tin kỹ thuật |

## Tính năng

- **Tạo task 2 chế độ** — modal dropdown Station · Ca · Team · Ngày; badge số NV; **Quét tự do (FREE)** không cần danh sách
- **2-phase quét** — phase **Mở** ghi Giờ có mặt, phase **Điểm danh** ghi Giờ quét:
  - Task Đối chiếu: pre-fill Giờ có mặt, quét = Có mặt / Đã điểm danh / Dư
  - Task FREE: quét lần 1 xây danh sách, bấm **Chuyển điểm danh** → quét lần 2; NV lạ → Dư
- **Role gate (phase Mở)** — task `open` chỉ owner + admin quét được; legacy `createdBy='web'` fail-open
- **Role gate (quản trị)** — F-search NV (`searchLogsByStaffApi`, lịch sử chấm công cá nhân) chỉ manager+; `getStaffStatsApi` operator+; settings editor-only
- **Sidebar 7 mục** — thu gọn icon `☰` (48px), mặc định mở; mục Cấu hình (chỉ editor) ẩn theo meta.isEditor; đã bỏ nút 📋/ⓘ khỏi header
- **Dán danh sách mã** — dán hàng loạt mã NV, 1 `setValues` batch, dedupe, clamp 1000, báo mã lỗi
- **Kết thúc task** → NV chưa quét gán **Vắng** (modal confirm); **Mở lại** → về Điểm danh
- **Counters tức thì** — Đã quét / Chưa / Dư, queue nền + optimistic
- **A11y** — skip-link, focus trap, `prefers-contrast`, phản hồi không dùng `alert()`

## Cấu trúc dự án

```
RollCall_2/
├── appsscript.json         # manifest + webapp block
├── Code.gs                # doGet (template) + 17 API endpoint *Api + editor tools
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
├── app-core.html          # JS client (module 1/7) — state, utils, boot, nav, clock
├── app-stats.html         # JS client (module 2/7) — viewStats
├── app-staff.html         # JS client (module 3/7) — viewStaff + funnel
├── app-modals.html        # JS client (module 4/7) — paste/create/confirm modals
├── app-config.html        # JS client (module 5/7) — viewConfig admin
├── app-tasks.html         # JS client (module 6/7) — task list + search + create
├── app-scan.html          # JS client (module 7/7) — scan view + queue + actions
├── mock/mock-google.js    # mock GAS cho dev local
├── test-fixtures/         # CSV mẫu cho test
├── tests/                 # 124 unit tests node --test
├── scripts/
│   ├── build-local.js     # gộp template 3 file → index.local.html (test local)
│   ├── cdp-helper.js      # CDP verify UI (geometry là truth)
│   ├── test-local-mock.js # tự động test UI local mock qua CDP (11/11)
│   ├── audit-css.js       # rà dead CSS 3 file template (exit 1 nếu có dead; --full xem dynamic)
│   ├── audit-gs.js        # rà hàm/const/API dead trong 14 file .gs (exit 1 nếu có dead/treo)
│   ├── audit-style.js     # rà computed style class chung qua CDP (--strict exit 1 nếu lệch)
│   └── audit-ui.js         # audit CDP 7 view x 4 viewport — layout/scroll/nav/card (exit 1 nếu FAIL; --quick)
├── skills/               # skill chuẩn SKILL.md (Agent Skills format — tái sử dụng đa công cụ AI)
└── docs/                  # deploy-codespace-actions.md (how-to deploy)
```

## Cách chạy

```bash
npm test                        # 124/124 pass
node scripts/test-local-mock.js # UI test local mock qua CDP (11/11)
```

Mock local (trình duyệt không render GAS template → gộp trước):

```bash
node scripts/build-local.js     # → index.local.html
node scripts/audit-css.js         # rà dead CSS (217 class — 0 dead hiện tại; --full xem class nối chuỗi)
node scripts/audit-gs.js          # rà dead .gs (109 hàm — 0 dead hiện tại)
node scripts/audit-style.js --strict # rà style class chung (33 class — 0 lệch thật hiện tại; cần Chrome)
node scripts/audit-ui.js            # audit CDP toàn diện (110 check — 0 FAIL hiện tại; --quick chỉ desktop)
```

Rồi mở `index.local.html` bằng browser (mock tự nạp khi không có `google.script.run`).

Deploy (chi tiết: `docs/deploy-codespace-actions.md`):

```bash
clasp login
clasp push -f
clasp deploy
```

> **⚠️ Học hỏi deploy:** `PUT /deployments/{id}` đứt `entryPoints` → `/exec` 404. Chỉ dùng `clasp deploy`; sau đó verify URL `/exec` bằng curl.

## Quy ước

- Cột sheet: tiếng Anh · UI: tiếng Việt · Constants gom ở `Config.gs`
- Cache versioned (`rc2_*_vN`) — thay đổi có invalidate
- Mọi ghi log/đổi status → `invalidateTaskDetailCache_(taskId)`
- Frontend GAS template: `index.html` + `styles.html` (CSS) + **7 module JS `app-*.html`** (tách từ app.html 2026-08-13 — index.html include tuần tự, chung global scope) — GAS chỉ nhận `.gs`/`.html`; doGet dùng `createTemplateFromFile` + `include()`
- `index.html` KHÔNG BOM — BOM đầu output GAS sinh khoảng trống phía trên header (lesson 9982293); deterministic write dùng `utf-8` (KHÔNG `sig`)

## Trạng thái (2026-08-11)

- ✅ Portal shell: sidebar 7 trang; trang chủ logo + đồng hồ; viewReports placeholder
- ✅ Tách frontend 3 file GAS template (index/styles/app) + `build-local.js` cho test local
- ✅ Fix BOM regression — khoảng trống phía trên header trên GAS + guard test 3 file không BOM
- ✅ Cấu hình Admin (SettingsService) + role gate (manager/operator/editor) + pre-select mặc định
- ✅ Dọn rác repo (sketches/mockup cũ/docs planning) — `docs/` còn deploy guide
- ✅ 124/124 test + 11/11 CDP local mock; ⏳ viewReports (báo cáo chấm công tháng) đang xây
- ✅ Vệ sinh (2026-08-13): bỏ BOM 3 file .gs + README/AGENTS (guard mới `tests/eol-bom.test.js`), chuẩn hóa CRLF qua `.gitattributes` (`*.gs` + 3 template `text eol=crlf`), untrack `.clasp.json`, xóa ID production khỏi docs/Spec
- ✅ Tách module client (2026-08-13): `app.html` 3665 dòng → 7 module `app-*.html` (core/stats/staff/modals/config/tasks/scan)
- ✅ Đổi tên (2026-08-14): app **Attendance Portal** → **SPX Điểm Danh**; repo `rollcall-kiosk-v2x` → `attendance-portal`; bỏ toàn bộ khái niệm "kiosk" (chỉ dùng máy tính / máy tính bảng / điện thoại)
