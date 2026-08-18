## Kéo git mới nhất về

1. Chạy `git pull --ff-only origin main` — an toàn vì working tree sạch và local không có commit vượt trước; nếu lệnh báo diverged (local có commit riêng), KHÔNG tự merge — dừng lại và báo user chọn rebase/merge.
2. In `git log --oneline -5` sau pull để xác nhận HEAD mới và liệt kê commit vừa kéo về (dự kiến có commit từ phiên Codebuff song song theo memory).
3. Không commit/push gì thêm — đây chỉ là thao tác đồng bộ, không phải thay đổi code của phiên này.