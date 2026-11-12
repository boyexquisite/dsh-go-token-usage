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
  if (node.type === type) out.push(node)
  for (const value of Object.values(node)) collect(value, type, out)
  return out
}

test('usageView: panel renders in a chat and in All features', async () => {
  const home = homeWithLog()
  const ledger = new UsageLedger({ home, now: () => NOW })
  await ledger.refresh()
  try {
    const chat = usageView({ sessionId: 'session-aaa' }, { locale: 'zh-CN' })
    assert.equal(chat.type, 'stack')
    assert.equal(collect(chat, 'panel').length, 0)
    assert.equal(collect(chat, 'metric').length >= 6, true)
    const labels = collect(chat, 'metric').map((m) => m.label)
    assert.ok(labels.includes('今日'))
    assert.ok(labels.includes('总量'))
    assert.ok(collect(chat, 'text').some((t) => t.text.includes('缓存（近 30 天）')))
    assert.ok(collect(chat, 'text').some((t) => t.text.includes('单位 tokens')))
    // 未缓存输入和输入合计必须分开展示，避免把「未缓存输入」看成全部输入
    const keys = collect(chat, 'keyValue').flatMap((kv) => kv.items.map((row) => row[0]))
    assert.ok(keys.includes('近 30 天'))
    assert.ok(keys.includes('未缓存输入'))
    assert.ok(keys.includes('输入合计'))
    assert.ok(keys.includes('其中推理'))
    assert.ok(collect(chat, 'chart').length === 1)
    assert.equal(collect(chat, 'chart')[0].kind, 'bar')

    const features = usageView({}, { locale: 'en-US' })
    assert.ok(collect(features, 'metric').map((m) => m.label).includes('Today'))
    assert.ok(collect(features, 'text').some((t) => t.text === 'All time'))
    assert.ok(collect(features, 'metric').map((m) => m.label).includes('Total'))

    const json = JSON.stringify(chat)
    assert.ok(json.length < 32 * 1024, 'panel view stays under the 32 KiB budget')
  } finally {
    ledger.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('usageData: windows, chart series and models are filled from the log', async () => {
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
    assert.equal(data.models[0].title, 'm1')
    assert.equal(data.month.hit, '99%')
    assert.equal(data.month.days, '1') // every call in this fixture is "today"
    assert.equal(data.month.daily, '6.09k') // average over the days that have calls
    assert.ok(data.updated.startsWith('已更新'))
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
