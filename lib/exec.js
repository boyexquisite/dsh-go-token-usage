// Executable lookup that a rooted phone or an `adb shell`-started host cannot
// hijack: PATH entries that are relative or writable by others are never trusted.
import { accessSync, constants, lstatSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'

// Only native PE binaries: `execFile` cannot run `.cmd`/`.bat` natively (Node
// needs a shell for those) nor extensionless npm bash shims, so returning them
// would resolve "successfully" and then fail to execute. Windows installs are
// therefore unsupported until the installer grows a `shell: true` path.
const WINDOWS_EXTENSIONS = ['.exe', '.com']
/** Writable by the current group or by everyone: another user may replace its contents. */
const WRITABLE_MODE = 0o022
/** Sticky directories (/tmp and friends): only the owner may unlink or rename an entry. */
const STICKY_BIT = 0o1000
/**
 * Kernel pseudo filesystems: `mkdirSync(path, { recursive: true })` under these
 * can spin forever (mkdir returns ENOENT while the parent already exists), so a
 * poisoned DSH_HOME/HOME must never reach a recursive mkdir.
 */
const PSEUDO_FS_ROOTS = ['/proc', '/sys', '/dev']

/** True when `path` resolves under /proc, /sys or /dev. */
export function isPseudoFsPath(path) {
  if (typeof path !== 'string' || path === '') return false
  let resolved
  try {
    resolved = resolve(path)
  } catch {
    return false
  }
  return PSEUDO_FS_ROOTS.some((root) => resolved === root || resolved.startsWith(`${root}/`))
}

/**
 * 2026-11-28: 第三方能写、且不是 sticky 的条目才叫"能被换掉"。sticky 目录
 * （/tmp 这类 1777）里已有的文件只有 owner 和 root 能删除或重命名，别人只能
 * 抢注还不存在的名字，而那一条由上面的 uid 检查挡着（抢注的文件不是自己的
 * uid）。普通文件上的 sticky 位在 Linux 上不提供任何保护，所以只对目录放宽。
 */
function isThirdPartyWritable(st) {
  if ((st.mode & WRITABLE_MODE) === 0) return false
  return !(st.isDirectory() && (st.mode & STICKY_BIT) !== 0)
}

/**
 * Resolve an executable like a shell would, but skip relative PATH entries and
 * anything a third party can write (e.g. /data/local/tmp on Android, group-writable
 * tool dirs). Returns the absolute path, or undefined when nothing safe was found.
 */
function trustedPath(path) {
  const uid = process.getuid?.()
  const check = (full) => {
    let current = resolve(full)
    for (;;) {
      const st = lstatSync(current)
      if (uid !== undefined && st.uid !== 0 && st.uid !== uid) return false
      if (st.isSymbolicLink()) {
        if (!check(realpathSync(current))) return false
      } else if (isThirdPartyWritable(st)) return false
      const parent = dirname(current)
      if (parent === current) return true
      current = parent
    }
  }
  return check(path) && check(realpathSync(path))
}

/**
 * 2026-11-28: 出图解释器的统一信任检查。以前 `DSH_TOKEN_USAGE_PYTHON` 覆盖值
 * 和 `/usr/bin/python3` 这类固定路径直接进候选，绕过了 PATH 那条检查——相对
 * 路径、/tmp 里的脚本、别人拥有的可执行文件都能被拿来跑。现在所有候选（覆盖
 * 值、固定路径、PATH 命中的）都走这一道，复用的是上面那份 trustedPath。
 *
 * 要求：绝对路径、普通文件（跟随符号链接后，与 resolveExecutable 一致）、
 * POSIX 上有执行位、整条祖先链不可被第三方替换、owner 是 root 或当前 uid。
 */
export function isTrustedExecutable(path) {
  if (typeof path !== 'string' || path === '' || !isAbsolute(path)) return false
  try {
    if (isPseudoFsPath(path)) return false
    const st = statSync(path)
    if (!st.isFile()) return false
    if (process.platform !== 'win32' && (st.mode & 0o111) === 0) return false
    return trustedPath(path)
  } catch {
    return false
  }
}

export function resolveExecutable(name) {
  if (typeof name !== 'string' || name === '') return undefined
  const isWindows = process.platform === 'win32'
  const extensions = isWindows ? WINDOWS_EXTENSIONS : ['']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    // A relative entry would make the returned path relative too, and the caller
    // executes it through PATH again (cwd-dependent hijack).
    if (!isAbsolute(dir)) continue
    let dirStat
    try {
      dirStat = statSync(dir)
    } catch {
      continue
    }
    if (!dirStat.isDirectory()) continue
    if ((dirStat.mode & WRITABLE_MODE) !== 0) continue
    for (const extension of extensions) {
      const candidate = join(dir, name + extension)
      try {
        const fileStat = statSync(candidate)
        if (!fileStat.isFile()) continue
        if (!trustedPath(candidate)) continue
        if ((fileStat.mode & WRITABLE_MODE) !== 0) continue
        if (!isWindows) accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        // keep looking
      }
    }
  }
  return undefined
}

/**
 * Resolve `$DSH_HOME` without throwing: an Android app uid may have no passwd
 * entry (os.homedir() raises) and HOME="" or "/" are unusable.
 */
export function resolveHome(explicit) {
  const pick = (value) => {
    const text = String(value ?? '').trim()
    if (text === '' || text === '/' || text === '\\') return ''
    // A home under /proc, /sys or /dev would make every recursive mkdir downstream hang.
    if (isPseudoFsPath(text)) return ''
    return text
  }
  const configured = pick(explicit ?? process.env.DSH_HOME)
  if (configured !== '') return configured
  for (const name of ['HOME', 'USERPROFILE']) {
    const value = pick(process.env[name])
    if (value !== '') return join(value, '.dsh')
  }
  try {
    const home = pick(os.homedir())
    if (home !== '') return join(home, '.dsh')
  } catch {
    // SystemError on Android app uids
  }
  try {
    const fallback = join(process.cwd(), '.dsh')
    if (!isPseudoFsPath(fallback)) return fallback
  } catch {
    // cwd is gone: fall through to a relative path
  }
  try {
    const temp = join(os.tmpdir(), '.dsh')
    if (!isPseudoFsPath(temp)) return temp
  } catch {
    // tmpdir unavailable
  }
  return '.dsh'
}
