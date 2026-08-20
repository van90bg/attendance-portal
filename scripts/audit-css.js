#!/usr/bin/env node
/**
 * scripts/audit-css.js — Rà dead CSS toàn diện cho 3 file template (index/styles/app).
 *
 * Cách dùng:  node scripts/audit-css.js
 *             node scripts/audit-css.js --full    (in cả class dùng qua nối chuỗi — mặc định ẩn)
 *
 * Cách hoạt động:
 *   1. Trích mọi class token từ selector trong styles.html (bỏ @keyframes, data-URI SVG).
 *   2. Gom nguồn dùng: index.html + app-*.html (9 module client) với các pattern:
 *      - class="..." (HTML tĩnh + chuỗi JS literal)
 *      - classList.add/remove/toggle/contains/replace('x')
 *      - className = 'x' / 'a b' (literal)
 *      - className = 'x' + var / 'a ' + (cond ? 'x' : '')  → nhóm DYNAMIC
 *      - querySelector/querySelectorAll/closest/matches('.x')
 *      - getElementsByClassName('x')
 *      - template string class="${...}"  → nhóm DYNAMIC
 *   3. Class CSS không xuất hiện ở đâu → DEAD (chắc chắn).
 *      Class chỉ xuất hiện qua nối chuỗi → DYNAMIC (in ra để xác minh thủ công).
 *
 * Exit code: 0 = không có dead chắc chắn · 1 = có dead chắc chắn (dùng được trong CI/script).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
/** Đọc toàn bộ module client app-*.html (app.html tách module — P2-2 2026-08-13). */
function readAppParts() {
  return fs.readdirSync(ROOT)
    .filter((f) => /^app-.*\.html$/.test(f))
    .sort()
    .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'))
    .join('\n');
}
const css = fs.readFileSync(path.join(ROOT, 'styles.html'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const js = readAppParts(); // app.html tách module app-*.html (P2-2 2026-08-13)

// ---- 1. Class token từ CSS selector ----
// Bỏ comment + data-URI (url("data:...svg...")) để không bắt xmlns/w3.org làm class
let cssClean = css.replace(/\/\*[\s\S]*?\*\//g, '');
cssClean = cssClean.replace(/url\(\s*["']?data:[^)]*\)/gi, '');
const cssClasses = new Set(cssClean.match(/\.([A-Za-z][A-Za-z0-9_-]*)/g) || [].map(() => null).slice(0, 0));
// Dọn tiền tố '.'
const classes = new Set();
cssClasses.forEach((m) => classes.add(m.slice(1)));
// Bỏ tên @keyframes (không phải selector)
const keyframes = new Set(css.match(/@keyframes\s+([A-Za-z0-9_-]+)/g) || [].map(() => null).slice(0, 0));
keyframes.forEach((m) => classes.delete(m.split(/\s+/)[1]));

// ---- 2. Gom nguồn dùng ----
const used = new Set();      // chắc chắn dùng (literal)
const dynamic = new Set();   // dùng qua nối chuỗi / template — cần xác minh

function addClassAttr(src) {
  const re = /class\s*=\s*["'`]([^"'`]*)["'`]/g;
  let m;
  while ((m = re.exec(src))) {
    const v = m[1];
    if (v.includes('${')) { v.split(/\s+/).forEach((t) => t && dynamic.add(t.replace(/\$\{[^}]*\}/g, ''))); }
    else { v.split(/\s+/).forEach((t) => t && used.add(t)); }
  }
}
function addClassList(src) {
  const re = /classList\.(?:add|remove|toggle|contains|replace)\(\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src))) m[1].split(/\s+/).forEach((t) => t && used.add(t));
}
function addClassNameLiteral(src) {
  // className = 'literal'  hoặc  className = "literal"
  const re = /className\s*=\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src))) m[1].split(/\s+/).forEach((t) => t && used.add(t));
}
function addClassNameConcat(src) {
  // className = 'scan-card ' + cls  |  'a ' + (cond ? 'b' : 'c')
  const re = /className\s*=\s*["']([^"']*)["']\s*\+/g;
  let m;
  while ((m = re.exec(src))) m[1].split(/\s+/).forEach((t) => t && dynamic.add(t));
  // ternary 2 vế đều literal: (ok ? '' : ' offline')  |  (x ? 'scan-card extra' : 'scan-card ok')
  const reT = /\?\s*["']([^"']*)["']\s*:\s*["']([^"']*)["']/g;
  while ((m = reT.exec(src))) { m[1].split(/\s+/).forEach((t) => t && dynamic.add(t)); m[2].split(/\s+/).forEach((t) => t && dynamic.add(t)); }
  // vế true đơn khi vế sau là nested ternary: (mode === 'err' ? 'err' : (...))
  const reT2 = /\?\s*["']([^"']+)["']/g;
  while ((m = reT2.exec(src))) m[1].split(/\s+/).forEach((t) => t && dynamic.add(t));
}
function addQuery(src) {
  const re = /(?:querySelector(?:All)?|closest|matches)\(\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src))) {
    const sel = m[1];
    const mm = sel.match(/\.([A-Za-z][A-Za-z0-9_-]*)/g) || [];
    mm.forEach((t) => used.add(t.slice(1)));
  }
}
function addGetClass(src) {
  const re = /getElementsByClassName\(\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src))) m[1].split(/\s+/).forEach((t) => t && used.add(t));
}

addClassAttr(html);
addClassAttr(js);
addClassList(js);
addClassNameLiteral(js);
addClassNameConcat(js);
addQuery(js);
addGetClass(js);

// ---- 3. Kết quả ----
const dead = [...classes].filter((c) => !used.has(c) && !dynamic.has(c)).sort();
const dynOnly = [...classes].filter((c) => !used.has(c) && dynamic.has(c)).sort();
// Class dùng trong HTML/JS nhưng KHÔNG có rule CSS (typo / thiếu style)
const htmlOnly = [...used].filter((c) => !classes.has(c) && c !== 'hidden').sort();

console.log('=== CSS audit: %d class | used: %d | dynamic: %d | DEAD: %d ===',
  classes.size, classes.size - dead.length - dynOnly.length, dynOnly.length, dead.length);

if (dead.length) {
  console.log('\n--- DEAD (chắc chắn — không có bất kỳ tham chiếu nào) ---');
  dead.forEach((c) => {
    const line = (css.split('\n').find((ln) => ln.includes('.' + c)) || '?').trim().slice(0, 90);
    console.log('  .%-28s | %s'.replace('%-28s', c.padEnd(28)).replace('%s', line));
  });
}

if (dynOnly.length && process.argv.includes('--full')) {
  console.log('\n--- DYNAMIC (chỉ qua nối chuỗi/template — xác minh thủ công) ---');
  dynOnly.forEach((c) => console.log('  .' + c));
}

if (htmlOnly.length) {
  console.log('\n--- Dùng trong HTML/JS nhưng KHÔNG có rule CSS (typo / thiếu style?) ---');
  htmlOnly.slice(0, 30).forEach((c) => console.log('  .' + c));
}

process.exit(dead.length ? 1 : 0);
