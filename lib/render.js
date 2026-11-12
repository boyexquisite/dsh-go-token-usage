// 主机侧出图：把面板上的数字画成一张 PNG，写进包的 assets/ 目录，
// 通过桥接的 /dsh-go/v1/assets/<包名>/<文件> 给 App 显示（点开是图片页）。
//
// 画图用 Python + Pillow（系统自带或 pip 装上即可）。没有它时按钮给一句
// 人话提示，其余功能不受影响。
import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { totalTokens } from './tally.js'
import { displayCompact, hitRateText, sanitizeLabel, sourceLabel, words } from './view.js'
import { resolveExecutable } from './exec.js'

const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(PKG_DIR, 'scripts', 'render.py')
const ASSETS_DIR = join(PKG_DIR, 'assets')
const KEEP_IMAGES = 3
const execFileAsync = promisify(execFile)

const COLORS = { all: '#3D6FD6', session: '#258051', today: '#CA6328', week: '#167F84', month: '#8554BB' }

// PNG 的模型/来源两列比面板窄；先清洗换行/控制字符，再裁到这两列放得下的长度。
const IMAGE_MODEL_MAX = 28
const IMAGE_SOURCE_MAX = 18
/** A crashed render may leave its 0700 temp dir behind; clean it up on the next draw. */
const STALE_TEMP_MS = 60 * 60 * 1000
/** Node's recursive mkdir may spin forever on these; never hand it a path under them. */
const PSEUDO_FS_ROOTS = process.platform === 'win32' ? [] : ['/proc', '/sys', '/dev']

const isPseudoFsPath = (target) => {
  let resolved
  try {
    resolved = resolve(target)
  } catch {
    return true
  }
  return PSEUDO_FS_ROOTS.some((root) => resolved === root || resolved.startsWith(root + sep))
}

/**
 * Create `dir` without ever calling `mkdirSync({ recursive: true })`. On some
 * pseudo filesystems Node's recursive mkdir spins forever in a synchronous loop
 * (audit V-02: /proc path under TMPDIR wedged the whole host at 95% CPU), so we
 * walk to the first existing ancestor and then create one segment at a time.
 */
export function safeEnsureDir(dir) {
  if (typeof dir !== 'string' || dir === '') return false
  let target
  try {
    target = resolve(dir)
  } catch {
    return false
  }
  if (isPseudoFsPath(target)) return false
  const missing = []
  let cursor = target
  while (true) {
    let stat
    try {
      stat = statSync(cursor)
    } catch {
      stat = undefined
    }
    if (stat !== undefined) {
      if (!stat.isDirectory()) return false
      break
    }
    missing.push(cursor)
    const parent = dirname(cursor)
    if (parent === cursor || missing.length > 32) return false
    cursor = parent
  }
  for (const segment of missing.reverse()) {
    try {
      mkdirSync(segment)
    } catch (error) {
      if (error?.code !== 'EEXIST') return false
    }
    try {
      if (!statSync(segment).isDirectory()) return false
    } catch {
      return false
    }
  }
  return true
}

/** Remove left-over `dsh-usage-*` temp dirs older than an hour (crashed renders). */
function cleanStaleTempDirs(root, now = Date.now()) {
  try {
    for (const name of readdirSync(root)) {
      if (!name.startsWith('dsh-usage-')) continue
      const path = join(root, name)
      try {
        if (now - statSync(path).mtimeMs > STALE_TEMP_MS) rmSync(path, { recursive: true, force: true })
      } catch {
        // best effort
      }
    }
  } catch {
    // root unreadable: the next draw simply uses another candidate
  }
}

/** Create a private (0700) temp dir under the first usable candidate. */
export function pickTempDir(ledger, now = Date.now()) {
  const candidates = [tmpdir(), process.env.TMPDIR, process.env.TMP, process.env.TEMP]
  if (typeof ledger?.home === 'string' && ledger.home !== '') {
    candidates.push(join(ledger.home, 'cache', 'dsh-go-token-usage', 'tmp'))
  }
  const seen = new Set()
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue
    let root
    try {
      root = resolve(candidate)
    } catch {
      continue
    }
    if (seen.has(root)) continue
    seen.add(root)
    if (!safeEnsureDir(root)) continue
    cleanStaleTempDirs(root, Date.now())
    try {
      return mkdtempSync(join(root, 'dsh-usage-'))
    } catch {
      // try the next candidate
    }
  }
  return undefined
}

