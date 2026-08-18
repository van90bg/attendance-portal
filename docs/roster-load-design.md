# Đề xuất: Nạp danh sách theo ca (roster) ở phase 1 — hợp nhất quét / dán / roster

> **Trạng thái: ĐÃ TRIỂN KHAI Phase A (2026-08-18)** — task mới luôn FREE + OPEN, chọn ca =
> pre-fill roster, `loadRosterApi` + nút "Lấy danh sách theo ca", cảnh báo chuyển phase khi log
> rỗng. **Phase B** (bỏ branch `reconcile` khi hết task cũ) chưa làm — tách issue riêng.

## 1. Bối cảnh & mục tiêu

Modal tạo task hiện tại buộc người dùng quyết định trước 2 loại task (đối chiếu theo danh sách
vs quét tự do) + 5 dòng filter (Station · Team · Ca · Hình thức · Ngày) — người mới khó hiểu,
mất thời gian làm quen. Đề xuất đảo ngược: **tạo task rồi quét**, danh sách (roster) nạp **sau**
khi cần — qua 1 trong 3 hành vi ngang hàng nhau:

| Hành vi | Nguồn dữ liệu |
|---|---|
| **Quét** (phase 1) | NV có mặt thực tế quét mã |
| **Dán danh sách** | mã NV dán tay (đã có: nút "Dán danh sách mã") |
| **Nạp roster theo ca** (MỚI) | StaffData lọc theo Station / Ca / Team / Ngày |

3 hành vi đều tạo **dòng PENDING** trong log (phase 1) — khác nhau duy nhất ở nguồn dữ liệu.

## 2. Ngữ nghĩa đã chốt (điều kiện tiên quyết)

> **Phase 1 KHÔNG có "Dư". Dư (EXTRA) chỉ xảy ra khi quét điểm danh (phase 2) mà NV
> không có trong danh sách (không có dòng PENDING trong log).**

| Hành vi | Phase 1 (Mở) | Phase 2 (Điểm danh) |
|---|---|---|
| Quét NV **chưa có dòng** | thêm **PENDING** + timeRef (Có mặt, chưa điểm danh) — không Dư | thêm **EXTRA (Dư)** |
| Quét NV **có dòng PENDING** | đã có timeRef → reject "đã có mặt" | cập nhật → **PRESENT** (timeScan) |
| Quét NV có dòng EXTRA | (không xảy ra — phase 1 không tạo EXTRA) | giữ EXTRA, cập nhật timeScan |
| **Dán danh sách mã** | thêm PENDING + timeRef (người đã có → reject) | **chặn** (gate: FREE + open) |
| **Nạp roster theo ca** (mới) | thêm PENDING + timeRef = lúc nạp (người đã có → **bỏ qua im lặng**) | **chặn** (cùng gate) |
| Kết thúc (completeTask) | — | PENDING chưa có timeScan → **Vắng**; EXTRA giữ Dư |

Quy tắc này **trùng khớp nhánh FREE hiện tại** (ScanLogic.gs `classifyScan` — `isFree` branch)
→ **không cần sửa classifyScan**. "Danh sách" ở phase 2 = mọi dòng PENDING trong log, không
phân biệt nguồn (quét phase 1 ∪ dán ∪ roster).

### 2.1 Hệ quả bắt buộc chấp nhận

1. Người **ngoài ca** xuất hiện ở phase 1 vẫn được tính **Có mặt** (PENDING → phase 2 PRESENT).
   Chỉ người xuất hiện **lần đầu ở phase 2** mới là Dư. (Mềm hơn reconcile cũ — đã chốt.)
2. **Không reclassify** dòng cũ: PENDING không bao giờ tự đổi thành EXTRA.
3. Rủi ro duy nhất còn lại: NV trong roster mà roster **chưa nạp** khi họ quét phase 2 → thành
   Dư, không cứu được. → Bắt buộc: cảnh báo nút "Chuyển điểm danh" (§7) + gate nạp roster ở
   phase 1.

### 2.2 Giao hoán trong phase 1

