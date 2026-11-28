// Edge cases for the settlement fold: seeded prefixes, retries, replacements and
// the stream parser. These are the behaviours that produced wrong totals before,
// so each one is pinned down here.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { UsageLedger } from '../lib/ledger.js'
import { totalTokens } from '../lib/tally.js'

const NOW = new Date(2026, 10, 12, 12, 0, 0).getTime()
const SESSION = 'session-edge'

const usage = (input, cached, output, reasoning = 0) => ({ inputTokens: input, cacheReadTokens: cached, cacheWriteTokens: 0, outputTokens: output, reasoningTokens: reasoning })
const header = (extra = {}) => JSON.stringify({ type: 'session', version: 4, id: SESSION, createdAt: NOW, cwd: '/p', ...extra })
const message = (seq, turn, step, u, extra = {}) => JSON.stringify({ type: 'assistant/message', seq, time: NOW + seq * 1000, data: { turn, step, usage: u, stream: [], message: { source: { provider: 'p', model: 'm1' } }, ...extra } })
const messageNoUsage = (seq, turn, step, streamUsage) => JSON.stringify({ type: 'assistant/message', seq, time: NOW + seq * 1000, data: { turn, step, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: streamUsage } }], message: { source: { provider: 'p', model: 'm1' } } } })
const attempt = (seq, turn, step, us) => JSON.stringify({ type: 'assistant/attempt', seq, time: NOW + seq * 1000, data: { turn, step, stream: us.map((u) => ({ type: 'chunk', chunk: { type: 'usage', usage: u } })) } })
const retry = (seq, turn, step) => JSON.stringify({ type: 'llm/retry-started', seq, time: NOW + seq * 1000, data: { turn, step } })
const endSeed = (seq, inherited) => JSON.stringify({ type: 'session/end-seed', seq, time: NOW, data: inherited === undefined ? {} : { inherited } })
const noise = (seq) => JSON.stringify({ type: 'tool/result', seq, time: NOW, data: { text: 'x'.repeat(100) } })
const z = (lines, split) => {
  const text = lines.join('\n') + '\n'
  if (split === undefined) return zlib.zstdCompressSync(Buffer.from(text, 'utf8'))
  const frames = [text.slice(0, split), text.slice(split)].map((part) => zlib.zstdCompressSync(Buffer.from(part, 'utf8')))
  return Buffer.concat(frames)
}

/** Write one log and return the single record the ledger parsed. */
async function parseOne({ lines, name = 'session.v4.jsonl.zstd', bytes }) {
  const home = mkdtempSync(join(tmpdir(), 'fold-'))
  const dir = join(home, 'sessions', 'proj', SESSION)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), bytes ?? z(lines))
  const ledger = new UsageLedger({ home, now: () => NOW })
  await ledger.refresh()
  const rec = [...ledger.records.values()][0]
  ledger.dispose()
  rmSync(home, { recursive: true, force: true })
  assert.ok(rec, 'a record must be parsed')
  return rec
}
const tokensOf = (rec) => totalTokens(rec.totals)

test('seeded: inherited prefix is skipped, own calls are kept once', async () => {
  const rec = await parseOne({
    lines: [
      header({ isSeeded: true, parentSession: 'session-parent' }),
      message(0, 1, 1, usage(100, 1000, 10)),
      attempt(1, 1, 2, [usage(50, 500, 5)]),
      endSeed(2, true),
      message(3, 2, 1, usage(7, 70, 3)),
    ],
  })
  assert.equal(tokensOf(rec), 80)
  assert.equal(rec.totals.calls, 1)
  assert.equal(rec.isSeeded, true)
  assert.equal(rec.inheritedCut, 2)
})

test('seeded: a marker without inherited counts everything', async () => {
  const rec = await parseOne({
    lines: [
      header({ isSeeded: true }),
      message(0, 1, 1, usage(10, 100, 5)),
      endSeed(1),
      message(2, 2, 1, usage(7, 70, 3)),
    ],
  })
  assert.equal(tokensOf(rec), 115 + 80)
  assert.equal(rec.totals.calls, 2)
  assert.equal(rec.inheritedCut, -1)
})

