// 面板视图、数据模型、状态条文案。视图只画结构和绑定，数字全走 data.*，
// 这样桥接推的是小补丁（≤ 4 次/秒），App 不会整页重画。
import { cacheHitRate, compact, lastDays, percent, totalTokens } from './tally.js'

const WORDS = {
  zh: {
    title: 'Token 用量',
    today: '今日',
    week: '近 7 天',
    month: '近 30 天',
    all: '累计',
    hit: '缓存命中',
    hit30: '缓存命中（近 30 天）',
    daily: '日均（近 30 天）',
    session: '本对话',
    monthTitle: '近 30 天明细',
    allTitle: '累计明细',
    modelsTitle: '今日模型',
    total: '总计',
    input: '输入（未缓存）',
    cached: '缓存读取',
    cacheWrite: '缓存写入',
    output: '输出',
    reasoning: '其中推理',
    calls: '模型调用',
    tokens: 'tokens',
    chart: '近 7 天每天 tokens',
    copy: '复制统计',
    copied: '已复制',
    refresh: '刷新',
    refreshed: '已刷新',
    updatedAll: (t) => `已更新 ${t}`,
    noData: '还没有调用记录，发一条消息后这里就有数字了',
    source: '数据来自本机会话记录，不联网、不估算',
    turn: (tokens, hit) => `${tokens} · 缓存${hit}`,
    strip: (session, today, hit) =>
      session === null ? `${today} · 缓存 ${hit}` : `本对话 ${session} · 今日 ${today}`,
  },
  en: {
    title: 'Token usage',
    today: 'Today',
    week: 'Last 7 days',
    month: 'Last 30 days',
    all: 'All time',
    hit: 'Cache hits',
    hit30: 'Cache hits (30 days)',
    daily: 'Daily avg (30 days)',
    session: 'This chat',
    monthTitle: 'Last 30 days',
    allTitle: 'All time',
    modelsTitle: 'Models today',
    total: 'Total',
    input: 'Input (uncached)',
    cached: 'Cache reads',
    cacheWrite: 'Cache writes',
    output: 'Output',
    reasoning: 'Reasoning',
    calls: 'Model calls',
    tokens: 'tokens',
    chart: 'Tokens per day, last 7 days',
    copy: 'Copy summary',
    copied: 'Copied',
    refresh: 'Refresh',
    refreshed: 'Refreshed',
    updatedAll: (t) => `Updated ${t}`,
    noData: 'No model calls yet — send a message and the numbers show up here',
    source: 'Counted from this host\'s session logs; no network, no estimates',
    turn: (tokens, hit) => `${tokens} · 缓存${hit}`,
    turn: (tokens, hit) => `${tokens} · ${hit}`,
    strip: (session, today, hit) =>
      session === null ? `${today} · cache ${hit}` : `Chat ${session} · today ${today}`,
  },
}

/** zh unless the app's locale says otherwise. */
export function words(locale) {
  return typeof locale === 'string' && locale.toLowerCase().startsWith('en') ? WORDS.en : WORDS.zh
}

const breakdown = (t) => ({
  total: t === undefined ? '—' : compact(totalTokens(t)),
  input: compact(t?.input ?? 0),
  cached: compact(t?.cached ?? 0),
  cacheWrite: compact(t?.cacheWrite ?? 0),
  output: compact(t?.output ?? 0),
  reasoning: compact(t?.reasoning ?? 0),
  calls: String(t?.calls ?? 0),
  hit: percent(cacheHitRate(t ?? { input: 0, cached: 0, cacheWrite: 0 })),
})

const rows = (w, prefix) => [
  [w.input, { $: `data.${prefix}.input` }],
  [w.cached, { $: `data.${prefix}.cached` }],
  [w.cacheWrite, { $: `data.${prefix}.cacheWrite` }],
  [w.output, { $: `data.${prefix}.output` }],
  [w.reasoning, { $: `data.${prefix}.reasoning` }],
  [w.calls, { $: `data.${prefix}.calls` }],
]

/**
 * The panel: this chat / today / last 7 days / last 30 days / cache hits.
 * `scope.sessionId` is set inside a chat (session.tab, chat.panel) and absent in All features.
 */
