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
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
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

// ── arguments ───────────────────────────────────────────────────────────────
// Options may appear before or after the command; unknown flags are errors
// instead of silently starting an install.
const COMMANDS = new Set(['install', 'bridge', 'plugin', 'status', 'help'])
const BOOL_FLAGS = new Set(['help', 'version', 'no-bridge', 'force', 'dry-run'])
const VALUE_FLAGS = new Set(['profile', 'from'])
function parseArgs(raw) {
  const parsed = { command: 'install', flags: new Set(), values: new Map() }
  for (let i = 0; i < raw.length; i += 1) {
    const arg = raw[i]
    if (arg === '-h') { parsed.flags.add('help'); continue }
    if (arg === '-v') { parsed.flags.add('version'); continue }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
      const inline = eq === -1 ? undefined : arg.slice(eq + 1)
      if (BOOL_FLAGS.has(name)) {
        if (inline !== undefined) throw new Error(`--${name} 不接受值`)
        parsed.flags.add(name)
        continue
      }
      if (!VALUE_FLAGS.has(name)) throw new Error(`未知选项 --${name}（用 --help 看用法）`)
      let value = inline
      if (value === undefined) {
        const next = raw[i + 1]
        if (next === undefined || next.startsWith('-')) throw new Error(`--${name} 需要一个值`)
        value = next
        i += 1
      }
      if (value === '') throw new Error(`--${name} 需要一个值`)
      if (parsed.values.has(name)) throw new Error(`--${name} 重复了`)
      parsed.values.set(name, value)
      continue
    }
    if (!COMMANDS.has(arg)) throw new Error(`未知命令 ${arg}（可用：install / bridge / plugin / status / help）`)
    if (parsed.command !== 'install' || parsed.commandExplicit === true) throw new Error(`命令重复：${arg}`)
    parsed.command = arg
    parsed.commandExplicit = true
  }
  return parsed
}
let parsed
try {
  parsed = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(2)
}
const command = parsed.command
const flag = (name) => parsed.flags.has(name)
const value = (name, fallback) => parsed.values.get(name) ?? fallback
const versionOf = (text) => {
  const parts = String(text).split('.').map((part) => Number.parseInt(part, 10))
  return parts.every(Number.isFinite) ? parts : undefined
}
const versionAtLeast = (have, want) => {
  const a = versionOf(have)
  const b = versionOf(want)
  if (a === undefined || b === undefined) return false
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return true
}

if (flag('version')) {
  console.log(OWN.version)
  process.exit(0)
}

if (flag('help') || command === 'help') {
  console.log(`dsh-go-token-usage ${OWN.version}

Usage:
  npx ${OWN.name} install [--profile web] [--no-bridge] [--from <spec>]
                        (an older install is upgraded automatically)
  npx ${OWN.name} bridge  [--profile web] [--force]
  npx ${OWN.name} plugin  [--profile web] [--from <spec>]
  npx ${OWN.name} status  [--profile web]

Options:
  --version         print this package version and exit
  --profile <name>  DSH profile to install into (default: web, which dsh-go uses)
  --from <spec>     install the plugin from an npm spec / tarball / directory instead
                    of the published package name
  --no-bridge       skip the bridge step
  --force           reinstall even when already present (also upgrades)
  --dry-run         print the plan without downloading or writing anything

The status strip, panel and turn notes appear only on hosts that serve the
dsh-go bridge: the phone app's built-in engine has it, a remote host needs it
once (this script installs it).`)
  process.exit(0)
}

// ── environment ─────────────────────────────────────────────────────────────

const profile = value('profile', 'web')
if (!/^[A-Za-z0-9._-]+$/.test(profile) || profile === '.' || profile === '..') {
  console.error(`profile 名不合法：${profile}`)
  process.exit(2)
}
const fromSpec = value('from', undefined)
if (fromSpec !== undefined && fromSpec.startsWith('-')) {
  console.error('--from 的值不能以 - 开头')
  process.exit(2)
}
if (process.env.DSH_GO_BRIDGE_REF !== undefined && !/^[0-9a-f]{40}$/i.test(process.env.DSH_GO_BRIDGE_REF)) {
  console.error('DSH_GO_BRIDGE_REF 必须是 40 位 commit SHA')
  process.exit(2)
}
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

function bridgeComplete() {
  return BRIDGE_FILES.every((file) => existsSync(join(bridgeDir, file)))
}

function bridgePresent() {
  if (deps()['dsh-go-bridge'] !== undefined) return true
  // A half-finished download (often interrupted on a bad network) must not look
  // installed, otherwise the second run skips the files that are still missing.
  return bridgeComplete()
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

async function fetchBridgeFile(file) {
  const url = `https://raw.githubusercontent.com/${BRIDGE_REPO}/${BRIDGE_REF}/${BRIDGE_SRC}/${file}`
  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(url, { redirect: 'follow' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = Buffer.from(await res.arrayBuffer())
      if (body.length === 0) throw new Error('空文件')
      return body
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt))
    }
  }
  throw new Error(`下载 ${file} 失败（${lastError.message}）`)
}

