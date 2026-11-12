// What gets cleaned before publishing, and whether the local image cache keeps the
// cards other chats are still showing.
//
// Isolation: every test here works on a throwaway copy of the package, so the real
// repository assets/ directory is never written to. `node --test` runs files in
// parallel; rendering into the repo assets from a test used to race the other
// image tests (prune deleting a card another file had just written).
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import zlib from 'node:zlib'
import { canRender } from '../lib/render.js'
import { UsageLedger } from '../lib/ledger.js'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
const REAL_ASSETS = join(PKG, 'assets')
const NOW = Date.now()

/** Assets are as much of an input as the code: start from the real ones. */
const repoAssets = () => readdirSync(REAL_ASSETS).sort()

/** A throwaway copy of the package (lib + scripts + assets + manifest). */
function tempPackage() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-assets-pkg-'))
  for (const entry of ['lib', 'scripts', 'assets', 'package.json']) {
    cpSync(join(PKG, entry), join(root, entry), { recursive: true })
  }
  return root
}

const images = (root) => readdirSync(join(root, 'assets')).filter((name) => /^usage-/.test(name))

/** The repository assets must be byte-identical to before the test started. */
function assertRepoUntouched(before) {
  assert.deepEqual(repoAssets(), before, 'the repository assets/ must not be touched by a test')
}

test('prepack cleanup removes both current and legacy usage images', () => {
  const before = repoAssets()
  const root = tempPackage()
  try {
    const assets = join(root, 'assets')
    const created = ['usage-20261112-120000-abcd12.png', 'usage-20261112-120000.png']
    for (const name of created) writeFileSync(join(assets, name), Buffer.from('png'))
    execFileSync(process.execPath, [join(root, 'scripts', 'clean-assets.mjs')], { encoding: 'utf8' })
    const left = readdirSync(assets)
    for (const name of created) assert.equal(left.includes(name), false, `${name} must be cleaned before packing`)
    assert.deepEqual(images(root), [])
    assertRepoUntouched(before)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('npm pack never includes local usage images', () => {
  const before = repoAssets()
  const root = tempPackage()
  try {
    writeFileSync(join(root, 'assets', 'usage-20261112-120000-abc123.png'), Buffer.from('png'))
    const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' })
    // prepack may print a line before the JSON document
    const json = out.slice(out.indexOf('['), out.lastIndexOf(']') + 1)
    const files = JSON.parse(json)[0].files.map((file) => file.path)
    assert.equal(files.some((path) => /assets\/usage-/.test(path)), false, files.join(','))
    assertRepoUntouched(before)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('prune keeps images other chats are still showing', { skip: !canRender() && 'host has no python3 + Pillow' }, async () => {
  const before = repoAssets()
  // The plugin only prunes when outDir is its own package assets, so test against a
  // throwaway package copy instead of the repository's assets/.
  const root = tempPackage()
  const home = mkdtempSync(join(tmpdir(), 'assets-prune-'))
  try {
    const { renderUsageImage } = await import(pathToFileURL(join(root, 'lib', 'render.js')).href)
    const dir = join(home, 'sessions', 'proj', 'session-aaa')
    mkdirSync(dir, { recursive: true })
    const header = JSON.stringify({ type: 'session', version: 4, id: 'session-aaa', createdAt: NOW, cwd: '/p' })
    const call = JSON.stringify({ type: 'assistant/message', seq: 1, time: NOW, data: { turn: 1, step: 1, usage: { inputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 0, outputTokens: 5 }, message: { source: { provider: 'p', model: 'm1' } } } })
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from([header, call].join('\n') + '\n')))
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    const keep = await renderUsageImage({ ledger, locale: 'zh-CN', now: NOW })
    const protectedFiles = [keep.file]
    for (let i = 1; i <= 3; i += 1) {
      await renderUsageImage({ ledger, locale: 'zh-CN', now: NOW + i * 1000, protectedFiles })
    }
    const left = images(root)
    assert.ok(left.includes(keep.src.slice('asset:'.length)), 'the protected card must survive pruning')
    assert.ok(left.length <= 4, `prune kept ${left.length} images`)
    assert.ok(!left.includes('placeholder.png'), 'the placeholder is not a usage card')
    ledger.dispose()
    assertRepoUntouched(before)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})
