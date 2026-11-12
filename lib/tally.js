// Token tallies from DSH session records. Pure: no I/O, no clock.
//
// A model call is an `assistant/message` event whose `data.usage` is a TokenUsage
// (@deepseek-ai/dsh-llm). Counts are disjoint: `inputTokens` is uncached input,
// cache hits are `cacheReadTokens`, `reasoningTokens` is part of `outputTokens`.
//
// @typedef {{ input: number, cached: number, cacheWrite: number, output: number, reasoning: number, calls: number }} Totals

/** @returns {Totals} */
export const emptyTotals = () => ({ input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, calls: 0 })

const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/**
 * The usage one logged assistant message adds, or undefined when it adds none.
 * @deprecated Ledger accounting uses settlementOf() (messages *and* retried
 * attempts). Kept as a small public helper for callers that only need a message.
 * @param {any} event a parsed session-log event
 * @returns {{ totals: Totals, model: string, provider: string } | undefined}
 */
export function usageOf(event) {
  if (event?.type !== 'assistant/message') return undefined
  const u = event.data?.usage
  if (typeof u !== 'object' || u === null) return undefined
  const totals = {
    input: count(u.inputTokens),
    cached: count(u.cacheReadTokens),
    cacheWrite: count(u.cacheWriteTokens),
    output: count(u.outputTokens),
    reasoning: count(u.reasoningTokens),
    calls: 1,
  }
  if (totals.input + totals.cached + totals.cacheWrite + totals.output === 0) return undefined
  const source = event.data?.message?.source
  return {
    totals,
    model: typeof source?.model === 'string' ? source.model : '',
    provider: typeof source?.provider === 'string' ? source.provider : '',
  }
}

/** a += b, returns a. */
export function addTotals(a, b) {
  for (const k of Object.keys(a)) a[k] += b[k] ?? 0
  return a
}

/** Whether two totals describe the same billed buckets (calls/推理 excluded). */
export const bucketsEqual = (a, b) =>
  a.input === b.input && a.cached === b.cached && a.cacheWrite === b.cacheWrite && a.output === b.output

/** The last usage sample embedded in an Assistant stream, per the engine's rule. */
export function lastUsageSample(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const chunk = stream[i]?.chunk
    if (chunk?.type === 'usage' && chunk.usage !== null && typeof chunk.usage === 'object') return chunk.usage
  }
  return undefined
}

/**
 * The billed sample one durable Assistant settlement reports, following the
 * engine's own `tokenUsage` projection rule: a finished message prefers
 * `data.usage`, a retried/failed attempt reports the last usage sample of its
 * recorded stream. Compaction summaries are not settlements — the engine's
 * projection ignores them too — so they stay out of the ledger.
 *
 * @param {any} event a parsed session-log event
 * @returns {{ totals: Totals, model: string, provider: string, turn?: number, step?: number, seq: number, time: number, cacheCounters: boolean } | undefined}
 */
export function settlementOf(event) {
  const type = event?.type
  if (type !== 'assistant/message' && type !== 'assistant/attempt') return undefined
  const fromMessage = type === 'assistant/message' && event.data?.usage !== null && typeof event.data?.usage === 'object'
  const sample = fromMessage ? event.data.usage : lastUsageSample(event.data?.stream)
  if (sample === undefined || sample === null || typeof sample !== 'object') return undefined
  const totals = {
    input: count(sample.inputTokens),
    cached: count(sample.cacheReadTokens),
    cacheWrite: count(sample.cacheWriteTokens),
    output: count(sample.outputTokens),
    reasoning: count(sample.reasoningTokens),
    calls: 1,
  }
  if (totalTokens(totals) === 0) return undefined
  const source = event.data?.message?.source
  return {
    totals,
    model: typeof source?.model === 'string' ? source.model : '',
    provider: typeof source?.provider === 'string' ? source.provider : '',
    turn: Number.isInteger(event.data?.turn) ? event.data.turn : undefined,
    step: Number.isInteger(event.data?.step) ? event.data.step : undefined,
    seq: Number.isInteger(event.seq) ? event.seq : -1,
    time: Number.isFinite(event.time) ? event.time : 0,
    cacheCounters: sample.cacheReadTokens !== undefined || sample.cacheWriteTokens !== undefined,
  }
}

/** All billed tokens: uncached input + cache reads + cache writes + output. */
export const totalTokens = (t) => t.input + t.cached + t.cacheWrite + t.output

/** Share of prompt tokens served from the cache, 0–1; null without prompt tokens. */
export function cacheHitRate(t) {
  const prompt = t.input + t.cached + t.cacheWrite
  return prompt === 0 ? null : t.cached / prompt
}

/**
 * Three significant digits, one set of units everywhere: 980 · 8.82k · 186k ·
 * 1.25M · 175M · 3.59B. k/M/B/T follow how token counts are usually written
 * (B = billion = 十亿; an SI "G" means the same thing but reads as giga). Keeping
 * the digit count consistent makes numbers in one panel comparable at a glance.
 */
export function compact(n) {
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1000) return String(Math.round(n))
  const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'k']]
  for (const [base, suffix] of units) {
    if (n < base) continue
    const v = n / base
    const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2
    const rounded = Number(v.toFixed(digits))
    // 999.6k must become 1M, not "1000k".
    if (rounded >= 1000 && base !== 1e12) return compact(rounded * base)
    return `${rounded}${suffix}`
  }
  return String(Math.round(n))
}

/**
 * 0.634 → "63%"; null → "—". Rounds to whole percent, except that a value which
 * would round to 100% (or 0%) while not actually being there keeps one decimal —
 * a 99.7% cache hit rate must not read as "100%".
 */
export function percent(r) {
  if (r === null || !Number.isFinite(r)) return '—'
  const whole = Math.round(r * 100)
  if (whole >= 100 && r < 0.9995) return `${(r * 100).toFixed(1)}%`
  if (whole >= 100 && r < 1) return '>99.9%'
  if (whole <= 0 && r > 0) return r < 0.001 ? '<0.1%' : `${(r * 100).toFixed(1)}%`
  return `${whole}%`
}

/** Local calendar day of an epoch-ms time: "2026-10-25". */
export function dayKey(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** The `n` local days ending with `today` (oldest first). */
export function lastDays(today, n) {
  const [y, m, d] = today.split('-').map(Number)
  const out = []
  for (let i = n - 1; i >= 0; i--) out.push(dayKey(new Date(y, m - 1, d - i, 12).getTime()))
  return out
}

/** Sum of the day buckets in `days` (a Map or a plain object) restricted to `dates`. */
export function sumDays(days, dates) {
  const out = emptyTotals()
  for (const date of dates) {
    const t = days instanceof Map ? days.get(date) : days[date]
    if (t !== undefined) addTotals(out, t)
  }
  return out
}
