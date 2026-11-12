// Regression tests for the data-core audit round: unreadable paths, repeated
// parse failures, zero-token settlements, cache damage, dispose, malformed live
// input, scan-lag during Verify, and the pseudo-filesystem mkdir trap.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { UsageLedger } from '../lib/ledger.js'
import { dayKey, emptyTotals, settlementOf, totalTokens } from '../lib/tally.js'

const NOW = new Date(2026, 10, 13, 1, 0, 0).getTime()
const header = (id) => JSON.stringify({ type: 'session', version: 4, id, createdAt: NOW })
const call = (seq, input, cached, output, turn = seq, step = seq) => JSON.stringify({
  type: 'assistant/message',
  seq,
  time: NOW,
  data: {
    turn,
    step,
    usage: { inputTokens: input, cacheReadTokens: cached, cacheWriteTokens: 0, outputTokens: output },
    message: { source: { provider: 'p', model: 'm' } },
  },
})
const zeroCall = (seq, turn = 1, step = 1) => JSON.stringify({
  type: 'assistant/message',
  seq,
  time: NOW,
  data: { turn, step, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
})
const frame = (...lines) => zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'))

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-robust-'))
  const dir = join(home, 'sessions', 'proj', 'session-aaa')
  mkdirSync(dir, { recursive: true })
  return { home, dir, file: join(dir, 'session.v4.jsonl.zstd') }
}

function addSession(home, proj, id, lines) {
  const dir = join(home, 'sessions', proj, 'session-' + id)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, frame(header('session-' + id), ...lines))
  return file
}

