import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { UsageLedger } from '../lib/ledger.js'
import { canRender, cardData, renderUsageImage } from '../lib/render.js'
import { imagePanelData, usageView } from '../lib/view.js'

const NOW = new Date(2026, 10, 12, 12, 0, 0).getTime()
const call = (seq, provider, model, input, cached, output) =>
  JSON.stringify({
    type: 'assistant/message',
    seq,
    time: NOW - (10 - seq) * 60_000,
    data: {
      turn: seq + 1,
      step: 1,
      usage: { inputTokens: input, cacheReadTokens: cached, cacheWriteTokens: 0, outputTokens: output },
      message: { source: { provider, model } },
    },
  })

function homeWithLog() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-render-'))
  const dir = join(home, 'sessions', 'proj', 'session-aaa')
  mkdirSync(dir, { recursive: true })
  return { home, dir }
}

const collect = (node, type, out = []) => {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) collect(item, type, out)
    return out
  }
  if (node.type === type) out.push(node)
  for (const value of Object.values(node)) collect(value, type, out)
  return out
}

test('usageView: one panel with the image at the bottom and four actions', () => {
  const view = usageView({}, { locale: 'zh-CN' })
  assert.equal(view.v, 2)
  const image = collect(view, 'image')[0]
  assert.deepEqual(image.src, { $: 'data.imageSrc' })
  assert.deepEqual(image.aspect, { $: 'data.imageAspect' })
  const actions = collect(view, 'actions')[0].items.map((item) => item.action)
  assert.deepEqual(actions, ['copy', 'export', 'verify', 'refresh'])
  assert.ok(JSON.stringify(view).length < 32 * 1024)
})

test('imagePanelData: placeholder until a render exists, then the asset reference', () => {
  const empty = imagePanelData(null, 'zh-CN')
  assert.equal(empty.imageSrc, 'asset:placeholder.png')
  assert.ok(empty.imageCaption.includes('生成图片'))
  const ready = imagePanelData({ src: 'asset:usage-20260101-000000.png', aspect: 0.66, caption: '今日 1M tokens' }, 'zh-CN')
  assert.equal(ready.imageSrc, 'asset:usage-20260101-000000.png')
  assert.equal(ready.imageAspect, 0.66)
  assert.equal(ready.imageCaption, '今日 1M tokens')
})

test('cardData: rows, colors and provider labels for the image', async () => {
  const { home } = homeWithLog()
  try {
    const dir = join(home, 'sessions', 'proj', 'session-aaa')
    const header = JSON.stringify({ type: 'session', version: 4, id: 'session-aaa', createdAt: NOW, cwd: '/p' })
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from([header, call(0, 'deepseek-account', 'm1', 10, 100, 5), call(1, 'custom-sta1n', 'm2', 10, 200, 6)].join('\n') + '\n', 'utf8')))
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    const data = cardData({ ledger, scope: { sessionId: 'session-aaa' }, locale: 'zh-CN', now: NOW })
    assert.equal(data.title, 'Token 用量')
    assert.deepEqual(data.rows.map((row) => row.label), ['累计', '本对话', '今日', '近 7 天', '近 30 天'])
    assert.equal(data.rows[0].color, '#3D6FD6')
    assert.match(data.rows[0].value, /^\d+(\.\d+)?[kMB]?$/)
    assert.deepEqual(data.models.map((m) => m.source), ['中转 · sta1n', '官方 · 账号'])
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('renderUsageImage draws a PNG the bridge can serve', { skip: !canRender() && 'host has no python3 + Pillow' }, async () => {
  const { home } = homeWithLog()
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-render-out-'))
  try {
    const dir = join(home, 'sessions', 'proj', 'session-aaa')
    const header = JSON.stringify({ type: 'session', version: 4, id: 'session-aaa', createdAt: NOW, cwd: '/p' })
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from([header, call(0, 'deepseek-account', 'm1', 10, 100, 5)].join('\n') + '\n', 'utf8')))
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    const out = renderUsageImage({ ledger, scope: { sessionId: 'session-aaa' }, pkgName: 'dsh-go-token-usage', locale: 'zh-CN', now: NOW, outDir })
    assert.match(out.src, /^asset:usage-\d{8}-\d{6}\.png$/)
    assert.ok(out.aspect > 0.25 && out.aspect < 4)
    assert.ok(statSync(out.file).size > 5000, 'PNG has real pixels')
    assert.ok(out.caption.includes('tokens'))
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
})
