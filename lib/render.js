// 主机侧出图：把面板上的数字画成一张 PNG，写进包的 assets/ 目录，
// 通过桥接的 /dsh-go/v1/assets/<包名>/<文件> 给 App 显示（点开是图片页）。
//
// 画图用 Python + Pillow（系统自带或 pip 装上即可）。没有它时按钮给一句
// 人话提示，其余功能不受影响。
import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { basename, dirname, join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { cacheHitRate, compact, percent, totalTokens } from './tally.js'
import { sourceLabel, words } from './view.js'
import { resolveExecutable } from './exec.js'

const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(PKG_DIR, 'scripts', 'render.py')
const ASSETS_DIR = join(PKG_DIR, 'assets')
const KEEP_IMAGES = 3
const execFileAsync = promisify(execFile)

const COLORS = { all: '#3D6FD6', session: '#258051', today: '#CA6328', week: '#167F84', month: '#8554BB' }

/** Keep drawn labels inside the card's column widths. */
const clip = (text, limit) => {
  const chars = [...String(text)]
  return chars.length <= limit ? String(text) : `${chars.slice(0, limit - 1).join('')}…`
}

let pythonState
/** Resolved interpreter ("python3" or "python"); cached once one works. */
let pythonBin

/** Whether this host can draw the card (python3 + Pillow). Cached after the first probe. */
export function canRender() {
  if (pythonState === true) return true
  // A failed probe is not cached: installing Pillow should work without an engine
  // restart (python3 on Linux/macOS, python on Windows).
  const candidates = []
  const override = String(process.env.DSH_TOKEN_USAGE_PYTHON ?? '').trim()
  if (override !== '') candidates.push(override)
  for (const fixed of ['/usr/bin/python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3', '/system/bin/python3']) {
    candidates.push(fixed)
  }
  // PATH lookup refuses world-writable directories (adb shell PATH can contain them).
  for (const name of ['python3', 'python']) {
    const resolved = resolveExecutable(name)
    if (resolved !== undefined) candidates.push(resolved)
  }
  for (const bin of [...new Set(candidates)]) {
    try {
      execFileSync(bin, ['-c', 'import PIL'], { stdio: 'ignore', timeout: 3000 })
      pythonBin = bin
      pythonState = true
      return true
    } catch {
      // try the next name
    }
  }
  pythonState = false
  return false
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
  const sessionKnown = session !== undefined
  const today = ledger.window(1)
  const week = ledger.window(7)
  const month = ledger.window(30)
  const all = ledger.allTime()
  const weekCovered = ledger.coveredDays(7)
  const monthCovered = ledger.coveredDays(30)
  const average = (totals, covered) => (totals.calls === 0 ? '—' : compact(Math.round(totalTokens(totals) / Math.max(1, covered))))
  const hit = (totals, known) => (totals !== undefined && known ? percent(cacheHitRate(totals)) : '—')
  const row = (label, totals, color, extra, known) => ({
    label,
    value: totals === undefined ? '—' : compact(totalTokens(totals)),
    unit: w.tokens,
    meta: `${w.hit} ${hit(totals, known)}`,
    extra,
    color,
  })
  const sessionCacheKnown = sessionId !== null && ledger.sessionCacheKnown(sessionId)
  const todayKnown = ledger.windowCacheKnown(1)
  const weekKnown = ledger.windowCacheKnown(7)
  const monthKnown = ledger.windowCacheKnown(30)
  const rows = [row(w.all, all, COLORS.all, `${w.inputTotal} ${compact(all.input + all.cached + all.cacheWrite)} · ${w.output} ${compact(all.output)}`, ledger.allCacheKnown())]
  if (sessionId !== null) {
    const extra = sessionKnown ? `${w.inputTotal} ${compact(session.input + session.cached + session.cacheWrite)} · ${w.output} ${compact(session.output)}` : ''
    rows.push(row(w.session, session, COLORS.session, extra, sessionCacheKnown))
  }
  rows.push(
    row(w.today, today, COLORS.today, `${w.inputTotal} ${compact(today.input + today.cached + today.cacheWrite)} · ${w.output} ${compact(today.output)}`, todayKnown),
    row(w.week, week, COLORS.week, `${w.daily} ${average(week, weekCovered)} · ${w.days} ${weekCovered}`, weekKnown),
    row(w.month, month, COLORS.month, `${w.daily} ${average(month, monthCovered)} · ${w.days} ${monthCovered}`, monthKnown),
  )
  const models = ledger.todayModels(6).map(([provider, model, tokens]) => ({
    name: clip(model, 28),
    source: clip(sourceLabel(provider, locale), 18),
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

/** Refuse to write card images through a symlinked assets directory. */
function assertAssetsInsidePackage() {
  const pkg = realpathSync(PKG_DIR)
  let assets
  try {
    assets = realpathSync(ASSETS_DIR)
  } catch {
    return // not created yet: the plain mkdir below creates a real directory
  }
  if (assets !== pkg && !assets.startsWith(pkg + sep)) throw new Error('assets-dir-outside-package')
}

function prune(current, protectedNames = [], keep = KEEP_IMAGES) {
  try {
    // Old releases named files without the random suffix; keep both matchable so
    // stale images from a previous version are still cleaned up.
    const entries = readdirSync(ASSETS_DIR)
      .filter((name) => /^usage-\d{8}-\d{6}(-[a-z0-9]+)?\.png$/.test(name))
      .map((name) => ({ name, mtime: statSync(join(ASSETS_DIR, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    const keepNames = new Set(entries.slice(0, keep).map((entry) => entry.name))
    if (current !== undefined) keepNames.add(current)
    // Panels of other chats may still be showing their own card.
    for (const name of protectedNames) keepNames.add(name)
    for (const entry of entries) if (!keepNames.has(entry.name)) rmSync(join(ASSETS_DIR, entry.name), { force: true })
  } catch {
    // 没有目录或删不掉都不影响这次出图
  }
}

/**
 * Render one card and return what the panel needs: the bridge URL, its aspect
 * ratio and a one-line caption. Throws when the host cannot draw.
 * @param {{ ledger: any, scope?: any, locale?: string, now?: number, outDir?: string }} options
 */
export async function renderUsageImage({ ledger, scope, locale, now = Date.now(), outDir = ASSETS_DIR, protectedFiles = [] }) {
  if (!canRender()) throw new Error('missing-python')
  const data = cardData({ ledger, scope, locale, now })
  if (outDir === ASSETS_DIR) assertAssetsInsidePackage()
  mkdirSync(outDir, { recursive: true })
  const suffix = Math.random().toString(36).slice(2, 8)
  const base = `usage-${stamp(now)}-${suffix}`
  const file = join(outDir, `${base}.png`)
  const input = join(tmpdir(), `dsh-usage-${process.pid}-${now}-${suffix}.json`)
  writeFileSync(input, JSON.stringify(data), 'utf8')
  let size = { width: 1080, height: 1500 }
  try {
    const { stdout } = await execFileAsync(pythonBin ?? 'python3', [SCRIPT, input, file], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1 << 20 })
    try { chmodSync(file, 0o600) } catch { /* best effort on filesystems without modes */ }
    if (stdout) size = JSON.parse(stdout)
  } catch (error) {
    rmSync(file, { force: true }) // never leave a half-written card behind
    throw error
  } finally {
    rmSync(input, { force: true })
  }
  if (outDir === ASSETS_DIR) {
    const protectedNames = []
    for (const file of protectedFiles) {
      const name = basename(String(file))
      if (name !== '' && name !== `${base}.png`) protectedNames.push(name)
    }
    prune(base, protectedNames)
  }
  const today = ledger.window(1)
  const hit = ledger.windowCacheKnown(1) ? percent(cacheHitRate(today)) : '—'
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