export function usageView(scope, caps) {
  const w = words(caps?.locale)
  const inChat = typeof scope?.sessionId === 'string' && scope.sessionId !== ''
  return {
    type: 'stack',
    title: w.title,
    children: [
      {
        type: 'row',
        children: [
          { type: 'metric', label: w.today, value: { $: 'data.today.total' }, tone: 'info' },
          { type: 'metric', label: w.week, value: { $: 'data.week.total' } },
          { type: 'metric', label: w.month, value: { $: 'data.month.total' } },
        ],
      },
      {
        type: 'row',
        children: [
          { type: 'metric', label: w.hit30, value: { $: 'data.month.hit' }, tone: 'good' },
          { type: 'metric', label: w.daily, value: { $: 'data.month.daily' } },
          { type: 'metric', label: w.all, value: { $: 'data.all.total' } },
        ],
      },
      {
        type: 'chart',
        kind: 'bar',
        categories: { $: 'data.chart.labels' },
        series: [{ name: w.tokens, values: { $: 'data.chart.values' } }],
        caption: w.chart,
      },
      { type: 'text', text: inChat ? w.session : w.allTitle, tone: 'muted' },
      { type: 'keyValue', items: rows(w, inChat ? 'session' : 'all') },
      { type: 'text', text: w.monthTitle, tone: 'muted' },
      { type: 'keyValue', items: rows(w, 'month') },
      { type: 'text', text: w.modelsTitle, tone: 'muted' },
      { type: 'list', items: { $: 'data.models' } },
      { type: 'callout', text: { $: 'data.note' }, tone: 'info' },
      {
        type: 'actions',
        items: [
          { label: w.copy, action: 'copy', icon: 'summary' },
          { label: w.refresh, action: 'refresh', icon: 'refresh' },
        ],
      },
      { type: 'text', text: { $: 'data.updated' }, tone: 'muted' },
    ],
  }
}

/** The data model the panel and the strip bind to. Language-neutral numbers and names. */
export function usageData(ledger, scope) {
  const w = words() // numbers only; 「更新于」时间也只用数字
  const today = ledger.today()
  const month = ledger.window(30)
  const sessionId = typeof scope?.sessionId === 'string' && scope.sessionId !== '' ? scope.sessionId : null
  const session = sessionId === null ? undefined : ledger.session(sessionId)
  const dates = lastDays(today, 7)
  const meta = ledger.meta()
  const models = ledger.todayModels(6).map(([model, tokens]) => ({
    title: model,
    trailing: compact(tokens),
    icon: 'robot',
  }))
  const daily = month.calls === 0 ? '—' : compact(Math.round(totalTokens(month) / 30))
  return {
    today: breakdown(ledger.window(1)),
    week: breakdown(ledger.window(7)),
    month: { ...breakdown(month), daily },
    all: breakdown(ledger.allTime()),
    session: breakdown(session),
    chart: {
      labels: dates.map((d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`),
      values: ledger.dailyValues(7),
    },
    models,
    note: models.length === 0 && month.calls === 0 ? w.noData : w.source,
    updated: w.updatedAll(formatClock(meta.newest)),
  }
}

/** The status-strip line (≤ 24 characters). */
export function stripData(ledger, scope, locale) {
  const w = words(locale)
  const today = compact(totalTokens(ledger.window(1)))
  const hit = percent(cacheHitRate(ledger.window(1)))
  const sessionId = typeof scope?.sessionId === 'string' && scope.sessionId !== '' ? scope.sessionId : null
  const session = sessionId === null ? undefined : ledger.session(sessionId)
  return {
    text: w.strip(session === undefined ? null : compact(totalTokens(session)), today, hit),
    icon: 'chart',
  }
}

/** Plain-text summary for the clipboard. */
export function summaryText(ledger, scope, locale) {
  const w = words(locale)
  const today = ledger.window(1)
  const week = ledger.window(7)
  const month = ledger.window(30)
  const sessionId = typeof scope?.sessionId === 'string' && scope.sessionId !== '' ? scope.sessionId : null
  const session = sessionId === null ? undefined : ledger.session(sessionId)
  const lines = []
  if (session !== undefined) {
    lines.push(`${w.session}: ${compact(totalTokens(session))} tokens（${w.input} ${compact(session.input)}、${w.cached} ${compact(session.cached)}、${w.output} ${compact(session.output)}）`)
  }
  lines.push(`${w.today}: ${compact(totalTokens(today))} tokens · ${w.hit} ${percent(cacheHitRate(today))} · ${w.calls} ${today.calls}`)
  lines.push(`${w.week}: ${compact(totalTokens(week))} tokens`)
  lines.push(`${w.month}: ${compact(totalTokens(month))} tokens · ${w.hit} ${percent(cacheHitRate(month))}`)
  for (const [model, tokens] of ledger.todayModels(4)) lines.push(`- ${model}: ${compact(tokens)}`)
  return lines.join('\n')
}

function formatClock(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Per-turn footnotes: turn number -> one short line with that turn's tokens and cache hits. */
export function turnNoteData(ledger, scope, locale) {
  const w = words(locale)
  const turns = ledger.sessionTurnsOf(scope?.sessionId)
  const out = {}
  for (const [turn, totals] of turns) {
    const tokens = compact(totalTokens(totals))
    const hit = percent(cacheHitRate(totals))
    out[String(turn)] = { text: w.turn(tokens, hit), tone: 'muted' }
  }
  return out
}
