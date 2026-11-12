// PATH hardening: a rooted phone or an `adb shell`-started host often has
// world-writable directories on PATH; those must never win an executable lookup.
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveExecutable } from '../lib/exec.js'

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
