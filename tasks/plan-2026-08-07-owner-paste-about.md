# Plan — 2026-08-07: Role theo owner + Dán danh sách mã + Trang giới thiệu

> Ngày: 2026-08-07 · 3 yêu cầu trên RollCall v2 hiện tại (47/47 test pass)
> Bỏ qua: lỗ hổng bypass transitionToAttend mở cho tất cả (USER quyết: KHÔNG gate) — chấp nhận rủi ro, ghi nhận rõ.

## Quyết định & giả định (chốt trước khi code)

| # | Quyết định | Giá trị chọn | Lý do / Thay đổi sau dễ không |
|---|---|---|---|
| A1 | Task cũ `createdBy='web'`/rỗng (owner không xác định) | **KHÔNG áp dụng gate** (ai cũng quét được OPEN) | Tương thích task đang chạy khi deploy; không fail-closed gây kẹt vận hành. Ngược lại an toàn hơn thì đổi 1 dòng. |
| A2 | `transitionToAttend` / `completeTask` / `reopenTask` | Giữ mở cho mọi user (ngoài phạm vi, user bỏ qua bypass) | Ghi vào README như biết rõ. |
| A3 | Owner = `createdBy` trùng `Session.getActiveUser()` email (case-insensitive), admin = `isEditor_()` | Server tính `permission` và trả trong detail; client KHÔNG tự suy admin (DEPLOYER_EMAIL bí mật) | 1 nguồn sự thật, không leak email deployer. |
| A4 | Paste: tối đa 1000 dòng/lần (server clamp) — UI ~300 | 300 dòng/lần theo yêu cầu; server clamp 1000 | Chống abuse/quota. |
| A5 | Gate paste: FREE + OPEN + owner/admin | Như Yêu cầu 2 | Cùng rule với Yêu cầu 1. |

## Kiến trúc thay đổi

```
ScanLogic.gs  (+pure: canScanOpen_, planBatchScans)      ← Node test được
ScanService.gs (+pasteCodes_ batch, dùng lock 1 lần)
Database.gs   (+batchAppendLogRows_ + update LOG_ROWS cache 1 lần) 
TaskService.gs(getTaskDetail + permission)
Code.gs       (+pasteCodesApi dispatch)
index.html    (gate UI + paste modal + aboutView)
tests/        (+paste-batch.test.js)
README / Spec (cập nhật)
```

## T-1 — Server: owner gate cho scan (Yêu cầu 1)

**Files:** `ScanLogic.gs`, `ScanService.gs`, `TaskService.gs`, `Code.gs`(không cần)

- `ScanLogic.gs` thêm pure helper (export cho Node test):
  - `canScanOpen_(cfg?, createdBy, activeEmail, isAdmin)` — rule A1/A3:
    ``task.status !== OPEN` → true; `isAdmin` → true; `createdBy` là email hợp lệ (khác 'web'/''/không chứa '@') → `activeEmail === createdBy` (lowercase); ngược lại (owner không xác định) → true (A1).
- `ScanService.scanStaff`: sau `readTask_(taskId)`, nếu `!canScanOpen_(task, activeEmail, isAdmin)` → return `{ok:false, message: UI_LABELS.SCAN_OPEN_OWNER_ONLY}` (thêm label Config.gs). Lấy `activeEmail = Session.getActiveUser().getEmail()` (wrap try/catch → ''), `isAdmin = isEditor_()`.
- `TaskService.getTaskDetail`: thêm `task.permission = { isAdmin, isOwner, canScanOpen }` (tính bằng helper trên với task vừa đọc). ⚠️ `readTaskDetailCached_` cache detail 15s → permission theo email NGƯỜI ĐỌC không thể nằm trong cache chung (bao giờ cũng user đầu tiên). → **KHÔNG nhét vào cache**: `getTaskDetail` đọc xong cache, tính permission tươi rồi bổ sung vào response (không lưu vào cache).
- Client (`index.html`):
  - `renderScanView`/`openScan`: `CURRENT_TASK.permission` → nếu `!canScanOpen`: `scanInput.disabled = true`, hiện banner "Chỉ owner mới quét được ở phase Mở (task này)", ẩn `#btnToAttend` và nút paste.
  - `submitScan()`: guard `if (input.disabled) { buzz + toast; return; }` (defense — barcode physical vẫn có thể gõ).
  - Sau `transitionToAttend`/`reopen`/load detail → gọi lại `applyScanPermission()` (1 hàm chung, tái render).

