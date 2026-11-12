// Installer behaviour that used to bite users: dry-run side effects, half-finished
// bridge downloads, overwritten local hardening, ignored upgrades, loose argument
// parsing and permission fixes that escaped $DSH_HOME.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
const INSTALLER = join(PKG, 'bin', 'install.mjs')
const OWN = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'))
const SOURCE = readFileSync(INSTALLER, 'utf8')
const BRIDGE_FILES = [...SOURCE.match(/const BRIDGE_FILES = \[([\s\S]*?)\n\]/)[1].matchAll(/'([^']+)'/g)].map((match) => match[1])

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'installer-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  // Fake dsh/pnpm: log arguments, or fail when FAKE_FAIL is set.
  for (const name of ['dsh', 'pnpm']) {
    writeFileSync(
      join(bin, name),
      '#!/bin/sh\nif [ -n "$FAKE_FAIL" ]; then exit 1; fi\nif [ -n "$FAKE_LOG" ]; then echo "$@" >> "$FAKE_LOG"; fi\nexit 0\n',
      { mode: 0o755 },
    )
  }
  const env = { ...process.env, DSH_HOME: join(root, 'dsh'), PATH: `${bin}:${process.env.PATH}` }
  return { root, home: env.DSH_HOME, env }
}

function spawn(installer, args, env, nodeArgs = [], options = {}) {
  try {
    return { status: 0, stdout: execFileSync(process.execPath, [...nodeArgs, installer, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], ...options }) }
  } catch (error) {
    return { status: error.status, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }
  }
}

function run(args, env, nodeArgs = [], options = {}) {
  return spawn(INSTALLER, args, env, nodeArgs, options)
}

function modeOf(path) {
  return statSync(path).mode & 0o777
}

/** A complete but purely synthetic bridge tree (hashes differ from the pin unless copied from upstream). */
function writeSyntheticBridge(dir) {
  for (const file of BRIDGE_FILES) {
    const path = join(dir, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `synthetic ${file}\n`)
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-go-bridge', version: '0.4.0' }))
}

/** Preload module that serves bridge downloads from $STUB_UPSTREAM instead of the network. */
const FETCH_STUB = `import { existsSync, readFileSync } from 'node:fs'
const UPSTREAM = process.env.STUB_UPSTREAM
const PREFIX = '/runtime/bridge/dsh-go-bridge/'
globalThis.fetch = async (url) => {
  const text = String(url)
  const at = text.indexOf(PREFIX)
  if (at === -1) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }
  const file = UPSTREAM + '/' + decodeURIComponent(text.slice(at + PREFIX.length))
  if (!existsSync(file)) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }
  const body = readFileSync(file)
  return { ok: true, status: 200, arrayBuffer: async () => body }
}
`

/** chmod every entry of a tree (never follows symlinks). */
function chmodTree(root, dirMode, fileMode) {
  const walk = (path) => {
    const st = lstatSync(path)
    if (st.isSymbolicLink()) return
    chmodSync(path, st.isDirectory() ? dirMode : fileMode)
    if (!st.isDirectory()) return
    for (const entry of readdirSync(path)) walk(join(path, entry))
  }
  walk(root)
}

function writePluginInstall(home, version) {
  const profile = join(home, 'profiles', 'web')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { [OWN.name]: version } }))
  const mod = join(profile, 'node_modules', OWN.name)
  mkdirSync(mod, { recursive: true })
  writeFileSync(join(mod, 'package.json'), JSON.stringify({ name: OWN.name, version }))
  return profile
}

