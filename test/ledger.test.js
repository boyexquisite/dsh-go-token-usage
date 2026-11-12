import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { UsageLedger } from '../lib/ledger.js'
import { totalTokens } from '../lib/tally.js'

const NOW = new Date(2026, 10, 12, 12, 0, 0).getTime() // 2026-11-12 12:00 local
const DAY = (n) => NOW - n * 24 * 60 * 60 * 1000

const header = (id) => JSON.stringify({ type: 'session', version: 4, id, createdAt: NOW, cwd: '/p' })
const call = (seq, time, input, cached, output, turn = 1) =>
  JSON.stringify({
    type: 'assistant/message',
    seq,
    time,
    data: {
      turn,
      step: 1,
      usage: { inputTokens: input, cacheReadTokens: cached, cacheWriteTokens: 0, outputTokens: output, totalTokens: input + cached + output },
      message: { source: { provider: 'p', model: 'm1' } },
    },
  })
const frame = (lines) => zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'))

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-usage-'))
  const dir = join(home, 'sessions', 'proj', 'session-aaa')
  mkdirSync(dir, { recursive: true })
  return { home, dir, file: join(dir, 'session.v4.jsonl.zstd') }
}

test('scan: folds every assistant/message.usage into day and session totals', async () => {
  const { home, file } = makeHome()
  try {
    writeFileSync(file, frame([header('session-aaa'), call(1, DAY(1), 10, 100, 5), call(2, NOW, 20, 200, 6)]))
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    // today carries only the second call; yesterday the first
    assert.equal(totalTokens(ledger.window(1)), 226)
    assert.equal(totalTokens(ledger.window(7)), 341)
    assert.equal(totalTokens(ledger.session('session-aaa')), 341)
    // 「session-<uuid>」 and「<uuid>」 are the same chat
    assert.equal(totalTokens(ledger.session('aaa')), 341)
    assert.equal(ledger.session('session-aaa').calls, 2)
    assert.equal(ledger.coveredDays(30), 2) // today and yesterday have calls
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('live call counts before the file catches up and is not doubled afterwards', async () => {
  const { home, file } = makeHome()
  try {
    writeFileSync(file, frame([header('session-aaa'), call(1, NOW, 10, 100, 5)]))
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    assert.equal(totalTokens(ledger.window(1)), 115)

    ledger.noteLive('session-aaa', 2, NOW, { input: 7, cached: 70, cacheWrite: 0, output: 3, reasoning: 0, calls: 1 }, 'm1', 1)
    assert.equal(totalTokens(ledger.window(1)), 195)
    assert.equal(ledger.pending.size, 1)

    appendFileSync(file, frame([call(2, NOW, 7, 70, 3)]))
    await ledger.refresh()
    assert.equal(totalTokens(ledger.window(1)), 195, 'file data replaces the pending entry')
    assert.equal(ledger.pending.size, 0)
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the same live event twice is counted once', () => {
  const { home } = makeHome()
  try {
    const ledger = new UsageLedger({ home, now: () => NOW })
    const usage = { input: 1, cached: 10, cacheWrite: 0, output: 1, reasoning: 0, calls: 1 }
    ledger.noteLive('session-aaa', 4, NOW, usage, 'm1', 2)
    ledger.noteLive('session-aaa', 4, NOW, usage, 'm1', 2)
    assert.equal(totalTokens(ledger.window(1)), 12)
    assert.equal(ledger.sessionTurnsOf('session-aaa').get(2).calls, 1)
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('per-turn totals and model totals are kept per chat and per day', async () => {
  const { home, file } = makeHome()
  try {
    writeFileSync(file, frame([header('session-aaa'), call(1, NOW, 1, 10, 1, 1), call(2, NOW, 2, 20, 2, 1), call(3, NOW, 3, 30, 3, 2)]))
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    const turns = ledger.sessionTurnsOf('session-aaa')
    assert.equal(turns.get(1).calls, 2)
    assert.equal(turns.get(2).calls, 1)
    assert.deepEqual(ledger.todayModels(), [['p', 'm1', 72]])
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a second instance reuses the cached index', async () => {
  const { home, file } = makeHome()
  try {
    writeFileSync(file, frame([header('session-aaa'), call(1, NOW, 10, 100, 5)]))
    const first = new UsageLedger({ home, now: () => NOW })
    await first.refresh()
    first.dispose() // flushes index.json
    const second = new UsageLedger({ home, now: () => NOW })
    assert.equal(second.records.size, 1)
    assert.equal(totalTokens(second.window(1)), 115)
    second.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('seeded fork logs do not double-count the inherited prefix', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-seeded-'))
  try {
    const dir = join(home, 'sessions', 'proj', 'fork-bbb')
    mkdirSync(dir, { recursive: true })
    const seededHeader = JSON.stringify({ type: 'session', version: 4, id: 'fork-bbb', createdAt: NOW, cwd: '/p', isSeeded: true, parentSession: 'session-aaa', delegationDepth: 1 })
    const endSeed = JSON.stringify({ type: 'session/end-seed', seq: 2, time: NOW, data: { inherited: true } })
    const lines = [seededHeader, call(0, NOW, 100, 1000, 10), call(1, NOW, 100, 1000, 10), endSeed, call(3, NOW, 5, 50, 5)]
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), frame(lines))
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    // Only the fork's own call (65 tokens) is counted; the two inherited calls belong to the parent log.
    assert.equal(totalTokens(ledger.window(1)), 60)
    assert.equal(ledger.session('fork-bbb').calls, 1)
    const rec = [...ledger.records.values()][0]
    assert.equal(rec.isSeeded, true)
    assert.equal(rec.inheritedCut, 2)
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('recount re-reads the logs and agrees with the live ledger', async () => {
  const { home, file } = makeHome()
  try {
    writeFileSync(file, frame([header('session-aaa'), call(1, NOW, 10, 100, 5), call(2, NOW, 20, 200, 6)]))
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    const recount = await ledger.recount()
    assert.equal(totalTokens(recount.totals), totalTokens(ledger.allTime()))
    assert.equal(recount.totals.calls, ledger.allTime().calls)
    assert.equal(recount.files, 1)
    // A call the file has not caught up with is pending, not a mismatch.
    ledger.noteLive('session-aaa', 3, NOW, { input: 1, cached: 10, cacheWrite: 0, output: 1, reasoning: 0, calls: 1 }, 'm1', 1, 'p')
    const after = await ledger.recount()
    assert.equal(totalTokens(after.totals), totalTokens(recount.totals))
    assert.equal(ledger.pendingCount(), 1)
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
