/**
 * tests/admin-audit.test.js — Audit log + Admin console (mở rộng phân quyền).
 *
 * Cover: audit_ ghi row AuditLog đúng cột; getAuditLogApi gate (operator/manager chặn /
 * admin nhận rows, mới nhất trước); scanStaff + completeTask ghi audit vào sheet.
 *
 * Mock GAS + loader dùng chung: tests/gas-sandbox.js (loadAll: toàn bộ .gs).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeSandbox, loadAll } = require('./gas-sandbox');
const fs = require('node:fs');
const path = require('node:path');

// Config.gs consts (STATUS/UI_LABELS) la lexical binding trong vm - khong phai property
// cua sandbox object -> doc truc tiep Config.gs de lay gia tri so sanh.
const CFG_SRC = fs.readFileSync(path.join(__dirname, '..', 'Config.gs'), 'utf8');
function cfgVal(key) {
  const m = CFG_SRC.match(new RegExp('(?:STATUS|UI_LABELS)\\s*=\\s*\\{[\\s\\S]*?\\b' + key + ":\\s*'([^']*)'"));
  return m ? m[1] : null;
}
const ST = { PRESENT: cfgVal('PRESENT'), ABSENT: cfgVal('ABSENT'), EXTRA: cfgVal('EXTRA'), PENDING: cfgVal('PENDING') };
const UI_SCAN_OWNER = cfgVal('SCAN_OPEN_OWNER_ONLY');

test('audit_: ghi row AuditLog đúng cột (timestamp/email/action/targetId/detail)', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'manager@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  svc.audit_('completeTask', 'R2026', { absentCount: 2 });
  const rows = ss.sheets.AuditLog.data;
  assert.equal(rows.length, 2); // header + 1 row
  assert.ok(rows[1][0], 'timestamp');            // ISO
  assert.equal(rows[1][1], 'manager@spx.com');   // email
  assert.equal(rows[1][2], 'completeTask');      // action
  assert.equal(rows[1][3], 'R2026');             // targetId
  assert.ok(rows[1][4].includes('absentCount')); // detail JSON
});

test('getAuditLogApi: operator bị chặn (ok:false) — gate admin', () => {
  const { ctx } = makeSandbox({ activeEmail: 'op@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  // op@spx.com chưa cấu hình roleMap → operator mặc định → bị chặn
  const blocked = svc.getAuditLogApi(50);
  assert.equal(blocked.ok, false);
});

test('getAuditLogApi: admin nhận rows, mới nhất trước', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'mgr@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  ss.sheets.Config.appendRow(['roleMap', JSON.stringify({ 'mgr@spx.com': 'admin' })]);
  svc.audit_('completeTask', 'R2026', {});
  svc.audit_('createTask', 'R2027', {});
  const res = svc.getAuditLogApi(50);
  assert.equal(res.ok, true);
  assert.equal(res.rows.length, 2);
  assert.equal(res.rows[0].action, 'createTask'); // mới nhất đứng trước
  assert.equal(res.rows[0].email, 'mgr@spx.com');
});

test('getAuditLogApi: nâng role operator→admin giữa phiên vẫn qua (invalidate cache)', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'op@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  svc.audit_('settings', '', { saved: ['roleMap'] });
  assert.equal(svc.getAuditLogApi(50).ok, false); // operator — cache settings (chưa có roleMap)
  ss.sheets.Config.appendRow(['roleMap', JSON.stringify({ 'op@spx.com': 'admin' })]);
  svc.invalidateSettingsCache_();                 // cache 60s — bỏ để đọc roleMap mới
  const res = svc.getAuditLogApi(50);
  assert.equal(res.ok, true);
  assert.equal(res.rows.length, 1);
});

test('scanStaff KHÔNG ghi audit — bỏ audit tần suất cao (chống phình AuditLog)', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'web@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  // task FREE phase attend — NV lạ → Dư (ok:true)
  ss.sheets.AttendanceTask.appendRow(['R2026', 'HN SOC', 'Tự do', '', '', 'attend', '2026-08-17 08:00', 'web@spx.com', '']);
  const res = svc.scanStaff('R2026', 'Ops6219');
  assert.equal(res.ok, true);
  // AuditLog chỉ còn header — scan không thêm dòng (mutation quản trị vẫn audit)
  const rows = ss.sheets.AuditLog.data;
  assert.equal(rows.length, 1);
});

test('completeTask ghi audit (action=completeTask)', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'owner@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  ss.sheets.AttendanceTask.appendRow(['R2026', 'HN SOC', '08:00-17:00', 'Inbound', 'Full', 'attend', '2026-08-17 08:00', 'owner@spx.com', '']);
  const res = svc.completeTask('R2026');
  assert.equal(res.ok, true);
  const rows = ss.sheets.AuditLog.data;
  assert.equal(rows[rows.length - 1][2], 'completeTask');
  assert.equal(rows[rows.length - 1][3], 'R2026');
});

test('completeTask: task with scanned EXTRA rows still closes (regression counter partition)', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'owner@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  ss.sheets.AttendanceTask.appendRow(['R2026', 'HN SOC', '08:00-17:00', 'Inbound', 'Full', 'attend', '2026-08-17 08:00', 'owner@spx.com', '']);
  const t = new Date('2026-08-17T08:00:00+07:00');
  // 1 PRESENT scanned, 1 PENDING (will be ABSENT), 1 EXTRA scanned in phase 2.
  // Old bug: scanned+absent+extra double-counted the scanned EXTRA row -> task never closed.
  ss.sheets.AttendanceLog.appendRow(['R2026', 'Ops6219', 'NV A', '08:00-17:00', 'HN SOC', 'Inbound', 'WS1', t, t, ST.PRESENT, '2026-08-17']);
  ss.sheets.AttendanceLog.appendRow(['R2026', 'Ops6220', 'NV B', '08:00-17:00', 'HN SOC', 'Inbound', 'WS1', t, '', ST.PENDING, '2026-08-17']);
  ss.sheets.AttendanceLog.appendRow(['R2026', 'Ops6221', 'NV C', '', '', '', '', '', t, ST.EXTRA, '']);
  const res = svc.completeTask('R2026');
  assert.equal(res.ok, true);
  assert.equal(svc.readTask_('R2026').status, 'done');
  const byId = {};
  svc.readLogRows_('R2026').forEach((r) => { byId[r.staffId] = r.status; });
  assert.equal(byId['Ops6219'], ST.PRESENT);
  assert.equal(byId['Ops6220'], ST.ABSENT);
  assert.equal(byId['Ops6221'], ST.EXTRA);
});

test('completeTask: non-owner rejected (owner gate)', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'op@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  ss.sheets.AttendanceTask.appendRow(['R2026', 'HN SOC', '08:00-17:00', 'Inbound', 'Full', 'attend', '2026-08-17 08:00', 'owner@spx.com', '']);
  const res = svc.completeTask('R2026');
  assert.equal(res.ok, false);
  assert.equal(res.message, UI_SCAN_OWNER);
});

test('reopenTask: non-owner rejected (owner gate)', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'op@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  ss.sheets.AttendanceTask.appendRow(['R2026', 'HN SOC', '08:00-17:00', 'Inbound', 'Full', 'done', '2026-08-17 08:00', 'owner@spx.com', '2026-08-17 12:00']);
  const res = svc.reopenTask('R2026');
  assert.equal(res.ok, false);
  assert.equal(res.message, UI_SCAN_OWNER);
});

test('completeTask: counter mismatch + admin → force-close ok:true + audit completeTaskForceClose', () => {
  const { ctx, ss } = makeSandbox(); // admin@spx.com = editor (DEPLOYER_EMAIL)
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  ss.sheets.AttendanceTask.appendRow(['R2026', 'HN SOC', '08:00-17:00', 'Inbound', 'Full', 'attend', '2026-08-17 08:00', 'owner@spx.com', '']);
  const t = new Date('2026-08-17T08:00:00+07:00');
  ss.sheets.AttendanceLog.appendRow(['R2026', 'Ops6219', 'NV A', '08:00-17:00', 'HN SOC', 'Inbound', 'WS1', t, t, ST.PRESENT, '2026-08-17']);
  ss.sheets.AttendanceLog.appendRow(['R2026', 'Ops6221', 'NV C', '', '', '', '', '', '', ST.EXTRA, '']); // EXTRA chưa quét → counter lệch
  const res = svc.completeTask('R2026');
  assert.equal(res.ok, true, res.message);
  assert.equal(svc.readTask_('R2026').status, 'done');
  const rows = ss.sheets.AuditLog.data;
  assert.equal(rows[rows.length - 2][2], 'completeTaskForceClose');
  assert.equal(rows[rows.length - 2][3], 'R2026');
  assert.equal(rows[rows.length - 1][2], 'completeTask', 'audit completeTask vẫn được ghi sau');
});

test('completeTask: counter mismatch + non-admin owner → vẫn reject (chỉ admin force-close)', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'owner@spx.com' }); // owner nhưng KHÔNG editor
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  ss.sheets.AttendanceTask.appendRow(['R2026', 'HN SOC', '08:00-17:00', 'Inbound', 'Full', 'attend', '2026-08-17 08:00', 'owner@spx.com', '']);
  const t = new Date('2026-08-17T08:00:00+07:00');
  ss.sheets.AttendanceLog.appendRow(['R2026', 'Ops6219', 'NV A', '08:00-17:00', 'HN SOC', 'Inbound', 'WS1', t, t, ST.PRESENT, '2026-08-17']);
  ss.sheets.AttendanceLog.appendRow(['R2026', 'Ops6221', 'NV C', '', '', '', '', '', '', ST.EXTRA, '']);
  const res = svc.completeTask('R2026');
  assert.equal(res.ok, false);
  assert.match(res.message, /scanned \+ absent/i);
});

test('updateLogRowStatus: owner đổi ABSENT→PRESENT → fill TIME_SCAN + counters + audit', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'owner@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  ss.sheets.AttendanceTask.appendRow(['R2026', 'HN SOC', '08:00-17:00', 'Inbound', 'Full', 'attend', '2026-08-17 08:00', 'owner@spx.com', '']);
  const t = new Date('2026-08-17T08:00:00+07:00');
  ss.sheets.AttendanceLog.appendRow(['R2026', 'Ops6219', 'NV A', '08:00-17:00', 'HN SOC', 'Inbound', 'WS1', t, '', ST.ABSENT, '2026-08-17']);
  const res = svc.updateLogRowStatus('R2026', 'Ops6219', ST.PRESENT);
  assert.equal(res.ok, true, res.message);
  assert.ok(res.counters, 'trả counters để client render');
  const row = svc.findLogRow(svc.readLogRows_('R2026'), 'Ops6219');
  assert.equal(row.status, ST.PRESENT);
  assert.ok(Number(row.scannedAtEpoch) > 0, 'TIME_SCAN được điền (invariant PRESENT)');
  const rows = ss.sheets.AuditLog.data;
  assert.equal(rows[rows.length - 1][2], 'fixLogRowStatus');
  assert.ok(String(rows[rows.length - 1][4]).includes('fillScanTime') && String(rows[rows.length - 1][4]).includes('true'));
});

test('updateLogRowStatus: PRESENT→EXTRA không fill TIME_SCAN (chỉ đổi STATUS)', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'owner@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  ss.sheets.AttendanceTask.appendRow(['R2026', 'HN SOC', '08:00-17:00', 'Inbound', 'Full', 'attend', '2026-08-17 08:00', 'owner@spx.com', '']);
  const t = new Date('2026-08-17T08:00:00+07:00');
  ss.sheets.AttendanceLog.appendRow(['R2026', 'Ops6219', 'NV A', '08:00-17:00', 'HN SOC', 'Inbound', 'WS1', t, t, ST.PRESENT, '2026-08-17']);
  const res = svc.updateLogRowStatus('R2026', 'Ops6219', ST.EXTRA);
  assert.equal(res.ok, true, res.message);
  const row = svc.findLogRow(svc.readLogRows_('R2026'), 'Ops6219');
  assert.equal(row.status, ST.EXTRA);
  const raw = ss.sheets.AttendanceLog.data[1];
  assert.equal(raw[8].getTime(), t.getTime(), 'TIME_SCAN giữ nguyên');
});

test('updateLogRowStatus: PRESENT→ABSENT clear TIME_SCAN → counter scanned giảm, absent tăng (L1)', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'owner@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  ss.sheets.AttendanceTask.appendRow(['R2026', 'HN SOC', '08:00-17:00', 'Inbound', 'Full', 'attend', '2026-08-17 08:00', 'owner@spx.com', '']);
  const t = new Date('2026-08-17T08:00:00+07:00');
  ss.sheets.AttendanceLog.appendRow(['R2026', 'Ops6219', 'NV A', '08:00-17:00', 'HN SOC', 'Inbound', 'WS1', t, t, ST.PRESENT, '2026-08-17']);
  const res = svc.updateLogRowStatus('R2026', 'Ops6219', ST.ABSENT);
  assert.equal(res.ok, true, res.message);
  const row = svc.findLogRow(svc.readLogRows_('R2026'), 'Ops6219');
  assert.equal(row.status, ST.ABSENT);
  const raw = ss.sheets.AttendanceLog.data[1];
  assert.equal(raw[8], '', 'TIME_SCAN bị xoá — dòng Vắng không còn tính Có mặt');
  assert.equal(raw[7].getTime(), t.getTime(), 'LISTED_AT giữ nguyên (NV vẫn đã đến)');
  assert.equal(res.counters.scanned, 0, 'scanned hết dòng đã quét nhầm');
  assert.equal(res.counters.absent, 1, 'absent đếm đúng dòng Vắng');
  const rows = ss.sheets.AuditLog.data;
  assert.ok(String(rows[rows.length - 1][4]).includes('clearScanTime') && String(rows[rows.length - 1][4]).includes('true'));
});

test('updateLogRowStatus: PRESENT→PENDING clear TIME_SCAN + LISTED_AT (reset về chưa đến) (L1)', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'owner@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  ss.sheets.AttendanceTask.appendRow(['R2026', 'HN SOC', '08:00-17:00', 'Inbound', 'Full', 'attend', '2026-08-17 08:00', 'owner@spx.com', '']);
  const t = new Date('2026-08-17T08:00:00+07:00');
  ss.sheets.AttendanceLog.appendRow(['R2026', 'Ops6219', 'NV A', '08:00-17:00', 'HN SOC', 'Inbound', 'WS1', t, t, ST.PRESENT, '2026-08-17']);
  const res = svc.updateLogRowStatus('R2026', 'Ops6219', ST.PENDING);
  assert.equal(res.ok, true, res.message);
  const raw = ss.sheets.AttendanceLog.data[1];
  assert.equal(raw[7], '', 'LISTED_AT bị xoá');
  assert.equal(raw[8], '', 'TIME_SCAN bị xoá');
  assert.equal(res.counters.scanned, 0);
  assert.equal(res.counters.presentAt, 0);
  assert.equal(res.counters.absent, 1);
  assert.ok(String(ss.sheets.AuditLog.data[ss.sheets.AuditLog.data.length - 1][4]).includes('clearListedAt') && String(ss.sheets.AuditLog.data[ss.sheets.AuditLog.data.length - 1][4]).includes('true'));
});

test('updateLogRowStatus: ABSENT→PENDING clear LISTED_AT (không có scan để clear) (#7)', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'owner@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  ss.sheets.AttendanceTask.appendRow(['R2026', 'HN SOC', '08:00-17:00', 'Inbound', 'Full', 'attend', '2026-08-17 08:00', 'owner@spx.com', '']);
  const t = new Date('2026-08-17T08:00:00+07:00');
  ss.sheets.AttendanceLog.appendRow(['R2026', 'Ops6219', 'NV A', '08:00-17:00', 'HN SOC', 'Inbound', 'WS1', t, '', ST.ABSENT, '2026-08-17']);
  const res = svc.updateLogRowStatus('R2026', 'Ops6219', ST.PENDING);
  assert.equal(res.ok, true, res.message);
  const raw = ss.sheets.AttendanceLog.data[1];
  assert.equal(raw[7], '', 'LISTED_AT bị xoá — PENDING = chưa đến');
  assert.equal(raw[8], '', 'TIME_SCAN (rỗng sẵn) không đổi');
  assert.equal(res.counters.absent, 1, 'partition: PENDING chưa quét vẫn tính absent (scanned+absent=total)');
});

test('audit_: action ngoài whitelist KHÔNG ghi (log poisoning chặn) (#9)', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'mgr@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  svc.audit_('completeTask', 'R2026', {});
  svc.audit_('scan', 'R2026', { staffId: 'Ops1' });        // ngoài whitelist — bị bỏ
  svc.audit_('deleteAllRows', 'R2026', {});                // action lạ qua google.script.run
  const rows = ss.sheets.AuditLog.data;
  assert.equal(rows.length, 2, 'chỉ header + 1 row whitelist');
  assert.equal(rows[1][2], 'completeTask');
});

test('updateLogRowStatus: PENDING→EXTRA dòng chưa quét → FILL TIME_SCAN (B-P1-2 — task đóng được)', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'owner@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  ss.sheets.AttendanceTask.appendRow(['R2026', 'HN SOC', '08:00-17:00', 'Inbound', 'Full', 'attend', '2026-08-17 08:00', 'owner@spx.com', '']);
  const t = new Date('2026-08-17T08:00:00+07:00');
  ss.sheets.AttendanceLog.appendRow(['R2026', 'Ops6219', 'NV A', '08:00-17:00', 'HN SOC', 'Inbound', 'WS1', t, '', ST.PENDING, '2026-08-17']);
  const res = svc.updateLogRowStatus('R2026', 'Ops6219', ST.EXTRA);
  assert.equal(res.ok, true, res.message);
  const raw = ss.sheets.AttendanceLog.data[1];
  assert.ok(raw[8] && raw[8].getTime() > 0, 'EXTRA trên dòng chưa quét được FILL TIME_SCAN — giữ partition invariant');
  assert.equal(res.counters.scanned + res.counters.absent, res.counters.total, 'partition invariant — task đóng được không cần force-close');
  const close = svc.completeTask('R2026');
  assert.equal(close.ok, true, close.message);
  const rows = ss.sheets.AuditLog.data;
  assert.ok(!rows.some((r) => r[2] === 'completeTaskForceClose'), 'không cần force-close');
});

test('updateLogRowStatus: PRESENT→EXTRA GIỮ TIME_SCAN — partition invariant scanned+absent=total (L1)', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'owner@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  ss.sheets.AttendanceTask.appendRow(['R2026', 'HN SOC', '08:00-17:00', 'Inbound', 'Full', 'attend', '2026-08-17 08:00', 'owner@spx.com', '']);
  const t = new Date('2026-08-17T08:00:00+07:00');
  ss.sheets.AttendanceLog.appendRow(['R2026', 'Ops6219', 'NV A', '08:00-17:00', 'HN SOC', 'Inbound', 'WS1', t, t, ST.PRESENT, '2026-08-17']);
  const res = svc.updateLogRowStatus('R2026', 'Ops6219', ST.EXTRA);
  assert.equal(res.ok, true, res.message);
  const raw = ss.sheets.AttendanceLog.data[1];
  assert.equal(raw[8].getTime(), t.getTime(), 'TIME_SCAN giữ nguyên (EXTRA quét phase 2 luôn có SCANNED_AT)');
  assert.equal(res.counters.scanned + res.counters.absent, res.counters.total, 'partition invariant còn nguyên — task đóng được không cần force-close');
  const close = svc.completeTask('R2026');
  assert.equal(close.ok, true, close.message);
  const rows = ss.sheets.AuditLog.data;
  assert.ok(!rows.some((r) => r[2] === 'completeTaskForceClose'), 'không cần force-close');
});

test('updateLogRowStatus: non-owner reject (owner gate)', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'op@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  ss.sheets.AttendanceTask.appendRow(['R2026', 'HN SOC', '08:00-17:00', 'Inbound', 'Full', 'attend', '2026-08-17 08:00', 'owner@spx.com', '']);
  ss.sheets.AttendanceLog.appendRow(['R2026', 'Ops6219', 'NV A', '08:00-17:00', 'HN SOC', 'Inbound', 'WS1', '', '', ST.PENDING, '2026-08-17']);
  const res = svc.updateLogRowStatus('R2026', 'Ops6219', ST.PRESENT);
  assert.equal(res.ok, false);
  assert.equal(res.message, UI_SCAN_OWNER);
});

test('updateLogRowStatus: status không hợp lệ → reject', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'owner@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  ss.sheets.AttendanceTask.appendRow(['R2026', 'HN SOC', '08:00-17:00', 'Inbound', 'Full', 'attend', '2026-08-17 08:00', 'owner@spx.com', '']);
  ss.sheets.AttendanceLog.appendRow(['R2026', 'Ops6219', 'NV A', '08:00-17:00', 'HN SOC', 'Inbound', 'WS1', '', '', ST.PENDING, '2026-08-17']);
  const res = svc.updateLogRowStatus('R2026', 'Ops6219', 'X');
  assert.equal(res.ok, false);
  assert.match(res.message, /hợp lệ/);
});

test('updateLogRowStatus: NV không có trong task → reject; cùng status → reject', () => {
  const { ctx, ss } = makeSandbox({ activeEmail: 'owner@spx.com' });
  const svc = loadAll(ctx);
  svc.ensureSheets_();
  ss.sheets.AttendanceTask.appendRow(['R2026', 'HN SOC', '08:00-17:00', 'Inbound', 'Full', 'attend', '2026-08-17 08:00', 'owner@spx.com', '']);
  ss.sheets.AttendanceLog.appendRow(['R2026', 'Ops6219', 'NV A', '08:00-17:00', 'HN SOC', 'Inbound', 'WS1', '', '', ST.PENDING, '2026-08-17']);
  const nf = svc.updateLogRowStatus('R2026', 'Ops9999', ST.PRESENT);
  assert.equal(nf.ok, false);
  assert.match(nf.message, /Không tìm thấy NV/);
  const same = svc.updateLogRowStatus('R2026', 'Ops6219', ST.PENDING);
  assert.equal(same.ok, false);
  assert.match(same.message, /đã ở trạng thái/);
});
