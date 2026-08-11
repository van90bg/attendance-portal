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
      appTitle: 'Attendance Portal [LOCAL MOCK]',
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
      { taskId: 'R20260802-0900', taskType: 'reconcile', station: 'HN2 SOC', slotCode: '08:00-17:00', team: 'Outbound', status: 'open', createdBy: 'web', createdAtText: '2026-08-02 09:00:00' },
      { taskId: 'R20260802-0850', taskType: 'reconcile', station: 'HN2 SOC', slotCode: '18:00-02:00', team: 'Inbound', status: 'done', createdBy: 'web', createdAtText: '2026-08-02 08:50:00' },
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
        // timeRefEpoch CHỈ cho NV đã quét (scanned) — presentAt đếm đúng 2.
        // NV chưa quét: timeRef rỗng → client phase OPEN không chặn 'Đã có mặt' khi quét họ.
        timeRefText: scanned ? '09:00:00' : '',
        timeRefEpoch: scanned ? 1783072800000 : 0,  // 09:00:00 — Giờ có mặt (presentAt; khớp server computeCounters)
        timeScanText: scanned ? (i === 0 ? '09:02:15' : '09:03:40') : '',
        timeScanEpoch: scanned ? 1783072800000 + (i === 0 ? 135000 : 220000) : 0,  // 09:02:15 / 09:03:40 — sort key
        status: scanned ? 'Có mặt' : '-',
        dateText: '2026-08-01',  // ngày vào làm (StaffData Date) — khớp server yyyy-MM-dd
      };
    });
    // Dư row: NV lạ phase 2 → Dư ghi Giờ quét (ScanLogic) — CÓ timeScanEpoch như scanStaffApi push.
    // Khớp server computeCounters: scanned đếm mọi row timeScanEpoch>0 kể cả Dư.
    // timeScanEpoch khớp timeScanText '09:05:00' (= 09:02:15 + 165s).
    log.push({
      taskId: taskId, staffId: 'Ops999999', staffName: 'NV-DU', slotCode: '', station: '', team: '',
      workstation: '', timeRefText: '', timeScanText: '09:05:00', timeScanEpoch: 1783073100000, status: 'Dư',
    });
    return log;
  }

  function counters(log) {
    // Khớp server computeCounters (ScanLogic.gs): 5 field — scanned, presentAt, absent, extra, total.
    // Epoch > 0 là nguồn sự thật duy nhất (text mất ngày xuyên nửa đêm).
    var c = { scanned: 0, presentAt: 0, absent: 0, extra: 0, total: log.length };
    log.forEach(function (r) {
      var hasScan = Number(r.timeScanEpoch) > 0;
      var hasRef = Number(r.timeRefEpoch) > 0;
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
      if (base.date && base.date !== (s.dateText || '')) return false;
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
  };
  var MOCK_SETTINGS = {
    stations: ['HN2 SOC', 'HN SOC'],
    teams: ['Inbound', 'Outbound'],
    slotcodes: ['08:00-17:00', '13:00-01:00', '18:00-02:00'],
    departments: ['SOC'],
  };

  var handlers = {
    getMetaApi: function () {
      // Khớp server getMetaApi (Code.gs): { ok, appTitle, userEmail, isEditor, role }.
      // Mock LUÔN editor (isEditor:true) + role admin (server getRole_: editor => ADMIN) — để test trang Cấu hình ở local.
      return { ok: true, appTitle: MOCK_DATA.meta.appTitle, userEmail: '', isEditor: true, role: 'admin' };
    },
    warmStaffCacheApi: function () {
      // Khớp server: slim index { staffId, staffName, slotCode, station, team, workstation, agency }
      var slim = {};
      MOCK_DATA.staff.forEach(function (s) {
        slim[s.staffId] = { staffId: s.staffId, staffName: s.staffName, slotCode: s.slotCode, station: s.station, team: s.team, workstation: s.workstation, agency: s.agency || '' };
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
    getTaskDetailApi: function (taskId) {
      var task = null;
      MOCK_DATA.tasks.forEach(function (t) { if (t.taskId === taskId) task = t; });
      if (!task) return { ok: false, message: 'Không tìm thấy task', task: null, log: [] };
      var log = getLog(taskId);
      // Deep-copy khi trả client — optimistic client mutate CURRENT_LOG (status/epoch)
      // KHÔNG được leak vào server-side mock state (giống prod: google.script.run serialize JSON).
      // Nếu trả reference: mọi lần quét đầu tiên đều bị reject nhầm 'Đã điểm danh'.
      return { ok: true, task: task, log: JSON.parse(JSON.stringify(log)), counters: counters(log) };
    },
    createReconcileTaskApi: function (input) {
      var taskId = 'R' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-0' + (MOCK_DATA.tasks.length + 1);
      var task = {
        taskId: taskId, taskType: 'reconcile', station: input.station, slotCode: input.slotCode,
        team: input.team, date: (input && input.date) || '', status: 'open', createdBy: 'web', createdAtText: '2026-08-02 09:00:00',
      };
      MOCK_DATA.tasks.unshift(task);
      var log = getLog(taskId);
      return { ok: true, taskId: taskId, count: log.length, message: 'Tạo task thành công: ' + taskId };
    },
    scanStaffApi: function (taskId, staffId) {
      var log = getLog(taskId);
      var hit = null;
      log.forEach(function (r) { if (r.staffId.toLowerCase() === staffId.toLowerCase()) hit = r; });
      var nowMs = Date.now();  // timeScanEpoch: sort key thật (QA sort "mới nhất lên đầu")
      var d = new Date(nowMs);
      var ts = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
      if (hit && (hit.status === 'Có mặt' || hit.status === 'Dư')) {
        return { ok: false, message: 'Đã điểm danh', status: null, timeScanText: '', timeScanEpoch: 0, staffName: null, counters: counters(log) };
      }
      if (hit) { hit.status = 'Có mặt'; hit.timeScanText = ts; hit.timeScanEpoch = nowMs; }
      else { log.push({ taskId: taskId, staffId: staffId, staffName: 'NV LẠ', slotCode: '', station: '', team: '', workstation: '', timeRefText: '', timeScanText: ts, timeScanEpoch: nowMs, status: 'Dư' }); }
      return { ok: true, message: 'Có mặt', status: 'Có mặt', timeScanText: ts, timeScanEpoch: nowMs, staffName: hit ? hit.staffName : 'NV LẠ', counters: counters(log) };
    },
    pasteCodesApi: function (taskId, rawLines) {
      // Khớp server pasteCodes: { ok, message, total, success, failed, results, counters }
      var lines = (Array.isArray(rawLines) ? rawLines : []).slice(0, 200);
      var task = null;
      MOCK_DATA.tasks.forEach(function (t) { if (t.taskId === taskId) task = t; });
      if (!task) return { ok: false, message: 'Không tìm thấy task', total: 0, success: 0, failed: 0, results: [], counters: null };
      if (task.taskType !== 'free' || task.status !== 'open') {
        return { ok: false, message: 'Chỉ áp dụng quét tự do (FREE) phase Mở', total: 0, success: 0, failed: 0, results: [], counters: null };
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
        if (hit) { hit.timeRefText = ts; hit.timeRefEpoch = nowMs; }
        else { log.push({ taskId: taskId, staffId: c.toUpperCase(), staffName: 'NV DÁN', slotCode: '', station: '', team: '', workstation: '', timeRefText: ts, timeRefEpoch: nowMs, timeScanText: '', timeScanEpoch: 0, status: '-', dateText: '' }); }
        success++; results.push({ code: c, ok: true, action: 'append' });
      });
      return { ok: true, message: 'Dán ' + success + '/' + lines.length + ' mã thành công', total: lines.length, success: success, failed: failed, results: results, counters: counters(log) };
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
            taskType: t.taskType, station: t.station, team: t.team, slotCode: t.slotCode,
            taskStatus: t.status, createdAtText: t.createdAtText, createdBy: t.createdBy,
            timeRefText: r.timeRefText, timeScanText: r.timeScanText,
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
            taskType: t.taskType, station: t.station, team: t.team, slotCode: t.slotCode,
            taskStatus: t.status, createdAtText: t.createdAtText, createdBy: t.createdBy,
            timeRefText: '', timeScanText: '',
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
      return { ok: true, message: 'Đã chuyển sang Điểm danh — bắt đầu quét Giờ quét' };
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