async function downloadBridge() {
  console.log(`→ 从上游 ${BRIDGE_REPO}@${BRIDGE_REF.slice(0, 7)} 下载 dsh-go 桥接…`)
  // Download into a staging directory and only swap it in once every file is
  // there: a half-finished download must never look installed.
  const stage = `${bridgeDir}.partial-${process.pid}`
  await rm(stage, { recursive: true, force: true })
  try {
    for (const [index, file] of BRIDGE_FILES.entries()) {
      const body = await fetchBridgeFile(file)
      const target = join(stage, file)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, body)
      if ((index + 1) % 8 === 0) console.log(`  ${index + 1}/${BRIDGE_FILES.length}`)
    }
    const pkg = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8'))
    if (pkg.name !== 'dsh-go-bridge') throw new Error(`下载内容不是 dsh-go-bridge（name=${pkg.name}）`)
    const missing = BRIDGE_FILES.filter((file) => !existsSync(join(stage, file)))
    if (missing.length > 0) throw new Error(`下载不完整：缺 ${missing.join(', ')}`)
    await mkdir(pluginsDir, { recursive: true })
    await rm(bridgeDir, { recursive: true, force: true })
    await rename(stage, bridgeDir)
    console.log(`  ${BRIDGE_FILES.length}/${BRIDGE_FILES.length} 完成`)
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    throw new Error(`${error.message}。网络不通时可先在别处拷一份 dsh-go-bridge 到 ${bridgeDir}`)
  }
}

async function ensureBridge() {
  if (flag('no-bridge')) {
    console.log('· 跳过桥接（--no-bridge）')
    return
  }
  if (appRuntime && !flag('force')) {
    console.log('· 这是 dsh-go 手机本机引擎，桥接自带，跳过')
    return
  }
  const registered = deps()['dsh-go-bridge'] !== undefined
  const complete = bridgeComplete()
  if (complete && registered && !flag('force')) {
    console.log('· 桥接已装，跳过')
    return
  }
  if (complete && !flag('force')) {
    console.log('→ 桥接文件已就位，补充注册到 profile')
    if (!flag('dry-run')) run('dsh', ['plugin', '--profile', profile, 'add', bridgeDir])
    else run('dsh', ['plugin', '--profile', profile, 'add', bridgeDir])
    return
  }
  if (flag('dry-run')) {
    console.log(`[dry-run] download ${BRIDGE_FILES.length} files from ${BRIDGE_REPO}@${BRIDGE_REF.slice(0, 7)} → ${bridgeDir}`)
    run('dsh', ['plugin', '--profile', profile, 'add', bridgeDir])
    return
  }
  await downloadBridge()
  run('dsh', ['plugin', '--profile', profile, 'add', bridgeDir])
}

// ── plugin ──────────────────────────────────────────────────────────────────

function installedPluginVersion() {
  try {
    return JSON.parse(readFileSync(join(profileDir, 'node_modules', OWN.name, 'package.json'), 'utf8')).version
  } catch {
    return undefined
  }
}

async function ensurePlugin() {
  const from = fromSpec
  const force = flag('force') || from !== undefined
  const installed = installedPluginVersion()
  const depVersion = typeof deps()[OWN.name] === 'string' ? deps()[OWN.name] : undefined
  if (!force) {
    if (installed !== undefined) {
      if (versionAtLeast(installed, OWN.version)) {
        console.log(`· ${OWN.name} ${installed} 已是最新，跳过（要重装加 --force）`)
        return
      }
      console.log(`→ 升级 ${OWN.name} ${installed} → ${OWN.version}`)
    } else if (depVersion !== undefined && versionAtLeast(depVersion, OWN.version)) {
      console.log(`· ${OWN.name} 已在 profile 注册（${depVersion}）但 node_modules 不完整，重装`)
    } else if (pluginPresent()) {
      console.log(`→ ${OWN.name} 已注册旧版本${depVersion === undefined ? '' : ` ${depVersion}`}，升级到 ${OWN.version}`)
    }
  }
  let spec = from ?? `${OWN.name}@${OWN.version}`
  // Running from a git checkout (not an npx cache): install that checkout directly.
  if (from === undefined && existsSync(join(ROOT, '.git'))) spec = ROOT
  console.log(`→ dsh plugin --profile ${profile} add ${spec}`)
  try {
    run('dsh', ['plugin', '--profile', profile, 'add', spec])
  } catch (error) {
    if (from !== undefined || spec === ROOT || flag('dry-run')) throw error
    // Never leave the profile linked to an npx cache directory: copy the package
    // into the host plugin dir and install from there.
    const stable = join(pluginsDir, OWN.name)
    console.log(`  npm 安装失败，复制当前包到 ${stable} 后再装（不依赖 npx 缓存）`)
    await mkdir(pluginsDir, { recursive: true })
    await rm(stable, { recursive: true, force: true })
    await cp(ROOT, stable, { recursive: true })
    run('dsh', ['plugin', '--profile', profile, 'add', stable])
  }
}

// ── status ──────────────────────────────────────────────────────────────────

function status() {
  const installed = installedPluginVersion()
  const depVersion = typeof deps()[OWN.name] === 'string' ? deps()[OWN.name] : undefined
  console.log(`DSH_HOME     ${dshHome}`)
  console.log(`profile      ${profile}`)
  if (appRuntime) console.log('桥接         本机引擎自带')
  else if (bridgeComplete()) console.log(`桥接         已装（${BRIDGE_FILES.length} 个文件完整）`)
  else if (existsSync(bridgeDir)) console.log('桥接         不完整，重跑 install 补齐')
  else console.log('桥接         未装')
  if (installed !== undefined) console.log(`用量插件     已装 ${installed}`)
  else if (depVersion !== undefined) console.log(`用量插件     已注册 ${depVersion}（node_modules 缺失，重跑 install）`)
  else console.log('用量插件     未装')
}

// ── main ────────────────────────────────────────────────────────────────────

if (command === 'status') {
  status()
  process.exit(0)
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
