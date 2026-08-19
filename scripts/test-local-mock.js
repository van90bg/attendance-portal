/**
 * scripts/test-local-mock.js — Tự động test UI trên LOCAL MOCK (file://) qua CDP.
 *
 * Usage:
 *   node scripts/test-local-mock.js
 *
 * Yêu cầu: Chrome đang chạy với --remote-debugging-port=9222.
 * Mở tab mới trỏ tới file://.../index.html → mock-google.js tự nạp (chế độ LOCAL).
 * Chạy chuỗi test rồi in PASS/FAIL, exit code 0/1.
 *
 * Không đụng GAS production — chỉ test UI + mock logic local.
 */
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const { build } = require('./build-local.js'); // index.html giờ là GAS template — gộp 3 file → index.local.html
build();

const CDP_PORT = 9222;
const CDP_HTTP = 'http://127.0.0.1:' + CDP_PORT;
const INDEX_FILE = 'file:///' + path.resolve(__dirname, '..', 'index.local.html').replace(/\\/g, '/');
const SETTLE_MS = 500;   // mock trả sau 250ms — đủ để UI cập nhật
const LOAD_WAIT_MS = 2500;

// Chrome đang chạy qua remote-debugging-pipe (Hermes MCP) → không có port HTTP.
// Tự spawn Chrome headless RIÊNG với --remote-debugging-port để script chạy độc lập.
let chromeProc = null;
async function ensureCdp() {
  try {
    await httpGet('/json/version');
    return; // đã có CDP port
  } catch (e) { /* chưa mở */ }
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollcall-mock-'));
  const exe = process.env.CHROME_PATH || [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',  // Windows (default dev box)
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',  // Linux (codespace)
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
  ].find(function (p) { return fs.existsSync(p); }) || 'google-chrome';
  console.log('Boot Chrome headless (CDP port ' + CDP_PORT + ')...');
  chromeProc = spawn(exe, [
    '--headless=new',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + userDataDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'about:blank',
  ], { stdio: 'ignore' });
  // Chờ port mở (tối đa 10s)
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    try { await httpGet('/json/version'); return; } catch (e) { /* retry */ }
  }
  throw new Error('Không mở được CDP port sau 10s');
}

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function evalIn(ws, expression) {
  const res = await send(ws, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) return { err: (res.exceptionDetails.exception && res.exceptionDetails.exception.description) || 'exception' };
  return { value: res.result && res.result.value };
}

