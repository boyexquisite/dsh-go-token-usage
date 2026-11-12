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

/** All billed tokens: uncached input + cache reads + cache writes + output. */
export const totalTokens = (t) => t.input + t.cached + t.cacheWrite + t.output

/** Share of prompt tokens served from the cache, 0–1; null without prompt tokens. */
export function cacheHitRate(t) {
  const prompt = t.input + t.cached + t.cacheWrite
  return prompt === 0 ? null : t.cached / prompt
}

/**
 * Three significant digits, one set of units everywhere: 980 · 8.82k · 186k ·
 * 1.25M · 175M · 3.59G. Keeping the digit count consistent makes the numbers in
 * one panel comparable at a glance (2-decimal M next to 1-decimal k reads wrong).
 */
export function compact(n) {
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1000) return String(Math.round(n))
  const units = [[1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k']]
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
  if (whole >= 100 && r < 1) return `${(r * 100).toFixed(1)}%`
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
