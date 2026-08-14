/**
 * tests/scan-commit.test.js — planScanCommits (seam B 2026-08-12).
 *
 * Seam THUẦN gom quyết định commit scan: re-check race (2 thiết bị cùng staffId),
 * enrich staffIndex cho append, gom update/append thành batch — scanStaff +
 * pasteCodes dùng chung (thay buildExtraRow cũ).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const ScanLogic = require('../ScanLogic.gs');

const CFG = {
  STATUS: { PENDING: '-', PRESENT: 'Có mặt', ABSENT: 'Vắng', EXTRA: 'Dư' },
  TASK_STATUS: { OPEN: 'open', ATTEND: 'attend', DONE: 'done' },
  TASK_TYPE: { RECONCILE: 'reconcile', FREE: 'free' },
};
const FMT = (d) => 'T:' + d.getTime();

function makeRow(overrides) {
  return Object.assign({
    taskId: 'R1',
    staffId: 'OPS000001',
    staffName: 'NV 1',
    slotCode: '08:00-17:00',
    station: 'HN2 SOC',
    team: 'Inbound',
    workstation: 'IB',
    timeRefText: '',
    timeRefEpoch: 0,
    timeScanText: '',
    timeScanEpoch: 0,
    status: CFG.STATUS.PENDING,
    _rowIndex: 5,
  }, overrides || {});
}

test('planScanCommits: append (không race) → row 11 cột + outcome enrich staffIndex', () => {
  const now = new Date('2026-08-02T08:00:00');
  const staffIndex = {
    OPS000099: { staffName: 'NhanVien Mau 099', slotCode: '13:00-22:00', station: 'HN2 SOC', team: 'Inbound', workstation: 'IBReceiving', date: '2026-08-02' },
  };
  const res = ScanLogic.planScanCommits(CFG, { taskId: 'R1' },
    [{ code: 'OPS000099', action: 'append', field: 'timeScan', status: CFG.STATUS.EXTRA }],
    [], staffIndex, now, FMT);
  assert.equal(res.appends.length, 1);
  assert.equal(res.updates.length, 0);
  const row = res.appends[0];
  assert.equal(row.length, 11);
  assert.equal(row[0], 'R1');
  assert.equal(row[1], 'OPS000099');
  assert.equal(row[2], 'NhanVien Mau 099');
  assert.equal(row[7], '');            // timeRef rỗng
  assert.equal(row[8], now);           // timeScan
  assert.equal(row[9], CFG.STATUS.EXTRA);
  assert.equal(row[10], '2026-08-02');
  const o = res.outcomes.OPS000099;
  assert.equal(o.action, 'append');
  assert.equal(o.timeScanEpoch, now.getTime());
  assert.equal(o.timeRefEpoch, 0);
  assert.equal(o.staffName, 'NhanVien Mau 099');
  assert.equal(o.slotCode, '13:00-22:00');
  // counters từ outcome epoch (nguồn sự thật — khớp computeCounters)
  const c = ScanLogic.computeCounters(CFG, [{ timeScanEpoch: o.timeScanEpoch, timeRefEpoch: o.timeRefEpoch, status: o.status }]);
  assert.equal(c.scanned, 1);
  assert.equal(c.extra, 1);
});

test('planScanCommits: append timeRef → timeRef epoch, status giữ action.status', () => {
  const now = new Date('2026-08-02T08:00:00');
  const res = ScanLogic.planScanCommits(CFG, { taskId: 'R1' },
    [{ code: 'OPS000099', action: 'append', field: 'timeRef', status: CFG.STATUS.PENDING }],
    [], null, now, FMT);
  const row = res.appends[0];
  assert.equal(row[7], now);
  assert.equal(row[8], '');
  assert.equal(row[9], CFG.STATUS.PENDING);
  const o = res.outcomes.OPS000099;
  assert.equal(o.timeRefEpoch, now.getTime());
  assert.equal(o.timeScanEpoch, 0);
  assert.equal(o.status, CFG.STATUS.PENDING);
  assert.equal(o.staffName, null);   // không staffIndex → rỗng
});

test('planScanCommits: update timeScan → 1 update kèm keepStatus, outcome text=fmt(now)', () => {
  const now = new Date('2026-08-02T08:00:00');
  const row = makeRow({});
  const res = ScanLogic.planScanCommits(CFG, { taskId: 'R1' },
    [{ code: 'OPS000001', action: 'update', field: 'timeScan', status: CFG.STATUS.PRESENT, row: row }],
    [row], null, now, FMT);
  assert.equal(res.updates.length, 1);
  assert.deepEqual(Object.keys(res.updates[0]).sort(), ['field', 'keepStatus', 'newStatus', 'rowIndex', 'time']);
  assert.equal(res.updates[0].rowIndex, 5);
  assert.equal(res.updates[0].field, 'timeScan');
  assert.equal(res.updates[0].newStatus, CFG.STATUS.PRESENT);
  assert.equal(res.updates[0].keepStatus, CFG.STATUS.PENDING);
  const o = res.outcomes.OPS000001;
  assert.equal(o.timeScanEpoch, now.getTime());
  assert.equal(o.timeRefEpoch, 0);
  assert.equal(o.status, CFG.STATUS.PRESENT);
});

test('planScanCommits: update timeRef → KHÔNG keepStatus (chỉ TIME_REF, khớp updateLogRowRef_ cũ)', () => {
  const now = new Date('2026-08-02T08:00:00');
  const row = makeRow({});
  const res = ScanLogic.planScanCommits(CFG, { taskId: 'R1' },
    [{ code: 'OPS000001', action: 'update', field: 'timeRef', status: CFG.STATUS.PENDING, row: row }],
    [row], null, now, FMT);
  assert.equal(res.updates.length, 1);
  assert.equal(res.updates[0].field, 'timeRef');
  assert.ok(res.updates[0].keepStatus === undefined, 'timeRef không ghi status');
  assert.equal(res.outcomes.OPS000001.timeRefEpoch, now.getTime());
  assert.equal(res.outcomes.OPS000001.status, CFG.STATUS.PENDING);
});

test('planScanCommits RACE: append nhưng staffId đã có (timeScanEpoch=0) → convert update timeScan', () => {
  const now = new Date('2026-08-02T08:00:00');
  const ex = makeRow({ staffId: 'OPS000001', timeScanEpoch: 0, timeScanText: '', status: CFG.STATUS.PENDING });
  const res = ScanLogic.planScanCommits(CFG, { taskId: 'R1' },
    [{ code: 'OPS000001', action: 'append', field: 'timeScan', status: CFG.STATUS.PRESENT }],
    [ex], null, now, FMT);
  assert.equal(res.appends.length, 0, 'không append trùng');
  assert.equal(res.updates.length, 1);
  assert.equal(res.updates[0].field, 'timeScan');
  assert.equal(res.updates[0].rowIndex, ex._rowIndex);
  assert.equal(res.updates[0].newStatus, CFG.STATUS.PRESENT);
  const o = res.outcomes.OPS000001;
  assert.equal(o.action, 'update');
  assert.equal(o.timeScanEpoch, now.getTime());
  assert.equal(o.status, CFG.STATUS.PRESENT);
});

test('planScanCommits RACE skip: staffId đã có timeScanEpoch>0 → KHÔNG ghi, báo row hiện hữu', () => {
  const now = new Date('2026-08-02T08:00:00');
  const ex = makeRow({ staffId: 'OPS000001', timeScanEpoch: 1700000000000, timeScanText: '07:45:00', status: CFG.STATUS.PRESENT });
  const res = ScanLogic.planScanCommits(CFG, { taskId: 'R1' },
    [{ code: 'OPS000001', action: 'append', field: 'timeScan', status: CFG.STATUS.EXTRA }],
    [ex], null, now, FMT);
  assert.equal(res.updates.length, 0, 'phase đã xong → không ghi (không đè thời gian)');
  assert.equal(res.appends.length, 0);
  const o = res.outcomes.OPS000001;
  assert.equal(o.timeScanEpoch, 1700000000000);
  assert.equal(o.timeScanText, '07:45:00');
  assert.equal(o.status, CFG.STATUS.PRESENT, 'báo status row hiện hữu');
});

test('planScanCommits RACE timeRef: ex chưa có timeRefEpoch → convert update timeRef (không ghi status)', () => {
  const now = new Date('2026-08-02T08:00:00');
  const ex = makeRow({ staffId: 'OPS000001', timeRefEpoch: 0 });
  const res = ScanLogic.planScanCommits(CFG, { taskId: 'R1' },
    [{ code: 'OPS000001', action: 'append', field: 'timeRef', status: CFG.STATUS.PENDING }],
    [ex], null, now, FMT);
  assert.equal(res.updates.length, 1);
  assert.equal(res.updates[0].field, 'timeRef');
  assert.equal(res.outcomes.OPS000001.timeRefEpoch, now.getTime());
  assert.equal(res.outcomes.OPS000001.status, CFG.STATUS.PENDING, 'timeRef convert giữ status row (PENDING)');
});

test('planScanCommits: nhiều actions cùng batch (race skip + update + append thật) — tách đúng', () => {
  const now = new Date('2026-08-02T08:00:00');
  const ex = makeRow({ staffId: 'OPS000001', timeScanEpoch: 1700000000000, timeScanText: '07:45:00', status: CFG.STATUS.PRESENT });
  const row2 = makeRow({ staffId: 'OPS000002', _rowIndex: 9 });
  const actions = [
    { code: 'OPS000001', action: 'append', field: 'timeScan', status: CFG.STATUS.EXTRA }, // race skip
    { code: 'OPS000002', action: 'update', field: 'timeScan', status: CFG.STATUS.PRESENT, row: row2 },
    { code: 'OPS000003', action: 'append', field: 'timeRef', status: CFG.STATUS.PENDING },  // append thật
  ];
  const res = ScanLogic.planScanCommits(CFG, { taskId: 'R1' }, actions, [ex, row2], null, now, FMT);
  assert.equal(res.updates.length, 1);
  assert.equal(res.updates[0].rowIndex, 9);
  assert.equal(res.appends.length, 1);
  assert.equal(res.appends[0][1], 'OPS000003');
  assert.equal(res.outcomes.OPS000001.action, 'update');
  assert.equal(res.outcomes.OPS000001.timeScanEpoch, 1700000000000);
  assert.equal(res.outcomes.OPS000003.action, 'append');
});
