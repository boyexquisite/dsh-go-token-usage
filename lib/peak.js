// 峰价 / 谷价：时段判定、状态条上的短标签、价目表面板。
//
// 规则来自 DeepSeek 官方定价页：峰时只有工作日 UTC 01:00-04:00、06:00-10:00
// （北京时间 09:00-12:00、14:00-18:00），排除中国法定节假日；其余时间一律半价。
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
// 中国标准时间固定 UTC+8，没有夏令时。
const CST_OFFSET = 8 * 60 * MINUTE
// 北京时间下的峰时窗口（分钟数，左闭右开）。
const PEAK_WINDOWS = [[9 * 60, 12 * 60], [14 * 60, 18 * 60]]
const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
// 最远往后找 8 天内的下一次切换；平时足够，春节那种连续 9 天低谷再放宽到 32 天。
const NEXT_SCAN_DAYS = 8

// 2026 年法定节假日（国办发明电〔2025〕7 号）。
// 调休上班的周六日不落在周一至周五，按低谷算。
const HOLIDAYS = (() => {
  const set = new Set()
  const addRange = (month, from, to) => {
    for (let day = from; day <= to; day += 1) {
      set.add(`2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`)
    }
  }
  addRange(1, 1, 3) // 元旦
  addRange(2, 15, 23) // 春节
  addRange(4, 4, 6) // 清明
  addRange(5, 1, 5) // 劳动节
  addRange(6, 19, 21) // 端午
  addRange(9, 25, 27) // 中秋
  addRange(10, 1, 7) // 国庆
  return set
})()

const EN = (locale) => typeof locale === 'string' && locale.startsWith('en')

function localParts (ms) {
  const date = new Date(ms + CST_OFFSET)
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return {
    key: `${date.getUTCFullYear()}-${month}-${day}`,
    weekday: date.getUTCDay(),
    minute: date.getUTCHours() * 60 + date.getUTCMinutes(),
  }
}

/** 这一毫秒是不是峰价（工作日 + 非节假日 + 落在峰时窗口）。 */
export function isPeakAt (ms) {
  const part = localParts(ms)
  if (part.weekday === 0 || part.weekday === 6) return false
  if (HOLIDAYS.has(part.key)) return false
  return PEAK_WINDOWS.some(([from, to]) => part.minute >= from && part.minute < to)
}

// 下一次峰/谷切换的时刻；按分钟扫描，状态只可能整分钟切换。
function nextSwitchAt (ms) {
  const current = isPeakAt(ms)
  let probe = Math.floor(ms / MINUTE) * MINUTE + MINUTE
  for (const days of [NEXT_SCAN_DAYS, 32]) {
    const limit = probe + days * DAY
    for (; probe < limit; probe += MINUTE) {
      if (isPeakAt(probe) !== current) return probe
    }
  }
  return null
}

function clockLabel (minute) {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
}

function durationLabel (ms) {
  const total = Math.max(0, Math.floor(ms / MINUTE))
  const hours = Math.floor(total / 60)
  if (hours === 0) return `${total}m`
  return `${hours}h${String(total % 60).padStart(2, '0')}m`
}

