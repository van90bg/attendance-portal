# Cloud AI Agent — Daytona + OpenCode Web + OpenRouter + GitHub

Chỉnh sửa code GitHub **trực tiếp trên browser** từ bất kỳ đâu (laptop, điện thoại) mà không cần máy nhà chạy. Toàn bộ tính toán/agent chạy trong **Daytona sandbox (cloud, BYOK)**, LLM dùng **OpenRouter (BYOK)**, kết quả push thẳng về **GitHub**. Chi phí: miễn phí hoặc trả phí theo key OpenRouter bạn tự nạp — không phải thuê server nào.

```
laptop/phone browser
        │  (mở preview link)
        ▼
Daytona sandbox (cloud): OpenCode Web ── LLM qua OpenRouter ── repo GitHub clone sẵn
        │
        └── commit + push về GitHub (dùng GITHUB_TOKEN cấp 1 repo)
```

## Chuẩn bị 3 key (làm 1 lần, ~5 phút)

| Key | Lấy tại | Cấp quyền |
|---|---|---|
| `DAYTONA_API_KEY` | https://app.daytona.io/dashboard/keys | Tài khoản Daytona miễn phí |
| `OPENROUTER_API_KEY` | https://openrouter.ai/keys | Dùng model `:free` hoặc model trả phí |
| `GITHUB_TOKEN` | https://github.com/settings/tokens?type=beta (fine-grained PAT) | Chỉ cấp **1 repo** bạn muốn sửa + quyền `Contents: Read/Write` |

## LLM providers (BYOK — thêm key nào dùng key đó)

Tất cả key đều điền vào `.env`; script tự forward vào sandbox, đổi model trong UI (menu dưới ô prompt):

| Provider | Key trong `.env` | Lấy key tại | Ghi chú |
|---|---|---|---|
| OpenRouter (mặc định) | `OPENROUTER_API_KEY` | https://openrouter.ai/keys | Có model `:free` |
| NVIDIA (build.nvidia.com) | `NVIDIA_API_KEY` | https://build.nvidia.com | Miễn phí, built-in OpenCode |
| Kilo AI Gateway | `KILO_API_KEY` | https://app.kil.ai | OpenAI-compatible, 1 key = hàng trăm model (`anthropic/claude-...`, `openai/gpt-...`) |
| OpenCode Zen | `OPENCODE_ZEN_API_KEY` | https://opencode.ai/zen | Model do OpenCode test sẵn |
| Anthropic / OpenAI / Gemini / Groq | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` / `GROQ_API_KEY` | trang chủ từng hãng | Built-in, chỉ cần env var |

- Model string dạng `provider/model`, vd: `nvidia/nemotron-...`, `opencode/gemini-3.6-flash`, `kilo/anthropic/claude-sonnet-4.5`, `openrouter/...`
- Kilo là provider custom (đã khai trong script, không liệt kê model cứng): nhập model Kilo trực tiếp trong UI theo ID tại `https://api.kilo.ai/api/gateway/models`.
- NVIDIA NIM tự host (on-prem) cũng được — đổi `provider.nvidia.options.baseURL` về endpoint NIM của bạn.

## One-shot: `daytona-setup.js` (1 file, project bất kỳ)

Muốn tạo sandbox từ **project chưa có gì** (kể cả không có `node_modules`): copy **một file duy nhất** `cloud-agent/daytona-setup.js` vào project đó, rồi:

```bash
node daytona-setup.js
```

Script tự động:
1. Tạo `.env` (template) nếu chưa có → bạn điền key (tối thiểu `DAYTONA_API_KEY` + `OPENROUTER_API_KEY`) → chạy lại
2. Tự thêm `.env` + `.sandbox-runner/` vào `.gitignore` của project (nếu có)
3. Tự `npm install` SDK vào thư mục `.sandbox-runner/` — **không làm bẩn project**
4. Tạo sandbox (spec 2vCPU/4GB/10GB, auto-stop 240, auto-delete=-1), cài OpenCode, **tự đoán repo** từ `GITHUB_REPO` trong `.env` — hoặc từ `git remote origin` của project nếu không set → clone + git config + web UI
5. In link preview + sandbox ID; Ctrl+C **giữ sandbox** (flag `--delete` nếu muốn xóa khi thoát)

Chạy bằng `node daytona-setup.js` (không chạy `./daytona-setup.js` trực tiếp vì file giữ CRLF theo quy ước repo).

## Chạy trên máy nhà (laptop)

