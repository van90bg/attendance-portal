/* Verify fix: roster modal "Theo ca" — station chips cho task station rỗng (A2/legacy).
 * Flow A: tạo task (chọn Station) → mở scan → Nạp danh sách → preview tự > 0 → chọn Ca → submit.
 * Flow B (fix): task station RỖNG → modal hiện chips Station → chọn HN2 SOC → preview > 0 → submit.
 * Chạy: CHROME_PATH=... node scripts/verify-roster-station.js
 */
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const { build } = require('./build-local.js');

build();

const CDP_PORT = 9223;
const CDP_HTTP = 'http://127.0.0.1:' + CDP_PORT;
const INDEX_FILE = 'file:///' + path.resolve(__dirname, '..', 'index.local.html').replace(/\\/g, '/');
const SETTLE_MS = 600;

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
  try { await httpGet('/json/version'); return; } catch (e) { /* boot */ }
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollcall-roster-'));
  const exe = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  console.log('Boot Chrome headless (CDP port ' + CDP_PORT + ')...');
  chromeProc = spawn(exe, ['--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + userDataDir, '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'],
    { stdio: 'ignore' });
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    try { await httpGet('/json/version'); return; } catch (e) { /* retry */ }
  }
  throw new Error('Không mở được CDP port sau 10s');
}
let msgId = 0;
const pending = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const results = [];
function check(name, cond, detail) {
  results.push({ pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function main() {
  await ensureCdp();
  const target = await httpGet('/json/new?' + encodeURIComponent(INDEX_FILE), 'PUT');
  console.log('Opened tab:', target.id);
  await sleep(2600);
  const ws = await connect(target.webSocketDebuggerUrl);
  setupListener(ws);
  await send(ws, 'Runtime.enable');

  const boot = await evalIn(ws, `JSON.stringify({
    hasMock: !!(window.google && window.google.script && window.google.script.run),
    metaLoaded: !!(window.META && window.META.appTitle),
  })`);
  const B = boot.err ? null : JSON.parse(boot.value);
  check('App load + mock', !!(B && B.hasMock && B.metaLoaded), boot.err || '');

  /* ===== Flow A: tạo task (chọn Station) → roster tự prefill ===== */
  await evalIn(ws, `document.getElementById('btnCreate').click()`);
  await sleep(300);
  await evalIn(ws, `(function(){
    var chips = document.querySelectorAll('#createChipsStation .pick');
    var target = null;
    Array.prototype.forEach.call(chips, function (c) { if (c.getAttribute('data-val') === 'HN2 SOC') target = c; });
    if (target) target.click();
    return !!target;
  })()`);
  await sleep(300);
  const subState = await evalIn(ws, `JSON.stringify({ disabled: document.getElementById('btnCreateSubmit').disabled })`);
  const SS = subState.err ? null : JSON.parse(subState.value);
  check('Create modal: chọn Station → nút Tạo enabled', !!(SS && SS.disabled === false), JSON.stringify(SS));
  await evalIn(ws, `document.getElementById('btnCreateSubmit').click()`);
  await sleep(SETTLE_MS);
  const newId = await evalIn(ws, `(function(){ var t = document.getElementById('toast'); var m = t && t.innerText.match(/R\\d{8}-\\d+/); return m ? m[0] : null; })()`);
  check('Tạo task mới thành công (mock unshift)', !!newId.value, newId.value || newId.err);

  await evalIn(ws, `openScan(${JSON.stringify(newId.value)})`);
  await sleep(SETTLE_MS);
  const vA = await evalIn(ws, `JSON.stringify({
    station: CURRENT_TASK ? (CURRENT_TASK.station || '') : null,
    loadBtn: (function(){ var b = document.getElementById('btnLoadList'); return b ? (b.style.display !== 'none') : false; })(),
  })`);
  const VA = vA.err ? null : JSON.parse(vA.value);
  check('Flow A: task có station HN2 SOC', !!(VA && VA.station === 'HN2 SOC'), JSON.stringify(VA));

  await evalIn(ws, `document.getElementById('btnLoadList').click()`);
  await sleep(SETTLE_MS + 400);
  const mA = await evalIn(ws, `JSON.stringify({
    num: document.getElementById('rosterTotalNum').textContent,
    subDisabled: document.getElementById('btnRosterSubmit').disabled,
    stChips: document.querySelectorAll('#rosterChipsStation .pick').length,
  })`);
  const MA = mA.err ? null : JSON.parse(mA.value);
  check('Flow A: station prefill từ task → preview tự > 0', !!(MA && Number(MA.num) > 0 && MA.subDisabled === false && MA.stChips >= 1), JSON.stringify(MA));

  await evalIn(ws, `(function(){
    var chips = document.querySelectorAll('#rosterChipsSlot .pick');
    var target = null;
    Array.prototype.forEach.call(chips, function (c) { if (c.getAttribute('data-val') === '08:00-17:00') target = c; });
    if (target) target.click();
    return !!target;
  })()`);
  await sleep(SETTLE_MS + 400);
  const mA2 = await evalIn(ws, `JSON.stringify({
    num: document.getElementById('rosterTotalNum').textContent,
    subDisabled: document.getElementById('btnRosterSubmit').disabled,
    selSlots: ROSTER_FILTER.slotCode.join('|'),
  })`);
  const MA2 = mA2.err ? null : JSON.parse(mA2.value);
  check('Flow A: chọn Ca chip → preview cập nhật', !!(MA2 && MA2.selSlots === '08:00-17:00' && Number(MA2.num) > 0), JSON.stringify(MA2));

  await evalIn(ws, `document.getElementById('btnRosterSubmit').click()`);
  await sleep(SETTLE_MS);
  const dA = await evalIn(ws, `JSON.stringify({
    toast: document.getElementById('toast').innerText,
    rows: document.querySelectorAll('#scanTableBody tr').length,
    modalClosed: !document.getElementById('loadListModal').classList.contains('open'),
  })`);
  const DA = dA.err ? null : JSON.parse(dA.value);
  check('Flow A: nạp hoàn tất (mock seed log sẵn → thêm 0 hoặc >0, modal đóng)', !!(DA && (/Đã nạp/.test(DA.toast) || /đã có/.test(DA.toast)) && DA.rows >= 6 && DA.modalClosed), JSON.stringify(DA));

  /* ===== Flow B (fix): task station RỖNG → chips Station cho phép chọn ===== */
  // Flow B: mô phỏng task station rỗng — openRosterModal đọc CURRENT_TASK.station lúc mở modal.
  await evalIn(ws, `(function(){ if (CURRENT_TASK) CURRENT_TASK.station = ''; return CURRENT_TASK ? CURRENT_TASK.station : null; })()`);
  await evalIn(ws, `openScan(${JSON.stringify(newId.value)})`);
  await sleep(SETTLE_MS);
  const vB = await evalIn(ws, `JSON.stringify({ station: CURRENT_TASK ? (CURRENT_TASK.station || '') : null })`);
  const VB = vB.err ? null : JSON.parse(vB.value);
  check('Flow B: task station rỗng (A2/legacy)', !!(VB && VB.station === ''), JSON.stringify(VB));

  await evalIn(ws, `document.getElementById('btnLoadList').click()`);
  await sleep(SETTLE_MS + 400);
  const mB = await evalIn(ws, `JSON.stringify({
    num: document.getElementById('rosterTotalNum').textContent,
    subDisabled: document.getElementById('btnRosterSubmit').disabled,
    stChips: document.querySelectorAll('#rosterChipsStation .pick').length,
  })`);
  const MB = mB.err ? null : JSON.parse(mB.value);
  check('Flow B: station rỗng → preview 0 + nút disabled (chưa chọn)', !!(MB && MB.num === '0' && MB.subDisabled === true && MB.stChips >= 1), JSON.stringify(MB));

  await evalIn(ws, `(function(){
    var chips = document.querySelectorAll('#rosterChipsStation .pick');
    var target = null;
    Array.prototype.forEach.call(chips, function (c) { if (c.getAttribute('data-val') === 'HN2 SOC') target = c; });
    if (target) target.click();
    return !!target;
  })()`);
  await sleep(SETTLE_MS + 400);
  const mB2 = await evalIn(ws, `JSON.stringify({
    num: document.getElementById('rosterTotalNum').textContent,
    subDisabled: document.getElementById('btnRosterSubmit').disabled,
    st: ROSTER_FILTER.station,
  })`);
  const MB2 = mB2.err ? null : JSON.parse(mB2.value);
  check('Flow B (FIX): chọn Station chip → preview > 0 + nút enabled', !!(MB2 && MB2.st === 'HN2 SOC' && Number(MB2.num) > 0 && MB2.subDisabled === false), JSON.stringify(MB2));

  await evalIn(ws, `document.getElementById('btnRosterSubmit').click()`);
  await sleep(SETTLE_MS);
  const dB = await evalIn(ws, `JSON.stringify({
    toast: document.getElementById('toast').innerText,
    rows: document.querySelectorAll('#scanTableBody tr').length,
  })`);
  const DB = dB.err ? null : JSON.parse(dB.value);
  check('Flow B (FIX): nạp danh sách thành công', !!(DB && /Đã nạp/.test(DB.toast) && DB.rows >= 1), JSON.stringify(DB));

  const failed = results.filter((r) => !r.pass).length;
  console.log(failed ? 'RESULT: FAIL (' + failed + ')' : 'RESULT: ALL PASS');
  if (chromeProc) chromeProc.kill();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('SCRIPT ERROR', e); if (chromeProc) chromeProc.kill(); process.exit(1); });