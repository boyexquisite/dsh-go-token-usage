// 主机侧出图：把面板上的数字画成一张 PNG，写进包的 assets/ 目录，
// 通过桥接的 /dsh-go/v1/assets/<包名>/<文件> 给 App 显示（点开是图片页）。
//
// 画图用 Python + Pillow（系统自带或 pip 装上即可）。没有它时按钮给一句
// 人话提示，其余功能不受影响。
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { cacheHitRate, compact, percent, totalTokens } from './tally.js'
import { sourceLabel, words } from './view.js'

const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(PKG_DIR, 'scripts', 'render.py')
const ASSETS_DIR = join(PKG_DIR, 'assets')
const KEEP_IMAGES = 3

const COLORS = { all: '#3D6FD6', session: '#258051', today: '#CA6328', week: '#167F84', month: '#8554BB' }

let pythonState

/** Whether this host can draw the card (python3 + Pillow). Cached after the first probe. */
export function canRender() {
  if (pythonState !== undefined) return pythonState
  try {
    execFileSync('python3', ['-c', 'import PIL'], { stdio: 'ignore', timeout: 5000 })
    pythonState = true
  } catch {
    pythonState = false
  }
  return pythonState
}

const clock = (ms) => {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const stamp = (ms) => {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** The JSON the Python renderer draws. */
export function cardData({ ledger, scope, locale, now = Date.now() }) {
  const w = words(locale)
  const sessionId = typeof scope?.sessionId === 'string' && scope.sessionId !== '' ? scope.sessionId : null
  const session = sessionId === null ? undefined : ledger.session(sessionId)
  const today = ledger.window(1)
  const week = ledger.window(7)
  const month = ledger.window(30)
  const all = ledger.allTime()
  const weekCovered = ledger.coveredDays(7)
  const monthCovered = ledger.coveredDays(30)
  const average = (totals, covered) => (totals.calls === 0 ? '—' : compact(Math.round(totalTokens(totals) / Math.max(1, covered))))
  const hit = (totals) => (ledger.cacheKnown() ? percent(cacheHitRate(totals)) : '—')
  const row = (label, totals, color, extra) => ({
    label,
    value: compact(totalTokens(totals)),
    unit: w.tokens,
    meta: `${w.hit} ${hit(totals)}`,
    extra,
    color,
  })
  const rows = [row(w.all, all, COLORS.all, `${w.inputTotal} ${compact(all.input + all.cached + all.cacheWrite)} · ${w.output} ${compact(all.output)}`)]
  if (session !== undefined) {
    rows.push(row(w.session, session, COLORS.session, `${w.inputTotal} ${compact(session.input + session.cached + session.cacheWrite)} · ${w.output} ${compact(session.output)}`))
  }
  rows.push(
    row(w.today, today, COLORS.today, `${w.inputTotal} ${compact(today.input + today.cached + today.cacheWrite)} · ${w.output} ${compact(today.output)}`),
    row(w.week, week, COLORS.week, `${w.daily} ${average(week, weekCovered)} · ${w.days} ${weekCovered}`),
    row(w.month, month, COLORS.month, `${w.daily} ${average(month, monthCovered)} · ${w.days} ${monthCovered}`),
  )
  const models = ledger.todayModels(4).map(([provider, model, tokens]) => ({
    name: model,
    source: sourceLabel(provider, locale),
    value: compact(tokens),
  }))
  return {
    title: w.title,
    subtitle: clock(now),
    rows,
    modelsTitle: w.models,
    models,
    modelCol: w.modelCol,
    sourceCol: w.sourceCol,
    tokensCol: w.tokensCol,
    footer: w.imageFooter,
  }
}

function prune(keep = KEEP_IMAGES) {
  try {
    const files = readdirSync(ASSETS_DIR)
      .filter((name) => /^usage-\d{8}-\d{6}\.png$/.test(name))
      .sort()
      .reverse()
    for (const name of files.slice(keep)) rmSync(join(ASSETS_DIR, name), { force: true })
  } catch {
    // 没有目录或删不掉都不影响这次出图
  }
}

/**
 * Render one card and return what the panel needs: the bridge URL, its aspect
 * ratio and a one-line caption. Throws when the host cannot draw.
 * @param {{ ledger: any, scope?: any, locale?: string, now?: number, outDir?: string }} options
 */
export function renderUsageImage({ ledger, scope, locale, now = Date.now(), outDir = ASSETS_DIR }) {
  if (!canRender()) throw new Error('missing-python')
  const data = cardData({ ledger, scope, locale, now })
  mkdirSync(outDir, { recursive: true })
  const file = join(outDir, `usage-${stamp(now)}.png`)
  const input = join(tmpdir(), `dsh-usage-${process.pid}-${now}.json`)
  writeFileSync(input, JSON.stringify(data), 'utf8')
  let size = { width: 1080, height: 1500 }
  try {
    const output = execFileSync('python3', [SCRIPT, input, file], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] })
    if (output) size = JSON.parse(output)
  } finally {
    rmSync(input, { force: true })
  }
  if (outDir === ASSETS_DIR) prune()
  const today = ledger.window(1)
  const hit = ledger.cacheKnown() ? percent(cacheHitRate(today)) : '—'
  const w = words(locale)
  // App 只认两种 image src：data:image 内联，或 asset:<包内 assets 下的路径>；
  // 后者由 App 自己拼成 /dsh-go/v1/assets/<包名>/<路径> 并带凭据去取。
  return {
    src: `asset:${basename(file)}`,
    aspect: Math.round((size.width / size.height) * 1000) / 1000,
    caption: `${w.today} ${compact(totalTokens(today))} tokens · ${w.hit} ${hit}`,
    file,
  }
}
