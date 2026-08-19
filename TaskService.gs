/**
 * TaskService.gs — Nghiệp vụ task (tạo/đóng/chuyển phase) + nạp roster (pre-fill log qua loadRoster).
 *
 * 2-phase attendance: tạo task → phase1 (Mở, quét LISTED_AT) → phase2 (Điểm danh,
 * quét SCANNED_AT) → Xong.
 * A2 (docs/roster-load-design.md): mọi task mới = FREE + OPEN (phase 1) + log RỖNG —
 * KHÔNG pre-fill roster khi tạo (kể cả khi client gửi ca thật); danh sách nạp sau qua
 * loadRosterApi (nút "Lấy danh sách theo ca" trong màn quét). Phase 1 KHÔNG có Dư —
 * Dư chỉ khi quét phase 2 ngoài danh sách. transitionToAttend chuyển Mở→Điểm danh.
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
 * Tạo task mới (A2): luôn FREE + OPEN (phase 1) + log RỖNG — KHÔNG pre-fill roster khi
 * tạo (slotCode client gửi bị ép 'Tự do'). Roster nạp sau qua loadRosterApi ("Lấy danh
 * sách theo ca" trong màn quét). Legacy task 'reconcile' cũ không còn được tạo mới.
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
  // A2 (2026-08-18): task mới LUÔN quét tự do — KHÔNG pre-fill roster khi tạo, bất kể
  // slotCode client gửi (ca thật cũng bị bỏ — trước đây modal chỉ Station + Ngày mà
  // SEL.slots rỗng → isFreeSel() false → nạp nhầm cả station vào roster).
  // Nạp danh sách sau qua loadRosterApi (nút "Lấy danh sách theo ca" trong màn quét).
  // Nhánh pre-fill bên dưới chỉ còn là legacy path — noList luôn true nên không chạy.
  const noList = true;
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

  // A2: Station không bắt buộc khi tạo task (modal chỉ còn nút Tạo — Station/Ca/Team/Date
  // nạp sau qua loadRosterApi). noList=true → guard deduped.length bỏ qua (luôn 0 dòng).

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // noList: KHÔNG đọc StaffData, log rỗng — mọi quét sau là Dư (phase1 LISTED_AT,
    // phase2 SCANNED_AT). Dùng trực tiếp staffList rỗng để skip filter + dedupe + guard.
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
      station: station,
      // 2026-08-07: FREE không chọn Ca — tự gán SLOT_FREE_MAGIC (task sheet hiển thị Ca=Tự do).
      slotCode: noList ? SLOT_FREE_MAGIC : slotCode,
      team: team,
      contractType: contractType,
      // A2: KHÔNG còn task sinh ở ATTEND — mọi task mới mở phase 1 log rỗng; bấm
      // "Chuyển điểm danh" sang phase 2 (NV ngoài danh sách quét phase 2 = Dư).
      status: TASK_STATUS.OPEN,
      createdAt: now,
      createdBy: createdBy,
      completedAt: null,
      date: date,  // ngày vào làm — pre-fill roster modal
    };
    // Legacy pre-fill (A1 — KHÔNG chạy từ A2 vì noList luôn true): TIME_REF = LISTED_AT
    // ghi ngay giờ tạo task cho mọi NV trong list. S2 (idempotency): ghi log TRƯỚC
    // insertTask_ — batchInsert fail → không để lại task ATTEND rỗng.
    const count = noList ? 0 : batchInsertLogRows_(taskId, deduped, now);
    insertTask_(task);
    audit_('createTask', taskId, { count: count });
    return { ok: true, taskId: taskId, count: count, message: 'Tạo task' + (noList ? ' quét tự do' : '') + ' thành công: ' + taskId };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Nạp danh sách theo ca (roster) vào task đang MỞ — Phase A (docs/roster-load-design.md).
 * Lọc StaffData theo tổ hợp → append dòng PENDING + timeRef = now cho NV CHƯA có trong log
 * (bỏ qua im lặng NV đã có — idempotent, khác paste báo "đã có mặt"). KHÔNG reclassify dòng cũ.
 * Gate: operator + status OPEN + canScanOpen_ (owner/admin) — pattern DEFENSE (như pasteCodes).
 * @param {string} taskId
 * @param {{station: string, slotCode: string|string[], team: string|string[], contractType: string|string[], date: string}} filters
 * @returns {{ok: boolean, total: number, added: number, skipped: number, message: string, counters: Object}}
 */