Nếu 3 hành vi đều idempotent-skip (bỏ qua NV đã có dòng), mọi thứ tự quét/dán/nạp trong phase 1
cho **cùng một log cuối** (phép union) — thứ tự không ảnh hưởng kết quả. Điểm bất nhất duy nhất
hiện tại: paste báo "đã có mặt" = **lỗi** (dán sau khi quét bị fail), trong khi nạp roster sẽ
**bỏ qua im lặng**. → Chấp nhận tạm (paste giữ nguyên), chỉ nạp roster mới là silent-skip.

## 3. Server — API mới `loadRosterApi`

Đặt trong **TaskService.gs** (cạnh `createReconcileTask` — dùng chung `filterStaffByGroup` /
`dedupeStaffByGroup` / `batchInsertLogRows_`); wrapper `loadRosterApi` trong Code.gs (pattern
`pasteCodesApi`).

### 3.1 Contract

```
loadRosterApi(taskId, filters)
  filters: { station, slotCode: string[]|string, team: string[]|string,
             contractType: string[]|string, date: string }
           — cùng shape input createReconcileTask (filterStaffByGroup)

→ { ok, total, added, skipped, message, counters }
  total   — NV khớp tổ hợp sau dedupe
  added   — NV mới thêm vào log
  skipped — NV đã có dòng trong log (bỏ qua, không lỗi)
  counters — computeCounters(log mới) — client render ngay
```

### 3.2 Gate (service layer, pattern DEFENSE — trong try)

1. `requireRole_('operator')` — chặn viewer bypass.
2. Task tồn tại.
3. `task.status === OPEN` — **chỉ phase 1** (đồng gate với paste: "Chỉ phase Mở mới nạp được").
4. `canScanOpen_` (owner/admin) — giữ nguyên rule owner scan phase Mở.

### 3.3 Flow

1. `readTask_` → gate (trên).
2. `staffList = filterStaffByGroup(readStaffList_(), filters)` — rỗng → `ok:false`,
   message khớp `UI_LABELS.CREATE_FAILED_EMPTY`.
3. `deduped = dedupeStaffByGroup(staffList)` (StaffData có thể 2 dòng/NV — giữ dòng đầu).
4. `existing = Map(staffId)` từ `readLogRowsCached_(taskId)` (slim rows — epoch + status).
5. `toAdd = deduped.filter(nv chưa có trong existing)`; `skipped = deduped.length - toAdd.length`.
6. `toAdd` rỗng → `{ ok:true, added:0, skipped, message: 'N NV đã có trong danh sách' }`.
7. `batchInsertLogRows_(taskId, toAdd, now)` — 1 setValues (LogRepo.gs:151), timeRef = now
   (**Giờ có mặt = thời điểm nạp**, giống pre-fill createReconcileTask), status PENDING.
   → KHÔNG áp clamp 200 của paste (roster theo ca là danh sách chính thức, đường ghi đã dùng
   cho roster lớn ở createReconcileTask).
8. `audit_('loadRoster', taskId, { total, added, skipped })` — sau khi ghi (fail-safe order).
9. Trả `counters` (computeCounters trên log mới).

Lock: `LockService.waitLock(10000)` + release trong `finally` (như mọi mutation). KHÔNG chạm
dòng cũ (không update/không reclassify). Không cần `readStaffIndex_` (roster lấy từ StaffData
thẳng — batchInsertLogRows_ tự điền staffName/slotCode/station/team từ staffList).

## 4. Client — nút "Lấy danh sách theo ca" (app-scan.html + index.html)

- Nút `#btnLoadRoster` **cạnh "Dán danh sách mã"** trong topbar viewScan — hiện cùng điều kiện
  với `#btnPaste` (phase Mở + `canScanOpen`; sau Phase A mọi task mới = FREE nên không cần check
  taskType). Vị trí: `#btnPaste` bên cạnh, cùng class btn-outline.
- Dialog `#rosterModal` (tái dùng `.about-overlay` + `.about-dialog` + `anyModalOpen()`):
  - Bộ lọc gọn: Station (bắt buộc) + Ca + Team + Ngày — **tái dùng cây `getFilterOptionsApi`**
    (stationGroups + defaults + lists) + pattern chips của create modal; hoặc select đơn giản
    (quyết định ở §6).
  - Preview số NV khớp: gọi **`previewStaffApi(filters)`** (đã có — Code.gs:94, trả count,
    dùng chung dedupe) → hiện "N NV khớp" cạnh nút nạp.
  - Nút "Nạp danh sách" → `loadRosterApi` → toast `'{added} NV thêm · {skipped} đã có'` +
    `loadTaskDetail(silent)` + `renderCounters()` (đồng bộ submitPaste).
