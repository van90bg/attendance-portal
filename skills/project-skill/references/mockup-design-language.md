# Mockup Design Language — viewConfig (2026-08-16)

> Nguồn chuẩn: `C:\Users\Van90BG\Documents\AppScript\New folder\mockup.html` — user directive
> 2026-08-16: **"lấy đây là ngôn ngữ giao diện cho app"**. Mọi thiết kế UI mới (đặc biệt viewConfig)
> phải theo language này. Mockup dùng class `cfg2-*` — app giữ prefix `cfg-*` (mapping bên dưới).
> Commit: `4763237` (base redesign) → `792f1a8` (chip edit gọn) → `fee929b` (áp dụng toàn bộ mockup).

## 1. Mapping tên mockup → app

| Mockup (`cfg2-*`) | App (`cfg-*`) | Chú thích |
|---|---|---|
| `cfg2-role-card` | `cfg-role-card` | card role (thay bảng) |
| `cfg2-add-chip` | `cfg-add-chip` | + Thêm dashed pill |
| `cfg2-chip-edit` / `cfg2-chip-del` | `cfg-chip-edit` / `cfg-chip-del` | icon 20px tròn |
| `cfg2-chip-val` | `cfg-chip-value` | value chip (cap + ellipsis) |
| `cfg2-count` | `cfg-count` | badge đếm mục |
| `cfg2-chevron` | `cfg-chevron` | ▾ xoay -90° khi collapse |

## 2. Pattern UI (mockup — áp dụng khi thiết kế)

1. **Card head clickable**: `role="button" tabindex="0" aria-expanded` + `onclick` collapse +
   `onkeydown` Enter/Space. Chevron luôn `▾`, CSS `transform: rotate(-90deg)` khi `.is-collapsed`
   (đổi transform, KHÔNG đổi glyph — không nhảy width). Head hover `row-hover` + `:focus-visible` outline.
2. **Count badge pill**: `font-size:11px; font-weight:700; color:var(--muted); background:var(--surface-muted);
   border-radius:999px; min-width:20px; text-align:center` — thay chữ "X mục" hint.
3. **Chip**: `background:var(--surface-muted); border:1px solid transparent; border-radius:999px;
   padding:6px 6px 6px 12px` — KHÔNG hover border. **Default**: `background:var(--primary-bg);
   border-color:var(--primary)` (xanh, KHÔNG amber).
4. **Chip value**: `white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:220px`
   (mobile 140px) + JS `title="..."` tooltip. `font-size:13px; color:var(--text)` (KHÔNG primary-dark).
5. **Chip edit (gọn — user: "input fullwidth chiếm chỗ thừa")**: chip `.cfg-chip-editing` padding 4px,
   bg #fff, `border-color:var(--primary)`; input trong chip: `border:none; outline:none; background:transparent;
   width:140px; padding:4px 6px; font-size:13px` — KHÔNG class `.cfg-input` (viền override). ✓/✕ =
   `cfg-chip-edit`/`cfg-chip-del` 20×20 tròn, muted, hover `#fff` + primary/danger. Placeholder "Giá trị mới"
   CHỈ khi thêm mới (cur === ''), sửa item có giá trị → placeholder rỗng.
6. **+ Thêm**: `.cfg-add-chip` dashed pill `border:1px dashed var(--border)` cuối hàng chips
   (không nút ở head); hover primary. Role: "+ Thêm role".
7. **Role = CARD rows (KHÔNG bảng)**: `.cfg-role-rows` flex column gap 8; `.cfg-role-card` flex
   `align-items:center; gap:10px; padding:10px 12px; border:1px solid var(--border); border-radius:10px;
   background:#fff` + hover row-hover; edit: `border-color:var(--primary)`. Email `flex:1; min-width:0;
   nowrap; ellipsis; font-weight:600; 13px` + title; badge `flex-shrink:0`; actions `flex gap:6; flex-shrink:0`.
   Role head KHÔNG click (`cursor:default`, không chevron). Rỗng: `div.cfg-empty-val` "(chưa có role)".
8. **Icon buttons**: `.cfg-icon-btn` 30×30 desktop LẪN mobile (mockup 30 everywhere — đừng thêm 32 touch),
   color `var(--muted)`, hover `border-color+color` primary/danger/success (KHÔNG đổi nền).
9. **Star ★/☆**: `font-size:14px`, off `color:var(--border)`, on `color:var(--warning)`
   (KHÔNG amber-dark), hover warning.

## 3. State/config — KHÔNG reload UI (bất biến từ 2026-08-13 → 08-16)

