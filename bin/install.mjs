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
const BRIDGE_PINNED = 'c36fe8c1a8bc82ef08aae89023aea226117386ba'
const BRIDGE_REF = process.env.DSH_GO_BRIDGE_REF || BRIDGE_PINNED
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

// SHA-256 of every pinned bridge file at BRIDGE_REF. Downloaded bytes are verified
// against this map, so a compromised mirror/DNS/proxy cannot inject code into a
// rooted host. Custom BRIDGE_REF values skip the check (they are not in the map).
const BRIDGE_SHA256 = {
  'PRESET-NOTICE.txt': 'e61242af8da22f92bf592e48e29f7dbe452b932f38a41a59a3e6e674d5e7130d',
  'cordis.patch.yml': '9993e09a264ed0624587f2f4dd39f30a29b0f0b349780953f7fe32a9dfe67557',
  'lib/client.js': '9d826e51021a0133978b16ed5c87d67606f12639fd98829346f648a06884fcb3',
  'lib/companion/full-context.js': '83737e05d1f0af580ef6a087cd6b38c153b80cfee8ea9d76a78bd168a0e5f64f',
  'lib/companion/full-persona.js': '398c7261cdadf51632854535080443d83fe23cc3f0b63f46ac3647de32fe23cc',
  'lib/companion/prompt-context.js': '630d7587654bc23e695d08dd8776d6fdd679f25e76f576b5761911e15f8acc69',
  'lib/companion/recall-context.js': '770c7b01b9ebf578c99641bcc6a7716ada06b7572a15c85aaccca24c6ea4cbfb',
  'lib/companion/recall-engine.js': '1b3424c58f7dc02e7eda09f17af53e1e88c74d1676fe03e3cf57c83a5abdc62d',
  'lib/companion/recall-markers.js': '49ec14cb6ccb1cbe43f0cd9912e6e79a5804aaf3ac7141601d7c2ae38acfe41e',
  'lib/companion/recall-schema.js': '9749d220b1e66fc78545d8c71404bb089ebbc7ab9a7863a833d418b0d51d23cf',
  'lib/companion/recall-selector.js': '0a7780058d4272480fb37a2720fdc17a0d8f1957263e103117a6244da4972325',
  'lib/companion/recall.js': '66dea2bd7c7734a692867568a6de68e515968aa0a9852445b252145a42e94d36',
  'lib/companion/routes.js': '9d0f821dc78cdf1ad1f9fb8db77485aed80521f499d2b2b09f1b4b1486e6c02b',
  'lib/companion/schema.js': 'e1e32e223eea3d40c1d55a85255b62a0bbb30f3e5e08e088755f76b22f1dd63a',
  'lib/companion/signals-schema.js': '9797b7886b73a1bf1a1a92fd1ccb3e36c3d1029012a620570fda1eca1e8b1714',
  'lib/companion/signals.js': 'deba2f577cae0ccbd46e940e4ebcc547980d3a4a4b6be5dce2859c4b15172465',
  'lib/companion/state.js': '7d639e0770d9602f644f0d3870df911cd37d608818c819bb52c2c28f81c41715',
  'lib/companion/store.js': 'bb61d2f738ba03151ea3c9f85e14a2d5632cbe365e8a14cc7091476c979d6076',
  'lib/config-source.js': 'c19ce8151e00ce8277e267c0e680888d30be0ec45b632b06fd3072b4e6a0ae3e',
  'lib/index.js': 'b35104a3b546fbbf99d51b51a652b5e46d722e1d805780d232072cd8397c289d',
  'lib/native/capabilities.js': '845a298e0defe793acbaa7a1330e2bdbb164e1600ce389c0c08a6f93cac50135',
  'lib/native/capability-runtime.js': '2283fa147623396400b8cc055a0870f3e17feb581103cfd939a3dd802bbc72be',
  'lib/native/core.js': '81d17022a9f409d50d2d2416637c1a2a2cb7ce35ccc99074ea3ee5c1c6d657b5',
  'lib/native/effects.js': 'dc21b22d5fce2402d32d3d37071bfa50e5228f56ca0e3dd154980d2c2ad2ef16',
  'lib/native/file-picker-runtime.js': '2fcc8f06e6aaeb538e7d2a48aa164418fedd57f4add2e9911aca3bd4aa1c361f',
  'lib/native/limits.js': 'bf7215077362ddbd10e8dee7302f7a9ff8c71dc439773c4307de5ef681c6f8ac',
  'lib/native/manifest.js': '897378bfad0538e381c764915b7b772645cd3e5ec1e989656f98e174eaec02cf',
  'lib/native/routes.js': 'f1b46b019a8692b8d9f2fbc589d6bd51b2c4d04b307fb4336f50e91527e02500',
  'lib/native/util.js': '5d95310a47221010e68e1c93cebe7d198d1f57ace5a0a8cd4731c6ab57d24347',
  'lib/native/ws.js': 'a82bb23bb32eb973c93dc75210dbcfe6af221ceb0dbee9bf4695a22b72351c77',
  'lib/plugin-config.js': 'f12c64a428135fef287ce94815e8dcd1bf47476f95d6099d79131c48041f0a9d',
  'lib/session-deletion.js': '8483c8265cfad03d9f4f1b5a483f0f4a300bb97eb0027d8d60016c9f09706837',
  'package.json': 'e5bc88d5895c53cf5c551a77080125c15b04954bc0b3bc9b8810249861ee7c09',
}

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
if (typeof process.getuid === 'function' && process.getuid() === 0) {
  console.log('· 以 root 运行：请确认目标主机上的 DSH 引擎也用同一用户运行，否则它可能读不到刚装的文件')
}

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
      if (BRIDGE_REF === BRIDGE_PINNED) {
        const { createHash } = await import('node:crypto')
        const got = createHash('sha256').update(body).digest('hex')
        const want = BRIDGE_SHA256[file]
        if (want === undefined) throw new Error(`没有 ${file} 的哈希，拒绝安装`)
        if (got !== want) throw new Error(`哈希不匹配（${file}：期望 ${want.slice(0, 12)}…，实际 ${got.slice(0, 12)}…）`)
      }
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
  if (BRIDGE_REF !== BRIDGE_PINNED) console.log('· 自定义 BRIDGE_REF：跳过文件哈希校验')
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