async function main() {
  console.log('INDEX:', INDEX_FILE);

  // 0. Đảm bảo CDP port (tự boot Chrome headless nếu cần)
  await ensureCdp();

  // 1. Mở tab mới
  const target = await httpGet('/json/new?' + encodeURIComponent(INDEX_FILE), 'PUT');
  console.log('Opened tab:', target.id);
  await sleep(LOAD_WAIT_MS);

  const ws = await connect(target.webSocketDebuggerUrl);
  setupListener(ws);
  await send(ws, 'Runtime.enable');

  // 2. App đã load với mock?
  const load = await evalIn(ws, `JSON.stringify({
    title: document.title,
    hasMock: !!(window.google && window.google.script && window.google.script.run),
    metaLoaded: !!(window.META && window.META.appTitle),
    appTitle: window.META ? window.META.appTitle : null,
    hasViewList: !!document.getElementById('viewTasks'),
    hasScanTable: !!document.getElementById('scanTable'),
  })`);
  const L = load.err ? null : JSON.parse(load.value);
  check('App load + mock nạp (google.script.run)', !!(L && L.hasMock && L.metaLoaded), L ? L.appTitle + ' / ' + L.title : load.err);
  check('Meta appTitle = LOCAL MOCK', !!(L && L.metaLoaded && /LOCAL MOCK/.test(L.appTitle)), L && L.appTitle);
  check('DOM đủ: viewTasks + scanTable', !!(L && L.hasViewList && L.hasScanTable));

  // 3. Task list render (mock: 2 tasks)
  const tl = await evalIn(ws, `JSON.stringify((function(){
    var rows = document.querySelectorAll('#taskListTable tbody tr');
    return { count: rows.length, first: rows[0] ? rows[0].innerText.slice(0,120) : '' };
  })())`);
  const TL = tl.err ? null : JSON.parse(tl.value);
  check('Task list render ≥ 1 dòng', !!(TL && TL.count >= 1), TL ? TL.count + ' rows' : tl.err);

  // 4. Mở task đầu tiên (open) — mock: R20260802-0900, 5 Outbound, 2 scanned
  const open = await evalIn(ws, `(function(){
    if (typeof openScan !== 'function') return 'no-openScan';
    var first = document.querySelector('#taskListTable tbody tr');
    var id = first && first.getAttribute('data-task-id');
    if (!id) { var m = first && first.innerText.match(/R\\d{8}-\\d{4}/); id = m ? m[0] : null; }
    if (!id) return 'no-task-id';
    openScan(id);
    return 'opened:' + id;
  })()`);
  await sleep(SETTLE_MS);
  const vs = await evalIn(ws, `JSON.stringify((function(){
    var view = document.getElementById('viewScan');
    var visible = view && !view.classList.contains('hidden');
    var rows = document.querySelectorAll('#scanTableBody tr');
    return {
      visible: !!visible,
      rows: rows.length,
      cScanned: document.getElementById('cScanned') ? document.getElementById('cScanned').innerText : null,
      cAbsent: document.getElementById('cAbsent') ? document.getElementById('cAbsent').innerText : null,
      cExtra: document.getElementById('cExtra') ? document.getElementById('cExtra').innerText : null,
      scanInput: !!document.getElementById('scanInput'),
    };
  })())`);
  const VS = vs.err ? null : JSON.parse(vs.value);
  check('openScan → viewScan hiển thị', !!(VS && VS.visible), open.value || open.err);
  check('scanTable có dòng log', !!(VS && VS.rows >= 1), VS ? VS.rows + ' rows' : vs.err);
  // Client phase OPEN: counter 1 = 'Có mặt' (presentAt), counter 2 = 'Chưa có mặt'
  // (roster chưa tới = total - presentAt - extra — FREE không roster → 0).
  // Mock: total=6, presentAt=2, extra=1 → cAbsent = 6-2-1 = 3.
  check('Counter ban đầu (mock 6 dòng log: 2 có mặt / 3 chưa / 1 dư) → S:2 A:3 E:1',
    !!(VS && VS.cScanned === '2' && VS.cAbsent === '3' && VS.cExtra === '1'),
    VS ? 'S:' + VS.cScanned + ' A:' + VS.cAbsent + ' E:' + VS.cExtra : vs.err);

  // 5. Quét NV chưa có mặt (Ops229444) → Có mặt, counter 1 (presentAt) 2→3,
  // counter 2 (chưa có mặt) 3→2 — dòng vừa quét KHÔNG bị đếm nhầm vào 'Chưa có mặt'.
  const scan1 = await evalIn(ws, `(function(){
    var input = document.getElementById('scanInput');
    input.value = 'Ops229444';
    if (typeof submitScan === 'function') submitScan();
    return 'submitted';
  })()`);
  await sleep(SETTLE_MS);
  const s1 = await evalIn(ws, `JSON.stringify({
    cScanned: document.getElementById('cScanned').innerText,
    cAbsent: document.getElementById('cAbsent').innerText,
    toast: document.getElementById('toast') ? document.getElementById('toast').innerText : '',
  })`);
  const S1 = s1.err ? null : JSON.parse(s1.value);
  check('Quét Ops229444 (phase 1) → Có mặt 2→3, Chưa có mặt 3→2',
    !!(S1 && S1.cScanned === '3' && S1.cAbsent === '2'), S1 ? 'cScanned=' + S1.cScanned + ' cAbsent=' + S1.cAbsent : s1.err);

  // 6. Quét trùng (Ops237511 đã có mặt) → không tăng counter
  const scan2 = await evalIn(ws, `(function(){
    var input = document.getElementById('scanInput');
    input.value = 'Ops237511';
    submitScan();
    return 'submitted';
  })()`);
  await sleep(SETTLE_MS);
  const s2 = await evalIn(ws, `JSON.stringify({
    cScanned: document.getElementById('cScanned').innerText,
    toast: document.getElementById('toast') ? document.getElementById('toast').innerText : '',
  })`);
  const S2 = s2.err ? null : JSON.parse(s2.value);
  check('Quét trùng Ops237511 → vẫn 3 (mock reject)', !!(S2 && S2.cScanned === '3'), S2 ? 'cScanned=' + S2.cScanned + ' toast=' + S2.toast : s2.err);

  // 7. Quét NV lạ (Ops777777) → Dư, counter extra 1→2
  const scan3 = await evalIn(ws, `(function(){
    var input = document.getElementById('scanInput');
    input.value = 'Ops777777';
    submitScan();
    return 'submitted';
  })()`);
  await sleep(SETTLE_MS);
  const s3 = await evalIn(ws, `JSON.stringify({
    cExtra: document.getElementById('cExtra').innerText,
    toast: document.getElementById('toast') ? document.getElementById('toast').innerText : '',
  })`);
  const S3 = s3.err ? null : JSON.parse(s3.value);
  check('Quét NV lạ Ops777777 → Dư 1→2', !!(S3 && S3.cExtra === '2'), S3 ? 'cExtra=' + S3.cExtra + ' toast=' + S3.toast : s3.err);

  // 7b. Chuyển điểm danh → phase 2: badge cột Trạng thái đổi NGAY (không mở lại task),
  // counter label 'Đã điểm danh'/'Chưa điểm danh' + giá trị phase 2.
  const tr = await evalIn(ws, `(function(){
    var b = document.getElementById('btnToAttend');
    if (!b || b.style.display === 'none') return 'no-btn';
    b.click();
    return 'clicked';
  })()`);
  await sleep(SETTLE_MS);
  const tv = await evalIn(ws, `JSON.stringify((function(){
    var rows = Array.prototype.slice.call(document.querySelectorAll('#scanTableBody tr'));
    var badges = {};
    rows.forEach(function (tr) {
      var st = tr.querySelector('.badge');
      if (st) badges[st.innerText] = (badges[st.innerText] || 0) + 1;
    });
    return {
      phase: window.CURRENT_TASK ? window.CURRENT_TASK.phase : null,
      cScanned: document.getElementById('cScanned').innerText,
      cAbsent: document.getElementById('cAbsent').innerText,
      scannedLbl: (document.getElementById('cScanned').parentElement.querySelector('.lbl') || {}).innerText,
      absentLbl: (document.getElementById('cAbsent').parentElement.querySelector('.lbl') || {}).innerText,
      badges: badges,
      btnToAttend: (document.getElementById('btnToAttend') || {}).style ? document.getElementById('btnToAttend').style.display : null,
    };
  })())`);
  const TV = tv.err ? null : JSON.parse(tv.value);
  check('Transition → phase attend: counter Đã điểm danh/Chưa điểm danh + badge cập nhật ngay',
    !!(TV && TV.phase === 'attend'
      && TV.scannedLbl.toUpperCase() === 'ĐÃ ĐIỂM DANH' && TV.absentLbl.toUpperCase() === 'CHƯA ĐIỂM DANH'
      && TV.cScanned === '3' && TV.cAbsent === '3'
      && TV.badges['Chưa điểm danh'] === 3
      && TV.badges['Có mặt'] === 2
      && TV.badges['Dư'] === 2
      && TV.btnToAttend === 'none'),
    TV ? 'phase=' + TV.phase + ' S:' + TV.cScanned + ' A:' + TV.cAbsent + ' lbl=' + TV.scannedLbl + '/' + TV.absentLbl + ' badges=' + JSON.stringify(TV.badges) : tv.err);

  // 8. F-search (searchLogsByStaffApi mock) — kết quả render vào #taskListTable (viewTasks),
  // KHÔNG còn #globalSearchResults (element cũ đã xóa khi F-search chuyển sang taskListTable).
  const fs = await evalIn(ws, `JSON.stringify((function(){
    var input = document.getElementById('listSearch');
    if (!input) return { noInput: true };
    input.value = 'Ops237511';
    if (typeof runListSearch === 'function') runListSearch();
    return { ran: true };
  })())`);
  await sleep(SETTLE_MS * 2);
  const fsv = await evalIn(ws, `JSON.stringify((function(){
    var tbl = document.getElementById('taskListTable');
    var body = document.getElementById('taskListBody');
    var empty = document.getElementById('taskEmpty');
    return {
      tableVisible: !!(tbl && tbl.style.display !== 'none'),
      rows: body ? body.querySelectorAll('tr').length : 0,
      emptyVisible: !!(empty && empty.style.display !== 'none'),
      text: body ? body.innerText.slice(0, 80) : '',
    };
  })())`);
  const F = fsv.err ? null : JSON.parse(fsv.value);
  check('F-search Ops237511 → có kết quả (taskListTable)',
    !!(F && F.tableVisible && F.rows > 0 && !F.emptyVisible),
    F ? 'rows=' + F.rows + ' text=' + F.text : fsv.err);

  // Tổng kết
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log('\n===== SUMMARY =====');
  console.log(`PASS: ${passed} / ${results.length}  FAIL: ${failed}`);
  ws.close();
  await httpGet('/json/close/' + target.id).catch(() => {});
  if (chromeProc) { chromeProc.kill(); chromeProc = null; }  // dọn Chrome headless do ta boot
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
