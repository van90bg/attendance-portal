// Regression: fmtClockHMS bị khai báo lồng bên trong thân hàm esc() (lệch ngoặc)
// → scope cục bộ của esc, gọi từ renderStaffDataTable (toàn cục) bị ReferenceError
// → bảng StaffData không bao giờ render (skeleton treo). Bug từ commit cũ, tồn tại
// qua nhiều lần upload CRLF (a96381b...). Test này bắt cấu trúc, không cần DOM.
'use strict';

const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');

// index.html giờ là GAS template (<?!= include() ?>) — gộp 3 file về 1 trước khi parse.
const { build } = require('../scripts/build-local.js');
build();
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.local.html'), 'utf8');

function extractInlineScript(src) {
  const m = src.match(/<script[^>]*>([\s\S]*?)<\/script>/g) || [];
  let body = '';
  m.forEach(function (tag) {
    const inner = tag.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
    body += inner + '\n';
  });
  return body;
}

// Brace-matcher bỏ qua: comment // /* */, chuỗi ' " ` (template), regex literal
// (heuristic: '/' không đứng sau identifier/')'/'}'/']' hoặc regex chứa {n,m}).
function matchingBrace(src, openIdx) {
  let depth = 0;
  let inStr = null;
  let inTpl = false;
  let inRegex = false;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    const prev = i > 0 ? src[i - 1] : '';
    const prev2 = i > 1 ? src[i - 2] : '';
    if (inRegex) {
      if (ch === '\\') { i++; continue; }
      if (ch === '/') inRegex = false;
      continue;
    }
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === inStr) {
        inStr = null;
        if (inTpl) inTpl = false;
      }
      continue;
    }
    // comment
    if (ch === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    // string / template
    if (ch === '"' || ch === "'") { inStr = ch; continue; }
    if (ch === '`') { inStr = '`'; inTpl = true; continue; }
    // regex heuristic
    if (ch === '/' && !/[A-Za-z0-9_$)\]'"`]/.test(prev)) {
      inRegex = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

test('index.html inline script parse OK (new Function)', function () {
  const body = extractInlineScript(indexHtml);
  assert.ok(body.length > 5000, 'script inline phải tồn tại');
  assert.doesNotThrow(function () { new Function(body); }, 'script phải parse được');
});

test('fmtClockHMS được khai báo ở phạm vi toàn cục, KHÔNG lồng trong esc()', function () {
  const body = extractInlineScript(indexHtml);
  const escIdx = body.indexOf('function esc(');
  const fIdx = body.indexOf('function fmtClockHMS(');
  assert.ok(escIdx >= 0, 'phải có function esc(');
  assert.ok(fIdx > escIdx, 'phải có function fmtClockHMS');
  const escClose = matchingBrace(body, body.indexOf('{', escIdx));
  assert.ok(escClose >= 0, 'esc phải đóng ngoặc hợp lệ');
  assert.ok(fIdx > escClose,
    'fmtClockHMS bị khai báo TRONG thân esc() (lệch ngoặc) → ReferenceError khi render bảng StaffData. ' +
    'Phải tách fmtClockHMS ra khỏi esc, ở phạm vi toàn cục: escClose=' + escClose + ' fmtIdx=' + fIdx);
  const eaIdx = body.indexOf('function escAttr(');
  assert.ok(eaIdx > escClose, 'escAttr cũng không được lồng trong esc()');
});

test('fmtClockHMS (staffTable) format HH:mm:ss giống scanTable/fmtDate', function () {
  const body = extractInlineScript(indexHtml);
  const fIdx = body.indexOf('function fmtClockHMS(');
  assert.ok(fIdx >= 0, 'phải có function fmtClockHMS');
  const fmtClockHMS = new Function('return (' + body.slice(fIdx, matchingBrace(body, body.indexOf('{', fIdx)) + 1) + ');')();
  assert.equal(fmtClockHMS(new Date(1899, 11, 30, 8, 12, 5)), '08:12:05', 'Date sheet (time-only) → HH:mm:ss');
  assert.equal(fmtClockHMS('7:12:05'), '07:12:05', 'chuỗi giờ 1 chữ số → pad 0');
  assert.equal(fmtClockHMS('07:12:05'), '07:12:05');
  assert.equal(fmtClockHMS('17:30:00'), '17:30:00');
  assert.equal(fmtClockHMS(''), '');
});
// Regression: cột Đối tượng nhật ký admin hiện JSON thô ({"saved":["roleMap"]})
// khi targetId trống (settings) — auditTargetText_ phải parse + nhãn tiếng Việt.
test('auditTargetText_: settings targetId trống → nhãn đọc được, không JSON thô', function () {
  const body = extractInlineScript(indexHtml);
  const fIdx = body.indexOf('function auditTargetText_(');
  assert.ok(fIdx >= 0, 'phải có function auditTargetText_');
  const fn = new Function('return (' + body.slice(fIdx, matchingBrace(body, body.indexOf('{', fIdx)) + 1) + ');')();
  assert.equal(fn({ targetId: 'R2026', detail: '{"absentCount":2}' }), 'R2026', 'targetId có sẵn → giữ nguyên');
  assert.equal(fn({ targetId: '', detail: '{"saved":["roleMap"]}' }), 'Đã lưu: roleMap', 'settings → nhãn tiếng Việt');
  assert.equal(fn({ targetId: '', detail: '{"saved":["roleMap","stations"]}' }), 'Đã lưu: roleMap, stations', 'nhiều key → liệt kê');
  assert.equal(fn({ targetId: '', detail: 'không-phải-json' }), 'không-phải-json', 'detail không phải JSON → fallback');
  assert.equal(fn({ targetId: '', detail: '' }), '—');
});

// Mở Thống kê/Dữ liệu không tự fetch mỗi lần (StaffData ít đổi, cache theo khung giờ) — RED→GREEN
test('ensureStaffData: mở view KHÔNG gọi loadStaffView trực tiếp (dùng cache client)', function () {
  const body = extractInlineScript(indexHtml);
  assert.ok(body.indexOf('function ensureStaffData(') >= 0, 'phải có function ensureStaffData');
  // selectPage(auto-open) phải gọi ensureStaffData(false), KHÔNG còn loadStaffView() tự động
  const autoOpen = body.match(/page === 'stats' \|\| page === 'data'[\s\S]{0,80}?loadStaffView\(\)/);
  assert.ok(!autoOpen, 'selectPage vẫn gọi loadStaffView() khi mở view → mỗi lần mở lại fetch (sai). Phải là ensureStaffData(false)');
  assert.ok(/page === 'stats' \|\| page === 'data'[\s\S]{0,90}?ensureStaffData\(false\)/.test(body),
    'selectPage phải gọi ensureStaffData(false) khi mở stats/data');
});
// Regression guard: UTF-8 BOM ở đầu index.html serve qua GAS sinh khoảng trống phía trên header
// (lesson 9982293; BOM tái xuất ở 673d01a do write utf-8-sig). Cả 3 file template phải không BOM.
test('index/styles + mọi module app-* KHÔNG có BOM đầu file', function () {
  const parts = ['index.html', 'styles.html'].concat(
    fs.readdirSync(path.join(__dirname, '..')).filter((f) => /^app-.*\.html$/.test(f))
  );
  parts.forEach(function (f) {
    const raw = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.notEqual(raw.charCodeAt(0), 0xfeff, f + ' bắt đầu bằng UTF-8 BOM — xóa BOM');
  });
});
// M1: index.html include app-* theo thứ tự cố định — core luôn trước cảm khác
// để các hàm global (META, LAST_SERVER_CONFIG, repairViewParents) có sẵn khi module khác gọi.
// Thỏa thuận dự án: core → stats/staff/modals/config → tasks/scan/reports/admin.
test('index.html include app-* đúng thứ tự: core trước modules phụ thuộc', function () {
  const idxSrc = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const order = [];
  const re = /include\(['"](app-[^'"]+)['"]\) \?>/g;
  let m;
  while ((m = re.exec(idxSrc)) !== null) order.push(m[1].replace(/^app-/, ''));
  assert.ok(order[0] === 'core', 'app-core phải include đầu tiên (global bootstrap), thực tế đầu tiên: ' + order[0]);
  const coreIdx = order.indexOf('core');
  const deps = ['stats','staff','modals','config','tasks','scan','reports','admin'];
  deps.forEach(function (dep) {
    const idx = order.indexOf(dep);
    assert.ok(idx > coreIdx, 'app-' + dep + ' phải include SAU app-core (bootstrap global), core=' + coreIdx + ' dep=' + idx);
  });
  assert.deepEqual(order.sort(), ['admin','config','core','modals','reports','scan','staff','stats','tasks'],
    'phân bố include phải đủ 9 module, không thừa/thiếu. Thực tế: ' + JSON.stringify(order));
});