- Module: thêm vào `app-scan.html` (nút + dialog logic) + `index.html` (HTML dialog) —
  không module mới.

## 5. Modal tạo task — 2 phương án (chờ chốt)

| | A1 — giữ chọn ca (khuyến nghị) | A2 — rút gọn |
|---|---|---|
| Modal | Giữ nguyên 5 filter + chip "Tự do" | Chỉ Station (+ Ngày) |
| Chọn ca thật | Task FREE + **pre-nạp roster ngay lúc tạo** (batchInsertLogRows_, status **OPEN**) | Không pre-nạp — roster qua nút nạp sau |
| Người quen việc | Giữ luồng "tạo xong có sẵn roster" (chỉ mất 1 bước Chuyển điểm danh so với reconcile cũ) | Phải nạp roster thủ công |
| Độ phức tạp | Tạo task đổi: `noList` → luôn FREE + OPEN; chọn ca = pre-nạp (đi thẳng vào batchInsertLogRows_) | Tạo task đổi: luôn FREE + OPEN, bỏ filter |

Cả 2 phương án: **task mới LUÔN `taskType='free'` + status OPEN** — taskType 'reconcile'
không còn được tạo mới. A1 giữ modal hiện tại (ít thay đổi UI, giữ người quen việc) — khuyến nghị.

## 6. Cảnh báo nút "Chuyển điểm danh"

`updateFinishBtnState` / click `btnToAttend`: nếu `CURRENT_LOG` rỗng (chưa quét + chưa nạp roster)
→ `showConfirm('Chưa có ai trong danh sách', 'NV quét ở phase 2 sẽ tính là Dư. Tiếp tục?')`
trước khi `transitionToAttend`. Chỉ nhắc, không chặn.

## 7. Backward-compat & rollout

- **Không migration dữ liệu.** Cột TASK_TYPE giữ nguyên; task cũ `reconcile` đang chạy giữ hành
  vi cũ (branch `isFree` của classifyScan + gate pasteCodes vẫn đọc taskType như hôm nay).
- Task mới = `free` → paste + nạp roster đều mở (phase 1).
- **Phase B (riêng issue, sau khi hết task reconcile cũ):** bỏ branch reconcile khỏi
  classifyScan/pasteCodes gate, gỡ cột TASK_TYPE + mock + docs. Không làm trong Phase A.

## 8. Tests & docs (đi kèm Phase A)

- `tests/roster-load.test.js` (mới, dùng gas-sandbox): gate operator / status != open /
  non-owner reject; filter rỗng → ok:false; dedupe nội bộ; **idempotent** (gọi 2 lần, lần 2
  `added=0, skipped=N`); append đúng PENDING + timeRef = now; counters; audit row.
- `mock-contract.test.js`: thêm handler `loadRosterApi` (chống drift mock↔server).
- `index-html-parse` (parse) + `eol-bom` (CRLF) tự chạy trong `npm run test`.
- Docs: README (danh sách API + luồng "tạo task → nạp roster"), Spec (bảng API §API,
  §4.x tạo task, §9.x viewScan) — CÙNG commit.

## 9. Quyết định mở cần chốt trước khi code

1. **Modal:** A1 (giữ chọn ca → pre-nạp roster) hay A2 (rút gọn chỉ Station)? — đề xuất A1.
2. **Nạp roster ở phase 2:** chặn (đề xuất — gate `status === OPEN`) hay cho phép? Nếu cho phép:
   mở lại vấn đề "có mặt" lệch (PENDING append ở phase 2) + rủi ro NV quét phase 2 trước khi
   nạp vẫn thành Dư không cứu được — đề xuất chặn + cảnh báo §6.
3. **Dialog roster:** chips cascade (tái dùng create modal) hay select đơn giản? — đề xuất
   select đơn giản (dialog nhỏ, ít code mới).
