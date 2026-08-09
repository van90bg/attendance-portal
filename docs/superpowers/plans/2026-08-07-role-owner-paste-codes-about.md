# Bổ sung role user + "Dán danh sách mã" + Trang giới thiệu — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm kiểm soát quyền theo chủ sở hữu task khi quét ở phase Mở, thêm chức năng "Dán danh sách mã" cho task Quét tự do (FREE), và mở rộng trang Giới thiệu thành hướng dẫn 3 phần.

**Architecture:** Tất cả là Google Apps Script web app (HtmlService, `google.script.run`). Server chia: `ScanLogic.gs` (logic thuần, export `module.exports` cho node test), `ScanService.gs` (wrapper GAS + LockService), `Code.gs` (API layer), `Config.gs` (hằng số / `UI_LABELS`). Client là 1 file `index.html` (UTF-8 + CRLF — **chỉ patch bằng node script deterministic, KHÔNG dùng tool MSYS**).

**Tech Stack:** Apps Script (ES5 `var`/`function`), LockService/CacheService, `node --test` (`node --test tests/*.test.js`) với `require('../*.gs')`, PowerShell.

## Global Constraints
- Không tự `clasp push`. Test xong → `git add` + `git commit` + `git push` (repo GitHub).
- `index.html` UTF-8 + CRLF — mọi sửa client bằng node script có `\r\n`, không dùng `editFile` lên file này.
- File `.gs` bị tool đọc coi là binary → đọc bằng PowerShell `Get-Content` khi cần.
- `ScanLogic.gs` là logic THUẦN: không gọi `SpreadsheetApp`/`Session`/`LockService` — giữ nguyên để unit-test bằng `node --test`.
- Fail-closed: thiếu email/task/createdBy ⇒ chặn (không fail-open). `isEditor_()` (Code.gs:250) là chuẩn: so `Session.getActiveUser()` với `getDeployerEmail_()` (Script Properties `DEPLOYER_EMAIL`).
- Cache v2: mọi đường ghi log (`updateLogRowScan_/updateLogRowRef_/append`) phải invalidate (detail + list + logRows). KHÔNG đổi hành vi có sẵn.
- `createdBy` đã có sẵn trong `taskFromRow_` (`getTaskDetail` → `task.createdBy`). Client đã có `META.userEmail` (từ `getMeta`) — chỉ thiếu flag admin.
- Giữ tên/kiểu nhất quán giữa Task ScanLogic ↔ ScanService ↔ client (đã chốt ở Self-Review).

---

## File Structure

| File | Trách nhiệm | Thay đổi |
|---|---|---|
| `server/src/Config.gs` | Hằng số, `UI_LABELS`, `TASK_TYPE` | Thêm `SCAN_OWNER_ONLY`, `PASTE_BLOCKED`, `PASTE_EMPTY` |
| `server/src/ScanLogic.gs` | Logic thuần (export + test) | Thêm `canScanTask` + `mayPasteCodes` |
| `server/src/ScanService.gs` | Wrapper GAS, lock, ghi sheet | Gate chủng trong `scanStaff`; refactor `scanOneCore_`; thêm `pasteCodes` |
| `server/src/Code.gs` | API layer + `getMeta` | Thêm `pasteCodesApi`; `getMeta` trả `isAdmin` |
| `client/index.html` | UI | `renderScanView` gate quyền; nút "Dán danh sách mã" + modal; mở rộng `aboutModal` |
| `tests/scan-perms.test.js` | Test mới | `canScanTask`, `mayPasteCodes` |

> Lưu ý đường dẫn: repo thật đặt `.gs` ở thư mục root (vd `ScanService.gs`, `Code.gs`). Nếu code đang ở root thì dùng đường dẫn thật (không có `server/src/`). Thay đúng tên file dựa hiện trạng repo — check `git ls-files` trước khi áp dụng path.

---

## Task 1: Config.gs — thêm label

**Files:**
- Modify: `Config.gs` (block `UI_LABELS`)

**Produces:** `UI_LABELS.SCAN_OWNER_ONLY`, `UI_LABELS.PASTE_BLOCKED`, `UI_LABELS.PASTE_EMPTY`.

