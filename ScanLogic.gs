/**
 * ScanLogic.gs — Logic THUẦN phân loại quét + đếm counters.
 *
 * KHÔNG gọi GAS API — test được trên Node (`node --test tests/scan-classify.test.js`).
 * ScanService.gs (wrapper GAS) gọi các hàm này sau khi lấy dữ liệu từ Database.
 *
 * Dùng hằng số STATUS/TASK_STATUS từ Config.gs (global trong GAS).
 * Để Node test chạy được, file này KHÔNG require Config — các hằng số được
 * truyền vào qua tham số `cfg` (xem chữ ký hàm).
 * Ngoại lệ DUY NHẤT: BARCODE_ID_RE (CsvUtil.gs) — global GAS; Node test standalone
 * require CsvUtil (xem scanStaff).
 */

// Regex mã barcode NV — 1 nguồn sự thật: CsvUtil.gs. KHÔNG khai báo ở top-level
// (GAS gộp mọi file vào 1 scope — khai trùng const/var cùng tên = SyntaxError lúc load).
// ScanService dùng BARCODE_ID_RE (global GAS / require CsvUtil khi test standalone).

/**
 * Phân loại 1 lần quét (2-phase attendance).
 *
 * @param {Object} cfg — { STATUS: {...}, TASK_STATUS: {...} } (từ Config.gs)
 * @param {Object} task — { taskId, status } (status: open=phase1, attend=phase2, done)
 * @param {Array<Object>} logRows — các dòng AttendanceLog của task (đã map theo LOG_COLS;
 *   mỗi row cần field listedAtEpoch / scannedAtEpoch để làm nguồn sự thật)
 * @param {string} staffId — mã NV đã normalize
 * @returns {{action: 'update'|'append'|'reject', phase: 'present'|'attend', field: 'listedAt'|'scannedAt'|null, status: string|null, reason: string|null, row: Object|null}}
 *   - phase 'present' (task.status=open): ghi THỜI ĐIỂM VÀO DANH SÁCH (LISTED_AT).
 *       update: NV trong log + chưa có LISTED_AT → ghi listedAt, status giữ PENDING.
 *       append: NV không trong log → dòng mới EXTRA + listedAt (ghi nhận có mặt, chưa điểm danh).
 *   - phase 'attend' (task.status=attend): ghi SCANNED_AT = điểm danh.
 *       update: NV trong log + chưa quét → ghi scannedAt, status PRESENT.
 *       append: NV không trong log → dòng mới EXTRA + scannedAt (Dư, có mặt + quét).
 *   - reject 'task-closed': task done (hoặc không xác định).
 *   - reject 'already-present': phase1, NV đã có LISTED_AT.
 *   - reject 'already-scanned': phase2, NV đã quét.
 */
function classifyScan(cfg, task, logRows, staffId) {
  // Phase từ task.status: open=1 (ghi LISTED_AT), attend=2 (ghi SCANNED_AT).
  const phase = task && task.status === cfg.TASK_STATUS.ATTEND ? 'attend' : 'present';
  if (!task || (task.status !== cfg.TASK_STATUS.OPEN && task.status !== cfg.TASK_STATUS.ATTEND)) {
    return { action: 'reject', phase: phase, field: null, status: null, reason: 'task-closed', row: null };
  }
  if (!staffId) {
    return { action: 'reject', phase: phase, field: null, status: null, reason: 'empty-staff-id', row: null };
  }
  const row = findLogRow(logRows, staffId);
  if (row) {
    if (phase === 'present') {
      // Đã ghi LISTED_AT cho lần 1 → không ghi lại (client cũng chặn, đây là defense).
      if (Number(row.listedAtEpoch) > 0) {
        return { action: 'reject', phase: 'present', field: null, status: null, reason: 'already-present', row: row };
      }
      // Ghi LISTED_AT, giữ status PENDING (chưa điểm danh).
      return { action: 'update', phase: 'present', field: 'listedAt', status: cfg.STATUS.PENDING, reason: null, row: row };
    }
    // phase 'attend' — chỉ quét lần 2 mới là điểm danh.
    // P2: epoch là nguồn sự thật duy nhất (khớp computeCounters) — text mất ngày.
    if (Number(row.scannedAtEpoch) > 0) {
      return { action: 'reject', phase: 'attend', field: null, status: null, reason: 'already-scanned', row: row };
    }
    // NV lạ (Dư/EXTRA từ phase1) quét lại phase2 → VẪN là Dư (EXTRA), KHÔNG đổi thành
    // Có mặt (PRESENT). Chỉ NV trong danh sách (status PENDING) quét phase2 mới = PRESENT.
    if (row.status === cfg.STATUS.EXTRA) {
      return { action: 'update', phase: 'attend', field: 'scannedAt', status: cfg.STATUS.EXTRA, reason: null, row: row };
    }
    return { action: 'update', phase: 'attend', field: 'scannedAt', status: cfg.STATUS.PRESENT, reason: null, row: row };
  }
  // NV không có trong log — phase1: append PENDING; phase2: EXTRA.
  //   phase1: append PENDING (NV tham gia, chưa điểm danh); phase2: EXTRA (ngoài danh sách).
  return {
    action: 'append', phase: phase, field: (phase === 'present' ? 'listedAt' : 'scannedAt'),
    status: phase === 'present' ? cfg.STATUS.PENDING : cfg.STATUS.EXTRA, reason: null, row: null,
  };
}