```bash
cd cloud-agent
copy .env.example .env        # Windows: Copy-Item .env.example .env
# → điền 3 key + GITHUB_REPO (vd van90bg/RollCall_2_deploy)
npm start
```

**Script bootstrap 1 chạm (đã có sẵn trong `cloud-agent/`):**

| Script | Dùng khi | Lệnh |
|---|---|---|
| `start.sh` | Codespace, Linux, macOS, Git Bash/WSL trên Windows | `./start.sh` |
| `start.cmd` | Windows (đổi thành bấm đúp) | `start.cmd` |

Cả hai tự làm: tạo `.env` từ `.env.example` nếu chưa có → kiểm tra Node → `npm install` nếu thiếu `node_modules` → chạy `npm start`. Lưu ý: `start.sh` giữ **LF** (bash không chạy được file CRLF) — không chuyển nó sang CRLF.

Script sẽ: tạo sandbox → cài OpenCode → clone repo (đã set git config + remote kèm token) → in ra link:

```
OpenCode Web UI: https://3000-xxxx.proxy.daytona.works/
```

Mở link đó bằng browser ở **bất kỳ đâu** (cả điện thoại). Session vẫn sống cho tới khi bạn Ctrl+C trên máy nhà → sandbox bị xóa, không tốn phí.

## Dùng agent

1. Trong UI, chọn model nếu muốn khác mặc định (menu dưới ô prompt; `:free` = miễn phí).
2. Repo nằm tại `/home/daytona/project` — agent clone sẵn. Ra lệnh bình thường.
3. Muốn lưu: bảo agent **"commit và push lên GitHub"** — nó commit + push về repo của bạn.
4. Chạy server thử app? Agent tự sinh preview link (nhờ Daytona Preview Links).

## Ghi chú quan trọng

- **Không commit `.env`** — đã thêm vào `.gitignore` (chứa key của bạn).
- Token GitHub chỉ nên cấp quyền đúng 1 repo (fine-grained); nếu rò rỉ thì thu hồi ngay.
- Mỗi lần `npm start` là sandbox mới; key được truyền lại qua envVars nên OpenCode tự nhận `OPENROUTER_API_KEY`. Không cần nhập lại trong UI.
- Repo này (RollCall) quy ước file CRLF: sau khi clone, bảo agent/hoặc chạy `git config core.autocrlf true` trong sandbox để checkout ra CRLF đúng chuẩn.
- Ctrl+C phải là lúc bạn **không** đang chạy session dở — sandbox xóa đồng nghĩa dữ liệu chưa push trong sandbox mất.

## Chạy không cần máy nhà (SANDBOX_KEEP=1)

Máy nhà chỉ cần khởi tạo **1 lần**; sau đó có thể tắt máy hoàn toàn, dùng từ điện thoại:

1. Set `SANDBOX_KEEP=1` trong `.env` rồi `npm start` (lần này vẫn chạy trên máy nhà)
2. Khi ra ngoài: **bấm Ctrl+C bình thường** — sandbox được giữ lại, không xóa (script in rõ thông báo KEEP + sandbox ID)
3. Tắt máy. **Từ điện thoại:**
   - Link preview vẫn mở — trong khi sandbox đang chạy, không cần làm gì khác
   - Nếu sandbox auto-stop (dừng): vào https://app.daytona.io → Sandboxes → bấm **▶ Start**
   - Nếu link web chết mà sandbox đã Start (server `opencode web` không chạy sau khi stop/restart): mở **web terminal** (icon `>_` ngay cạnh sandbox trong dashboard) rồi gõ:
     ```bash
     cd ~/project && opencode web --port 3000
     ```
     (config + repo + keys đã lưu sẵn trong sandbox khi setup — script ghi config vào `~/.config/opencode/opencode.json`; thư mục project là `~/project` — home user tùy image, script tự dò `$HOME`)
4. Muốn dừng hẳn: Ctrl+C khi có máy, hoặc xóa sandbox từ dashboard → Sandboxes → **Delete**

Ghi chú:
- `SANDBOX_KEEP=1` mà Ctrl+C = **không xóa sandbox** — tự nhớ dọn dẹp trên dashboard, nếu không sandbox tồn tại đến khi bị auto-stop/auto-archive.
- Mỗi lần sandbox auto-stop rồi Start lại, `opencode web` phải chạy lại bằng tay qua web terminal (1 dòng lệnh, vài giây) — đây là bước duy nhất cần làm từ điện thoại.

## Thử với E2B (thay Daytona): `e2b-setup.js`

Cùng kiểu one-shot nhưng dùng **E2B** (microVM, API rất giống Daytona):

