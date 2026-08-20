/**
 * TaskService.gs — Nghiệp vụ task (tạo/đóng/chuyển phase) + pre-fill roster lúc tạo task.
 *
 * 2-phase attendance: tạo task → phase1 (Mở, quét LISTED_AT) → phase2 (Điểm danh,
 * quét SCANNED_AT) → Xong.
 * A3: danh sách NV nạp NGAY khi tạo task (createReconcileTask — theo ca hoặc dán mã);
 * không còn modal "Nạp danh sách" trong màn quét. Task rỗng = FREE + OPEN + log rỗng.
 * Phase 1 KHÔNG có Dư — Dư chỉ khi quét phase 2 ngoài danh sách. transitionToAttend
 * chuyển Mở→Điểm danh.
 */

/** Tạo taskId có thứ tự đọc được: R20260802-0730 (giờ tạo). */
function makeTaskId_(now) {
  const d = now || new Date();
  const pad = function (n) { return String(n).padStart(2, '0'); };
  const datePart = d.getFullYear()
    + pad(d.getMonth() + 1)
    + pad(d.getDate());
  const timePart = pad(d.getHours()) + pad(d.getMinutes());
  return 'R' + datePart + '-' + timePart;
}

/**
 * Tạo task mới (A3): nạp danh sách NV NGAY lúc tạo — 3 mode:
 *  - Theo ca: input.station (+ slotCode/team/contractType/department/date) → lọc StaffData
 *    → pre-fill dòng PENDING (LISTED_AT rỗng — thời điểm đến ghi khi NV quét phase 1).
 *  - Dán mã: input.codes (mảng mã NV) → tra staffIndex → pre-fill NV có trong dữ liệu;
 *    mã không tìm thấy bỏ qua (mã trùng trong cùng lần dán tính 1, đếm skippedCodes).
 *  - Task rỗng: không station + không codes → log rỗng, quét tự do (FREE).
 * @param {{station: string, slotCode: string|string[], team: string|string[], contractType: string|string[], department: string|string[], date: string, codes: string[], createdBy: string}} input
 * @returns {{ok: boolean, taskId: string|null, count: number, skippedCodes: number, message: string}}
 */
