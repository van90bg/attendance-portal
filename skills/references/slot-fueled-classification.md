# Slot-based classification ('Tự do' = FREE) — approved 2026-08-08

Status: **user-approved design, đã implement vào app thật** (mockup sketches/005-dropdown-config 005e approved — thư mục sketches đã xóa 2026-08-11; real app giờ dùng dropdown config 1 chế độ). When implementing, follow this plan exactly and keep `taskType` stored.

## Decision
Replace the modal's Free/Reconcile **tab** with a magic **slot value `'Tự do'`** inside the Ca dropdown. `'Tự do'` means FREE: no roster pre-fill, task starts OPEN (phase1 builds the danh sách), phases behave exactly like today's noList flow. Any real slotCode → reconcile (pre-fill roster, task starts ATTEND).

User explicitly chose: **bỏ tabs hoàn toàn** (no tabs in the modal), no step-2, no NV preview list, `'Tự do'` is mutually exclusive with real slots.

## Server impact (Phương án A — derive-and-store; ~3 lines)
`TaskService.createReconcileTask` — keep everything else untouched:

```
const slotCode = ... (existing normalize to string)
const slotFree = !noList && slotCode === 'Tự do'          // magic check BEFORE filter
const isFree   = !!(input && input.noList) || slotFree;   // dual-source during rollout
```

- `taskType: isFree ? TASK_TYPE.FREE : TASK_TYPE.RECONCILE` (unchanged)
- `slotCode: isFree ? 'Tự do' : slotCode` (unchanged)
- `status: isFree ? TASK_STATUS.OPEN : TASK_STATUS.ATTEND` (unchanged)
- `if (!isFree)` → filter+dedupe+`CREATE_FAILED_EMPTY` guard (unchanged — FREE must SKIP the empty-list guard)

**Do NOT touch:** `classifyScan` (ScanLogic.gs:68 already reads `task.taskType`), `pasteCodes` gate (ScanService.gs:246), `taskFromRow_` (Database.gs:237), client badge `taskTypeBadge`, the 4 test files (they construct `taskType` fixtures directly). They all key off stored `taskType`, which is still written.

## Client-side (index.html — the real work)
- Remove `#tabReconcile`/`#tabFree` mode switching + `setCreateMode(`, `chkNoList` (noLonger needed), and the noList branch of `onNoListChange()`.
- CA filter (`grp` slot) becomes a multi-select dropdown with a special flag option:
  - `'Tự do'` = first option, styled as FREE (green tag), with "exclusive" semantics:
    - checking `'Tự do'` → clear all real slot selections (SEL.slots = ['Tự do'])
    - checking any real slot → remove `'Tự do'` from selection
    - `isFree = SEL.slots.length === 1 && SEL.slots[0] === 'Tự do'`
  - Orange tag on FREE. Do not allow `['Tự do', '08:00-17:00']` — a mix is contradictory (FREE = no pre-fill vs slot filter = pre-fill).
- When `isFree`: hide Hình thức row, disable Ngày (`selDate.disabled = true`), button label `+ Tạo task quét tự do` (no count), submit `slotCode: ['Tự do']`.
- When not free: show Hình thức, enable Ngày, `' (N NV)'` count on the create button (existing `setCreateBtnCount`).
- `createTask` client validate → send `{station, team, slotCode:['Tự do']}` for FREE; `{station, team, slotCode:[real slots]}` for reconcile. **Do NOT send `noList:true` anymore** — server derives from the slot value (keep `noList` accepted for old clients during rollout).

## Why `'Tự do'` as magic (vs `'free'`)
- Old FREE tasks already store `slotCode = 'Tự do'` → migration free, label unchanged, no dual-check window.
- Real slot values in production are time ranges (08:00-17:00 …) — collision improbable; if one ever appears, exact-string match on a single selected `'Tự do'` makes the magic explicit.
- `'free'` would force: migration of old rows + dual-check (`taskType==='free' || slotCode==='free'`) in every FREE consumer — extra complexity with zero benefit.

## Edge cases (user-confirmed on 2026-08-08)
1. Guard `CREATE_FAILED_EMPTY` must be skipped for FREE (it is — `if (!isFree)`).
2. Status init: `'Tự do'` → OPEN (phase1); other → ATTEND.
3. `isFree` check happens BEFORE the slot filter (avoids reading StaffData at all for FREE).
4. Old tasks (`noList:true` from prior UI) keep working: server keeps `input.noList` OR magic-slot.

## Verify after implementing
- `npm run test` (4 test files construct `taskType` directly — they stay green unchanged; add a test asserting `slotFree` derivation through `createReconcileTask`-adjacent pure logic if practical).
- CRLF preserved; `new vm.Script()` for .gs, `new Function()` for inline client JS.
- `check-html-js-gaps` false positives only.
- Live deploy is user's clasp job; confirm running SHA via `gh run list`.