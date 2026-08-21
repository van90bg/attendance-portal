---
name: audit-webapp-optimize
description: 3-phase webapp audit (code → UI/UX → optimize) with P0/P1/P2 and user approval before fix. Use when: starting review of unread project, user reports many unspecific issues, before big refactor, or after many fixes want verification. Skip for single bug fixes.
---

# Skill: WebApp Audit & Optimize (3-phase)

> Dùng khi: bắt đầu review dự án chưa đọc, user báo "có nhiều vấn đề" không chi tiết, trước refactor lớn, sau nhiều fix muốn verify. Bỏ qua khi chỉ fix 1 bug đơn lẻ.

**Nguyên tắc cốt lõi: READ ALL FILES → COMPILE ALL ISSUES → USER VERIFIES → FIX → OPTIMIZE.** Không bao giờ nhảy tới fix trước khi user thấy toàn cảnh.

## Phase 1 — Code audit

1. Đọc TẤT CẢ file `.gs` + `<script>` trong `.html` (GAS: cả client JS).
2. Với mỗi file note: mục đích, hàm chính + data flow, dependencies, vấn đề tiềm ẩn (logic/security/edge).
3. Check GAS failure modes:
   | Category | Check |
   |---|---|
   | Security | Server-side role gate fail-closed? executeAs USER_ACCESSING có gate? |
   | LockService | Silent failure? Double-checked re-read trong lock? |
   | CacheService | Read-merge-write race? Blind put() mất concurrent writes? |
   | Batch flush | `setValues` trước `cache.remove`? |
   | Timestamps | Timezone-aware? Session.getScriptTimeZone()? |
   | Cooldown | Server vs client value đồng bộ? |
   | API gates | Mọi mutator có server-side check? |
4. Compile issue list phân cấp:
   - **P0** — data loss, sai logic, security
   - **P1** — bug, logic error, edge case
   - **P2** — code quality, readability
5. **Verify từng claim với code hiện tại.** Reject line numbers cũ.
6. **Trình user full list + xin confirmation TRƯỚC khi fix.**

## Phase 2 — UI/UX audit

Checklist:
- Layout: flex/grid consistent? breakpoints? nút 44px mobile? scroll mượt?
- Tokens: CSS variables? font/space/radius/shadow nhất quán? contrast WCAG AA?
- States: loading skeleton · empty · error toast · disabled style?
- A11y: `th[scope]`, `aria-sort`, `role=listbox`+label, icon `aria-hidden`, `aria-live=polite`, `prefers-reduced-motion`, `:focus-visible`.
- Animation: transform/opacity thay top/left, transition consistent.
- Phân loại: P0 sai dữ liệu · P1 layout break / không dùng được · P2 cosmetic.
- Đánh giá đề xuất UI (thêm dropdown, dời panel, đổi bố cục): vẽ ASCII wireframe các trạng thái (Đóng/Mở + Mobile) — xem ui-ux-audit §Wireframe.

## Phase 3 — Optimize

- Simplify code: guard clauses, gom helper trùng, bỏ dead code/console.log/comment.
- Performance: `getValue()`→`getValues()`, `setValue()`→`setValues()`, không heavy work trong lock, cache fallback sheet.
- Quality gate: không secrets, input validation, error handling external calls, code mới có tests.

## Phase 4 — Final gate

- [ ] Phase 1–3 xong, user duyệt từng phase
- [ ] Mọi P0/P1 fix hoặc user cho bỏ qua
- [ ] Đã commit/push; app deploy + test thật

## GAS perf patterns
- Polling 15s thay 10s (tiết kiệm 33% RPC)
- Sheet read 2-6s → cache TTL 30-60s
- `Array.isArray` guard cho payload dán mã
- Cache payload ≤ 90KB (CacheService 100KB/key limit)

---

**Xem thêm:** `../review-gas-failure-modes/SKILL.md` (checklist 40+ failure modes cụ thể kèm confidence scoring) • `../debug-systematic/SKILL.md` (debug từng issue sau audit).
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
## Redesign format (khi task thiết kế lại UI)

Task redesign giao diện → dùng format riêng trong ui-ux-audit (bảng Trước→Sau + token + 📐 layout). Xem ../ui-ux-audit/SKILL.md §Redesign format.
**5. Confidence score** — mỗi finding có độ tin cậy 0–100 (review-gas):
| Sev | Vấn đề | Vị trí | Conf | Đề xuất |
|---|---|---|---|---|
| 🔴 P0 | cache blind put mất write | Cache.gs:55 | 92 | read-merge-write |
- Blocker/security: LUÔN report dù conf thấp. Major ≥70 · Minor/Nit ≥80 · dưới ngưỡng → bỏ im lặng.

**6. Empty-state** — KHÔNG có issue thì in 1 dòng, không bỏ trống:
✅ Sạch — 0 P0 · 0 P1 · 0 P2 (kèm scope đã quét: 	est:css + test:gs + audit-ui)

**7. Anti-pattern (CẤM — đừng trả kết quả thế này)**
`
✗ Tôi đã đọc qua code và thấy có một số vấn đề nhỏ về giao diện,
  cụ thể là màu sắc ở vài chỗ có vẻ không nhất quán, rồi còn chuyện
  nút bấm hơi bé trên mobile nữa, bạn xem rồi sửa dùm tôi nhé...
`
Thay bằng:
⚠️ Cần duyệt — 0 P0 · 2 P1 + bảng 2 hàng (vị trí + đề xuất cụ thể).
Quy tắc: không tường thuật, không "vài chỗ/có vẻ", mỗi claim có ile:line.