/**
 * Tìm dòng NV trong log theo staffId (staffId đã normalize trước).
 * @param {Array<Object>} logRows
 * @param {string} staffId
 * @returns {Object|null}
 */
function findLogRow(logRows, staffId) {
  if (!logRows || !staffId) return null;
  const needle = String(staffId).trim().toUpperCase();
  for (let i = 0; i < logRows.length; i++) {
    if (String(logRows[i].staffId || '').trim().toUpperCase() === needle) return logRows[i];
  }
  return null;
}

/**
 * Tính counters từ danh sách dòng log của task.
 * Quy ước (đã chốt): Đã quét = scannedAtEpoch > 0 (PRESENT + EXTRA); Vắng = pre-fill chưa quét;
 * Dư = status EXTRA.
 * 2-phase: có mặt = listedAtEpoch>0 (LISTED_AT, phase1); quét = scannedAtEpoch>0 (SCANNED_AT, phase2).
 *
 * @param {Object} cfg — { STATUS: {...} }
 * @param {Array<Object>} logRows
 * @returns {{scanned: number, absent: number, extra: number, total: number}}
 */
function computeCounters(cfg, logRows) {
  let scanned = 0;   // scannedAtEpoch>0 — điểm danh xong
  let presentAt = 0; // listedAtEpoch>0 — phase1
  let absent = 0;
  let extra = 0;
  const total = logRows ? logRows.length : 0;
  (logRows || []).forEach(function (row) {
    // P2: epoch là nguồn sự thật duy nhất (text mất ngày xuyên nửa đêm; slim cache
    // không còn field timeScan Date) — khớp hướng scanCard/restoreScanCard.
    var hasScan = Number(row.scannedAtEpoch) > 0;
    var hasRef = Number(row.listedAtEpoch) > 0;
    if (hasScan) scanned++;
    if (hasRef) presentAt++;
    if (row.status === cfg.STATUS.EXTRA) extra++;
    else if (!hasScan) absent++; // chưa quét (phase2) → Vắng khi kết thúc
  });
  return { scanned: scanned, presentAt: presentAt, absent: absent, extra: extra, total: total };
}

/**
 * applyOutcomeRow_ — overlay 1 outcome lên 1 row để tính counters (thay thế
 * computeCountersFromOutcome_). Chỉ đè field khi outcome CÓ text thật — khớp eff()
 * cũ: scannedAtEpoch/listedAtEpoch lấy từ outcome NẾU có scannedAtText/listedAtText
 * tương ứng, ngược lại giữ giá trị row. append (row=null) → lấy trực tiếp từ outcome
 * (1 trong 2 field ép theo phase). Dùng chung cho update + append.
 *
 * @param {Object|null} row — dòng log hiện hữu (null nếu append mới)
 * @param {Object} outcome — outcome từ planScanCommits (scannedAtText/listedAtText/epoch/status)
 * @returns {{scannedAtEpoch:number, listedAtEpoch:number, status:string}}
 */
function applyOutcomeRow_(row, outcome) {
  const o = outcome || {};
  return {
    scannedAtEpoch: o.scannedAtText ? o.scannedAtEpoch : Number(row ? row.scannedAtEpoch : 0),
    listedAtEpoch: o.listedAtText ? o.listedAtEpoch : Number(row ? row.listedAtEpoch : 0),
    status: o.status || (row ? row.status : o.status),
  };
}

