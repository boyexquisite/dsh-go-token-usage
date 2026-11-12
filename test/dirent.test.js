// Android proot (and some FUSE filesystems) lie about d_type: a regular session
// log can be reported as a symlink, so the scan must stat instead of trusting
// Dirent.isFile(). These cases pin that down with real symlinks.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { UsageLedger } from '../lib/ledger.js'
import { totalTokens } from '../lib/tally.js'

const NOW = Date.now()
const header = JSON.stringify({ type: 'session', version: 4, id: 'session-aaa', createdAt: NOW, cwd: '/p' })
const call = JSON.stringify({ type: 'assistant/message', seq: 1, time: NOW, data: { turn: 1, step: 1, usage: { inputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 0, outputTokens: 5 }, message: { source: { provider: 'p', model: 'm1' } } } })
const frame = (lines) => zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'))
const logBody = () => frame([header, call])
const tokens = (ledger) => totalTokens(ledger.allTime())

test('a session log that dirent reports as a symlink is still read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dirent-file-'))
  try {
    const dir = join(root, 'sessions', 'proj', 'session-aaa')
    mkdirSync(dir, { recursive: true })
    const real = join(root, 'real-log.bin')
    writeFileSync(real, logBody())
    symlinkSync(real, join(dir, 'session.v4.jsonl.zstd'))
    const ledger = new UsageLedger({ home: root, now: () => NOW })
    await ledger.refresh()
    assert.equal(tokens(ledger), 115)
    assert.equal(ledger.sourceState().logFiles, 1)
    ledger.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('symlinked project and session directories are still scanned', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dirent-dir-'))
  try {
    const realSession = join(root, 'store', 'session-aaa')
    mkdirSync(realSession, { recursive: true })
    writeFileSync(join(realSession, 'session.v4.jsonl.zstd'), logBody())
    const realProject = join(root, 'store', 'proj')
    mkdirSync(realProject, { recursive: true })
    symlinkSync(realSession, join(realProject, 'session-aaa'))
    mkdirSync(join(root, 'sessions'), { recursive: true })
    symlinkSync(realProject, join(root, 'sessions', 'proj'))
    const ledger = new UsageLedger({ home: root, now: () => NOW })
    await ledger.refresh()
    assert.equal(tokens(ledger), 115)
    assert.equal(ledger.sourceState().logFiles, 1)
    ledger.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a directory named like a log is ignored, and broken links do not crash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dirent-bad-'))
  try {
    const dir = join(root, 'sessions', 'proj', 'session-aaa')
    mkdirSync(join(dir, 'session.v4.jsonl.zstd'), { recursive: true })
    mkdirSync(join(root, 'sessions', 'proj', 'session-empty'), { recursive: true })
    symlinkSync(join(root, 'missing-target'), join(root, 'sessions', 'proj', 'session-empty', 'session.v4.jsonl.zstd'))
    const ledger = new UsageLedger({ home: root, now: () => NOW })
    await ledger.refresh()
    assert.equal(tokens(ledger), 0)
    assert.equal(ledger.sourceState().logFiles, 0)
    ledger.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