test('seeded: a log truncated before its end marker is not counted twice', async () => {
  // 2026-11-25：seeded 头说明前缀属于父会话、父日志已经计过。前缀还没走完 end-seed
  // 就截断时，旧行为把整段再计一次（实测 115→230），且 recount 同规则不报差异。
  const rec = await parseOne({
    lines: [header({ isSeeded: true }), message(0, 1, 1, usage(10, 100, 5))],
  })
  assert.equal(tokensOf(rec), 0)
  assert.equal(rec.totals.calls, 0)
  assert.equal(rec.tornSeeded, true)
})

test('seeded: an own settlement sharing the inherited slot is not subtracted twice', async () => {
  const rec = await parseOne({
    lines: [
      header({ isSeeded: true }),
      message(0, 1, 1, usage(100, 1000, 10)),
      endSeed(1, true),
      message(2, 1, 1, usage(7, 70, 3)), // same turn+step as the inherited settlement
      message(3, 2, 1, usage(1, 10, 1)),
    ],
  })
  assert.equal(tokensOf(rec), 80 + 12)
  assert.equal(rec.totals.calls, 2)
  for (const bucket of Object.values(rec.days)) for (const value of Object.values(bucket)) assert.ok(value >= 0)
})

test('retry: the failed attempt and the retry are two calls', async () => {
  const rec = await parseOne({
    lines: [header(), attempt(1, 1, 1, [usage(3076, 182272, 1888)]), retry(2, 1, 1), message(3, 1, 1, usage(100, 1000, 10))],
  })
  assert.equal(tokensOf(rec), 187236 + 1110)
  assert.equal(rec.totals.calls, 2)
})

test('retry: settlement without a retry marker replaces the earlier one', async () => {
  const rec = await parseOne({
    lines: [header(), attempt(1, 1, 1, [usage(10, 100, 5)]), message(2, 1, 1, usage(20, 200, 6))],
  })
  assert.equal(tokensOf(rec), 226)
  assert.equal(rec.totals.calls, 1)
})

test('retry: an identical re-settlement is ignored', async () => {
  const rec = await parseOne({
    lines: [header(), message(1, 1, 1, usage(10, 100, 5)), message(2, 1, 1, usage(10, 100, 5))],
  })
  assert.equal(tokensOf(rec), 115)
  assert.equal(rec.totals.calls, 1)
})

test('retry: replacement across days and models leaves no negative buckets', async () => {
  const rec = await parseOne({
    lines: [
      header(),
      JSON.stringify({ type: 'assistant/message', seq: 1, time: NOW - 86_400_000, data: { turn: 1, step: 1, usage: usage(10, 100, 5), message: { source: { provider: 'a', model: 'old' } } } }),
      JSON.stringify({ type: 'assistant/message', seq: 2, time: NOW, data: { turn: 1, step: 1, usage: usage(20, 200, 6), message: { source: { provider: 'b', model: 'new' } } } }),
    ],
  })
  assert.equal(tokensOf(rec), 226)
  for (const bucket of Object.values(rec.days)) for (const value of Object.values(bucket)) assert.ok(value >= 0)
  for (const models of Object.values(rec.models)) for (const value of Object.values(models)) assert.ok(value >= 0)
})

test('settlements without turn+step are all counted (no replacement slot)', async () => {
  const rec = await parseOne({
    lines: [header(), message(1, undefined, undefined, usage(10, 100, 5)), message(2, undefined, undefined, usage(20, 200, 6))],
  })
  assert.equal(tokensOf(rec), 341)
  assert.equal(rec.totals.calls, 2)
})

test('a message without data.usage falls back to its last stream sample', async () => {
  const rec = await parseOne({ lines: [header(), messageNoUsage(1, 1, 1, usage(2, 20, 2))] })
  assert.equal(tokensOf(rec), 24)
})

test('a zero-token settlement adds no call', async () => {
  const rec = await parseOne({ lines: [header(), message(1, 1, 1, usage(0, 0, 0))] })
  assert.equal(rec.totals.calls, 0)
})

test('multi-frame zstd split inside a JSON line still parses the whole log', async () => {
  const lines = [header(), message(1, 1, 1, usage(10, 100, 5)), message(2, 2, 1, usage(7, 70, 3))]
  const text = lines.join('\n') + '\n'
  const split = text.indexOf('"assistant/message"') + 20 // mid-line byte split
  const rec = await parseOne({ bytes: z(lines, split) })
  assert.equal(tokensOf(rec), 195)
  assert.equal(rec.totals.calls, 2)
})

