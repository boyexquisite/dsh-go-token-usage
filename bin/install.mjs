#!/usr/bin/env node
// dsh-go-token-usage installer.
//
//   npx dsh-go-token-usage install     # bridge (if this host lacks it) + the plugin
//   npx dsh-go-token-usage bridge      # only the dsh-go bridge
//   npx dsh-go-token-usage plugin      # only this plugin
//   npx dsh-go-token-usage status      # what is already installed
//
// Why the bridge: dsh-go draws the native strip / panel / turn notes only on hosts
// that serve /dsh-go/v1/*. The phone app's own engine ships it; a remote host
// (server, PC) has to install it once. This script fetches it straight from the
// upstream dsh-Go repository at a pinned commit — nothing is redistributed here.
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const OWN = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

// Upstream dsh-Go bridge, protocol v1 (package dsh-go-bridge 0.4.0). Pinned so a
// future upstream change cannot silently break installs; override with DSH_GO_BRIDGE_REF.
const BRIDGE_REPO = 'ccch1mneyyy/dsh-Go'
const BRIDGE_REF = process.env.DSH_GO_BRIDGE_REF || 'c36fe8c1a8bc82ef08aae89023aea226117386ba'
const BRIDGE_SRC = 'runtime/bridge/dsh-go-bridge'
const BRIDGE_FILES = [
  'cordis.patch.yml',
  'package.json',
  'PRESET-NOTICE.txt',
  'lib/client.js',
  'lib/config-source.js',
  'lib/index.js',
  'lib/plugin-config.js',
  'lib/session-deletion.js',
  'lib/companion/full-context.js',
  'lib/companion/full-persona.js',
  'lib/companion/prompt-context.js',
  'lib/companion/recall-context.js',
  'lib/companion/recall-engine.js',
  'lib/companion/recall-markers.js',
  'lib/companion/recall-schema.js',
  'lib/companion/recall-selector.js',
  'lib/companion/recall.js',
  'lib/companion/routes.js',
  'lib/companion/schema.js',
  'lib/companion/signals-schema.js',
  'lib/companion/signals.js',
  'lib/companion/state.js',
  'lib/companion/store.js',
  'lib/native/capabilities.js',
  'lib/native/capability-runtime.js',
  'lib/native/core.js',
  'lib/native/effects.js',
  'lib/native/file-picker-runtime.js',
  'lib/native/limits.js',
  'lib/native/manifest.js',
  'lib/native/routes.js',
  'lib/native/util.js',
  'lib/native/ws.js',
]

const args = process.argv.slice(2)
const command = args.find((a) => !a.startsWith('-')) ?? 'install'
const flag = (name) => args.includes(`--${name}`)
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

if (flag('help') || command === 'help') {
  console.log(`dsh-go-token-usage ${OWN.version}

Usage:
  npx ${OWN.name} install [--profile web] [--no-bridge] [--from <spec>]
  npx ${OWN.name} bridge  [--profile web] [--force]
  npx ${OWN.name} plugin  [--profile web] [--from <spec>]
  npx ${OWN.name} status  [--profile web]

Options:
  --profile <name>  DSH profile to install into (default: web, which dsh-go uses)
  --from <spec>     install the plugin from an npm spec / tarball / directory instead
                    of the published package name
  --no-bridge       skip the bridge step
  --force           reinstall even when already present
  --dry-run         print the commands instead of running them

The status strip, panel and turn notes appear only on hosts that serve the
dsh-go bridge: the phone app's built-in engine has it, a remote host needs it
once (this script installs it).`)
  process.exit(0)
}

// ── environment ─────────────────────────────────────────────────────────────

