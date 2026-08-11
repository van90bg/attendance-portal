#!/usr/bin/env node
/**
 * scripts/audit-ui.js — Audit CDP toàn diện: 7 view (home/tasks/scan/stats/staff/config/reports)
 * x nhiều viewport (desktop · tablet · mobile) — rà layout vỡ / scroll / nav che / card chạm đáy.
 *
 * Cách dùng:  node scripts/audit-ui.js            (4 viewport mặc định: 1384x900 · 1024x768 · 390x844 · 375x667)
 *             node scripts/audit-ui.js --quick     (chỉ desktop 1384x900 — nhanh, ~20s)
 *             node scripts/audit-ui.js 820x1180    (viewport tùy chọn, cách nhau dấu cách)
 *
 * Cách hoạt động:
 *   1. Tự build index.local.html (scripts/build-local.js) rồi boot Chrome headless CDP (port 9222 —
 *      dùng Chrome đang chạy nếu có, không thì tự spawn riêng, tự dọn).
 *   2. Với mỗi viewport: mở 7 view, đo geometry (getBoundingClientRect — geometry là truth):
 *      - View hiển thị đúng (section active)
 *      - Trang KHÔNG cuộn (body height:100vh + overflow hidden — nội dung dài cuộn TRONG card)
 *      - Bottom nav mobile không che nội dung
 *      - Card vừa màn hình (đo theo viewport THẬT = body height — KHÔNG innerHeight:
 *        headless mobile emulation báo innerHeight 1007 nhưng body 844, đo nhầm → gap giả 247px)
 *      - Bảng có dữ liệu (Tasks/Scan/Staff/Stats)
 *      - viewScan mobile: card cao hơn section là ĐÚNG (section overflow-y:auto cuộn trong) — miễn trừ
 *   3. In PASS/FAIL từng check + summary, exit code 0/1 (dùng được trong CI/script).
 *
 * Ghi chú quirk headless: mobile emulation báo innerWidth/Height theo layout viewport (465/1007)
 * trong khi clientWidth/Height theo CSS viewport (375/844) — mọi đo đạc dùng body/client, không inner*.
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

// Viewport mặc định: desktop · tablet · mobile 390 · mobile 375
const DEFAULT_VIEWPORTS = [
  { w: 1384, h: 900, label: 'desktop', mobile: false },
  { w: 1024, h: 768, label: 'tablet', mobile: false },
  { w: 390, h: 844, label: 'mobile390', mobile: true },
  { w: 375, h: 667, label: 'mobile375', mobile: true },
];

// CLI: --quick (chỉ desktop) hoặc viewport tùy chọn "WxH"
let viewports = DEFAULT_VIEWPORTS;
const args = process.argv.slice(2);
if (args.includes('--quick')) {
  viewports = [{ w: 1384, h: 900, label: 'desktop', mobile: false }];
} else {
  const custom = args.filter((a) => /^\d+x\d+$/.test(a)).map((a) => {
    const [w, h] = a.split('x').map(Number);
    return { w, h, label: `${w}x${h}`, mobile: false };
  });
  if (custom.length) viewports = custom;
}

let chromeProc = null;
async function ensureCdp() {
  try { await httpGet('/json/version'); return; } catch (e) { /* chưa mở */ }
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollcall-audit-ui-'));
  const exe = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  console.log('Boot Chrome headless (CDP port ' + CDP_PORT + ')...');
  chromeProc = spawn(exe, [
    '--headless=new', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + userDataDir,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    try { await httpGet('/json/version'); return; } catch (e) { /* retry */ }
  }
  throw new Error('Không mở được CDP port sau 10s');
}

function httpGet(p) {
  return new Promise((resolve, reject) => {
    const req = http.request(CDP_HTTP + p, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Bad JSON: ' + data.slice(0, 80))); } });
    });
    req.on('error', reject);
    req.end();
  });
}

