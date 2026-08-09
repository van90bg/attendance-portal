# Project Skill — Attendance Portal (RollCall v2)

> Bản skill đóng gói cho AI agent làm việc trong repo `RollCall_2_deploy` (GitHub: `van90bg/rollcall-kiosk-v2x`).
> Dùng khi: sửa GAS kiosk/portal này — bất kỳ edit nào (UI, server, tests, docs).
> Nguồn: skill Hermes `rollcall-kiosk` (đồng bộ định kỳ). Nếu mâu thuẫn, Hermes skill là nguồn mới nhất.

## 1. Repo facts

- Local: `C:\Users\Van90BG\Documents\AppScript\RollCall_2_deploy` · Remote `main` (CI self-clasp).
- **User rule: agent commit+push GitHub — KHÔNG tự clasp push/deploy.** CI deploy trễ → luôn check SHA thật trước khi kết luận bug.
- Test: `npm run test` = 78 tests (node:test, chỉ pure logic ScanLogic/CsvUtil — không cover GAS API).
- File chính: `index.html` (toàn bộ UI, ~198KB, UTF-8 + **CRLF**).

## 2. Attendance Portal — shell hiện tại (2026-08-09)

App scope mở rộng: quản lý chấm công, không chỉ điểm danh. Layout: `<header>` (controls: userEmail · net-dot · 🔊 · ⟳ — ĐÃ BỎ 📋/ⓘ) > `.app-shell` (flex) = `#sidebar` (240↔48px, icon SVG đơn sắc currentColor, KHÔNG side-head, nút thu gọn `☰`) + `#main-content`.

Router: `selectPage(page)` + `PAGE_VIEWS = { home:'viewHome', stats:'viewStats', attendance:'viewList', data:'viewStaff', about:'aboutView' }`. `initSidebar()` + `selectPage('home')` trong DOMContentLoaded. Lưu ý `showSection` ẩn **danh sách cố định** — thêm view nào phải thêm vào đó.

- viewHome: hero logo local (`sea-logo.svg`/`spx-express.svg`) + tên + đồng hồ realtime (`renderHomeClock`, Intl Asia/Ho_Chi_Minh).
- viewStats: pivot fullscreen (tabs Team×Ca · BPO · OS + station filter `#statsStation`).
- viewStaff (page key data): bảng StaffData fullscreen (search+count).
- View mới phải vào mảng `repairViewParents()['viewHome','viewStats','viewStaff','aboutView','viewScan','viewList']`.

## 3. Architecture mental model (đọc TRƯỚC mọi fix)

- Task 2-phase: `open` (timeRef/Giờ có mặt) → `attend` (timeScan/Giờ quét) → `done`.
- `logRow.status`: PENDING(-) · PRESENT(Có mặt) · ABSENT(Vắng) · EXTRA(Dư). **Epoch là nguồn sự thật**.
- `classifyScan(cfg,task,logRows,staffId)` → `{action:update|append|reject, phase, field, status}`.
- `reopenTask` → ATTEND (không quay OPEN), client recompute phase từ status.
- ROSTER: task reconcile created → status ATTEND luôn (pre-fill); FREE (noList) → OPEN.
- **NO LIST quy tắc phase2**: NV lạ phase2 → EXTRA (không PRESENT). Client `optimistic status` = mirror server.

## 4. Deterministic editing (bắt buộc trên index.html)

- Fuzzy patch BANNED; sed/echo trong bash làm hỏng VN+CRLF.
- Python pattern (đọc/ghi với `newline=''`, `encoding='utf-8-sig'`, anchor literal `\r\n`).
- Khối lớn: viết block mới sang file tạm `.txt` rồi ghép bằng index (tránh tool-call >8K token).
- Sau mọi edit: verify CRLF (LF-only==0, normalize nếu cần) + JS parse `new Function` + CSS balance.
- **Write nhỏ nhất, parse trước write** — nếu `assert count==0` → DỪNG, không ghi (file giữ nguyên).

## 5. Pitfall checklist (2026-08-09)

- `.hidden { display:none !important; }` — tránh ID rule thắng class.
- `--header-h: 59px` đo thật (từng là 53 → scroll 6px).
- `taskListTable` không nằm trong `#taskSkeleton` (parent chain check).
- Card stretch `flex:1` tạo trắng → card auto height; `.table-wrap { max-height: calc(100vh - 320px); }`.
- Scan layout chuẩn `.scan-layout > .scan-col-left(480)+.scan-col-right` — card phải ở cột phải.
- StaffData header = 20 tên cột sheet tiếng Anh; Clock format `H:mm:ss` qua `fmtClockHMS` (giờ không pad: 7:05:30).
- App title đồng bộ 4 chỗ: `<title>`, brandTitle, `Config.gs UI_LABELS.APP_TITLE`, mock cả `meta.appTitle`+`labels.APP_TITLE`.
- AboutView: back button `selectPage('home')`, không `showSection('viewList')`.
- role gate phase Mở: `permission` tươi từ getTaskDetail; `applyScanPermission()` chạy cuối renderScanView.
- Spinner: mọi success handler phải `hideLoadingOverlay()` (don't leave stuck).

## 6. Verify workflow

Logic changes → `npm run test` (78/78). UI-only → parse+CRLF đủ (test không bắt buộc).
CDP: `node scripts/cdp-helper.js open "file:///...index.html?t=N"` — geometry `getBoundingClientRect` là truth; kiểm `document.documentElement.scrollHeight` vs `innerHeight`, section parents (repairViewParents), bảng parent content.
Production bug: check `gh run list --limit 5` **trước** khi kết luận — CI có thể deploy trễ (user test trên GAS build cũ).

## 7. Lệnh hữu ích

```bash
npm test
python -c "data=open('index.html','rb').read(); print('CRLF',data.count(b'\r\n'),'LF-only',data.count(b'\n')-data.count(b'\r\n'))"
# normalize nếu LF-only>0:
python -c "d=open('index.html','rb').read(); open('index.html','wb').write(d.replace(b'\r\n',b'\n').replace(b'\n',b'\r\n'))"
```