#!/usr/bin/env node
/**
 * daytona-setup.js - Cloud Agent 1-file one-shot
 * ==============================================
 * Chep file nay vao BAT KY project (khong can node_modules, khong can cau hinh)
 * roi chay 1 lan:   node daytona-setup.js
 *
 * No tu dong:
 *   1. Tao .env (tu template) + them ".env" va ".sandbox-runner/" vao .gitignore
 *   2. Cai deps vao .sandbox-runner/ (khong lam ban project)
 *   3. Tao sandbox Daytona (spec + auto-stop + auto-delete=-1), cai OpenCode,
 *      clone repo (tu GITHUB_REPO hoac tu remote origin cua project), bat web UI
 *   4. In link preview + sandbox ID - dung duoc tu dien thoai
 *
 * Flags:
 *   --delete   xoa sandbox khi Ctrl+C (mac dinh: GIU lai, xoa tay tren dashboard)
 *   --env FILE doc cau hinh tu file khac (mac dinh .env)
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

process.chdir(__dirname)

const ARGS = new Set(process.argv.slice(2))
const KEEP = ARGS.has('--keep') || !ARGS.has('--delete')
const ENV_FILE = ARGS.has('--env') ? process.argv[process.argv.indexOf('--env') + 1] : '.env'
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
  if (!txt.includes('.sandbox-runner')) add.push('.sandbox-runner/')
  if (!txt.split(/\r?\n/).some((l) => l.trim() === '.env')) add.push('.env')
  if (add.length && !txt.endsWith('\n')) txt += '\n'
  fs.writeFileSync('.gitignore', txt + add.join('\n') + '\n')
}

function injectEnvVar(name, content) {
  const base64 = Buffer.from(content).toString('base64')
  return `${name}=$(echo '${base64}' | base64 -d)`
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

async function ensureDeps() {
  const base = path.join(__dirname, '.sandbox-runner')
  if (fs.existsSync(path.join(base, 'node_modules', '@daytona', 'sdk'))) return base
  console.log('Installing local deps into .sandbox-runner/ ...')
  const res = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--prefix', base, '@daytona/sdk', 'dotenv'], {
    stdio: 'inherit',
    shell: true,
  })
  if (res.status !== 0) {
    console.error('npm install failed. Need Node.js >= 18 + npm.')
    process.exit(1)
  }
  return base
}

async function main() {
  const env = { ...parseEnvFile(ENV_FILE), ...process.env }

  if (!env.DAYTONA_API_KEY) {
    if (!fs.existsSync(ENV_FILE)) {
      const tpl = `# Created by daytona-setup.js - fill in the keys then rerun\nDAYTONA_API_KEY=\nOPENROUTER_API_KEY=\nGITHUB_TOKEN=\nGITHUB_REPO=\nOPENROUTER_MODEL=openrouter/deepseek/deepseek-chat-v3-0324:free\nSANDBOX_CPU=2\nSANDBOX_MEMORY_GB=4\nSANDBOX_DISK_GB=10\nSANDBOX_AUTOSTOP_MINUTES=240\nSANDBOX_AUTODELETE_MINUTES=-1\nNVIDIA_API_KEY=\nKILO_API_KEY=\nOPENCODE_ZEN_API_KEY=\n`
      fs.writeFileSync(ENV_FILE, tpl)
      console.log(`Created ${ENV_FILE} - fill in the keys, then run again.`)
    } else {
      console.log(`DAYTONA_API_KEY is missing in ${ENV_FILE}.`)
    }
    console.log('Keys: DAYTONA_API_KEY (app.daytona.io) + OPENROUTER_API_KEY (openrouter.ai) la bat buoc;')
    console.log('       GITHUB_TOKEN + GITHUB_REPO de clone repo (bo trong = dung remote origin cua project).')
    process.exit(1)
  }
  ensureGitignore()

  const runner = await ensureDeps()
  const { Daytona } = require(path.join(runner, 'node_modules', '@daytona', 'sdk'))

  const daytona = new Daytona({
    apiKey: env.DAYTONA_API_KEY,
    ...(env.DAYTONA_REGION ? { region: env.DAYTONA_REGION } : {}),
  })

  let sandbox
  try {
    const sandboxEnv = {}
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
      if (env[key]) sandboxEnv[key] = env[key]
    }
    if (env.GITHUB_TOKEN) sandboxEnv.GITHUB_TOKEN = env.GITHUB_TOKEN

    const createParams = {}
    const resources = {}
    if (num(env.SANDBOX_CPU)) resources.cpu = num(env.SANDBOX_CPU)
    if (num(env.SANDBOX_MEMORY_GB)) resources.memory = num(env.SANDBOX_MEMORY_GB)
    if (num(env.SANDBOX_DISK_GB)) resources.disk = num(env.SANDBOX_DISK_GB)
    if (Object.keys(resources).length) {
      createParams.resources = resources
      createParams.image = env.SANDBOX_IMAGE || 'node:lts-bookworm'
    }
    createParams.envVars = sandboxEnv
    if (num(env.SANDBOX_AUTOSTOP_MINUTES)) createParams.autoStopInterval = num(env.SANDBOX_AUTOSTOP_MINUTES)
    const autodelNum = Number(env.SANDBOX_AUTODELETE_MINUTES)
    createParams.autoDeleteInterval =
      env.SANDBOX_AUTODELETE_MINUTES !== undefined && env.SANDBOX_AUTODELETE_MINUTES !== '' && Number.isFinite(autodelNum)
        ? autodelNum
        : -1

    console.log('Creating sandbox...')
    try {
      sandbox = await daytona.create(createParams)
    } catch (err) {
      if (createParams.resources) {
        console.warn(`Create with custom spec failed (${err.message}) - falling back to default template.`)
        const fallback = { envVars: sandboxEnv, autoDeleteInterval: createParams.autoDeleteInterval }
        if (createParams.autoStopInterval) fallback.autoStopInterval = createParams.autoStopInterval
        sandbox = await daytona.create(fallback)
      } else {
        throw err
      }
    }
    const sp =
      (resources.cpu ? resources.cpu : 'default') +
      ' vCPU / ' +
      (resources.memory ? resources.memory : 'default') +
      ' GiB RAM / ' +
      (resources.disk ? resources.disk : 'default') +
      ' GiB disk'
    const autoDelTxt = createParams.autoDeleteInterval < 0 ? 'disabled (never delete)' : createParams.autoDeleteInterval + ' min'
    console.log(
      `Sandbox spec: ${sp} | auto-stop: ${createParams.autoStopInterval ? createParams.autoStopInterval + ' min' : 'default (15 min)'} | auto-delete: ${autoDelTxt}`
    )

    process.once('SIGINT', async () => {
      try {
        if (KEEP) {
          console.log(`\nKEEP mode: sandbox "${sandbox.id}" was KEPT (not deleted).`)
          console.log('- Web UI link still works while sandbox is running.')
          console.log('- Delete manually: https://app.daytona.io -> Sandboxes -> Delete')
        } else {
          console.log('\nCleaning up...')
          if (sandbox) await sandbox.delete()
        }
      } catch (e) {
        console.error('Error cleaning up:', e)
      } finally {
        process.exit(0)
      }
    })

    console.log('Installing OpenCode...')
    await sandbox.process.executeCommand('npm i -g opencode-ai')

    const homeRes = await sandbox.process.executeCommand('echo $HOME')
    const home = String(homeRes.result || '').trim() || '/home/daytona'

    const repo = env.GITHUB_REPO || gitOriginRepo()
    if (repo && env.GITHUB_TOKEN) {
      console.log(`Cloning ${repo} ...`)
      await sandbox.process.executeCommand(
        `H="${home}" && mkdir -p "$H" && cd "$H" && { [ -d project/.git ] && echo SKIP-EXISTING; } || git clone https://x-access-token:${'$'}{GITHUB_TOKEN}@github.com/${repo}.git project`
      )
      const cfgRes = await sandbox.process.executeCommand(
        `cd "${home}/project" && git config user.name "${env.GIT_USER_NAME || 'Cloud Agent'}" && git config user.email "${env.GIT_USER_EMAIL || 'agent@daytona.local'}" && git remote set-url origin https://x-access-token:${'$'}{GITHUB_TOKEN}@github.com/${repo}.git && echo PROJECT_OK`
      )
      const cloneOk = !!(cfgRes && cfgRes.result && String(cfgRes.result).includes('PROJECT_OK'))
      if (cloneOk) console.log(`Repo ready at ${home}/project (git config + remote token OK).`)
      else console.log(`WARNING: clone may have failed at ${home}/project - check inside sandbox.`)
    } else if (repo) {
      console.log('GITHUB_TOKEN missing - skipping auto-clone. Clone manually inside the sandbox.')
    } else {
      console.log('No repo detected - skipping clone (set GITHUB_REPO or add a git remote to your project).')
    }

    const previewLink = await sandbox.getPreviewLink(1234)
    const previewUrlPattern = previewLink.url.replace(/1234/, '{PORT}')

    const systemPrompt = [
      'You are running in a Daytona sandbox.',
      `Your home directory is ${home}. Use it instead of /workspace for file operations.`,
      `When running services on localhost, they will be accessible as: ${previewUrlPattern}`,
      'When starting a server, always give the user the preview URL to access it.',
      'When starting a server, start it in the background with & so the command does not block further instructions.',
      repo
        ? `The user's repository is cloned at ${home}/project. Work inside it. When the user asks to save or push, commit and push to origin.`
        : '',
    ].join(' ')

    const model = env.OPENROUTER_MODEL || 'openrouter/free'
    const opencodeConfig = {
      $schema: 'https://opencode.ai/config.json',
      model,
      default_agent: 'daytona',
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
        daytona: {
          description: 'Daytona sandbox-aware coding agent',
          mode: 'primary',
          prompt: systemPrompt,
        },
      },
    }

    console.log('Starting OpenCode web server...')
    const configJson = JSON.stringify(opencodeConfig)
    const configBase64 = Buffer.from(configJson).toString('base64')
    await sandbox.process.executeCommand(
      `mkdir -p ~/.config/opencode && echo '${configBase64}' | base64 -d > ~/.config/opencode/opencode.json`
    )
    const sessionId = `opencode-session-${Date.now()}`
    await sandbox.process.createSession(sessionId)

    const envVar = injectEnvVar('OPENCODE_CONFIG_CONTENT', configJson)
    const workDir = repo && env.GITHUB_TOKEN ? `cd "${home}/project" && ` : ''
    const command = await sandbox.process.executeSessionCommand(sessionId, {
      command: `${envVar} ${workDir}opencode web --port ${OPENCODE_PORT}`,
      runAsync: true,
    })

    const opencodePreviewLink = await sandbox.getPreviewLink(OPENCODE_PORT)
    const replaceUrl = (text) =>
      text.replace(new RegExp(`http:\\/\\/127\\.0\\.0\\.1:${OPENCODE_PORT}`, 'g'), opencodePreviewLink.url)

    if (!command.cmdId) throw new Error('Failed to start OpenCode command in sandbox')
    sandbox.process.getSessionCommandLogs(
      sessionId,
      command.cmdId,
      (stdout) => console.log(replaceUrl(stdout).trim()),
      (stderr) => console.error(replaceUrl(stderr).trim())
    )

    console.log(`\nOpenCode Web UI: ${opencodePreviewLink.url}`)
    console.log(`Sandbox: ${sandbox.id}`)
    if (KEEP) {
      console.log('KEEP mode: Ctrl+C will KEEP the sandbox running (usable from phone).')
      console.log('  -> Delete manually: https://app.daytona.io -> Sandboxes -> Delete')
    } else {
      console.log('Press Ctrl+C to stop (deletes the sandbox).')
    }
    console.log('')
    await new Promise(() => {})
  } catch (error) {
    console.error('Error:', error)
    try {
      if (sandbox) await sandbox.delete()
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