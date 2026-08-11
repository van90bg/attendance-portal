# AGENTS.md — Attendance Portal (RollCall v2)

Hướng dẫn dành cho AI agent làm việc trong repo này. Đọc kỹ trước khi sửa code.

## 1. Dự án là gì

**Attendance Portal** — ứng dụng quản lý chấm công + điểm danh kho SPX Express, chạy trên **Google Apps Script WebApp** + **Google Sheets**. Repo con: `van90bg/rollcall-kiosk-v2x` (private, remote git + CI auto-clasp-push).

- Frontend: **3 file GAS template** — `index.html` (HTML + `<?!= include() ?>`) + `styles.html` (CSS) + `app.html` (JS) — Vanilla không framework. `doGet` dùng `createTemplateFromFile('index').evaluate()` + helper `include(name)`. Test local: `node scripts/build-local.js` gộp 3 file → `index.local.html` (file:// không render template).
- Backend: `Code.gs` `Config.gs` `CsvUtil.gs` `Spreadsheet.gs` `Cache.gs` `StaffDataRepo.gs` `TaskRepo.gs` `LogRepo.gs` `ScanLogic.gs` `ScanService.gs` `TaskService.gs` `Auth.gs` `Debug.gs` `SettingsService.gs` (Database.gs đã tách thành 5 repo file 2026-08-11).
- Dữ liệu: 4 sheet — Config · StaffData (HR, 20 cột tên tiếng Anh) · AttendanceTask · AttendanceLog.

**Shell UI (sidebar 7 trang):** Trang chủ (viewHome) · Thống kê (viewStats) · Điểm danh (viewTasks + viewScan từ nút Quét) · Báo cáo (viewReports — placeholder) · Dữ liệu chấm công (viewStaff) · Cấu hình (viewConfig — chỉ editor, ẩn theo meta.isEditor) · Giới thiệu (viewAbout). Toolbar đầu MỌI view dùng chung 1 class `.view-topbar` (+ `.view-topbar-title`) — List/Scan/Stats/Staff/Config (rename 2026-08-11, hết `.scan-topbar`/`.view-toolbar`). Ô tìm NV/task (mã Ops/R2026) nằm TRONG viewTasks: `#listSearch` + `runListSearch()` (đã rời header). Sidebar trái collapsible `240px ↔ 48px`, icon đơn sắc SVG, bỏ side-head, nút thu gọn `☰`. Header giữ userEmail · net-dot · âm thanh · Làm mới. Đã bỏ nút 📋/ⓘ cũ khỏi header.

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
path = r"..."  # .gs hay index.html/styles.html/app.html
# ĐỌC với newline='' — dùng utf-8-sig (strip BOM nếu file cũ có)
with open(path, 'r', encoding='utf-8-sig', newline='') as f:
    content = f.read()
# SỬA bằng string replace CHÍNH XÁC, assert count==1 cho từng anchor
# GHI với newline='' — BẮT BUỘC dùng utf-8 (KHÔNG sig): utf-8-sig khi write THÊM BOM
# (EF BB BF) → index.html serve qua GAS sinh khoảng trống phía trên header
# (commit 9982293 lesson 2026-08-11).
with open(path, 'w', encoding='utf-8', newline='') as f:
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
- **Role (2026-08-11)**: viewer<operator<manager<admin — ROLES (Config.gs) + roleMap (Config sheet qua SettingsService), đọc qua Auth.getRole_; gate chuẩn `requireRole_(min)`. operator là MẶC ĐỊNH — không được phá luồng kiosk (anonymous = operator). Gate hiện tại: getStaffStatsApi operator+ · searchLogsByStaffApi (lịch sử chấm công NV) manager+ · settings editor-only. Khi thêm API quản trị: gate TRONG try (pattern DEFENSE).

## 5. View/UI pitfalls đã đóng (2026-08-09)

- `.hidden { display:none !important }` — !important để thắng MỌI rule hiển thị khác (tránh section chồng view).
- `showSection` phải list ĐỦ mọi section (viewHome/viewStats/viewTasks/viewScan/viewStaff/viewConfig/viewReports/viewAbout) — đừng quên thêm.
- `repairViewParents()` chạy DOMContentLoaded — nếu parser eject section khỏi `<main>` (CDP: parent=BODY), nó kéo về. Khi thêm view: thêm id vào mảng repair (`['viewHome','viewStats','viewStaff','viewAbout','viewScan','viewTasks','viewConfig','viewReports']`).
- `--header-h: 59px` (header thực); khi cardio không flex giãn → card auto height + `.table-wrap` scroll nội bộ.
- `taskListTable` KHÔNG được nằm trong `#taskSkeleton` (đã fix 2026-08-09).
- Scan layout chuẩn: `.scan-layout > .scan-col-left (480px) + .scan-col-right` — card bảng phải trong `.scan-col-right`, không rớt cuối.
- Giữ sync ID dupl: vd `statsStation` vs statsStation2 — grep id sau split.
- StaffData table header = **tên cột sheet đúng** (`STAFF_TABLE_HEAD` 20 cột tiếng Anh), Clock In/Out dùng `fmtClockHMS` → `H:mm:ss`.
- Sidebar icons: SVG stroke `currentColor` (đơn sắc) — không emoji.
- **Chuẩn tên view (2026-08-11)**: `viewTasks` (danh sách task — sidebar 'Điểm danh') · `viewScan` · `viewHome` · `viewStats` · `viewStaff` · `viewConfig` · `viewReports` (Báo cáo — placeholder) · `viewAbout` — đồng bộ prefix `view*`. KHÔNG dùng tên cũ: viewList · aboutView · headerSearch · globalSearch · runSearch · scan-topbar · view-toolbar.
- **Toolbar chung**: 1 class `.view-topbar` cho 5 view (List/Scan/Stats/Staff/Config) — sticky theo `--header-h`, `.stuck` đổ bóng; JS sync dùng `querySelectorAll('.view-topbar')`.
- **Search dùng chung `.list-search` (2026-08-11, d6b0516)**: viewTasks `#listSearch` + `#btnListSearch` + `#btnListSearchClear` nằm trong `task-list-toolbar` (hàng DANH SÁCH TASK trong card, `margin-left:auto` ép phải kể cả wrap) — KHÔNG còn trong `.view-topbar`; viewStaff `#staffSearch` + viewScan `#scanSearch` cũng dùng chung class `.list-search` (đã xóa `.att-search`). Hàm `runListSearch()` (nhánh con `runSearchStaff`/`runSearchTask` GIỮ tên) + `onListSearchKeydown` (Escape clear). CSS `.list-search` (style sáng hợp card).
- **Spinner toàn màn**: `showModalSpin` có guard — nếu `#loadingOverlay` đang hiện thì KHÔNG mở spinModal (tránh 2 spinner đè nhau; khởi động refreshAll mở spinModal trong lúc overlay còn hiện — fix 2026-08-11).
- **Scroll trong card**: các view dùng `.table-wrap`/`.stats-table-wrap` cuộn nội bộ; `#viewAbout .card` + `#viewStats .card` giới hạn `max-height` + cuộn trong (đồng bộ 2026-08-11) — giữ `pageScrolls:false`.

## 6. Workflow — fix & verify

1. Đọc code trước (skill + file) → xác định `P0→P1→P2`.
2. Edit deterministic → verify (parse/CRLF/test).
3. Commit + push GitHub (định dạng `type(scope): mô tả`).
4. **Verify production**: GAS có thể đang chạy SHA cũ — check `gh run list --limit 5` (xem `.head_sha`), đối chiếu git HEAD. Nếu CI trễ: báo user đợi clasp deploy.

## 7. Test & Tools

- `npm run test` → **114/114** bằng `node:test` (cover pure logic ScanLogic/CsvUtil + smoke load toàn bộ .gs với mock GAS + contract mock↔server + role — GAS API thật không test được trong Node). `index-html-parse` + `test-local-mock` tự build template qua `scripts/build-local.js` → `index.local.html` trước khi chạy.
- CDP verify UI: `scripts/cdp-helper.js` (open/eval/shot) — đo `getBoundingClientRect` = geometry là truth, screenshot chỉ để cảm nhận.
- Dead CSS audit: `node scripts/audit-css.js` — rà class selector styles.html đối chiếu index.html + app.html (class="" / classList / className literal + nối chuỗi / querySelector / getElementsByClassName) → phân loại DEAD chắc chắn vs DYNAMIC; **exit 1 nếu có dead** (chạy sau mỗi batch CSS). `--full` in thêm class nối chuỗi.
- Dead GAS audit: `node scripts/audit-gs.js` — rà hàm/const top-level 14 file .gs đối chiếu toàn bộ nguồn (gs + index/app + mock + tests + scripts); phân loại **DEAD** (không ai gọi) + **API TREO** (*Api server có nhưng client không gọi — drift mock↔server↔client); **exit 1 nếu có dead/treo** (chạy sau mỗi batch server). Entry runtime GAS (doGet/doPost/include) không tính.
- Style audit: `node scripts/audit-style.js [--strict]` — boot Chrome headless + đo computed style mọi class chung (SHARED_CLASSES trong script) → in class lệch fingerprint; `--strict` exit 1 nếu có lệch ngoài ALLOWED_DRIFT (chủ đích: modal 44px touch / btn-sm / cfg-card / flabel 56px / card+table-wrap flex scan). Bỏ element display:none (nhiễu min-height 0px). Chạy sau batch UI đổi style; cần Chrome.
- UI audit toàn diện: `node scripts/audit-ui.js` — boot Chrome headless + đo geometry 7 view (home/tasks/scan/stats/staff/config/reports) x 4 viewport (desktop 1384 · tablet 1024 · mobile 390/375): view hiển thị · trang không cuộn · nav không che · card vừa màn hình (đo theo body height — KHÔNG innerHeight: headless mobile emulation báo 1007 nhưng body 844 → gap giả) · bảng có dữ liệu; viewScan mobile miễn trừ gap âm (section cuộn trong). `--quick` chỉ desktop (~20s); **exit 1 nếu có FAIL** (chạy sau mỗi batch UI thay đổi layout/touch). Cần Chrome.

## 8. Đọc thêm

- `README.md` — tổng quan cập nhật.
- `Spec — RollCall v2.md` — spec đầy đủ.
- `skills/` — bộ skill đóng gói cho agent:
  - `project-skill.md` — skill dự án ĐẦY ĐỦ (architecture, gotchas, batch/perf, deterministic, pitfalls).
  - `references/` — 3 reference: `architecture-gotchas.md` · `deterministic-batch-runner.md` · `slot-fueled-classification.md`.
  - `audit-webapp-optimize.md` — 3-phase audit (code → UI/UX → optimize), P0/P1/P2, user duyệt trước khi fix.
  - `review-gas-failure-modes.md` — review GAS with confidence scoring + failure modes checklist + MoA option.
  - `debug-systematic.md` — 4-phase root-cause debugging (Iron Law: không fix trước root cause).