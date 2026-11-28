// 目录换入：把新副本放到 `stable`，并且任何时候宿主都留着至少一份能用的副本。
//
// 2026-11-28 审查 P1-2：原来「cp → rm 旧目录 → rename 新目录」，rename 失败时旧副本
// 已经删了，错误信息却还在说「原副本保持不变」。这里把「备份旧的 → 换入新的 → 失败恢复
// → 成功后清理旧备份」收成一个函数，文件操作可注入，失败路径能被测试稳定触发。
import { cp, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const defaultFs = { cp, readdir, rename, rm }

const unique = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** Keep at most `keep` `<stable>.bak-*` directories next to `stable` (best effort). */
async function pruneBackups(stable, keep, fs) {
  const dir = dirname(stable)
  const base = stable.slice(dir.length + 1)
  let names
  try {
    names = await fs.readdir(dir)
  } catch {
    return
  }
  const backups = names.filter((name) => name.startsWith(`${base}.bak-`)).sort()
  for (const name of backups.slice(0, Math.max(0, backups.length - keep))) {
    await fs.rm(join(dir, name), { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Replace `stable` with a copy of `source`.
 * - the old copy is renamed aside first, never deleted before the new one is in;
 * - when the swap fails, the old copy is put back and the error says what happened;
 * - a first install (nothing at `stable`) still works;
 * - at most `keepBackups` old copies are kept after a success.
 * @returns {Promise<{ ok: true }>} resolves when `stable` holds the new copy
 */
export async function swapIn(source, stable, options = {}) {
  const fs = { ...defaultFs, ...options.fs }
  const keepBackups = Number.isInteger(options.keepBackups) ? options.keepBackups : 1
  const stage = `${stable}.partial-${unique()}`
  const backup = `${stable}.bak-${unique()}`
  let movedAside = false
  await fs.rm(stage, { recursive: true, force: true })
  try {
    await fs.cp(source, stage, { recursive: true })
    try {
      await fs.rename(stable, backup)
      movedAside = true
    } catch (error) {
      // Nothing installed yet: a first install is not a failure.
      if (error?.code !== 'ENOENT') throw error
    }
    await fs.rename(stage, stable)
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {})
    if (movedAside) {
      try {
        await fs.rename(backup, stable)
      } catch (restoreError) {
        throw new Error(`复制 ${source} 到 ${stable} 失败（${error.message}）；旧副本已移到 ${backup}，恢复也失败（${restoreError.message}），请手动把它改回 ${stable}`)
      }
      throw new Error(`复制 ${source} 到 ${stable} 失败（${error.message}）；旧副本已还原`)
    }
    throw new Error(`复制 ${source} 到 ${stable} 失败（${error.message}）；原副本未动`)
  }
  if (movedAside) await pruneBackups(stable, keepBackups, fs)
  return { ok: true }
}
