// History-retention guarantees: a younger generation, a re-created file or a stale
// cache must never silently erase usage that was already counted.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { UsageLedger } from '../lib/ledger.js'
import { totalTokens } from '../lib/tally.js'
import { historyNote, usageData, verifyLine } from '../lib/view.js'

const NOW = new Date(2026, 10, 12, 12, 0, 0).getTime()
const header = (id = 'session-aaa') => JSON.stringify({ type: 'session', version: 4, id, createdAt: NOW, cwd: '/p' })
const call = (seq, turn, step, input = 10, cached = 100, output = 5) =>
  JSON.stringify({ type: 'assistant/message', seq, time: NOW, data: { turn, step, usage: { inputTokens: input, cacheReadTokens: cached, cacheWriteTokens: 0, outputTokens: output }, message: { source: { provider: 'p', model: 'm1' } } } })
const frame = (lines) => zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'))

function home() {
  const root = mkdtempSync(join(tmpdir(), 'history-'))
  const dir = join(root, 'sessions', 'proj', 'session-aaa')
  mkdirSync(dir, { recursive: true })
  return { root, dir, zstd: join(dir, 'session.v4.jsonl.zstd') }
}
const tokens = (ledger) => totalTokens(ledger.allTime())

test('a header-only newer generation does not erase the complete older one', async () => {
  const h = home()
  try {
    writeFileSync(join(h.dir, 'session.v3.jsonl.zstd'), frame([header(), call(1, 1, 1), call(2, 2, 1, 20, 200, 6)]))
    writeFileSync(h.zstd, frame([header()])) // header written, first event torn
    const ledger = new UsageLedger({ home: h.root, now: () => NOW })
    await ledger.refresh()
    assert.equal(tokens(ledger), 341)
    ledger.dispose()
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('a whitespace-only newer generation does not erase history either', async () => {
  const h = home()
  try {
    writeFileSync(join(h.dir, 'session.v3.jsonl.zstd'), frame([header(), call(1, 1, 1), call(2, 2, 1, 20, 200, 6)]))
    writeFileSync(join(h.dir, 'session.v4.jsonl'), '\n')
    const ledger = new UsageLedger({ home: h.root, now: () => NOW })
    await ledger.refresh()
    assert.equal(tokens(ledger), 341)
    ledger.dispose()
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('a log re-created shorter after it disappeared keeps the counted history', async () => {
  const h = home()
  try {
    writeFileSync(h.zstd, frame([header(), call(1, 1, 1), call(2, 2, 1, 20, 200, 6)]))
    const ledger = new UsageLedger({ home: h.root, now: () => NOW })
    await ledger.refresh()
    assert.equal(tokens(ledger), 341)
    unlinkSync(h.zstd)
    await ledger.refresh()
    assert.equal(ledger.sourceState().lostFiles, 1)
    writeFileSync(h.zstd, frame([header(), call(1, 1, 1)]))
    await ledger.refresh()
    assert.equal(tokens(ledger), 341, 'the shorter re-created file must not drop billed history')
    assert.equal(ledger.sourceState().lostFiles, 0)
    ledger.dispose()
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('an old cache entry without a log position is dropped on load', async () => {
  const h = home()
  try {
    writeFileSync(h.zstd, frame([header(), call(1, 1, 1)]))
    mkdirSync(join(h.root, 'cache', 'dsh-go-token-usage'), { recursive: true })
    const legacy = {
      v: 7,
      files: {},
      pending: { aaa: [{ seq: -1, time: NOW, totals: { input: 7, cached: 70, cacheWrite: 0, output: 3, reasoning: 0, calls: 1 } }] },
    }
    writeFileSync(join(h.root, 'cache', 'dsh-go-token-usage', 'index.json'), JSON.stringify(legacy))
    const ledger = new UsageLedger({ home: h.root, now: () => NOW })
    assert.equal(ledger.pendingCount(), 0)
    await ledger.refresh()
    assert.equal(tokens(ledger), 115)
    ledger.dispose()
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('an identical re-settlement in the log releases its provisional live entry', async () => {
  const h = home()
  try {
    writeFileSync(h.zstd, frame([header(), call(1, 1, 1)]))
    const ledger = new UsageLedger({ home: h.root, now: () => NOW })
    await ledger.refresh()
    const u = { input: 10, cached: 100, cacheWrite: 0, output: 5, reasoning: 0, calls: 1 }
    ledger.noteLive('session-aaa', 2, NOW, u, 'm1', 1, 'p', 1)
    assert.equal(tokens(ledger), 230)
    writeFileSync(h.zstd, frame([header(), call(1, 1, 1), call(2, 1, 1)])) // identical settlement, seq 2
    await ledger.refresh()
    assert.equal(tokens(ledger), 115, 'the call is counted once, the live entry is gone')
    assert.equal(ledger.pendingCount(), 0)
    ledger.dispose()
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('aliases never reach the cache file (downgrade cannot double-count)', async () => {
  const h = home()
  const copyDir = join(h.root, 'sessions', 'proj2', 'session-aaa')
  try {
    writeFileSync(h.zstd, frame([header(), call(1, 1, 1)]))
    mkdirSync(copyDir, { recursive: true })
    cpSync(h.zstd, join(copyDir, 'session.v4.jsonl.zstd'))
    const ledger = new UsageLedger({ home: h.root, now: () => NOW })
    await ledger.refresh()
    assert.equal(tokens(ledger), 115)
    ledger.dispose()
    const cache = JSON.parse(readFileSync(join(h.root, 'cache', 'dsh-go-token-usage', 'index.json'), 'utf8'))
    assert.equal(cache.v, 8)
    assert.equal(Object.keys(cache.files).length, 1, 'only the owning record is persisted')
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('a stale timezone in the cache forces a re-read of the log', async () => {
  const h = home()
  try {
    writeFileSync(h.zstd, frame([header(), call(1, 1, 1)]))
    const first = new UsageLedger({ home: h.root, now: () => NOW })
    await first.refresh()
    first.dispose()
    const cachePath = join(h.root, 'cache', 'dsh-go-token-usage', 'index.json')
    const cache = JSON.parse(readFileSync(cachePath, 'utf8'))
    for (const rec of Object.values(cache.files)) rec.tzOffset = 12345 // a different host timezone
    writeFileSync(cachePath, JSON.stringify(cache))
    const second = new UsageLedger({ home: h.root, now: () => NOW })
    await second.refresh()
    assert.equal(second.parsedFiles, 1, 'the record was re-read for the new timezone')
    assert.equal(tokens(second), 115)
    second.dispose()
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('unknown cache coverage only affects the windows it covers', async () => {
  const h = home()
  try {
    writeFileSync(h.zstd, frame([header(), call(1, 1, 1)]))
    const first = new UsageLedger({ home: h.root, now: () => NOW })
    await first.refresh()
    first.dispose()
    const cachePath = join(h.root, 'cache', 'dsh-go-token-usage', 'index.json')
    const cache = JSON.parse(readFileSync(cachePath, 'utf8'))
    const yesterday = new Date(NOW - 86_400_000)
    const key = yesterday.getFullYear() + '-' + String(yesterday.getMonth() + 1).padStart(2, '0') + '-' + String(yesterday.getDate()).padStart(2, '0')
    cache.files['/gone/session.v4.jsonl.zstd'] = {
      id: 'session-gone',
      days: { [key]: { input: 1, cached: 0, cacheWrite: 0, output: 1, reasoning: 0, calls: 1 } },
      turns: {},
      lastSeq: 0,
      lastTime: NOW - 86_400_000,
      missing: true,
      // no cacheDays/cacheTurns: written by an older version
    }
    writeFileSync(cachePath, JSON.stringify(cache))
    const ledger = new UsageLedger({ home: h.root, now: () => NOW })
    await ledger.refresh()
    assert.equal(ledger.windowCacheKnown(1), true, "today's known coverage is not poisoned by old records")
    assert.equal(ledger.sessionCacheKnown('session-aaa'), true)
    assert.equal(ledger.allCacheKnown(), false, 'the whole ledger still has an unknown day')
    const data = usageData(ledger, { sessionId: 'session-aaa' }, 'zh-CN')
    assert.equal(data.today.hit, '91%')
    assert.match(data.all.hit, /^≈\d/, 'partial coverage shows an approximate rate')
    ledger.dispose()
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('a seeded log with a lost header still skips its inherited prefix', async () => {
  const h = home()
  try {
    const lines = [
      call(0, 1, 1, 100, 1000, 10),
      call(1, 2, 1, 100, 1000, 10),
      JSON.stringify({ type: 'session/end-seed', seq: 2, time: NOW, data: { inherited: true } }),
      call(3, 3, 1, 7, 70, 3),
    ]
    writeFileSync(h.zstd, frame(lines))
    const ledger = new UsageLedger({ home: h.root, now: () => NOW })
    await ledger.refresh()
    assert.equal(tokens(ledger), 80, 'the inherited prefix is not billed twice even without a header')
    assert.equal(ledger.allTime().calls, 1)
    ledger.dispose()
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('a damaged cache falls back to the backup instead of losing history', async () => {
  const h = home()
  try {
    writeFileSync(h.zstd, frame([header(), call(1, 1, 1)]))
    const first = new UsageLedger({ home: h.root, now: () => NOW })
    await first.refresh()
    first.dispose()
    const second = new UsageLedger({ home: h.root, now: () => NOW })
    await second.refresh()
    second.dispose() // a second save turns the first cache into index.json.bak
    const cacheDir = join(h.root, 'cache', 'dsh-go-token-usage')
    writeFileSync(join(cacheDir, 'index.json'), '{not json')
    const third = new UsageLedger({ home: h.root, now: () => NOW })
    assert.equal(tokens(third), 115, 'history survived through the backup')
    assert.equal(third.sourceState().cacheDamaged, true)
    await third.refresh()
    assert.equal(tokens(third), 115)
    third.dispose()
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('an empty log is called out instead of being reported as "no logs"', async () => {
  const h = home()
  try {
    writeFileSync(h.zstd, frame([header(), call(1, 1, 1)]))
    const emptyDir = join(h.root, 'sessions', 'proj', 'session-empty')
    mkdirSync(emptyDir, { recursive: true })
    writeFileSync(join(emptyDir, 'session.v4.jsonl.zstd'), Buffer.alloc(0))
    const ledger = new UsageLedger({ home: h.root, now: () => NOW })
    await ledger.refresh()
    assert.equal(ledger.sourceState().emptyLogs, 1)
    assert.equal(historyNote(ledger, 'zh-CN'), '1 个日志为空，统计可能偏少')
    ledger.dispose()
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('a call-count-only mismatch still shows up in Verify', async () => {
  const h = home()
  try {
    writeFileSync(h.zstd, frame([header(), call(1, 1, 1)]))
    const ledger = new UsageLedger({ home: h.root, now: () => NOW })
    await ledger.refresh()
    const rec = [...ledger.records.values()][0]
    rec.totals.calls += 1 // calls differ, tokens do not
    const line = verifyLine(ledger, await ledger.recount(), 'zh-CN')
    assert.equal(line, '核对：差 1 次')
    ledger.dispose()
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})