let pythonState
let pythonFailedAt = 0
/** Resolved interpreter ("python3" or "python"); cached once one works. */
let pythonBin
/** In-flight async probe, so concurrent draws share one quick check. */
let rendererPromise

/** Candidate interpreters, in the order they are probed. */
function pythonCandidates() {
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
  return [...new Set(candidates)]
}

/**
 * Whether this host can draw the card (python3 + Pillow). Synchronous probe kept
 * for tests and compatibility; image export uses ensureRenderer() so a slow/hung
 * interpreter cannot block the host's event loop.
 */
export function canRender() {
  if (pythonState === true) return true
  // A probe can block for its timeout; do not repeat it on every tap.
  if (pythonFailedAt !== 0 && Date.now() - pythonFailedAt < 60_000) return false
  for (const bin of pythonCandidates()) {
    try {
      execFileSync(bin, ['-c', 'import PIL'], { stdio: 'ignore', timeout: 3000, killSignal: 'SIGKILL' })
      pythonBin = bin
      pythonState = true
      return true
    } catch {
      // try the next name
    }
  }
  pythonState = false
  pythonFailedAt = Date.now()
  return false
}

/**
 * Async version of canRender(): same candidates/timeouts, but a hung interpreter
 * only delays the pending export instead of freezing the plugin host. A failed
 * probe is not cached for long: installing Pillow should work without restart.
 */
export function ensureRenderer() {
  if (pythonState === true && typeof pythonBin === 'string') return Promise.resolve(pythonBin)
  if (rendererPromise === undefined) {
    rendererPromise = probeAsync().finally(() => {
      rendererPromise = undefined
    })
  }
  return rendererPromise
}

