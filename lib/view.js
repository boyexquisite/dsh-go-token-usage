// 面板视图、数据模型、状态条文案。
//
// 面板用视图 v2 的分组卡片：每一段一个彩色卡片（不同主题色），顺序固定为
// 累计 → 本对话 → 今日 → 近 7 天 → 近 30 天，最后才是模型/明细，方便一眼分区。
// 视图只画结构和绑定，数字全走 data.*，桥接推的是小补丁。
import { cacheHitRate, compact, lastDays, percent, totalTokens } from './tally.js'

const WORDS = {
  zh: {
    title: 'Token 用量',
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
    callOne: '次',
    daily: '日均',
    days: '覆盖天数（天）',
    models: '今日模型',
    modelCol: '模型',
    sourceCol: '来源',
    tokensCol: 'tokens',
    srcAccount: '官方 · 账号',
    srcApiKey: '官方 · API Key',
    srcSubscription: '订阅 · ',
    srcRelay: '中转 · ',
    srcThird: '第三方 · ',
    srcUnknown: '未知来源',
    input: '未缓存输入',
    cached: '缓存读取',
    cacheWrite: '缓存写入',
    inputTotal: '输入合计',
    output: '输出',
    reasoning: '其中推理',
    chart: '每天 tokens（含缓存）',
    copy: '复制统计',
    verify: '核对',
    unverified: '未核对',
    verifyOk: '核对：一致 ·',
    verifyPending: '核对：差',
    verifyDiff: '核对：差',
    verifyFail: '核对失败：',
    exportImage: '生成图片',
    exportDone: '已生成用量图',
    exportNoPython: '这台主机缺 python3 或 Pillow，出不了图',
    exportFail: '出图失败：',
    imageHint: 'App 图片暂不支持长按保存，截图即可',
    imagePlaceholder: '点「生成图片」生成用量卡',
    imageFooter: '数据来自本机会话记录 · dsh-go-token-usage',
    copied: '已复制',
    refresh: '刷新',
    refreshed: '已刷新',
    updatedAll: (t) => `已更新 ${t}`,
    strip: (session, today) => (session === null ? `今日 ${today}` : `本对话 ${session} · 今日 ${today}`),
    turn: (tokens, hit) => `${tokens} · 命中${hit}`,
    verifyNoRoot: '核对：跳过（找不到会话日志目录）',
    historyErrors: (n) => `${n} 个日志读不了，统计可能偏少`,
    historyEmpty: (n) => `${n} 个日志为空，统计可能偏少`,
    historyOversized: (n) => `${n} 个日志过大，已跳过`,
    cacheDamaged: '缓存损坏，已重新扫描',
    cacheDenied: '缓存读写用户不一致，历史可能不全',
    exportFailGeneric: '出图失败，请重试',
    verifyFailGeneric: '核对失败，请重试',
    historyNoRoot: '找不到会话日志目录，历史不可用',
    historyNoLogs: '本机没有会话日志，只含实时调用',
    historyLost: (n) => `${n} 个日志已不存在，历史按缓存保留`,
    verifyLost: (n) => `${n} 个日志已丢失`,
    historyUnavailableDirs: (n) => `${n} 个目录读不了，新日志可能没计入`,
    historyCacheDropped: (n) => `${n} 条缓存记录损坏，历史可能不全`,
    verifySkippedDirs: (n) => `${n} 处读不了`,
  },
  en: {
    title: 'Token usage',
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
    callOne: 'call',
    daily: 'Daily avg',
    days: 'Days covered',
    models: 'Models today',
    modelCol: 'Model',
    sourceCol: 'Source',
    tokensCol: 'tokens',
    srcAccount: 'official · account',
    srcApiKey: 'official · API key',
    srcSubscription: 'subscription · ',
    srcRelay: 'relay · ',
    srcThird: 'third-party · ',
    srcUnknown: 'unknown source',
    input: 'Uncached input',
    cached: 'Cache reads',
    cacheWrite: 'Cache writes',
    inputTotal: 'Input total',
    output: 'Output',
    reasoning: 'Reasoning',
    chart: 'Tokens per day (cache included)',
    copy: 'Copy summary',
    verify: 'Verify',
    unverified: 'Not verified',
    verifyOk: 'Verified ·',
    verifyPending: 'Diff',
    verifyDiff: 'Diff',
    verifyFail: 'Verify failed: ',
    exportImage: 'Generate image',
    exportDone: 'Usage image ready',
    exportNoPython: 'Host cannot draw: needs python3 + Pillow',
    exportFail: 'Export failed: ',
    imageHint: 'No long-press save yet — screenshot it',
    imagePlaceholder: 'Tap Generate image to draw the card',
    imageFooter: 'Counted from session logs · dsh-go-token-usage',
    copied: 'Copied',
    refresh: 'Refresh',
    refreshed: 'Refreshed',
    updatedAll: (t) => `Updated ${t}`,
    strip: (session, today) => (session === null ? `Today ${today}` : `Chat ${session} · today ${today}`),
    turn: (tokens, hit) => `${tokens} · ${hit}`,
    verifyNoRoot: 'Verify skipped: no session log folder',
    historyErrors: (n) => `${n} log(s) unreadable — totals may be low`,
    historyEmpty: (n) => `${n} log(s) empty — totals may be low`,
    historyOversized: (n) => `${n} log(s) too large — skipped`,
    cacheDamaged: 'Cache was damaged — rescanned',
    cacheDenied: 'Cache owner mismatch — history may be incomplete',
    exportFailGeneric: 'Could not draw the card, please retry',
    verifyFailGeneric: 'Verify failed, please retry',
    historyNoRoot: 'No session log folder — history unavailable',
    historyNoLogs: 'No session logs here — live calls only',
    historyLost: (n) => `${n} log(s) gone — history kept from cache`,
    verifyLost: (n) => `${n} log(s) gone`,
    historyUnavailableDirs: (n) => `${n} dir(s) unreadable — new logs may be missing`,
    historyCacheDropped: (n) => `${n} cache record(s) corrupt — history may be incomplete`,
    verifySkippedDirs: (n) => `${n} dir(s) unreadable`,
  },
}