/**
 * makeOutcome_ — gom khối literal outcome (14 field) lặp ở planScanCommits thành 1
 * helper, giữ shape response client đồng nhất (batch write + cache dùng chung).
 */
function makeOutcome_(f) {
  return {
    action: f.action,
    field: f.field,
    scannedAtText: f.scannedAtText || '',
    scannedAtEpoch: f.scannedAtEpoch || 0,
    listedAtText: f.listedAtText || '',
    listedAtEpoch: f.listedAtEpoch || 0,
    status: f.status || '',
    staffName: f.staffName || null,
    slotCode: f.slotCode || '',
    station: f.station || '',
    team: f.team || '',
    workstation: f.workstation || '',
    dateText: f.dateText || '',
    rowIndex: f.rowIndex || 0,
    staffUnknown: !!f.staffUnknown,
  };
}

/**
 * B (2026-08-12): planScanCommits — seam THUẦN gom quyết định COMMIT scan.
 * scanStaff trước đây tự viết lại 3 thứ (duplicate logic — architecture review B):
 *   1. re-check race (2 thiết bị cùng staffId trong cửa sổ cache) → append biến update/skip
 *   2. enrich append bằng staffIndex
 *   3. gom update/append thành batch
 * Hàm này nhận actions đã plan + log rows RE-CHECK (caller đọc lại sau khi giữ lock)
 * và trả đúng shape 2 helper LogRepo tiêu thụ:
 *   updates: [{rowIndex, field, time, newStatus?, keepStatus?}] → batchUpdateLogRows_
 *   appends: [11 cột theo LOG_COL_COUNT]                            → batchAppendLogRows_
 *   outcomes: {STAFFID: {action, field, listedAtText, listedAtEpoch, scannedAtText,
 *              scannedAtEpoch, status, staffName, slotCode, station, team, workstation,
 *              dateText, rowIndex}} — payload response client (scanStaff).
 *
 * Race semantics (thống nhất theo hành vi scanStaff):
 *  - append mà staffId ĐÃ có trong freshLogRows (thiết bị khác vừa ghi trong lock):
 *    + field 'scannedAt' & chưa có scannedAtEpoch → convert thành update scannedAt
 *    + field 'listedAt'  & chưa有 listedAtEpoch   → convert thành update listedAt
 *    + field đã có epoch (thiết bị khác xong phase này) → KHÔNG ghi (không đè thời gian),
 *      báo thông tin row hiện hữu.
 *
 * @param {Object} cfg — { STATUS, TASK_STATUS }
 * @param {Object} task — { taskId, status }
 * @param {Array} actions — [{ code?, action:'update'|'append', field, status, row? }]
 *   (classifyScan result — cùng shape commit)
 * @param {Array} freshLogRows — log rows RE-CHECK (slim: staffId, text, epoch, status, _rowIndex)
 * @param {Object|null} staffIndex — map STAFFID → {staffName, slotCode, station, team, workstation, date}
 * @param {Date} now
 * @param {function(Date):string} fmtTime — formatTime_ (GAS); stub trong test
 * @returns {{updates:Array, appends:Array, outcomes:Object}}
 */
