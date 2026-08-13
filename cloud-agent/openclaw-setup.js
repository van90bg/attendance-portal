#!/usr/bin/env node
/**
 * openclaw-setup.js - OpenClaw gateway 1-file one-shot (E2B)
 * ============================================================
 * Chep file nay vao BAT KY project roi chay 1 lan:   node openclaw-setup.js
 *
 * Tu dong:
 *   1. Tao .env (tu template) + them ".env" va ".e2b-runner/" vao .gitignore
 *   2. Cai deps vao .e2b-runner/ (npm package "e2b", khong lam ban project)
 *   3. Tao sandbox E2B template 'openclaw' (gateway da cai san)
 *   4. Set model mac dinh + chay `openclaw gateway` (token auth, port 18789)
 *   5. In link gateway (?token=...) + sandbox ID
 *
 * Gateway = web UI chat voi agent (docs: docs.e2b.dev/agents/openclaw).
 * onTimeout: 'pause' + autoResume: true — het gio pause giu state,
 * co activity tu tinh lai, KHONG can chay lai script.
 * Ctrl+C mac dinh KHONG giet sandbox.
 *
 * Flags:
 *   --connect <sandboxId>  ket noi lai sandbox dang chay/paused:
 *                          chi kiem tra gateway con listen khong, neu khong
 *                          thi restart (khong tao moi).
 *   --kill     giet sandbox khi Ctrl+C (mac dinh: de song, tu dong pause)
 *   --env FILE doc cau hinh tu file khac (mac dinh .env)
 *
 * .env:
 *   E2B_API_KEY            bat buoc (dashboard.e2b.dev)
 *   OPENCLAW_APP_TOKEN     token cua gateway (mac dinh: tu sinh random)
 *   OPENCLAW_MODEL         model mac dinh (mac dinh: openai/gpt-5.2)
 *   OPENCLAW_PORT          port gateway (mac dinh: 18789)
 *   OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENROUTER_API_KEY
 *                          forward vao sandbox (BYOK — chon model tuong ung)
 */
'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawnSync } = require('child_process')

process.chdir(__dirname)

const args = process.argv.slice(2)
const KILL = args.includes('--kill')
const ENV_FILE = args.includes('--env') ? args[args.indexOf('--env') + 1] : '.env'
const CONNECT_ID = args.includes('--connect') ? args[args.indexOf('--connect') + 1] : null

function parseEnvFile(file) {
  const out = {}
  if (!fs.existsSync(file)) return out
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!m || line.trim().startsWith('#')) continue
    let v = m[2].trim().replace(/^["']|["']$/g, '')
    if (!(m[1] in out)) out[m[1]] = v
  }
  return out
}

function gitOriginRepo() {
  const r = spawnSync('git', ['config', '--get', 'remote.origin.url'], { encoding: 'utf8' })
  if (r.status !== 0) return null
  const url = r.stdout.trim()
  const m = url.match(/(?:github\.com[/:])([^/]+\/[^/.]+)(?:\.git)?$/)
  return m ? m[1] : null
}

function ensureGitignore() {
  if (!fs.existsSync('.gitignore')) return
  let txt = fs.readFileSync('.gitignore', 'utf8')
  const add = []
  if (!txt.includes('.e2b-runner')) add.push('.e2b-runner/')
  if (!txt.split(/\r?\n/).some((l) => l.trim() === '.env')) add.push('.env')
  if (add.length && !txt.endsWith('\n')) txt += '\n'
  fs.writeFileSync('.gitignore', txt + add.join('\n') + '\n')
}

async function ensureDeps() {
  const base = path.join(__dirname, '.e2b-runner')
  if (fs.existsSync(path.join(base, 'node_modules', 'e2b'))) return base
  console.log('Installing local deps into .e2b-runner/ ...')
  const res = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--prefix', base, 'e2b'], { stdio: 'inherit', shell: true })
  if (res.status !== 0) {
    console.error('npm install failed. Need Node.js >= 18 + npm.')
    process.exit(1)
  }
  return base
}

async function gatewayReady(sandbox, port) {
  const probe = await sandbox.commands.run(`bash -lc 'ss -ltn | grep -q ":${port} " && echo ready || echo waiting'`)
  return probe.stdout.trim() === 'ready'
}

async function startGateway(sandbox, env, port, token) {
  const model = env.OPENCLAW_MODEL || 'openai/gpt-5.2'
  console.log(`Setting default model: ${model} ...`)
  await sandbox.commands.run(`openclaw config set agents.defaults.model.primary ${model}`)
  console.log('Starting OpenClaw gateway...')
  await sandbox.commands.run(
    `bash -lc 'openclaw config set gateway.controlUi.allowInsecureAuth true && ` +
      `openclaw config set gateway.controlUi.dangerouslyDisableDeviceAuth true && ` +
      `openclaw gateway --allow-unconfigured --bind lan --auth token --token ${token} --port ${port}'`,
    { background: true }
  )
  for (let i = 0; i < 45; i++) {
    if (await gatewayReady(sandbox, port)) break
    await new Promise((r) => setTimeout(r, 1000))
  }
  if (!(await gatewayReady(sandbox, port))) {
    console.warn('WARNING: gateway did not report listening within 45s - check logs inside sandbox.')
  }
}

