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

test('usageView: five aligned cards in the requested order', async () => {
  const home = homeWithLog()
  const ledger = new UsageLedger({ home, now: () => NOW })
  await ledger.refresh()
  try {
    const chat = usageView({ sessionId: 'session-aaa' }, { locale: 'zh-CN' })
    assert.equal(chat.v, 2)
    assert.equal(chat.children[0].type, 'stack', 'the first thing is the first card, not a note')
    const cards = sections(chat)
    assert.deepEqual(cards.map((c) => c.children[0].spans[0].text), ['累计', '本对话', '今日', '近 7 天', '近 30 天'])
    assert.deepEqual(cards.map((c) => c.style.background), ['blue', 'green', 'orange', 'teal', 'violet'])
    assert.equal(new Set(cards.map((c) => c.style.background)).size, 5)
    for (const card of cards) {
      assert.equal(card.style.card, 'tinted')
      assert.equal(card.style.padding, 'M')
      const headline = card.children[0]
      assert.equal(headline.style.size, 'subtitle')
      assert.ok(headline.spans.some((span) => typeof span.text === 'string' && span.text.includes('tokens')))
      const kv = card.children.find((c) => c.type === 'keyValue')
      const labels = kv.items.map((item) => item.label)
      // Every card starts with the same four aligned rows.
      assert.deepEqual(labels.slice(0, 4), ['命中率', '调用（次）', '输入合计', '输出'])
      assert.ok(kv.items.every((item) => item.value.$ !== undefined))
    }
    const todayList = cards[2].children.find((c) => c.type === 'list')
    assert.deepEqual(todayList.items, { $: 'data.models' })
    const week = cards[3]
    assert.deepEqual(week.children[1].items.map((i) => i.label).slice(4), ['日均', '覆盖天数（天）'])
    assert.equal(collect(week, 'chart').length, 1)
    const month = cards[4]
    const monthLabels = month.children[1].items.map((i) => i.label)
    assert.deepEqual(monthLabels.slice(4), ['日均', '覆盖天数（天）', '未缓存输入', '缓存读取', '缓存写入', '其中推理'])
    assert.ok(month.children[1].items.length <= 24)
    assert.equal(collect(chat, 'row').length, 0)
    assert.equal(collect(chat, 'metric').length, 0)
    assert.ok(JSON.stringify(chat).length < 32 * 1024)

    const features = usageView({}, { locale: 'en-US' })
    assert.deepEqual(sections(features).map((c) => c.children[0].spans[0].text), ['All time', 'Today', 'Last 7 days', 'Last 30 days'])
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
    assert.equal(data.models[0].subtitle, '第三方 · p')
    assert.equal(data.models[0].trailing, '6.09k')
    assert.ok(data.updated.startsWith('已更新'))
  } finally {
    ledger.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('cards keep values as bindings and units out of the numbers', async () => {
  const home = homeWithLog()
  const ledger = new UsageLedger({ home, now: () => NOW })
  await ledger.refresh()
  try {
    const chat = usageView({ sessionId: 'session-aaa' }, { locale: 'zh-CN' })
    const items = collect(chat, 'keyValue').flatMap((kv) => kv.items)
    assert.ok(items.every((item) => typeof item.value === 'object' && item.value.$ !== undefined))
    assert.ok(items.some((item) => item.label === '未缓存输入'))
    assert.ok(items.some((item) => item.label === '输入合计'), 'uncached input must not look like all the input')
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