```bash
# 1. Copy file vào project, chạy lần 1 → điền key vào .env rồi chạy lại
node e2b-setup.js
```

- Key bắt buộc: `E2B_API_KEY` (dashboard.e2b.dev) + `OPENROUTER_API_KEY`; tự tạo `.env`, tự ignore, tự `npm install` vào `.e2b-runner/`
- `E2B_TIMEOUT_MS` (mặc định 3600000): **Base plan tối đa ~1h chạy liên tục** (Pro ~24h) — hết giờ **tự pause, giữ nguyên trạng thái**, resume được từ https://e2b.dev
- Ctrl+C mặc định **không gết** sandbox (`--kill` nếu muốn); link preview dạng `https://3000-<sandboxId>.e2b.dev`
- Khác biệt: E2B không có "auto-delete/auto-stop theo phút" như Daytona — thời gian sống do `timeoutMs`; dừng tay qua dashboard hoặc `kill()`

## Cursor Sandboxes — provider?

Cursor Sandboxes (browser IDE của Cursor) **không cho thêm provider tùy ý**. BYOK chính thức chỉ: **OpenAI, Anthropic, Google AI, Azure OpenAI, AWS Bedrock** (Settings → Models → API Keys). OpenRouter không nằm trong danh sách, nhưng chạy được qua workaround:

1. Settings → Models → API Keys → bật **OpenAI API Key**, dán key OpenRouter (`sk-or-...`)
2. Bật **Override OpenAI Base URL** = `https://openrouter.ai/api/v1/cursor` (bắt buộc `/cursor`)
3. Thêm model thủ công theo ID OpenRouter

Giới hạn: tab completion luôn dùng model Cursor; vài tính năng agent có thể giới hạn ở chế độ BYOK; model trùng tên với Cursor (vd Claude Sonnet) có thể lỗi mapping — nên đặt tên model lạ/rõ ràng.

## Cấu hình sandbox (spec & thời gian sống)

Điều chỉnh trong `.env` (áp dụng lần chạy kế tiếp; script in ra spec đã dùng):

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `SANDBOX_CPU` | 2 | vCPU |
| `SANDBOX_MEMORY_GB` | 4 | RAM (GiB) |
| `SANDBOX_DISK_GB` | 10 | Ổ đĩa (GiB) |
| `SANDBOX_AUTOSTOP_MINUTES` | 240 | Auto-stop sau X phút không hoạt động; `0` = vô hạn |
| `SANDBOX_AUTODELETE_MINUTES` | -1 | Auto-delete: `-1` = **không bao giờ tự xóa**; `0` = xóa ngay khi stop; số dương = X phút sau khi stop |

Khi set spec (CPU/RAM/Disk), script tạo sandbox từ image `node:lts-bookworm` (Node chính thức, có sẵn node/npm/git) — vì API không cho `resources` kèm template mặc định. Nếu create thất bại, tự động fallback về template mặc định (không custom spec, chỉ giữ auto-stop). Muốn đổi image: set `SANDBOX_IMAGE` (phải là image Docker Hub có sẵn Node).

Lưu ý:
- **Giới hạn theo tier & vùng** của tài khoản bạn: xem https://app.daytona.io/dashboard/limits — nếu create lỗi vì spec quá cao, giảm xuống hoặc enable billing (PAYG).
- `autoStopInterval` mặc định của Daytona là **15 phút** — vì vậy với giá trị đang set 240, web UI không bị tắt giữa chừng khi bạn rời tay một lúc.
- Auto-stop chỉ tạm dừng sandbox (không xóa): mở lại từ dashboard nếu cần; `autoDeleteInterval` không set nên sandbox không tự bị xóa khi stop.
- `0` phút = không auto-stop: sandbox chạy đến khi bạn Ctrl+C hoặc hết quota — chỉ dùng khi đã enable billing.

## Lỗi thường gặp

- `DAYTONA_API_KEY chua set` → chưa copy `.env` hoặc thiếu key.
- `npm i -g opencode-ai` chậm → chỉ lần đầu; lần sau sandbox mới vẫn phải cài lại (chấp nhận được, vài chục giây).
- UI không lên model OpenRouter → kiểm tra `OPENROUTER_API_KEY` trong `.env` (phải có trước khi `npm start`).
- Cú pháp lệnh `opencode web` đổi theo version → vào sandbox chạy `opencode --help` để xác nhận flag.

## Tài liệu gốc

- https://www.daytona.io/docs/en/guides/opencode/opencode-web-agent
- SDK: https://www.npmjs.com/package/@daytona/sdk