- [ ] **Step 1:** trong `UI_LABELS`, đặt cạnh `TASK_CLOSED`, thêm:
  ```js
  SCAN_OWNER_ONLY: 'Chỉ người tạo task được quét ở bước này',
  PASTE_BLOCKED: 'Chỉ người tạo task Quét tự do mới dán danh sách',
  PASTE_EMPTY: 'Không có mã hợp lệ nào để điểm danh',
  ```
- [ ] **Step 2:** Commit
  ```bash
  git add Config.gs
  git commit -m "chore: add UI_LABELS for owner-scan + paste"
  ```

---

## Task 2: ScanLogic — pure `canScanTask` (owner gate) TDD

**Files:**
- Modify: `ScanLogic.gs`
- Test: `tests/scan-perms.test.js` (new)

**Interfaces:**
- Produces: `module.exports.canScanTask(cfg, task, userEmail, isAdmin)` → `boolean`.
  - `task` ít nhất `{ status, createdBy }`.
  - `isAdmin` = `isEditor_()` (editor/deployer luôn bypass).
  - Luật: `status===OPEN` (phase 1) → chỉ `userEmail===task.createdBy`; `status!==OPEN` → mọi người. Fail-closed khi thiếu thông tin.

- [ ] **Step 1: Viết test thất bại**
  ```js
  const test = require('node:test');
  const assert = require('node:assert/strict');
  const S = require('../ScanLogic.gs');
  const CFG = {
    TASK_STATUS: { OPEN: 'open', ATTEND: 'attend', DONE: 'done' },
    TASK_TYPE: { RECONCILE: 'reconcile', FREE: 'free' },
  };
  const OWNER = 'owner@example.com';

  test('canScanTask: OPEN + owner → true', () => {
    assert.equal(S.canScanTask(CFG, { status: CFG.TASK_STATUS.OPEN, createdBy: OWNER }, OWNER, false), true);
  });
  test('canScanTask: OPEN + khác user → false', () => {
    assert.equal(S.canScanTask(CFG, { status: CFG.TASK_STATUS.OPEN, createdBy: OWNER }, 'other@example.com', false), false);
  });
  test('canScanTask: OPEN + anonymous → false', () => {
    assert.equal(S.canScanTask(CFG, { status: CFG.TASK_STATUS.OPEN, createdBy: OWNER }, '', false), false);
  });
  test('canScanTask: OPEN + admin bypass → true', () => {
    assert.equal(S.canScanTask(CFG, { status: CFG.TASK_STATUS.OPEN, createdBy: OWNER }, 'other@example.com', true), true);
  });
  test('canScanTask: phase khác OPEN → mọi user (kể cả anonymous) true', () => {
    assert.equal(S.canScanTask(CFG, { status: CFG.TASK_STATUS.ATTEND, createdBy: OWNER }, '', false), true);
  });
  test('canScanTask: thiếu createdBy (OPEN) → false', () => {
    assert.equal(S.canScanTask(CFG, { status: CFG.TASK_STATUS.OPEN, createdBy: '' }, OWNER, false), false);
  });
  ```
- [ ] **Step 2: Chạy → FAIL**
  ```bash
  node --test tests/scan-perms.test.js
  ```
  Expected: FAIL "canScanTask is not a function".
- [ ] **Step 3: Implement `canScanTask`**
  ```js
  function canScanTask(cfg, task, userEmail, isAdmin) {
    if (isAdmin) return true;                   // editor/deployer luôn được
    if (!task || !task.status) return false;      // fail-closed
    if (task.status !== cfg.TASK_STATUS.OPEN) return true; // ATTEND/DONE: ai cũng quét
    const owner = task.createdBy;
    if (!userEmail || !owner) return false;       // thiếu → chặn
    return String(userEmail).toLowerCase() === String(owner).toLowerCase();
  }
  ```
  Và thêm `canScanTask` vào **object `module.exports` hiện có** ở cuối `ScanLogic.gs` (đừng tạo export thứ 2). Nếu file đang khai báo từng export thì thêm vào tập hợp.
- [ ] **Step 4: Chạy lại → PASS**
  ```bash
  node --test tests/scan-perms.test.js
  ```
- [ ] **Step 5: Chạy toàn bộ test cũ**
  ```bash
  node --test tests/
  ```
- [ ] **Step 6: Commit**
  ```bash
  git add ScanLogic.gs tests/scan-perms.test.js
  git commit -m "feat(scan): owner-gate for OPEN-phase scan (canScanTask)"
  ```

---

## Task 3: ScanService — enforce gate trong `scanStaff`