/**
 * Hit rate for a scope: exact when every call reported cache counters, "≈" when
 * only some did (a single relay call without cache fields used to blank the whole
 * number), "—" only when nothing in the scope reported them.
 */
export function hitRateText(totals, coverage) {
  if (totals === undefined) return '—'
  const calls = coverage?.calls ?? 0
  const withCounters = coverage?.withCounters ?? 0
  if (calls === 0 || withCounters === 0) return '—'
  const value = percent(cacheHitRate(totals))
  if (value === '—') return '—'
  return withCounters >= calls ? value : `≈${value}`
}

/** zh unless the app's locale says otherwise. */
export function words(locale) {
  return typeof locale === 'string' && locale.toLowerCase().startsWith('en') ? WORDS.en : WORDS.zh
}

/** Control characters (incl. line breaks) that must never reach a label the app or Pillow draws. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g
/** Keep abnormal model/provider names out of the panel data budget and the PNG layout. */
const MODEL_LABEL_MAX = 48
const SOURCE_LABEL_MAX = 32

/**
 * One-line, whitespace-collapsed, length-clipped label. Model/provider names come
 * straight from session logs: a newline would make Pillow's textlength throw and
 * break image export, and a 5 KiB name would blow the panel's 32 KiB data budget.
 */
export function sanitizeLabel(value, max) {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
  const cleaned = text.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim()
  if (!Number.isFinite(max) || max <= 0) return cleaned
  const chars = [...cleaned]
  return chars.length <= max ? cleaned : `${chars.slice(0, max - 1).join('').trimEnd()}…`
}

/** The same chars-not-code-units clip used for protocol text limits. */
const fitText = (text, limit) => {
  const chars = [...String(text)]
  return chars.length <= limit ? String(text) : `${chars.slice(0, limit - 1).join('')}…`
}

const BIG_UNITS = [[1e18, 'E'], [1e15, 'P'], [1e12, 'T']]

/**
 * Display wrapper around compact(): the panel, strips, notes, copy summary and PNG
 * must stay ≤5 characters per number even for absurd totals. `compact()` renders
 * ≥1e15 as "1000T"/"1000000T", which overflowed the strip's 24 and the turn
 * note's 16 char budget (the bridge then cut the number in half).
 */
