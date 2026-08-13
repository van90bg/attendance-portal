#!/usr/bin/env node
/**
 * e2b-setup.js - Cloud Agent 1-file one-shot (E2B - thay Daytona)
 * ============================================================
 * Chep file nay vao BAT KY project roi chay 1 lan:   node e2b-setup.js
 *
 * Tu dong:
 *   1. Tao .env (tu template) + them ".env" va ".e2b-runner/" vao .gitignore
 *   2. Cai deps vao .e2b-runner/ (npm package "e2b", khong lam ban project)
 *   3. Tao sandbox E2B (template 'opencode' pre-built + envs + timeout),
 *      cai OpenCode, clone repo, bat web UI
 *   4. In link preview + sandbox ID
 *
 * Sandbox E2B bi gioi han thoi gian chay lien tuc (Base ~1h / Pro ~24h).
 * onTimeout: 'pause' -> het gio PAUSE giu nguyen trang thai;
 * autoResume: true -> co activity (mo lai link preview / goi SDK) la sandbox
 * tu tinh lai, KHONG can chay lai script. Ctrl+C mac dinh KHONG giet sandbox.
 *
 * Flags:
 *   --connect <sandboxId>  ket noi lai sandbox dang chay/paused (khong tao moi)
 *                          -> chi check opencode web con chay khong, neu khong
 *                          thi khoi dong lai. Bo qua cai deps/clone/config.
 *   --kill     giet sandbox khi Ctrl+C (mac dinh: de song, tu dong pause)
 *   --env FILE doc cau hinh tu file khac (mac dinh .env)
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

process.chdir(__dirname)

const args = process.argv.slice(2)
const KILL = args.includes('--kill')
const ENV_FILE = args.includes('--env') ? args[args.indexOf('--env') + 1] : '.env'
const CONNECT_ID = args.includes('--connect') ? args[args.indexOf('--connect') + 1] : null
const OPENCODE_PORT = 3000

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

async function prepareSandbox(sandbox, env) {
  console.log('Checking OpenCode (template opencode pre-built)...')
  const verRes = await sandbox.commands.run('opencode --version')
  if (verRes.stdout.trim()) {
    console.log('OpenCode: ' + verRes.stdout.trim())
  } else {
    console.log('OpenCode missing - falling back to npm install...')
    await sandbox.commands.run('npm i -g opencode-ai', { timeout: 300000 })
  }

  const homeRes = await sandbox.commands.run('echo $HOME')
  const home = String(homeRes.stdout || '').trim() || '/root'

  const repo = env.GITHUB_REPO || gitOriginRepo()
  if (repo && env.GITHUB_TOKEN) {
    console.log(`Cloning ${repo} (skip if exists)...`)
    await sandbox.commands.run(
      `H="${home}" && mkdir -p "$H" && cd "$H" && { [ -d project/.git ] && echo SKIP-EXISTING; } || git clone https://x-access-token:${'$'}{GITHUB_TOKEN}@github.com/${repo}.git project`,
      { timeout: 300000 }
    )
    const cfgRes = await sandbox.commands.run(
      `cd "${home}/project" && git config user.name "${env.GIT_USER_NAME || 'Cloud Agent'}" && git config user.email "${env.GIT_USER_EMAIL || 'agent@e2b.local'}" && git remote set-url origin https://x-access-token:${'$'}{GITHUB_TOKEN}@github.com/${repo}.git && echo PROJECT_OK`
    )
    if (cfgRes.stdout.includes('PROJECT_OK')) console.log(`Repo ready at ${home}/project (git config + remote token OK).`)
    else console.log(`WARNING: clone may have failed at ${home}/project - check inside sandbox.`)
  } else if (repo) {
    console.log('GITHUB_TOKEN missing - skipping auto-clone.')
  } else {
    console.log('No repo detected - skipping clone (set GITHUB_REPO or add a git remote to your project).')
  }

  const previewUrlPattern = `https://${await sandbox.getHost(OPENCODE_PORT)}`

  const systemPrompt = [
    'You are running in an E2B sandbox.',
    `Your home directory is ${home}. Use it instead of /workspace for file operations.`,
    `When running services on localhost, they will be accessible as: ${previewUrlPattern}`,
    'When starting a server, always give the user the preview URL to access it.',
    'When starting a server, start it in the background with & so the command does not block further instructions.',
    repo
      ? `The user's repository is cloned at ${home}/project. Work inside it. When the user asks to save or push, commit and push to origin.`
      : '',
  ].join(' ')

  const model = env.OPENROUTER_MODEL || 'openrouter/deepseek/deepseek-chat-v3-0324:free'
  const opencodeConfig = {
    $schema: 'https://opencode.ai/config.json',
    model,
    default_agent: 'e2b',
    provider: {
      kilo: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Kilo AI Gateway',
        options: {
          baseURL: 'https://api.kilo.ai/api/gateway',
          apiKey: '{env:KILO_API_KEY}',
        },
      },
    },
    agent: {
      e2b: {
        description: 'E2B sandbox-aware coding agent',
        mode: 'primary',
        prompt: systemPrompt,
      },
    },
  }

  const configJson = JSON.stringify(opencodeConfig)
  const configBase64 = Buffer.from(configJson).toString('base64')
  await sandbox.commands.run(
    `mkdir -p ~/.config/opencode && echo '${configBase64}' | base64 -d > ~/.config/opencode/opencode.json`
  )

  const workDir = repo && env.GITHUB_TOKEN ? `cd "${home}/project" && ` : ''
  const upRes = await sandbox.commands.run(`curl -s -o /dev/null http://localhost:${OPENCODE_PORT} && echo WEB_UP || echo WEB_DOWN`)
  if (upRes.stdout.includes('WEB_UP')) {
    console.log('Web server already running - skipping start.')
  } else {
    console.log('Starting OpenCode web server...')
    await sandbox.commands.run(`${workDir}opencode web --port ${OPENCODE_PORT} > /tmp/opencode-web.log 2>&1`, { background: true })
    await new Promise((r) => setTimeout(r, 8000))
    const logRes = await sandbox.commands.run('tail -n 5 /tmp/opencode-web.log')
    if (logRes.stdout.toLowerCase().includes('error') || logRes.stderr) {
      console.warn('Web server log (check if something is wrong):')
      console.warn(logRes.stdout || logRes.stderr)
    }
  }
  return { home, repo }
}

async function printLink(sandbox) {
  const host = await sandbox.getHost(OPENCODE_PORT)
  const previewUrl = `https://${host}`
  console.log(`\nOpenCode Web UI: ${previewUrl}`)
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
      const tpl = `# Created by e2b-setup.js - fill in the keys then rerun\nE2B_API_KEY=\nOPENROUTER_API_KEY=\nGITHUB_TOKEN=\nGITHUB_REPO=\nOPENROUTER_MODEL=openrouter/deepseek/deepseek-chat-v3-0324:free\nE2B_TIMEOUT_MS=3600000\nNVIDIA_API_KEY=\nKILO_API_KEY=\nOPENCODE_ZEN_API_KEY=\n`
      fs.writeFileSync(ENV_FILE, tpl)
      console.log(`Created ${ENV_FILE} - fill in the keys, then run again.`)
    } else {
      console.log(`E2B_API_KEY is missing in ${ENV_FILE}.`)
    }
    console.log('Keys: E2B_API_KEY (dashboard.e2b.dev) + OPENROUTER_API_KEY (openrouter.ai) la bat buoc;')
    console.log('       GITHUB_TOKEN + GITHUB_REPO de clone repo (bo trong = dung remote origin cua project).')
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
        'OPENROUTER_API_KEY',
        'NVIDIA_API_KEY',
        'KILO_API_KEY',
        'OPENCODE_ZEN_API_KEY',
        'OPENCODE_API_KEY',
        'ANTHROPIC_API_KEY',
        'OPENAI_API_KEY',
        'GEMINI_API_KEY',
        'GROQ_API_KEY',
      ]) {
        if (env[key]) envs[key] = env[key]
      }
      if (env.GITHUB_TOKEN) envs.GITHUB_TOKEN = env.GITHUB_TOKEN

      const timeoutMs = Number(env.E2B_TIMEOUT_MS)
      const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 3600000

      console.log('Creating E2B sandbox (template opencode)...')
      sandbox = await Sandbox.create('opencode', {
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

    await prepareSandbox(sandbox, env)
    await printLink(sandbox)
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