**Files:**
- Modify: `ScanService.gs`

**Interfaces:**
- Consumes: `canScanTask`, `UI_LABELS.SCAN_OWNER_ONLY`, `isEditor_()`, `Session.getActiveUser()`.
- Produces: reject shape `{ok:false, message:SCAN_OWNER_ONLY, status:null, counters:{scanned:0,absent:0,extra:0,total:0}}`.

- [ ] **Step 1: Helper `_activeUserEmail_`** (nếu chưa có)
  ```js
  /** Email người đang truy cập — anonymous → '' (fail-closed). */
  function _activeUserEmail_() {
    try { return Session.getActiveUser().getEmail() || ''; } catch (e) { return ''; }
  }
  ```
- [ ] **Step 2:** trong `scanStaff`, ngay SAU `const task = readTask_(taskId);` và TRƯỚC khi đọc/ghi, chèn gate:
  ```js
  const allowed = ScanLogic.canScanTask(
    { STATUS: STATUS, TASK_STATUS: TASK_STATUS, TASK_TYPE: TASK_TYPE },
    task,
    _activeUserEmail_(),
    isEditor_()
  );
  if (!allowed) {
    return { ok:false, message: UI_LABELS.SCAN_OWNER_ONLY, status:null,
      counters: { scanned:0, absent:0, extra:0, total:0 } };
  }
  ```
  Đặt sau `readTask_` và trước khi duyệt logic. Nếu `task` null (`readTask_` trả null) thì gate fail-closed đúng: `!task` → false → reject message — đảm bảo trả `{ok:false}` chứ không crash.
- [ ] **Step 3:** Verify thủ công: task OPEN + không phải owner → toast `SCAN_OWNER_ONLY`. Logic thuần đã test ở Task 2.
- [ ] **Step 4: Commit**
  ```bash
  git add ScanService.gs
  git commit -m "feat(scan): reject non-owner in OPEN-phase scan"
  ```

---

## Task 4: Refactor ScanService — extract `scanOneCore_`

**Files:**
- Modify: `ScanService.gs`

**Interfaces:**
- Produces: `scanOneCore_(task, logRows, rawStaffId, now)` → `{ok, action:'update'|'append', field, status, row, staffName?}` hoặc `{ok:false, reason}`. Không giữ lock (caller giữ). **Thực hiện ghi sheet** khi update/append; **đẩy row mới vào mảng `logRows`** sau append (quan trọng cho batch paste).
- Reuse bởi: `scanStaff` (Task 3 refactor) và `pasteCodes` (Task 5).

**Bước chuẩn bị — QUAN TRỌNG:** đọc hàm `appendRow_`/ghi sheet hiện có trong nhánh append của `scanStaff` hiện tại để dùng **đúng tên hàm thật** (đề tên `appendRow_` là gợi ý; nếu khác thì dùng tên trong repo). Mọi ghi phải bảo toàn invalidate cache như hiện có.

