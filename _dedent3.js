const fs = require('fs');
const p = 'index.html';
let s = fs.readFileSync(p, 'utf8');
let n = 0;
function rep(oldS, newS, label) {
  if (!s.includes(oldS)) { console.error('MISS: ' + label); process.exit(1); }
  if (s.split(oldS).length - 1 > 1) { console.error('MULTI: ' + label); process.exit(1); }
  s = s.replace(oldS, newS);
  n++;
  console.log('OK: ' + label);
}

// Dedent các khối bị patch tool thụt lệch (6-8 spaces → 4-6 chuẩn)

// 1) HEAD khối SEARCH_HEAD (dòng 1163-1166): 8 spaces → 4
rep(
  '  var SEARCH_HEAD = \'<tr>\' +\r\n        \'<th scope="col">STT</th><th scope="col">Mã task</th><th scope="col">Mã NV</th><th scope="col">Tên NV</th>\' +\r\n        \'<th scope="col">Điểm danh</th><th scope="col">Loại</th><th scope="col">Station</th><th scope="col">Team</th><th scope="col">Ca</th>\' +\r\n        \'<th scope="col">Tạo lúc</th><th scope="col">Người tạo</th><th scope="col">Thao tác</th></tr>\';',
  '  var SEARCH_HEAD = \'<tr>\' +\r\n    \'<th scope="col">STT</th><th scope="col">Mã task</th><th scope="col">Mã NV</th><th scope="col">Tên NV</th>\' +\r\n    \'<th scope="col">Điểm danh</th><th scope="col">Loại</th><th scope="col">Station</th><th scope="col">Team</th><th scope="col">Ca</th>\' +\r\n    \'<th scope="col">Tạo lúc</th><th scope="col">Người tạo</th><th scope="col">Thao tác</th></tr>\';',
  'SEARCH_HEAD indent'
);

// 2) LAST_SEARCH_ROWS / LAST_TASK_SEARCH khai báo
rep(
  '  var LAST_TASK_LIST = { tasks: null, ts: 0 };\r\n    var LAST_SEARCH_ROWS = [];\r\n    // Lưu kết quả tìm TASK hiện tại (mode \'task\') — render lại trang không mất kết quả.\r\n    var LAST_TASK_SEARCH = [];',
  '  var LAST_TASK_LIST = { tasks: null, ts: 0 };\r\n  // Lưu kết quả tìm NV hiện tại (để goListPage render lại đúng trang).\r\n  var LAST_SEARCH_ROWS = [];\r\n  // Lưu kết quả tìm TASK hiện tại (mode \'task\') — render lại trang không mất kết quả.\r\n  var LAST_TASK_SEARCH = [];',
  'LAST_SEARCH_ROWS indent'
);

fs.writeFileSync(p, s);
console.log('ALL OK, replacements: ' + n);