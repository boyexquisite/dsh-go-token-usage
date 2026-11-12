// 面板视图、数据模型、状态条文案。
//
// 面板用视图 v2 的分组卡片：每一段一个彩色卡片（不同主题色），顺序固定为
// 累计 → 本对话 → 今日 → 近 7 天 → 近 30 天，最后才是模型/明细，方便一眼分区。
// 视图只画结构和绑定，数字全走 data.*，桥接推的是小补丁。
import { cacheHitRate, compact, lastDays, percent, totalTokens } from './tally.js'

const WORDS = {
  zh: {
    all: '累计',
    session: '本对话',
    today: '今日',
    week: '近 7 天',
    month: '近 30 天',
    total: '总量',
    hit: '命中率',
    calls: '调用',
    tokens: 'tokens',
    times: '次',
    daily: '日均',
    days: '覆盖天数',
    models: '今日模型',
    breakdown: '明细',
    input: '未缓存输入',
    cached: '缓存读取',
    cacheWrite: '缓存写入',
    inputTotal: '输入合计',
    output: '输出',
    reasoning: '其中推理',
    chart: '每天 tokens（含缓存）',
    copy: '复制统计',
    copied: '已复制',
    refresh: '刷新',
    refreshed: '已刷新',
    updatedAll: (t) => `已更新 ${t}`,
    noData: '还没有调用记录',
    strip: (session, today) => (session === null ? `今日 ${today}` : `本对话 ${session} · 今日 ${today}`),
    turn: (tokens, hit) => `${tokens} · 命中${hit}`,
  },
  en: {
    all: 'All time',
    session: 'This chat',
    today: 'Today',
    week: 'Last 7 days',
    month: 'Last 30 days',
    total: 'Total',
    hit: 'Hit rate',
    calls: 'Calls',
    tokens: 'tokens',
    times: 'calls',
    daily: 'Daily avg',
    days: 'Days with calls',
    models: 'Models today',
    breakdown: 'Breakdown',
    input: 'Uncached input',
    cached: 'Cache reads',
    cacheWrite: 'Cache writes',
    inputTotal: 'Input total',
    output: 'Output',
    reasoning: 'Reasoning',
    chart: 'Tokens per day (cache included)',
    copy: 'Copy summary',
    copied: 'Copied',
    refresh: 'Refresh',
    refreshed: 'Refreshed',
    updatedAll: (t) => `Updated ${t}`,
    noData: 'No model calls yet',
    strip: (session, today) => (session === null ? `Today ${today}` : `Chat ${session} · today ${today}`),
    turn: (tokens, hit) => `${tokens} · hit ${hit}`,
  },
}

/** zh unless the app's locale says otherwise. */
export function words(locale) {
  return typeof locale === 'string' && locale.toLowerCase().startsWith('en') ? WORDS.en : WORDS.zh
}

// 每一段的主题色，顺序与卡片顺序一致。
const COLORS = { all: 'blue', session: 'green', today: 'orange', week: 'teal', month: 'violet' }

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

const metric = (w, label, value, color, caption) => ({
  type: 'metric',
  label,
  value,
  caption,
  style: { size: 'subtitle', weight: 'bold', color },
})

/** 一段：彩色卡片 + 标题 + 三个指标（总量 / 命中率 / 调用）。 */
function section(w, key, title, extra = []) {
  const color = COLORS[key]
  return {
    type: 'stack',
    style: { card: 'tinted', background: color, padding: 'M', gap: 'S' },
    children: [
      { type: 'text', text: title, style: { size: 'subtitle', weight: 'bold', color } },
      {
        type: 'row',
        style: { columns: [1, 1, 1], gap: 'S' },
        children: [
          metric(w, w.total, { $: `data.${key}.total` }, color, w.tokens),
          metric(w, w.hit, { $: `data.${key}.hit` }, color),
          metric(w, w.calls, { $: `data.${key}.calls` }, color, w.times),
        ],
      },
      ...extra,
    ],
  }
}

