/**
 * mock-google.js — Mock google.script.run cho test UI local (mở index.html trực tiếp).
 *
 * KHÔNG push lên GAS production (đã .claspignore). Chỉ dùng khi chạy file://
 * — index.html tự phát hiện thiếu google.script và nạp file này.
 *
 * Cùng interface thật: google.script.run.fn().withSuccessHandler(h).withFailureHandler(e)
 * Dữ liệu mẫu lấy từ test-fixtures/Att.sample.csv (ẩn danh hóa).
 */
(function () {
  if (typeof window.google !== 'undefined' && window.google.script) return;

  var MOCK_DATA = {
    meta: {
      ok: true,
      appTitle: 'Điểm Danh [LOCAL MOCK]',
      userEmail: 'nv001.demo@spxexpress.com',  // demo viewReports — khớp MOCK_REPORT_INFO bên dưới
      role: 'admin',  // local mock: full quyền (admin) — để mọi view hiện khi test UI (audit-ui/audit-style)
      // Khớp server getMetaApi: { ok, appTitle, userEmail } — KHÔNG labels/tableHeaders
      // (client không dùng, server không trả — drift đã xóa 2026-08-11).
    },
    staff: [
      { staffId: 'Ops237511', staffName: 'NV001', slotCode: '08:00-17:00', station: 'HN2 SOC', team: 'Outbound', workstation: 'OBLoading', agency: 'GRG', contractType: 'BPO', date: '2026-08-02', cardIn: '20:15', cardOut: '06:20' },
      { staffId: 'Ops196935', staffName: 'NV002', slotCode: '08:00-17:00', station: 'HN2 SOC', team: 'Outbound', workstation: 'OBLoading', agency: 'FEX', contractType: 'OS', date: '2026-08-02', cardIn: '20:18', cardOut: '06:25' },
      { staffId: 'Ops229444', staffName: 'NV003', slotCode: '08:00-17:00', station: 'HN2 SOC', team: 'Outbound', workstation: 'OBLoading', agency: 'SKT', contractType: 'S-BPO', date: '2026-08-02', cardIn: '20:22', cardOut: '06:30' },
      { staffId: 'Ops110512', staffName: 'NV004', slotCode: '08:00-17:00', station: 'HN2 SOC', team: 'Outbound', workstation: 'OBHandover', agency: 'TPZ', contractType: 'I-BPO', date: '2026-08-02', cardIn: '20:25', cardOut: '06:35' },
      { staffId: 'Ops124563', staffName: 'NV005', slotCode: '08:00-17:00', station: 'HN2 SOC', team: 'Outbound', workstation: 'OBHandover', agency: 'GMG', contractType: 'OS', date: '2026-08-02', cardIn: '20:28', cardOut: '' },
      { staffId: 'Ops129481', staffName: 'NV104', slotCode: '18:00-02:00', station: 'HN2 SOC', team: 'Inbound', workstation: 'IBReceiving', agency: 'AGR', contractType: 'OS', date: '2026-08-01', cardIn: '06:10', cardOut: '14:20' },
      { staffId: 'Ops126503', staffName: 'NV105', slotCode: '18:00-02:00', station: 'HN2 SOC', team: 'Inbound', workstation: 'IBReceiving', agency: 'SKT', contractType: 'BPO', date: '2026-08-01', cardIn: '06:12', cardOut: '14:22' },
      { staffId: 'Ops133754', staffName: 'NV020', slotCode: '22:00-06:00', station: 'HN2 SOC', team: 'Inbound', workstation: 'IBMove', agency: 'FEX', contractType: 'OS', date: '2026-08-01', cardIn: '10:15', cardOut: '18:19' },
    ],
    tasks: [
      { taskId: 'R20260802-0900', station: 'HN2 SOC', slotCode: '08:00-17:00', team: 'Outbound', status: 'open', createdBy: 'web', createdAtText: '2026-08-02 09:00:00' },
      { taskId: 'R20260802-0850', station: 'HN2 SOC', slotCode: '18:00-02:00', team: 'Inbound', status: 'done', createdBy: 'web', createdAtText: '2026-08-02 08:50:00' },
    ],
  };

  // Log mẫu: 5 NV Outbound 08:00-17:00 (2 đã quét, 3 chưa — task ĐANG MỞ nên là '-') + 1 dư
  function buildLog(taskId) {
    var outbound = MOCK_DATA.staff.filter(function (s) { return s.slotCode === '08:00-17:00'; });
    var log = outbound.map(function (s, i) {
      var scanned = i < 2;
      return {
        taskId: taskId, staffId: s.staffId, staffName: s.staffName,
        slotCode: s.slotCode, station: s.station, team: s.team, workstation: s.workstation,
        // listedAtEpoch CHỈ cho NV đã quét (scanned) — presentAt đếm đúng 2.
        // NV chưa quét: timeRef rỗng → client phase OPEN không chặn 'Đã có mặt' khi quét họ.
        listedAtText: scanned ? '09:00:00' : '',
        listedAtEpoch: scanned ? 1783072800000 : 0,  // 09:00:00 — LISTED_AT (presentAt; khớp server computeCounters)
        scannedAtText: scanned ? (i === 0 ? '09:02:15' : '09:03:40') : '',
        scannedAtEpoch: scanned ? 1783072800000 + (i === 0 ? 135000 : 220000) : 0,  // 09:02:15 / 09:03:40 — sort key
        status: scanned ? 'Có mặt' : '-',
        dateText: '2026-08-01',  // ngày vào làm (StaffData Date) — khớp server yyyy-MM-dd
      };
    });
    // Dư row: NV lạ phase 2 → Dư ghi SCANNED_AT (ScanLogic) — CÓ scannedAtEpoch như scanStaffApi push.
    // Khớp server computeCounters: scanned đếm mọi row scannedAtEpoch>0 kể cả Dư.
    // scannedAtEpoch khớp scannedAtText '09:05:00' (= 09:02:15 + 165s).
    log.push({
      taskId: taskId, staffId: 'Ops999999', staffName: 'NV-DU', slotCode: '', station: '', team: '',
      workstation: '', listedAtText: '', scannedAtText: '09:05:00', scannedAtEpoch: 1783073100000, status: 'Dư',
    });
    return log;
  }

  function counters(log) {
    // Khớp server computeCounters (ScanLogic.gs): 5 field — scanned, presentAt, absent, extra, total.
    // Epoch > 0 là nguồn sự thật duy nhất (text mất ngày xuyên nửa đêm).
    var c = { scanned: 0, presentAt: 0, absent: 0, extra: 0, total: log.length };
    log.forEach(function (r) {
      var hasScan = Number(r.scannedAtEpoch) > 0;
      var hasRef = Number(r.listedAtEpoch) > 0;
      if (hasScan) c.scanned++;
      if (hasRef) c.presentAt++;
      if (r.status === 'Dư') c.extra++;
      else if (!hasScan) c.absent++;
    });
    return c;
  }

  function delay(fn) { setTimeout(fn, 250); }

  // State per-task: mock PHẢI giữ log giữa các lần quét (giống prod đọc sheet thật).
  // Nếu buildLog lại mỗi lần → mất state → counters sai giữa các lần quét liên tiếp.
    // Chuẩn hoá filter giống server filterStaffByGroup (CsvUtil.gs) — dùng cho preview
  function mockFilterStaff(base) {
    return MOCK_DATA.staff.filter(function (s) {
      if (base.station && s.station !== base.station) return false;
      if (base.slotCode && base.slotCode.length && base.slotCode.indexOf(s.slotCode) === -1) return false;
      if (base.team && base.team.length && base.team.indexOf(s.team) === -1) return false;
      if (base.contractType && base.contractType.length && base.contractType.indexOf(s.contractType) === -1) return false;
      if (base.date && base.date !== (s.date || '')) return false;
      return true;
    });
  }
  function mockDedupe(list) {
    var seen = {}; return list.filter(function (s) { if (seen[s.staffId]) return false; seen[s.staffId] = true; return true; });
  }
  var MOCK_LOGS = {};
  function getLog(taskId) {
    if (!MOCK_LOGS[taskId]) MOCK_LOGS[taskId] = buildLog(taskId);
    return MOCK_LOGS[taskId];
  }

  // Settings Admin (mock): state bền giữa save/get — giống prod đọc sheet thật.
  var SETTINGS_DEFAULTS_MOCK = {
    defaultStation: '', defaultSlotCode: '', defaultTeam: '', roleMap: {},  // single keys (Config.gs)
    stations: ['HN2 SOC', 'HN SOC'], teams: ['Inbound', 'Outbound', 'Manual', 'TBS', 'Prep-WH'],
    slotcodes: ['08:00-17:00', '13:00-01:00', '13:00-22:00', '18:00-02:00', '18:00-05:00', '20:00-06:00', '22:00-06:00'],
    departments: ['SOC'],  // group keys = JSON array — khớp SETTINGS_DEFAULTS (Config.gs)
    agencies: [],  // thứ tự cột Agency stats (rỗng = giữ alphabet)
    contractTypes: [],  // thứ tự chip Contract Type + cột Contract×Ca stats (2026-08-16)
  };
  var MOCK_SETTINGS = {
    stations: ['HN2 SOC', 'HN SOC'],
    teams: ['Inbound', 'Outbound'],
    slotcodes: ['08:00-17:00', '13:00-01:00', '18:00-02:00'],
    departments: ['SOC'],
    agencies: ['GRG', 'FEX', 'SKT'],  // demo: mock staff có GRG/FEX/SKT (có trong Config) + TPZ/GMG/AGR (lệch → Khác)
    contractTypes: ['BPO', 'OS', 'S-BPO', 'I-BPO'],  // demo: thứ tự chip tạo task + cột Contract×Ca stats
  };

  // Báo cáo (viewReports) mock: StaffInfo email→Ops + StaffAttendance rows — khớp server
  // ReportRepo/ReportService: lọc theo Ops ID, "None"→'', sort desc theo ngày (client render).
  var MOCK_REPORT_INFO = {
    'nv001.demo@spxexpress.com': { opsId: 'Ops237511', name: 'NV001' },
  };
  var MOCK_REPORT_ROWS = [
    { reportDate: '2026-08-01', bizStaffId: 'Ops237511', employeeId: 'SPXVN00001', staffName: 'NV001', station: 'HN2 SOC', result: '22:00-06:00', workHour: '8.13', inTime: '21:52', outTime: '06:00', pmo: 'Tang NV001' },
    { reportDate: '2026-08-02', bizStaffId: 'Ops237511', employeeId: 'SPXVN00001', staffName: 'NV001', station: 'HN2 SOC', result: 'OFF', workHour: '', inTime: '', outTime: '', pmo: 'Không chấm công hoặc OFF tuần' },
    { reportDate: '2026-08-03', bizStaffId: 'Ops237511', employeeId: 'SPXVN00001', staffName: 'NV001', station: 'HN2 SOC', result: '08:00-17:00', workHour: '8', inTime: '07:58', outTime: '17:02', pmo: 'Tang NV001' },
    { reportDate: '2026-08-04', bizStaffId: 'Ops999999', employeeId: 'SPXVN00999', staffName: 'NV-DU', station: 'HN2 SOC', result: '13:00-22:00', workHour: '9', inTime: '12:55', outTime: '22:01', pmo: '—' },
  ];

  var handlers = {
    getMetaApi: function () {
      // Khớp server getMetaApi (Code.gs): { ok, appTitle, userEmail, isEditor, role }.
      // Mock LUÔN editor (isEditor:true) + role admin (server getRole_: editor => ADMIN) — để test trang Cấu hình ở local.
      return { ok: true, appTitle: MOCK_DATA.meta.appTitle, userEmail: MOCK_DATA.meta.userEmail || '', isEditor: true, role: 'admin' };
    },
    warmStaffCacheApi: function () {
      // Khớp server: slim index { staffId, staffName, slotCode, station, team, workstation, agency }
      // FIX(2026-08-14): key UPPERCASE như server normalizeStaffId (CsvUtil.gs) — client tra cứu
      // theo .toUpperCase() (scanRowCells/scanCardHTML); mock cũ giữ case gốc 'Ops237511'
      // → CLIENT_STAFF_INDEX miss → Agency rỗng ở local test (server trả key hoa).
      var slim = {};
      MOCK_DATA.staff.forEach(function (s) {
        var id = String(s.staffId || '').trim().toUpperCase();
        slim[id] = { staffId: id, staffName: s.staffName, slotCode: s.slotCode, station: s.station, team: s.team, workstation: s.workstation, agency: s.agency || '', date: s.date || '' };
      });
      return { ok: true, index: slim };
    },
    getFilterOptionsApi: function () {
      // Khớp server: trả cây stationGroups cho modal tạo task + defaults (pre-select) + lists
      // (danh sách Admin khai báo — client merge với distinct StaffData qua mergeOpts_).
      return {
        ok: true,
        defaults: {
          // pre-select modal tạo task — đọc MOCK_SETTINGS (đã lưu qua trang Cấu hình local)
          station: (MOCK_SETTINGS.defaultStation || ''),
          slotCode: (MOCK_SETTINGS.defaultSlotCode || ''),
          team: (MOCK_SETTINGS.defaultTeam || ''),
        },
        lists: {
          // khớp server getFilterOptionsApi.lists (SettingsService settingsList_)
          stations: (MOCK_SETTINGS.stations || []).slice(),
          teams: (MOCK_SETTINGS.teams || []).slice(),
          slotcodes: (MOCK_SETTINGS.slotcodes || []).slice(),
          departments: (MOCK_SETTINGS.departments || []).slice(),
          agencies: (MOCK_SETTINGS.agencies || []).slice(),
          contractTypes: (MOCK_SETTINGS.contractTypes || []).slice(),
        },
        stationGroups: [
          {
            station: 'HN2 SOC',
            slotCodes: [
              { slotCode: '08:00-17:00', teams: ['Outbound'] },
              { slotCode: '13:00-22:00', teams: ['Inbound'] },
              { slotCode: '18:00-02:00', teams: ['Inbound'] },
              { slotCode: '22:00-06:00', teams: ['Inbound'] },
            ],
            contractTypes: ['GRG', 'OS', 'VN'],
            dates: ['2026-08-01', '2026-08-02', '2026-08-03'],
          },
        ],
      };
    },
    previewStaffApi: function (input) {
      // chuẩn hoá: đếm NV khớp filter (giống server previewStaffApi)
      var base = {
        station: input && input.station,
        slotCode: (input && input.slotCode) || [],
        team: (input && input.team) || [],
        contractType: (input && input.contractType) || [],
        date: input && input.date,
      };
      var filtered = mockFilterStaff(base);
      return { ok: true, count: mockDedupe(filtered).length };
    },
    getTaskListApi: function () {
      return MOCK_DATA.tasks.slice();
    },
    getAuditLogApi: function (limit) {
      return { ok: true, rows: (MOCK_DATA.audit || []).slice(0, limit || 50) };
    },
    getTaskDetailApi: function (taskId) {
      var task = null;
      MOCK_DATA.tasks.forEach(function (t) { if (t.taskId === taskId) task = t; });
      if (!task) return { ok: false, message: 'Không tìm thấy task', task: null, log: [] };
      var log = getLog(taskId);
      // Deep-copy khi trả client — optimistic client mutate CURRENT_LOG (status/epoch)
      // KHÔNG được leak vào server-side mock state (giống prod: google.script.run serialize JSON).
      // Nếu trả reference: mọi lần quét đầu tiên đều bị reject nhầm 'Đã điểm danh'.
      // Khớp server getTaskDetail (TaskService.gs): permission tính tươi theo user đọc —
      // mock luôn owner/admin để 2 nút Dán + Lấy danh sách hiện khi test local.
      task.permission = { isAdmin: true, isOwner: true, canScanOpen: true };
      return { ok: true, task: task, log: JSON.parse(JSON.stringify(log)), counters: counters(log) };
    },
    createReconcileTaskApi: function (input) {
      var taskId = 'R' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-0' + (MOCK_DATA.tasks.length + 1);
      var task = {
        taskId: taskId, station: input.station, slotCode: input.slotCode,
        team: input.team, date: (input && input.date) || '', status: 'open', createdBy: 'web', createdAtText: '2026-08-02 09:00:00',
      };
      MOCK_DATA.tasks.unshift(task);
      var log = getLog(taskId);
      return { ok: true, taskId: taskId, count: log.length, message: 'Tạo task thành công: ' + taskId };
    },
    scanStaffApi: function (taskId, staffId, clientEpoch) {
      // Mock 2-pha khớp server scanStaff (ScanService.gs + classifyScan):
      // open = ghi LISTED_AT (timeRef, giữ status '-'); attend = ghi SCANNED_AT (timeScan).
      var log = getLog(taskId);
      var task = null;
      MOCK_DATA.tasks.forEach(function (t) { if (t.taskId === taskId) task = t; });
      var phase2 = !!(task && task.status === 'attend');
      var hit = null;
      log.forEach(function (r) { if (r.staffId.toLowerCase() === staffId.toLowerCase()) hit = r; });
      // WYSIWYG: nhận epoch client chụp lúc quét (khớp server scanStaff clientEpoch) — mock
      // không đè bằng giờ server (test local khớp prod: giờ hiển thị = giờ ghi sheet).
      var nowMs = (typeof clientEpoch === 'number' && clientEpoch > 0) ? clientEpoch : Date.now();
      var d = new Date(nowMs);
      var ts = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
      if (hit) {
        var done = phase2 ? (Number(hit.scannedAtEpoch) > 0) : (Number(hit.listedAtEpoch) > 0);
        if (done) {
          return { ok: false, message: phase2 ? 'Đã điểm danh' : 'Đã có mặt', status: null, scannedAtText: '', scannedAtEpoch: 0, listedAtText: '', listedAtEpoch: 0, staffName: null, counters: counters(log) };
        }
        if (phase2) { hit.status = 'Có mặt'; hit.scannedAtText = ts; hit.scannedAtEpoch = nowMs; }
        else { hit.listedAtText = ts; hit.listedAtEpoch = nowMs; }  // giữ status '-'​ (PENDING)
        return { ok: true, message: 'Có mặt', status: hit.status, phase: phase2 ? 'attend' : 'present', field: phase2 ? 'scannedAt' : 'listedAt',
          scannedAtText: hit.scannedAtText || '', scannedAtEpoch: hit.scannedAtEpoch || 0,
          listedAtText: hit.listedAtText || '', listedAtEpoch: hit.listedAtEpoch || 0,
          staffName: hit.staffName, dateText: (hit && hit.dateText) || '', counters: counters(log) };
      }
      // NV lạ: phase1 = PENDING (thuệc danh sách); phase2 = Dư (ngoài danh sách).
      var st = !phase2 ? '-' : 'Dư';
      log.push({ taskId: taskId, staffId: staffId, staffName: 'NV LẠ', slotCode: '', station: '', team: '', workstation: '',
        listedAtText: phase2 ? '' : ts, listedAtEpoch: phase2 ? 0 : nowMs,
        scannedAtText: phase2 ? ts : '', scannedAtEpoch: phase2 ? nowMs : 0, status: st, dateText: '' });
      return { ok: true, message: st, status: st, phase: phase2 ? 'attend' : 'present', field: phase2 ? 'scannedAt' : 'listedAt',
        scannedAtText: phase2 ? ts : '', scannedAtEpoch: phase2 ? nowMs : 0,
        listedAtText: phase2 ? '' : ts, listedAtEpoch: phase2 ? 0 : nowMs,
        staffName: 'NV LẠ', dateText: '', counters: counters(log) };
    },
    pasteCodesApi: function (taskId, rawLines) {
      // Khớp server pasteCodes: { ok, message, total, success, failed, results, counters }
      var lines = (Array.isArray(rawLines) ? rawLines : []).slice(0, 200);
      var task = null;
      MOCK_DATA.tasks.forEach(function (t) { if (t.taskId === taskId) task = t; });
      if (!task) return { ok: false, message: 'Không tìm thấy task', total: 0, success: 0, failed: 0, results: [], counters: null };
      if (task.status !== 'open') {
        return { ok: false, message: 'Chỉ áp dụng quét tự do phase Mở', total: 0, success: 0, failed: 0, results: [], counters: null };
      }
      var log = getLog(taskId);
      // Gate canScanOpen_ (owner/admin phase OPEN) bỏ qua CÓ CHỦ Ý — mock không mô
      // hình hoá identity; luôn mở cho local test. Không "fix" thành gate ở đây.
      var results = [];
      var success = 0, failed = 0;
      var seen = {}; // mã trùng trong cùng batch → reject (khớp planBatchScans)
      var nowMs = Date.now();
      var d = new Date(nowMs);
      var ts = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
      lines.forEach(function (code) {
        var c = String(code || '').trim();
        if (!c) return;
        if (!/^OPS\d+$/i.test(c)) { failed++; results.push({ code: c, ok: false, reason: 'invalid-format' }); return; }
        var key = c.toUpperCase();
        if (seen[key]) { failed++; results.push({ code: c, ok: false, reason: 'already-present' }); return; }
        seen[key] = true;
        var hit = null;
        log.forEach(function (r) { if (r.staffId.toLowerCase() === c.toLowerCase()) hit = r; });
        if (hit && hit.status !== '-') { failed++; results.push({ code: c, ok: false, reason: 'already-present' }); return; }
        if (hit) { hit.listedAtText = ts; hit.listedAtEpoch = nowMs; }
        else { log.push({ taskId: taskId, staffId: c.toUpperCase(), staffName: 'NV DÁN', slotCode: '', station: '', team: '', workstation: '', listedAtText: ts, listedAtEpoch: nowMs, scannedAtText: '', scannedAtEpoch: 0, status: '-', dateText: '' }); }
        success++; results.push({ code: c, ok: true, action: 'append' });
      });
      return { ok: true, message: 'Dán ' + success + '/' + lines.length + ' mã thành công', total: lines.length, success: success, failed: failed, results: results, counters: counters(log) };
    },
    loadRosterApi: function (taskId, filters) {
      // Khớp server loadRoster (TaskService): gate status OPEN; lọc StaffData → append PENDING
      // + timeRef = now; bỏ qua NV đã có dòng (idempotent, không lỗi như paste).
      var task = null;
      MOCK_DATA.tasks.forEach(function (t) { if (t.taskId === taskId) task = t; });
      function z(msg) { return { ok: false, total: 0, added: 0, skipped: 0, message: msg, counters: null }; }
      if (!task) return z('Không tìm thấy task');
      if (task.status === 'done') return z('Task đã kết thúc — không thể nạp danh sách');
      var base = {
        station: filters && filters.station,
        slotCode: (filters && filters.slotCode) || [],
        team: (filters && filters.team) || [],
        contractType: (filters && filters.contractType) || [],
        date: filters && filters.date,
      };
      var deduped = mockDedupe(mockFilterStaff(base));
      if (!deduped.length) return z('Không có nhân viên nào trong tổ hợp đã chọn');
      var log = getLog(taskId);
      var nowMs = Date.now();
      var d = new Date(nowMs);
      var ts = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
      var added = 0, skipped = 0;
      deduped.forEach(function (s) {
        var hit = null;
        log.forEach(function (r) { if (r.staffId.toLowerCase() === s.staffId.toLowerCase()) hit = r; });
        if (hit) { skipped++; return; }
        log.push({ taskId: taskId, staffId: s.staffId, staffName: s.staffName || '', slotCode: s.slotCode || '', station: s.station || '', team: s.team || '', workstation: s.workstation || '', listedAtText: ts, listedAtEpoch: nowMs, scannedAtText: '', scannedAtEpoch: 0, status: '-', dateText: s.date || '' });
        added++;
      });
      return { ok: true, total: deduped.length, added: added, skipped: skipped, counters: counters(log), message: added ? ('Đã nạp ' + added + ' NV' + (skipped ? ' — bỏ qua ' + skipped + ' đã có' : '')) : ('Tất cả ' + skipped + ' NV đã có trong danh sách') };
    },
    updateLogRowStatusApi: function (taskId, staffId, newStatus) {
      // Khớp server updateLogRowStatus (TaskService): đổi STATUS 1 dòng theo staffId;
      // PRESENT trên dòng chưa quét → fill TIME_SCAN = now; trả counters + message.
      var task = null;
      MOCK_DATA.tasks.forEach(function (t) { if (t.taskId === taskId) task = t; });
      if (!task) return { ok: false, message: 'Không tìm thấy task', counters: null };
      var allowed = ['-', 'Có mặt', 'Vắng', 'Dư'];
      if (allowed.indexOf(newStatus) === -1) return { ok: false, message: 'Trạng thái không hợp lệ', counters: null };
      var needle = String(staffId || '').trim().toUpperCase();
      var hit = null;
      getLog(taskId).forEach(function (r) { if (String(r.staffId || '').toUpperCase() === needle) hit = r; });
      if (!hit) return { ok: false, message: 'Không tìm thấy NV trong task', counters: null };
      if (hit.status === newStatus) return { ok: false, message: 'NV đã ở trạng thái này', counters: null };
      hit.status = newStatus;
      if (newStatus === 'Có mặt' && !hit.scannedAtEpoch) {
        var nowMs = Date.now();
        var d = new Date(nowMs);
        hit.scannedAtText = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
        hit.scannedAtEpoch = nowMs;
      }
      return { ok: true, message: 'Đã cập nhật ' + staffId + ' → ' + newStatus, counters: counters(getLog(taskId)) };
    },
    searchLogsByStaffApi: function (rawStaffId) {
      // Mock F-search: quét toàn bộ task log + roster NV, filter staffId (case-insensitive).
      var needle = String(rawStaffId || '').trim().toUpperCase();
      var out = [];
      // Khớp server: trả { ok, rows } — mock không mô hình gate manager (luôn ok, test shape thôi).
      if (!needle) return { ok: true, rows: [] };
      MOCK_DATA.tasks.forEach(function (t) {
        var log = getLog(t.taskId);
        log.forEach(function (r) {
          if (String(r.staffId || '').toUpperCase() !== needle) return;
          out.push({
            taskId: t.taskId, staffId: r.staffId, staffName: r.staffName, status: r.status,
            station: t.station, team: t.team, slotCode: t.slotCode,
            taskStatus: t.status, createdAtText: t.createdAtText, createdBy: t.createdBy,
            listedAtText: r.listedAtText, scannedAtText: r.scannedAtText,
          });
        });
      });
      // Thêm roster NV (các NV chưa trong log của task này) — mock tìm trong staff list.
      MOCK_DATA.staff.forEach(function (s) {
        if (String(s.staffId || '').toUpperCase() !== needle) return;
        MOCK_DATA.tasks.forEach(function (t) {
          var exists = out.some(function (o) { return o.taskId === t.taskId && o.staffId === s.staffId; });
          if (exists) return;
          out.push({
            taskId: t.taskId, staffId: s.staffId, staffName: s.staffName, status: '-',
            station: t.station, team: t.team, slotCode: t.slotCode,
            taskStatus: t.status, createdAtText: t.createdAtText, createdBy: t.createdBy,
            listedAtText: '', scannedAtText: '',
          });
        });
      });
      out.sort(function (a, b) { return b.createdAtText < a.createdAtText ? -1 : (b.createdAtText > a.createdAtText ? 1 : 0); });
      return { ok: true, rows: out.slice(0, 200) };
    },
    searchTasksByQueryApi: function (rawQ) {
      // Mock tìm kiếm task theo mã (prefix/contains, case-insensitive) — copy matchTasksByQuery.
      var q = String(rawQ || '').trim().toUpperCase();
      if (!q) return [];
      return MOCK_DATA.tasks.filter(function (t) {
        return t.taskId && String(t.taskId).toUpperCase().indexOf(q) >= 0;
      }).slice(0, 50);
    },
    transitionToAttendApi: function (taskId) {
      // Khớp server transitionToAttend: chỉ OPEN → ATTEND (phase2)
      var task = null;
      MOCK_DATA.tasks.forEach(function (t) { if (t.taskId === taskId) task = t; });
      if (!task) return { ok: false, message: 'Không tìm thấy task' };
      if (task.status !== 'open') return { ok: false, message: 'Chỉ chuyển sang điểm danh khi task đang ở trạng thái Mở' };
      task.status = 'attend';
      return { ok: true, message: 'Đã chuyển sang Điểm danh — bắt đầu điểm danh' };
    },
    reopenTaskApi: function (taskId) {
      // F3: mirror server reopenTask — resetAbsentToPending_ (ABSENT->PENDING) trước,
      // rồi chuyển ATTEND (phase2). Trước đây set 'open' thẳng → lệch phase + counters.
      var rows = getLog(taskId);
      rows.forEach(function (r) {
        if (r.status === 'Vắng' /* ABSENT */ || r.status === 'vắng') r.status = '-'; /* PENDING */
      });
      MOCK_DATA.tasks.forEach(function (t) { if (t.taskId === taskId) t.status = 'attend'; });
      return { ok: true, message: 'Đã mở lại task ' + taskId };
    },
    completeTaskApi: function (taskId) {
      MOCK_DATA.tasks.forEach(function (t) { if (t.taskId === taskId) t.status = 'done'; });
      return { ok: true, message: 'Đã kết thúc task ' + taskId };
    },
    cancelTaskApi: function (taskId) {
      // Khớp server cancelTask: chỉ OPEN + log rỗng → xóa hẳn khỏi MOCK_DATA.tasks.
      var idx = -1;
      for (var i = 0; i < MOCK_DATA.tasks.length; i++) {
        if (MOCK_DATA.tasks[i].taskId === taskId) { idx = i; break; }
      }
      if (idx < 0) return { ok: false, message: 'Không tìm thấy task' };
      if (MOCK_DATA.tasks[idx].status !== 'open') return { ok: false, message: 'Chỉ hủy được task đang ở phase Mở' };
      var rows = getLog(taskId);
      if (rows && rows.length) return { ok: false, message: 'Task đã có dữ liệu quét — không hủy được' };
      MOCK_DATA.tasks.splice(idx, 1);
      return { ok: true, message: 'Đã hủy task ' + taskId };
    },
    getStaffStatsApi: function () {
      // Mock view StaffData: trả toàn bộ MOCK_DATA.staff (đã có agency/contractType).
      return { ok: true, staff: MOCK_DATA.staff };
    },
    getSettingsApi: function () {
      // Khớp server getSettings_: merge defaults + override (state MOCK_SETTINGS bền).
      var out = {};
      Object.keys(SETTINGS_DEFAULTS_MOCK).forEach(function (k) { out[k] = SETTINGS_DEFAULTS_MOCK[k]; });
      Object.keys(MOCK_SETTINGS).forEach(function (k) { out[k] = MOCK_SETTINGS[k]; });
      return { ok: true, settings: out };
    },
    saveSettingsApi: function (patch) {
      // Khớp server saveSettings_: whitelist key defaults + lưu state (value undefined → bỏ qua).
      var saved = []; var ignored = [];
      Object.keys(patch || {}).forEach(function (k) {
        if (patch[k] === undefined) { ignored.push(k); return; }
        if (k in SETTINGS_DEFAULTS_MOCK) { MOCK_SETTINGS[k] = patch[k]; saved.push(k); }
        else { ignored.push(k); }
      });
      return { ok: true, saved: saved, ignored: ignored, message: 'Đã lưu ' + saved.length + ' cấu hình' };
    },
    getReportsApi: function () {
      // Khớp server getReports (ReportService): lọc theo email đăng nhập → Ops ID (StaffInfo).
      var email = String((MOCK_DATA.meta && MOCK_DATA.meta.userEmail) || '').trim().toLowerCase();
      var info = MOCK_REPORT_INFO[email];
      if (!info) return { ok: true, rows: [], email: email, message: 'Không tìm thấy mã nhân viên (StaffInfo) cho email này' };
      var rows = MOCK_REPORT_ROWS.filter(function (r) { return String(r.bizStaffId).toUpperCase() === String(info.opsId).toUpperCase(); });
      return { ok: true, rows: rows, email: email, opsId: info.opsId, staffName: info.name, message: rows.length ? '' : 'Chưa có dữ liệu chấm công (StaffAttendance) cho nhân viên này' };
    },
  };

  // GAS thật: google.script.run.withSuccessHandler(h).withFailureHandler(e).fn(args)
  // → gọi theo CHAIN (handler gán trước, hàm gọi cuối).
  // Mock phải bắt chước đúng: MỖI chain có closure handler RIÊNG —
  // nếu dùng 1 object pending chung, 2 API gọi gần nhau (vd loadFilterOptions
  // + loadTaskList từ refreshAll) sẽ đè handler của nhau → dropdown trống.
  function makeRunner() {
    function makeChain() {
      var ok = null;
      var err = null;
      var proxy = {
        withSuccessHandler: function (h) { ok = h; return proxy; },
        withFailureHandler: function (h) { err = h; return proxy; },
      };
      Object.keys(handlers).forEach(function (name) {
        proxy[name] = function () {
          var args = Array.prototype.slice.call(arguments);
          delay(function () {
            try {
              var result = handlers[name].apply(null, args);
              if (ok) ok(result);
            } catch (e) {
              if (err) err(e);
              else throw e;
            }
          });
          return proxy;
        };
      });
      return proxy;
    }
    var run = {
      withSuccessHandler: function (h) { return makeChain().withSuccessHandler(h); },
      withFailureHandler: function (h) { return makeChain().withFailureHandler(h); },
    };
    // Cho phép gọi run.fn() trực tiếp không handler (chạy nhưng không làm gì)
    Object.keys(handlers).forEach(function (name) {
      run[name] = function () { return makeChain()[name].apply(null, arguments); };
    });
    return run;
  }

  var run = makeRunner();

  window.google = { script: { run: run } };
  console.log('[MOCK] google.script.run đã nạp — chế độ LOCAL, không gọi GAS thật');
})();