- [ ] **Step 1: Đọc nhánh append hiện tại** trong `scanStaff` (PowerShell `Get-Content`) để lấy tên hàm ghi + `buildExtraRow` + `readStaffIndex_` exact.
- [ ] **Step 2: Build `scanOneCore_`**
  ```js
  function scanOneCore_(task, logRows, rawStaffId, now) {
    const staffId = normalizeStaffId(rawStaffId);
    if (!isValidBarcodeId(staffId)) return { ok:false, reason:'bad-format' };

    const result = classifyScan(
      { STATUS: STATUS, TASK_STATUS: TASK_STATUS, TASK_TYPE: TASK_TYPE },
      task, logRows, staffId);
    if (result.action === 'reject') return { ok:false, reason: result.reason };

    const field = result.field;
    if (result.action === 'update') {
      if (field === 'timeScan') {
        updateLogRowScan_(result.row, now, result.status);
        result.row.timeScan = now; result.row.timeScanEpoch = now.getTime();
      } else {
        updateLogRowRef_(result.row, now);
        result.row.timeRef = now; result.row.timeRefEpoch = now.getTime();
      }
      result.row.status = result.status;
      return { ok:true, action:'update', field, row: result.row, status: result.status, staffId };
    }

    // action === 'append'
    let existing = null;
    try { existing = findLogRow(readLogRowsCached_(task.taskId), staffId); } catch (e) { /* ignore */ }
    let staffInfo = null;
    if (!existing) {
      try { staffInfo = (readStaffIndex_())[staffId] || null; } catch (e) { staffInfo = null; }
    }
    if (existing) {
      if (field === 'timeScan') {
        if (!existing.timeScanEpoch) {
          updateLogRowScan_(existing, now, result.status || STATUS.EXTRA);
          existing.timeScan = now; existing.timeScanEpoch = now.getTime();
          existing.status = result.status || STATUS.EXTRA;
        }
      } else {
        if (!existing.timeRefEpoch) {
          updateLogRowRef_(existing, now);
          existing.timeRef = now; existing.timeRefEpoch = now.getTime();
        }
      }
      return { ok:true, action:'update', field, row: existing, status: existing.status, staffId };
    }

    // thực sự chưa có → append thật
    const extraRow = buildExtraRow({ STATUS: STATUS }, task.taskId, staffId, staffInfo, now, field, (result.status || STATUS.EXTRA));
    appendLogRow_(task.taskId, extraRow); // <-- tên hàm ghi đã xác nhận; giữ invalidate
    // QUAN TRỌNG: push slim row vào logRows để mã trùng trong cùng batch thấy
    logRows.push({
      taskId: task.taskId, staffId: staffId,
      staffName: staffInfo ? staffInfo.staffName : '',
      slotCode: staffInfo ? staffInfo.slotCode : '',
      station: staffInfo ? staffInfo.station : '',
      team: staffInfo ? staffInfo.team : '',
      workstation: staffInfo ? staffInfo.workstation : '',
      timeRefText: field === 'timeRef' ? formatTime_(now) : '',
      timeRefEpoch: field === 'timeRef' ? now.getTime() : 0,
      timeScanText: field === 'timeScan' ? formatTime_(now) : '',
      timeScanEpoch: field === 'timeScan' ? now.getTime() : 0,
      status: result.status,
      _rowIndex: 0,
    });
    return { ok:true, action:'append', field, status: result.status, staffId,
             row: logRows[logRows.length - 1] };
  }
  ```
- [ ] **Step 3:** refactor `scanStaff` (sau gate Task 3): bên trong lock, thay toàn bộ nhánh classify→update/append bằng:
  ```js
  const now = new Date();
  const res = scanOneCore_(task, logRows, rawStaffId, now);
  if (!res.ok) {
    const REJECT_MSG = {
      'task-closed': UI_LABELS.TASK_CLOSED,
      'already-scanned': UI_LABELS.ALREADY_SCANNED,
      'bad-format': 'Mã phải bắt đầu bằng "Ops"',
    };
    return { ok:false, message: REJECT_MSG[res.reason] || UI_LABELS.STAFF_NOT_FOUND,
             status:null, counters: computeCounters({ STATUS: STATUS }, logRows) };
  }
  ```
  rồi từ `res.row` build `timeRefText/Epoch` + `timeScanText/Epoch` đúng field, lấy `staffName` từ `res.row.staffName`, và return shape cũ (kèm `slotCode/station/team/workstation` từ `res.row`). Giữ nguyên benchmark log như hiện có.