- MỌI thao tác config (sửa/thêm/xoá/kéo/default/role/collapse) = **state cục bộ** + `markCfgDirty_()`;
  server chỉ nhận **1 patch** (`cfgDiff_()` vs `CFG_SNAPSHOT`) khi bấm "Lưu cấu hình".
- **CFG_SNAPSHOT = trạng thái server cuối** (cập nhật sau mỗi save success). "Huỷ thay đổi"
  (`discardCfgChanges`) → khôi phục `renderConfigForm(deepCopy(CFG_SNAPSHOT))` — **KHÔNG gọi
  loadConfigView** (không fetch/skeleton/nhấp nháy). "Lưu" success → chỉ đổi snapshot + tắt dirty + toast.
- `renderCfgList()` giữ scroll: lưu `card.scrollTop` trước, khôi phục sau innerHTML.
- Verify "không reload" bằng CDP: `performance.getEntriesByType('navigation')[0].type` giữ nguyên +
  `#cfgSkeleton` display không bật + scroll giữ — geometry/navigation là truth.
- Bẫy probe cũ: nút Lưu luôn hiện sau load — cờ hết dirty là `disabled=true`, KHÔNG phải display:none;
  sau khi Lưu thành công default mới đã persist → starsOn=1 là ĐÚNG (đừng kỳ vọng 0).

## 4. App-wide color language (P1/P2 2026-08-16 — BẮT BUỘC toàn app)

Một accent tương tác duy nhất = **--primary (xanh #0b57d0)**; amber CHỈ cho brand/cảnh báo. Không bao giờ dùng amber cho tương tác/heading/focus.

- **Tương tác/hiển thị chọn = primary**: focus ring (`--focus-ring` rgba(11,87,208,.45)), input/select focus border, `pick.on` (primary-bg + border primary + primary-dark — giống chip default), `pick.all.on`, pagination hover/active, `th-funnel` hover/on, modal title border-bottom, spin-dialog border-top, stats `td.total` (primary-bg + primary-dark), cột Tổng.
- **Active nav trên nền dark** = `--primary-bright #1a73e8` (sidebar `.side-item.active`, bottom-nav `.nav-item.active`) — #0b57d0 quá tối trên #0d111a.
- **Heading view** (`.task-title`, `.section-heading`) = `var(--text)` đậm — KHÔNG màu. **Label** (`.flabel`, `label`) = `var(--muted)`.
- **Giữ amber (brand/cảnh báo — KHÔNG đụng)**: header `.brand-accent` ("ĐIỂM DANH"), `.home-clock` gradient, `.counter.extra` (amber-dark), `.scan-card.extra/.warn`, `#toast.warn`, laser scan-line + camera reticle, `.bg-task-indicator`, `.empty-arrow`, `.btn-amber`, `.pick.free.on` (xanh lá FREE).
- **Badge xanh 1 token**: `.badge.present` = `--success-dark` (hợp nhất #137333 vs #1e7e34); `.badge.done` nền `#e9ecf2` (tông task-count-badge).
- **Card padding = 14px** (12→14, mockup 13/16); viewConfig giữ 13/16 riêng theo mockup.
- **Home (P2)**: `.home-brand` label "SPX Express" (12px 800, letter-spacing 5px, muted, uppercase) trên logo + `.home-shortcuts` 3 card mềm (Điểm danh → `selectPage('attendance')` · Thống kê → `selectPage('stats')` · Báo cáo → `selectPage('reports')`), hover primary-bg + border primary, icon SVG stroke currentColor 20px.

## 5. Verify workflow viewConfig

1. Edit deterministic (Python, CRLF) → CRLF 0 LF-only/no BOM + JS parse + CSS braces 0.
2. `node scripts/build-local.js` (BẮT BUỘC trước CDP — index.local.html stale gây probe false-fail).
3. `npm test` (133/133) + `node scripts/audit-css.js` (DEAD 0; warnings không fatal: `.cfg-item-group`
   intentional JS-only, `.reports-user-name` pre-existing) + `node scripts/audit-gs.js` (0 dead/treo).
4. CDP probe desktop 1384 + mobile 390: geometry `getBoundingClientRect` là truth. Mock roleMap = `{}`
   → inject `CFG_STATE['roleMap']` + gọi `renderRoleRows()` để test role card. Port 9222 tự boot headless
   (pattern `scripts/test-local-mock.js`); PowerShell phá inline node -e → viết script qua write tool.
5. Xóa probe → commit + push (`type(scope): mô tả`) → `gh run list --limit 3` (CI deploy trễ — user
   test GAS build cũ khi SHA chưa khớp).