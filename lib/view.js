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
    calls: '调用（次）',
    tokens: 'tokens',
    times: '次',
    daily: '日均',
    days: '覆盖天数（天）',
    models: '今日模型',
    srcAccount: '官方 · 账号',
    srcApiKey: '官方 · API Key',
    srcSubscription: '订阅 · ',
    srcRelay: '中转 · ',
    srcThird: '第三方 · ',
    srcUnknown: '未知来源',
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
    days: 'Days covered',
    models: 'Models today',
    srcAccount: 'official · account',
    srcApiKey: 'official · API key',
    srcSubscription: 'subscription · ',
    srcRelay: 'relay · ',
    srcThird: 'third-party · ',
    srcUnknown: 'unknown source',
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

/** provider 名 → 来源标签：官方账号 / 官方 Key / 订阅 / 中转 / 第三方。 */
export function sourceLabel(provider, locale) {
  const w = words(locale)
  const p = typeof provider === 'string' ? provider.trim() : ''
  const lower = p.toLowerCase()
  if (lower === '') return w.srcUnknown
  if (lower === 'deepseek-account' || (lower.includes('deepseek') && lower.includes('account'))) return w.srcAccount
  if (lower.includes('api-key') || lower.includes('apikey')) return w.srcApiKey
  if (lower === 'custom-command-code' || lower.includes('command-code')) return w.srcSubscription + 'command-code'
  if (lower.startsWith('custom-')) return w.srcRelay + lower.slice('custom-'.length)
  if (lower.includes('official')) return w.srcAccount
  return w.srcThird + p
}

// 每一段的主题色，顺序与卡片顺序一致。
const COLORS = { all: 'blue', session: 'green', today: 'orange', week: 'teal', month: 'violet' }

// 每张卡片同一套骨架：标题+总量一行，下面是左右对齐的 keyValue 行，
// 这样五段的「命中率 / 调用 / 输入合计 / 输出」上下对齐，看起来齐整。
const TITLE_SIZE = 'subtitle'
const NOTE_SIZE = 'caption'
const GRAY = 'gray'

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

/** 卡片第一行：彩色标题 + 总量 + 单位。 */
function headline(w, key, title) {
  return {
    type: 'text',
    text: `${title} · ${w.total} · ${w.tokens}`,
    style: { size: TITLE_SIZE, weight: 'bold' },
    spans: [
      { text: title, weight: 'bold', color: COLORS[key] },
      { text: '  ' },
      { text: { $: `data.${key}.total` }, weight: 'bold', color: COLORS[key] },
      { text: ' ' + w.tokens, color: GRAY },
    ],
  }
}

/** 左右对齐的一行：名称在左、数值在右。 */
const row = (label, value) => ({ label, value: { $: value } })

const kv = (items) => ({ type: 'keyValue', items })

const card = (key, children) => ({
  type: 'stack',
  style: { card: 'tinted', background: COLORS[key], padding: 'M', gap: 'S' },
  children,
})

/**
 * 面板：累计 → 本对话 → 今日 → 近 7 天 → 近 30 天，各一段彩色卡片。
 * `scope.sessionId` 在对话里才有（session.tab、chat.panel）；「全部功能」里没有本对话段。
 */
export function usageView(scope, caps) {
  const w = words(caps?.locale)
  const inChat = typeof scope?.sessionId === 'string' && scope.sessionId !== ''
  const common = (key) => [
    row(w.hit, `data.${key}.hit`),
    row(w.calls, `data.${key}.calls`),
    row(w.inputTotal, `data.${key}.inputTotal`),
    row(w.output, `data.${key}.output`),
  ]
  const cards = [card('all', [headline(w, 'all', w.all), kv(common('all'))])]
  if (inChat) cards.push(card('session', [headline(w, 'session', w.session), kv(common('session'))]))
  cards.push(
    card('today', [
      headline(w, 'today', w.today),
      kv(common('today')),
      { type: 'text', text: w.models, style: { size: NOTE_SIZE, weight: 'bold', color: COLORS.today } },
      { type: 'list', items: { $: 'data.models' } },
    ]),
  )
  cards.push(
    card('week', [
      headline(w, 'week', w.week),
      kv([...common('week'), row(w.daily, 'data.week.daily'), row(w.days, 'data.week.days')]),
      {
        type: 'chart',
        kind: 'bar',
        categories: { $: 'data.chart.labels' },
        series: [{ name: w.tokens, values: { $: 'data.chart.values' } }],
        caption: w.chart,
      },
    ]),
  )
  cards.push(
    card('month', [
      headline(w, 'month', w.month),
      kv([
        ...common('month'),
        row(w.daily, 'data.month.daily'),
        row(w.days, 'data.month.days'),
        row(w.input, 'data.month.input'),
        row(w.cached, 'data.month.cached'),
        row(w.cacheWrite, 'data.month.cacheWrite'),
        row(w.reasoning, 'data.month.reasoning'),
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
      { type: 'text', text: { $: 'data.updated' }, tone: 'muted', style: { size: NOTE_SIZE } },
    ],
  }
}

/** The data model the panel and the strip bind to. Language-neutral numbers and names. */
export function usageData(ledger, scope, locale) {
  const w = words() // 数字与模型名，不带语言
  const today = ledger.today()
  const month = ledger.window(30)
  const week = ledger.window(7)
  const sessionId = typeof scope?.sessionId === 'string' && scope.sessionId !== '' ? scope.sessionId : null
  const session = sessionId === null ? undefined : ledger.session(sessionId)
  const dates = lastDays(today, 7)
  const meta = ledger.meta()
  const cacheKnown = ledger.cacheKnown()
  const bd = (totals) => {
    const value = breakdown(totals)
    // A relay that omits cache counters must not read as a 0% cache hit rate.
    if (!cacheKnown) value.hit = '—'
    return value
  }
  const models = ledger.todayModels(6).map(([provider, model, tokens]) => ({
    title: model,
    subtitle: sourceLabel(provider, locale),
    trailing: compact(tokens),
  }))
  const weekCovered = ledger.coveredDays(7)
  const monthCovered = ledger.coveredDays(30)
  const average = (totals, covered) => (totals.calls === 0 ? '—' : compact(Math.round(totalTokens(totals) / Math.max(1, covered))))
  return {
    all: bd(ledger.allTime()),
    session: bd(session),
    today: bd(ledger.window(1)),
    week: { ...bd(week), daily: average(week, weekCovered), days: String(weekCovered) },
    month: { ...bd(month), daily: average(month, monthCovered), days: String(monthCovered) },
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
    // 中转不报缓存计数时不写「命中—」，只留这一轮的 tokens。
    out[String(turn)] = { text: ledger.cacheKnown() ? w.turn(tokens, percent(cacheHitRate(totals))) : tokens, tone: 'muted' }
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
