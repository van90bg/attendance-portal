#!/usr/bin/env node
/**
 * probe-behavior-config.js (temp) — Verify hành vi nút viewConfig (B1..B6) bằng CDP thật.
 * Boot Chrome headless + index.local.html (mock GAS) → click DOM → đo state/toast/DOM.
 */
'use strict';
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

let chromeProc = null;
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
async function ensureCdp() {
  try { await httpGet('/json/version'); return; } catch (e) {}
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollcall-behave-'));
  const exe = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  console.log('Boot Chrome headless (CDP port ' + CDP_PORT + ')...');
  chromeProc = spawn(exe, [
    '--headless=new', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + userDataDir,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    try { await httpGet('/json/version'); return; } catch (e) {}
  }
  throw new Error('Không mở được CDP');
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

let passed = 0, failed = 0;
function check(name, ok, detail) {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (ok) passed++; else failed++;
}

async function main() {
  await ensureCdp();
  const tabs = await httpGet('/json/list');
  const tab = tabs.find((t) => t.type === 'page');
  const ws = await connect(tab.webSocketDebuggerUrl);
  setupListener(ws);
  await send(ws, 'Page.enable');
  await send(ws, 'Runtime.enable');
  await send(ws, 'Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send(ws, 'Page.navigate', { url: INDEX_FILE });
  await sleep(2500);
  await evalIn(ws, `selectPage('config')`);
  await sleep(900);

  // Trạng thái ban đầu: sau load
  let r = await evalIn(ws, `(() => {
    var b = document.getElementById('cfgSaveBtn');
    var ref = document.getElementById('cfgRefreshBtn');
    return { saveDisabled: b.disabled, saveShown: b.style.display !== 'none', refreshLabel: ref.textContent, dirty: CFG_DIRTY };
  })()`);
  const s0 = r.value;
  check('B3: Lưu disabled khi sạch', s0.saveDisabled === true, 'disabled=' + s0.saveDisabled);
  check('B6: nhãn Làm mới khi sạch', s0.refreshLabel.indexOf('Làm mới') !== -1, JSON.stringify(s0.refreshLabel));

  // Đổi default (toggle ◉ item 0 stations) → dirty
  await evalIn(ws, `toggleCfgDefault('stations', 'HN2 SOC')`);
  r = await evalIn(ws, `(() => {
    var b = document.getElementById('cfgSaveBtn');
    var ref = document.getElementById('cfgRefreshBtn');
    return { saveDisabled: b.disabled, dirty: CFG_DIRTY, refreshLabel: ref.textContent, refreshDirty: ref.classList.contains('cfg-refresh-dirty') };
  })()`);
  const s1 = r.value;
  check('B3: Lưu enabled khi dirty', s1.saveDisabled === false && s1.dirty === true, 'disabled=' + s1.saveDisabled);
  check('B6: nhãn Hủy thay đổi khi dirty', s1.refreshLabel.indexOf('Hủy thay đổi') !== -1 && s1.refreshDirty, JSON.stringify(s1.refreshLabel));

  // B4: Xoá item đang là mặc định → confirm nhắc Mặc định
  await evalIn(ws, `deleteCfgGroupItem('stations', 0)`);
  await sleep(200);
  r = await evalIn(ws, `(() => {
    var t = document.getElementById('confirmModalTitle');
    var m = document.getElementById('confirmModalMsg');
    return { title: t ? t.textContent : null, msg: m ? m.textContent : null, open: document.getElementById('confirmModal').classList.contains('open') };
  })()`);
  const s2 = r.value;
  check('B4: confirm xoá mặc định nhắc Mặc định', s2.open && s2.msg.indexOf('Mặc định') !== -1, JSON.stringify(s2.msg));
  await evalIn(ws, `closeConfirmModal()`);
  await sleep(150);

  // B1: Sửa item 0 → gõ value → bấm Sửa item 1 → item 0 phải commit (không mất)
  await evalIn(ws, `editCfgGroupItem('stations', 0)`);
  r = await evalIn(ws, `(() => {
    var inp = document.getElementById('cfgGroupEditInput');
    inp.value = 'SGN SOC EDITED';
    return true;
  })()`);
  await evalIn(ws, `editCfgGroupItem('stations', 1)`);
  await sleep(100);
  r = await evalIn(ws, `(() => {
    var list = CFG_STATE.stations;
    return { idx0: list[0], idx1: list[1], dirty: CFG_DIRTY, editOpen: !!document.getElementById('cfgGroupEditInput') };
  })()`);
  const s3 = r.value;
  check('B1: flush edit dở khi Sửa item khác', s3.idx0 === 'SGN SOC EDITED' && s3.editOpen, JSON.stringify(s3));

  // B1: bấm Sửa role khi group đang edit → flush group (input đang mở là idx1)
  await evalIn(ws, `document.getElementById('cfgGroupEditInput').value = 'ROLE-FLUSH-OK'`);
  await evalIn(ws, `addRoleRow()`);
  await sleep(100);
  r = await evalIn(ws, `(() => {
    var list = CFG_STATE.stations;
    return { idx1: list[1], roleEdit: ROLE_EDIT && ROLE_EDIT.isNew, groupInputGone: !document.getElementById('cfgGroupEditInput') };
  })()`);
  const s4 = r.value;
  check('B1: Sửa role flush group đang edit', s4.idx1 === 'ROLE-FLUSH-OK' && s4.roleEdit && s4.groupInputGone, JSON.stringify(s4));
  await evalIn(ws, `cancelRoleEdit()`);
  await sleep(100);

  // B5: commit role → toast lần đầu
  await evalIn(ws, `CFG_DIRTY = false; syncCfgSaveBtn_();`);
  await evalIn(ws, `addRoleRow()`);
  await evalIn(ws, `(() => {
    var em = document.querySelector('.cfg-role-editing .cfg-role-email');
    em.value = 'new@spx.vn';
    return true;
  })()`);
  await evalIn(ws, `commitRoleEdit()`);
  await sleep(150);
  r = await evalIn(ws, `(() => {
    var t = document.querySelector('#toast .toast-text');
    return { toast: t ? t.textContent : null, dirty: CFG_DIRTY };
  })()`);
  const s5 = r.value;
  check('B5: toast Đã chốt sau commit lần đầu', (s5.toast || '').indexOf('Đã chốt') !== -1, JSON.stringify(s5));

  // B2: saveConfig flush — mở edit group, gõ dở, bấm Lưu (mock lưu thành công)
  await evalIn(ws, `editCfgGroupItem('teams', 0)`);
  await evalIn(ws, `document.getElementById('cfgGroupEditInput').value = 'INBOUND-2'`);
  await evalIn(ws, `saveConfig(document.getElementById('cfgSaveBtn'))`);
  await sleep(600);
  r = await evalIn(ws, `(() => ({
    dirty: CFG_DIRTY,
    saveDisabled: document.getElementById('cfgSaveBtn').disabled,
    teams0: CFG_STATE.teams[0],
    patchOk: CFG_SNAPSHOT && CFG_SNAPSHOT.teams[0],
    editGone: !document.getElementById('cfgGroupEditInput'),
  }))()`);
  const s6 = r.value;
  check('B2: save flush edit dở + sạch dirty sau lưu', s6.dirty === false && s6.saveDisabled === true && s6.teams0 === 'INBOUND-2' && s6.editGone, JSON.stringify(s6));

  console.log('\n===== ' + passed + ' PASS / ' + failed + ' FAIL =====');
  if (chromeProc) chromeProc.kill();
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); if (chromeProc) chromeProc.kill(); process.exit(2); });
