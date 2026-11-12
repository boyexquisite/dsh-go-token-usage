import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { UsageLedger } from '../lib/ledger.js'
import { stripData, summaryText, turnNoteData, usageData, usageView } from '../lib/view.js'

const NOW = new Date(2026, 10, 12, 12, 0, 0).getTime()
const header = JSON.stringify({ type: 'session', version: 4, id: 'session-aaa', createdAt: NOW, cwd: '/p' })
const call = (seq, turn, input, cached, output) =>
  JSON.stringify({
    type: 'assistant/message',
    seq,
    time: NOW - (10 - turn) * 60_000,
    data: {
      turn,
      step: 1,
      usage: { inputTokens: input, cacheReadTokens: cached, cacheWriteTokens: 0, outputTokens: output, totalTokens: input + cached + output },
      message: { source: { provider: 'p', model: 'm1' } },
    },
  })

function homeWithLog() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-view-'))
  const dir = join(home, 'sessions', 'proj', 'session-aaa')
  mkdirSync(dir, { recursive: true })
  const lines = [header]
  for (let turn = 1; turn <= 3; turn++) lines.push(call(turn, turn, 10 * turn, 1000 * turn, 5 * turn))
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8')))
  return home
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

const sections = (view) => view.children.filter((c) => c.type === 'stack')

test('usageView: five coloured cards in the requested order, no top annotation', async () => {
  const home = homeWithLog()
  const ledger = new UsageLedger({ home, now: () => NOW })
  await ledger.refresh()
  try {
    const chat = usageView({ sessionId: 'session-aaa' }, { locale: 'zh-CN' })
    assert.equal(chat.v, 2)
    assert.equal(chat.children[0].type, 'stack', 'the first thing is the first card, not a note')
    assert.deepEqual(sections(chat).map((c) => c.children[0].children[0].text), ['累计', '本对话', '今日', '近 7 天', '近 30 天'])
    const colors = sections(chat).map((c) => c.style.background)
    assert.deepEqual(colors, ['blue', 'green', 'orange', 'teal', 'violet'])
    assert.equal(new Set(colors).size, 5)
    for (const card of sections(chat)) {
      assert.equal(card.style.card, 'tinted')
      assert.equal(card.style.padding, 'S')
      const rows = card.children.filter((c) => c.type === 'row')
      assert.equal(rows[0].children.length, 2, 'title and total share one row')
      assert.equal(rows[1].children.length, 2, 'hit rate and calls sit side by side')
      assert.ok(rows.every((r) => r.style.columns[0] === 1 && r.style.columns[1] === 1))
    }
    assert.equal(collect(chat, 'chart').length, 1)
    assert.equal(collect(chat, 'metric').length, 15)
    assert.equal(collect(chat, 'list').length, 0, 'models are one compact line, not a list')
    assert.ok(JSON.stringify(chat).length < 32 * 1024)

    const features = usageView({}, { locale: 'en-US' })
    assert.deepEqual(sections(features).map((c) => c.children[0].children[0].text), ['All time', 'Today', 'Last 7 days', 'Last 30 days'])
    assert.ok(collect(features, 'metric').length === 12)
  } finally {
    ledger.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('usageData: windows, averages over days with calls, chart series and models', async () => {
  const home = homeWithLog()
  const ledger = new UsageLedger({ home, now: () => NOW })
  await ledger.refresh()
  try {
    const data = usageData(ledger, { sessionId: 'session-aaa' })
    assert.equal(data.chart.values.length, 7)
    assert.equal(data.chart.values.at(-1), 6090)
    assert.equal(data.chart.labels.at(-1), '11/12')
    assert.equal(data.session.total, '6.09k')
    assert.equal(data.session.inputTotal, '6.06k')
    assert.equal(data.session.calls, '3')
    assert.equal(data.session.reasoning, '—') // engine reported no reasoning tokens
    assert.equal(data.month.hit, '99%')
    assert.equal(data.month.days, '1') // every call in this fixture is "today"
    assert.equal(data.month.daily, '6.09k') // average over the days that have calls
    assert.equal(data.week.days, '1')
    assert.equal(data.models[0].title, 'm1')
    assert.ok(data.modelsLine.includes('m1'))
    assert.ok(data.updated.startsWith('已更新'))
  } finally {
    ledger.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('breakdowns stay in the panel and keep units out of the numbers', async () => {
  const home = homeWithLog()
  const ledger = new UsageLedger({ home, now: () => NOW })
  await ledger.refresh()
  try {
    const chat = usageView({ sessionId: 'session-aaa' }, { locale: 'zh-CN' })
    const keys = collect(chat, 'keyValue').flatMap((kv) => kv.items.map((row) => row[0]))
    const spanTexts = collect(chat, 'text').flatMap((t) => (t.spans ?? []).map((sp) => sp.text)).filter((v) => typeof v === 'string')
    assert.ok(keys.includes('未缓存输入'))
    assert.ok(keys.includes('输入合计'), 'uncached input must not look like all the input')
    assert.ok(spanTexts.some((text) => text.includes('输入合计')), 'the inline line labels the input total')
    assert.ok(spanTexts.some((text) => text.includes('覆盖天数')))
    assert.ok(spanTexts.some((text) => text.includes('日均')))
    assert.ok(keys.includes('其中推理'))
    const metrics = collect(chat, 'metric')
    assert.ok(metrics.every((m) => typeof m.value === 'object' && m.value.$ !== undefined))
  } finally {
    ledger.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('strip and turn notes stay inside the protocol limits', async () => {
  const home = homeWithLog()
  const ledger = new UsageLedger({ home, now: () => NOW })
  await ledger.refresh()
  try {
    for (const locale of ['zh-CN', 'en-US']) {
      const strip = stripData(ledger, { sessionId: 'session-aaa' }, locale)
      assert.ok([...strip.text].length <= 24, `${locale} strip: ${strip.text}`)
      assert.equal(strip.icon, 'chart')
    }
    const notes = turnNoteData(ledger, { sessionId: 'session-aaa' }, 'zh-CN')
    assert.deepEqual(Object.keys(notes).sort(), ['1', '2', '3'])
    for (const note of Object.values(notes)) {
      assert.ok([...note.text].length <= 16, `note: ${note.text}`)
      assert.equal(note.tone, 'muted')
    }
    const text = summaryText(ledger, { sessionId: 'session-aaa' }, 'zh-CN')
    assert.ok(text.includes('本对话'))
    assert.ok(text.includes('近 30 天'))
  } finally {
    ledger.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})
