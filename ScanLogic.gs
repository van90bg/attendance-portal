/**
 * ScanLogic.gs — Logic THUẦN phân loại quét + đếm counters.
 *
 * KHÔNG gọi GAS API — test được trên Node (`node --test tests/scan-classify.test.js`).
 * ScanService.gs (wrapper GAS) gọi các hàm này sau khi lấy dữ liệu từ Database.
 *
 * Dùng hằng số STATUS/TASK_STATUS từ Config.gs (global trong GAS).
 * Để Node test chạy được, file này KHÔNG require Config — các hằng số được
 * truyền vào qua tham số `cfg` (xem chữ ký hàm).
 */

/**
 * Phân loại 1 lần quét (2-phase attendance).
 *
 * @param {Object} cfg — { STATUS: {...}, TASK_STATUS: {...} } (từ Config.gs)
 * @param {Object} task — { taskId, status } (status: open=phase1, attend=phase2, done)
 * @param {Array<Object>} logRows — các dòng AttendanceLog của task (đã map theo LOG_COLS;
 *   mỗi row cần field timeRefEpoch / timeScanEpoch để làm nguồn sự thật)
 * @param {string} staffId — mã NV đã normalize
 * @returns {{action: 'update'|'append'|'reject', phase: 'present'|'attend', field: 'timeRef'|'timeScan'|null, status: string|null, reason: string|null, row: Object|null}}
 *   - phase 'present' (task.status=open): ghi GIỜ CÓ MẶT (TIME_REF).
 *       update: NV trong log + chưa có Giờ có mặt → ghi timeRef, status giữ PENDING.
 *       append: NV không trong log → dòng mới EXTRA + timeRef (ghi nhận có mặt, chưa điểm danh).
 *   - phase 'attend' (task.status=attend): ghi GIỜ QUÉT (TIME_SCAN) = điểm danh.
 *       update: NV trong log + chưa quét → ghi timeScan, status PRESENT.
 *       append: NV không trong log → dòng mới EXTRA + timeScan (Dư, có mặt + quét).
 *   - reject 'task-closed': task done (hoặc không xác định).
 *   - reject 'already-present': phase1, NV đã có Giờ có mặt.
 *   - reject 'already-scanned': phase2, NV đã quét.
 */
function classifyScan(cfg, task, logRows, staffId) {
  // Phase từ task.status: open=1 (ghi Giờ có mặt), attend=2 (ghi Giờ quét).
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
      // Đã ghi Giờ có mặt cho lần 1 → không ghi lại (client cũng chặn, đây là defense).
      if (Number(row.timeRefEpoch) > 0) {
        return { action: 'reject', phase: 'present', field: null, status: null, reason: 'already-present', row: row };
      }
      // Ghi Giờ có mặt (TIME_REF), giữ status PENDING (chưa điểm danh).
      return { action: 'update', phase: 'present', field: 'timeRef', status: cfg.STATUS.PENDING, reason: null, row: row };
    }
    // phase 'attend' — chỉ quét lần 2 mới là điểm danh.
    // P2: epoch là nguồn sự thật duy nhất (khớp computeCounters) — text mất ngày.
    if (Number(row.timeScanEpoch) > 0) {
      return { action: 'reject', phase: 'attend', field: null, status: null, reason: 'already-scanned', row: row };
    }
    return { action: 'update', phase: 'attend', field: 'timeScan', status: cfg.STATUS.PRESENT, reason: null, row: row };
      }
      // NV không có trong log.
      // - Roster (taskType != 'free'): NV quét lạ là Dư (EXTRA) — ghi nhận ngoài danh sách chốt.
      //   phase1 Giờ có mặt, phase2 Giờ quét.
      // - Quét tự do (taskType FREE / noList): KHÔNG có danh sách chốt → NV lạ là hợp lệ,
      //   KHÔNG phải Dư. Quét đầu (phase1) = PENDING (chưa điểm danh), phase2 = PRESENT.
      //   (Fix Dư sai 2026-08-05)
      const isFree = task && task.taskType === cfg.TASK_TYPE.FREE;
      if (isFree) {
        return {
          action: 'append', phase: phase, field: (phase === 'present' ? 'timeRef' : 'timeScan'),
          status: phase === 'present' ? cfg.STATUS.PENDING : cfg.STATUS.PRESENT, reason: null, row: null,
        };
      }
      if (phase === 'present') {
        return { action: 'append', phase: 'present', field: 'timeRef', status: cfg.STATUS.EXTRA, reason: null, row: null };
      }
      return { action: 'append', phase: 'attend', field: 'timeScan', status: cfg.STATUS.EXTRA, reason: null, row: null };
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
 * Quy ước (đã chốt): Đã quét = timeScanEpoch > 0 (PRESENT + EXTRA); Vắng = pre-fill chưa quét;
 * Dư = status EXTRA.
 * 2-phase: có mặt = timeRefEpoch>0 (Giờ có mặt, phase1); quét = timeScanEpoch>0 (Giờ quét, phase2).
 *
 * @param {Object} cfg — { STATUS: {...} }
 * @param {Array<Object>} logRows
 * @returns {{scanned: number, presentAt: number, absent: number, extra: number, total: number}}
 */
