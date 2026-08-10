# AGENTS.md — Attendance Portal (RollCall v2)

Hướng dẫn dành cho AI agent làm việc trong repo này. Đọc kỹ trước khi sửa code.

## 1. Dự án là gì

**Attendance Portal** — ứng dụng quản lý chấm công + điểm danh kho SPX Express, chạy trên **Google Apps Script WebApp** + **Google Sheets**. Repo con: `van90bg/rollcall-kiosk-v2x` (private, remote git + CI auto-clasp-push).

- Frontend: **1 file** `index.html` (CSS + HTML + JS inline) — Vanilla, không framework.
- Backend: `Code.gs` `Config.gs` `CsvUtil.gs` `Spreadsheet.gs` `Cache.gs` `StaffDataRepo.gs` `TaskRepo.gs` `LogRepo.gs` `ScanLogic.gs` `ScanService.gs` `TaskService.gs` (Database.gs đã tách thành 5 repo file 2026-08-11).
- Dữ liệu: 4 sheet — Config · StaffData (HR, 20 cột tên tiếng Anh) · AttendanceTask · AttendanceLog.

**Shell UI (sidebar 5 trang):** Trang chủ (viewHome) · Thống kê (viewStats) · Điểm danh (viewList + viewScan từ nút Quét) · Dữ liệu chấm công (viewStaff) · Giới thiệu (aboutView). Sidebar trái collapsible `240px ↔ 48px`, icon đơn sắc SVG, bỏ side-head, nút thu gọn `☰`. Header giữ userEmail · net-dot · âm thanh · Làm mới. Đã bỏ nút 📋/ⓘ cũ khỏi header.

## 2. Quy tắc bất biến (KHÔNG bao giờ vi phạm)

1. **KHÔNG sửa file bằng fuzzy/write_file trực tiếp nếu có tiếng Việt + CRLF.** Chỉ được sửa qua **script deterministic** (xem mục 5). Mọi file trên disk (kể cả .gs — `core.autocrlf=true`: git lưu LF, checkout ra CRLF) dùng **CRLF** — tuyệt đối không tạo LF-only.
2. **User commit + push GitHub, KHÔNG tự clasp push/deploy.** CI tự deploy nhưng trễ — khi user báo bug, KIỂM TRA SHA GAS đang chạy trước (mục 6).
3. **1 issue = 1 commit = 1 push** — gom nhiều edit nhỏ vào 1 script, commit 1-2 lần/batch.
4. **Không commit secrets**: `.clasprc.json`, `.clasp.json` credentials, `codegraph.json`, file tạm verify.
5. **Không đọc/ghi API keys/tokens** — thay `[REDACTED]`.
6. **Kiểm chứng bằng kết quả thực (CDP / npm test)**, không tưởng tượng.

## 3. Cách edit deterministic (BẮT BUỘC)

Pattern chuẩn (Python, `execute_code`):

```python
path = r"..."  # .gs hay index.html
# ĐỌC với newline=''
with open(path, 'r', encoding='utf-8-sig', newline='') as f:
    content = f.read()
# SỬA bằng string replace CHÍNH XÁC, assert count==1 cho từng anchor
# GHI với newline=''
with open(path, 'w', encoding='utf-8-sig', newline='') as f:
    f.write(content)
```

- **String literal trong Python phải khớp CRLF** — file dùng `\r\n`, không dùng raw `\n` trong anchor.
- Khối lớn: tách nhỏ thành file tạm (write_file .txt) rồi ghép bằng index (`content.find(marker)`), tránh tool-call quá lớn.
- Sau mỗi edit HTML: verify `CRLF` — chạy:
  ```bash
  python -c "data=open('index.html','rb').read(); print('CRLF',data.count(b'\r\n'),'LF-only',data.count(b'\n')-data.count(b'\r\n'))"
  ```
  LF-only ≠ 0 → normalize: `data.replace(b'\r\n',b'\n').replace(b'\n',b'\r\n')` + ghi bytes → verify lại.
- After any HTML edit: JS parse `new Function`, CSS brace balance (đếm `{}`=0), npm test nếu đụng logic.