async function probeAsync() {
  for (const bin of pythonCandidates()) {
    try {
      await execFileAsync(bin, ['-c', 'import PIL'], { stdio: 'ignore', timeout: 3000, killSignal: 'SIGKILL' })
      pythonBin = bin
      pythonState = true
      return bin
    } catch {
      // try the next name
    }
  }
  pythonState = false
  pythonFailedAt = Date.now()
  throw new Error('missing-python')
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
  const en = words('en-US')
  const sessionId = typeof scope?.sessionId === 'string' && scope.sessionId !== '' ? scope.sessionId : null
  const session = sessionId === null ? undefined : ledger.session(sessionId)
  const sessionCoverage = sessionId !== null ? ledger.sessionCacheCoverage(sessionId) : undefined
  const today = ledger.window(1)
  const week = ledger.window(7)
  const month = ledger.window(30)
  const all = ledger.allTime()
  const weekCovered = ledger.coveredDays(7)
  const monthCovered = ledger.coveredDays(30)
  const todayCoverage = ledger.windowCacheCoverage(1)
  const weekCoverage = ledger.windowCacheCoverage(7)
  const monthCoverage = ledger.windowCacheCoverage(30)
  const average = (totals, covered) => (totals.calls === 0 ? '—' : displayCompact(Math.round(totalTokens(totals) / Math.max(1, covered))))
  const hit = (totals, coverage) => hitRateText(totals, coverage)
  const row = (wordsFor, label, totals, color, extra, coverage) => ({
    label,
    value: totals === undefined ? '—' : displayCompact(totalTokens(totals)),
    unit: wordsFor.tokens,
    meta: `${wordsFor.hit} ${hit(totals, coverage)}`,
    extra,
    color,
  })
  const buildRows = (wordsFor) => {
    const rows = [
      row(
        wordsFor,
        wordsFor.all,
        all,
        COLORS.all,
        `${wordsFor.inputTotal} ${displayCompact(all.input + all.cached + all.cacheWrite)} · ${wordsFor.output} ${displayCompact(all.output)}`,
        ledger.allCacheCoverage(),
      ),
    ]
    if (sessionId !== null) {
      const extra = session !== undefined
        ? `${wordsFor.inputTotal} ${displayCompact(session.input + session.cached + session.cacheWrite)} · ${wordsFor.output} ${displayCompact(session.output)}`
        : ''
      rows.push(row(wordsFor, wordsFor.session, session, COLORS.session, extra, sessionCoverage))
    }
    rows.push(
      row(
        wordsFor,
        wordsFor.today,
        today,
        COLORS.today,
        `${wordsFor.inputTotal} ${displayCompact(today.input + today.cached + today.cacheWrite)} · ${wordsFor.output} ${displayCompact(today.output)}`,
        todayCoverage,
      ),
      row(wordsFor, wordsFor.week, week, COLORS.week, `${wordsFor.daily} ${average(week, weekCovered)} · ${wordsFor.days} ${weekCovered}`, weekCoverage),
      row(wordsFor, wordsFor.month, month, COLORS.month, `${wordsFor.daily} ${average(month, monthCovered)} · ${wordsFor.days} ${monthCovered}`, monthCoverage),
    )
    return rows
  }
  const localeFor = (wordsFor) => (wordsFor === en ? 'en-US' : locale ?? 'zh-CN')
  const buildModels = (wordsFor) =>
    ledger.todayModels(6).map(([provider, model, tokens]) => ({
      name: sanitizeLabel(model, IMAGE_MODEL_MAX),
      source: sanitizeLabel(sourceLabel(provider, localeFor(wordsFor)), IMAGE_SOURCE_MAX),
      value: displayCompact(tokens),
    }))
  const rows = buildRows(w)
  const models = buildModels(w)
  const data = {
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
  // If the host has no CJK font, render.py draws this English label set instead of
  // silently filling the card with tofu boxes (audit V-04).
  if (w !== en) {
    const enRows = buildRows(en)
    const enModels = buildModels(en)
    data.fallback = {
      title: en.title,
      modelsTitle: en.models,
      modelCol: en.modelCol,
      sourceCol: en.sourceCol,
      tokensCol: en.tokensCol,
      footer: en.imageFooter,
      rows: enRows.map((item) => ({ label: item.label, meta: item.meta, extra: item.extra })),
      models: enModels.map((item) => ({ source: item.source })),
    }
  }
  return data
}

/** Refuse to write card images through a symlinked assets directory. */
function assertAssetsInsidePackage() {
  const pkg = realpathSync(PKG_DIR)
  let assets
  try {
    assets = realpathSync(ASSETS_DIR)
  } catch {
    return // not created yet: safeEnsureDir below creates a real directory
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
 * @param {{ ledger: any, scope?: any, locale?: string, now?: number, outDir?: string, protectedFiles?: string[] }} options
 */
export async function renderUsageImage({ ledger, scope, locale, now = Date.now(), outDir = ASSETS_DIR, protectedFiles = [] }) {
  let bin
  try {
    bin = await ensureRenderer()
  } catch {
    throw new Error('missing-python')
  }
  const data = cardData({ ledger, scope, locale, now })
  if (outDir === ASSETS_DIR) assertAssetsInsidePackage()
  if (!safeEnsureDir(outDir)) throw new Error('assets-dir-unwritable')
  // Always six lowercase base36 chars: the prune/prepack patterns depend on it.
  const suffix = Math.random().toString(36).slice(2, 8).padEnd(6, '0')
  const base = `usage-${stamp(now)}-${suffix}`
  const file = join(outDir, `${base}.png`)
  const tempDir = pickTempDir(ledger, now)
  if (tempDir === undefined) throw new Error('no-temp-dir')
  const input = join(tempDir, 'card.json')
  writeFileSync(input, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 })
  let size = { width: 1080, height: 1500 }
  try {
    const { stdout } = await execFileAsync(bin, [SCRIPT, input, file], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1 << 20, killSignal: 'SIGKILL' })
    try { chmodSync(file, 0o600) } catch { /* best effort on filesystems without modes */ }
    if (stdout) size = JSON.parse(stdout)
  } catch (error) {
    rmSync(file, { force: true }) // never leave a half-written card behind
    throw error
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
  if (outDir === ASSETS_DIR) {
    const protectedNames = []
    for (const item of protectedFiles) {
      const name = basename(String(item))
      if (name !== '' && name !== `${base}.png`) protectedNames.push(name)
    }
    prune(base, protectedNames)
  }
  const today = ledger.window(1)
  const tokens = displayCompact(totalTokens(today))
  const hit = hitRateText(today, ledger.windowCacheCoverage(1))
  const w = words(locale)
  // App 只认两种 image src：data:image 内联，或 asset:<包内 assets 下的路径>；
  // 后者由 App 自己拼成 /dsh-go/v1/assets/<包名>/<路径> 并带凭据去取。
  return {
    src: `asset:${basename(file)}`,
    aspect: Math.round((size.width / size.height) * 1000) / 1000,
    caption: `${w.today} ${tokens} tokens · ${w.hit} ${hit}`,
    // Language-neutral metadata so imagePanelData() can rebuild the caption after
    // the app switches languages (the PNG itself keeps the old language).
    tokens,
    hit,
    file,
  }
}