test('--version and --help work without touching anything', () => {
  const box = sandbox()
  try {
    assert.equal(run(['--version'], box.env).stdout.trim(), OWN.version)
    const help = run(['--help'], box.env)
    assert.equal(help.status, 0)
    assert.match(help.stdout, /Usage:/)
    assert.match(help.stdout, /backs the old bridge up/, '--force bridge reinstall documents the backup')
    assert.equal(existsSync(join(box.home, 'profiles', 'web')), false)
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

test('unknown flags and commands fail loudly instead of starting an install', () => {
  const box = sandbox()
  try {
    const badFlag = run(['install', '--nope'], box.env)
    assert.equal(badFlag.status, 2)
    assert.match(badFlag.stderr, /未知选项/)
    const badCmd = run(['frobnicate'], box.env)
    assert.equal(badCmd.status, 2)
    assert.match(badCmd.stderr, /未知命令/)
    const badFrom = run(['plugin', '--from', '--global'], box.env)
    assert.equal(badFrom.status, 2)
    assert.match(badFrom.stderr, /--from/)
    const badProfile = run(['status', '--profile', '../escape'], box.env)
    assert.equal(badProfile.status, 2)
    assert.match(badProfile.stderr, /profile/)
    assert.equal(existsSync(join(box.home, 'profiles', 'web')), false)
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

test('--dry-run prints the plan and writes nothing (no bridge download)', () => {
  const box = sandbox()
  try {
    const out = run(['install', '--dry-run'], box.env)
    assert.equal(out.status, 0)
    assert.match(out.stdout, /\[dry-run\] download 33 files/)
    assert.match(out.stdout, /\[dry-run\] .*dsh plugin --profile web add/)
    assert.equal(existsSync(join(box.home, 'dsh-go', 'plugins', 'dsh-go-bridge')), false, 'dry-run must not write the bridge')
    assert.equal(existsSync(join(box.home, 'profiles', 'web')), false, 'dry-run must not touch the profile')
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

test('a half-finished bridge directory is reported and never treated as installed', () => {
  const box = sandbox()
  try {
    const bridge = join(box.home, 'dsh-go', 'plugins', 'dsh-go-bridge')
    mkdirSync(bridge, { recursive: true })
    writeFileSync(join(bridge, 'package.json'), JSON.stringify({ name: 'dsh-go-bridge' }))
    const status = run(['status'], box.env)
    assert.equal(status.status, 0)
    assert.match(status.stdout, /不完整/)
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

test('an older install is upgraded, the current one is left alone', () => {
  const box = sandbox()
  try {
    writePluginInstall(box.home, '0.0.1')
    const upgrade = run(['plugin', '--dry-run'], box.env)
    assert.equal(upgrade.status, 0)
    assert.match(upgrade.stdout, /升级/)
    // A git checkout installs itself; an npm install uses the published spec.
    assert.match(upgrade.stdout, new RegExp(`add (${PKG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|${OWN.name}@${OWN.version})`))
    writePluginInstall(box.home, OWN.version)
    const skip = run(['plugin', '--dry-run'], box.env)
    assert.match(skip.stdout, /已是最新/)
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

test('the pinned bridge hash manifest covers every downloaded file', () => {
  const source = readFileSync(join(PKG, 'bin', 'install.mjs'), 'utf8')
  const fileList = source.match(/const BRIDGE_FILES = \[([\s\S]*?)\n\]/)[1]
  const files = [...fileList.matchAll(/'([^']+)'/g)].map((match) => match[1])
  const mapBody = source.match(/const BRIDGE_SHA256 = \{([\s\S]*?)\n\}/)[1]
  const map = new Map([...mapBody.matchAll(/'([^']+)': '([0-9a-f]{64})'/g)].map((match) => [match[1], match[2]]))
  assert.equal(map.size, files.length)
  for (const file of files) assert.match(map.get(file) ?? '', /^[0-9a-f]{64}$/, file)
  assert.match(source.match(/const BRIDGE_PINNED = '([^']+)'/)[1], /^[0-9a-f]{40}$/)
})

test('a local directory --from is copied to a stable host path, not linked', () => {
  const box = sandbox()
  try {
    const source = join(box.root, 'source-600')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: OWN.name, version: OWN.version }))
    chmodSync(source, 0o700)
    const log = join(box.root, 'fake.log')
    const env = { ...box.env, FAKE_LOG: log }
    const out = run(['plugin', '--from', source], env)
    assert.equal(out.status, 0, out.stderr)
    const stable = join(box.home, 'dsh-go', 'plugins', OWN.name)
    assert.equal(existsSync(join(stable, 'package.json')), true, 'the package was copied under DSH_HOME')
    const called = readFileSync(log, 'utf8')
    assert.ok(called.includes(stable), called)
    assert.ok(!called.includes(source), 'pnpm must not be pointed at the source directory')
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

// ── H1/H5: permission fixes stay inside $DSH_HOME and never follow symlinks ──

test('an install does not follow a profile symlink outside DSH_HOME and keeps modes', () => {
  const box = sandbox()
  try {
    const external = join(box.root, 'external-plugin')
    mkdirSync(join(external, 'lib'), { recursive: true })
    writeFileSync(join(external, '.env'), 'token\n')
    writeFileSync(join(external, 'tool'), '#!/bin/sh\n')
    writeFileSync(join(external, 'lib', 'run.sh'), '#!/bin/sh\n')
    chmodSync(join(external, '.env'), 0o600)
    chmodSync(join(external, 'tool'), 0o700)
    chmodSync(join(external, 'lib', 'run.sh'), 0o700)
    chmodSync(join(external, 'lib'), 0o700)
    chmodSync(external, 0o700)

    const profile = join(box.home, 'profiles', 'web')
    mkdirSync(join(profile, 'node_modules'), { recursive: true })
    symlinkSync(external, join(profile, 'node_modules', 'external-plugin'))
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'external-plugin': `link:${external}`, [OWN.name]: OWN.version } }))
    const other = join(profile, 'node_modules', 'other')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, 'secret.txt'), 'secret\n')
    chmodSync(join(other, 'secret.txt'), 0o600)
    chmodSync(profile, 0o700)

    const out = run(['plugin', '--force'], box.env)
    assert.equal(out.status, 0, out.stderr)

    assert.equal(modeOf(join(external, '.env')), 0o600, '0600 outside DSH_HOME must not become 0644')
    assert.equal(modeOf(join(external, 'tool')), 0o700, 'executable bit outside DSH_HOME must stay')
    assert.equal(modeOf(join(external, 'lib', 'run.sh')), 0o700)
    assert.equal(modeOf(join(external, 'lib')), 0o700)
    assert.equal(modeOf(external), 0o700)
    assert.equal(modeOf(join(other, 'secret.txt')), 0o600, 'unrelated profile files must not be chmodded (H5)')
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

// ── H3: dry-run must not touch an existing profile's permissions ────────────

test('--dry-run does not change permissions of an existing install', () => {
  const box = sandbox()
  try {
    const profile = writePluginInstall(box.home, '0.0.1')
    const other = join(profile, 'node_modules', 'other')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, 'secret.txt'), 'secret\n')
    chmodSync(join(other, 'secret.txt'), 0o600)
    chmodSync(join(profile, 'node_modules', OWN.name, 'package.json'), 0o600)
    chmodSync(profile, 0o700)

    const out = run(['plugin', '--dry-run'], box.env)
    assert.equal(out.status, 0, out.stderr)
    assert.match(out.stdout, /\[dry-run\]/)
    assert.equal(modeOf(join(other, 'secret.txt')), 0o600, 'dry-run must not chmod unrelated files')
    assert.equal(modeOf(join(profile, 'node_modules', OWN.name, 'package.json')), 0o600, 'dry-run must not chmod the installed package')
    assert.equal(modeOf(profile), 0o700, 'dry-run must not chmod the profile directory')
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

// ── H4: --from the host copy itself must not be deleted before copying ──────

test('--from pointing at the host copy itself does not delete it', () => {
  const box = sandbox()
  try {
    const stable = join(box.home, 'dsh-go', 'plugins', OWN.name)
    mkdirSync(stable, { recursive: true })
    writeFileSync(join(stable, 'package.json'), JSON.stringify({ name: OWN.name, version: OWN.version }))
    const log = join(box.root, 'fake.log')
    const out = run(['plugin', '--from', stable], { ...box.env, FAKE_LOG: log })
    assert.equal(out.status, 0, out.stderr)
    assert.match(out.stdout, /源目录就是本机插件副本/)
    assert.equal(existsSync(join(stable, 'package.json')), true, 'the host copy must survive')
    assert.ok(readFileSync(log, 'utf8').includes(stable), 'the existing copy is what gets installed')
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

// ── H2: --force bridge reinstall backs up local hardening and says what it replaces ──

test('--force --dry-run lists existing bridge files that differ from the pin without writing', () => {
  const box = sandbox()
  try {
    const bridge = join(box.home, 'dsh-go', 'plugins', 'dsh-go-bridge')
    writeSyntheticBridge(bridge)
    writeFileSync(join(bridge, 'lib', 'index.js'), '// local hardening\n')
    mkdirSync(join(box.home, 'profiles', 'web'), { recursive: true })
    writeFileSync(join(box.home, 'profiles', 'web', 'package.json'), JSON.stringify({ dependencies: { 'dsh-go-bridge': `link:${bridge}` } }))

    const out = run(['bridge', '--force', '--dry-run'], box.env)
    assert.equal(out.status, 0, out.stderr)
    assert.match(out.stdout, /33 个文件与本安装器 pin 的版本不同/)
    assert.match(out.stdout, /lib\/index\.js/)
    assert.match(out.stdout, /\[dry-run\] download 33 files/)
    assert.match(out.stdout, /\[dry-run\] backup/)
    assert.equal(readFileSync(join(bridge, 'lib', 'index.js'), 'utf8'), '// local hardening\n', 'dry-run must not replace anything')
    assert.deepEqual(readdirSync(join(box.home, 'dsh-go', 'plugins')), ['dsh-go-bridge'])
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

test('--force bridge reinstall keeps a timestamped backup of the old bridge', () => {
  const box = sandbox()
  try {
    const plugins = join(box.home, 'dsh-go', 'plugins')
    const bridge = join(plugins, 'dsh-go-bridge')
    writeSyntheticBridge(bridge)
    writeFileSync(join(bridge, 'lib', 'index.js'), '// local hardening\n')
    mkdirSync(join(box.home, 'profiles', 'web'), { recursive: true })
    writeFileSync(join(box.home, 'profiles', 'web', 'package.json'), JSON.stringify({ dependencies: { 'dsh-go-bridge': `link:${bridge}` } }))

    const upstream = join(box.root, 'upstream')
    writeSyntheticBridge(upstream)
    const stub = join(box.root, 'stub-fetch.mjs')
    writeFileSync(stub, FETCH_STUB)
    const env = { ...box.env, STUB_UPSTREAM: upstream, DSH_GO_BRIDGE_REF: '0123456789abcdef0123456789abcdef01234567' }
    const out = run(['bridge', '--force'], env, ['--import', stub])
    assert.equal(out.status, 0, out.stderr)
    assert.match(out.stdout, /旧桥接已备份到/)
    assert.equal(readFileSync(join(bridge, 'lib', 'index.js'), 'utf8'), 'synthetic lib/index.js\n', 'pinned files are swapped in')
    const backups = readdirSync(plugins).filter((name) => /^dsh-go-bridge\.bak-\d{8}-\d{6}(-\d+)?$/.test(name))
    assert.equal(backups.length, 1, `expected one backup, got ${backups.join(',')}`)
    assert.match(readFileSync(join(plugins, backups[0], 'lib', 'index.js'), 'utf8'), /local hardening/)
    assert.equal(readdirSync(plugins).some((name) => name.includes('.partial-')), false, 'staging dir is cleaned up')
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

// ── H8: status explains an unreadable install instead of printing [object Object] ──

test('status explains an unreadable install instead of printing [object Object]', (t) => {
  const box = sandbox()
  try {
    const profile = writePluginInstall(box.home, OWN.version)
    const pkgJson = join(profile, 'node_modules', OWN.name, 'package.json')

    const capture = (fn) => {
      try {
        return { status: 0, stdout: fn(), stderr: '' }
      } catch (error) {
        return { status: error.status, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }
      }
    }

    let out
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      if (process.platform !== 'linux') return t.skip('needs setpriv (linux) to drop root for a 0600 file')
      try {
        execFileSync('setpriv', ['--help'], { stdio: 'ignore' })
      } catch {
        return t.skip('setpriv is not available')
      }
      const pkgCopy = join(box.root, 'pkg')
      mkdirSync(pkgCopy, { recursive: true })
      cpSync(join(PKG, 'bin'), join(pkgCopy, 'bin'), { recursive: true })
      cpSync(join(PKG, 'lib'), join(pkgCopy, 'lib'), { recursive: true })
      cpSync(join(PKG, 'package.json'), join(pkgCopy, 'package.json'))
      chmodTree(box.root, 0o755, 0o644)
      writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { [OWN.name]: OWN.version } }))
      chmodSync(join(profile, 'node_modules', OWN.name, 'package.json'), 0o600)
      out = capture(() => execFileSync('setpriv', ['--reuid=65534', '--regid=65534', '--clear-groups', 'env', `DSH_HOME=${box.home}`, 'PATH=/usr/bin:/bin', process.execPath, join(pkgCopy, 'bin', 'install.mjs'), 'status'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
    } else {
      chmodSync(pkgJson, 0o000)
      out = run(['status'], box.env)
      chmodSync(pkgJson, 0o644)
    }
    assert.match(out.stdout, /当前用户读不到/)
    assert.doesNotMatch(out.stdout, /\[object Object\]/)
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

// ── H10: dry-run prints the plan before requiring dsh/pnpm ──────────────────

test('--dry-run prints the plan even when dsh and pnpm are missing', () => {
  const box = sandbox()
  try {
    const empty = join(box.root, 'empty-path')
    mkdirSync(empty)
    const out = run(['install', '--dry-run'], { ...box.env, PATH: empty })
    assert.equal(out.status, 0, out.stderr)
    assert.match(out.stdout, /\[dry-run\] download 33 files/)
    assert.doesNotMatch(out.stdout, /找不到 dsh/)
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

// ── H11: status checks bridge bytes against the pin and registration ───────

test('status reports a corrupted or unregistered bridge instead of "33 files complete"', () => {
  const box = sandbox()
  try {
    const bridge = join(box.home, 'dsh-go', 'plugins', 'dsh-go-bridge')
    writeSyntheticBridge(bridge)
    const profile = join(box.home, 'profiles', 'web')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: {} }))

    let out = run(['status'], box.env)
    assert.match(out.stdout, /33 个文件与 pin 不同/)
    assert.match(out.stdout, /未注册到 profile/)

    writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-go-bridge': `link:${bridge}` } }))
    out = run(['status'], box.env)
    assert.doesNotMatch(out.stdout, /未注册到 profile/)

    rmSync(join(bridge, 'lib', 'index.js'))
    out = run(['status'], box.env)
    assert.match(out.stdout, /不完整（缺 1 个文件）/)
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

// ── H16: running the installer from the host copy must not delete it ────────

test('the installer refuses to copy itself when run from the host plugin copy', () => {
  const box = sandbox()
  try {
    const stable = join(box.home, 'dsh-go', 'plugins', OWN.name)
    mkdirSync(stable, { recursive: true })
    cpSync(join(PKG, 'bin'), join(stable, 'bin'), { recursive: true })
    cpSync(join(PKG, 'lib'), join(stable, 'lib'), { recursive: true })
    cpSync(join(PKG, 'package.json'), join(stable, 'package.json'))
    const out = spawn(join(stable, 'bin', 'install.mjs'), ['plugin'], { ...box.env, FAKE_FAIL: '1' })
    assert.notEqual(out.status, 0)
    assert.match(`${out.stdout}${out.stderr}`, /运行在宿主插件副本里/)
    assert.equal(existsSync(join(stable, 'package.json')), true, 'the host copy must survive the failed npm install')
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

// ── H17: dead helpers and stale comments must stay gone ────────────────────

test('the installer no longer carries dead bridge helpers', () => {
  assert.doesNotMatch(SOURCE, /function bridgePresent\(/)
  assert.doesNotMatch(SOURCE, /function has\(/)
  assert.doesNotMatch(SOURCE, /readable-check below still warns/)
})

// ── pseudo filesystems: a DSH_HOME under /proc must fail fast, not hang ────

test('a DSH_HOME under /proc fails fast instead of hanging on mkdir', () => {
  const box = sandbox()
  try {
    const out = run(['install'], { ...box.env, DSH_HOME: '/proc/audit-dsh-should-not-hang' }, [], { timeout: 10_000 })
    assert.notEqual(out.status, 0)
    assert.match(out.stderr, /\/proc|sys|dev/)
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})

test('--from a pseudo filesystem directory fails fast', () => {
  const box = sandbox()
  try {
    const out = run(['plugin', '--from', '/proc/self'], box.env, [], { timeout: 10_000 })
    assert.notEqual(out.status, 0)
    assert.match(out.stderr, /\/proc|sys|dev/)
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
})
