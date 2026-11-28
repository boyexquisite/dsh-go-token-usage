// 主机侧出图：把面板上的数字画成一张 PNG，写进包的 assets/ 目录，
// 通过桥接的 /dsh-go/v1/assets/<包名>/<文件> 给 App 显示（点开是图片页）。
//
// 画图用 Python + Pillow（系统自带或 pip 装上即可）。没有它时按钮给一句
// 人话提示，其余功能不受影响。
import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, closeSync, constants as fsConstants, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { totalTokens } from './tally.js'
import { displayCompact, hitRateText, sanitizeLabel, sourceLabel, words } from './view.js'
import { isTrustedExecutable, resolveExecutable } from './exec.js'

const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(PKG_DIR, 'scripts', 'render.py')
const ASSETS_DIR = join(PKG_DIR, 'assets')
const KEEP_IMAGES = 3
const execFileAsync = promisify(execFile)

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' })

/** execFile + real cancellation: kill the exact child and wait for its close before cleanup. */
function execFileWithSignal(bin, args, options, signal) {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    let child
    let aborted = false
    const onAbort = () => {
      aborted = true
      try { child.kill('SIGKILL') } catch { /* already exited */ }
    }
    const done = (error, stdout, stderr) => {
      signal?.removeEventListener('abort', onAbort)
      if (aborted) reject(abortError())
      else if (error) reject(error)
      else resolve({ stdout, stderr })
    }
    try {
      child = execFile(bin, args, options, done)
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      }
    } catch (error) {
      signal?.removeEventListener('abort', onAbort)
      reject(error)
    }
  })
}

const COLORS = { all: '#3D6FD6', session: '#258051', today: '#CA6328', week: '#167F84', month: '#8554BB' }

// PNG 的模型/来源两列比面板窄；先清洗换行/控制字符，再裁到这两列放得下的长度。
const IMAGE_MODEL_MAX = 28
const IMAGE_SOURCE_MAX = 18
/** A crashed render may leave its 0700 temp dir behind; clean it up on the next draw. */
const STALE_TEMP_MS = 60 * 60 * 1000
/** 2026-11-28: 插件自己的 temp base 前缀；清理只允许发生在这个 base 里面。 */
const TEMP_BASE_PREFIX = 'dsh-usage-'
/** 每次出图的临时目录名；base 里只有带这个前缀的条目才会被当作遗留清理。 */
const RUN_PREFIX = 'run-'
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

const selfUid = () => process.getuid?.()

/** 插件专有的 base 名：同一台机器上不同用户共用一个 TMPDIR 时也互不干扰。 */
const tempBaseName = () => `${TEMP_BASE_PREFIX}${selfUid() ?? 'u'}`

/**
 * 2026-11-28: 取得插件自己的 temp base（不存在就按 0700 建），拿不到就放弃这个
 * root 候选。旧实现在共享 TMPDIR 顶层按 `dsh-usage-` 前缀 + 年龄递归删除，
 * 别人或别的程序的同名目录会被一起删掉。现在清理范围只在自己的 base 里，
 * 判断依据是 lstat（不跟随符号链接）：必须是真正的目录、uid 是自己，
 * 别人的、符号链接、普通文件一律不接管也不删除。
 */
function openTempBase(root) {
  const uid = selfUid()
  const path = join(root, tempBaseName())
  let st
  try {
    st = lstatSync(path)
  } catch (error) {
    if (error?.code !== 'ENOENT') return undefined
    try {
      mkdirSync(path, { mode: 0o700 })
      st = lstatSync(path)
    } catch {
      return undefined
    }
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return undefined
  if (uid !== undefined && st.uid !== uid) return undefined
  if (uid !== undefined && (st.mode & 0o077) !== 0) {
    // 自己的 base 收窄回 0700；改不动就不用它，别把清理范围交给半个权限。
    try {
      chmodSync(path, 0o700)
      st = lstatSync(path)
    } catch {
      return undefined
    }
    if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== uid) return undefined
  }
  return path
}

/**
 * 2026-11-28: 只清 base 里由 mkdtemp 建的 `run-*` 目录（崩溃的出图留下的）。
 * 不属于自己的条目（别人的 uid、符号链接、普通文件）一律不碰，base 以外的
 * 东西更不碰——旧版本崩溃留下的顶层 `dsh-usage-*` 从此不会被自动回收，
 * 这是不越界删除的代价。
 */
