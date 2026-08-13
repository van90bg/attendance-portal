#!/usr/bin/env node
/**
 * scripts/probe-config-overflow.js — Đo overflow NGANG thật trong viewConfig (CDP).
 * Reuse audit-ui.js infra (boot Chrome headless 9222 + build-local).
 * In từng phần tử có scrollWidth > clientWidth (tràn) + bảng tổng hợp.
 * Cách dùng: node scripts/probe-config-overflow.js
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

const VIEWPORTS = [
  { w: 1384, h: 900, label: 'desktop1384', mobile: false },
  { w: 1920, h: 1080, label: 'wide1920', mobile: false },
  { w: 2560, h: 1440, label: 'ultrawide2560', mobile: false },
  { w: 1024, h: 768, label: 'tablet1024', mobile: false },
  { w: 390, h: 844, label: 'mobile390', mobile: true },
  { w: 375, h: 667, label: 'mobile375', mobile: true },
  { w: 320, h: 640, label: 'mobile320', mobile: true },
];

let chromeProc = null;
async function ensureCdp() {
  try { await httpGet('/json/version'); return; } catch (e) { /* chưa mở */ }
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollcall-probe-'));
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

// Quét mọi phần tử viewConfig: báo phần tử có scrollWidth > clientWidth (overflow ngang)
// + clientWidth của container để biết bối cảnh (card/configWrap/body)
const SCAN = `(() => {
  var sec = document.getElementById('viewConfig');
  if (!sec) return { err: 'no viewConfig' };
  var out = { overflow: [], ctx: { cols: {} } };
  var g = document.querySelector('#cfgList .cfg-groups');
  if (g) out.ctx.cols.cfgGroups = getComputedStyle(g).gridTemplateColumns.split(' ').length;
  var rl = document.getElementById('cfgRoleRows');
  if (rl) out.ctx.cols.cfgRoleList = getComputedStyle(rl).gridTemplateColumns.split(' ').length;
  function ctx(sel, el) {
    var r = el.getBoundingClientRect();
    out.ctx[sel] = { cw: Math.round(el.clientWidth), sw: Math.round(el.scrollWidth), w: Math.round(r.width), scrollX: el.scrollLeft > 0 };
  }
  ctx('body', document.body);
  ctx('configWrap', document.getElementById('configWrap'));
  ctx('configForm', document.getElementById('configForm'));
  ctx('roleWrap', document.getElementById('roleWrap'));
  ctx('cfgList', document.getElementById('cfgList'));
  ctx('cfgRoleRows', document.getElementById('cfgRoleRows'));
  sec.querySelectorAll('*').forEach(function (el) {
    if (!el.classList || !el.classList.length) return;
    var cw = el.clientWidth, sw = el.scrollWidth;
    if (sw > cw + 1) {
      var groups = document.querySelector('#cfgList .cfg-groups');
  if (groups) out.ctx.cols.cfgGroups = getComputedStyle(groups).gridTemplateColumns.split(' ').length;
  var roleList = document.getElementById('cfgRoleRows');
  if (roleList) out.ctx.cols.cfgRoleList = getComputedStyle(roleList).gridTemplateColumns.split(' ').length;
  out.overflow.push({
        cls: (el.className || '').toString().slice(0, 60),
        id: el.id || '',
        cw: cw, sw: sw, diff: sw - cw,
        w: Math.round(el.getBoundingClientRect().width),
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
    const m = await evalIn(ws, SCAN);
    const v = m.value || {};
    console.log('\n===== ' + vp.label + ' ' + vp.w + 'x' + vp.h + ' =====');
    if (v.err) { console.log('  ERR', v.err); continue; }
    console.log('  cols cfgGroups=' + (v.ctx.cols && v.ctx.cols.cfgGroups) + ' cfgRoleList=' + (v.ctx.cols && v.ctx.cols.cfgRoleList));
  console.log('  body cw=' + v.ctx.body.cw + ' | configWrap cw=' + v.ctx.configWrap.cw + ' sw=' + v.ctx.configWrap.sw
      + ' | configForm cw=' + v.ctx.configForm.cw + ' sw=' + v.ctx.configForm.sw
      + ' | roleWrap cw=' + v.ctx.roleWrap.cw + ' sw=' + v.ctx.roleWrap.sw);
    if (!v.overflow.length) {
      console.log('  OK — không có phần tử tràn ngang');
    } else {
      v.overflow.forEach((o) => console.log('  OVERFLOW ' + (o.id ? '#' + o.id : '.' + o.cls) + ' cw=' + o.cw + ' sw=' + o.sw + ' diff=' + o.diff));
    }
  }

  if (chromeProc) chromeProc.kill();
}
main().catch((e) => { console.error('FATAL', e); if (chromeProc) chromeProc.kill(); process.exit(2); });