function monthDayLabel (ms) {
  const date = new Date(ms + CST_OFFSET)
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`
}

/**
 * 状态条尾部标签：' · 谷价' / ' · 峰价'。
 * 分隔符两侧都留空格，跟正文里的「 · 」保持同一个节奏，别让某个间隔看起来少一格。
 */
export function stripSuffix (ms = Date.now(), locale) {
  const peak = isPeakAt(ms)
  if (EN(locale)) return peak ? ' · peak' : ' · off-peak'
  return peak ? ' · 峰价' : ' · 谷价'
}

/**
 * 状态条图标：谷价用金币、峰价用警示。
 * App 目前不给状态条文字上色，图标形状是唯一能被一眼看出的区分。
 */
export function stripIcon (ms = Date.now()) {
  return isPeakAt(ms) ? 'warning' : 'coin'
}

/** 「峰谷价」面板的数据（文字已按 locale 拼好，视图只做绑定）。 */
export function peakPanelData (ms = Date.now(), locale) {
  const en = EN(locale)
  const peak = isPeakAt(ms)
  const next = nextSwitchAt(ms)
  const part = localParts(ms)
  const holiday = HOLIDAYS.has(part.key)
  const weekend = part.weekday === 0 || part.weekday === 6
  const weekdays = en ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] : WEEKDAY_NAMES
  const dayWord = en ? (holiday ? 'holiday' : weekend ? 'weekend' : 'weekday') : (holiday ? '节假日低谷' : weekend ? '周末低谷' : '工作日')

  let nextText = '—'
  if (next !== null) {
    const nextPart = localParts(next)
    const gap = next - ms
    const when = gap < 3 * DAY
      ? `${weekdays[nextPart.weekday]} ${clockLabel(nextPart.minute)}`
      : `${monthDayLabel(next)} ${clockLabel(nextPart.minute)}`
    const target = en ? (peak ? 'off-peak' : 'peak') : (peak ? '转谷价' : '转峰价')
    nextText = gap < DAY
      ? (en ? `${target} in ${durationLabel(gap)} (${clockLabel(nextPart.minute)})` : `距${target} ${durationLabel(gap)}（${clockLabel(nextPart.minute)}）`)
      : (en ? `Next ${target}: ${when}` : `下次${target}：${when}`)
  }

  return {
    rate: peak ? (en ? 'Peak · full price' : '峰价 · 标准价') : (en ? 'Off-peak · half price' : '谷价 · 半价'),
    tone: peak ? 'warn' : 'good',
    day: `${weekdays[part.weekday]} · ${dayWord}`,
    next: nextText,
    clock: `${en ? 'Now' : '现在'} ${clockLabel(part.minute)}`,
  }
}

// 美元 / 百万 token（官方 2026-11 定价页）。
const PRICE_ROWS = {
  zh: [
    ['flash 输入 · 命中缓存', '$0.003', '$0.006'],
    ['flash 输入 · 未命中', '$0.15', '$0.30'],
    ['flash 输出', '$0.60', '$1.20'],
    ['pro 输入 · 命中缓存', '$0.022', '$0.044'],
    ['pro 输入 · 未命中', '$0.66', '$1.32'],
    ['pro 输出', '$1.98', '$3.96'],
  ],
  en: [
    ['flash input · cache hit', '$0.003', '$0.006'],
    ['flash input · cache miss', '$0.15', '$0.30'],
    ['flash output', '$0.60', '$1.20'],
    ['pro input · cache hit', '$0.022', '$0.044'],
    ['pro input · cache miss', '$0.66', '$1.32'],
    ['pro output', '$1.98', '$3.96'],
  ],
}

/** 「峰谷价」面板的视图（v1 组件，数字以外的文字按 locale 出）。 */
export function peakPanelView (caps) {
  const en = EN(caps?.locale)
  const zh = !en
  return {
    type: 'stack',
    children: [
      { type: 'metric', label: zh ? '当前计费' : 'Pricing now', value: { $: 'data.rate' }, tone: { $: 'data.tone' }, caption: { $: 'data.day' } },
      { type: 'text', text: { $: 'data.next' }, tone: 'muted' },
      { type: 'table', columns: zh ? ['项目', '谷价', '峰价'] : ['Item', 'Off-peak', 'Peak'], rows: zh ? PRICE_ROWS.zh : PRICE_ROWS.en },
      {
        type: 'callout',
        tone: 'info',
        text: zh
          ? '峰时：工作日 09:00–12:00、14:00–18:00（北京时间）。其余时段含整个周末和法定节假日，全都半价。'
          : 'Peak: weekdays 09:00–12:00 and 14:00–18:00 (UTC+8). Everything else, including weekends and public holidays, is half price.',
      },
      {
        type: 'callout',
        tone: 'info',
        text: zh
          ? '价格单位是美元 / 百万 token。节假日按国办 2026 年安排；调休上班的周末仍按低谷算。'
          : 'Prices in USD per million tokens. Holidays follow China’s 2026 schedule; make-up working weekends still count as off-peak.',
      },
    ],
  }
}