async function stopGateway(sandbox) {
  await sandbox.commands.run(
    `bash -lc 'for p in "[o]penclaw gateway" "[o]penclaw-gateway"; do for pid in $(pgrep -f "$p" || true); do kill "$pid" >/dev/null 2>&1 || true; done; done'`
  )
  await new Promise((r) => setTimeout(r, 1000))
}

async function prepareSandbox(sandbox, env) {
  console.log('Checking OpenClaw (template openclaw pre-built)...')
  const verRes = await sandbox.commands.run('openclaw --version')
  if (verRes.stdout.trim()) {
    console.log('OpenClaw: ' + verRes.stdout.trim())
  } else {
    console.log('OpenClaw missing - fallback install not supported; use E2B template "openclaw".')
  }

  const port = Number(env.OPENCLAW_PORT) || 18789
  const token = env.OPENCLAW_APP_TOKEN || crypto.randomBytes(16).toString('hex')

  const up = await gatewayReady(sandbox, port)
  if (up) {
    console.log('Gateway already running - skipping start.')
  } else {
    await stopGateway(sandbox)
    await startGateway(sandbox, env, port, token)
  }
  return { port, token }
}

async function printLink(sandbox, port, token) {
  const host = await sandbox.getHost(port)
  const url = `https://${host}/?token=${token}`
  console.log(`\nOpenClaw Gateway: ${url}`)
  console.log(`Sandbox: ${sandbox.sandboxId}`)
  if (KILL) {
    console.log('Press Ctrl+C to stop (kills the sandbox).')
  } else {
    console.log('Ctrl+C will KEEP the sandbox (auto-pause on timeout, auto-resume on activity). Manage at https://e2b.dev')
  }
  console.log('')
}

async function main() {
  const env = { ...parseEnvFile(ENV_FILE), ...process.env }

  if (!env.E2B_API_KEY) {
    if (!fs.existsSync(ENV_FILE)) {
      const tpl = `# Created by openclaw-setup.js - fill in the keys then rerun\nE2B_API_KEY=\nOPENAI_API_KEY=\n# ANTHROPIC_API_KEY=\n# GEMINI_API_KEY=\n# OPENROUTER_API_KEY=\n# OPENCLAW_APP_TOKEN=\n# OPENCLAW_MODEL=openai/gpt-5.2\n# OPENCLAW_PORT=18789\n`
      fs.writeFileSync(ENV_FILE, tpl)
      console.log(`Created ${ENV_FILE} - fill in the keys, then run again.`)
    } else {
      console.log(`E2B_API_KEY is missing in ${ENV_FILE}.`)
    }
    console.log('Keys: E2B_API_KEY (dashboard.e2b.dev) bat buoc; OPENAI_API_KEY / ANTHROPIC_API_KEY /')
    console.log('       GEMINI_API_KEY / OPENROUTER_API_KEY de chon model BYOK (forward vao sandbox).')
    console.log('Luu y: Base plan sandbox chay toi da ~1h lien tuc, het gio tu dong pause (resume lai duoc).')
    process.exit(1)
  }
  process.env.E2B_API_KEY = env.E2B_API_KEY
  ensureGitignore()

  const runner = await ensureDeps()
  const { Sandbox } = require(path.join(runner, 'node_modules', 'e2b'))

  let sandbox
  try {
    if (CONNECT_ID) {
      console.log(`Connecting to existing sandbox ${CONNECT_ID} ...`)
      sandbox = await Sandbox.connect(CONNECT_ID)
      console.log(`Connected: ${sandbox.sandboxId}`)
    } else {
      const envs = {}
      for (const key of [
        'OPENAI_API_KEY',
        'ANTHROPIC_API_KEY',
        'GEMINI_API_KEY',
        'OPENROUTER_API_KEY',
        'GROQ_API_KEY',
        'NVIDIA_API_KEY',
        'KILO_API_KEY',
        'OPENCODE_ZEN_API_KEY',
        'OPENCLAW_APP_TOKEN',
      ]) {
        if (env[key]) envs[key] = env[key]
      }

      const timeoutMs = Number(env.E2B_TIMEOUT_MS)
      const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 3600000

      console.log('Creating E2B sandbox (template openclaw)...')
      sandbox = await Sandbox.create('openclaw', {
        apiKey: env.E2B_API_KEY,
        envs,
        timeoutMs: timeout,
        lifecycle: { onTimeout: 'pause', autoResume: true },
      })
      console.log(`Sandbox: ${sandbox.sandboxId} (timeout ${Math.round(timeout / 60000)} min, base plan ~60 min)`)
    }

    process.once('SIGINT', async () => {
      try {
        if (KILL) {
          console.log('\nKilling sandbox...')
          await sandbox.kill()
        } else {
          console.log('\nKEPT sandbox alive (Ctrl+C does NOT kill).')
          console.log(`- Sandbox: ${sandbox.sandboxId} - resume/stop at https://e2b.dev`)
          console.log('- It auto-pauses when the timeout expires and auto-resumes on activity.')
        }
      } catch (e) {
        console.error('Error cleaning up:', e)
      } finally {
        process.exit(0)
      }
    })

    const { port, token } = await prepareSandbox(sandbox, env)
    await printLink(sandbox, port, token)
    await new Promise(() => {})
  } catch (error) {
    console.error('Error:', error)
    try {
      if (sandbox) await sandbox.kill()
    } catch (_) {
      /* ignore */
    }
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('An error occurred:', err)
  process.exit(1)
})