export function displayCompact(n) {
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1e12) return compact(n)
  if (n >= 1e21) return '999E'
  let index = BIG_UNITS.findIndex(([base]) => n >= base)
  if (index < 0) return compact(n)
  const scale = (i) => {
    const v = n / BIG_UNITS[i][0]
    const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2
    return Number(v.toFixed(digits))
  }
  let value = scale(index)
  if (value >= 1000 && index > 0) {
    index -= 1
    value = scale(index)
  }
  if (value >= 1000) return '999E'
  return `${value}${BIG_UNITS[index][1]}`
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
  if (lower.startsWith('custom-')) {
    const name = lower.slice('custom-'.length)
    // A bare "custom-" would otherwise render a dangling "relay · " label.
    return name === '' ? w.srcUnknown : w.srcRelay + name
  }
  if (lower.includes('official')) return w.srcAccount
  return w.srcThird + p
}

// 每一段的主题色，顺序与卡片顺序一致。
const COLORS = { all: 'blue', session: 'green', today: 'orange', week: 'teal', month: 'violet' }

// 每张卡片同一套骨架：标题+总量一行，下面是左右对齐的 keyValue 行，
// 这样五段的「命中率 / 调用 / 输入合计 / 输出」上下对齐，看起来齐整。
// 标题行用 body 而不是 subtitle：subtitle（20px）下「本对话 29.3M tokens」在窄屏恰好折行，
// 每段标题会一行变两行（累计/今日不折、本对话折），看着不齐；body（16px）一行放得下。
const TITLE_SIZE = 'body'
const NOTE_SIZE = 'caption'
const GRAY = 'gray'

const breakdown = (t) => {
  if (t === undefined) {
    return { total: '—', input: '—', cached: '—', cacheWrite: '—', inputTotal: '—', output: '—', reasoning: '—', calls: '—', hit: '—' }
  }
  const inputTotal = t.input + t.cached + t.cacheWrite
  return {
    total: displayCompact(totalTokens(t)),
    input: displayCompact(t.input),
    cached: displayCompact(t.cached),
    cacheWrite: displayCompact(t.cacheWrite),
    inputTotal: displayCompact(inputTotal),
    output: displayCompact(t.output),
    reasoning: t.reasoning > 0 ? displayCompact(t.reasoning) : '—',
    calls: displayCompact(t.calls),
    hit: percent(cacheHitRate(t)),
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
      {
        type: 'table',
        columns: [w.modelCol, w.sourceCol, { label: w.tokensCol, align: 'end' }],
        rows: { $: 'data.modelRows' },
      },
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
      { type: 'image', src: { $: 'data.imageSrc' }, alt: w.title, aspect: { $: 'data.imageAspect' } },
      { type: 'text', text: { $: 'data.imageCaption' }, tone: 'muted', style: { size: NOTE_SIZE } },
      { type: 'text', text: w.imageHint, tone: 'muted', style: { size: NOTE_SIZE } },
      {
        type: 'actions',
        items: [
          { label: w.copy, action: 'copy', icon: 'summary' },
          { label: w.exportImage, action: 'export', icon: 'image' },
          { label: w.verify, action: 'verify', icon: 'check' },
          { label: w.refresh, action: 'refresh', icon: 'refresh' },
        ],
      },
      { type: 'text', text: { $: 'data.lastVerify' }, tone: 'muted', style: { size: NOTE_SIZE } },
      { type: 'text', text: { $: 'data.updated' }, tone: 'muted', style: { size: NOTE_SIZE } },
    ],
  }
}

/** 面板底部的图片：占位图直到导出过一次；导出后用 bridge 的 asset 引用。 */
const PLACEHOLDER_SRC = 'asset:placeholder.png'
const PLACEHOLDER_ASPECT = 810 / 240

export function imagePanelData(image, locale) {
  const w = words(locale)
  if (image === null || image === undefined) {
    return { imageSrc: PLACEHOLDER_SRC, imageAspect: PLACEHOLDER_ASPECT, imageCaption: w.imagePlaceholder }
  }
  // Rebuild the caption in the *current* locale: the image itself was drawn once,
  // but the line under it should follow an app language switch.
  const caption = typeof image.tokens === 'string' && typeof image.hit === 'string'
    ? `${w.today} ${image.tokens} tokens · ${w.hit} ${image.hit}`
    : image.caption
  return { imageSrc: image.src, imageAspect: image.aspect, imageCaption: caption }
}