## T-2 — pasteCodesApi (Yêu cầu 2)

- `ScanLogic.gs` thêm pure `planBatchScans(cfg, task, logRows, codes: string[])`:
  - normalize từng dòng (`trim`, skip rỗng), `isValidBarcodeId` → mỗi mã lỗi format đẩy `{code, ok:false, reason:'invalid-format'}` (KHÔNG dừng batch).
  - Lặp gọi `classifyScan` trên cùng `logRows` — dedupe tự nhiên (mã trùng trong paste → reject named 'already-present'/'already-scanned').
  - Trả `{plans: [{code, action, phase, field, status, reason, row}], invalid: [...]}` — chưa ghi gì (image of ghi).
- `Database.gs` thêm:
  - `batchAppendLogRows_(rows)` — 1 `setValues` cho N dòng mới (giống `batchInsertLogRows_`), gán `_rowIndex = startRow + i`, sau đó **cập nhật LOG_ROWS cache 1 lần** (đọc cache, push N slim, put 1 lần) thay vì `pushLogRowToCache_` mỗi row (300× JSON parse/put → chậm). Nếu cache miss → bỏ qua (rebuild tự nhiên).
  - `batchUpdateTimeRefs_(taskId, updates[])` — group cập nhật timeRef/timeScan theo `_rowIndex` → 1 `setValues` full column? — KHÔNG: cột rời (TIME_REF cột 8, TIME_SCAN cột 9 liền nhau → ghi được 1 range 2 cột). Gom các hàng cần ghi thành từng đoạn liên tiếp nếu được; tối giản: 1 pass ghi từng cặp (timeRef,timeScan) bằng 1 `setValues` phạm vi toàn bộ dòng liền cần sửa (range liên tục min..max). Rồi invalidate detail/list + update LOG_ROWS cache 1 lần.
  - Đơn giản hóa đề xuất: **paste chủ yếu sinh append** (phase OPEN cho FREE: NV lạ → append PENDING); update timeRef chỉ khi NV đã trong log. Plan app tỷ lệ: dùng `batchAppendLogRows_` cho append + cho update phần lặp `updateLogRowRef_` từng mã (số ít) — ghi chú giới hạn.
- `ScanService.gs` thêm `pasteCodes(taskId, rawLines)`:
  - Gate: task = `readTask_(taskId)`; reject nếu KHÔNG phải FREE + OPEN + `canScanOpen_`. (GATE: `task.taskType !== FREE → 'Chỉ áp dụng quét tự do'`; `status !== OPEN → 'Chỉ phase Mở'`).
  - 1 `LockService` (waitLock 10s) + `try/finally` như `scanStaff`; 1 lần đọc `readLogRowsCached_`.
  - Lặp `planBatchScans` → chạy kế hoạch: append batch, update thật, cập nhật cache LOG_ROWS.
  - Đọc lại chính xác: cần `staffIndex` cho append (lazy 1 lần) — như scanStaff.
  - Tính `counters` mới (từ `logRows` đã push thêm) → trả `{ok, total, success, failed, results:[{code, ok, status, message}], counters}`.
  - Benchmark threshold log (pattern sẵn có).
  - Giới hạn: `rawLines.length > 1000 → clamp` (A4).
- `Code.gs`: `pasteCodesApi(input)` → `{taskId, lines}` → gọi `pasteCodes`.
- Client (`index.html`):
  - Thêm modal paste (`#pasteModal` class `.about-overlay` — BẮT BUỘC đăng ký vào `anyModalOpen()` để auto-focus loop không cướp textarea).
  - Nút "Dán danh sách mã" chỉ hiện khi FREE + OPEN + `permission.canScanOpen` (cạnh input quét).
  - Textarea 1 dòng = 1 mã; nút Dán → gọi `pasteCodesApi`; hiện summary (xanh/đỏ) + liệt kê mã hỏng (invalid/trùng/chặn) dạng danh sách; refresh `CURRENT_LOG/CURRENT_COUNTERS` từ response.
  - Client guard: tối đa ~1000 dòng + cảnh báo; bỏ dòng rỗng.

