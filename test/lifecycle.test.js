// H9 (host side): after ctx dispose the plugin must not keep pushing panel data
// or accept new feeds. The ledger-side "no save after dispose" lives in ledger.js.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { apply } from '../lib/index.js'

const NOW = Date.now()
const z = (lines) => zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'))
const header = (id) => JSON.stringify({ type: 'session', version: 4, id, createdAt: NOW, cwd: '/p' })
const call = (seq, turn, input, cached, output) =>
  JSON.stringify({
    type: 'assistant/message', seq, time: NOW,
    data: { turn, step: seq, usage: { inputTokens: input, cacheReadTokens: cached, cacheWriteTokens: 0, outputTokens: output }, message: { source: { provider: 'deepseek-account', model: 'm1' } } },
  })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'lifecycle-'))
  const dir = join(home, 'sessions', 'proj', 'session-a')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), z([header('session-a'), call(1, 1, 10, 100, 5)]))
  const handlers = {}
  const captures = {}
  const ctx = { on: (name, fn) => { handlers[name] = fn }, effect: (fn) => { ctx._dispose = fn() }, inject: (deps, fn) => fn(ctx) }
  ctx.dshGo = { panel: (id, def) => { (captures.panels ??= {})[id] = def }, strip: () => {}, turnNote: () => {} }
  apply(ctx, { home })
  return { home, ctx, captures, handlers }
}

test('after dispose a late session/event does not push panel data', async () => {
  const { home, ctx, captures, handlers } = setup()
  try {
    let emits = 0
    const cancel = captures.panels.usage.data({ sessionId: 'session-a' }, () => { emits += 1 }, { locale: 'zh-CN' })
    await sleep(300)
    ctx._dispose()
    const afterDispose = emits
    handlers['session/event']({ id: 'session-a' }, JSON.parse(call(9, 9, 10, 100, 5)))
    await sleep(100)
    assert.equal(emits, afterDispose, 'a late event must not emit after dispose')
    const lateFeed = captures.panels.usage.data({ sessionId: 'session-a' }, () => { emits += 1 }, { locale: 'zh-CN' })
    await sleep(50)
    assert.equal(typeof lateFeed, 'function')
    lateFeed()
    assert.equal(emits, afterDispose, 'a feed created after dispose stays silent')
    cancel()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('dispose and a late feed cancel are idempotent', async () => {
  const { home, ctx, captures } = setup()
  try {
    const cancel = captures.panels.usage.data({ sessionId: 'session-a' }, () => {}, { locale: 'zh-CN' })
    await sleep(300)
    ctx._dispose()
    ctx._dispose()
    cancel()
    cancel()
    assert.ok(true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
