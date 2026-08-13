/**
 * TaskService.gs — Nghiệp vụ task (tạo/đóng/chuyển phase) + pre-fill log.
 *
 * 2-phase attendance: tạo task → phase1 (Mở, quét Giờ có mặt) → phase2 (Điểm danh,
 * quét Giờ quét) → Xong.
 * - Có list: pre-fill log, TIME_REF = giờ tạo task (Giờ có mặt cho mọi NV).
 * - Không list: log rỗng; quét lần 1 ghi TIME_REF (Giờ có mặt) + dòng Dư.
 * transitionToAttend chuyển Mở→Điểm danh (mở nút Kết thúc). completeTask chỉ ở phase2.
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
 * Tạo task đối chiếu (reconcile) + pre-fill log.
 * @param {{station: string, slotCode: string, team: string, createdBy: string}} input
 * @returns {{ok: boolean, taskId: string|null, count: number, message: string}}
 */
function createReconcileTask(input) {
  // M1 (review 2026-08-11): gate THẬT ở service layer — google.script.run gọi được global
  // trực tiếp nên gate chỉ ở *Api wrapper bị bypass. Mặc định mọi user là operator
  // (ROLES.DEFAULT, Auth.gs) → không đổi hành vi hiện tại.
  if (!requireRole_('operator')) {
    return { ok: false, message: 'Không đủ quyền (cần role operator trở lên)' };
  }
  const station = String((input && input.station) || '').trim();
  // noList: quét tự do KHÔNG danh sách (luồng vận hành quét 2 lần không cần roster).
  // Khi bật, bỏ qua validate group + KHÔNG pre-fill log → mọi quét là Dư (phase1 ghi
  // Giờ có mặt, phase2 ghi Giờ quét). Task vẫn Mở (phase1) như bình thường.
  // Commit 2026-08-08: slotCode='Tự do' (magic trong dropdown Ca) tự quyết FREE.
  // isFreeSlotSelection_ fail-safe: ['Tự do','X'] → false → đi reconcile path
  // (filter không khớp → CREATE_FAILED_EMPTY). Giữ (input.noList) cũ cho tương thích.
  const noList = isFreeSlotSelection_(input && input.slotCode) || !!(input && input.noList);
  // Multi-select: slotCode/team có thể là mảng (từ modal) — task sheet chỉ có 1 cột,
  // nối ", " để lưu hiển thị; filter vẫn dùng mảng gốc (dòng NV khớp BẤT KỲ team/slot chọn).
  const slotCode = Array.isArray(input && input.slotCode)
    ? (input.slotCode).map(String).join(', ')
    : String((input && input.slotCode) || '').trim();
  const team = Array.isArray(input && input.team)
    ? (input.team).map(String).join(', ')
    : String((input && input.team) || '').trim();
  const contractType = Array.isArray(input && input.contractType)
    ? (input.contractType).map(String).join(', ')
    : String((input && input.contractType) || '').trim();
  const filterSlots = Array.isArray(input && input.slotCode) ? input.slotCode : (slotCode ? [slotCode] : []);
  const filterTeams = Array.isArray(input && input.team) ? input.team : (team ? [team] : []);
  const filterContractTypes = Array.isArray(input && input.contractType) ? input.contractType : (contractType ? [contractType] : []);
  const date = String((input && input.date) || '').trim();  // ngày vào làm (optional — lọc theo StaffData Date)
  // P2-8: createdBy PHẢI từ server session — KHÔNG tin input.client (tránh giả mạo người tạo).
  // Deploy executeAs USER_DEPLOYING + access DOMAIN → getActiveUser() trả email người truy cập thật.
  const createdBy = getActiveEmail_() || 'web';

  // 2026-08-07: CẢ 2 luồng (reconcile + FREE) đều cần station.
  // Reconcile thêm slotCode; FREE tự gán slotCode='Tự do' (xem build task dưới).
  // 2026-08-11: team/slot RỖNG hợp lệ = 'Tất cả' (không lọc) — filterStaffByGroup bỏ lọc
  // khi mảng rỗng; guard deduped.length dưới vẫn chặn task 0 NV. Station luôn bắt buộc.
  if (!station) {
    return { ok: false, taskId: null, count: 0, message: 'Thiếu station' };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // noList: KHÔNG đọc StaffData, log rỗng — mọi quét sau là Dư (phase1 Giờ có mặt,
    // phase2 Giờ quét). Dùng trực tiếp staffList rỗng để skip filter + dedupe + guard.
    let deduped = [];
    if (!noList) {
      const staffList = filterStaffByGroup(readStaffList_(), { station: station, slotCode: filterSlots, team: filterTeams, contractType: filterContractTypes, date: date });
      // P1: Att.csv thật có NV 2 dòng trong CÙNG tổ hợp → dedupe theo staffId (giữ dòng đầu).
      // Nếu không: log 2 dòng cùng staffId → phantom absent khi kết thúc + row-key client lệch.
      deduped = dedupeStaffByGroup(staffList);
      if (!deduped.length) {
        return { ok: false, taskId: null, count: 0, message: UI_LABELS.CREATE_FAILED_EMPTY };
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
      // noList (Quét tự do) dùng taskType FREE để classifyScan nhận biết:
      // NV lạ quét đầu (phase1) ghi PENDING (chưa điểm danh), KHÔNG Dư.
      taskType: noList ? TASK_TYPE.FREE : TASK_TYPE.RECONCILE,
      station: station,
      // 2026-08-07: FREE không chọn Ca — tự gán SLOT_FREE_MAGIC (task sheet hiển thị Ca=Tự do).
      slotCode: noList ? SLOT_FREE_MAGIC : slotCode,
      team: team,
      contractType: contractType,
      // 2.10: RECONCILE (có list pre-fill) tạo task vào thẳng phase2 (attend) — KHÔNG
      // cần bấm "Chuyển điểm danh" thủ công (danh sách đã có sẵn → quét NV ngoài list = Dư).
      // FREE (noList) vẫn mở phase1 (open) — cần scan phase1 để xây danh sách rồi mới chuyển attend.
      status: noList ? TASK_STATUS.OPEN : TASK_STATUS.ATTEND,
      createdAt: now,
      createdBy: createdBy,
      completedAt: null,
    };
    insertTask_(task);
    // TIME_REF = Giờ có mặt (breaking 2026-08-05): pre-fill ghi ngay giờ tạo task
    // cho mọi NV trong list. Khác v1 (pre-fill time = taskCreated rỗng).
    const count = noList ? 0 : batchInsertLogRows_(taskId, deduped, now);

    return { ok: true, taskId: taskId, count: count, message: 'Tạo task' + (noList ? ' quét tự do' : '') + ' thành công: ' + taskId };
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
    // Chỉ kết thúc khi đang ở phase2 (Điểm danh). Nếu còn Mở (phase1) → chặn.
    if (task.status === TASK_STATUS.OPEN) {
      return { ok: false, message: UI_LABELS.COMPLETE_BLOCKED };
    }
    if (task.status !== TASK_STATUS.ATTEND) {
      return { ok: false, message: 'Task đã kết thúc' };
    }
    // P1 (audit): markUnscannedAbsent_ TRƯỚC, updateTaskStatus_(DONE) SAU — fail-safe.
    // Nếu mark fail (quota/timeout): task vẫn ATTEND → user retry được.
    // Nếu updateTaskStatus_ fail: task vẫn ATTEND → retry, mark idempotent (dòng đã
    // ABSENT/PRESENT không chạm lại). Thứ tự cũ (DONE trước) → mark fail = task đã
    // đóng nhưng log chưa chuyển Vắng, retry bị chặn "Task đã kết thúc".
    const absentCount = markUnscannedAbsent_(taskId);
    updateTaskStatus_(taskId, TASK_STATUS.DONE, new Date(), task._rowIndex, task.contractType || '');
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
 * Mở nút "Kết thúc". Sau bước này, quét sẽ ghi Giờ quét (TIME_SCAN) thay vì Giờ có mặt.
 * Không sửa log — NV đã có Giờ có mặt giữ nguyên; NV quét tiếp theo (lần 2) ghi Giờ quét.
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
    updateTaskStatus_(taskId, TASK_STATUS.ATTEND, null, task._rowIndex, task.contractType || '');
    return { ok: true, message: 'Đã chuyển sang Điểm danh — bắt đầu quét Giờ quét' };
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
    if (task.status !== TASK_STATUS.DONE) {
      return { ok: false, message: 'Task đang mở — không cần mở lại' };
    }
    // Reset Vắng → Chưa điểm danh TRƯỚC (batch 1 lần), sau đó mở status task.
    // Thứ tự fail-safe giống completeTask: reset fail → task vẫn DONE, retry được.
    const resetCount = resetAbsentToPending_(taskId);
    // F4: mở lại → Điểm danh (phase2, ghi Giờ quét) để quét tiếp luôn — KHÔNG về OPEN.
    updateTaskStatus_(taskId, TASK_STATUS.ATTEND, null, task._rowIndex, task.contractType || '');
    return {
      ok: true,
      message: 'Đã mở lại task ' + taskId + (resetCount > 0 ? ' — ' + resetCount + ' NV Vắng được đặt lại Chưa điểm danh' : ''),
    };
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
  const isAdmin = isEditor_();
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
