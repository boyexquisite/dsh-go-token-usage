// 面板视图、数据模型、状态条文案。视图只画结构和绑定，数字全走 data.*，
// 这样桥接推的是小补丁（≤ 4 次/秒），App 不会整页重画。
//
// 展示约定：所有 token 数统一 k/M/G 三位有效数字；总量 = 未缓存输入 + 缓存读取 +
// 缓存写入 + 输出；「未缓存输入」单列一项，避免把它误当成全部输入。
import { cacheHitRate, compact, lastDays, percent, totalTokens } from './tally.js'

const WORDS = {
  zh: {
    title: 'Token 用量',
    units: '单位 tokens：k = 千、M = 百万、G = 十亿。「总量」= 未缓存输入 + 缓存读取 + 缓存写入 + 输出。',
    groupToday: '概览',
    groupWindow: '时间窗口',
    groupCache: '缓存（近 30 天）',
    groupSession: '本对话',
    groupAll: '累计明细',
    groupMonth: '近 30 天明细',
    groupModels: '今日模型（tokens）',
    today: '今日',
    week: '近 7 天',
    month: '近 30 天',
    all: '累计',
    daily: '日均（有数据天数）',
    calls30: '调用（30 天，次）',
    todayHit: '今日命中率',
    todayCalls: '今日调用（次）',
    sessionCalls: '调用（次）',
    covered: '覆盖天数（30 天）',
    hit: '命中率',
    monthHit: '命中率',
    cached: '缓存读取',
    cacheWrite: '缓存写入',
    total: '总量',
    input: '未缓存输入',
    inputTotal: '输入合计',
    output: '输出',
    reasoning: '其中推理',
    tokens: 'tokens',
    chart: '近 7 天 · 每天 tokens（含缓存）',
    copy: '复制统计',
    copied: '已复制',
    refresh: '刷新',
    refreshed: '已刷新',
    updatedAll: (t) => `已更新 ${t}`,
    noData: '还没有调用记录，发一条消息后这里就有数字了',
    source: '数据来自本机会话记录，不联网、不估算；推理 tokens 引擎没上报时显示「—」。',
    strip: (session, today) => (session === null ? `今日 ${today}` : `本对话 ${session} · 今日 ${today}`),
    turn: (tokens, hit) => `${tokens} · 命中${hit}`,
  },
  en: {
    title: 'Token usage',
    units: 'Units in tokens: k = thousand, M = million, G = billion. Total = uncached input + cache reads + cache writes + output.',
    groupToday: 'Overview',
    groupWindow: 'Windows',
    groupCache: 'Cache (last 30 days)',
    groupSession: 'This chat',
    groupAll: 'All time',
    groupMonth: 'Last 30 days',
    groupModels: 'Models today (tokens)',
    today: 'Today',
    week: 'Last 7 days',
    month: 'Last 30 days',
    all: 'All time',
    daily: 'Daily avg (days with calls)',
    calls30: 'Calls (30 days)',
    todayHit: 'Hit rate today',
    todayCalls: 'Calls today',
    sessionCalls: 'Calls',
    covered: 'Days with calls (30)',
    hit: 'Hit rate',
    monthHit: 'Hit rate',
    cached: 'Cache reads',
    cacheWrite: 'Cache writes',
    total: 'Total',
    input: 'Uncached input',
    inputTotal: 'Input total',
    output: 'Output',
    reasoning: 'Reasoning',
    tokens: 'tokens',
    chart: 'Tokens per day, last 7 days (cache included)',
    copy: 'Copy summary',
    copied: 'Copied',
    refresh: 'Refresh',
    refreshed: 'Refreshed',
    updatedAll: (t) => `Updated ${t}`,
    noData: 'No model calls yet — send a message and the numbers show up here',
    source: "Counted from this host's session logs. No network, no estimates. Reasoning shows an em dash when the engine does not report it.",
    strip: (session, today) => (session === null ? `Today ${today}` : `Chat ${session} · today ${today}`),
    turn: (tokens, hit) => `${tokens} · hit ${hit}`,
  },
}

/** zh unless the app's locale says otherwise. */
export function words(locale) {
  return typeof locale === 'string' && locale.toLowerCase().startsWith('en') ? WORDS.en : WORDS.zh
}