let msgId = 0;
const pending = new Map();
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('WS error'));
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function evalIn(ws, expression) {
  const res = await send(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) return { err: (res.exceptionDetails.exception && res.exceptionDetails.exception.description) || 'exception' };
  return { value: res.result && res.result.value };
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// Đo geometry view active — viewport THẬT = body height (tránh artifact innerHeight của mobile emulation)
const MEASURE = `(() => {
  var sec = document.querySelector('main section:not(.hidden)');
  if (!sec) return { err: 'no visible section' };
  var id = sec.id;
  var card = sec.querySelector('.card');
  var nav = document.getElementById('bottomNav');
  var sidebar = document.getElementById('sidebar');
  var vh = Math.round(document.body.getBoundingClientRect().height);
  var navTop = nav && getComputedStyle(nav).display !== 'none' ? Math.round(nav.getBoundingClientRect().top) : null;
  var secR = sec.getBoundingClientRect();
  var cardR = card ? card.getBoundingClientRect() : null;
  var tbl = sec.querySelector('table');
  return {
    id: id,
    pageScrollable: document.documentElement.scrollHeight > vh + 5,
    secBottom: Math.round(secR.bottom),
    navTop: navTop,
    coveredByNav: navTop != null && secR.bottom > navTop + 2,
    cardBottomGap: cardR ? Math.round(vh - cardR.bottom) : null,
    tblRows: tbl ? tbl.rows.length : 0,
    tblCols: tbl && tbl.rows[0] ? tbl.rows[0].cells.length : 0,
  };
})()`;

async function runViewport(ws, vp) {
  const { w, h, label, mobile } = vp;
  await send(ws, 'Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile: !!mobile });
  await send(ws, 'Page.navigate', { url: INDEX_FILE });
  await sleep(2500);

  const pages = ['home', 'attendance', 'scan', 'stats', 'data', 'config', 'reports'];
  const openScan = `(() => {
    if (typeof openScan === 'function') {
      var tr = document.querySelector('#taskListTable tbody tr');
      if (tr) { var btn = tr.querySelector('button'); if (btn) { btn.click(); return 'clicked'; } }
    }
    selectPage('attendance');
    return 'fallback';
  })()`;

  for (const pg of pages) {
    if (pg === 'scan') { await evalIn(ws, openScan); }
    else { await evalIn(ws, `selectPage('${pg}')`); }
    await sleep(650);
    const m = await evalIn(ws, MEASURE);
    const v = m.value || {};
    if (v.err) { check(`${label}/?: ${v.err}`, false); continue; }

    const n = `${label}/${v.id || pg}`;
    check(`${n}: view hiển thị`, !!v.id, `id=${v.id}`);
    check(`${n}: trang không cuộn`, v.pageScrollable === false);
    if (v.navTop != null) check(`${n}: nav không che view`, !v.coveredByNav, `secBottom=${v.secBottom} navTop=${v.navTop}`);
    if (v.cardBottomGap != null) {
      // viewScan mobile: card cao hơn section (cuộn trong) — gap âm là ĐÚNG thiết kế
      if (v.id === 'viewScan' && mobile) {
        check(`${n}: card nội dung cuộn trong section`, v.cardBottomGap < 0, `gap=${v.cardBottomGap}`);
      } else {
        const ok = v.cardBottomGap >= 0 && v.cardBottomGap <= (mobile ? 100 : 40);
        check(`${n}: card vừa màn hình`, ok, `gap=${v.cardBottomGap}`);
      }
    }
    if (['viewTasks', 'viewScan', 'viewStaff', 'viewStats'].indexOf(v.id) !== -1) {
      check(`${n}: bảng có dữ liệu`, v.tblRows > 0, `rows=${v.tblRows} cols=${v.tblCols}`);
    }
  }
}

async function main() {
  await ensureCdp();
  const tabs = await httpGet('/json/list');
  const tab = tabs.find((t) => t.type === 'page');
  const ws = await connect(tab.webSocketDebuggerUrl);
  setupListener(ws);
  await send(ws, 'Page.enable');
  await send(ws, 'Runtime.enable');

  for (const vp of viewports) await runViewport(ws, vp);

  const fails = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - fails.length}/${results.length} PASS ===`);
  if (fails.length) {
    console.log('\n--- FAIL list ---');
    fails.forEach((f) => console.log('FAIL', f.name, '—', f.detail || ''));
  }
  if (chromeProc) chromeProc.kill();
  process.exit(fails.length ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); if (chromeProc) chromeProc.kill(); process.exit(2); });
