# Attendance Portal (RollCall v2) — Quản lý chấm công & điểm danh

> Hệ thống quản lý thông tin chấm công + điểm danh nhân viên kho (warehouse) bằng barcode, chạy trên **Google Apps Script WebApp** + **Google Sheets**.
> Repo: `van90bg/rollcall-kiosk-v2x` · Spec chi tiết: [`Spec — RollCall v2.md`](Spec%20—%20RollCall%20v2.md)

## Tổng quan

**Attendance Portal** là cổng làm việc tập trung thay thế màn hình điểm danh đơn lẻ: sidebar điều hướng 5 trang, dữ liệu nhân sự lấy từ sheet **StaffData** (20 cột chuẩn Att.csv), dữ liệu chấm công lưu tại **AttendanceTask** / **AttendanceLog**.

## Điều hướng (sidebar trái, collapsible 240px ↔ 48px)

| Mục | Chức năng |
| :--- | :-------- |
| **Trang chủ** | Logo + tên app + đồng hồ thời gian thực (Asia/Ho_Chi_Minh) — màn hình kiosk/chiếu |
| **Thống kê** | Pivot StaffData theo Team × Contract × Ca (Inbound/Outbound), tab lọc BPO / OS — fullscreen |
| **Điểm danh** | Danh sách task đối chiếu — tạo task, quét giờ có mặt, điểm danh, bàn giao, kết thúc |
| **Dữ liệu chấm công** | Toàn bộ StaffData — 20 cột khớp tên sheet, Clock In/Out format `H:mm:ss`, tìm mã/tên/agency |
| **Giới thiệu** | Hướng dẫn sử dụng và thông tin kỹ thuật |

## Tính năng

- **Tạo task 2 chế độ** — modal dropdown Station · Ca · Team · Ngày; badge số NV; **Quét tự do (FREE)** không cần danh sách
- **2-phase quét** — phase **Mở** ghi Giờ có mặt, phase **Điểm danh** ghi Giờ quét:
  - Task Đối chiếu: pre-fill Giờ có mặt, quét = Có mặt / Đã điểm danh / Dư
  - Task FREE: quét lần 1 xây danh sách, bấm **Chuyển điểm danh** → quét lần 2; NV lạ → Dư
- **Role gate (phase Mở)** — task `open` chỉ owner + admin quét được; legacy `createdBy='web'` fail-open
- **Sidebar 5 mục** — thu gọn icon `☰` (48px), mặc định mở; đã bỏ nút 📋/ⓘ khỏi header
- **Dán danh sách mã** — dán hàng loạt mã NV, 1 `setValues` batch, dedupe, clamp 1000, báo mã lỗi
- **Kết thúc task** → NV chưa quét gán **Vắng** (modal confirm); **Mở lại** → về Điểm danh
- **Counters tức thì** — Đã quét / Chưa / Dư, queue nền + optimistic
- **A11y** — skip-link, focus trap, `prefers-contrast`, phản hồi không dùng `alert()`

## Cấu trúc dự án

```
RollCall_2/
├── appsscript.json         # manifest + webapp block
├── Code.gs                # doGet + verify + pasteCodesApi
├── Config.gs              # hằng số sheet/cột/cache/status/labels (APP_TITLE)
├── CsvUtil.gs             # parse CSV + isValidBarcodeId()
├── Spreadsheet.gs         # getSheet_/getSpreadsheet_/ensureSheets_ (bootstrap)
├── Cache.gs               # cache wrapper version-key + format thời gian
├── StaffDataRepo.gs       # đọc/ghi StaffData (index/list/overwrite)
├── TaskRepo.gs            # đọc/ghi AttendanceTask + cache task
├── LogRepo.gs             # đọc/ghi AttendanceLog + cache log (batch)
├── ScanLogic.gs           # phân loại scan 2-phase (pure)
├── ScanService.gs         # scanStaff — guard + LockService
├── TaskService.gs         # task CRUD + transition + kết thúc
├── index.html             # toàn bộ UI (sidebar + 5 views) — 1 file
├── mock/mock-google.js    # mock GAS cho dev local
├── tests/                 # unit tests node --test
└── scripts/cdp-helper.js  # CDP verify UI
```

## Cách chạy

```bash
npm test          # 98/98 pass
```

Mock local: mở `index.html` bằng browser (mock tự nạp khi không có `google.script.run`).

Deploy:

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

## Trạng thái (2026-08-09)

- ✅ Portal shell: sidebar + 5 pages; trang chủ logo + đồng hồ
- ✅ Thống kê / Dữ liệu chấm công: tách view, staffTable 20 cột `H:mm:ss`
- ✅ Fix DOM `repairViewParents()` → view bị đẩy về main
- ✅ Fix task list: table lồng skeleton
- ✅ Title đồng bộ `Attendance Portal`; Giới thiệu viết lại
- ✅ 98/98 test (đã tách Database.gs → 5 repo file + smoke test load toàn bộ .gs + doGet wiring + SettingsService đọc/ghi Config sheet); ⏳ P2 QA prod