function planScanCommits(cfg, task, actions, freshLogRows, staffIndex, now, fmtTime) {
  const STATUS = cfg.STATUS;
  const fmt = fmtTime || function () { return ''; };
  const num = function (v) { return Number(v) || 0; };
  const updates = [];
  const appends = [];
  const outcomes = {};
  const existingMap = {};
  (freshLogRows || []).forEach(function (r) {
    existingMap[String(r.staffId || '').trim().toUpperCase()] = r;
  });
  (actions || []).forEach(function (a) {
    const sid = String(a.code !== undefined && a.code !== null ? a.code : '').trim().toUpperCase();
    if (!sid) return;
    if (a.action === 'update' && a.row) {
      const isScan = a.field === 'scannedAt';
      // RACE defense (cùng semantics nhánh append): freshLogRows đã có epoch cho phase này
      // (thiết bị khác vừa ghi trong lock) → KHÔNG đè thời gian, báo row hiện hữu.
      const ex = existingMap[sid];
      const done = isScan ? num(ex && ex.scannedAtEpoch) : num(ex && ex.listedAtEpoch);
      if (done) {
        outcomes[sid] = makeOutcome_({
          action: 'update', field: a.field,
          scannedAtText: isScan ? (ex.scannedAtText || fmt(now)) : '',
          scannedAtEpoch: isScan ? num(ex.scannedAtEpoch) : 0,
          listedAtText: isScan ? '' : (ex.listedAtText || fmt(now)),
          listedAtEpoch: isScan ? 0 : num(ex.listedAtEpoch),
          status: ex.status || STATUS.EXTRA,
          staffName: ex.staffName, slotCode: ex.slotCode, station: ex.station,
          team: ex.team, workstation: ex.workstation, dateText: ex.dateText,
          rowIndex: ex._rowIndex,
        });
        return;
      }
      outcomes[sid] = makeOutcome_({
        action: 'update', field: a.field,
        scannedAtText: isScan ? fmt(now) : '',
        scannedAtEpoch: isScan ? now.getTime() : 0,
        listedAtText: isScan ? '' : fmt(now),
        listedAtEpoch: isScan ? 0 : now.getTime(),
        status: a.status || STATUS.EXTRA,
        staffName: a.row.staffName, slotCode: a.row.slotCode, station: a.row.station,
        team: a.row.team, workstation: a.row.workstation, dateText: a.row.dateText,
        rowIndex: a.row._rowIndex,
      });
      const u = { rowIndex: a.row._rowIndex, field: a.field, time: now, newStatus: a.status };
      // scannedAt: ghi STATUS; listedAt: chỉ LISTED_AT
      if (isScan) u.keepStatus = a.row.status;
      updates.push(u);
      return;
    }
    if (a.action === 'append') {
      const ex = existingMap[sid];
      if (ex) {
        // RACE: thiết bị khác vừa append trong lock → chỉ ghi nếu phase CHƯA hoàn thành
        if (a.field === 'scannedAt' && !num(ex.scannedAtEpoch)) {
          updates.push({ rowIndex: ex._rowIndex, field: 'scannedAt', time: now, newStatus: a.status || STATUS.EXTRA, keepStatus: ex.status });
          outcomes[sid] = makeOutcome_({
            action: 'update', field: 'scannedAt',
            scannedAtText: ex.scannedAtText || fmt(now), scannedAtEpoch: now.getTime(),
            listedAtText: '', listedAtEpoch: 0,
            status: a.status || STATUS.EXTRA,
            staffName: ex.staffName, slotCode: ex.slotCode, station: ex.station,
            team: ex.team, workstation: ex.workstation, dateText: ex.dateText,
            rowIndex: ex._rowIndex,
          });
        } else if (a.field === 'listedAt' && !num(ex.listedAtEpoch)) {
          updates.push({ rowIndex: ex._rowIndex, field: 'listedAt', time: now });
          outcomes[sid] = makeOutcome_({
            action: 'update', field: 'listedAt',
            listedAtText: ex.listedAtText || fmt(now), listedAtEpoch: now.getTime(),
            scannedAtText: '', scannedAtEpoch: 0,
            status: ex.status || STATUS.EXTRA,
            staffName: ex.staffName, slotCode: ex.slotCode, station: ex.station,
            team: ex.team, workstation: ex.workstation, dateText: ex.dateText,
            rowIndex: ex._rowIndex,
          });
        } else {
          // phase đã xong (thiết bị khác) → KHÔNG ghi, báo row hiện hữu (không đè thời gian)
          outcomes[sid] = makeOutcome_({
            action: 'update', field: a.field,
            scannedAtText: a.field === 'scannedAt' ? (ex.scannedAtText || fmt(now)) : '',
            scannedAtEpoch: a.field === 'scannedAt' ? num(ex.scannedAtEpoch) : 0,
            listedAtText: a.field === 'listedAt' ? (ex.listedAtText || fmt(now)) : '',
            listedAtEpoch: a.field === 'listedAt' ? num(ex.listedAtEpoch) : 0,
            status: ex.status || STATUS.EXTRA,
            staffName: ex.staffName, slotCode: ex.slotCode, station: ex.station,
            team: ex.team, workstation: ex.workstation, dateText: ex.dateText,
            rowIndex: ex._rowIndex,
          });
        }
        return;
      }
      // append thật — enrich staffIndex (nếu có)
      const info = staffIndex ? staffIndex[sid] : null;
      const isScan = a.field === 'scannedAt';
      appends.push([
        task.taskId, sid,
        info ? String(info.staffName || '') : '',
        info ? String(info.slotCode || '') : '',
        info ? String(info.station || '') : '',
        info ? String(info.team || '') : '',
        info ? String(info.workstation || '') : '',
        isScan ? '' : now,
        isScan ? now : '',
        a.status || STATUS.EXTRA,
        info ? String(info.date || '') : '',
      ]);
      outcomes[sid] = makeOutcome_({
        action: 'append', field: a.field,
        // staffUnknown: ma khong co trong StaffData (staffIndex co nhung khong tim thay) -
        // client canh bao (gian lan / danh may sai); staffIndex load fail → null → khong bao.
        staffUnknown: staffIndex !== null && !info,
        scannedAtText: isScan ? fmt(now) : '', scannedAtEpoch: isScan ? now.getTime() : 0,
        listedAtText: isScan ? '' : fmt(now), listedAtEpoch: isScan ? 0 : now.getTime(),
        status: a.status || STATUS.EXTRA,
        staffName: info ? info.staffName : null,
        slotCode: info ? info.slotCode : '',
        station: info ? info.station : '',
        team: info ? info.team : '',
        workstation: info ? info.workstation : '',
        dateText: info ? info.date : '',  // cột Ngày (StaffData Date) — bảng quét hiện ngay
        rowIndex: 0, // gán sau batchAppendLogRows_ (caller đối chiếu rowIndices)
      });
    }
  });
  return { updates: updates, appends: appends, outcomes: outcomes };
}