function computeCounters(cfg, logRows) {
  let scanned = 0;   // Giờ quét có (timeScanEpoch>0) — điểm danh xong
  let presentAt = 0; // Giờ có mặt có (timeRefEpoch>0) — đã quét lần 1
  let absent = 0;
  let extra = 0;
  const total = logRows ? logRows.length : 0;
  (logRows || []).forEach(function (row) {
    // P2: epoch là nguồn sự thật duy nhất (text mất ngày xuyên nửa đêm; slim cache
    // không còn field timeScan Date) — khớp hướng scanCard/restoreScanCard.
    var hasScan = Number(row.timeScanEpoch) > 0;
    var hasRef = Number(row.timeRefEpoch) > 0;
    if (hasScan) scanned++;
    if (hasRef) presentAt++;
    if (row.status === cfg.STATUS.EXTRA) extra++;
    else if (!hasScan) absent++; // chưa quét (phase2) → Vắng khi kết thúc
  });
  return { scanned: scanned, presentAt: presentAt, absent: absent, extra: extra, total: total };
}

/**
 * Tạo dòng mới cho NV quét lạ (append) — dùng dữ liệu từ staffIndex nếu có.
 * @param {Object} cfg — { STATUS: {...} }
 * @param {string} taskId
 * @param {string} staffId
 * @param {Object|null} staffInfo — từ staffIndex (có thể null nếu không tìm thấy)
 * @param {Date} now
 * @param {string} field — 'timeRef' (phase1: Giờ có mặt) | 'timeScan' (phase2: Giờ quét)
 * @param {string} status — status ghi cho dòng (mặc định EXTRA để roster lạ = Dư).
 *   noList QUÉT ĐẦU (phase1) truyền PENDING (Chưa điểm danh) — NV lạ chưa có
 *   Giờ quét nên KHÔNG gán Dư; chỉ phase2 (có Giờ quét) mới PRESENT. (Fix #3)
 * @returns {Object} row theo LOG_COLS
 */
function buildExtraRow(cfg, taskId, staffId, staffInfo, now, field, status) {
  var timeRef = null, timeScan = null, timeRefEpoch = 0, timeScanEpoch = 0;
  if (field === 'timeScan') {
    timeScan = now; timeScanEpoch = now ? now.getTime() : 0;
  } else {
    // mặc định phase1: ghi Giờ có mặt
    timeRef = now; timeRefEpoch = now ? now.getTime() : 0;
  }
  return {
    taskId: taskId,
    staffId: staffId,
    staffName: staffInfo ? staffInfo.staffName : '',
    slotCode: staffInfo ? staffInfo.slotCode : '',
    station: staffInfo ? staffInfo.station : '',
    team: staffInfo ? staffInfo.team : '',
    workstation: staffInfo ? staffInfo.workstation : '',
    timeRef: timeRef,
    timeScan: timeScan,
    timeRefEpoch: timeRefEpoch,
    // append phase2 cũng phải set timeScanEpoch (nguồn sự thật counters/sort).
    timeScanEpoch: timeScanEpoch,
    date: '',  // NV quét lạ không có trong StaffData → không có ngày vào làm
    // status do caller truyền (mặc định EXTRA giữ behaviour roster lạ = Dư);
    // noList quét đầu (phase1) truyền PENDING — Fix #3.
    status: status || cfg.STATUS.EXTRA,
  };
}

// ===== Node test support (GAS bỏ qua) =====
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    classifyScan: classifyScan,
    findLogRow: findLogRow,
    computeCounters: computeCounters,
    buildExtraRow: buildExtraRow,
  };
}