- [ ] **Step 4: Run test cũ**
  ```bash
  node --test tests/
  ```
  Nếu `scanservice.test.js` dùng mock GAS, chúng sẽ bọc được `scanStaff` — chạy và đảm bảo PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add ScanService.gs
  git commit -m "refactor(scan): extract scanOneCore for batch paste reuse"
  ```

---

## Task 5: ScanService — `pasteCodes(taskId, rawCodes)` (batch, 1 lock)

**Files:**
- Modify: `ScanService.gs`

**Interfaces:**
- Consumes: `scanOneCore_`, `mayPasteCodes` (Task 6 — implement trước hoặc cùng task), `readTask_`, `readLogRowsCached_`, `computeCounters`, `_activeUserEmail_`, `isEditor_`.
- Produces: `pasteCodes(taskId, rawCodes)` → `{ok, applied, failed, results:[{code, ok}], counters}`; hoặc `{ok:false, message}` khi không đủ điều kiện.

> Để tránh phụ thuộc đảo: implement `mayPasteCodes` (Task 6) cùng lúc với Task này (2 function nhỏ, cùng `ScanLogic.gs`). Hoặc reorder — là 1 gate thuần dễ.

- [ ] **Step 1: Implement**
  ```js
  function pasteCodes(taskId, rawCodes) {
    const MAX = 200; // chặn batch quá lớn — tránh lock lâu + quota 6m
    const t0 = Date.now();
    const codes = (Array.isArray(rawCodes) ? rawCodes : [])
      .map(function (c) { return String(c == null ? '' : c).trim(); })
      .filter(Boolean).slice(0, MAX);
    if (!codes.length) return { ok:false, message: UI_LABELS.PASTE_EMPTY };

    try {
      const lock = LockService.getScriptLock();
      lock.waitLock(10000);
      try {
        const task = readTask_(taskId);
        if (!task) return { ok:false, message: 'Không tìm thấy task' };
        // Gate: chỉ FREE + OPEN + owner (hoặc admin)
        const allow = ScanLogic.mayPasteCodes(
          { STATUS, TASK_STATUS, TASK_TYPE }, task, _activeUserEmail_(), isEditor_());
        if (!allow) return { ok:false, message: UI_LABELS.PASTE_BLOCKED };

        let logRows = readLogRowsCached_(taskId);
        const now = new Date();
        const results = [];
        let applied = 0;
        codes.forEach(function (code) {
          const r = scanOneCore_(task, logRows, code, now);
          results.push({ code: code, ok: r.ok });
          if (r.ok) applied++;
        });
        const countersObj = computeCounters({ STATUS: STATUS }, logRows);
        console.log({ bench: 'pasteCodes', taskId: taskId, count: codes.length, applied: applied, ms: Date.now() - t0 });
        return { ok:true, applied: applied, failed: codes.length - applied, results: results, counters: countersObj };
      } finally {
        lock.releaseLock();
      }
    } catch (e) {
      return { ok:false, message: (e && e.message) || 'paste failed' };
    }
  }
  ```
- [ ] **Step 2:** đảm bảo `mayPasteCodes` export (Task 6). Nếu `pasteCodes` cần đọc lại sau khi append → `readLogRowsCached_` invalidated bởi từng ghi; nhưng `scanOneCore_` đang push vào mảng local nên batch nhìn đúng dữ liệu nội tương đối.
- [ ] **Step 3: Commit**
  ```bash
  git add ScanService.gs
  git commit -m "feat(scan): pasteCodes batch under single lock"
  ```

---

## Task 6: ScanLogic — pure `mayPasteCodes` TDD

**Files:**
- Modify: `ScanLogic.gs`
- Test: `tests/scan-perms.test.js`

**Interfaces:**
- Produces: `module.exports.mayPasteCodes(cfg, task, userEmail, isAdmin)`.
  - `true` khi `isAdmin` OR (`task.taskType===FREE` AND `task.status===OPEN` AND `userEmail===createdBy`). Fail-closed còn lại.

- [ ] **Step 1: Test**
  ```js
  test('mayPasteCodes: FREE+OPEN+owner → true', () => {
    const t = { taskType: CFG.TASK_TYPE.FREE, status: CFG.TASK_STATUS.OPEN, createdBy: OWNER };
    assert.equal(S.mayPasteCodes(CFG, t, OWNER, false), true);
  });
  test('mayPasteCodes: RECONCILE → false', () => {
    const t = { taskType: CFG.TASK_TYPE.RECONCILE, status: CFG.TASK_STATUS.OPEN, createdBy: OWNER };
    assert.equal(S.mayPasteCodes(CFG, t, OWNER, false), false);
  });
  test('mayPasteCodes: FREE + ATTEND → false', () => {
    const t = { taskType: CFG.TASK_TYPE.FREE, status: CFG.TASK_STATUS.ATTEND, createdBy: OWNER };
    assert.equal(S.mayPasteCodes(CFG, t, OWNER, false), false);
  });
  test('mayPasteCodes: khác user → false', () => {
    const t = { taskType: CFG.TASK_TYPE.FREE, status: CFG.TASK_STATUS.OPEN, createdBy: OWNER };
    assert.equal(S.mayPasteCodes(CFG, t, 'b@example.com', false), false);
  });
  test('mayPasteCodes: admin bypass → true', () => {
    const t = { taskType: CFG.TASK_TYPE.FREE, status: CFG.TASK_STATUS.OPEN, createdBy: OWNER };
    assert.equal(S.mayPasteCodes(CFG, t, 'b@example.com', true), true);
  });
  ```
- [ ] **Step 2: run → FAIL**
- [ ] **Step 3: Implement**
  ```js
  function mayPasteCodes(cfg, task, userEmail, isAdmin) {
    if (isAdmin) return true;
    if (!task || task.taskType !== cfg.TASK_TYPE.FREE) return false;
    if (task.status !== cfg.TASK_STATUS.OPEN) return false;
    const owner = task.createdBy;
    if (!userEmail || !owner) return false;
    return String(userEmail).toLowerCase() === String(owner).toLowerCase();
  }
  ```
  Thêm vào object `module.exports`.
- [ ] **Step 4: run → PASS**
- [ ] **Step 5: Commit**
  ```bash
  git add ScanLogic.gs tests/scan-perms.test.js
  git commit -m "feat(scanlogic): mayPasteCodes gate for FREE+OPEN+owner"
  ```

---

## Task 7: Code.gs — `getMeta.isAdmin` + `pasteCodesApi`

**Files:**
- Modify: `Code.gs` (`getMeta` + thêm API)

**Interfaces:**
- Produces: `getMeta()` thêm `isAdmin: isEditor_()`. `pasteCodesApi(taskId, rawCodes)` → gọi `pasteCodes`, guard `Array.isArray`.

- [ ] **Step 1:** trong `getMeta` object trả, thêm `isAdmin: isEditor_()`. Giữ `{ok,appTitle,userEmail}` hiện có.
- [ ] **Step 2:** thêm `pasteCodesApi` ngay sau `scanStaffApi`:
  ```js
  function pasteCodesApi(taskId, rawCodes) {
    const codes = (Array.isArray(rawCodes) ? rawCodes : []).filter(function(c){ return c != null; });
    return pasteCodes(taskId, codes);
  }
  ```
- [ ] **Step 3: Commit**
  ```bash
  git add Code.gs
  git commit -m "feat: getMeta.isAdmin + pasteCodesApi"
  ```

---

## Task 8: Client — gate `renderScanView` theo owner + disable `#scanInput`