const breakdown = (t) => {
  const inputTotal = (t?.input ?? 0) + (t?.cached ?? 0) + (t?.cacheWrite ?? 0)
  return {
    total: t === undefined ? '—' : compact(totalTokens(t)),
    input: compact(t?.input ?? 0),
    cached: compact(t?.cached ?? 0),
    cacheWrite: compact(t?.cacheWrite ?? 0),
    inputTotal: t === undefined ? '—' : compact(inputTotal),
    output: compact(t?.output ?? 0),
    reasoning: (t?.reasoning ?? 0) > 0 ? compact(t.reasoning) : '—',
    calls: compact(t?.calls ?? 0),
    hit: percent(cacheHitRate(t ?? { input: 0, cached: 0, cacheWrite: 0 })),
  }
}

const rows = (w, prefix) => [
  [w.input, { $: `data.${prefix}.input` }],
  [w.cached, { $: `data.${prefix}.cached` }],
  [w.cacheWrite, { $: `data.${prefix}.cacheWrite` }],
  [w.inputTotal, { $: `data.${prefix}.inputTotal` }],
  [w.output, { $: `data.${prefix}.output` }],
  [w.reasoning, { $: `data.${prefix}.reasoning` }],
]

const metricRow = (w, prefix, labels) => ({
  type: 'row',
  children: [
    { type: 'metric', label: labels[0], value: { $: `data.${prefix}.total` } },
    { type: 'metric', label: labels[1], value: { $: `data.${prefix}.hit` } },
    { type: 'metric', label: labels[2], value: { $: `data.${prefix}.calls` } },
  ],
})

/**
 * The panel: today / windows / cache / this chat / last-30-day detail / models.
 * `scope.sessionId` is set inside a chat (session.tab, chat.panel) and absent in All features.
 */
export function usageView(scope, caps) {
  const w = words(caps?.locale)
  const inChat = typeof scope?.sessionId === 'string' && scope.sessionId !== ''
  const windows = [
    [w.week, { $: 'data.week.total' }],
    [w.month, { $: 'data.month.total' }],
    [w.daily, { $: 'data.month.daily' }],
    [w.covered, { $: 'data.month.days' }],
    [w.calls30, { $: 'data.month.calls' }],
  ]
  return {
    type: 'stack',
    title: w.title,
    children: [
      { type: 'text', text: w.units, tone: 'muted' },
      { type: 'text', text: w.groupToday, tone: 'muted' },
      metricRow(w, 'today', [w.today, w.todayHit, w.todayCalls]),
      { type: 'text', text: w.groupWindow, tone: 'muted' },
      { type: 'keyValue', items: windows },
      { type: 'text', text: w.groupCache, tone: 'muted' },
      {
        type: 'keyValue',
        items: [
          [w.cached, { $: 'data.month.cached' }],
          [w.cacheWrite, { $: 'data.month.cacheWrite' }],
          [w.monthHit, { $: 'data.month.hit' }],
        ],
      },
      {
        type: 'chart',
        kind: 'bar',
        categories: { $: 'data.chart.labels' },
        series: [{ name: w.tokens, values: { $: 'data.chart.values' } }],
        caption: w.chart,
      },
      { type: 'text', text: inChat ? w.groupSession : w.groupAll, tone: 'muted' },
      metricRow(w, inChat ? 'session' : 'all', [w.total, w.hit, w.sessionCalls]),
      { type: 'keyValue', items: rows(w, inChat ? 'session' : 'all') },
      { type: 'text', text: w.groupMonth, tone: 'muted' },
      { type: 'keyValue', items: rows(w, 'month') },
      { type: 'text', text: w.groupModels, tone: 'muted' },
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
  const w = words() // numbers only; 更新时间也只含数字
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
  const monthTotal = totalTokens(month)
  const covered = ledger.coveredDays(30)
  const daily = month.calls === 0 ? '—' : compact(Math.round(monthTotal / Math.max(1, covered)))
  return {
    today: breakdown(ledger.window(1)),
    week: breakdown(ledger.window(7)),
    month: { ...breakdown(month), daily, days: String(covered) },
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
  const sessionId = typeof scope?.sessionId === 'string' && scope.sessionId !== '' ? scope.sessionId : null
  const session = sessionId === null ? undefined : ledger.session(sessionId)
  return {
    text: w.strip(session === undefined ? null : compact(totalTokens(session)), today),
    icon: 'chart',
  }
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
    lines.push(`${w.groupSession}: ${compact(totalTokens(session))} tokens`)
  }
  lines.push(`${w.today}: ${compact(totalTokens(today))} tokens · ${w.hit} ${percent(cacheHitRate(today))} · ${today.calls} calls`)
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
