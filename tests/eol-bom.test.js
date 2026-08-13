/**
 * tests/eol-bom.test.js — Guard bất biến AGENTS.md rule 1 (P1-2, 2026-08-13).
 *
 * Kiểm tra MỌI file nguồn GAS (.gs + 3 template) trên disk:
 *  1. KHÔNG có UTF-8 BOM đầu file (BOM đầu index.html = khoảng trắng trên header khi
 *     serve qua GAS — lesson 9982293; BOM cũ tồn tại ở Code.gs/TaskService.gs/
 *     SettingsService.gs do write utf-8-sig — đã xóa).
 *  2. Dùng CRLF (không LF-only) — file trên disk phải CRLF; .gitattributes
 *     `text eol=crlf` đảm bảo index lưu LF, checkout ra CRLF trên mọi platform.
 *
 * Nếu guard này fail: chạy lại normalization (xem AGENTS.md §3), KHÔNG commit file
 * BOM/LF-only vì sẽ tái phát churn + lỗi hiển thị trên GAS.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..');

/** Mọi file nguồn GAS phải tuân thủ invariant: .gs + index/styles/app. */
function sourceFiles() {
  const gs = fs.readdirSync(ROOT).filter((f) => f.endsWith('.gs'));
  // app.html tách module app-*.html (P2-2 2026-08-13) — mọi part phải tuân thủ invariant
  const appParts = fs.readdirSync(ROOT).filter((f) => /^app-.*\.html$/.test(f)).sort();
  return ['index.html', 'styles.html'].concat(appParts, gs);
}

test('mọi file nguồn KHÔNG có UTF-8 BOM đầu file', function () {
  sourceFiles().forEach(function (f) {
    const raw = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.notEqual(raw.charCodeAt(0), 0xfeff, f + ' bắt đầu bằng UTF-8 BOM (EF BB BF) — phải ghi utf-8 KHÔNG sig');
  });
});

test('mọi file nguồn dùng CRLF trên disk (không LF-only)', function () {
  sourceFiles().forEach(function (f) {
    const raw = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const lf = (raw.match(/\n/g) || []).length;
    const crlf = (raw.match(/\r\n/g) || []).length;
    assert.equal(lf, crlf, f + ' có ' + (lf - crlf) + ' LF không kèm CR (file phải CRLF — AGENTS.md rule 1)');
  });
});
