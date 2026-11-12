import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, cpSync } from 'node:fs'
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
      step: seq + 1, // distinct steps: each call is its own settlement, like the engine's logs
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

test('a vanished log keeps its history instead of dropping it to zero', async () => {
  const { home, file } = makeHome()
  try {
    writeFileSync(file, frame([header('session-aaa'), call(1, DAY(1), 10, 100, 5), call(2, NOW, 20, 200, 6)]))
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    assert.equal(totalTokens(ledger.allTime()), 341)
    assert.equal(ledger.sourceState().lostFiles, 0)

    // The engine (or the user deleting the chat) removes the log file.
    rmSync(file)
    await ledger.refresh()
    assert.equal(totalTokens(ledger.allTime()), 341, 'billed usage must not disappear with the log')
    assert.equal(ledger.allTime().calls, 2)
    const state = ledger.sourceState()
    assert.equal(state.scanned, true)
    assert.equal(state.logFiles, 0)
    assert.equal(state.lostFiles, 1)
    assert.equal(totalTokens(state.lostTotals), 341)

    // …and the cache carries the same history into the next process.
    ledger.dispose()
    const restarted = new UsageLedger({ home, now: () => NOW })
    assert.equal(totalTokens(restarted.allTime()), 341)
    assert.equal(restarted.sourceState().lostFiles, 1)
    restarted.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a log that comes back is re-read and cleared from the lost list', async () => {
  const { home, file } = makeHome()
  try {
    writeFileSync(file, frame([header('session-aaa'), call(1, NOW, 10, 100, 5)]))
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    rmSync(file)
    await ledger.refresh()
    assert.equal(ledger.sourceState().lostFiles, 1)
    writeFileSync(file, frame([header('session-aaa'), call(1, NOW, 10, 100, 5), call(2, NOW, 3, 30, 4)]))
    await ledger.refresh()
    assert.equal(ledger.sourceState().lostFiles, 0)
    assert.equal(totalTokens(ledger.allTime()), 152)
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('live calls survive a restart through the index', () => {
  const { home } = makeHome()
  try {
    const usage = { input: 1, cached: 10, cacheWrite: 0, output: 1, reasoning: 0, calls: 1 }
    const first = new UsageLedger({ home, now: () => NOW })
    first.noteLive('session-aaa', 5, NOW, usage, 'm1', 2, 'p')
    assert.equal(first.pendingCount(), 1)
    first.dispose() // flush the index
    const second = new UsageLedger({ home, now: () => NOW })
    assert.equal(second.pendingCount(), 1)
    assert.equal(totalTokens(second.window(1)), 12)
    assert.equal(second.sessionTurnsOf('session-aaa').get(2).calls, 1)
    second.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('only the highest format generation in a session directory is counted', async () => {
  const { home, dir } = makeHome()
  try {
    // A migrated session keeps its older generation next to the current one.
    writeFileSync(join(dir, 'session.v3.jsonl.zstd'), frame([header('session-aaa'), call(1, NOW, 10, 100, 5)]))
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), frame([header('session-aaa'), call(1, NOW, 10, 100, 5), call(2, NOW, 2, 20, 2)]))
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    assert.equal(totalTokens(ledger.allTime()), 139)
    assert.equal(ledger.allTime().calls, 2)
    assert.equal(ledger.sourceState().logFiles, 1)
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('uncompressed logs (compression: none) are read too', async () => {
  const { home, dir } = makeHome()
  try {
    writeFileSync(join(dir, 'session.v4.jsonl'), [header('session-aaa'), call(1, NOW, 10, 100, 5)].join('\n') + '\n')
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    assert.equal(totalTokens(ledger.allTime()), 115)
    assert.equal(ledger.sourceState().logFiles, 1)
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a missing sessions root is reported instead of looking like zero usage', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-noroot-'))
  try {
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    const state = ledger.sourceState()
    assert.equal(state.scanned, true)
    assert.equal(state.rootMissing, true)
    assert.equal(state.logFiles, 0)
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('an unreadable sessions root does not mark history as lost', async () => {
  const { home, file } = makeHome()
  try {
    writeFileSync(file, frame([header('session-aaa'), call(1, NOW, 10, 100, 5)]))
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    assert.equal(ledger.sourceState().lostFiles, 0)

    // A transient root failure must not be mistaken for deleted logs.
    rmSync(join(home, 'sessions'), { recursive: true, force: true })
    await ledger.refresh()
    const state = ledger.sourceState()
    assert.equal(state.rootMissing, true)
    assert.equal(state.lostFiles, 0)
    assert.equal(totalTokens(ledger.allTime()), 115)
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('moving or copying $DSH_HOME does not double-count the same sessions', async () => {
  const { home, file } = makeHome()
  const moved = mkdtempSync(join(tmpdir(), 'dsh-moved-'))
  try {
    writeFileSync(file, frame([header('session-aaa'), call(1, NOW, 10, 100, 5), call(2, NOW, 20, 200, 6)]))
    const first = new UsageLedger({ home, now: () => NOW })
    await first.refresh()
    assert.equal(totalTokens(first.allTime()), 341)
    first.dispose() // cache is written next to the sessions

    // Move the whole home: the cache carries absolute paths that no longer exist.
    cpSync(join(home, 'sessions'), join(moved, 'sessions'), { recursive: true })
    cpSync(join(home, 'cache'), join(moved, 'cache'), { recursive: true })
    const after = new UsageLedger({ home: moved, now: () => NOW })
    await after.refresh()
    assert.equal(totalTokens(after.allTime()), 341, 'the same calls must not count twice')
    assert.equal(after.allTime().calls, 2)
    assert.equal(after.sourceState().lostFiles, 0, 'the moved record is superseded, not lost')
    assert.equal(after.sourceState().logFiles, 1)

    // …and the deduplicated state survives another restart.
    after.dispose()
    const reloaded = new UsageLedger({ home: moved, now: () => NOW })
    assert.equal(totalTokens(reloaded.allTime()), 341)
    reloaded.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(moved, { recursive: true, force: true })
  }
})

test('the same session copied into two project directories counts once', async () => {
  const { home, dir } = makeHome()
  const copyDir = join(home, 'sessions', 'proj2', 'session-aaa')
  try {
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), frame([header('session-aaa'), call(1, NOW, 10, 100, 5)]))
    mkdirSync(copyDir, { recursive: true })
    cpSync(join(dir, 'session.v4.jsonl.zstd'), join(copyDir, 'session.v4.jsonl.zstd'))
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    assert.equal(totalTokens(ledger.allTime()), 115)
    assert.equal(ledger.records.size, 1, 'an alias record is dropped')
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

const usageSample = (input, cached, output) => ({ inputTokens: input, cacheReadTokens: cached, cacheWriteTokens: 0, outputTokens: output })
const attemptEvent = (seq, turn, step, usage) =>
  JSON.stringify({ type: 'assistant/attempt', seq, time: NOW, data: { turn, step, stream: [{ type: 'chunk', chunk: { type: 'text' } }, { type: 'chunk', time: NOW, chunk: { type: 'usage', usage } }] } })
const messageEvent = (seq, turn, step, usage, stream = []) =>
  JSON.stringify({ type: 'assistant/message', seq, time: NOW, data: { turn, step, usage, stream, message: { source: { provider: 'p', model: 'm1' } } } })
const retryStarted = (seq, turn, step) => JSON.stringify({ type: 'llm/retry-started', seq, time: NOW, data: { turn, step, retryId: 'r1' } })

test('a retried attempt keeps its billed usage (engine counts it too)', async () => {
  const { home, file } = makeHome()
  try {
    writeFileSync(
      file,
      frame([
        header('session-aaa'),
        attemptEvent(1, 1, 1, usageSample(3076, 182272, 1888)), // failed attempt: 187236 tokens
        retryStarted(2, 1, 1),
        messageEvent(3, 1, 1, usageSample(100, 1000, 10)),
      ]),
    )
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    assert.equal(totalTokens(ledger.allTime()), 187236 + 1110)
    assert.equal(ledger.allTime().calls, 2, 'the retried attempt and the retry are two calls')
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('re-settling one step replaces the previous settlement instead of adding it', async () => {
  const { home, file } = makeHome()
  try {
    writeFileSync(file, frame([header('session-aaa'), messageEvent(1, 1, 1, usageSample(10, 100, 5)), messageEvent(2, 1, 1, usageSample(20, 200, 6))]))
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    assert.equal(totalTokens(ledger.allTime()), 226, 'the engine replaces the earlier settlement of the same turn+step')
    assert.equal(ledger.allTime().calls, 1)
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a message without data.usage falls back to the last usage sample in its stream', async () => {
  const { home, file } = makeHome()
  try {
    const stream = [{ type: 'chunk', chunk: { type: 'usage', usage: usageSample(2, 20, 2) } }]
    writeFileSync(file, frame([header('session-aaa'), messageEvent(1, 1, 1, undefined, stream)]))
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    assert.equal(totalTokens(ledger.allTime()), 24)
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('live settlements use the same replacement rule', () => {
  const { home } = makeHome()
  try {
    const ledger = new UsageLedger({ home, now: () => NOW })
    const u1 = { input: 10, cached: 100, cacheWrite: 0, output: 5, reasoning: 0, calls: 1 }
    const u2 = { input: 20, cached: 200, cacheWrite: 0, output: 6, reasoning: 0, calls: 1 }
    ledger.noteLive('session-aaa', 1, NOW, u1, 'm1', 1, 'p', 1)
    assert.equal(totalTokens(ledger.allTime()), 115)
    ledger.noteLive('session-aaa', 2, NOW, u2, 'm1', 1, 'p', 1) // re-settle: replaces
    assert.equal(totalTokens(ledger.allTime()), 226)
    assert.equal(ledger.pendingCount(), 1)
    ledger.noteRetryStarted('session-aaa', 1, 1) // new attempt of the same step: adds
    ledger.noteLive('session-aaa', 3, NOW, u1, 'm1', 1, 'p', 1)
    assert.equal(totalTokens(ledger.allTime()), 341)
    assert.equal(ledger.pendingCount(), 2)
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('recount keeps the same per-session de-duplication as the live ledger', async () => {
  const { home, dir } = makeHome()
  const copyDir = join(home, 'sessions', 'proj2', 'session-aaa')
  try {
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), frame([header('session-aaa'), call(1, NOW, 10, 100, 5)]))
    mkdirSync(copyDir, { recursive: true })
    cpSync(join(dir, 'session.v4.jsonl.zstd'), join(copyDir, 'session.v4.jsonl.zstd'))
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    const recount = await ledger.recount()
    assert.equal(totalTokens(recount.totals), 115)
    assert.equal(recount.totals.calls, 1)
    assert.equal(totalTokens(recount.totals), totalTokens(ledger.allTime()))
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('structurally broken cached records are ignored instead of folded', async () => {
  const { home, file } = makeHome()
  try {
    writeFileSync(file, frame([header('session-aaa'), call(1, NOW, 10, 100, 5)]))
    mkdirSync(join(home, 'cache', 'dsh-go-token-usage'), { recursive: true })
    const broken = {
      v: 7,
      files: {
        '/nowhere/session.v3.jsonl.zstd': { id: 'dead', days: ['not', 'a', 'map'], lastSeq: 3 },
        '/nowhere/session.v2.jsonl.zstd': 'not an object',
        '/nowhere/session.v1.jsonl.zstd': { id: 'dead2', days: { '2026-11-12': 'nope' }, numbers: null },
      },
      pending: { dead: [{ seq: 'x' }, { seq: 1, time: NaN }] },
    }
    writeFileSync(join(home, 'cache', 'dsh-go-token-usage', 'index.json'), JSON.stringify(broken))
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    assert.equal(totalTokens(ledger.allTime()), 115)
    assert.equal(ledger.records.size, 1, 'only the real log is a record')
    assert.equal(ledger.pendingCount(), 0)
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
