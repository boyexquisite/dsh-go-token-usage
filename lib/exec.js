// Executable lookup that a rooted phone or an `adb shell`-started host cannot
// hijack: PATH entries in world-writable directories are never trusted.
import { accessSync, constants, statSync } from 'node:fs'
import os from 'node:os'
import { delimiter, join } from 'node:path'

const WINDOWS_EXTENSIONS = ['', '.exe', '.cmd', '.bat', '.com']

/**
 * Resolve an executable like a shell would, but skip world-writable directories
 * (e.g. /data/local/tmp on Android, /tmp on many hosts). Returns the absolute
 * path, or undefined when nothing safe was found.
 */
export function resolveExecutable(name) {
  if (typeof name !== 'string' || name === '') return undefined
  const isWindows = process.platform === 'win32'
  const extensions = isWindows ? WINDOWS_EXTENSIONS : ['']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    let dirStat
    try {
      dirStat = statSync(dir)
    } catch {
      continue
    }
    if (!dirStat.isDirectory()) continue
    if (!isWindows && (dirStat.mode & 0o002) !== 0) continue
    for (const extension of extensions) {
      const candidate = join(dir, name + extension)
      try {
        const fileStat = statSync(candidate)
        if (!fileStat.isFile()) continue
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
    return text !== '' && text !== '/' && text !== '\\' ? text : ''
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
    return join(process.cwd(), '.dsh')
  } catch {
    return '.dsh'
  }
}
