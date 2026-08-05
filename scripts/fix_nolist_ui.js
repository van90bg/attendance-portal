const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'index.html');
let src = fs.readFileSync(FILE, 'utf8');
// normalize to \n for stable replace, restore CRLF at end
const hadCRLF = src.includes('\r\n');
src = src.replace(/\r\n/g, '\n');

let changes = 0;

// ===== V3: showToast phân loại màu theo status (Dư=amber, lỗi=đỏ, còn lại=xanh) =====
// Thay vì chỉ (isError ? 'err' : 'ok'), nhận diện status Dư để tô amber.
const oldToast = `  var toastTimer = null;\n  function showToast(msg, isError) {\n    var t = document.getElementById('toast');\n    t.setAttribute('role', isError ? 'alert' : 'status');\n    t.setAttribute('aria-live', isError ? 'assertive' : 'polite');\n    t.innerHTML = '<span class="toast-text">' + esc(msg) + '</span>' +\n      (isError ? '<button class="toast-close" onclick="dismissToast()" aria-label="Đóng thông báo">✕</button>' : '');\n    t.className = 'show ' + (isError ? 'err' : 'ok');\n    clearTimeout(toastTimer);\n    toastTimer = setTimeout(function () { t.className = ''; }, 2600);\n  }`;

const newToast = `  var toastTimer = null;\n  function showToast(msg, isError) {\n    var t = document.getElementById('toast');\n    t.setAttribute('role', isError ? 'alert' : 'status');\n    t.setAttribute('aria-live', isError ? 'assertive' : 'polite');\n    t.innerHTML = '<span class="toast-text">' + esc(msg) + '</span>' +\n      (isError ? '<button class="toast-close" onclick="dismissToast()" aria-label="Đóng thông báo">✕</button>' : '');\n    // V3: phân loại màu toast theo thông tin — Dư = amber (cảnh báo, không lỗi),\n    // lỗi = đỏ, còn lại (Có mặt / Chưa điểm danh / thông báo thường) = xanh.\n    var cls = isError ? 'err' : (msg === STATUS_C.EXTRA ? 'warn' : 'ok');\n    t.className = 'show ' + cls;\n    clearTimeout(toastTimer);\n    toastTimer = setTimeout(function () { t.className = ''; }, 2600);\n  }`;

if (src.includes(oldToast)) {
  src = src.replace(oldToast, newToast);
  changes++;
  console.log('V3 showToast: patched');
} else {
  console.error('V3 showToast: NOT FOUND');
}

// Thêm CSS cho #toast.warn (amber) cạnh #toast.ok / #toast.err
const oldCss = `    #toast.ok { background: #188038; }\n    #toast.err { background: #d93025; }`;
const newCss = `    #toast.ok { background: #188038; }\n    #toast.err { background: #d93025; }\n    #toast.warn { background: var(--warning, #e85d04); }`;
if (src.includes(oldCss)) {
  src = src.replace(oldCss, newCss);
  changes++;
  console.log('V3 CSS: patched');
} else {
  console.error('V3 CSS: NOT FOUND');
}

// ===== V1: Đưa checkbox Quét tự do lên ĐẦU modal + card nổi bật + toggle filter =====
// (a) Xoá block checkbox cũ ở cuối (dưới grpCols)
const oldChkTail = `    </div>\n    <label class=\"grp-item\" style=\"margin:10px 0 0;gap:8px;align-items:center;font-size:13px;cursor:pointer;\">\n      <input type=\"checkbox\" id=\"chkNoList\" onchange=\"onNoListChange()\">\n      <span>Quét tự do (không danh sách) — mọi mã quét là NV lạ, quét 2 lần: Giờ có mặt → Giờ quét</span>\n    </label>`;
if (src.includes(oldChkTail)) {
  src = src.replace(oldChkTail, '    </div>');
  changes++;
  console.log('V1: removed tail checkbox');
} else {
  console.error('V1 tail checkbox: NOT FOUND');
}

