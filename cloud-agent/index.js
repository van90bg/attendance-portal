/*
 * Cloud AI Agent launcher
 * Daytona sandbox + OpenCode Web + OpenRouter (BYOK) + GitHub
 * Chay tren may ban (laptop), UI mo tu browser o bat ky dau.
 * Ctrl+C -> xoa sandbox.
 */
'use strict'

const path = require('path')
const dotenv = require('dotenv')
const { Daytona } = require('@daytona/sdk')

dotenv.config({ path: path.join(__dirname, '.env') })

const OPENCODE_PORT = 3000

const KEEP = process.env.SANDBOX_KEEP === '1' || process.argv.includes('--keep')

function injectEnvVar(name, content) {
  const base64 = Buffer.from(content).toString('base64')
  return `${name}=$(echo '${base64}' | base64 -d)`
}

async function main() {
  if (!process.env.DAYTONA_API_KEY) {
    console.error('Error: DAYTONA_API_KEY chua set. Copy .env.example sang .env va dien key.')
    process.exit(1)
  }

  const daytona = new Daytona({
    apiKey: process.env.DAYTONA_API_KEY,
    ...(process.env.DAYTONA_REGION ? { region: process.env.DAYTONA_REGION } : {}),
  })

  let sandbox
  try {
    const sandboxEnv = {}
    const PROVIDER_KEYS = [
      'OPENROUTER_API_KEY',
      'NVIDIA_API_KEY',
      'KILO_API_KEY',
      'OPENCODE_ZEN_API_KEY',
      'OPENCODE_API_KEY',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GEMINI_API_KEY',
      'GROQ_API_KEY',
    ]
    for (const key of PROVIDER_KEYS) {
      if (process.env[key]) sandboxEnv[key] = process.env[key]
    }
    if (process.env.GITHUB_TOKEN) sandboxEnv.GITHUB_TOKEN = process.env.GITHUB_TOKEN

    const num = (v) => {
      const n = Number(v)
      return Number.isFinite(n) && n > 0 ? n : null
    }
    const createParams = {}
    const resources = {}
    if (num(process.env.SANDBOX_CPU)) resources.cpu = num(process.env.SANDBOX_CPU)
    if (num(process.env.SANDBOX_MEMORY_GB)) resources.memory = num(process.env.SANDBOX_MEMORY_GB)
    if (num(process.env.SANDBOX_DISK_GB)) resources.disk = num(process.env.SANDBOX_DISK_GB)
    if (Object.keys(resources).length) {
      createParams.resources = resources
      createParams.image = process.env.SANDBOX_IMAGE || 'node:lts-bookworm'
    }
    createParams.envVars = sandboxEnv
    if (num(process.env.SANDBOX_AUTOSTOP_MINUTES)) {
      createParams.autoStopInterval = num(process.env.SANDBOX_AUTOSTOP_MINUTES)
    }
    const autodelRaw = process.env.SANDBOX_AUTODELETE_MINUTES
    const autodelNum = Number(autodelRaw)
    createParams.autoDeleteInterval =
      autodelRaw !== undefined && autodelRaw !== '' && Number.isFinite(autodelNum) ? autodelNum : -1

    console.log('Creating sandbox...')
    try {
      sandbox = await daytona.create(createParams)
    } catch (err) {
      if (createParams.resources) {
        console.warn(`Create voi custom spec that bai (${err.message}) — fallback ve template mac dinh (khong custom spec).`)
        const fallback = { envVars: sandboxEnv }
        if (createParams.autoStopInterval) fallback.autoStopInterval = createParams.autoStopInterval
        fallback.autoDeleteInterval = createParams.autoDeleteInterval
        sandbox = await daytona.create(fallback)
      } else {
        throw err
      }
    }
    const sp = (resources.cpu ? resources.cpu : 'default') + ' vCPU / ' + (resources.memory ? resources.memory : 'default') + ' GiB RAM / ' + (resources.disk ? resources.disk : 'default') + ' GiB disk'
    const autoDelTxt = createParams.autoDeleteInterval < 0 ? 'disabled (never delete)' : createParams.autoDeleteInterval + ' min'
    console.log(`Sandbox spec: ${sp} | auto-stop: ${createParams.autoStopInterval ? createParams.autoStopInterval + ' min' : 'default (15 min)'} | auto-delete: ${autoDelTxt}`)

    process.once('SIGINT', async () => {
      try {
        if (KEEP) {
          console.log(`\nKEEP mode: sandbox "${sandbox.id}" GIU LAI (khong xoa).`)
          console.log(`- Link web UI van hoat dong: ${'https://app.daytona.io'} -> Sandboxes`)
          console.log('- Muon xoa: vao Daytona dashboard -> Sandboxes -> Delete.')
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

    const repo = process.env.GITHUB_REPO
    if (repo && process.env.GITHUB_TOKEN) {
      console.log(`Cloning ${repo} ...`)
      await sandbox.process.executeCommand(
        `H="${home}" && mkdir -p "$H" && cd "$H" && { [ -d project/.git ] && echo SKIP-EXISTING; } || git clone https://x-access-token:${'$'}{GITHUB_TOKEN}@github.com/${repo}.git project`
      )
      const cfgRes = await sandbox.process.executeCommand(
        `cd "${home}/project" && git config user.name "${process.env.GIT_USER_NAME || 'Cloud Agent'}" && git config user.email "${process.env.GIT_USER_EMAIL || 'agent@daytona.local'}" && git remote set-url origin https://x-access-token:${'$'}{GITHUB_TOKEN}@github.com/${repo}.git && echo PROJECT_OK`
      )
      const cloneOk = !!(cfgRes && cfgRes.result && String(cfgRes.result).includes('PROJECT_OK'))
      if (cloneOk) {
        console.log(`Repo ready at ${home}/project (git config + remote token OK).`)
      } else {
        console.log(`CANH BAO: clone co the chua thanh cong tai ${home}/project — kiem tra trong sandbox.`)
      }
    } else {
      console.log('Thieu GITHUB_REPO/GITHUB_TOKEN — bo qua clone. Co the clone thu cong trong sandbox.')
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

    const model = process.env.OPENROUTER_MODEL || 'openrouter/deepseek/deepseek-chat-v3-0324:free'
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
          models: {
            'anthropic/claude-sonnet-4.5': { name: 'Claude Sonnet 4.5' },
            'anthropic/claude-haiku-4.5': { name: 'Claude Haiku 4.5' },
            'openai/gpt-4o-mini': { name: 'GPT-4o mini' },
            'openai/gpt-4o': { name: 'GPT-4o' },
            'google/gemini-2.5-flash': { name: 'Gemini 2.5 Flash' },
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
    const workDir = repo && process.env.GITHUB_TOKEN ? `cd "${home}/project" && ` : ''
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
      console.log('KEEP mode: Ctrl+C se GIU sandbox lai. Tat may nha van dung duoc tu dien thoai.')
      console.log('  -> Xoa sandbox thu cong: https://app.daytona.io -> Sandboxes -> Delete')
    } else {
      console.log('Press Ctrl+C to stop (se xoa sandbox).')
    }
    console.log('')
    await new Promise(() => {})
  } catch (error) {
    console.error('Error:', error)
    if (sandbox) await sandbox.delete()
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('An error occurred:', err)
  process.exit(1)
})
