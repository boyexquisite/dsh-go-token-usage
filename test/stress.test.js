// Consistency and resilience checks that the simple fixtures cannot show:
// live/scanned overlap, repeated refreshes, cache reloads and damaged files.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, copyFileSync, cpSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { UsageLedger } from '../lib/ledger.js'
import { totalTokens } from '../lib/tally.js'

const NOW = Date.now()
const SESSION = 'session-stress'
const usage = (i = 10, c = 100, o = 5) => ({ input: i, cached: c, cacheWrite: 0, output: o, reasoning: 0, calls: 1 })
const header = JSON.stringify({ type: 'session', version: 4, id: SESSION, createdAt: NOW, cwd: '/p' })
const message = (seq, turn, step, i = 10, c = 100, o = 5) =>
  JSON.stringify({ type: 'assistant/message', seq, time: NOW + seq, data: { turn, step, usage: { inputTokens: i, cacheReadTokens: c, cacheWriteTokens: 0, outputTokens: o }, message: { source: { provider: 'p', model: 'm1' } } } })
const z = (lines) => zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'))

function makeLog() {
  const home = mkdtempSync(join(tmpdir(), 'stress-'))
  const dir = join(home, 'sessions', 'proj', SESSION)
  mkdirSync(dir, { recursive: true })
  return { home, dir, file: join(dir, 'session.v4.jsonl.zstd') }
}
const tokens = (l) => totalTokens(l.allTime())