function createReconcileTask(input) {
  // M1 (review 2026-08-11): gate THẬT ở service layer — google.script.run gọi được global
  // trực tiếp nên gate chỉ ở *Api wrapper bị bypass. Mặc định mọi user là operator
  // (ROLES.DEFAULT, Auth.gs) → không đổi hành vi hiện tại.
  if (!requireRole_('operator')) {
    return { ok: false, message: 'Không đủ quyền (cần role operator trở lên)' };
  }
  const station = String((input && input.station) || '').trim();
  // Multi-select: slotCode/team/contractType/department có thể là mảng — task sheet chỉ có
  // 1 cột, nối ", " để lưu hiển thị; filter vẫn dùng mảng gốc (dòng NV khớp BẤT KỲ giá trị chọn).
  const slotCode = Array.isArray(input && input.slotCode)
    ? (input.slotCode).map(String).join(', ')
    : String((input && input.slotCode) || '').trim();
  const team = Array.isArray(input && input.team)
    ? (input.team).map(String).join(', ')
    : String((input && input.team) || '').trim();
  const contractType = Array.isArray(input && input.contractType)
    ? (input.contractType).map(String).join(', ')
    : String((input && input.contractType) || '').trim();
  const department = Array.isArray(input && input.department)
    ? (input.department).map(String).join(', ')
    : String((input && input.department) || '').trim();
  const filterSlots = Array.isArray(input && input.slotCode) ? input.slotCode : (slotCode ? [slotCode] : []);
  const filterTeams = Array.isArray(input && input.team) ? input.team : (team ? [team] : []);
  const filterContractTypes = Array.isArray(input && input.contractType) ? input.contractType : (contractType ? [contractType] : []);
  const filterDepartments = Array.isArray(input && input.department) ? input.department : (department ? [department] : []);
  const date = String((input && input.date) || '').trim();  // ngày vào làm (optional — lọc theo StaffData Date)
  // Dán mã: clamp 200 mã/lần (giống giới hạn paste cũ); mảng rỗng → bỏ qua.
  const codes = Array.isArray(input && input.codes)
    ? input.codes.map(function (c) { return String(c || '').trim(); }).filter(Boolean).slice(0, 200)
    : [];
  // P2-8: createdBy PHẢI từ server session — KHÔNG tin input.client (tránh giả mạo người tạo).
  // Deploy executeAs USER_DEPLOYING + access DOMAIN → getActiveUser() trả email người truy cập thật.
  const createdBy = getActiveEmail_() || 'web';

  // Task rỗng: không station + không codes → log rỗng, quét tự do.
  const noList = !station && codes.length === 0;

  const lock = LockService.getScriptLock();
  lock.waitLock(30000); // 30s — pre-fill dựng StaffData filter lâu, 10s dễ timeout khi lock bận
  try {
    let deduped = [];
    let skippedCodes = 0;
    if (station && codes.length === 0) {
      // Theo ca: lọc StaffData theo tổ hợp → pre-fill roster.
      const staffList = filterStaffByGroup(readStaffList_(), { station: station, slotCode: filterSlots, team: filterTeams, contractType: filterContractTypes, department: filterDepartments, date: date });
      // P1: Att.csv thật có NV 2 dòng trong CÙNG tổ hợp → dedupe theo staffId (giữ dòng đầu).
      // Nếu không: log 2 dòng cùng staffId → phantom absent khi kết thúc + row-key client lệch.
      deduped = dedupeStaffByGroup(staffList);
      if (!deduped.length) {
        return { ok: false, taskId: null, count: 0, skippedCodes: 0, message: UI_LABELS.CREATE_FAILED_EMPTY };
      }
    } else if (codes.length > 0) {
      // Dán mã: tra staffIndex — mã không có trong dữ liệu NV bỏ qua (skippedCodes).
      let staffIndex = [];
      try { staffIndex = readStaffIndex_() || []; } catch (e) { console.warn('readStaffIndex fail', e.message); staffIndex = []; }
      const byId = {};
      Object.keys(staffIndex).forEach(function (k) { byId[String(k).trim().toUpperCase()] = staffIndex[k]; });
      const seen = {};
      codes.forEach(function (c) {
        const key = String(c).trim().toUpperCase();
        if (seen[key]) return;
        seen[key] = true;
        const rec = byId[key];
        if (!rec) { skippedCodes++; return; }
        deduped.push(rec);
      });
      if (!deduped.length) {
        return { ok: false, taskId: null, count: 0, skippedCodes: skippedCodes, message: 'Không có mã NV nào hợp lệ trong danh sách dán' };
      }
    }

    const now = new Date();
    let taskId = makeTaskId_(now);
    // Tránh trùng taskId cùng phút — suffix số tăng dần (-2, -3, ...) thay vì -x-x
    let suffix = 2;
    while (readTask_(taskId)) {
      taskId = makeTaskId_(now) + '-' + suffix;
      suffix++;
    }

    const task = {
      taskId: taskId,
      station: station,
      // 2026-08-07: FREE không chọn Ca — tự gán SLOT_FREE_MAGIC (task sheet hiển thị Ca=Tự do).
      // Task rỗng + task dán mã (station rỗng) đều là FREE.
      slotCode: (noList || !station) ? SLOT_FREE_MAGIC : slotCode,
      team: team,
      contractType: contractType,
      // KHÔNG còn task sinh ở ATTEND — mọi task mới mở phase 1; bấm
      // "Bắt đầu điểm danh" sang phase 2 (NV ngoài danh sách quét phase 2 = Dư).
      status: TASK_STATUS.OPEN,
      createdAt: now,
      createdBy: createdBy,
      completedAt: null,
      date: date,  // ngày vào làm — pre-fill roster
    };
    // S2 (idempotency): ghi log TRƯỚC insertTask_ — batchInsert fail → không để lại task ATTEND rỗng.
    // Tình huống 2,3 (roster/dán mã): listedAt = createdAt — danh sách đã sẵn tại thời điểm tạo.
    // Tình huống 1 (noList): log rỗng, quét phase 1 mới ghi listedAt.
    const count = noList ? 0 : batchInsertLogRows_(taskId, deduped, now);
    insertTask_(task);
    audit_('createTask', taskId, { count: count, skippedCodes: skippedCodes });
    let message = 'Tạo task' + (noList ? ' quét tự do' : '') + ' thành công: ' + taskId;
    if (!noList && count > 0) {
      message = 'Đã tạo task + nạp ' + count + ' NV — ' + taskId
        + (skippedCodes ? ' (bỏ ' + skippedCodes + ' mã không có trong dữ liệu)' : '');
    }
    return { ok: true, taskId: taskId, count: count, skippedCodes: skippedCodes, message: message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Đóng task (Kết thúc) — chỉ ở phase2 (Điểm danh). Nút Kết thúc chỉ hiện ở phase2.
 * @param {string} taskId
 * @returns {{ok: boolean, message: string}}
 */
function completeTask(taskId) {
  if (!taskId) return { ok: false, message: 'Thiếu taskId' };
  // M1 (review 2026-08-11): gate THẬT ở service layer (chống bypass google.script.run gọi global).
  if (!requireRole_('operator')) {
    return { ok: false, message: 'Không đủ quyền (cần role operator trở lên)' };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const task = readTask_(taskId);
    if (!task) return { ok: false, message: 'Không tìm thấy task' };
    // Mutation gate fail-closed (canMutateTask_ — B-P1-4): đóng task gán Vắng cho NV chưa
    // quét — chỉ owner/admin; KHÔNG fail-open cho task legacy 'web' (canScanOpen_ dành vận hành).
    const isAdmin = requireRole_('admin');
    if (!canMutateTask_(task.createdBy, getActiveEmail_(), isAdmin)) {
      return { ok: false, message: UI_LABELS.SCAN_OPEN_OWNER_ONLY };
    }
    // Chỉ kết thúc khi đang ở phase2 (Điểm danh). Nếu còn Mở (phase1) → chặn.
    if (task.status === TASK_STATUS.OPEN) {
      return { ok: false, message: UI_LABELS.COMPLETE_BLOCKED };
    }
    if (task.status !== TASK_STATUS.ATTEND) {
      return { ok: false, message: 'Task đã kết thúc' };
    }
    // VALIDATE: scanned + absent = total — data inconsistency cần fix trước khi đóng.
    // Partition invariant: scanned counts every row that was ever scanned (PRESENT and EXTRA
    // both carry SCANNED_AT); absent counts the rest - so scanned+absent = total. Do NOT add
    // extra again: a scanned EXTRA row is already inside scanned -> double-count makes the
    // invariant fail and the task becomes unclosable.
    const logRows = readLogRows_(taskId);
    const counters = computeCounters({ STATUS: STATUS }, logRows);
    if (counters.scanned + counters.absent !== counters.total) {
      if (!isAdmin) {
        console.error({ bench: 'completeTask', taskId: taskId, counters: counters, error: 'counter-mismatch' });
        return {
          ok: false,
          message: 'Lỗi dữ liệu: scanned + absent ≠ total (' + counters.scanned + '+' + counters.absent + ' ≠ ' + counters.total + '). Vui lòng báo admin.',
        };
      }
      // Admin force-close (escape hatch): counter lech (sua tay sheet / bug) van cho admin
      // chot task - markUnscannedAbsent_ xu ly PENDING binh thuong ben duoi; audit ly do.
      console.warn({ bench: 'completeTask', taskId: taskId, counters: counters, error: 'counter-mismatch-force-closed' });
      audit_('completeTaskForceClose', taskId, { counters: counters });
    }
    // P1 (audit): markUnscannedAbsent_ TRƯỚC, updateTaskStatus_(DONE) SAU — fail-safe.
    // Nếu mark fail (quota/timeout): task vẫn ATTEND → user retry được.
    // Nếu updateTaskStatus_ fail: task vẫn ATTEND → retry, mark idempotent (dòng đã
    // ABSENT/PRESENT không chạm lại). Thứ tự cũ (DONE trước) → mark fail = task đã
    // đóng nhưng log chưa chuyển Vắng, retry bị chặn "Task đã kết thúc".
    const absentCount = markUnscannedAbsent_(taskId);
    updateTaskStatus_(taskId, TASK_STATUS.DONE, new Date(), task._rowIndex, task.contractType || '');
    audit_('completeTask', taskId, { absentCount: absentCount, counters: counters });
    return {
      ok: true,
      message: 'Đã kết thúc task ' + taskId + (absentCount > 0 ? ' — ' + absentCount + ' NV chưa quét đánh dấu Vắng' : ''),
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Chuyển task từ phase1 (Mở) sang phase2 (Điểm danh).
 * Mở nút "Kết thúc". Sau bước này, quét sẽ ghi SCANNED_AT (TIME_SCAN) thay vì LISTED_AT.
 * Không sửa log — NV đã có LISTED_AT giữ nguyên; NV quét tiếp theo (lần 2) ghi SCANNED_AT.
 * @param {string} taskId
 * @returns {{ok: boolean, message: string}}
 */
function transitionToAttend(taskId) {
  if (!taskId) return { ok: false, message: 'Thiếu taskId' };
  // M1 (review 2026-08-11): gate THẬT ở service layer (chống bypass google.script.run gọi global).
  if (!requireRole_('operator')) {
    return { ok: false, message: 'Không đủ quyền (cần role operator trở lên)' };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const task = readTask_(taskId);
    if (!task) return { ok: false, message: 'Không tìm thấy task' };
    if (task.status !== TASK_STATUS.OPEN) {
      return { ok: false, message: UI_LABELS.TRANSITION_BLOCKED };
    }
    // Owner-gate (M1): chuyển OPEN→ATTEND mở khoá quét phase 2 cho MỌI NGƯỜI (không còn
    // giới hạn owner) → chỉ owner/admin được phép, đồng gate scanStaff.
    // Thiếu gate này: non-owner gọi thẳng transitionToAttendApi qua console để vô hiệu
    // owner-gate phase Mở rồi quét thoải mái (owner-gate chỉ là khoá cửa trước).
    const isAdmin = requireRole_('admin');
    if (!canScanOpen_({ TASK_STATUS: TASK_STATUS }, task.createdBy, getActiveEmail_(), isAdmin)) {
      return { ok: false, message: UI_LABELS.SCAN_OPEN_OWNER_ONLY };
    }
    updateTaskStatus_(taskId, TASK_STATUS.ATTEND, null, task._rowIndex, task.contractType || '');
    audit_('transitionToAttend', taskId, {});
    return { ok: true, message: 'Đã chuyển sang Điểm danh — bắt đầu điểm danh' };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Mở lại task đã đóng (Reopen) — cho phép quét tiếp.
 * Reset NV bị đánh Vắng (ABSENT) về Chưa điểm danh (PENDING) để quét lại;
 * NV đã Có mặt giữ nguyên timeScan/status (không reset).
 * @param {string} taskId
 * @returns {{ok: boolean, message: string}}
 */
function reopenTask(taskId) {
  if (!taskId) return { ok: false, message: 'Thiếu taskId' };
  // M1 (review 2026-08-11): gate THẬT ở service layer (chống bypass google.script.run gọi global).
  if (!requireRole_('operator')) {
    return { ok: false, message: 'Không đủ quyền (cần role operator trở lên)' };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const task = readTask_(taskId);
    if (!task) return { ok: false, message: 'Không tìm thấy task' };
    // Mutation gate fail-closed (canMutateTask_ — B-P1-4): mở lại reset ABSENT→PENDING —
    // chỉ owner/admin; KHÔNG fail-open cho task legacy 'web'.
    const isAdmin = requireRole_('admin');
    if (!canMutateTask_(task.createdBy, getActiveEmail_(), isAdmin)) {
      return { ok: false, message: UI_LABELS.SCAN_OPEN_OWNER_ONLY };
    }
    if (task.status !== TASK_STATUS.DONE) {
      return { ok: false, message: 'Task đang mở — không cần mở lại' };
    }
    // Reset Vắng → Chưa điểm danh TRƯỚC (batch 1 lần), sau đó mở status task.
    // Thứ tự fail-safe giống completeTask: reset fail → task vẫn DONE, retry được.
    const resetCount = resetAbsentToPending_(taskId);
    // F4: mở lại → Điểm danh (phase2, ghi SCANNED_AT) để quét tiếp luôn — KHÔNG về OPEN.
    updateTaskStatus_(taskId, TASK_STATUS.ATTEND, null, task._rowIndex, task.contractType || '');
    audit_('reopenTask', taskId, { resetCount: resetCount });
    return {
      ok: true,
      message: 'Đã mở lại task ' + taskId + (resetCount > 0 ? ' — ' + resetCount + ' NV Vắng được đặt lại Chưa điểm danh' : ''),
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Hủy task đang Mở (OPEN) với log RỖNG — xóa hẳn task khỏi AttendanceTask (tạo nhầm / bỏ dở).
 * KHÔNG cho hủy khi đã có dữ liệu quét — phải Bắt đầu điểm danh → Chốt ca bình thường.
 * Gate: operator + OPEN + canMutateTask_ (owner/admin — fail-closed như complete/reopen).
 * @param {string} taskId
 * @returns {{ok: boolean, message: string}}
 */
function cancelTask(taskId) {
  if (!taskId) return { ok: false, message: 'Thiếu taskId' };
  // M1 (review 2026-08-11): gate THẬT ở service layer — google.script.run gọi được global
  // trực tiếp nên gate chỉ ở *Api wrapper bị bypass.
  if (!requireRole_('operator')) {
    return { ok: false, message: 'Không đủ quyền (cần role operator trở lên)' };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const task = readTask_(taskId);
    if (!task) return { ok: false, message: 'Không tìm thấy task' };
    if (task.status !== TASK_STATUS.OPEN) {
      return { ok: false, message: 'Chỉ hủy được task đang ở phase Mở' };
    }
    const isAdmin = requireRole_('admin');
    if (!canMutateTask_(task.createdBy, getActiveEmail_(), isAdmin)) {
      return { ok: false, message: UI_LABELS.SCAN_OPEN_OWNER_ONLY };
    }
    // An toàn: chỉ xóa dòng task khi log RỖNG — có dữ liệu quét thì phải Kết thúc bình thường.
    if (readLogRows_(taskId).length > 0) {
      return { ok: false, message: 'Task đã có dữ liệu quét — không hủy được. Hãy Bắt đầu điểm danh rồi Chốt ca.' };
    }
    getSheet_(SHEETS.ATTENDANCE_TASK).deleteRow(task._rowIndex);
    invalidateTaskCaches_(taskId);
    audit_('cancelTask', taskId, {});
    return { ok: true, message: 'Đã hủy task ' + taskId };
  } finally {
    lock.releaseLock();
  }
}

/** Lấy danh sách task (cho getTaskList API). */
function listTasks() {
  return readTaskList_();
}

/** Lấy chi tiết task + toàn bộ log (cho getTaskDetail API) — có cache 15s. */
function getTaskDetail(taskId) {
  if (!taskId) return detailError_('Thiếu taskId');
  const detail = readTaskDetailCached_(taskId);
  if (!detail || !detail.task) return detailError_('Không tìm thấy task');
  // T-1: Tính permission tươi cho user đang đọc — KHÔNG lưu vào cache (cache 15s dùng chung mọi user).
  const activeEmail = getActiveEmail_();
  const isAdmin = requireRole_('admin');
  const isOwner = String(detail.task.createdBy || '').trim().toLowerCase() === String(activeEmail || '').trim().toLowerCase()
    && String(detail.task.createdBy || '').trim().toLowerCase() !== 'web'
    && String(detail.task.createdBy || '').trim().includes('@');
  const canScanOpen = canScanOpen_({ TASK_STATUS: TASK_STATUS }, detail.task.createdBy, activeEmail, isAdmin);
  detail.task.permission = { isAdmin: isAdmin, isOwner: isOwner, canScanOpen: canScanOpen };
  return { ok: true, task: detail.task, log: detail.log, counters: detail.counters };
}

/** F: object lỗi dùng chung cho getTaskDetail. */
function detailError_(message) {
  return { ok: false, message: message, task: null, log: [] };
}

/**
 * Sua trang thai 1 dong log theo staffId (fix thu cong — owner/admin, co audit).
 * Dung cho: chuyen Du -> Co mat, sua Vang nham, bo sung nguoi vao danh sach.
 * newStatus PRESENT tren dong chua quet (scannedAtEpoch=0) → ghi kem TIME_SCAN=now
 * (giu invariant scanned+absent=total); cac status khac chi doi STATUS.
 * @param {string} taskId
 * @param {string} rawStaffId — ma NV (normalize trong ham)
 * @param {string} newStatus — PENDING/PRESENT/ABSENT/EXTRA (STATUS)
 * @returns {{ok: boolean, message: string, counters: Object|null}}
 */
function updateLogRowStatus(taskId, rawStaffId, newStatus) {
  if (!taskId || !rawStaffId) return { ok: false, message: 'Thiếu taskId hoặc mã NV', counters: null };
  // M1 (review): gate THẬT ở service layer — google.script.run gọi được global trực tiếp.
  if (!requireRole_('operator')) {
    return { ok: false, message: 'Không đủ quyền (cần role operator trở lên)', counters: null };
  }
  const allowed = [STATUS.PENDING, STATUS.PRESENT, STATUS.ABSENT, STATUS.EXTRA];
  if (allowed.indexOf(newStatus) === -1) {
    return { ok: false, message: 'Trạng thái không hợp lệ', counters: null };
  }
  // DEFENSE: bọc toàn bộ logic — mọi lỗi trả ok:false thay vì ném ra client.
  try {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const task = readTask_(taskId);
      if (!task) return { ok: false, message: 'Không tìm thấy task', counters: null };
      // Mutation dữ liệu chấm công → owner/admin (fail-closed canMutateTask_ — cùng gate
      // completeTask/reopenTask; KHÔNG fail-open cho task legacy 'web').
      const isAdmin = requireRole_('admin');
      if (!canMutateTask_(task.createdBy, getActiveEmail_(), isAdmin)) {
        return { ok: false, message: UI_LABELS.SCAN_OPEN_OWNER_ONLY, counters: null };
      }
      const staffId = normalizeStaffId(rawStaffId);
      const rows = readLogRows_(taskId);
      const row = findLogRow(rows, staffId);
      if (!row) return { ok: false, message: 'Không tìm thấy NV trong task', counters: null };
      if (row.status === newStatus) {
        return { ok: false, message: 'NV đã ở trạng thái này', counters: null };
      }
      // L1 (review): doi nguoc PRESENT→ABSENT/PENDING phai clear SCANNED_AT — computeCounters
      // dem scanned theo scannedAtEpoch>0; giu nguyen → dong Vang van tinh 'da diem danh'
      // (scanned sai, absent thieu). Ve PENDING → clear luon LISTED_AT (reset ve chua den).
      // EXTRA KHONG clear: giu SCANNED_AT theo thiet ke (completeTask partition
      // scanned+absent=total — EXTRA chua quet se pha invariant).
      // #7 (review 2026-08-19): clearListed DOC LAP voi clearScanned — ABSENT→PENDING
      // (khong co scan) truoc day LISTED_AT con → dong PENDING van nam trong filter
      // 'Da den (chua quet lan 2)'. PENDING = chua den → xoa LISTED_AT bat ky nguon nao.
      const hasScan = Number(row.scannedAtEpoch) > 0;
      const clearScanned = hasScan && (newStatus === STATUS.ABSENT || newStatus === STATUS.PENDING);
      const clearListed = newStatus === STATUS.PENDING;
      // B-P1-2: EXTRA trên dòng CHƯA quét cũng fill TIME_SCAN — partition invariant
      // scanned+absent=total (EXTRA không scan → computeCounters đếm extra, absent thiếu
      // → completeTask chặn "counter-mismatch", task kẹt không đóng được).
      const scanTime = ((newStatus === STATUS.PRESENT || newStatus === STATUS.EXTRA) && !hasScan) ? new Date() : null;
      setLogRowStatus_(taskId, row._rowIndex, newStatus, scanTime, clearScanned, clearListed);
      audit_('fixLogRowStatus', taskId, { staffId: staffId, oldStatus: row.status, newStatus: newStatus, fillScanTime: !!scanTime, clearScanTime: clearScanned, clearListedAt: clearListed });
      const counters = computeCounters({ STATUS: STATUS }, readLogRowsCached_(taskId));
      return { ok: true, message: 'Đã cập nhật ' + staffId + ' → ' + newStatus, counters: counters };
    } finally {
      lock.releaseLock();
    }
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : 'updateLogRowStatus fail', counters: null };
  }
}
