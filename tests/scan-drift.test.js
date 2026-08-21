/**
 * tests/scan-drift.test.js — Đối chiếu client optimistic decision ↔ server classifyScan
 * Dùng chung fixture để phát hiện drift sớm khi 1 bên sửa state machine.
 * Load clientScanDecision từ app-scan.html, server classifyScan từ ScanLogic.gs.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert');

// Load server
const ScanLogic = require('../ScanLogic.gs');

// Hằng số giống CFG ở scan-classify.test.js
const CFG = {
  STATUS: { PRESENT: 'Có mặt', ABSENT: 'Vắng', EXTRA: 'Dư', PENDING: '-' },
  TASK_STATUS: { OPEN: 'open', ATTEND: 'attend', DONE: 'done' },
};

// Load client — extract từ app-scan.html (đã build-local)
const { build } = require('../scripts/build-local.js');
build();
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.local.html'), 'utf8');

// Extract inline scripts
function extractInlineScript(src) {
  const m = src.match(/<script[^>]*>([\s\S]*?)<\/script>/g) || [];
  let body = '';
  m.forEach(function (tag) {
    const inner = tag.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
    body += inner + '\n';
  });
  return body;
}

function matchingBrace(src, openIdx) {
  let depth = 0;
  let inStr = null;
  let inTpl = false;
  let inRegex = false;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    const prev = i > 0 ? src[i - 1] : '';
    if (inRegex) {
      if (ch === '\\') { i++; continue; }
      if (ch === '/') inRegex = false;
      continue;
    }
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === inStr) { inStr = null; if (inTpl) inTpl = false; }
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch; continue; }
    if (ch === '`') { inStr = '`'; inTpl = true; continue; }
    if (ch === '/' && !/[A-Za-z0-9_$)\]'"`]/.test(prev)) { inRegex = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function extractFunction(name) {
  const body = extractInlineScript(indexHtml);
  const fIdx = body.indexOf('function ' + name + '(');
  if (fIdx < 0) throw new Error('Không tìm thấy function ' + name);
  const fnEnd = matchingBrace(body, body.indexOf('{', fIdx));
  return new Function('return (' + body.slice(fIdx, fnEnd + 1) + ');')();
}

// Hằng số client (giống app-core.html)
var STATUS_C = { PENDING: '-', PRESENT: 'Có mặt', ABSENT: 'Vắng', EXTRA: 'Dư' };
var TASK_STATUS_C = { OPEN: 'open', ATTEND: 'attend', DONE: 'done' };

// Load clientScanDecision + findLogRowByStaff
var clientScanDecision;
var findLogRowByStaff;
try {
  clientScanDecision = extractFunction('clientScanDecision');
  // Tạo global tạm cho clientScanDecision tham chiếu
  global.STATUS_C = STATUS_C;
  global.TASK_STATUS_C = TASK_STATUS_C;
  // findLogRowByStaff không cần global
} catch (e) {
  console.error('Extract fail:', e.message);
  process.exit(1);
}

// Shared fixture: 1 row log giống makeRow() trong scan-classify.test.js
function makeRow(overrides) {
  return Object.assign({
    taskId: 'R20260802-0730',
    staffId: 'OPS000001',
    staffName: 'NhanVien Mau 001',
    slotCode: '08:00-17:00',
    station: 'HN2 SOC',
    team: 'Outbound',
    workstation: 'OBLoading',
    cardIn: '7:57:01',
    cardOut: '',
    listedAt: new Date('2026-08-02T07:30:00'),
    scannedAt: null,
    scannedAtEpoch: 0,
    status: CFG.STATUS.ABSENT,
  }, overrides || {});
}

// Scenario: (phase, logRows, staffId, expected) — client và server phải đồng thuận
// expected: { action, status, field } hoặc { action: 'reject', reason }

test('scanDrift: phase1 (open) — NV trong log chưa LISTED_AT → update listedAt/PENDING', function () {
  const rows = [makeRow({ listedAt: null, listedAtEpoch: 0, status: CFG.STATUS.PENDING })];
  const sid = 'OPS000001';
  const client = clientScanDecision(TASK_STATUS_C.OPEN, rows, sid);
  const server = ScanLogic.classifyScan(CFG, { taskId: 'R1', status: CFG.TASK_STATUS.OPEN }, rows, sid);
  assert.equal(client.action, server.action, 'action');
  assert.equal(client.field, server.field, 'field');
  assert.equal(client.status, server.status, 'status');
});

test('scanDrift: phase1 (open) — NV đã LISTED_AT → reject already-present', function () {
  const rows = [makeRow({ listedAt: new Date('2026-08-02T07:30:00'), listedAtEpoch: 1700000000000, status: CFG.STATUS.PENDING })];
  const sid = 'OPS000001';
  const client = clientScanDecision(TASK_STATUS_C.OPEN, rows, sid);
  const server = ScanLogic.classifyScan(CFG, { taskId: 'R1', status: CFG.TASK_STATUS.OPEN }, rows, sid);
  assert.equal(client.action, 'reject');
  assert.equal(server.action, 'reject');
  assert.equal(client.reason, server.reason, 'reason');
});

test('scanDrift: phase1 (open) — NV không trong log → append PENDING', function () {
  const rows = [makeRow()]; // OPS000001
  const sid = 'OPS000099';
  const client = clientScanDecision(TASK_STATUS_C.OPEN, rows, sid);
  const server = ScanLogic.classifyScan(CFG, { taskId: 'R1', status: CFG.TASK_STATUS.OPEN }, rows, sid);
  assert.equal(client.action, server.action, 'action');
  assert.equal(client.field, server.field, 'field');
  assert.equal(client.status, server.status, 'status');
});

test('scanDrift: phase2 (attend) — NV trong log chưa quét → update scannedAt/PRESENT', function () {
  const rows = [makeRow({ listedAt: new Date('2026-08-02T07:30:00'), listedAtEpoch: 1700000000000, scannedAtEpoch: 0, status: CFG.STATUS.PENDING })];
  const sid = 'OPS000001';
  const client = clientScanDecision(TASK_STATUS_C.ATTEND, rows, sid);
  const server = ScanLogic.classifyScan(CFG, { taskId: 'R1', status: CFG.TASK_STATUS.ATTEND }, rows, sid);
  assert.equal(client.action, server.action, 'action');
  assert.equal(client.field, server.field, 'field');
  assert.equal(client.status, server.status, 'status');
});

test('scanDrift: phase2 (attend) — NV đã scanned → reject already-scanned', function () {
  const rows = [makeRow({ scannedAt: new Date('2026-08-02T08:00:00'), scannedAtEpoch: 1700000000000, status: CFG.STATUS.PRESENT })];
  const sid = 'OPS000001';
  const client = clientScanDecision(TASK_STATUS_C.ATTEND, rows, sid);
  const server = ScanLogic.classifyScan(CFG, { taskId: 'R1', status: CFG.TASK_STATUS.ATTEND }, rows, sid);
  assert.equal(client.action, 'reject');
  assert.equal(server.action, 'reject');
  assert.equal(client.reason, server.reason, 'reason');
});

test('scanDrift: phase2 (attend) — NV không trong log → append EXTRA', function () {
  const rows = [makeRow()]; // OPS000001
  const sid = 'OPS000099';
  const client = clientScanDecision(TASK_STATUS_C.ATTEND, rows, sid);
  const server = ScanLogic.classifyScan(CFG, { taskId: 'R1', status: CFG.TASK_STATUS.ATTEND }, rows, sid);
  assert.equal(client.action, server.action, 'action');
  assert.equal(client.field, server.field, 'field');
  assert.equal(client.status, server.status, 'status');
});

test('scanDrift: phase2 (attend) — NV EXTRA quét lại → giữ EXTRA (không PRESENT)', function () {
  const rows = [makeRow({ scannedAt: new Date('2026-08-02T08:00:00'), scannedAtEpoch: 1700000000000, status: CFG.STATUS.EXTRA })];
  const sid = 'OPS000001';
  const client = clientScanDecision(TASK_STATUS_C.ATTEND, rows, sid);
  const server = ScanLogic.classifyScan(CFG, { taskId: 'R1', status: CFG.TASK_STATUS.ATTEND }, rows, sid);
  assert.equal(client.action, server.action, 'action');
  assert.equal(client.field, server.field, 'field');
  assert.equal(client.status, server.status, 'status — EXTRA quét lại giữ EXTRA');
});

test('scanDrift: phase1 (open) — NV không trong log rỗng → append PENDING', function () {
  const rows = [];
  const sid = 'OPS000099';
  const client = clientScanDecision(TASK_STATUS_C.OPEN, rows, sid);
  const server = ScanLogic.classifyScan(CFG, { taskId: 'R1', status: CFG.TASK_STATUS.OPEN }, rows, sid);
  assert.equal(client.action, server.action, 'action');
  assert.equal(client.field, server.field, 'field');
  assert.equal(client.status, server.status, 'status');
});

test('scanDrift: phase2 (attend) — NV không trong log rỗng → append EXTRA', function () {
  const rows = [];
  const sid = 'OPS000099';
  const client = clientScanDecision(TASK_STATUS_C.ATTEND, rows, sid);
  const server = ScanLogic.classifyScan(CFG, { taskId: 'R1', status: CFG.TASK_STATUS.ATTEND }, rows, sid);
  assert.equal(client.action, server.action, 'action');
  assert.equal(client.field, server.field, 'field');
  assert.equal(client.status, server.status, 'status');
});

test('scanDrift: case-insensitive staffId khớp', function () {
  const rows = [makeRow({ listedAtEpoch: 0, scannedAtEpoch: 0, status: CFG.STATUS.PENDING })];
  // client dùng toUpperCase, server dùng trim+toUpperCase
  const client = clientScanDecision(TASK_STATUS_C.OPEN, rows, 'ops000001');
  const server = ScanLogic.classifyScan(CFG, { taskId: 'R1', status: CFG.TASK_STATUS.OPEN }, rows, 'ops000001');
  assert.equal(client.action, server.action, 'action');
  assert.equal(client.field, server.field, 'field');
  assert.equal(client.status, server.status, 'status');
});