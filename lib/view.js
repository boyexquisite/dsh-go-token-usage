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

// 字号比默认小一档：标题与数字都用 body(16)，说明用 caption(13)。
const TITLE_STYLE = (color) => ({ size: 'body', weight: 'bold', color })
const VALUE_STYLE = (color) => ({ size: 'body', weight: 'bold', color })
const NOTE_STYLE = { size: 'caption' }

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
  style: VALUE_STYLE(color),
})

/** 一段：彩色卡片，「标题 + 总量」一行，下面「命中率 | 调用」并排。 */
function section(w, key, title, extra = []) {
  const color = COLORS[key]
  return {
    type: 'stack',
    style: { card: 'tinted', background: color, padding: 'S', gap: 'S' },
    children: [
      {
        type: 'row',
        style: { columns: [1, 1], gap: 'S' },
        children: [
          { type: 'text', text: title, style: TITLE_STYLE(color) },
          metric(w, w.total, { $: `data.${key}.total` }, color, w.tokens),
        ],
      },
      {
        type: 'row',
        style: { columns: [1, 1], gap: 'S' },
        children: [
          metric(w, w.hit, { $: `data.${key}.hit` }, color),
          metric(w, w.calls, { $: `data.${key}.calls` }, color, w.times),
        ],
      },
      ...extra,
    ],
  }
}

/** 一行并排的小字：标签灰、数字粗，省掉一堆上下堆叠的 keyValue。 */
function inline(w, parts) {
  const fallback = parts.map((p) => p.label).join(' · ')
  return {
    type: 'text',
    text: fallback,
    style: NOTE_STYLE,
    spans: parts.flatMap((p, i) => [
      ...(i === 0 ? [] : [{ text: ' · ' }]),
      { text: p.label + ' ' },
      { text: p.value, weight: 'bold' },
    ]),
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
  const io = (key) =>
    inline(w, [
      { label: w.inputTotal, value: { $: `data.${key}.inputTotal` } },
      { label: w.output, value: { $: `data.${key}.output` } },
    ])
  const average = (key) =>
    inline(w, [
      { label: w.daily, value: { $: `data.${key}.daily` } },
      { label: w.days, value: { $: `data.${key}.days` } },
    ])
  const cards = [section(w, 'all', w.all, [io('all')])]
  if (inChat) cards.push(section(w, 'session', w.session, [io('session')]))
  cards.push(section(w, 'today', w.today, [io('today'), { type: 'text', text: { $: 'data.modelsLine' }, style: NOTE_STYLE }]))
  cards.push(
    section(w, 'week', w.week, [
      {
        type: 'chart',
        kind: 'bar',
        categories: { $: 'data.chart.labels' },
        series: [{ name: w.tokens, values: { $: 'data.chart.values' } }],
        caption: w.chart,
      },
      average('week'),
    ]),
  )
  cards.push(
    section(w, 'month', w.month, [
      average('month'),
      {
        type: 'row',
        style: { columns: [1, 1], gap: 'S' },
        children: [
          pair('month', [
            [w.input, 'input'],
            [w.cached, 'cached'],
            [w.cacheWrite, 'cacheWrite'],
          ]),
          pair('month', [
            [w.inputTotal, 'inputTotal'],
            [w.output, 'output'],
            [w.reasoning, 'reasoning'],
          ]),
        ],
      },
    ]),
  )
  return {
    v: 2,
    accent: 'app',
    type: 'stack',
    style: { gap: 'S' },
    children: [
      ...cards,
      {
        type: 'actions',
        items: [
          { label: w.copy, action: 'copy', icon: 'summary' },
          { label: w.refresh, action: 'refresh', icon: 'refresh' },
        ],
      },
      { type: 'text', text: { $: 'data.updated' }, tone: 'muted', style: NOTE_STYLE },
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
  const todayModels = ledger.todayModels(4)
  const models = todayModels.map(([model, tokens]) => ({
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
    modelsLine: todayModels.map(([model, tokens]) => `${model} ${compact(tokens)}`).join(' · '),
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