const pair = (prefix, rows) => ({
  type: 'keyValue',
  items: rows.map(([label, key]) => [label, { $: `data.${prefix}.${key}` }]),
})

/**
 * 面板：累计 → 本对话 → 今日 → 近 7 天 → 近 30 天，各一段彩色卡片。
 * `scope.sessionId` 在对话里才有（session.tab、chat.panel）；「全部功能」里没有本对话段。
 */
export function usageView(scope, caps) {
  const w = words(caps?.locale)
  const inChat = typeof scope?.sessionId === 'string' && scope.sessionId !== ''
  const cards = [section(w, 'all', w.all, [pair('all', [[w.inputTotal, 'inputTotal'], [w.output, 'output']])])]
  if (inChat) {
    cards.push(section(w, 'session', w.session, [pair('session', [[w.inputTotal, 'inputTotal'], [w.output, 'output']])]))
  }
  cards.push(
    section(w, 'today', w.today, [
      pair('today', [[w.inputTotal, 'inputTotal'], [w.output, 'output']]),
      { type: 'text', text: w.models, style: { size: 'caption', weight: 'medium', color: COLORS.today } },
      { type: 'list', items: { $: 'data.models' } },
    ]),
  )
  cards.push(
    section(w, 'week', w.week, [
      {
        type: 'chart',
        kind: 'bar',
        categories: { $: 'data.chart.labels' },
        series: [{ name: w.tokens, values: { $: 'data.chart.values' } }],
        caption: w.chart,
      },
      pair('week', [[w.daily, 'daily'], [w.days, 'days']]),
    ]),
  )
  cards.push(
    section(w, 'month', w.month, [
      pair('month', [[w.daily, 'daily'], [w.days, 'days']]),
      { type: 'text', text: w.breakdown, style: { size: 'caption', weight: 'medium', color: COLORS.month } },
      pair('month', [
        [w.input, 'input'],
        [w.cached, 'cached'],
        [w.cacheWrite, 'cacheWrite'],
        [w.inputTotal, 'inputTotal'],
        [w.output, 'output'],
        [w.reasoning, 'reasoning'],
      ]),
    ]),
  )
  return {
    v: 2,
    accent: 'app',
    type: 'stack',
    style: { gap: 'M' },
    children: [
      ...cards,
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
  const w = words() // 数字与模型名，不带语言
  const today = ledger.today()
  const month = ledger.window(30)
  const week = ledger.window(7)
  const sessionId = typeof scope?.sessionId === 'string' && scope.sessionId !== '' ? scope.sessionId : null
  const session = sessionId === null ? undefined : ledger.session(sessionId)
  const dates = lastDays(today, 7)
  const meta = ledger.meta()
  const models = ledger.todayModels(6).map(([model, tokens]) => ({
    title: model,
    trailing: compact(tokens),
    icon: 'robot',
  }))
  const weekCovered = ledger.coveredDays(7)
  const monthCovered = ledger.coveredDays(30)
  const average = (totals, covered) => (totals.calls === 0 ? '—' : compact(Math.round(totalTokens(totals) / Math.max(1, covered))))
  return {
    all: breakdown(ledger.allTime()),
    session: breakdown(session),
    today: breakdown(ledger.window(1)),
    week: { ...breakdown(week), daily: average(week, weekCovered), days: String(weekCovered) },
    month: { ...breakdown(month), daily: average(month, monthCovered), days: String(monthCovered) },
    chart: {
      labels: dates.map((d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`),
      values: ledger.dailyValues(7),
    },
    models,
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
  if (session !== undefined) lines.push(`${w.session}: ${compact(totalTokens(session))} tokens`)
  lines.push(`${w.today}: ${compact(totalTokens(today))} tokens · ${w.hit} ${percent(cacheHitRate(today))} · ${today.calls} ${w.times}`)
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