/**
 * One honest caption about where the history came from, '' when every log the
 * ledger counted is still on disk. The panel folds this into its "updated" line
 * so a wiped session log never reads as "you never used any tokens".
 */
export function historyNote(ledger, locale) {
  const w = words(locale)
  const state = ledger.sourceState()
  if (!state.scanned) return ''
  if (state.rootMissing) return w.historyNoRoot
  if (state.lostFiles > 0) return w.historyLost(state.lostFiles)
  if (state.unavailableDirs > 0) return w.historyUnavailableDirs(state.unavailableDirs)
  if (state.cacheDropped > 0) return w.historyCacheDropped(state.cacheDropped)
  if (state.scanErrors > 0) return w.historyErrors(state.scanErrors)
  if (state.cacheDenied) return w.cacheDenied
  if (state.cacheDamaged) return w.cacheDamaged
  if (state.oversizedLogs > 0) return w.historyOversized(state.oversizedLogs)
  if (state.emptyLogs > 0) return w.historyEmpty(state.emptyLogs)
  if (state.logFiles === 0) return w.historyNoLogs
  return ''
}

/**
 * The one-line self-check the Verify button shows: the whole ledger against a
 * fresh recount of the logs on disk, compared per session. Cached history whose
 * log is gone is named as lost instead of a fake diff; a real mismatch inside
 * readable logs still shows as a diff. The line is kept inside the app's 40-char
 * toast budget (the panel shows the same text).
 */
export function verifyLine(ledger, recount, locale) {
  const w = words(locale)
  const state = ledger.sourceState()
  if (state.rootMissing) return w.verifyNoRoot
  const comparison = ledger.compareRecount(recount)
  const shown = comparison.shownTotals
  const core = comparison.unexplainedTokens === 0 && comparison.unexplainedCalls === 0
    ? `${w.verifyOk} ${displayCompact(totalTokens(shown))}`
    : comparison.unexplainedTokens === 0
      ? `${w.verifyDiff} ${displayCompact(comparison.unexplainedCalls)} ${w.times}`
      : `${w.verifyDiff} ${displayCompact(comparison.unexplainedTokens)} tokens`
  const calls = comparison.unexplainedTokens === 0 && comparison.unexplainedCalls === 0
    ? `${displayCompact(shown.calls)} ${shown.calls === 1 ? w.callOne : w.times}`
    : ''
  const lost = comparison.lostFiles > 0 ? w.verifyLost(comparison.lostFiles) : ''
  const skipped = comparison.skippedDirs > 0 ? w.verifySkippedDirs(comparison.skippedDirs) : ''
  const fit = (parts) => {
    const line = parts.filter((part) => part !== '').join(' · ')
    return [...line].length <= 40 ? line : undefined
  }
  // Prefer naming the lost/skipped sources over the call count when the toast budget is tight.
  return fit([core, calls, lost, skipped])
    ?? fit([core, lost, skipped])
    ?? fit([core, skipped])
    ?? fit([core, lost])
    ?? fit([core])
    ?? core
}

