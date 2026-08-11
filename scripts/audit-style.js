#!/usr/bin/env node
/**
 * scripts/audit-style.js — Rà computed style class DÙNG CHUNG giữa các view qua CDP.
 *
 * Cách dùng:  node scripts/audit-style.js
 *             node scripts/audit-style.js --strict   (exit 1 nếu có class chung lệch style — guard CI)
 *
 * Cách hoạt động:
 *   1. Tự build template (build-local.js) → index.local.html
 *   2. Boot Chrome headless (CDP port 9222 — tự spawn nếu chưa mở) + mở file://
 *   3. Bỏ hidden mọi view (viewHome..viewAbout) → đo computed style mọi instance
 *      của các class dùng chung (khai báo SHARED_CLASSES — mở rộng khi thêm class)
 *   4. Nhóm instance theo fingerprint (bg/color/border/radius/padding/font/min-height)
 *      → class có 1 fingerprint = đồng nhất · >1 = LỆCH (in chi tiết nơi dùng)
 *
 * Lưu ý: một số lệch là CHỦ ĐÍCH (vd .btn trong modal 44px touch vs ngoài 10px; btn-sm nhỏ).
 * Chạy thường: in tất cả để xác minh thủ công. `--strict`: exit 1 nếu có class >1 fingerprint
 * (dùng trong CI — nếu thêm lệch chủ đích mới, cập nhật ALLOWED_DRIFT dưới đây).
 */
'use strict';

const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const { build } = require('./build-local.js');

build();

const CDP_PORT = 9222;
const CDP_HTTP = 'http://127.0.0.1:' + CDP_PORT;
const INDEX_FILE = 'file:///' + path.resolve(__dirname, '..', 'index.local.html').replace(/\\/g, '/');
const LOAD_WAIT_MS = 2500;

// Class dùng chung ≥2 view/modal — thêm class mới vào đây khi thêm component
// (KHÔNG đưa class base như .btn — nó match mọi variant → 11 fingerprint nhiễu; so variant riêng)
const SHARED_CLASSES = [
  'btn-ghost', 'btn-outline', 'btn-danger', 'btn-amber', 'btn-sm', 'btn-icon', 'btn-clear-filter',
  'card', 'empty', 'table-wrap', 'view-topbar', 'view-topbar-title', 'list-search', 'section-heading',
  'task-title', 'task-meta', 'task-count-badge', 'chips', 'pick', 'field-select', 'cfg-input',
  'cfg-field', 'cfg-section-title', 'cfg-hint', 'flabel', 'fnote', 'counter', 'empty-arrow',
  'paste-title', 'confirm-title', 'reports-empty-title', 'about-title', 'home-title',
];

// Lệch CHỦ ĐÍCH được phép (class → mô tả) — chỉ dùng với --strict
const ALLOWED_DRIFT = [
  'btn-sm',            // nút nhỏ trong bảng — padding 6/12 + 13px là chủ đích
  'btn-ghost',         // nút "Xem" (btn-sm) + modal Huỷ (44px touch) — chủ đích
  'btn-outline',       // + Add role (btn-sm) + modal (44px touch) — chủ đích
  'btn-danger',        // confirmOkBtn trong modal (44px touch) — chủ đích
  'cfg-card',          // card form Cấu hình — padding 16px khác card thường
  'flabel',            // viewStats label cột min-width 56px (căn dọc) vs modal auto — chủ đích
  'pick',              // .pick.on (active: nền cam + weight 700) vs .pick thường — trạng thái chọn là chủ đích
  'card',              // card trong scan-layout là flex item (min-width auto) — chủ đích
  'table-wrap',        // scan table là flex item (min-width auto) — chủ đích
];

let chromeProc = null;
function httpGet(p, method) {
  return new Promise((resolve, reject) => {
    const req = http.request(CDP_HTTP + p, { method: method || 'GET' }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Bad JSON: ' + data.slice(0, 80))); } });
    });
    req.on('error', reject);
    req.end();
  });
}