## T-3 — Trang giới thiệu (Yêu cầu 3)

- Thay modal hiện có:
  - Bỏ `#aboutModal` + `showAbout/closeAbout` (dòng 893–903, 1226–1237, Escape handler dòng 1357).
  - Thêm `<section id="aboutView" class="hidden">` như `#viewScan`, gồm 3 mục: **Giới thiệu** · **Hướng dẫn từng bước** (tạo task → Mở → quét/ấn mã → Điểm danh → Xong) · **Role** (owner/admin/khác theo rule: OPEN chỉ owner+admin quét; ATTEND mọi người; DONE chặn; dán mã = FREE+OPEN+owner).
  - Nút `ⓘ` (dòng 760) → `openAbout()` (helper mới `showSection(name)` quản 3 views: 'viewList'|'viewScan'|'aboutView' + start/stop auto-focus: về viewScan gọi lại `startAutoFocusLoop()`, khác → dừng như hiện tại).
  - Nút `←` trong aboutView → quay lại view trước (lưu `lastView` khi mở about; mặc định viewScan nếu vừa mở từ đó).
  - A11y: heading h2, cột `role="list"` nếu dùng list; không cần focus trap (view không phải modal).

## Test

- `tests/paste-batch.test.js` (Node pure, thêm vào package.json scripts):
  - batch: 3 mã hợp lệ phase OPEN/FREE → 3 append PENDING; mã lặp trong cùng paste → lần 2 reject 'already-pending'.
  - mã sai prefix → invalid-format không dừng batch.
  - task FREE + OPEN vs ATTEND → đúng nhánh (ATTEND chặn ở service, pure chỉ classify).
  - `planBatchScans` không đổi `logRows` (thuần).
  - `canScanOpen_`: admin bypass · owner đúng/case-insensitive · non-owner chặn · createdBy='web' → cho phép · task không OPEN → cho phép.
- `npm test` → 47 + ~8 mới ≈ 55 pass.

## Verification (checkpoint)

1. `npm test` xanh (sau mỗi Tần logic thêm test).
2. `clasp push -f` không lỗi syntax.
3. CDP verify UI: paste nút hiện/ẩn theo role(owner vs không — dùng 2 tài khoản hoặc set `DEPLOYER_EMAIL`), about mở/đóng/có nội dung Role, disable input đúng.
4. QA prod (nếu cho): FREE task → owner dán 300 mã → counters đúng; non-owner quét OPEN → reject đúng message; về task cũ phải không ảnh hưởng (A1).
5. Sau deploy: verify URL `/exec` 200 (lesson README).

## Risks & mitigation

| Rủi ro | Giảm thiểu |
|---|---|
| Bypass: non-owner chuyển OPEN→ATTEND (đã bỏ) | Ghi nhận accepted; nếu muốn sau này: gate transition = đúng 1 dòng |
| Legacy `createdBy='web'` gây nhầm owner | A1: không gate khi owner không xác định |
| 300 append lặp = timeout | `batchAppendLogRows_` 1 RPC + cache 1 put |
| Cache detail 15s chứa permission lệch user | permission tính sau cache, không lưu cache |
| Paste cướp focus textarea | paste modal trong `anyModalOpen()` |
| Client permission ngoài sync (sau transition/reopen) | `applyScanPermission()` gọi lại mọi nơi bật task |

## Files touched

- `Config.gs` (1 label), `ScanLogic.gs`, `ScanService.gs`, `TaskService.gs`, `Database.gs`, `Code.gs`, `index.html`, `tests/paste-batch.test.js`, `package.json` (test script), `README.md` (features/47→N)
- Không đụng: `CsvUtil.gs`, `appsscript.json`, CI workflows