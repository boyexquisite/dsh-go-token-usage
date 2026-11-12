// Rooted-phone / ADB / hostile-filesystem hardening: a session path may be a
// FIFO, a device, a symlink to a huge file or a log full of garbage. None of that
// may hang the engine, blow memory, or read unbounded bytes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { parse } from 'node:path'
import { UsageLedger } from '../lib/ledger.js'
import { totalTokens } from '../lib/tally.js'
import { historyNote } from '../lib/view.js'

const NOW = Date.now()
const POSIX = process.platform !== 'win32'
const header = JSON.stringify({ type: 'session', version: 4, id: 'session-a', createdAt: NOW, cwd: '/p' })
const call = (seq = 1) => JSON.stringify({ type: 'assistant/message', seq, time: NOW, data: { turn: 1, step: seq, usage: { inputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 0, outputTokens: 5 }, message: { source: { provider: 'p', model: 'm1' } } } })
const frame = (lines) => zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'))
const tokens = (ledger) => totalTokens(ledger.allTime())

function home() {
  const root = mkdtempSync(join(tmpdir(), 'harden-'))
  const dir = join(root, 'sessions', 'proj', 'session-a')
  mkdirSync(dir, { recursive: true })
  return { root, dir }
}

test('a FIFO posing as a session log is skipped without hanging', { skip: !POSIX && 'needs mkfifo' }, async () => {
  const h = home()
  try {
    writeFileSync(join(h.dir, 'session.v4.jsonl.zstd'), frame([header, call()]))
    const other = join(h.root, 'sessions', 'proj', 'session-b')
    mkdirSync(other, { recursive: true })
    execFileSync('mkfifo', [join(other, 'session.v4.jsonl.zstd')])
    const ledger = new UsageLedger({ home: h.root, now: () => NOW })
    await ledger.refresh()
    assert.equal(tokens(ledger), 115, 'the real log is still counted')
    ledger.dispose()
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('an oversized log is skipped visibly instead of being read', async () => {
  const h = home()
  try {
    writeFileSync(join(h.dir, 'session.v4.jsonl.zstd'), frame([header, call()]))
    const big = join(h.root, 'sessions', 'proj', 'session-big')
    mkdirSync(big, { recursive: true })
    const file = join(big, 'session.v4.jsonl.zstd')
    writeFileSync(file, Buffer.alloc(64))
    truncateSync(file, 10 * 1024 * 1024) // sparse, still 10MB by stat
    const ledger = new UsageLedger({ home: h.root, now: () => NOW, maxLogBytes: 1024 })
    await ledger.refresh()
    assert.equal(ledger.sourceState().oversizedLogs, 1)
    assert.match(historyNote(ledger, 'zh-CN'), /日志过大/)
    assert.equal(tokens(ledger), 115)
    ledger.dispose()
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('a symlink to a huge sparse file is refused by the size cap', async () => {
  const h = home()
  try {
    const huge = join(h.root, 'huge.bin')
    writeFileSync(huge, Buffer.alloc(32))
    truncateSync(huge, 50 * 1024 * 1024)
    symlinkSync(huge, join(h.dir, 'session.v4.jsonl.zstd'))
    const ledger = new UsageLedger({ home: h.root, now: () => NOW, maxLogBytes: 1024 })
    await ledger.refresh()
    assert.equal(ledger.sourceState().oversizedLogs, 1)
    assert.equal(tokens(ledger), 0)
    ledger.dispose()
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('one absurdly long line does not hide the usage lines after it', async () => {
  const h = home()
  try {
    const giant = JSON.stringify({ type: 'tool/result', seq: 1, time: NOW, data: { text: 'z'.repeat(500 * 1024) } })
    writeFileSync(join(h.dir, 'session.v4.jsonl.zstd'), frame([header, giant, call()]))
    const ledger = new UsageLedger({ home: h.root, now: () => NOW, maxLineBytes: 64 * 1024 })
    await ledger.refresh()
    assert.equal(tokens(ledger), 115)
    ledger.dispose()
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('cache files are private to the engine user', { skip: !POSIX && 'posix modes only' }, async () => {
  const h = home()
  try {
    writeFileSync(join(h.dir, 'session.v4.jsonl.zstd'), frame([header, call()]))
    const ledger = new UsageLedger({ home: h.root, now: () => NOW })
    await ledger.refresh()
    ledger.dispose()
    const dir = join(h.root, 'cache', 'dsh-go-token-usage')
    assert.equal(statSync(join(dir, 'index.json')).mode & 0o777, 0o600)
    assert.equal(statSync(dir).mode & 0o777, 0o700)
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('a FIFO replacing index.json does not hang the load', { skip: !POSIX && 'needs mkfifo' }, async () => {
  const h = home()
  try {
    writeFileSync(join(h.dir, 'session.v4.jsonl.zstd'), frame([header, call()]))
    const cacheDir = join(h.root, 'cache', 'dsh-go-token-usage')
    mkdirSync(cacheDir, { recursive: true })
    execFileSync('mkfifo', [join(cacheDir, 'index.json')])
    const ledger = new UsageLedger({ home: h.root, now: () => NOW })
    assert.equal(ledger.sourceState().cacheDamaged, true)
    await ledger.refresh()
    assert.equal(tokens(ledger), 115)
    ledger.dispose()
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('a zero ctime (filesystem without ctime support) does not force re-reads', async () => {
  const h = home()
  try {
    writeFileSync(join(h.dir, 'session.v4.jsonl.zstd'), frame([header, call()]))
    const first = new UsageLedger({ home: h.root, now: () => NOW })
    await first.refresh()
    first.dispose()
    const fs = await import('node:fs')
    const cachePath = join(h.root, 'cache', 'dsh-go-token-usage', 'index.json')
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
    for (const rec of Object.values(cache.files)) rec.ctimeMs = 0
    fs.writeFileSync(cachePath, JSON.stringify(cache))
    const second = new UsageLedger({ home: h.root, now: () => NOW })
    await second.refresh()
    assert.equal(second.parsedFiles, 0, 'unchanged files are not re-read when ctime is unavailable')
    assert.equal(tokens(second), 115)
    second.dispose()
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('the scan ignores lying dirent types entirely', async () => {
  const h = home()
  const fsp = (await import('node:fs/promises')).default
  const original = fsp.readdir
  try {
    writeFileSync(join(h.dir, 'session.v4.jsonl.zstd'), frame([header, call()]))
    fsp.readdir = async (path, options) => {
      const entries = await original(path, options)
      if (options?.withFileTypes !== true) return entries
      // proot-style lie: every entry claims to be a symlink, never a file/dir.
      return entries.map((entry) => ({
        name: entry.name,
        isFile: () => false,
        isDirectory: () => false,
        isSymbolicLink: () => true,
        isFIFO: () => false,
        isSocket: () => false,
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
      }))
    }
    const ledger = new UsageLedger({ home: h.root, now: () => NOW })
    await ledger.refresh()
    assert.equal(tokens(ledger), 115)
    ledger.dispose()
  } finally {
    fsp.readdir = original
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('a cache directory symlinked outside $DSH_HOME is never written through', async () => {
  const h = home()
  const outside = mkdtempSync(join(tmpdir(), 'harden-outside-'))
  try {
    writeFileSync(join(h.dir, 'session.v4.jsonl.zstd'), frame([header, call()]))
    mkdirSync(join(h.root, 'cache'), { recursive: true })
    symlinkSync(outside, join(h.root, 'cache', 'dsh-go-token-usage'))
    const ledger = new UsageLedger({ home: h.root, now: () => NOW })
    await ledger.refresh()
    ledger.noteLive('session-a', 2, NOW, { input: 1, cached: 1, cacheWrite: 0, output: 1, reasoning: 0, calls: 1 }, 'm1', 1, 'p', 2)
    ledger.dispose()
    const { readdirSync } = await import('node:fs')
    assert.deepEqual(readdirSync(outside), [], 'nothing may be written outside the home')
    await ledger.refresh()
    assert.equal(tokens(ledger), 118)
  } finally {
    rmSync(h.root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('a directory with too many generations is bounded and still scans', async () => {
  const h = home()
  try {
    for (let version = 1; version <= 20; version += 1) {
      const body = frame([header, call(version)])
      writeFileSync(join(h.dir, `session.v${version}.jsonl.zstd`), body)
    }
    const ledger = new UsageLedger({ home: h.root, now: () => NOW })
    await ledger.refresh()
    assert.equal(tokens(ledger), 115, 'the newest generation is still counted')
    assert.equal(ledger.records.size <= 16, true, 'candidate generations are bounded')
    ledger.dispose()
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('a cache written by an older build is tightened to private modes on load', { skip: !POSIX && 'posix modes only' }, async () => {
  const h = home()
  try {
    writeFileSync(join(h.dir, 'session.v4.jsonl.zstd'), frame([header, call()]))
    const first = new UsageLedger({ home: h.root, now: () => NOW })
    await first.refresh()
    first.dispose()
    const fs = await import('node:fs')
    const dir = join(h.root, 'cache', 'dsh-go-token-usage')
    const file = join(dir, 'index.json')
    fs.chmodSync(file, 0o644)
    fs.chmodSync(dir, 0o755)
    const second = new UsageLedger({ home: h.root, now: () => NOW })
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
    assert.equal(tokens(second), 115)
    second.dispose()
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})
