// PATH hardening: a rooted phone or an `adb shell`-started host often has
// world-writable directories on PATH; those must never win an executable lookup.
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isPseudoFsPath, resolveExecutable, resolveHome } from '../lib/exec.js'

const POSIX = process.platform !== 'win32'

test('an executable is not taken from a world-writable directory', { skip: !POSIX && 'posix modes only' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'exec-'))
  const evilDir = join(root, 'evil')
  const safeDir = join(root, 'safe')
  try {
    mkdirSync(evilDir)
    mkdirSync(safeDir)
    chmodSync(evilDir, 0o777)
    chmodSync(safeDir, 0o755)
    writeFileSync(join(evilDir, 'faketool'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    writeFileSync(join(safeDir, 'faketool'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const savedPath = process.env.PATH
    process.env.PATH = `${evilDir}:${safeDir}`
    try {
      assert.equal(resolveExecutable('faketool'), join(safeDir, 'faketool'))
      process.env.PATH = evilDir
      assert.equal(resolveExecutable('faketool'), undefined, 'only a hijackable copy exists')
    } finally {
      process.env.PATH = savedPath
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a non-executable file is not treated as a command', { skip: !POSIX && 'posix modes only' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'exec-'))
  const dir = join(root, 'bin')
  try {
    mkdirSync(dir)
    writeFileSync(join(dir, 'plain'), 'not executable\n', { mode: 0o644 })
    const savedPath = process.env.PATH
    process.env.PATH = dir
    try {
      assert.equal(resolveExecutable('plain'), undefined)
    } finally {
      process.env.PATH = savedPath
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── H12: relative PATH entries and writable executables are never trusted ──

test('relative PATH entries are ignored so the result is always absolute', { skip: !POSIX && 'posix modes only' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'exec-'))
  const savedPath = process.env.PATH
  const savedCwd = process.cwd()
  try {
    const dir = join(root, 'bin')
    mkdirSync(dir)
    writeFileSync(join(dir, 'dsh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    process.chdir(root)
    process.env.PATH = '.'
    assert.equal(resolveExecutable('dsh'), undefined, 'PATH="." must not resolve')
    process.env.PATH = 'bin'
    assert.equal(resolveExecutable('dsh'), undefined, 'a relative PATH entry must not resolve')
    process.env.PATH = join(root, 'bin')
    assert.equal(resolveExecutable('dsh'), join(root, 'bin', 'dsh'), 'absolute PATH entries still work')
  } finally {
    process.env.PATH = savedPath
    process.chdir(savedCwd)
    rmSync(root, { recursive: true, force: true })
  }
})

test('a group- or world-writable executable or directory is ignored', { skip: !POSIX && 'posix modes only' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'exec-'))
  const savedPath = process.env.PATH
  try {
    const groupWritable = join(root, 'gw')
    mkdirSync(groupWritable)
    chmodSync(groupWritable, 0o775)
    writeFileSync(join(groupWritable, 'tool-gw'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    process.env.PATH = groupWritable
    assert.equal(resolveExecutable('tool-gw'), undefined, '0775 dirs are writable by the group')

    const safe = join(root, 'safe')
    mkdirSync(safe)
    chmodSync(safe, 0o755)
    writeFileSync(join(safe, 'tool-open'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    writeFileSync(join(safe, 'tool-group'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    writeFileSync(join(safe, 'tool-ok'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    chmodSync(join(safe, 'tool-open'), 0o777)
    chmodSync(join(safe, 'tool-group'), 0o775)
    process.env.PATH = safe
    assert.equal(resolveExecutable('tool-open'), undefined, 'a world-writable file can be replaced')
    assert.equal(resolveExecutable('tool-group'), undefined, 'a group-writable file can be replaced')
    assert.equal(resolveExecutable('tool-ok'), join(safe, 'tool-ok'))
  } finally {
    process.env.PATH = savedPath
    rmSync(root, { recursive: true, force: true })
  }
})

// ── resolveHome: unusable values fall back instead of poisoning downstream mkdir ──

test('resolveHome ignores unusable and pseudo-filesystem paths', () => {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, DSH_HOME: process.env.DSH_HOME }
  const savedCwd = process.cwd()
  try {
    process.env.HOME = '/home/app'
    delete process.env.USERPROFILE
    process.env.DSH_HOME = '/proc/self/fake-dsh'
    assert.equal(isPseudoFsPath(resolveHome()), false, 'DSH_HOME under /proc must fall back')
    assert.equal(resolveHome(), '/home/app/.dsh')
    assert.equal(isPseudoFsPath(resolveHome('/sys/whatever')), false, 'explicit /sys path must fall back')

    delete process.env.DSH_HOME
    process.env.HOME = '/'
    assert.equal(resolveHome(), join(savedCwd, '.dsh'), 'HOME=/ is unusable and falls back to cwd')
    process.env.HOME = '/dev/shm/fake-home'
    assert.equal(resolveHome(), join(savedCwd, '.dsh'), 'HOME under /dev must fall back')
    process.env.DSH_HOME = '/custom/dsh'
    assert.equal(resolveHome(), '/custom/dsh')
  } finally {
    process.env.HOME = saved.HOME
    if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = saved.USERPROFILE
    if (saved.DSH_HOME === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved.DSH_HOME
  }
})

test('isPseudoFsPath only matches /proc, /sys and /dev', () => {
  assert.equal(isPseudoFsPath('/proc'), true)
  assert.equal(isPseudoFsPath('/proc/1/fd'), true)
  assert.equal(isPseudoFsPath('/sys/kernel'), true)
  assert.equal(isPseudoFsPath('/dev/null'), true)
  assert.equal(isPseudoFsPath('/procfs/fake'), false)
  assert.equal(isPseudoFsPath('/home/dev'), false)
  assert.equal(isPseudoFsPath(''), false)
})
