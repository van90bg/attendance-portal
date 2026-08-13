#!/usr/bin/env node
/** probe-edit-overflow.js — đo overflow NGANG khi viewConfig ở trạng thái EDIT (role edit + group edit). */
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
const VIEWPORTS = [
  { w: 390, h: 844, label: 'mobile390', mobile: true },
  { w: 375, h: 667, label: 'mobile375', mobile: true },
  { w: 320, h: 640, label: 'mobile320', mobile: true },
];

let chromeProc = null;
async function ensureCdp() {
  try { await httpGet('/json/version'); return; } catch (e) { /* chưa mở */ }
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollcall-probe-edit-'));
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

const SCAN = `(() => {
  var sec = document.getElementById('viewConfig');
  var out = { overflow: [] };
  sec.querySelectorAll('*').forEach(function (el) {
    var cw = el.clientWidth, sw = el.scrollWidth;
    if (sw > cw + 1) {
      out.overflow.push({
        cls: (el.className || '').toString().slice(0, 70),
        id: el.id || '', cw: cw, sw: sw,
      });
    }
  });
  return out;
})()`;

async function main() {
  await ensureCdp();
  const tabs = await httpGet('/json/list');
  const tab = tabs.find((t) => t.type === 'page');
  const ws = await connect(tab.webSocketDebuggerUrl);
  setupListener(ws);
  await send(ws, 'Page.enable');
  await send(ws, 'Runtime.enable');

  for (const vp of VIEWPORTS) {
    await send(ws, 'Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: vp.mobile ? 2 : 1, mobile: !!vp.mobile });
    await send(ws, 'Page.navigate', { url: INDEX_FILE });
    await sleep(2200);
    await evalIn(ws, `selectPage('config')`);
    await sleep(700);

    // Trạng thái EDIT role
    await evalIn(ws, `if (typeof startRoleEdit === 'function') startRoleEdit(Object.keys(CFG_STATE.roleMap || {})[0] || '');`);
    await sleep(350);
    let m = await evalIn(ws, SCAN);
    console.log('\n===== ' + vp.label + ' [role EDIT] =====');
    if (!m.value.overflow.length) console.log('  OK — không tràn');
    else m.value.overflow.forEach((o) => console.log('  OVERFLOW .' + o.cls + ' cw=' + o.cw + ' sw=' + o.sw));

    // Trạng thái EDIT group item đầu tiên
    await evalIn(ws, `if (typeof editCfgGroupItem === 'function') editCfgGroupItem('stations', 0);`);
    await sleep(350);
    m = await evalIn(ws, SCAN);
    console.log('===== ' + vp.label + ' [group EDIT] =====');
    if (!m.value.overflow.length) console.log('  OK — không tràn');
    else m.value.overflow.forEach((o) => console.log('  OVERFLOW .' + o.cls + ' cw=' + o.cw + ' sw=' + o.sw));
  }

  if (chromeProc) chromeProc.kill();
}
main().catch((e) => { console.error('FATAL', e); if (chromeProc) chromeProc.kill(); process.exit(2); });