async function ensureCdp() {
  try { await httpGet('/json/version'); return; } catch { /* chưa mở */ }
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollcall-style-'));
  const exe = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  chromeProc = spawn(exe, [
    '--headless=new', '--disable-gpu', '--allow-file-access-from-files',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + userDataDir,
    '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { await httpGet('/json/version'); return; } catch { /* retry */ }
  }
  throw new Error('Không mở được CDP port sau 10s');
}

let msgId = 0;
const pending = new Map();
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error('WS error: ' + (e && e.message)));
  });
}
function send(ws, method, params) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}
function setupListener(ws) {
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  };
}
async function evalIn(ws, expression) {
  const res = await send(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) return { err: (res.exceptionDetails.exception && res.exceptionDetails.exception.description) || 'exception' };
  return { value: res.result && res.result.value };
}

// Expression đo computed style — trả về map class → [ { fp, n, where[] } ]
function probeExpr() {
  const classes = JSON.stringify(SHARED_CLASSES);
  const keys = JSON.stringify(['backgroundColor', 'color', 'borderTopColor', 'borderRadius', 'paddingTop', 'paddingLeft', 'fontSize', 'fontWeight', 'minHeight', 'minWidth', 'textTransform']);
  return `JSON.stringify((() => {
    const CLASSES = ${classes};
    const KEYS = ${keys};
    const VIEWS = ['viewHome', 'viewTasks', 'viewScan', 'viewStats', 'viewStaff', 'viewConfig', 'viewReports', 'viewAbout'];
    VIEWS.forEach(id => { const el = document.getElementById(id); if (el) el.classList.remove('hidden'); });
    const out = {};
    CLASSES.forEach(cls => {
      const els = Array.from(document.querySelectorAll('.' + cls));
      if (!els.length) return;
      const groups = {};
      els.forEach(el => {
        if (getComputedStyle(el).display === 'none') return; // bỏ element đang hidden — computed min-height 0px gây nhiễu giả lệch
        const s = getComputedStyle(el);
        const fp = KEYS.map(k => s[k]).join('|');
        const parent = el.closest('section') || { id: 'modal?' };
        (groups[fp] = groups[fp] || []).push((parent.id || 'modal') + ':' + (el.id || el.className.split(' ').slice(0, 2).join('.')));
      });
      out[cls] = Object.keys(groups).map(fp => ({ fp, n: groups[fp].length, where: groups[fp] }));
    });
    return out;
  })())`;
}

async function main() {
  console.log('INDEX:', INDEX_FILE);
  await ensureCdp();

  const target = await httpGet('/json/new?' + encodeURIComponent(INDEX_FILE), 'PUT');
  console.log('Opened tab:', target.id);
  await new Promise((r) => setTimeout(r, LOAD_WAIT_MS));

  const ws = await connect(target.webSocketDebuggerUrl);
  setupListener(ws);
  await send(ws, 'Runtime.enable');

  const probe = await evalIn(ws, probeExpr());
  if (probe.err || !probe.value) { console.error('PROBE FAIL:', probe.err); process.exit(1); }
  const result = JSON.parse(probe.value);

  // Phân loại: class 1 nhóm = đồng nhất; >1 nhóm = lệch (in chi tiết)
  const drifted = [];
  Object.keys(result).sort().forEach((cls) => {
    const groups = result[cls];
    if (!groups.length || groups.length === 1) return; // 0 instance hiển thị hoặc đồng nhất
    drifted.push(cls);
    console.log(`\n[LỆCH] .${cls} — ${groups.length} fingerprint, ${groups.reduce((a, g) => a + g.n, 0)} instance:`);
    groups.forEach((g) => console.log(`  ${g.fp.replace(/\|/g, ' | ')}  (×${g.n})  [${g.where.join(', ')}]`));
  });

  const allowed = new Set(ALLOWED_DRIFT);
  const realDrift = drifted.filter((c) => !allowed.has(c));
  console.log(`\n=== Style audit: ${Object.keys(result).length} class chung | đồng nhất: ${Object.keys(result).length - drifted.length} | lệch: ${drifted.length} | lệch thật (--strict): ${realDrift.length} ===`);

  if (ws) { try { await send(ws, 'Page.close'); } catch { /* noop */ } }
  if (chromeProc) { try { chromeProc.kill(); } catch { /* noop */ } }

  const strict = process.argv.includes('--strict');
  process.exit(strict && realDrift.length ? 1 : 0);
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