## 4. Kiến trúc lõi (đọc trước khi sửa scan/logic)

- **Task 2 phase**: `task.status` = `open` (ghi Giờ có mặt/timeRef) → `attend` (ghi Giờ quét/timeScan) → `done`.
- `logRow.status`: `PENDING`(-/Chưa điểm danh) · `PRESENT`(Có mặt) · `ABSENT`(Vắng) · `EXTRA`(Dư).
- **Epoch là nguồn sự thật** cho counters/sort (`timeRefEpoch`/`timeScanEpoch` — text "HH:mm:ss" mất ngày qua đêm).
- `classifyScan` xử lý mọi lane (roster/free) — xem `skills/project-skill.md` §"Architecture mental model".
- **Không ghi đè cột lệch trong setValues** — LOG_COLS phải đồng bộ hệt nhau giữa ensureSheets_, methods, migration.
- Dư (EXTRA): NV lạ phase 2 → Dư (KHÔNG phải Có mặt). `optimistic` client phải y hệt server.

## 5. View/UI pitfalls đã đóng (2026-08-09)

- `.hidden { display:none !important }` — ID rule thường thắng class (chồng view).
- `showSection` phải list ĐỦ mọi section mới (viewHome/viewStats...) — đừng quên thêm.
- `repairViewParents()` chạy DOMContentLoaded — nếu parser eject section khỏi `<main>` (CDP: parent=BODY), nó kéo về. Khi thêm view: thêm id vào mảng repair.
- `--header-h: 59px` (header thực); khi cardio không flex giãn → card auto height + `.table-wrap` scroll nội bộ.
- `taskListTable` KHÔNG được nằm trong `#taskSkeleton` (đã fix 2026-08-09).
- Scan layout chuẩn: `.scan-layout > .scan-col-left (480px) + .scan-col-right` — card bảng phải trong `.scan-col-right`, không rớt cuối.
- Giữ sync ID dupl: vd `statsStation` vs statsStation2 — grep id sau split.
- StaffData table header = **tên cột sheet đúng** (`STAFF_TABLE_HEAD` 20 cột tiếng Anh), Clock In/Out dùng `fmtClockHMS` → `H:mm:ss`.
- Sidebar icons: SVG stroke `currentColor` (đơn sắc) — không emoji.

## 6. Workflow — fix & verify

1. Đọc code trước (skill + file) → xác định `P0→P1→P2`.
2. Edit deterministic → verify (parse/CRLF/test).
3. Commit + push GitHub (định dạng `type(scope): mô tả`).
4. **Verify production**: GAS có thể đang chạy SHA cũ — check `gh run list --limit 5` (xem `.head_sha`), đối chiếu git HEAD. Nếu CI trễ: báo user đợi clasp deploy.

## 7. Test & Tools

- `npm run test` → **90/90** bằng `node:test` (cover pure logic ScanLogic/CsvUtil + smoke load toàn bộ .gs với mock GAS — GAS API thật không test được trong Node).
- CDP verify UI: `scripts/cdp-helper.js` (open/eval/shot) — đo `getBoundingClientRect` = geometry là truth, screenshot chỉ để cảm nhận.

## 8. Đọc thêm

- `README.md` — tổng quan cập nhật.
- `Spec — RollCall v2.md` — spec đầy đủ.
- `skills/` — bộ skill đóng gói cho agent:
  - `project-skill.md` — skill dự án ĐẦY ĐỦ (architecture, gotchas, batch/perf, deterministic, pitfalls).
  - `references/` — 3 reference: `architecture-gotchas.md` · `deterministic-batch-runner.md` · `slot-fueled-classification.md`.
  - `audit-webapp-optimize.md` — 3-phase audit (code → UI/UX → optimize), P0/P1/P2, user duyệt trước khi fix.
  - `review-gas-failure-modes.md` — review GAS with confidence scoring + failure modes checklist + MoA option.
  - `debug-systematic.md` — 4-phase root-cause debugging (Iron Law: không fix trước root cause).