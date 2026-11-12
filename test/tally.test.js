import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cacheHitRate,
  compact,
  dayKey,
  emptyTotals,
  lastDays,
  percent,
  sumDays,
  totalTokens,
  usageOf,
} from '../lib/tally.js'

const event = (usage, extra = {}) => ({
  type: 'assistant/message',
  seq: 1,
  time: 1_700_000_000_000,
  data: { turn: 1, usage, message: { source: { provider: 'p', model: 'm1' } }, ...extra },
})

test('usageOf: counts are disjoint and totalTokens includes the cache', () => {
  const u = usageOf(event({ inputTokens: 1030, outputTokens: 554, cacheReadTokens: 11904, cacheWriteTokens: 0, totalTokens: 13488 }))
  assert.equal(u.totals.input, 1030)
  assert.equal(u.totals.cached, 11904)
  assert.equal(u.totals.output, 554)
  assert.equal(u.totals.calls, 1)
  assert.equal(u.model, 'm1')
  const totals = { ...emptyTotals(), ...u.totals }
  assert.equal(totalTokens(totals), 13488)
})

test('usageOf: ignores events without billed usage', () => {
  assert.equal(usageOf({ type: 'turn/start' }), undefined)
  assert.equal(usageOf({ type: 'assistant/message', data: {} }), undefined)
  assert.equal(usageOf(event({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })), undefined)
})

test('cacheHitRate: prompt = uncached + cache reads + cache writes', () => {
  assert.equal(cacheHitRate({ input: 100, cached: 900, cacheWrite: 0 }), 0.9)
  assert.equal(cacheHitRate({ input: 0, cached: 0, cacheWrite: 0 }), null)
  assert.equal(percent(0.634), '63%')
  assert.equal(percent(null), '—')
  assert.equal(percent(0.997), '99.7%') // a real 99.7% must not read as 100%
  assert.equal(percent(0.0004), '<0.1%')
  assert.equal(percent(1), '100%')
})

test('compact: k / M / B boundaries', () => {
  assert.equal(compact(980), '980')
  assert.equal(compact(8_823), '8.82k')
  assert.equal(compact(12_400), '12.4k')
  assert.equal(compact(186_000), '186k')
  assert.equal(compact(999_600), '1M') // 999.6k rounds up a unit instead of printing 1000k
  assert.equal(compact(1_250_000), '1.25M')
  assert.equal(compact(174_920_000), '175M')
  assert.equal(compact(3_590_000_000), '3.59B')
  assert.equal(compact(0), '0')
  assert.equal(compact(-1), '—')
})

test('dayKey / lastDays: local calendar days, oldest first', () => {
  const today = '2026-11-12'
  const days = lastDays(today, 7)
  assert.equal(days.length, 7)
  assert.equal(days.at(-1), today)
  assert.equal(days[0], '2026-11-06')
  assert.match(dayKey(Date.now()), /^\d{4}-\d{2}-\d{2}$/)
})

test('sumDays: works with a Map and skips missing days', () => {
  const a = { ...emptyTotals(), input: 10, calls: 2 }
  const b = { ...emptyTotals(), output: 5, calls: 1 }
  const days = new Map([
    ['2026-11-11', a],
    ['2026-11-12', b],
  ])
  const sum = sumDays(days, ['2026-11-10', '2026-11-11', '2026-11-12'])
  assert.equal(sum.input, 10)
  assert.equal(sum.output, 5)
  assert.equal(sum.calls, 3)
})

import { settlementOf, lastUsageSample } from '../lib/tally.js'

test('settlementOf: message usage, attempt stream sample, compaction excluded', () => {
  const message = { type: 'assistant/message', seq: 4, time: 1000, data: { turn: 2, step: 3, usage: { inputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 4, reasoningTokens: 5 }, message: { source: { provider: 'deepseek', model: 'm1' } } } }
  const s = settlementOf(message)
  assert.deepEqual(s.totals, { input: 1, cached: 2, cacheWrite: 3, output: 4, reasoning: 5, calls: 1 })
  assert.equal(s.model, 'm1')
  assert.equal(s.provider, 'deepseek')
  assert.equal(s.turn, 2)
  assert.equal(s.step, 3)

  const attempt = { type: 'assistant/attempt', seq: 5, time: 1001, data: { turn: 2, step: 3, stream: [{ chunk: { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } } }, { chunk: { type: 'usage', usage: { inputTokens: 7, cacheReadTokens: 70, outputTokens: 3 } } }] } }
  const a = settlementOf(attempt)
  assert.equal(totalTokens(a.totals), 80)
  assert.equal(a.model, '')
  assert.equal(a.cacheCounters, true)

  assert.equal(settlementOf({ type: 'compaction/summary', seq: 9, data: { usage: { inputTokens: 5 } } }), undefined)
  assert.equal(settlementOf({ type: 'user/message', seq: 1 }), undefined)
  assert.equal(lastUsageSample([{ chunk: { type: 'text' } }]), undefined)
})
