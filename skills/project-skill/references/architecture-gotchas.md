# RollCall — architecture gotchas & bug timeline

## 2-phase attendance model (source of truth)
- Per task: `open` (phase1: write timeRef = Giờ có mặt) → `attend` (phase2: write timeScan = Giờ quét) → `done`.
- Per log row status: `PENDING` ('-'), `PRESENT`, `ABSENT`, `EXTRA` (Dư).
- **Epochs are truth.** `timeRefEpoch`/`timeScanEpoch` drive counters (`computeCounters`) and sort. NEVER rely on text time columns for logic — text "HH:mm:ss" loses the date across midnight.
- `classifyScan(cfg, task, logRows, staffId)` is the pure decision function (Node-testable). Server just applies its result.

## The "Dư / extraRow" saga (do not regress)
History in git log shows repeated reverts on Dư handling (commits c5903db/dc13bf4/f7529bc/9d53ffa/bcecf1e/4166095 reverted by d0edc7a, then re-fixed in 224acd6/ae121c6/0d3920d).

**Real 2026-08-05 root cause (NOT a crash):** `ScanService.scanStaff` called `buildExtraRow(..., field)` without a `status` argument, and `buildExtraRow` hardcode `status: cfg.STATUS.EXTRA`. So EVERY append (including noList first scan) was written as Dư.
- Fix: `buildExtraRow(cfg, taskId, staffId, staffInfo, now, field, status)` with `status` param (default EXTRA for roster strangers). `ScanService` sets `extraRow.status = result.status || STATUS.EXTRA`.
- **noList quét đầu (phase1):** stranger append → must be **PENDING**, not EXTRA. Only phase2 (has timeScan) → PRESENT. (Roster stranger first scan = legitimately EXTRA — flows differ.)
- Symptom users reported: "all scans show Dư, toast error about extraRow, list empty until reopen" = server threw mid-write (pre-fix crash path) → client rollback removed optimistic row but sheet already wrote → state desync. The crash was fixed earlier; the mislabel was the 2026-08-05 fix.

## staffIndex lazy-cache gap (Fix #1, 2026-08-05)
`scanStaff` reads `readStaffIndex_()` only on append, and it's cached 5 min. After a cold cache, the first stranger scan has empty name/slot/station — only populated on later scans or reopen.
- Fix: `warmStaffCacheApi()` (read-only, safe for kiosk) preloads the index. Called on app open + right after creating a noList task (fire-and-forget, non-blocking). Apply this pattern whenever NV detail is missing on first scan.

## Toast color convention (UI)
- `showToast(msg, isError)`: `isError` → red (`err`); else classify by `msg`: `msg === STATUS_C.EXTRA` ('Dư') → amber (`warn`); else green (`ok`). Add CSS `#toast.warn { background: var(--warning, #e85d04); }`. scan-card uses separate classes (`extra`/`ok`/`err`) — do not confuse with toast.

## Deploy reality
Agent commits+pushes to GitHub. The USER runs `clasp push` to ship to GAS. A code fix is NOT live until deployed — verify by asking the user or by a fresh `clasp pull` diff.
