// Host half: the panel/strip/turn-note feeds and the tap actions, driven through a
// fake dsh-go bridge. This is where locale leaks, the deferred image export and
// the per-scope image cache are caught.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { apply } from '../lib/index.js'
import { canRender } from '../lib/render.js'

const NOW = Date.now()
const z = (lines) => zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'))
const header = (id) => JSON.stringify({ type: 'session', version: 4, id, createdAt: NOW, cwd: '/p' })
const call = (seq, turn, input, cached, output, provider = 'deepseek-account') =>
  JSON.stringify({
    type: 'assistant/message', seq, time: NOW,
    data: { turn, step: seq, usage: { inputTokens: input, cacheReadTokens: cached, cacheWriteTokens: 0, outputTokens: output }, message: { source: { provider, model: 'm1' } } },
  })
// A relay that does not report cache counters at all (fields absent, not zero).
const relayCall = (seq, turn, input, output) =>
  JSON.stringify({
    type: 'assistant/message', seq, time: NOW,
    data: { turn, step: seq, usage: { inputTokens: input, outputTokens: output }, message: { source: { provider: 'custom-relay', model: 'm1' } } },
  })

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'host-'))
  const imageDir = mkdtempSync(join(tmpdir(), 'host-img-'))
  for (const [id, lines] of [
    ['session-aaa', [header('session-aaa'), call(1, 1, 10, 900, 5), call(2, 2, 20, 1800, 6)]],
    ['session-bbb', [header('session-bbb'), relayCall(1, 1, 100, 10)]],
  ]) {
    const dir = join(home, 'sessions', 'proj', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), z(lines))
  }
  const handlers = {}
  const captures = {}
  const ctx = {
    on: (name, fn) => { handlers[name] = fn },
    effect: (fn) => { ctx._dispose = fn() },
    inject: (deps, fn) => fn(ctx),
  }
  ctx.dshGo = {
    panel: (id, def) => { captures.panel = def },
    strip: (id, feed) => { captures.strip = feed },
    turnNote: (id, feed) => { captures.turnNote = feed },
  }
  apply(ctx, { home, imageDir })
  return { home, imageDir, ctx, captures, handlers }
}

const pull = (feed, scope, locale) => {
  let data
  const off = feed(scope, (next) => { data = next }, { locale })
  off()
  return data
}

test('panel, strip and turn notes render in both locales', async () => {
  const { home, imageDir, ctx, captures } = setup()
  await new Promise((resolve) => setTimeout(resolve, 250))
  try {
    const zh = pull(captures.panel.data, { sessionId: 'session-aaa' }, 'zh-CN')
    assert.match(zh.updated, /^(已更新 |\d{2}\/\d{2} \d{2}:\d{2})/)
    assert.equal(zh.lastVerify, '未核对')
    const en = pull(captures.panel.data, { sessionId: 'session-aaa' }, 'en-US')
    assert.match(en.updated, /^(Updated |\d{2}\/\d{2} \d{2}:\d{2})/)
    assert.equal(en.lastVerify, 'Not verified')
    const relay = pull(captures.panel.data, { sessionId: 'session-bbb' }, 'en-US')
    assert.equal(relay.session.hit, '—')
    const strip = pull(captures.strip, { sessionId: 'session-aaa' }, 'zh-CN')
    assert.ok([...strip.text].length <= 24)
    const notes = pull(captures.turnNote, { sessionId: 'session-aaa' }, 'en-US')
    for (const note of Object.values(notes)) assert.ok([...note.text].length <= 16, note.text)
    ctx._dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(imageDir, { recursive: true, force: true })
  }
})

test('refresh and verify actions answer in the requested locale', async () => {
  const { home, imageDir, ctx, captures } = setup()
  await new Promise((resolve) => setTimeout(resolve, 250))
  try {
    const refresh = captures.panel.actions.refresh({}, { locale: 'en-US' })
    assert.ok(refresh.pending && refresh.result)
    assert.deepEqual(await refresh.result(), { toast: 'Refreshed' })
    // The engine appended a call after the last scan. Verify refreshes first, so
    // the fresh comparison is consistent instead of a fake "diff" on stale rows.
    appendFileSync(
      join(home, 'sessions', 'proj', 'session-aaa', 'session.v4.jsonl.zstd'),
      z([call(3, 3, 30, 2700, 7)]),
    )
    const verify = captures.panel.actions.verify({}, { locale: 'en-US' })
    const effects = await verify.result()
    assert.match(effects[0].text, /^Verified · /)
    assert.ok([...effects[0].text].length <= 40)
    assert.equal(effects[1].data.lastVerify, effects[0].text)
    ctx._dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(imageDir, { recursive: true, force: true })
  }
})

