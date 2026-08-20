---
name: review-gas-failure-modes
description: GAS review with failure-modes checklist + confidence scoring (+ MoA option). Use: post-feature git diff review, pre-deploy sanity check, or full-base review of attendance/queue GAS web apps.
---

# Skill: GAS Review — Failure Modes & Confidence Scoring

> Dùng khi: review sau feature mới (git diff), review code vừa viết trước khi declare done, pre-deploy sanity check, hoặc full-base review không git. Eco: attendance/queue-style GAS tools.

## Approach

- Review **diff mặc định** (unstaged). User có thể chỉ định scope khác.
- 5 stage: Requirements → Correctness → Quality → Testing → Security/Performance.
- Report findings với **confidence 0–100**:
  - Blocker/security: LUÔN report dù confidence thấp
  - Major: cần confidence ≥ 70
  - Minor/Nit: ≥ 80
  - Dưới ngưỡng: bỏ im lặng (quality over quantity)
- Verdict: **Approve / Request Changes / Comment**.

## Failure modes checklist (GAS webapp)

- `getUserRole()` fallback `'admin'` khi exception — phải fail CLOSED.
- Lock helper nuốt timeout trả `null` → caller phải check `{__lockError:true}`.
- `genTaskId() = Date.now().toString(36)+Math.random()` (1ms resolution) — dùng `Utilities.getUuid()`.
- Client cooldown early-return → bypass bằng clock; **server là sole authority**.
- Batch cache `put(key)` blind → mất concurrent writes; phải read-merge-write.
- `queue.slice(idx+1)` retry mất cả items sau — per-item retry counter.
- `getLogTail()`: `startRow <= 1` kéo theo header — dùng `Math.max(2, lastRow - tailRows + 1)`.
- `var SS = _ensureSS()` module scope — cache null nếu sheet chưa sẵn; dùng getter.
- Task meta helpers `getDataRange()` mỗi call hot path — cache TTL ngắn keyed taskId.
- Flush ordering: `setValues` xong mới `cache.remove(batchKey)`.
- Reset task giữa active scan batch — đọc pending trong lock, abort nếu còn unflushed.
- Cache invalidation giới hạn 2 date keys — dùng versioned keys (`staffInfo:v1:{date}`).
- `setAdminEmails`/`setSpreadsheetId` phải invalidate role cache (tránh privilege escalation).
- Client timestamps trong write → broken cooldown; dùng server `new Date()` + grace window.
- Deep link `#scan:<id>` không check task tồn tại.
- `appendRow` column order vs header — đếm độ dài, off-by-one ghi sai cột.
- `headers.indexOf('X')` = -1 → `data[-1]` undefined → `String(undefined)` — guard `< 0`.
- Duy nhất cache invalidation: 1 helper gọi mọi mutation path; quên nhất: `attListCache`.
- Client flush gate: `_pendingScanCount` — skip RPC khi 0 (tiết kiệm ~240 calls/h).
- `executeAs USER_ACCESSING` — bắt buộc server gate mọi mutator ("client ẩn nút" KHÔNG phải gate).
- Cooldown client/server mismatch (20s vs 15s) — đồng bộ 1 nguồn.

## UI/A11y tối thiểu

- `th[scope="col"]` · sort headers `aria-sort` · filter `role=listbox`+label · icon trang trí `aria-hidden` · các vùng động `aria-live="polite"` (bỏ aria-live static) · `prefers-reduced-motion` cho scan-line.

## MoA-assisted review (Hermes)

Khi thêm thì dùng để tăng detection (trước deploy / critical code). KHÔNG dùng cho debug (debug cần loop reproduce→fix→verify).
- Scope document PHẢI self-contained (reference models không đọc file).
- `/moa <scope>` → "Review as independent reviewer. Confidence 0-100, severity, file+line, fixes, verdict."
- Host merge: dedupe, giữ severity, đánh dấu disagreement, output final.

**Trong repo này: chạy `gh run list --limit 5` trước khi kết luận bug — CI có thể deploy trễ (user test trên GAS build cũ).**
## Output format (chuẩn chung — BẮT BUỘC khi trả kết quả)

Khi in kết quả chạy skill, TUÂN THỦ format này — dễ quét, có marker, không tường thuật.

**1. TL;DR 1 dòng** — verdict + đếm issue:
✅ Approve — 0 P0 · 2 P1 · 5 P2 | ⚠️ Cần duyệt — 1 P0 | 🔴 Blocked — 3 P0

**2. Bảng findings** (audit/review/debug) — mỗi dòng = 1 issue, cell ≤1 dòng:
| Sev | Vấn đề | Vị trí | Đề xuất |
|---|---|---|---|
| 🔴 P0 | quét ngoài DS ghi PRESENT | ScanLogic.gs:142 | mirror server EXTRA |
| 🟠 P1 | card mobile lệch tông | styles.html:88 | override 	body td:nth-child(n) |
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
- Mỗi finding có ile:line cụ thể — không "ở đâu đó trong scan".