function cleanStaleTempDirs(base, now = Date.now()) {
  const uid = selfUid()
  let names
  try {
    names = readdirSync(base)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith(RUN_PREFIX)) continue
    const path = join(base, name)
    let st
    try {
      st = lstatSync(path)
    } catch {
      continue
    }
    if (st.isSymbolicLink() || !st.isDirectory()) continue
    if (uid !== undefined && st.uid !== uid) continue
    if (now - st.mtimeMs <= STALE_TEMP_MS) continue
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
}

/**
 * Create a private (0700) temp dir under the first usable candidate.
 * `now` is kept for call-site compatibility: the age check always uses the wall
 * clock, because the card timestamp passed by the caller may be far in the past.
 */
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
    const base = openTempBase(root)
    if (base === undefined) continue
    cleanStaleTempDirs(base)
    try {
      return mkdtempSync(join(base, RUN_PREFIX))
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
  // 2026-11-28: 覆盖值和固定路径以前直接进候选，绕过了 PATH 那条所有者/祖先
  // 目录检查（覆盖值甚至允许相对路径）。现在所有候选走同一个 isTrustedExecutable，
  // 不合格的静默丢弃，继续试下一个；全都不合格时对外仍是 missing-python。
  return [...new Set(candidates)].filter((bin) => isTrustedExecutable(bin))
}

/**
 * Whether this host can draw the card (python3 + Pillow). Synchronous probe kept
 * for tests and compatibility; image export uses ensureRenderer() so a slow/hung
 * interpreter cannot block the host's event loop.
 */
export function canRender() {
  if (pythonState === true) {
    // 2026-11-28: 缓存下来的 bin 也可能在这期间被换掉，命中了才真的算数。
    if (typeof pythonBin === 'string' && isTrustedExecutable(pythonBin)) return true
    pythonState = undefined
    pythonBin = undefined
  }
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
  if (pythonState === true && typeof pythonBin === 'string' && isTrustedExecutable(pythonBin)) return Promise.resolve(pythonBin)
  if (pythonState === true) {
    // 2026-11-28: 缓存的解释器已不可信，清掉缓存重新探测。
    pythonState = undefined
    pythonBin = undefined
  }
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
 * @param {{ ledger: any, scope?: any, locale?: string, now?: number, outDir?: string, protectedFiles?: string[], signal?: AbortSignal }} options
 */
export async function renderUsageImage({ ledger, scope, locale, now = Date.now(), outDir = ASSETS_DIR, protectedFiles = [], signal }) {
  if (signal?.aborted) throw abortError()
  let bin
  try {
    bin = await ensureRenderer()
  } catch {
    throw new Error('missing-python')
  }
  // 2026-11-28: 从探测到 spawn 之间还要构建整张卡的数据；再用同一道检查确认
  // 这个 bin 仍然可信，缩短"检查—执行"的间隙。不可信就当没有解释器。
  if (!isTrustedExecutable(bin)) {
    pythonState = undefined
    pythonBin = undefined
    throw new Error('missing-python')
  }
  if (signal?.aborted) throw abortError()
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
  let claimed = false
  try {
    // 2026-11-28: 先以 0600 独占建出目标文件，再交给 Python 覆写。render.py 用
    // image.save() 打开的是已存在的 inode，会沿用这里的权限；旧实现要等子进程
    // 退出之后才 chmod，那段时间这张卡对其他用户可读。O_EXCL 也顺手挡住随机
    // 后缀碰撞——撞上就报错，绝不覆盖同名文件。
    let fd
    try {
      fd = openSync(file, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600)
    } catch (error) {
      if (error?.code === 'EEXIST') throw new Error('output-collision')
      throw error
    }
    claimed = true
    closeSync(fd)
    // 不写 .pyc：渲染脚本在包目录里，别让每次出图往 scripts/__pycache__ 塞字节码。
    const { stdout } = await execFileWithSignal(bin, [SCRIPT, input, file], {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 1 << 20,
      killSignal: 'SIGKILL',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    }, signal)
    try { chmodSync(file, 0o600) } catch { /* best effort on filesystems without modes */ }
    if (stdout) size = JSON.parse(stdout)
  } catch (error) {
    // 只删自己刚建出来的文件；O_EXCL 撞名时那个文件是别人的。
    if (claimed) rmSync(file, { force: true }) // never leave a half-written card behind
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
    prune(basename(file), protectedNames)
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