// (b) Thêm card Quét tự do vào ĐẦU modal (trước grpCols). Tìm anchor mở modal grpCols.
const oldHead = `    <div class=\"grp-cols\" id=\"grpCols\">`;
const newHead = `    <label class=\"grp-item nolist-card\" id=\"noListCard\" style=\"margin:0 0 12px;padding:10px 12px;gap:8px;align-items:center;font-size:13px;cursor:pointer;border:1px solid var(--warning, #e85d04);border-radius:var(--card-radius);background:#fef7e0;\">\n      <input type=\"checkbox\" id=\"chkNoList\" onchange=\"onNoListChange()\">\n      <span><strong style=\"color:var(--warning, #e85d04);\">Quét tự do</strong> (không danh sách) — mọi mã quét là NV lạ, quét 2 lần: Giờ có mặt → Giờ quét</span>\n    </label>\n    <div class=\"grp-cols\" id=\"grpCols\">`;
if (src.includes(oldHead)) {
  src = src.replace(oldHead, newHead);
  changes++;
  console.log('V1: added head checkbox card');
} else {
  console.error('V1 head anchor: NOT FOUND');
}

// (c) onNoListChange: khi bật → dim + disable filter; khi tắt → restore
const oldOnNoList = `  function onNoListChange() {\n    var chk = document.getElementById('chkNoList');\n    SEL.noList = !!(chk && chk.checked);\n    var grp = document.getElementById('grpCols');\n    if (grp) grp.style.opacity = SEL.noList ? '.4' : '';\n    updateCreatePreview();\n  }`;
const newOnNoList = `  function onNoListChange() {\n    var chk = document.getElementById('chkNoList');\n    SEL.noList = !!(chk && chk.checked);\n    var grp = document.getElementById('grpCols');\n    if (grp) {\n      grp.style.opacity = SEL.noList ? '.4' : '';\n      // V1: bật Quét tự do → vô hiệu hoá filter (không cần danh sách); tắt → mở lại\n      var inputs = grp.querySelectorAll('input, .grp-item');\n      for (var i = 0; i < inputs.length; i++) inputs[i].style.pointerEvents = SEL.noList ? 'none' : '';\n    }\n    var card = document.getElementById('noListCard');\n    if (card) card.style.background = SEL.noList ? '#fdeccf' : '#fef7e0';\n    updateCreatePreview();\n  }`;
if (src.includes(oldOnNoList)) {
  src = src.replace(oldOnNoList, newOnNoList);
  changes++;
  console.log('V1 onNoListChange: patched');
} else {
  console.error('V1 onNoListChange: NOT FOUND');
}

// (d) openCreateModal: reset checkbox + gọi onNoListChange để đồng bộ filter state
const oldOpen = `  function openCreateModal() {\n    var m = document.getElementById('createModal');\n    if (!m) return;\n    // P2: reset lựa chọn 4 cột mỗi lần mở — không giữ giá trị cũ (tránh tạo nhầm task)\n    resetSel();\n    renderAllCols();\n    m.setAttribute('aria-hidden', 'false');  // I10\n    m.classList.add('open');\n    var first = document.querySelector('#createModal .grp-item input');\n    if (first && first.focus) first.focus();\n  }`;
const newOpen = `  function openCreateModal() {\n    var m = document.getElementById('createModal');\n    if (!m) return;\n    // P2: reset lựa chọn 4 cột mỗi lần mở — không giữ giá trị cũ (tránh tạo nhầm task)\n    resetSel();\n    renderAllCols();\n    // V1: reset checkbox Quét tự do mỗi lần mở (không giữ trạng thái cũ)\n    var chk = document.getElementById('chkNoList');\n    if (chk) chk.checked = false;\n    onNoListChange();\n    m.setAttribute('aria-hidden', 'false');  // I10\n    m.classList.add('open');\n    var first = document.querySelector('#createModal .grp-item input');\n    if (first && first.focus) first.focus();\n  }`;
if (src.includes(oldOpen)) {
  src = src.replace(oldOpen, newOpen);
  changes++;
  console.log('V1 openCreateModal: patched');
} else {
  console.error('V1 openCreateModal: NOT FOUND');
}

if (hadCRLF) src = src.replace(/\n/g, '\r\n');
fs.writeFileSync(FILE, src, 'utf8');
console.log('TOTAL CHANGES:', changes);