test('uncompressed log with a torn final line keeps the complete lines', async () => {
  const raw = [header(), message(1, 1, 1, usage(10, 100, 5)), '{"type":"assistant/message","seq":2,"time":'].join('\n')
  const rec = await parseOne({ bytes: Buffer.from(raw, 'utf8'), name: 'session.v4.jsonl' })
  assert.equal(tokensOf(rec), 115)
  assert.equal(rec.totals.calls, 1)
})

test('a log whose last line has no trailing newline still counts it', async () => {
  const raw = [header(), message(1, 1, 1, usage(10, 100, 5))].join('\n')
  const rec = await parseOne({ bytes: Buffer.from(raw, 'utf8'), name: 'session.v4.jsonl' })
  assert.equal(tokensOf(rec), 115)
})

test('a log without a header reads using the directory name and counts everything', async () => {
  const rec = await parseOne({ lines: [message(1, 1, 1, usage(10, 100, 5))] })
  assert.equal(rec.id, SESSION)
  assert.equal(tokensOf(rec), 115)
})

test('a seeded marker before any settlement works', async () => {
  const rec = await parseOne({
    lines: [header({ isSeeded: true }), endSeed(0, true), message(1, 1, 1, usage(10, 100, 5))],
  })
  assert.equal(tokensOf(rec), 115)
  assert.equal(rec.inheritedCut, 0)
})

test('a large single line does not break streaming', async () => {
  const big = JSON.stringify({ type: 'tool/result', seq: 1, time: NOW, data: { text: 'y'.repeat(2 * 1024 * 1024) } })
  const rec = await parseOne({ lines: [header(), big, message(2, 1, 1, usage(10, 100, 5))] })
  assert.equal(tokensOf(rec), 115)
})

test('a torn final zstd frame keeps the readable prefix and never crashes', async () => {
  const lines = [header(), message(1, 1, 1, usage(10, 100, 5)), message(2, 2, 1, usage(7, 70, 3))]
  // 2026-11-28 审查 P2-4：原来拼接的是「整帧链的第 base.length 字节起的一截」，等于把
  // 第二帧从中间切开，并不是「第二帧从头被截断」。这里把第二帧单独压缩再截。
  const firstFrame = z(lines.slice(0, 2)) // header + 115 tokens
  const secondFrame = z(lines.slice(2)) // 80 tokens, 自己的帧
  const fullTotal = tokensOf(await parseOne({ bytes: Buffer.concat([firstFrame, secondFrame]) }))
  assert.equal(fullTotal, 195)
  let sawPrefix = false
  for (let cut = 1; cut < secondFrame.length; cut += Math.max(1, Math.floor(secondFrame.length / 16))) {
    const home = mkdtempSync(join(tmpdir(), 'fold-torn-'))
    const dir = join(home, 'sessions', 'proj', SESSION)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([firstFrame, secondFrame.subarray(0, cut)]))
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    const rec = [...ledger.records.values()][0]
    const total = rec === undefined ? 0 : totalTokens(rec.totals)
    assert.ok(Number.isFinite(total), `cut ${cut}`)
    // 截断帧要么整帧读不到（0），要么只保留前一个完整帧的 115；绝不能超过完整总数。
    assert.ok(total === 0 || total === 115, `cut ${cut}: ${total}`)
    if (total === 115) {
      sawPrefix = true
      assert.equal(rec.partial, true, `cut ${cut}: the partial read is disclosed`)
    }
    ledger.dispose()
    rmSync(home, { recursive: true, force: true })
  }
  assert.ok(sawPrefix, 'at least one truncation point keeps the readable prefix')
})

test('the header is recognised regardless of its key order', async () => {
  const customHeader = JSON.stringify({ version: 4, isSeeded: true, id: SESSION, createdAt: NOW, cwd: '/p', type: 'session' })
  const rec = await parseOne({
    lines: [customHeader, message(0, 1, 1, usage(100, 1000, 10)), endSeed(1, true), message(2, 2, 1, usage(7, 70, 3))],
  })
  assert.equal(rec.id, SESSION)
  assert.equal(rec.isSeeded, true)
  assert.equal(rec.inheritedCut, 1)
  assert.equal(tokensOf(rec), 80)
})