/**
 * Kiểm tra quyền quét khi task ở phase OPEN.
 * Quy tắc (A1/A3):
 * - Task không ở OPEN → cho phép (gate chỉ áp dụng phase OPEN).
 * - Admin (isEditor_) → bypass.
 * - createdBy là email hợp lệ (khác 'web', không rỗng, chứa '@') → chỉ owner (activeEmail === createdBy, case-insensitive) được quét.
 * - Ngược lại (owner không xác định: 'web', rỗng, không chứa '@') → cho phép tất cả (A1: fail-open cho task legacy).
 *
 * @param {Object} cfg — { TASK_STATUS: {...} }
 * @param {string} createdBy — email người tạo task (từ task.createdBy)
 * @param {string} activeEmail — email người đang quét (Session.getActiveUser().getEmail())
 * @param {boolean} isAdmin — true nếu là admin (isEditor_())
 * @returns {boolean} true = được quét, false = bị chặn
 */
/** Email người tạo task là owner hợp lệ (có '@', khác 'web'/'' — P2 2026-08-21, 1 nguồn). */
function isValidOwnerEmail_(createdBy) {
  const cb = String(createdBy || '').trim().toLowerCase();
  return cb.includes('@') && cb !== 'web' && cb !== '';
}

function canScanOpen_(cfg, createdBy, activeEmail, isAdmin) {
  // Gate chỉ áp dụng khi task ở phase OPEN — task status check do caller thực hiện.
  if (isAdmin) return true;
  const ae = String(activeEmail || '').trim().toLowerCase();
  if (!isValidOwnerEmail_(createdBy)) return true; // A1: owner không xác định → cho phép
  return ae === String(createdBy || '').trim().toLowerCase();
}

/**
 * Kiểm tra quyền MUTATE trạng thái chấm công (complete/reopen/updateLogRowStatus).
 * FAIL-CLOSED — khác canScanOpen_ (fail-open cho task legacy 'web' vì cần vận hành quét):
 * owner không xác định ('web'/rỗng/không '@') → CHẶN mọi mutation, chỉ admin bypass.
 * Mutation gán/reset Vắng ảnh hưởng dữ liệu chấm công nên không cho fail-open như scan.
 * @param {string} createdBy — email người tạo task
 * @param {string} activeEmail — email người đang thao tác
 * @param {boolean} isAdmin — isEditor_()
 * @returns {boolean}
 */
function canMutateTask_(createdBy, activeEmail, isAdmin) {
  if (isAdmin) return true;
  const ae = String(activeEmail || '').trim().toLowerCase();
  if (!isValidOwnerEmail_(createdBy)) return false; // fail-closed: owner không xác định → chặn mutation
  return ae === String(createdBy || '').trim().toLowerCase();
}

