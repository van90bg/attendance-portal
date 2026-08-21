# AGENTS.md — SPX Điểm Danh (RollCall v2)

Hướng dẫn dành cho AI agent làm việc trong repo này. Đọc kỹ trước khi sửa code.

## 1. Dự án là gì

**SPX Điểm Danh** — ứng dụng quản lý chấm công + điểm danh kho SPX Express, chạy trên **Google Apps Script WebApp** + **Google Sheets**. Repo con: `van90bg/attendance-portal` (private, remote git + CI auto-clasp-push).

- Frontend: **GAS template** — `index.html` (HTML + `<?!= include() ?>`) + `styles.html` (CSS) + **9 module JS `app-*.html`** (core/stats/staff/modals/config/tasks/scan/reports/admin — tách từ app.html 2026-08-13; index.html include tuần tự, chung global scope) — Vanilla không framework. `doGet` dùng `createTemplateFromFile('index').evaluate()` + helper `include(name)`. Test local: `node scripts/build-local.js` resolve MỌI `<?!= include() ?>` → `index.local.html` (file:// không render template).
- Backend: `Code.gs` `Config.gs` `CsvUtil.gs` `Spreadsheet.gs` `Cache.gs` `StaffDataRepo.gs` `TaskRepo.gs` `LogRepo.gs` `ScanLogic.gs` `ScanService.gs` `TaskService.gs` `Auth.gs` `Debug.gs` `SettingsService.gs` `AuditRepo.gs` `ReportRepo.gs` `ReportService.gs` (Database.gs đã tách thành 5 repo file 2026-08-11).
- Dữ liệu: 4 sheet — Config · StaffData (HR, 20 cột tên tiếng Anh) · AttendanceTask · AttendanceLog.

**Shell UI (sidebar 8 trang):** Trang chủ (viewHome) · Thống kê (viewStats) · Điểm danh (viewTasks + viewScan từ nút Quét) · Báo cáo (viewReports) · Quản trị (viewAdmin — chỉ admin, ẩn theo meta.role) · Dữ liệu chấm công (viewStaff) · Cấu hình (viewConfig — chỉ editor, ẩn theo meta.isEditor) · Giới thiệu (viewAbout). **Phân quyền view (2026-08-20):** viewer+ = viewTasks/viewScan/viewHome/viewAbout; manager+ = viewStats/viewStaff; operator+ = viewReports (báo cáo chính mình); admin = viewAdmin; editor = viewConfig (bảng đầy đủ ở README §Phân quyền + Spec §5.6). Toolbar đầu MỌI view dùng chung 1 class `.view-topbar` (+ `.view-topbar-title`) — List/Scan/Stats/Staff/Config/Reports/Admin (rename 2026-08-11, hết `.scan-topbar`/`.view-toolbar`). Ô tìm NV/task (mã Ops/R2026) nằm TRONG viewTasks: `#listSearch` + `runListSearch()` (đã rời header). Sidebar trái collapsible `240px ↔ 48px`, icon đơn sắc SVG, bỏ side-head, nút thu gọn `☰`. Header giữ userEmail · net-dot · âm thanh · Làm mới. Đã bỏ nút 📋/ⓘ cũ khỏi header.

## 2. Quy tắc bất biến (KHÔNG bao giờ vi phạm)

1. **KHÔNG sửa file bằng fuzzy/write_file trực tiếp nếu có tiếng Việt + CRLF.** Chỉ được sửa qua **script deterministic** (xem mục 5). Mọi file trên disk (kể cả .gs — `core.autocrlf=true`: git lưu LF, checkout ra CRLF) dùng **CRLF** — tuyệt đối không tạo LF-only.
2. **Mỗi thay đổi + fix: verify xong → commit + push GitHub NGAY** (1 issue = 1 commit = 1 push, format `type(scope): mô tả`). KHÔNG tự clasp push/deploy — CI tự deploy nhưng trễ — khi user báo bug, KIỂM TRA SHA GAS đang chạy trước (mục 6).
3. **1 issue = 1 commit = 1 push** — gom nhiều edit nhỏ vào 1 script, commit 1-2 lần/batch. **Tự commit + push NGAY sau mỗi đợt chỉnh sửa issue — không chờ user yêu cầu (quy tắc dự án thay thế mặc định "không commit khi chưa được hỏi").**
4. **Không commit secrets**: `.clasprc.json`, `.clasp.json` credentials, `codegraph.json`, file tạm verify.
5. **Không đọc/ghi API keys/tokens** — thay `[REDACTED]`.
6. **Kiểm chứng bằng kết quả thực (CDP / npm test)**, không tưởng tượng.
7. **KHÔNG thêm comment rác vào code khi fix/patch** — cấm comment dạng lịch sử/date/marker vòng fix:
   `FIX(YYYY-MM-DD): …` · `P1/P2/P3 (date): …` · `B3/I5/F7: …` · restatement lặp lại đúng lời gọi liền kề.
   Chúng lỗi thời ngay khi có fix/patch/tính năng khác — lịch sử đã nằm trong git log + commit message.
   Chỉ ghi comment khi CÓ GIÁ TRỊ: giải thích TẠI SAO (rationale non-obvious), cảnh báo gotcha "đừng regress",
   khớp nối wire/server ("KHỚP server X") — viết ngắn, KHÔNG kèm date/commit hash.
8. **KHÔNG hardcode màu/spacing/type/radius ngoài `:root`** — styles.html + inline style/JS phải dùng token
   (92 token: màu semantic · `--space-1..8` 4pt grid · `--text-3xs..8xl` px-exact · `--radius-2xs..full`).
   Ngoại lệ chủ đích: micro 1-3px trong component · `#fff`/`#000` · fallback `var(--x, #hex)` · px đo runtime (width/scroll).
   Thêm màu/spacing mới = thêm token vào `:root`, KHÔNG hardcode. (Audit 2026-08-17: 0 hex/px rời rạc còn lại.)
9. **MỌI thay đổi (code/UI/API/flow) phải cập nhật README.md + `Spec — RollCall v2.md` trong CÙNG commit** — số liệu
   (test count, file count, API, sheets), bảng phân quyền, tên view/API, flow. Đừng để docs drift khỏi code (tiền lệ
   audit 2026-08-17: 138→144 tests, 9 view, 19 API, 7 sheets — đã đồng bộ).
10. **KHÔNG tạo hàm trùng lặp — 1 logic = 1 nơi (Single Source of Truth).** Trước khi tạo hàm mới:
    - `grep -rn "function <tên>" --include="*.gs" --include="*.html"` + `grep -rn "<keyword>"` (vd `normalize`, `formatTime`, `cache`, `filterStaff`, `computeCounters`) — nếu đã có → **reuse**, không copy.
    - **Map bắt buộc:** `normalize*` → `CsvUtil.gs:55` · `formatTime/formatDate` → `Cache.gs:112` · `cache/cachedJson` → `Cache.gs:27` · `filter/dedupe/buildStation` → `CsvUtil.gs:242` · `classifyScan/computeCounters/findLogRow` → `ScanLogic.gs:37` · `invalidation` → `TaskRepo.gs:68`/`LogRepo.gs:140` — không tạo bản thứ 2.
    - Client/server duplicate (`classifyScan` vs `app-scan.html:35`, `computeCounters` vs `app-scan.html:583`) là **ngoại lệ có chủ đích** — giữ comment `KHỚP server` + guard `tests/scan-drift.test.js`. Thêm duplicate mới ngoài whitelist → P1.
    - Tạo hàm xong → `node scripts/audit-gs.js && npm run test` — audit báo `DEAD`/`API treo` là P0, semantic duplicate (grep ≥2 hit cùng intent) là P1.

## 3. Cách edit deterministic (BẮT BUỘC)

Pattern chuẩn (Python, `execute_code`):

```python
path = r"..."  # .gs hay index.html/styles.html/app-*.html
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

- **Task 2 phase**: `task.status` = `open` (ghi LISTED_AT/timeRef) → `attend` (ghi SCANNED_AT/timeScan) → `done`.
- `logRow.status`: `PENDING`(-/Chưa điểm danh) · `PRESENT`(Có mặt) · `ABSENT`(Vắng) · `EXTRA`(Dư).
- **Epoch là nguồn sự thật** cho counters/sort (`listedAtEpoch`/`scannedAtEpoch` — text "HH:mm:ss" mất ngày qua đêm).
- `classifyScan` xử lý mọi lane (roster/free) — xem `skills/project-skill/SKILL.md` §"Architecture mental model".
- **Không ghi đè cột lệch trong setValues** — LOG_COLS phải đồng bộ hệt nhau giữa ensureSheets_, methods, migration.
- Dư (EXTRA): NV lạ phase 2 → Dư (KHÔNG phải Có mặt). `optimistic` client phải y hệt server.
- **Role (2026-08-11)**: viewer<operator<manager<admin — ROLES (Config.gs) + roleMap (Config sheet qua SettingsService), đọc qua Auth.getRole_; gate chuẩn `requireRole_(min)`. operator là MẶC ĐỊNH — không được phá luồng điểm danh (anonymous = operator). Gate hiện tại: getStaffStatsApi (viewStats/viewStaff) manager+ · getReportsApi (viewReports — báo cáo chính mình) operator+ · searchLogsByStaffApi (lịch sử chấm công NV) manager+ · settings editor-only. Khi thêm API quản trị: gate TRONG try (pattern DEFENSE).
- **Gate ở service layer, KHÔNG chỉ `*Api` wrapper (2026-08-11, M1)**: google.script.run gọi được hàm global trực tiếp — gate chỉ đặt ở `*Api` wrapper bị bypass. MỌI hàm nhận input từ client (kể cả service trung gian như ScanService/TaskService) phải tự `requireRole_(min)` + wrap DEFENSE trong try.
- **Thứ tự ghi fail-safe (2026-08-07+)**: mutation nhiều bước ghi dữ liệu phụ TRƯỚC, trạng thái chính SAU — completeTask: markUnscannedAbsent_ → updateTaskStatus_(DONE); reopenTask: resetAbsentToPending_ → ATTEND; LogRepo: setValues xong mới cache.remove. Fail nửa chừng → retry an toàn (idempotent), không kẹt trạng thái chính.

## 5. View/UI pitfalls đã đóng (2026-08-09)

- `.hidden { display:none !important }` — !important để thắng MỌI rule hiển thị khác (tránh section chồng view).
- `showSection` phải list ĐỦ mọi section (viewHome/viewStats/viewTasks/viewScan/viewStaff/viewConfig/viewReports/viewAdmin/viewAbout) — đừng quên thêm.
- `repairViewParents()` chạy DOMContentLoaded — nếu parser eject section khỏi `<main>` (CDP: parent=BODY), nó kéo về. Khi thêm view: thêm id vào mảng repair (`['viewHome','viewStats','viewStaff','viewAbout','viewScan','viewTasks','viewConfig','viewReports','viewAdmin']`).
- `--header-h: 59px` (header thực); khi cardio không flex giãn → card auto height + `.table-wrap` scroll nội bộ.
- `taskListTable` KHÔNG được nằm trong `#taskSkeleton` (đã fix 2026-08-09).
- Scan layout chuẩn: `.scan-layout > .scan-col-left (480px) + .scan-col-right` — card bảng phải trong `.scan-col-right`, không rớt cuối.
- Giữ sync ID dupl: vd `statsStation` vs statsStation2 — grep id sau split.
- StaffData table header = **tên cột sheet đúng** (`STAFF_TABLE_HEAD` 20 cột tiếng Anh), Clock In/Out dùng `fmtClockHMS` → `H:mm:ss`.
- Sidebar icons: SVG stroke `currentColor` (đơn sắc) — không emoji.
- **Chuẩn tên view (2026-08-11)**: `viewTasks` (danh sách task — sidebar 'Điểm danh') · `viewScan` · `viewHome` · `viewStats` · `viewStaff` · `viewConfig` · `viewReports` (Báo cáo — placeholder) · `viewAbout` — đồng bộ prefix `view*`. KHÔNG dùng tên cũ: viewList · aboutView · headerSearch · globalSearch · runSearch · scan-topbar · view-toolbar.
- **Toolbar chung**: 1 class `.view-topbar` cho 7 view (List/Scan/Stats/Staff/Config/Reports/Admin) — sticky theo `--header-h`, `.stuck` đổ bóng; JS sync dùng `querySelectorAll('.view-topbar')`.
- **Search dùng chung `.list-search` (2026-08-11, d6b0516)**: viewTasks `#listSearch` + `#btnListSearch` + `#btnListSearchClear` nằm trong `task-list-toolbar` (hàng DANH SÁCH TASK trong card, `margin-left:auto` ép phải kể cả wrap) — KHÔNG còn trong `.view-topbar`; viewStaff `#staffSearch` + viewScan `#scanSearch` cũng dùng chung class `.list-search` (đã xóa `.att-search`). Hàm `runListSearch()` (nhánh con `runSearchStaff`/`runSearchTask` GIỮ tên) + `onListSearchKeydown` (Escape clear). CSS `.list-search` (style sáng hợp card).
- **Spinner toàn màn**: `showModalSpin` có guard — nếu `#loadingOverlay` đang hiện thì KHÔNG mở spinModal (tránh 2 spinner đè nhau; khởi động refreshAll mở spinModal trong lúc overlay còn hiện — fix 2026-08-11).
- **Scroll trong card**: các view dùng `.table-wrap`/`.stats-table-wrap` cuộn nội bộ; `#viewAbout .card` + `#viewStats .card` giới hạn `max-height` + cuộn trong (đồng bộ 2026-08-11) — giữ `pageScrolls:false`.
- **Mobile card — rule desktop rò rỉ (2026-08-16)**: rule cột desktop (`#reportsTable td:nth-child(5-9)` text-align:center, specificity 1,1,1) thắng base mobile (`#reportsTable tbody td`, 1,0,2) bất kể thứ tự khai báo → card lệch tông. Ép override bằng selector cao hơn `tbody td:nth-child(n)` (1,2,1) + `text-align:left`.
- **Design token system (2026-08-17)**: toàn bộ màu/spacing/type/radius nằm trong `:root` (92 token — quy tắc 8 §2). Spacing 4pt grid `--space-1..8` · type px-exact `--text-3xs..8xl` · radius `--radius-2xs..full` · màu semantic đủ family (primary/danger/warning/success/amber/badge status/dark-mode). Chi tiết: `skills/ui-ux-audit/component-inventory.md` Nhóm 7 + `skills/project-skill/SKILL.md` §13.

## 6. Workflow — fix & verify

1. Đọc code + `grep` duplicate trước (skill + file + `grep -rn "function <tên>"`) → xác định `P0→P1→P2` (trùng thì reuse, không tạo mới).
2. Edit deterministic → verify (parse/CRLF/test).
3. **Commit + push GitHub NGAY khi xong đợt edit (bắt buộc, không chờ user hỏi)** — định dạng `type(scope): mô tả`.
4. **Verify production**: GAS có thể đang chạy SHA cũ — check `gh run list --limit 5` (xem `.head_sha`), đối chiếu git HEAD. Nếu CI trễ: báo user đợi clasp deploy.
5. **Fix chồng fix gây hồi quy → revert về baseline sạch rồi làm lại** (tiền lệ d0edc7a 2026-08-05: loạt fix chống race xếp chồng làm hỏng → revert cả loạt về hành vi cũ). Không đắp vá tiếp lên nền hỏng.

## 7. Test & Tools

- `npm run test` → **196/196** bằng `node:test` (cover pure logic ScanLogic/CsvUtil + smoke load toàn bộ .gs với mock GAS + contract mock↔server + role — GAS API thật không test được trong Node). `index-html-parse` + `test-local-mock` tự build template qua `scripts/build-local.js` → `index.local.html` trước khi chạy.
- CDP verify UI: `scripts/cdp-helper.js` (open/eval/shot) — đo `getBoundingClientRect` = geometry là truth, screenshot chỉ để cảm nhận.
- Dead CSS audit: `node scripts/audit-css.js` — rà class selector styles.html đối chiếu index.html + toàn bộ app-*.html (class="" / classList / className literal + nối chuỗi / querySelector / getElementsByClassName) → phân loại DEAD chắc chắn vs DYNAMIC; **exit 1 nếu có dead** (chạy sau mỗi batch CSS). `--full` in thêm class nối chuỗi.
- Dead GAS audit: `node scripts/audit-gs.js` — rà hàm/const top-level 17 file .gs đối chiếu toàn bộ nguồn (gs + index/app + mock + tests + scripts); phân loại **DEAD** (không ai gọi) + **API TREO** (*Api server có nhưng client không gọi — drift mock↔server↔client); **exit 1 nếu có dead/treo** (chạy sau mỗi batch server). Entry runtime GAS (doGet/doPost/include) không tính.
- Duplicate logic audit: `grep -rn "^function " --include="*.gs" --include="*.html" | cut -d: -f2 | sort | uniq -d` — **0 duplicate exact** (GAS global scope sẽ SyntaxError). Semantic duplicate: `grep -rn "normalize\|formatTime\|cachePut\|filterStaff\|computeCounters" --include="*.gs" --include="*.html"` — >1 hit cùng intent → gộp trước khi commit. Chạy sau mỗi batch tạo hàm mới.
- Style audit: `node scripts/audit-style.js [--strict]` — boot Chrome headless + đo computed style mọi class chung (SHARED_CLASSES trong script) → in class lệch fingerprint; `--strict` exit 1 nếu có lệch ngoài ALLOWED_DRIFT (chủ đích: modal 44px touch / btn-sm / cfg-card / flabel 56px / card+table-wrap flex scan). Bỏ element display:none (nhiễu min-height 0px). Chạy sau batch UI đổi style; cần Chrome.
- UI audit toàn diện: `node scripts/audit-ui.js` — boot Chrome headless + đo geometry 7 view (home/tasks/scan/stats/staff/config/reports) x 4 viewport (desktop 1384 · tablet 1024 · mobile 390/375): view hiển thị · trang không cuộn · nav không che · card vừa màn hình (đo theo body height — KHÔNG innerHeight: headless mobile emulation báo 1007 nhưng body 844 → gap giả) · bảng có dữ liệu; viewScan mobile miễn trừ gap âm (section cuộn trong). `--quick` chỉ desktop (~20s); **exit 1 nếu có FAIL** (chạy sau mỗi batch UI thay đổi layout/touch). Cần Chrome.

## 8. Output format (chuẩn chung — BẮT BUỘC khi trả kết quả)

Khi in kết quả chạy skill, TUÂN THỦ format này — dễ quét, có marker, không tường thuật.

**1. TL;DR 1 dòng** — verdict + đếm issue:
✅ Approve — 0 P0 · 2 P1 · 5 P2 | ⚠️ Cần duyệt — 1 P0 | 🔴 Blocked — 3 P0

**2. Bảng findings** (audit/review/debug) — mỗi dòng = 1 issue, cell ≤1 dòng:
| Sev | Vấn đề | Vị trí | Đề xuất |
|---|---|---|---|
| 🔴 P0 | quét ngoài DS ghi PRESENT | ScanLogic.gs:142 | mirror server EXTRA |
| 🟠 P1 | card mobile lệch tông | styles.html:88 | override tbody td:nth-child(n) |
| 🟡 P2 | comment thừa | Code.gs:30 | xóa |

Marker: 🔴 P0 (blocker/sai data) · 🟠 P1 (break/khó dùng) · 🟡 P2 (cosmetic).

**3. Nhóm theo chủ đề** chỉ khi >5 issue — ### Nhóm + bullet 1 dòng/cái.

**4. Khối hành động cuối:**
> **Tiếp theo:** [làm gì] · [ai] · [duyệt?]

**Quy tắc vàng**
- Không tóm tắt lại nội dung skill — chỉ in kết quả.
- Không đoạn văn >3 dòng không chia ý.
- Dùng marker 🔴🟠🟡 ✅ ⚠️ ✓ thay chữ "lỗi/nghiêm trọng/đã xong".
- Số liệu đi đầu (đếm trước, kể sau): 5 P2 chứ không "có vài issue nhỏ".
- Mỗi finding có file:line cụ thể — không "ở đâu đó trong scan".
**5. Confidence score** — mỗi finding có độ tin cậy 0–100 (review-gas):
| Sev | Vấn đề | Vị trí | Conf | Đề xuất |
|---|---|---|---|---|
| 🔴 P0 | cache blind put mất write | Cache.gs:55 | 92 | read-merge-write |
- Blocker/security: LUÔN report dù conf thấp. Major ≥70 · Minor/Nit ≥80 · dưới ngưỡng → bỏ im lặng.

**6. Empty-state** — KHÔNG có issue thì in 1 dòng, không bỏ trống:
✅ Sạch — 0 P0 · 0 P1 · 0 P2 (kèm scope đã quét: test:css + test:gs + audit-ui)

**7. Anti-pattern (CẤM — đừng trả kết quả thế này)**
✗ Tôi đã đọc qua code và thấy có một số vấn đề nhỏ về giao diện, cụ thể là màu sắc ở vài chỗ có vẻ không nhất quán, rồi còn chuyện nút bấm hơi bé trên mobile nữa, bạn xem rồi sửa dùm tôi nhé...
Thay bằng:
⚠️ Cần duyệt — 0 P0 · 2 P1 + bảng 2 hàng (vị trí + đề xuất cụ thể).
Quy tắc: không tường thuật, không "vài chỗ/có vẻ", mỗi claim có file:line.
**8. Wireframe khi đánh giá đề xuất UI** — khi user nhờ đánh giá đổi thiết kế (thêm/sửa nút, panel, dropdown, dời bố cục…), vẽ ASCII wireframe để user hình dung **TRƯỚC khi chốt**:
- Vẽ ≥2 trạng thái: Đóng/Mở (hoặc Trước/Sau), và **Mobile (≤991px)** nếu ảnh hưởng responsive.
- Dùng box-drawing `│─┌┐└┘▾▴` + label class/function **thật** (`.view-topbar`, `#scanLoadPane`, `canScanLoad_()`…) — khớp code, không vẽ chung chung.
- Ghi rõ **luật tương tác** (mở/đóng, clear-selection khi đổi Station, disable điều kiện) ngay dưới khung.
- KHÔNG thay thế bảng findings P0/P1/P2 — wireframe là minh họa kèm verdict (được user thích, dùng thường xuyên cho UI).
**9. Đọc thêm**

- `README.md` — tổng quan cập nhật.
- `Spec — RollCall v2.md` — spec đầy đủ.
- `skills/` — bộ skill chuẩn `SKILL.md` (format chuẩn Agent Skills — tái sử dụng đa công cụ AI: Claude Code, OpenCode, Codex, Cursor…):
  - `project-skill/SKILL.md` — skill dự án ĐẦY ĐỦ (architecture, gotchas, batch/perf, deterministic, pitfalls) + `references/` (3 reference: `architecture-gotchas.md` · `deterministic-batch-runner.md` · `slot-fueled-classification.md`).
  - `audit-webapp-optimize/SKILL.md` — 3-phase audit (code → UI/UX → optimize), P0/P1/P2, user duyệt trước khi fix.
  - `ui-ux-audit/SKILL.md` — UI/UX audit toàn diện 1 lần: design language nhất quán + a11y (WCAG 2.2) + performance + lớp verify tự động (audit-css/gs/style/ui + CDP) — gom ui-design-process/accessibility/performance/audit-webapp-optimize, output P0/P1/P2 trình user duyệt trước khi fix.
  - `review-gas-failure-modes/SKILL.md` — review GAS with confidence scoring + failure modes checklist + MoA option.
  - `debug-systematic/SKILL.md` — 4-phase root-cause debugging (Iron Law: không fix trước root cause).