function loadRoster(taskId, filters) {
  if (!taskId) return { ok: false, total: 0, added: 0, skipped: 0, message: 'Thiếu taskId', counters: null };
  // M1 (review 2026-08-11): gate THẬT ở service layer — google.script.run gọi được global
  // trực tiếp nên gate chỉ ở *Api wrapper bị bypass. Operator vẫn dùng được (DEFAULT).
  if (!requireRole_('operator')) {
    return { ok: false, total: 0, added: 0, skipped: 0, message: 'Không đủ quyền (cần role operator trở lên)', counters: null };
  }
  // DEFENSE: bọc toàn bộ logic — mọi lỗi trả ok:false thay vì ném ra client (pattern scanStaff).
  try {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const task = readTask_(taskId);
      if (!task) return { ok: false, total: 0, added: 0, skipped: 0, message: 'Không tìm thấy task', counters: null };
      // Chỉ phase Mở (đồng gate với paste) — phase 2 không nạp roster (NV ngoài ds quét = Dư).
      if (task.status !== TASK_STATUS.OPEN) {
        return { ok: false, total: 0, added: 0, skipped: 0, message: 'Chỉ phase Mở mới nạp danh sách được', counters: null };
      }
      const isAdmin = isEditor_();
      if (!canScanOpen_({ TASK_STATUS: TASK_STATUS }, task.createdBy, getActiveEmail_(), isAdmin)) {
        return { ok: false, total: 0, added: 0, skipped: 0, message: UI_LABELS.SCAN_OPEN_OWNER_ONLY, counters: null };
      }
      const f = filters || {};
      // Guard station bắt buộc (pattern createReconcileTask) — station rỗng → filterStaffByGroup
      // bỏ lọc → nạp nhầm TOÀN BỘ StaffData làm roster (client đã chặn, server tự chặn — P1 audit).
      const station = String(f.station || '').trim();
      if (!station) {
        return { ok: false, total: 0, added: 0, skipped: 0, message: 'Thiếu station', counters: null };
      }
      // Chuẩn hoá mảng (client gửi string|array) — khớp filterStaffByGroup (createReconcileTask).
      const filterSlots = Array.isArray(f.slotCode) ? f.slotCode : (f.slotCode ? [f.slotCode] : []);
      const filterTeams = Array.isArray(f.team) ? f.team : (f.team ? [f.team] : []);
      const filterContractTypes = Array.isArray(f.contractType) ? f.contractType : (f.contractType ? [f.contractType] : []);
      const filterDates = Array.isArray(f.date) ? f.date : (f.date ? [f.date] : []);
      const staffList = filterStaffByGroup(readStaffList_(), {
        station: station,
        slotCode: filterSlots,
        team: filterTeams,
        contractType: filterContractTypes,
        date: filterDates,
      });
      const deduped = dedupeStaffByGroup(staffList);
      if (!deduped.length) {
        return { ok: false, total: 0, added: 0, skipped: 0, message: UI_LABELS.CREATE_FAILED_EMPTY, counters: null };
      }
      // Bỏ qua NV đã có dòng trong log — nạp lại an toàn (idempotent), không reclassify dòng cũ.
      const existing = {};
      (readLogRowsCached_(taskId) || []).forEach(function (r) {
        existing[String(r.staffId || '').trim().toUpperCase()] = 1;
      });
      const toAdd = deduped.filter(function (s) {
        return !existing[String(s.staffId || '').trim().toUpperCase()];
      });
      const skipped = deduped.length - toAdd.length;
      const now = new Date();
      const added = toAdd.length ? batchInsertLogRows_(taskId, toAdd, now) : 0;
      if (added) audit_('loadRoster', taskId, { total: deduped.length, added: added, skipped: skipped });
      const counters = computeCounters(
        { STATUS: STATUS, TASK_STATUS: TASK_STATUS },
        readLogRowsCached_(taskId) || []
      );
      return {
        ok: true, total: deduped.length, added: added, skipped: skipped,
        message: added
          ? 'Đã nạp ' + added + ' NV' + (skipped ? ' — bỏ qua ' + skipped + ' đã có' : '')
          : ('Tất cả ' + skipped + ' NV đã có trong danh sách'),
        counters: counters,
      };
    } finally {
      lock.releaseLock();
    }
  } catch (e) {
    return { ok: false, total: 0, added: 0, skipped: 0, message: e && e.message ? e.message : 'loadRoster fail', counters: null };
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
    // VALIDATE: scanned + absent + extra = total — data inconsistency cần fix trước khi đóng.
    const logRows = readLogRows_(taskId);
    const counters = computeCounters({ STATUS: STATUS }, logRows);
    if (counters.scanned + counters.absent + counters.extra !== counters.total) {
      console.error({ bench: 'completeTask', taskId: taskId, counters: counters, error: 'counter-mismatch' });
      return {
        ok: false,
        message: 'Lỗi dữ liệu: scanned + absent + extra ≠ total (' + counters.scanned + '+' + counters.absent + '+' + counters.extra + ' ≠ ' + counters.total + '). Vui lòng báo admin.',
      };
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
    // giới hạn owner) → chỉ owner/admin được phép, đồng gate scanStaff/pasteCodes/loadRoster.
    // Thiếu gate này: non-owner gọi thẳng transitionToAttendApi qua console để vô hiệu
    // owner-gate phase Mở rồi quét thoải mái (owner-gate chỉ là khoá cửa trước).
    const isAdmin = isEditor_();
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