**Files:**
- Modify: `client/index.html` (node script, CRLF an toàn)

**Consumes:** `META.isAdmin` (Task 7), `META.userEmail`, `task.createdBy`.

- [ ] **Step 1:** `loadMetaAndOptions` — hợp nhất: thay `META = meta;` bằng `META = Object.assign({}, meta);` để giữ cờ extra.
- [ ] **Step 2:** thêm hàm `_mayScanTask`, dùng chung:
  ```js
  function _mayScanTask(t) {
    if (META.isAdmin) return true;
    if (!t || !t.phase || t.phase !== TASK_STATUS_C.OPEN) return t ? true : false;
    var u = (META && META.userEmail) || '';
    var o = t.createdBy || '';
    return !!(u && o && String(u).toLowerCase() === String(o).toLowerCase()); // OPEN: owner-only
  }
  ```
- [ ] **Step 3:** trong `renderScanView`, sau khi tính `isReconcile/isFree/canScan` hiện có, đổi:
  ```js
  var canScan = (data.task.phase === TASK_STATUS_C.ATTEND || isReconcile || isFree) && _mayScanTask(data.task);
  ```
  và placeholder:
  ```js
  var totalScan = _mayScanTask(data.task);
  scanInput.placeholder = canScan ? 'Quét mã nhân viên…'
    : (totalScan ? 'Bấm "Chuyển điểm danh" để bắt đầu quét'
      : 'Chỉ người tạo task được quét ở bước này');
  ```
- [ ] **Step 4:** thêm (tùy chọn) banner khi bị chặn — hiện `#scanOwnerNote` (ẩn mặc định):
  chèn 1 thẻ `<div id="scanOwnerNote" class="muted" hidden>…</div>` dưới `scan-card` + set `.hidden` theo `!totalScan && phase open`.
- [ ] **Step 5:** verify thủ công — task OPEN của user khác → input disabled + placeholder đúng; ATTEND task khác → vẫn quét.
- [ ] **Step 6: Commit**
  ```bash
  git add client/index.html
  git commit -m "feat(client): owner-gate scan input in OPEN FREE"
  ```

**Lưu ý patch CRLF:** dùng node script deterministic:
```js
// scripts/patch.mjs (gợi ý tư liệu) — thay chuỗi, giữ CRLF
import { readFileSync, writeFileSync } from 'node:fs';
const f = 'client/index.html';
const text = readFileSync(f, 'utf8');
const next = text.replace('OLD_EXACT', 'NEW_EXACT');
if (next === text) { console.error('NO MATCH'); process.exit(1); }
writeFileSync(f, next.replace(/\r?\n/g, '\r\n'), 'utf8');
```