test('a live re-settlement is cleaned up once the log catches up', async () => {
  const { home, file } = makeLog()
  try {
    writeFileSync(file, z([header, message(1, 1, 1, 10, 100, 5)]))
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    assert.equal(tokens(ledger), 115)
    // The engine re-settles turn 1 step 1 before flushing it.
    ledger.noteLive(SESSION, 2, NOW, usage(20, 200, 6), 'm1', 1, 'p', 1)
    assert.equal(tokens(ledger), 341, 'provisional view: old + replacement')
    appendFileSync(file, z([message(2, 1, 1, 20, 200, 6)]))
    await ledger.refresh()
    assert.equal(tokens(ledger), 226, 'after the scan only the replacement is counted')
    assert.equal(ledger.pendingCount(), 0)
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('repeated refreshes and cache reloads are idempotent', async () => {
  const { home, file } = makeLog()
  try {
    writeFileSync(file, z([header, message(1, 1, 1), message(2, 2, 1, 20, 200, 6)]))
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    const first = tokens(ledger)
    await ledger.refresh()
    await ledger.refresh()
    assert.equal(tokens(ledger), first)
    ledger.dispose()
    for (let i = 0; i < 3; i += 1) {
      const again = new UsageLedger({ home, now: () => NOW })
      assert.equal(tokens(again), first, `restart ${i} keeps the numbers`)
      again.dispose()
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('appending events gives the same result as a cold scan', async () => {
  const { home, file } = makeLog()
  const coldHome = mkdtempSync(join(tmpdir(), 'stress-cold-'))
  try {
    writeFileSync(file, z([header, message(1, 1, 1)]))
    const live = new UsageLedger({ home, now: () => NOW })
    await live.refresh()
    for (let turn = 2; turn <= 6; turn += 1) {
      appendFileSync(file, z([message(turn, turn, 1, turn * 10, turn * 100, turn)]))
      await live.refresh()
    }
    const coldSessions = join(coldHome, 'sessions')
    mkdirSync(join(coldSessions, 'proj', SESSION), { recursive: true })
    copyFileSync(file, join(coldSessions, 'proj', SESSION, 'session.v4.jsonl.zstd'))
    const cold = new UsageLedger({ home: coldHome, now: () => NOW })
    await cold.refresh()
    assert.equal(tokens(live), tokens(cold))
    assert.equal(live.allTime().calls, cold.allTime().calls)
    live.dispose(); cold.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(coldHome, { recursive: true, force: true })
  }
})

test('randomised live/scan interleaving keeps totals non-negative and settles consistently', async () => {
  const { home, file } = makeLog()
  try {
    writeFileSync(file, z([header]))
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    let seed = 7
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    const lines = [header]
    let seq = 1
    for (let turn = 1; turn <= 40; turn += 1) {
      const step = 1 + Math.floor(rnd() * 3)
      const liveUsage = usage(1 + Math.floor(rnd() * 100), Math.floor(rnd() * 1000), 1 + Math.floor(rnd() * 20))
      const line = message(seq, turn, step, liveUsage.input, liveUsage.cached, liveUsage.output)
      lines.push(line)
      ledger.noteLive(SESSION, seq, NOW + seq, liveUsage, 'm1', turn, 'p', step)
      if (rnd() < 0.5) await ledger.refresh()
      if (rnd() < 0.3) {
        ledger.noteRetryStarted(SESSION, turn, step)
        ledger.noteLive(SESSION, seq + 1, NOW + seq + 1, liveUsage, 'm1', turn, 'p', step)
      }
      writeFileSync(file, z(lines))
      await ledger.refresh()
      seq += 2
      const total = tokens(ledger)
      assert.ok(Number.isFinite(total) && total >= 0, `total ${total}`)
      for (const bucket of Object.values(ledger.days.values())) for (const value of Object.values(bucket)) assert.ok(value >= 0)
    }
    // After everything is flushed and scanned, no provisional entries remain.
    assert.equal(ledger.pendingCount(), 0)
    const recount = await ledger.recount()
    assert.equal(totalTokens(recount.totals), tokens(ledger))
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('truncating a real log at every sampled byte never crashes or counts garbage', async () => {
  const { home, file } = makeLog()
  const full = z([header, message(1, 1, 1), message(2, 2, 1, 20, 200, 6)])
  try {
    writeFileSync(file, full)
    const seed = new UsageLedger({ home, now: () => NOW })
    await seed.refresh()
    const baseline = tokens(seed)
    assert.equal(baseline, 341)
    seed.dispose()
    for (let cut = 0; cut < full.length; cut += Math.max(1, Math.floor(full.length / 40))) {
      const home2 = mkdtempSync(join(tmpdir(), 'stress-cut-'))
      const dir = join(home2, 'sessions', 'proj', SESSION)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'session.v4.jsonl.zstd'), full.subarray(0, cut))
      const ledger = new UsageLedger({ home: home2, now: () => NOW })
      await ledger.refresh()
      const total = tokens(ledger)
      assert.ok(Number.isFinite(total) && total >= 0 && total <= baseline, `cut ${cut}: ${total}`)
      ledger.dispose()
      rmSync(home2, { recursive: true, force: true })
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('two present copies of one session: the more complete one wins', async () => {
  const { home, dir } = makeLog()
  const copyDir = join(home, 'sessions', 'proj2', SESSION)
  try {
    mkdirSync(copyDir, { recursive: true })
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), z([header, message(1, 1, 1)]))
    writeFileSync(join(copyDir, 'session.v4.jsonl.zstd'), z([header, message(1, 1, 1), message(2, 2, 1, 20, 200, 6)]))
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    assert.equal(ledger.meta().files, 1)
    assert.equal(tokens(ledger), 341, 'the copy with the most events is kept')
    const recount = await ledger.recount()
    assert.equal(totalTokens(recount.totals), 341)
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('moving the home twice still counts once', async () => {
  const { home, file } = makeLog()
  let a = null
  let b = null
  try {
    writeFileSync(file, z([header, message(1, 1, 1), message(2, 2, 1, 20, 200, 6)]))
    const one = new UsageLedger({ home, now: () => NOW })
    await one.refresh()
    one.dispose()
    a = mkdtempSync(join(tmpdir(), 'stress-hop1-'))
    cpSync(join(home, 'sessions'), join(a, 'sessions'), { recursive: true })
    cpSync(join(home, 'cache'), join(a, 'cache'), { recursive: true })
    const two = new UsageLedger({ home: a, now: () => NOW })
    await two.refresh()
    assert.equal(tokens(two), 341)
    two.dispose()
    b = mkdtempSync(join(tmpdir(), 'stress-hop2-'))
    cpSync(join(a, 'sessions'), join(b, 'sessions'), { recursive: true })
    cpSync(join(a, 'cache'), join(b, 'cache'), { recursive: true })
    const three = new UsageLedger({ home: b, now: () => NOW })
    await three.refresh()
    assert.equal(tokens(three), 341)
    assert.equal(three.sourceState().lostFiles, 0)
    three.dispose()
    // Corrupting the cache must not produce garbage either.
    const cache = JSON.parse(readFileSync(join(b, 'cache', 'dsh-go-token-usage', 'index.json'), 'utf8'))
    cache.files = 'nope'
    writeFileSync(join(b, 'cache', 'dsh-go-token-usage', 'index.json'), JSON.stringify(cache))
    const four = new UsageLedger({ home: b, now: () => NOW })
    await four.refresh()
    assert.equal(tokens(four), 341)
    four.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
    if (a) rmSync(a, { recursive: true, force: true })
    if (b) rmSync(b, { recursive: true, force: true })
  }
})

test('duplicate copies are parsed once and not re-read on warm scans', async () => {
  const { home, dir } = makeLog()
  const copyDir = join(home, 'sessions', 'proj2', SESSION)
  try {
    mkdirSync(copyDir, { recursive: true })
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), z([header, message(1, 1, 1)]))
    writeFileSync(join(copyDir, 'session.v4.jsonl.zstd'), z([header, message(1, 1, 1)]))
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    assert.equal(tokens(ledger), 115)
    assert.equal(ledger.meta().files, 1)
    await ledger.refresh()
    assert.equal(ledger.parsedFiles, 0, 'the alias copy is not re-read')
    // Deleting the owning file promotes the identical copy instead of losing data.
    rmSync(join(dir, 'session.v4.jsonl.zstd'))
    await ledger.refresh()
    assert.equal(tokens(ledger), 115)
    assert.equal(ledger.sourceState().lostFiles, 0)
    assert.equal(ledger.meta().files, 1)
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
