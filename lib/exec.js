// Executable lookup that a rooted phone or an `adb shell`-started host cannot
// hijack: PATH entries that are relative or writable by others are never trusted.
import { accessSync, constants, statSync } from 'node:fs'
import os from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'

// Only native PE binaries: `execFile` cannot run `.cmd`/`.bat` natively (Node
// needs a shell for those) nor extensionless npm bash shims, so returning them
// would resolve "successfully" and then fail to execute. Windows installs are
// therefore unsupported until the installer grows a `shell: true` path.
const WINDOWS_EXTENSIONS = ['.exe', '.com']
/** Writable by the current group or by everyone: another user may replace its contents. */
const WRITABLE_MODE = 0o022
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
 * Resolve an executable like a shell would, but skip relative PATH entries and
 * anything a third party can write (e.g. /data/local/tmp on Android, /tmp on
 * many hosts, group-writable tool dirs). Returns the absolute path, or undefined
 * when nothing safe was found.
 */
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
