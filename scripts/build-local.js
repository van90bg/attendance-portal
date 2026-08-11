/**
 * scripts/build-local.js — Gộp GAS template thành 1 file HTML cho test local.
 *
 * GAS deploy: doGet dùng createTemplateFromFile('index').evaluate() — template
 *   index.html có <?!= include('styles') ?> / <?!= include('app') ?> nạp CSS/JS
 *   từ styles.html + app.html (file .html riêng — GAS không chấp nhận .css/.js).
 * Local (file://): trình duyệt không render GAS template → build-local.js thay
 *   các directive include bằng nội dung thật → index.local.html.
 *
 * Usage:
 *   node scripts/build-local.js                              (CLI — ghi index.local.html)
 *   const { build } = require('./build-local.js'); build();  (module — test)
 *
 * index.local.html KHÔNG commit (gitignore + claspignore).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** Đọc file theo path tương đối root (utf8). */
function readFile(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/**
 * Gộp index.html (<?!= include() ?>) + styles.html + app.html → index.local.html.
 * Bảo toàn trạng thái BOM đầu file: index.html hiện KHÔNG BOM (BOM ở đầu output serve
 * qua GAS gây khoảng trống phía trên header — lesson 9982293; AGENTS.md §3 bắt buộc
 * write utf-8 KHÔNG sig).
 * Trả về chuỗi đã build.
 */
function build() {
  let html = readFile('index.html');
  const bom = html.charCodeAt(0) === 0xfeff ? html.charAt(0) : '';
  if (bom) html = html.slice(1);
  let out = bom + html
    .replace("<?!= include('styles') ?>", readFile('styles.html'))
    .replace("<?!= include('app') ?>", readFile('app.html'));
  // Local: inject viewport meta giống GAS addMetaTag('viewport', ...) — mobile emulation chuẩn (2026-08-11)
  out = out.replace('<a href="#main-content" class="skip-link">', '<meta name="viewport" content="width=device-width, initial-scale=1">\n<a href="#main-content" class="skip-link">');

  // Guard: template syntax đổi mà không cập nhật build-local → fail loud, không sinh file hỏng.
  if (out.includes('<?!=')) {
    throw new Error('build-local: còn sót directive <?!= ... ?> chưa thay thế — index.html đổi syntax?');
  }
  fs.writeFileSync(path.join(ROOT, 'index.local.html'), out, 'utf8');
  return out;
}

if (require.main === module) {
  build();
  console.log('index.local.html built (templates resolved)');
}

module.exports = { build };
