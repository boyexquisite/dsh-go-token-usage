// 换入目录的失败路径：旧副本绝不能先被删掉。2026-11-28 审查 P1-2 的回归测试。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { rename as renameAsync } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultFs, swapIn } from '../lib/swap.js'

function makeDirs() {
  const root = mkdtempSync(join(tmpdir(), 'swap-'))
  const source = join(root, 'source')
  const stable = join(root, 'plugin')
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'p', version: '2.0.0' }))
  return { root, source, stable }
}

test('a successful swap leaves the new copy and one backup', async () => {
  const { root, source, stable } = makeDirs()
  try {
    mkdirSync(stable, { recursive: true })
    writeFileSync(join(stable, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }))
    await swapIn(source, stable)
    assert.equal(JSON.parse(readFileSync(join(stable, 'package.json'), 'utf8')).version, '2.0.0')
    const backups = readdirSync(root).filter((name) => name.startsWith('plugin.bak-'))
    assert.equal(backups.length, 1, 'the previous copy is kept for one rollback window')
    assert.equal(JSON.parse(readFileSync(join(root, backups[0], 'package.json'), 'utf8')).version, '1.0.0')
    // Older backups do not pile up.
    await swapIn(source, stable)
    await swapIn(source, stable)
    assert.equal(readdirSync(root).filter((name) => name.startsWith('plugin.bak-')).length, 1)
    assert.equal(readdirSync(root).filter((name) => name.includes('.partial-')).length, 0, 'no staging dir is left behind')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a first install (nothing installed yet) works', async () => {
  const { root, source, stable } = makeDirs()
  try {
    await swapIn(source, stable)
    assert.equal(JSON.parse(readFileSync(join(stable, 'package.json'), 'utf8')).version, '2.0.0')
    assert.equal(readdirSync(root).filter((name) => name.startsWith('plugin.bak-')).length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a failed swap puts the old copy back instead of leaving nothing', async () => {
  const { root, source, stable } = makeDirs()
  try {
    mkdirSync(stable, { recursive: true })
    writeFileSync(join(stable, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }))
    const fs = {
      ...defaultFs,
      rename: async (from, to) => {
        // The final "move the new copy into place" fails.
        if (from.includes('.partial-') && to === stable) throw Object.assign(new Error('EIO: injected'), { code: 'EIO' })
        return renameAsync(from, to)
      },
    }
    await assert.rejects(swapIn(source, stable, { fs }), (error) => {
      assert.match(error.message, /旧副本已还原/)
      assert.doesNotMatch(error.message, /原副本未动|原副本保持不变/)
      return true
    })
    assert.equal(JSON.parse(readFileSync(join(stable, 'package.json'), 'utf8')).version, '1.0.0', 'the old copy is usable again')
    assert.equal(readdirSync(root).filter((name) => name.includes('.partial-')).length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('when even the restore fails the error names the backup that still holds the old copy', async () => {
  const { root, source, stable } = makeDirs()
  try {
    mkdirSync(stable, { recursive: true })
    writeFileSync(join(stable, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }))
    let backups = []
    const fs = {
      ...defaultFs,
      rename: async (from, to) => {
        if (from.includes('.partial-') && to === stable) throw Object.assign(new Error('EIO: injected'), { code: 'EIO' })
        if (from.includes('.bak-') && to === stable) throw Object.assign(new Error('EIO: restore failed'), { code: 'EIO' })
        if (to.includes('.bak-')) backups.push(to)
        return renameAsync(from, to)
      },
    }
    await assert.rejects(swapIn(source, stable, { fs }), (error) => {
      assert.match(error.message, /恢复也失败/)
      assert.ok(error.message.includes(backups[0]), 'the message says where the old copy is')
      return true
    })
    assert.equal(readdirSync(backups[0]).includes('package.json'), true, 'the old copy really is there')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