---

## Task 9: Client — nút "Dán danh sách mã" + modal + `pasteCodesApi`

**Files:**
- Modify: `client/index.html`

**Consumes:** `pasteCodesApi`, `CURRENT_TASK`, `TASK_TYPE_C.FREE`, `TASK_STATUS_C.OPEN`, `META`.

- [ ] **Step 1:** helper client:
  ```js
  function canPaste_() {
    if (META && META.isAdmin) return true;
    if (!CURRENT_TASK) return false;
    if (CURRENT_TASK.taskType !== TASK_TYPE_C.FREE) return false;
    if (CURRENT_TASK.phase !== TASK_STATUS_C.OPEN) return false;
    var u = (META && META.userEmail) || ''; var o = CURRENT_TASK.createdBy || '';
    return !!(u && o && String(u).toLowerCase() === String(o).toLowerCase());
  }
  ```
- [ ] **Step 2:** trong `renderScanView`, sau khi set `canScan`, điều cú nhìn:
  ```js
  var pBtn = document.getElementById('btnPaste');
  if (pBtn) pBtn.style.display = canPaste_() ? '' : 'none';
  ```
- [ ] **Step 3:** thêm nút `btnPaste` trước `scan-hint`:
  ```html
  <div class="paste-row">
    <button class="btn" id="btnPaste" onclick="openPaste()" style="display:none" aria-label="Dán danh sách mã">Dán danh sách mã</button>
  </div>
  ```
- [ ] **Step 4:** `openPaste()`/`closePaste()`/`submitPaste()`:
  ```js
  function openPaste() {
    var inp = document.getElementById('pasteInput'); if (inp) inp.value = '';
    var m = document.getElementById('pasteModal'); if (m) m.classList.add('open');
    if (inp) inp.focus();
  }
  function closePaste() {
    var m = document.getElementById('pasteModal'); if (m) m.classList.remove('open');
  }
  function submitPaste() {
    if (BUSY) return;
    var txt = (document.getElementById('pasteInput') || {}).value || '';
    var lines = txt.split(/\r?\n/).map(function(s){ return s.trim(); }).filter(Boolean).slice(0, 200);
    if (!lines.length) { showToast('Không có mã nào để điểm danh', true); return; }
    BUSY = true;
    google.script.run
      .withSuccessHandler(function (res) {
        BUSY = false;
        if (res.ok) {
          closePaste();
          showToast('Dán xong: ' + res.applied + ' mã' + (res.failed ? ' (' + res.failed + ' lỗi)' : ''), false);
          invalidateClientCaches_();
          loadTaskDetail(CURRENT_TASK && CURRENT_TASK.taskId);
        } else {
          showToast(res.message, true);
        }
      })
      .withFailureHandler(function (e) { BUSY = false; showToast('Lỗi dán: ' + e.message, true); })
      .pasteCodesApi(CURRENT_TASK && CURRENT_TASK.taskId, lines);
  }
  ```
- [ ] **Step 5:** thêm `#pasteModal` (kiểu dialog giống `aboutModal`, có `<textarea id="pasteInput">`) + CSS tối thiểu nếu cần.
- [ ] **Step 6:** Sau khi OK → server đã invalid; client gọi `loadTaskDetail` để cập nhật log/counters.
- [ ] **Step 7: Commit**
  ```bash
  git add client/index.html
  git commit -m "feat(client): paste-codes button + modal for FREE OPEN"
  ```

---

## Task 10: Trang giới thiệu — mở rộng `aboutModal` thành 3 mục

**Files:**
- Modify: `client/index.html` (block `aboutModal` ~dòng 893)

**Yêu cầu gốc:** 3 mục — Giới thiệu (tổng quan) / Hướng dẫn từng bước / Vai trò & quyền.

