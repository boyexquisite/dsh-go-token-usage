// What gets cleaned before publishing, and whether the local image cache keeps the
// cards other chats are still showing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { UsageLedger } from '../lib/ledger.js'
import { canRender, renderUsageImage } from '../lib/render.js'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
const ASSETS = join(PKG, 'assets')
const NOW = Date.now()
const images = () => readdirSync(ASSETS).filter((name) => /^usage-/.test(name))

test('prepack cleanup removes both current and legacy usage images', () => {
  const created = ['usage-20261112-120000-abcd12.png', 'usage-20261112-120000.png']
  for (const name of created) writeFileSync(join(ASSETS, name), Buffer.from('png'))
  try {
    execFileSync(process.execPath, [join(PKG, 'scripts', 'clean-assets.mjs')], { encoding: 'utf8' })
    const left = images()
    for (const name of created) assert.equal(left.includes(name), false, `${name} must be cleaned before packing`)
  } finally {
    for (const name of created) rmSync(join(ASSETS, name), { force: true })
  }
})

test('npm pack never includes local usage images', () => {
  const created = join(ASSETS, 'usage-20261112-120000-abc123.png')
  writeFileSync(created, Buffer.from('png'))
  try {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: PKG, encoding: 'utf8' })
    // prepack may print a line before the JSON document
    const json = out.slice(out.indexOf('['), out.lastIndexOf(']') + 1)
    const files = JSON.parse(json)[0].files.map((file) => file.path)
    assert.equal(files.some((path) => /assets\/usage-/.test(path)), false, files.join(','))
  } finally {
    rmSync(created, { force: true })
  }
})

test('prune keeps images other chats are still showing', { skip: !canRender() && 'host has no python3 + Pillow' }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'assets-prune-'))
  const before = new Set(images())
  try {
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
    const left = images()
    assert.ok(left.includes(keep.src.slice('asset:'.length)), 'the protected card must survive pruning')
    assert.ok(left.length <= 4, `prune kept ${left.length} images`)
    ledger.dispose()
  } finally {
    for (const name of images()) if (!before.has(name)) rmSync(join(ASSETS, name), { force: true })
    rmSync(home, { recursive: true, force: true })
  }
})