const profile = value('profile', 'web')
const dshHome = String(process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh')
const pluginsDir = join(dshHome, 'dsh-go', 'plugins')
const bridgeDir = join(pluginsDir, 'dsh-go-bridge')
const profileDir = join(dshHome, 'profiles', profile)
const profilePkgPath = join(profileDir, 'package.json')
const appRuntime = existsSync('/etc/dsh-app/runtime.json')

function profilePkg() {
  try {
    return JSON.parse(readFileSync(profilePkgPath, 'utf8'))
  } catch {
    return undefined
  }
}

function deps() {
  return profilePkg()?.dependencies ?? {}
}

function bridgePresent() {
  return deps()['dsh-go-bridge'] !== undefined || existsSync(join(bridgeDir, 'package.json'))
}

function pluginPresent() {
  return deps()[OWN.name] !== undefined
}

function has(bin) {
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function requireEnv() {
  if (!has('dsh')) {
    console.error('找不到 dsh 命令：先在目标主机装好 DSH，并让 dsh 在 PATH 里。')
    process.exit(1)
  }
  if (!has('pnpm')) {
    console.error('找不到 pnpm：dsh plugin add 需要 pnpm。先装一个（npm i -g pnpm）再重试。')
    process.exit(1)
  }
}

function run(cmd, cmdArgs) {
  if (flag('dry-run')) {
    console.log(`[dry-run] ${cmd} ${cmdArgs.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`)
    return
  }
  execFileSync(cmd, cmdArgs, { stdio: 'inherit' })
}

// ── bridge ──────────────────────────────────────────────────────────────────

async function downloadBridge() {
  console.log(`→ 从上游 ${BRIDGE_REPO}@${BRIDGE_REF.slice(0, 7)} 下载 dsh-go 桥接…`)
  let done = 0
  for (const file of BRIDGE_FILES) {
    const url = `https://raw.githubusercontent.com/${BRIDGE_REPO}/${BRIDGE_REF}/${BRIDGE_SRC}/${file}`
    const target = join(bridgeDir, file)
    let lastError
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, { redirect: 'follow' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = Buffer.from(await res.arrayBuffer())
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, body)
        lastError = undefined
        break
      } catch (error) {
        lastError = error
        await new Promise((resolve) => setTimeout(resolve, 400 * attempt))
      }
    }
    if (lastError !== undefined) {
      throw new Error(`下载 ${file} 失败（${lastError.message}）。网络不通时可以先在别处拷一份 dsh-go-bridge 到 ${bridgeDir}`)
    }
    done += 1
    if (done % 8 === 0) console.log(`  ${done}/${BRIDGE_FILES.length}`)
  }
  console.log(`  ${BRIDGE_FILES.length}/${BRIDGE_FILES.length} 完成`)
}

async function ensureBridge() {
  if (flag('no-bridge')) {
    console.log('· 跳过桥接（--no-bridge）')
    return
  }
  if (bridgePresent() && !flag('force')) {
    console.log('· 桥接已装，跳过')
    return
  }
  if (appRuntime && !flag('force')) {
    console.log('· 这是 dsh-go 手机本机引擎，桥接自带，跳过')
    return
  }
  await downloadBridge()
  run('dsh', ['plugin', '--profile', profile, 'add', bridgeDir])
}

// ── plugin ──────────────────────────────────────────────────────────────────

async function ensurePlugin() {
  if (pluginPresent() && !flag('force')) {
    console.log(`· ${OWN.name} 已装，跳过（要重装加 --force）`)
    return
  }
  const from = value('from', undefined)
  let spec = from ?? `${OWN.name}@${OWN.version}`
  // Running from a git checkout (not an npx cache): install that checkout directly.
  if (from === undefined && existsSync(join(ROOT, '.git'))) spec = ROOT
  console.log(`→ dsh plugin --profile ${profile} add ${spec}`)
  try {
    run('dsh', ['plugin', '--profile', profile, 'add', spec])
  } catch (error) {
    if (from !== undefined || spec === ROOT) throw error
    console.log('  npm 安装失败，改从本脚本所在的包目录装（若是 npx 缓存，清理缓存后需要重装）')
    run('dsh', ['plugin', '--profile', profile, 'add', ROOT])
  }
}

// ── status ──────────────────────────────────────────────────────────────────

function status() {
  console.log(`DSH_HOME     ${dshHome}`)
  console.log(`profile      ${profile}`)
  console.log(`桥接         ${appRuntime ? '本机引擎自带' : bridgePresent() ? '已装' : '未装'}`)
  console.log(`用量插件     ${pluginPresent() ? '已装' : '未装'}`)
}

// ── main ────────────────────────────────────────────────────────────────────

if (command === 'status') {
  status()
  process.exit(0)
}

if (!['install', 'bridge', 'plugin'].includes(command)) {
  console.error(`不认识的命令 ${command}；用 --help 看用法`)
  process.exit(1)
}

requireEnv()
if (command === 'install' || command === 'bridge') await ensureBridge()
if (command === 'install' || command === 'plugin') await ensurePlugin()

console.log(`
装好了。

在 dsh-go App 里：切一下主机（或重开 App）让它重读插件清单，然后——
  · 输入框上方：状态条「本对话 … · 今日 …」，点开是面板
  · 对话详情「插件」页签 /「全部功能」：Token 用量面板
  · 每条回复末尾：这一轮的 token 与缓存命中

清单（package.json）改了会自动重读；lib/ 里的代码改了要重启引擎才生效。
数据只读本机 ${join(dshHome, 'sessions')}，不联网、不上传。`)