/** The engine's tokenUsage rule, written out for differential assertions. */
function engineTokens(events) {
  const bucket = (u) => ({
    input: u.inputTokens ?? 0,
    cached: u.cacheReadTokens ?? 0,
    cacheWrite: u.cacheWriteTokens ?? 0,
    output: u.outputTokens ?? 0,
  })
  const equal = (a, b) => a.input === b.input && a.cached === b.cached && a.cacheWrite === b.cacheWrite && a.output === b.output
  const addReplace = (t, p, n) => ({
    input: t.input - (p?.input ?? 0) + n.input,
    cached: t.cached - (p?.cached ?? 0) + n.cached,
    cacheWrite: t.cacheWrite - (p?.cacheWrite ?? 0) + n.cacheWrite,
    output: t.output - (p?.output ?? 0) + n.output,
  })
  let totals = { input: 0, cached: 0, cacheWrite: 0, output: 0 }
  let last = null
  for (const event of events) {
    if (event.type === 'llm/retry-started') {
      if (last !== null && last.turn === event.data?.turn && last.step === event.data?.step) last = null
      continue
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
    const sample = event.data?.usage
    if (sample === undefined || sample === null) continue
    const { turn, step } = event.data ?? {}
    const next = bucket(sample)
    const previous = last !== null && last.turn === turn && last.step === step ? last.buckets : undefined
    if (previous !== undefined && equal(previous, next)) continue
    totals = addReplace(totals, previous, next)
    last = { turn, step, buckets: next }
  }
  return totals.input + totals.cached + totals.cacheWrite + totals.output
}

// ── F1/F4: unreadable paths are "skipped", never a fake Verify diff ─────────

test('F1: an unreadable project directory is skipped by Verify, not a fake diff', async () => {
  const { home } = makeHome()
  const moved = join(home, 'projB-real')
  try {
    addSession(home, 'projA', 'aaa', [call(1, 10, 100, 5)])
    addSession(home, 'projB', 'bbb', [call(1, 20, 200, 6), call(2, 20, 200, 6)])
    const first = new UsageLedger({ home, now: () => NOW })
    await first.refresh()
    assert.equal(totalTokens(first.allTime()), 567)
    first.dispose()

    // The project directory becomes a broken symlink (external storage unmounted,
    // home moved, permission revoked). The history is still in the cache.
    renameSync(join(home, 'sessions', 'projB'), moved)
    symlinkSync('/definitely/not/mounted/here', join(home, 'sessions', 'projB'))

    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    const state = ledger.sourceState()
    assert.equal(state.unavailableDirs, 1, 'the unreadable project is reported')
    assert.equal(state.lostFiles, 0, 'an unreadable directory is not a deleted log')
    assert.equal(state.logFiles, 1)
    assert.equal(totalTokens(ledger.allTime()), 567, 'cached history is kept')

    const recount = await ledger.recount()
    assert.equal(recount.unavailable.length, 1)
    const comparison = ledger.compareRecount(recount)
    assert.equal(comparison.unexplainedTokens, 0, JSON.stringify(comparison))
    assert.equal(comparison.unexplainedCalls, 0)
    assert.equal(comparison.lostFiles, 0)
    assert.equal(comparison.skippedDirs, 1)
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(moved, { recursive: true, force: true })
  }
})

test('F4: a broken log symlink is unavailable, not "the log was deleted"', async () => {
  const { home, file } = makeHome()
  addSession(home, 'proj', 'aaa', [call(1, 10, 100, 5)])
  const real = file + '.real'
  try {
    const first = new UsageLedger({ home, now: () => NOW })
    await first.refresh()
    first.dispose()

    renameSync(file, real)
    symlinkSync('/definitely/not/here', file)

    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    const state = ledger.sourceState()
    assert.equal(state.unavailableDirs, 1, 'the unreadable log path is named')
    assert.equal(state.lostFiles, 0, 'it must not be reported as lost history')
    assert.equal([...ledger.records.values()][0].missing !== true, true)
    const comparison = ledger.compareRecount(await ledger.recount())
    assert.equal(comparison.unexplainedTokens, 0, JSON.stringify(comparison))
    assert.equal(comparison.lostFiles, 0)
    assert.equal(comparison.skippedDirs, 1)
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ── F2: a permanently unreadable generation is not re-read every poll ───────

test('F2: a generation that fails to parse is memoized, and retried after it changes', async () => {
  const { home, dir, file } = makeHome()
  try {
    writeFileSync(file, frame(header('session-aaa'), call(1, 10, 100, 5)))
    const bad = join(dir, 'session.v5.jsonl.zstd')
    writeFileSync(bad, Buffer.from('this is not a zstd frame at all'))
    const ledger = new UsageLedger({ home, now: () => NOW })
    for (let round = 0; round < 3; round += 1) await ledger.refresh()
    assert.equal(ledger.errors, 1, 'errors reflect the current state, not a growing lifetime total')
    assert.equal(ledger.scanErrors, 1)
    assert.equal(ledger.failed.size, 1, 'the failed generation is remembered by its stat')
    assert.equal(totalTokens(ledger.allTime()), 115, 'the older complete generation is still read')

    // Once the file changes, the memo no longer matches and the parse is retried.
    writeFileSync(bad, frame(header('session-aaa'), call(1, 10, 100, 5), call(2, 20, 200, 6)))
    await ledger.refresh()
    assert.equal(ledger.failed.size, 0)
    assert.equal(ledger.errors, 0)
    assert.equal(totalTokens(ledger.allTime()), 341, 'the repaired newest generation wins')
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ── F3: zero-token settlements own their replacement slot, like the engine ──

test('F3: folding matches the engine when zero-token settlements are involved', async () => {
  const cases = [
    // A non-zero settlement replaced by a zero-token one: nothing is billed.
    [{ type: 'assistant/message', seq: 1, time: NOW, data: { turn: 1, step: 1, usage: { inputTokens: 10, cacheReadTokens: 100, outputTokens: 5 } } }, { type: 'assistant/message', seq: 2, time: NOW, data: { turn: 1, step: 1, usage: { inputTokens: 0, outputTokens: 0 } } }],
    // A zero-token settlement replaced by a real one: the real one is billed.
    [{ type: 'assistant/message', seq: 1, time: NOW, data: { turn: 1, step: 1, usage: { inputTokens: 0, outputTokens: 0 } } }, { type: 'assistant/message', seq: 2, time: NOW, data: { turn: 1, step: 1, usage: { inputTokens: 7, cacheReadTokens: 70, outputTokens: 3 } } }],
    // The zero slot moves the engine's replace target: an older turn+step added
    // again after the zero must be added, not used to replace the first call.
    [{ type: 'assistant/message', seq: 1, time: NOW, data: { turn: 1, step: 1, usage: { inputTokens: 10, cacheReadTokens: 100, outputTokens: 5 } } },
      { type: 'assistant/message', seq: 2, time: NOW, data: { turn: 2, step: 1, usage: { inputTokens: 0, outputTokens: 0 } } },
      { type: 'assistant/message', seq: 3, time: NOW, data: { turn: 1, step: 1, usage: { inputTokens: 20, cacheReadTokens: 200, outputTokens: 6 } } }],
  ]
  for (const [index, events] of cases.entries()) {
    const { home, file } = makeHome()
    try {
      writeFileSync(file, frame(header('session-aaa'), ...events.map((event) => JSON.stringify(event))))
      const ledger = new UsageLedger({ home, now: () => NOW })
      await ledger.refresh()
      assert.equal(totalTokens(ledger.allTime()), engineTokens(events), `case ${index} must match the engine`)
      if (index === 0) {
        // The replaced settlement's cache counters are taken back with it.
        assert.equal(ledger.windowCacheCoverage(1).withCounters, 0)
        assert.equal(ledger.sessionCacheCoverage('session-aaa').withCounters, 0)
      }
      ledger.dispose()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
  // A lone zero-token settlement bills nothing and adds no call.
  const { home, file } = makeHome()
  try {
    writeFileSync(file, frame(header('session-aaa'), zeroCall(1)))
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    assert.equal(totalTokens(ledger.allTime()), 0)
    assert.equal(ledger.allTime().calls, 0)
    const settlement = settlementOf(JSON.parse(zeroCall(2)))
    assert.ok(settlement !== undefined, 'settlementOf still reports zero samples so the slot is tracked')
    assert.equal(settlement.totals.calls, 1)
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('F3 live: a zero-token live re-settlement removes the provisional call', async () => {
  const { home, file } = makeHome()
  try {
    writeFileSync(file, frame(header('session-aaa'), call(1, 10, 100, 5)))
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    const live = (seq, totals, counters = false) =>
      ledger.noteLive('session-aaa', seq, NOW, { ...emptyTotals(), ...totals }, 'm', 1, 'p', 1, counters)
    live(2, { input: 7, cached: 70, output: 3, calls: 1 }, true)
    assert.equal(totalTokens(ledger.allTime()), 195)
    assert.equal(ledger.sessionCacheCoverage('session-aaa').withCounters, 2, 'the log call and the live call both reported counters')
    live(3, { calls: 1 }) // zero tokens for the same turn+step replaces the slot
    assert.equal(totalTokens(ledger.allTime()), 115, 'the provisional call was replaced with nothing')
    assert.equal(ledger.pendingCount(), 0)
    assert.equal(ledger.sessionCacheCoverage('session-aaa').withCounters, 1, 'the replaced live reach is dropped, the log call stays')
    live(4, { input: 50, cached: 500, output: 8, calls: 1 })
    assert.equal(totalTokens(ledger.allTime()), 673, 'a later real settlement is added, like the engine')
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ── V-07: Verify ignoring a session that grew after the ledger snapshot ─────

test('V-07: a session that grew between refresh and recount is lag, not a diff', async () => {
  const { home, file } = makeHome()
  try {
    writeFileSync(file, frame(header('session-aaa'), call(1, 10, 100, 5)))
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    appendFileSync(file, frame(call(2, 20, 200, 6)))
    const recount = await ledger.recount()
    const comparison = ledger.compareRecount(recount)
    assert.equal(comparison.lagging, 1, 'the session was appended after the ledger scanned it')
    assert.equal(comparison.unexplainedTokens, 0, JSON.stringify(comparison))
    assert.equal(comparison.unexplainedCalls, 0)
    assert.equal(comparison.lostFiles, 0)
    assert.equal(totalTokens(comparison.shownTotals), 0, 'lagging sessions are excluded from the compared totals')

    // A plain object recount (no live Map seqs) must not crash or be treated as lag.
    const fake = {
      totals: emptyTotals(),
      days: new Map(),
      sessions: new Map([['aaa', { ...emptyTotals(), input: 999, calls: 1 }]]),
      seqs: new Map([['aaa', 99]]),
      files: 1,
      unavailable: [],
    }
    const fakeComparison = ledger.compareRecount(fake)
    assert.equal(fakeComparison.lagging, 1)
    assert.equal(fakeComparison.unexplainedTokens, 0)
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ── F5: a .bak fallback stops warning once the cache is healthy again ───────

test('F5: cacheDamaged is cleared after a successful save following a .bak fallback', async () => {
  const { home, file } = makeHome()
  try {
    writeFileSync(file, frame(header('session-aaa'), call(1, 10, 100, 5)))
    const first = new UsageLedger({ home, now: () => NOW })
    await first.refresh()
    first.dispose()
    const cacheDir = join(home, 'cache', 'dsh-go-token-usage')
    // Simulate the crash window of the atomic save: only the backup is left.
    renameSync(join(cacheDir, 'index.json'), join(cacheDir, 'index.json.bak'))

    const second = new UsageLedger({ home, now: () => NOW })
    assert.equal(second.sourceState().cacheDamaged, true)
    assert.equal(totalTokens(second.allTime()), 115, 'history survived through the backup')
    await second.refresh()
    second.dispose()
    assert.equal(second.cacheDamaged, false, 'a healthy save clears the warning')
    const third = new UsageLedger({ home, now: () => NOW })
    assert.equal(third.sourceState().cacheDamaged, false)
    third.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ── F6: corrupt cached records are counted instead of silently dropped ──────

test('F6: corrupt cached records are reported through cacheDropped', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-dropped-'))
  try {
    mkdirSync(join(home, 'sessions'))
    const cacheDir = join(home, 'cache', 'dsh-go-token-usage')
    mkdirSync(cacheDir, { recursive: true })
    const day = '2026-11-12'
    const good = {
      id: 'session-good', origin: '', createdAt: NOW, days: { [day]: { input: 1, cached: 2, cacheWrite: 0, output: 3, reasoning: 0, calls: 1 } },
      models: {}, turns: {}, isSeeded: false, inheritedCut: -1, cacheSeen: false, lastSeq: 5, lastTime: NOW, mtimeMs: 1, size: 1, ctimeMs: 1,
    }
    const badBucket = { ...good, id: 'session-bad-bucket', days: { [day]: { input: null, cached: 2, cacheWrite: 0, output: 3, reasoning: 0, calls: 1 } } }
    const badKey = { ...good, id: 'session-bad-key', days: { 'NaN-NaN-NaN': { input: 1, cached: 2, cacheWrite: 0, output: 3, reasoning: 0, calls: 1 } } }
    writeFileSync(join(cacheDir, 'index.json'), JSON.stringify({ v: 8, files: { '/gone/good': good, '/gone/bad-bucket': badBucket, '/gone/bad-key': badKey }, pending: {} }))
    const ledger = new UsageLedger({ home, now: () => NOW })
    assert.equal(ledger.sourceState().cacheDropped, 2)
    assert.equal(totalTokens(ledger.allTime()), 6, 'the intact record is still loaded')
    assert.equal(ledger.sourceState().cacheDropped, 2)
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ── Malformed live input and malformed event times never corrupt the ledger ─

test('malformed live settlements and times are safely ignored', async () => {
  const { home } = makeHome()
  try {
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    const totals = { ...emptyTotals(), input: 1, output: 1, calls: 1 }
    for (const usage of [null, undefined, 'tokens', 42, [], { input: '1', cached: 0, cacheWrite: 0, output: 0, reasoning: 0, calls: 1 }, { input: -1, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, calls: 1 }, { ...totals, calls: 0 }]) {
      ledger.noteLive('session-live', 1, NOW, usage)
    }
    assert.equal(ledger.pendingCount(), 0, 'malformed calls add nothing')
    for (const seq of [-1, 1.5, Number.NaN, Infinity, '7']) ledger.noteLive('session-live', seq, NOW, totals)
    assert.equal(ledger.pendingCount(), 0, 'a live call without a real log position is left to the scan')

    // Bad event times fall back to now(): never a "NaN-NaN-NaN" or 1970 day key.
    let liveSeq = 100
    for (const time of [0, -5, 1e20, Number.NaN, Infinity, '123']) ledger.noteLive('session-live', liveSeq++, time, totals)
    assert.equal(totalTokens(ledger.allTime()), 12, 'six finite-fallback calls of two tokens each')
    for (const day of ledger.days.keys()) assert.match(day, /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(ledger.days.has(dayKey(NOW)))
    await ledger.refresh() // still healthy
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a log with unusable event times falls back to a real calendar day', async () => {
  const { home, file } = makeHome()
  try {
    const timed = (seq, time) => JSON.stringify({
      type: 'assistant/message', seq, time,
      data: { turn: seq, step: seq, usage: { inputTokens: 1, outputTokens: 1 } },
    })
    const headerNoStamp = JSON.stringify({ type: 'session', version: 4, id: 'session-aaa' })
    writeFileSync(file, frame(headerNoStamp, timed(1, 0), timed(2, -1), timed(3, 1e20), timed(4, Number.MAX_VALUE)))
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    assert.equal(totalTokens(ledger.allTime()), 8)
    const days = Object.keys([...ledger.records.values()][0].days)
    assert.ok(days.length >= 1)
    for (const day of days) {
      assert.match(day, /^\d{4}-\d{2}-\d{2}$/)
      assert.ok(!day.includes('NaN'))
    }
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ── H9: dispose stops an in-flight scan from writing or emitting ────────────

test('H9: dispose stops an in-flight scan from writing the cache or emitting', async () => {
  const { home, file } = makeHome()
  try {
    writeFileSync(file, frame(header('session-aaa'), call(1, 10, 100, 5)))
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    const cacheFile = join(home, 'cache', 'dsh-go-token-usage', 'index.json')
    appendFileSync(file, frame(call(2, 20, 200, 6))) // a scan started now would see this
    let emitted = 0
    ledger.listen(() => { emitted += 1 })
    const scanning = ledger.refresh()
    ledger.dispose()
    await scanning
    assert.equal(ledger.disposed, true)
    assert.equal(emitted, 0, 'a disposed ledger must not push to feeds')
    const saved = JSON.parse(readFileSync(cacheFile, 'utf8'))
    assert.equal(saved.files[file].lastSeq, 1, 'the in-flight scan did not overwrite the flushed cache')
    const mtime = statSync(cacheFile).mtimeMs
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(statSync(cacheFile).mtimeMs, mtime, 'no debounced save fires after dispose')
    ledger.dispose() // idempotent
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ── Node recursive-mkdir trap: a pseudo-fs $DSH_HOME must never hang us ─────

test('a pseudo-filesystem home never hangs refresh or dispose', { skip: process.platform === 'win32' && 'posix paths only' }, () => {
  const ledgerUrl = new URL('../lib/ledger.js', import.meta.url).href
  for (const home of ['/proc', '/sys']) {
    const code = [
      `import { UsageLedger } from ${JSON.stringify(ledgerUrl)}`,
      `const ledger = new UsageLedger({ home: ${JSON.stringify(home)} })`,
      'await ledger.refresh()',
      'ledger.dispose()',
      "console.log('ok')",
    ].join('\n')
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { timeout: 8000, encoding: 'utf8' })
    assert.equal(result.error, undefined, `${home}: ${result.error?.message ?? ''}`)
    assert.equal(result.status, 0, `${home}: ${result.stderr}`)
    assert.match(result.stdout, /ok/)
  }
})