test('image export is deferred and stays scoped to its chat', { skip: !canRender() && 'host has no python3 + Pillow' }, async () => {
  const { home, imageDir, ctx, captures } = setup()
  await new Promise((resolve) => setTimeout(resolve, 250))
  try {
    const exported = captures.panel.actions.export({ sessionId: 'session-aaa' }, { locale: 'zh-CN' })
    assert.ok(exported.pending && exported.result, 'slow work must use the deferred effect')
    const effects = await exported.result()
    const patch = effects.find((effect) => effect.type === 'patch')
    assert.match(patch.data.imageSrc, /^asset:usage-\d{8}-\d{6}-[a-z0-9]+\.png$/)
    const files = readdirSync(imageDir).filter((name) => name.endsWith('.png'))
    assert.equal(files.length, 1)
    const mine = pull(captures.panel.data, { sessionId: 'session-aaa' }, 'zh-CN')
    assert.equal(mine.imageSrc, patch.data.imageSrc, 'this chat shows its own card')
    const other = pull(captures.panel.data, { sessionId: 'session-bbb' }, 'zh-CN')
    assert.equal(other.imageSrc, 'asset:placeholder.png', 'another chat keeps the placeholder')
    ctx._dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(imageDir, { recursive: true, force: true })
  }
})

// ── H13: deferred results honour the bridge's abort signal ─────────────────

test('deferred actions stop as soon as the bridge aborts', async () => {
  const { home, imageDir, ctx, captures } = setup()
  await new Promise((resolve) => setTimeout(resolve, 250))
  try {
    const aborted = new AbortController()
    aborted.abort()
    const refresh = captures.panel.actions.refresh({}, { locale: 'en-US' })
    assert.deepEqual(await refresh.result(aborted.signal), [], 'aborted refresh returns nothing')
    const verify = captures.panel.actions.verify({}, { locale: 'en-US' })
    assert.deepEqual(await verify.result(aborted.signal), [], 'aborted verify returns nothing')
    const before = readdirSync(imageDir).filter((name) => name.endsWith('.png')).length
    const exported = captures.panel.actions.export({ sessionId: 'session-aaa' }, { locale: 'en-US' })
    assert.deepEqual(await exported.result(aborted.signal), [], 'aborted export returns nothing')
    assert.equal(readdirSync(imageDir).filter((name) => name.endsWith('.png')).length, before, 'aborted export must not render a card')
    const panel = pull(captures.panel.data, { sessionId: 'session-aaa' }, 'en-US')
    assert.equal(panel.lastVerify, 'Not verified', 'aborted verify must not store a result')
  } finally {
    ctx._dispose()
    rmSync(home, { recursive: true, force: true })
    rmSync(imageDir, { recursive: true, force: true })
  }
})

// ── H14: the per-chat image cache is bounded and forgets deleted files ─────

test('the image cache keeps at most 8 chats and drops files that are gone', { skip: !canRender() && 'host has no python3 + Pillow' }, async () => {
  const { home, imageDir, ctx, captures } = setup()
  try {
    const ids = []
    for (let i = 0; i < 10; i += 1) {
      const id = `session-${String(i).padStart(3, '0')}`
      ids.push(id)
      const dir = join(home, 'sessions', 'proj', id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'session.v4.jsonl.zstd'), z([header(id), call(1, 1, 10, 900, 5)]))
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
    const srcs = []
    for (const id of ids) {
      const exported = captures.panel.actions.export({ sessionId: id }, { locale: 'zh-CN' })
      const effects = await exported.result()
      const patch = effects.find((effect) => effect.type === 'patch')
      srcs.push(patch.data.imageSrc)
      assert.match(patch.data.imageSrc, /^asset:usage-\d{8}-\d{6}-[a-z0-9]+\.png$/)
    }
    for (const id of ids.slice(2)) {
      const mine = pull(captures.panel.data, { sessionId: id }, 'zh-CN')
      assert.notEqual(mine.imageSrc, 'asset:placeholder.png', `${id} should still show its card`)
    }
    for (const id of ids.slice(0, 2)) {
      const evicted = pull(captures.panel.data, { sessionId: id }, 'zh-CN')
      assert.equal(evicted.imageSrc, 'asset:placeholder.png', `${id} must fall off the 8-entry cache`)
    }
    const newest = ids[ids.length - 1]
    rmSync(join(imageDir, srcs[srcs.length - 1].slice('asset:'.length)))
    const gone = pull(captures.panel.data, { sessionId: newest }, 'zh-CN')
    assert.equal(gone.imageSrc, 'asset:placeholder.png', 'a deleted card file falls back to the placeholder')
  } finally {
    ctx._dispose()
    rmSync(home, { recursive: true, force: true })
    rmSync(imageDir, { recursive: true, force: true })
  }
})