- [ ] **Step 1:** thay body `#aboutModal` thành 3 section (giữ `id=aboutModal`+`onclick=closeAbout`; button ⓘ header đã gọi `showAbout()`):
  ```html
  <div class="about-dialog">
    <h3 id="aboutTitle" style="margin:0 0 8px;font-size:16px;color:var(--text);">Giới thiệu</h3>
    <div class="about-scroll">
      <section>
        <h4>🎯 Hệ thống điểm danh kho</h4>
        <p>RollCall v2 — điểm danh nhân viên theo Ca (Slot) / Station / Team. Với task <b>Đối chiếu (RECONCILE)</b>: quét mã <b>Ops</b> ghi <b>Giờ có mặt</b> (phase 1) rồi <b>Giờ quét</b> (phase 2). Với task <b>Quét tự do (FREE)</b>: lần 1 lấy danh sách, lần 2 điểm danh, NV lạ tính <b>Dư</b>.</p>
      </section>
      <section>
        <h4>Hướng dẫn từng bước</h4>
        <ol>
          <li>Mở <b>+ Tạo task</b>, chọn <b>Station / Ca / Team</b> (hoặc sang tab <b>Quét tự do</b> nếu không có danh sách).</li>
          <li>Nhấn <b>+ Tạo task</b> — danh sách NV được pre-fill.</li>
          <li>Ở màn quét: quét mã NV, hoặc <b>Dán danh sách mã</b> (chỉ task Quét tự do).</li>
          <li>Khi đủ, nhấn <b>Chuyển điểm danh</b> để sang phase ghi Giờ quét.</li>
          <li>Hết ca, nhấn <b>Kết thúc</b> — NV chưa quét bị đánh Vắng.</li>
        </ol>
      </section>
      <section>
        <h4>Vai trò & quyền</h4>
        <ul>
          <li><b>Chủ task (người tạo):</b> quét cả 2 phase; là người duy nhất được <b>Dán danh sách</b> và quét ở phase <b>Mở</b>.</li>
          <li><b>Nhân viên khác:</b> quét được ở phase <b>Điểm danh</b> (phase 2) của mọi task.</li>
          <li><b>Admin (deployer):</b> bypass mọi giới hạn — luôn quét được + dán được.</li>
        </ul>
      </section>
    </div>
    <div style="display:flex;justify-content:flex-end;margin-top:16px;">
      <button class="btn" onclick="closeAbout()">Đóng</button>
    </div>
  </div>
  ```
- [ ] **Step 2:** thêm CSS nếu chưa có `.about-scroll { max-height:60vh; overflow-y:auto; }`.
- [ ] **Step 3:** verify: bấm ⓘ hiện 3 mục, scroll + đóng.
- [ ] **Step 4: Commit**
  ```bash
  git add client/index.html
  git commit -m "feat(client): expand about modal to 3 sections"
  ```

---

## Self-Review

**1. Spec coverage:**
- [ ] Role theo task owner — `canScanTask` (Task 2) + gate `scanStaff` (Task 3) + client gate (Task 8).
- [ ] open/ATTEND/adminx — trong `canScanTask`.
- [ ] "Dán danh sách mã" chỉ FREE + OPEN + owner — `mayPasteCodes` (Task 6) + `pasteCodes` (Task 5) + UI (Task 9) + API (Task 7).
- [ ] Nhiều mã trong 1 lock + `{code, ok}` + counters + MAX 200 — Task 5.
- [ ] Trang giới thiệu 3 mục — Task 10.

**2. Placeholder scan:** mọi hàm có code; Task 4 Step 1 yêu cầu đối chiếu tên hàm append/báo thật (anchor gợi ý `appendLogRow_`/`buildExtraRow`), không có chữ "TBD"/"implement later" không có nội dung.

**3. Type consistency:**
- `canScanTask(cfg, task, userEmail, isAdmin)` — Task 2 define, Task 3 dùng.
- `mayPasteCodes(cfg, task, userEmail, isAdmin)` — Task 6 define, Task 5 dùng.
- `scanOneCore_(task, logRows, rawStaffId, now)` — Task 4 define, Task 5 dùng.
- `UI_LABELS.SCAN_OWNER_ONLY / PASTE_BLOCKED / PASTE_EMPTY` — Task 1, dùng Task 3/5/9.
- `getMeta().isAdmin` → `META.isAdmin` — Task 7 → Task 8/9.

---

## Execution Handoff

Sau khi duyệt plan, chọn cách chạy:

**1. Subagent-Driven (k/huyên)** — dispatch subagent/task, review giữa các task, iteration nhanh.
**2. Inline Execution** — chạy trong session này theo `executing-plans`, batch + checkpoint.

Hoàn chỉnh: test logic (`node --test`) → commit → push GitHub. KHÔNG clasp deploy.