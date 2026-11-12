// Installer behaviour that used to bite users: dry-run side effects, half-finished
// bridge downloads, ignored upgrades and loose argument parsing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
const INSTALLER = join(PKG, 'bin', 'install.mjs')
const OWN = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'))

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'installer-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  for (const name of ['dsh', 'pnpm']) {
    writeFileSync(join(bin, name), '#!/bin/sh\nif [ -n "$FAKE_LOG" ]; then echo "$@" >> "$FAKE_LOG"; fi\nexit 0\n', { mode: 0o755 })
  }
  const env = { ...process.env, DSH_HOME: join(root, 'dsh'), PATH: `${bin}:${process.env.PATH}` }
  return { root, home: env.DSH_HOME, env }
}

function run(args, env) {
  try {
    return { status: 0, stdout: execFileSync(process.execPath, [INSTALLER, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (error) {
    return { status: error.status, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }
  }
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