/**
 * matchLogsByStaff — logic THUẦN: lọc log rows theo mã NV (xuyên task) + join task meta.
 * Dùng cho tính năng search header (F-search). Server (Database.searchLogsByStaff) chỉ
 * đọc sheet rồi gọi hàm này — tránh duplicate logic, test được Node mà không cần mock sheet.
 *
 * @param {Array<Object>} logRows — toàn bộ dòng log (đã map logFromRow_: staffId, staffName,
 *   status (scan status NV), taskId, listedAtText, scannedAtText, ...).
 * @param {Array<Object>} tasks — danh sách task (taskFromRow_: taskId, station,
 *   slotCode, team, status, createdAtText, createdBy, ...). Map nhanh theo taskId.
 * @param {string} staffId — mã NV đã normalize (uppercase) để so khớp.
 * @returns {Array<Object>} — [{ taskId, staffId, staffName, status, station,
 *   team, slotCode, taskStatus, createdAtText, createdBy, listedAtText, scannedAtText }],
 *   sort Tạo lúc giảm dần, limit 200.
 */
function matchLogsByStaff(logRows, tasks, staffId) {
  if (!staffId) return [];
  const needle = String(staffId).toUpperCase();
  const taskMap = {};
  if (tasks) {
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      if (t && t.taskId != null) taskMap[String(t.taskId)] = t;
    }
  }
  const rows = logRows || [];
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    if (String(r.staffId || '').toUpperCase() !== needle) continue;
    const taskId = String(r.taskId || '').trim();
    if (!taskId) continue;
    const t = taskMap[taskId] || null;
    out.push({
      taskId: taskId,
      staffId: r.staffId,
      staffName: r.staffName || '',
      status: r.status || '',                   // scan status NV trong task (Có mặt/Vắng/Dư/-) — giữ nguyên để client quyết định có hiện không
      station: t ? t.station : '',
      team: t ? t.team : '',
      slotCode: t ? t.slotCode : '',
      taskStatus: t ? t.status : '',
      createdAtText: t ? t.createdAtText : '',
      createdBy: t ? t.createdBy : '',
      listedAtText: r.listedAtText || '',
      scannedAtText: r.scannedAtText || '',
    });
  }
  // Tạo lúc giảm dần (yyyy-MM-dd HH:mm:ss — sort chuỗi được). limit 200 bảo vệ sheet lớn.
  out.sort(function (a, b) {
    return b.createdAtText < a.createdAtText ? -1 : (b.createdAtText > a.createdAtText ? 1 : 0);
  });
  return out.slice(0, 200);
}

/**
 * matchTasksByQuery — logic THUẦN: lọc danh sách task theo mã task (prefix/contains,
 * case-insensitive). Dùng cho tìm kiếm task ở header (F-search mở rộng): người dùng nhập
 * "R202608" hoặc "2352" → trả các task khớp. KHÔNG join log — chỉ filter task meta.
 *
 * @param {Array<Object>} tasks — danh sách task (taskFromRow_ + counters, đã có từ readTaskList_).
 * @param {string} q — chuỗi tìm (đã normalize uppercase ở caller, có thể kèm space).
 * @returns {Array<Object>} — tasks khớp, giữ nguyên thứ tự (mới nhất trước), limit 50.
 */
function matchTasksByQuery(tasks, q) {
  if (!q) return [];
  const needle = String(q).trim().toUpperCase();
  if (!needle) return [];
  const out = [];
  (tasks || []).forEach(function (t) {
    if (!t || !t.taskId) return;
    if (String(t.taskId).toUpperCase().indexOf(needle) >= 0) out.push(t);
  });
  return out.slice(0, 50);
}

// ===== Node test support (GAS bỏ qua) =====
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    classifyScan: classifyScan,
    findLogRow: findLogRow,
    computeCounters: computeCounters,
    applyOutcomeRow_: applyOutcomeRow_,
    makeOutcome_: makeOutcome_,
    canScanOpen_: canScanOpen_,
    canMutateTask_: canMutateTask_,
    planScanCommits: planScanCommits,
    matchLogsByStaff: matchLogsByStaff,
    matchTasksByQuery: matchTasksByQuery,
  };
}