/** The data model the panel and the strip bind to. Language-neutral numbers and names. */
export function usageData(ledger, scope, locale) {
  const w = words(locale)
  const today = ledger.today()
  const month = ledger.window(30)
  const week = ledger.window(7)
  const sessionId = typeof scope?.sessionId === 'string' && scope.sessionId !== '' ? scope.sessionId : null
  const session = sessionId === null ? undefined : ledger.session(sessionId)
  const dates = lastDays(today, 7)
  const meta = ledger.meta()
  const bd = (totals, coverage) => {
    const value = breakdown(totals)
    value.hit = hitRateText(totals, coverage)
    return value
  }
  const sessionCoverage = sessionId !== null ? ledger.sessionCacheCoverage(sessionId) : undefined
  const todayCoverage = ledger.windowCacheCoverage(1)
  const weekCoverage = ledger.windowCacheCoverage(7)
  const monthCoverage = ledger.windowCacheCoverage(30)
  // 表格里来源不带「·」，省一列宽度：中转 sta1n / 官方 账号。
  const modelRows = ledger.todayModels(6).map(([provider, model, tokens]) => [
    sanitizeLabel(model, MODEL_LABEL_MAX),
    sanitizeLabel(sourceLabel(provider, locale).replace(' · ', ' '), SOURCE_LABEL_MAX),
    displayCompact(tokens),
  ])
  const weekCovered = ledger.coveredDays(7)
  const monthCovered = ledger.coveredDays(30)
  const average = (totals, covered) => (totals.calls === 0 ? '—' : displayCompact(Math.round(totalTokens(totals) / Math.max(1, covered))))
  const note = historyNote(ledger, locale)
  const clock = formatClock(meta.newest)
  // Never render "updated —": before the first scan (or on a host with no history
  // at all) the line is either omitted or replaced by the honest history note.
  const updated = clock === '' ? note : note === '' ? w.updatedAll(clock) : `${w.updatedAll(clock)} · ${note}`
  return {
    all: bd(ledger.allTime(), ledger.allCacheCoverage()),
    session: bd(session, sessionCoverage),
    today: bd(ledger.window(1), todayCoverage),
    week: { ...bd(week, weekCoverage), daily: average(week, weekCovered), days: String(weekCovered) },
    month: { ...bd(month, monthCoverage), daily: average(month, monthCovered), days: String(monthCovered) },
    chart: {
      labels: dates.map((d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`),
      values: ledger.dailyValues(7),
    },
    modelRows,
    lastVerify: ledger.verifyNote || w.unverified,
    historyNote: note,
    updated,
  }
}

/** The status-strip line (≤ 24 characters). */
export function stripData(ledger, scope, locale) {
  const w = words(locale)
  const today = displayCompact(totalTokens(ledger.window(1)))
  const sessionId = typeof scope?.sessionId === 'string' && scope.sessionId !== '' ? scope.sessionId : null
  const session = sessionId === null ? undefined : ledger.session(sessionId)
  const full = w.strip(session === undefined ? null : displayCompact(totalTokens(session)), today)
  // displayCompact keeps each number ≤5 chars, so this only fires for broken data.
  // Fall back to the today-only form before cutting any number in half.
  const text = [...full].length <= 24 ? full : fitText(w.strip(null, today), 24)
  return { text, icon: 'chart' }
}

/** Per-turn footnotes: turn number -> one short line with that turn's tokens and cache hits. */
export function turnNoteData(ledger, scope, locale) {
  const w = words(locale)
  const turns = ledger.sessionTurnsOf(scope?.sessionId)
  const out = {}
  for (const [turn, totals] of turns) {
    const tokens = displayCompact(totalTokens(totals))
    // 中转完全不报缓存计数时只留这一轮的 tokens，不写「命中—」。
    const coverage = ledger.turnCacheCoverage(scope?.sessionId, turn)
    const full = (coverage?.withCounters ?? 0) === 0 ? tokens : w.turn(tokens, hitRateText(totals, coverage))
    // Protocol: each turn note segment is ≤16 chars. Drop the hit rate first
    // rather than let the bridge cut the token number itself.
    const text = [...full].length <= 16 ? full : fitText(tokens, 16)
    out[String(turn)] = { text, tone: 'muted' }
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
  const hitOf = (totals, coverage) => hitRateText(totals, coverage)
  const lines = []
  if (session !== undefined) lines.push(`${w.session}: ${displayCompact(totalTokens(session))} tokens`)
  lines.push(`${w.today}: ${displayCompact(totalTokens(today))} tokens · ${w.hit} ${hitOf(today, ledger.windowCacheCoverage(1))} · ${today.calls} ${today.calls === 1 ? w.callOne : w.times}`)
  lines.push(`${w.week}: ${displayCompact(totalTokens(week))} tokens`)
  lines.push(`${w.month}: ${displayCompact(totalTokens(month))} tokens · ${w.hit} ${hitOf(month, ledger.windowCacheCoverage(30))}`)
  // todayModels yields [provider, model, tokens]: the copy lists the model, not the provider.
  // Same six models as the panel/image, with the same label sanitising/clipping.
  for (const [, model, tokens] of ledger.todayModels(6)) lines.push(`- ${sanitizeLabel(model, MODEL_LABEL_MAX)}: ${displayCompact(tokens)}`)
  return lines.join('\n')
}

function formatClock(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
