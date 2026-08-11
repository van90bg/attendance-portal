#!/usr/bin/env node
/**
 * scripts/audit-gs.js — Rà hàm/const DEAD trong 14 file .gs server.
 *
 * Cách dùng:  node scripts/audit-gs.js
 *             node scripts/audit-gs.js --full    (in cả const + hàm nội bộ đang dùng — mặc định ẩn)
 *
 * Cách hoạt động:
 *   1. Trích mọi khai báo:
 *      - Hàm global: `^function name(` (GAS không có module — mọi function top-level là public)
 *      - Const top-level: `^const NAME =` (Config.gs SHEETS/STATUS..., CsvUtil.gs SLOT_FREE_MAGIC...)
 *   2. Gom nguồn dùng (đếm số lần xuất hiện của tên với word boundary):
 *      - Toàn bộ *.gs (gọi nội bộ lẫn nhau)
 *      - index.html (template `<?!= include('app') ?>`) + app.html (client google.script.run .XxxApi())
 *      - mock/mock-google.js (handlers map — khớp API server)
 *      - tests/*.js + scripts/*.js
 *   3. Phân loại:
 *      - ENTRY (runtime/template GAS, không xuất hiện trong code): doGet · doPost · include
 *      - DEAD: hàm/const chỉ xuất hiện ĐÚNG 1 lần (dòng khai báo) — không ai gọi
 *      - API TREO: hàm *Api có trong server nhưng KHÔNG xuất hiện trong app.html (client không gọi)
 *        → drift mock↔server↔client (vd previewStaffApi từng bị xóa vì client không gọi)
 *
 * Exit code: 0 = sạch · 1 = có DEAD hoặc API treo (dùng được trong CI/script).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const GS_FILES = fs.readdirSync(ROOT).filter((f) => f.endsWith('.gs')).sort();

// ---- 1. Gom nguồn ----
function read(p) {
  try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch { return ''; }
}
const sources = {
  gs: GS_FILES.map((f) => read(f)).join('\n'),
  index: read('index.html'),
  app: read('app.html'),
  mock: read('mock/mock-google.js'),
  tests: read('tests'),
  scripts: read('scripts'),
};
// index-html-parse đọc index.html; tests dùng cả thư mục — đọc nối các file tests
let testsAll = '';
try {
  testsAll = fs.readdirSync(path.join(ROOT, 'tests')).filter((f) => f.endsWith('.js'))
    .map((f) => read(path.join('tests', f))).join('\n');
} catch { /* noop */ }
let scriptsAll = '';
try {
  scriptsAll = fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => f.endsWith('.js'))
    .map((f) => read(path.join('scripts', f))).join('\n');
} catch { /* noop */ }

const allSrc = sources.gs + '\n' + sources.index + '\n' + sources.app + '\n' + sources.mock + '\n' + testsAll + '\n' + scriptsAll;

// ---- 2. Trích khai báo ----
const funcs = {};   // name -> [file, line]
const consts = {};  // name -> [file, line]
GS_FILES.forEach((f) => {
  const content = read(f);
  content.split('\n').forEach((line, i) => {
    const fm = line.match(/^function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (fm) funcs[fm[1]] = [f, i + 1];
    const cm = line.match(/^const\s+([A-Z][A-Z0-9_]*)\s*=/);
    if (cm) consts[cm[1]] = [f, i + 1];
  });
});

// ---- 3. Phân loại ----
function countOccur(name) {
  const re = new RegExp('\\b' + name + '\\b', 'g');
  return (allSrc.match(re) || []).length;
}

const ENTRY = new Set(['doGet', 'doPost', 'include']); // GAS runtime + template include

const deadFuncs = [];
const deadConsts = [];
Object.keys(funcs).forEach((name) => {
  if (ENTRY.has(name)) return;
  if (countOccur(name) <= 1) deadFuncs.push(name);
});
Object.keys(consts).forEach((name) => {
  if (countOccur(name) <= 1) deadConsts.push(name);
});

// API treo: *Api trong server nhưng client (app.html) không gọi
const serverApis = Object.keys(funcs).filter((n) => n.endsWith('Api'));
const treoApis = serverApis.filter((n) => {
  const re = new RegExp('\\b' + n + '\\b', 'g');
  return !(sources.app.match(re) || []);
});

// ---- 4. In kết quả ----
console.log('=== GS audit: %d hàm | %d const | DEAD hàm: %d | DEAD const: %d | API treo: %d ===',
  Object.keys(funcs).length, Object.keys(consts).length, deadFuncs.length, deadConsts.length, treoApis.length);

function fmt(name, loc) {
  return '  ' + name.padEnd(32) + ' | ' + loc[0] + ':' + loc[1];
}

if (deadFuncs.length) {
  console.log('\n--- DEAD FUNCTION (chỉ xuất hiện ở dòng khai báo — không ai gọi) ---');
  deadFuncs.forEach((n) => console.log(fmt(n, funcs[n])));
}
if (deadConsts.length) {
  console.log('\n--- DEAD CONST (không ai đọc) ---');
  deadConsts.forEach((n) => console.log(fmt(n, consts[n])));
}
if (treoApis.length) {
  console.log('\n--- API TREO (server có nhưng client app.html KHÔNG gọi — drift mock↔server↔client) ---');
  treoApis.forEach((n) => console.log(fmt(n, funcs[n])));
}
if (!deadFuncs.length && !deadConsts.length && !treoApis.length) {
  console.log('\nSạch — không có hàm/const/API dead.');
}

process.exit(deadFuncs.length || deadConsts.length || treoApis.length ? 1 : 0);
