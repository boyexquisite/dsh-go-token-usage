import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, cpSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { UsageLedger } from '../lib/ledger.js'
import { totalTokens } from '../lib/tally.js'
import { historyNote, stripData, summaryText, turnNoteData, usageData, usageView, verifyLine } from '../lib/view.js'

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
      assert.equal(headline.style.size, 'body')
      assert.ok(headline.spans.some((span) => typeof span.text === 'string' && span.text.includes('tokens')))
      const kv = card.children.find((c) => c.type === 'keyValue')
      const labels = kv.items.map((item) => item.label)
      // Every card starts with the same four aligned rows.
      assert.deepEqual(labels.slice(0, 4), ['命中率', '调用（次）', '输入合计', '输出'])
      assert.ok(kv.items.every((item) => item.value.$ !== undefined))
    }
    const todayTable = cards[2].children.find((c) => c.type === 'table')
    assert.deepEqual(todayTable.rows, { $: 'data.modelRows' })
    assert.deepEqual(todayTable.columns.map((c) => (typeof c === 'string' ? c : c.label)), ['模型', '来源', 'tokens'])
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
    assert.deepEqual(data.modelRows[0], ['m1', '第三方 p', '6.09k'])
    assert.ok(data.updated.startsWith('已更新'))
    assert.equal(data.lastVerify, '未核对')
    ledger.verifyNote = '核对：一致 · 6.09k · 3 次'
    assert.equal(usageData(ledger, { sessionId: 'session-aaa' }, 'zh-CN').lastVerify, '核对：一致 · 6.09k · 3 次')
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
    // The model line must name the model and its token count, not the provider/—
    assert.ok(text.includes('- m1: 6.09k'), text)
    assert.ok(!text.includes('—'), text)
  } finally {
    ledger.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('cache hit rate shows an em dash when the provider omits cache counters', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-nocache-'))
  try {
    const dir = join(home, 'sessions', 'proj', 'session-ccc')
    mkdirSync(dir, { recursive: true })
    const header = JSON.stringify({ type: 'session', version: 4, id: 'session-ccc', createdAt: NOW, cwd: '/p' })
    const event = JSON.stringify({
      type: 'assistant/message', seq: 0, time: NOW,
      data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 10 }, message: { source: { provider: 'relay-x', model: 'm' } } },
    })
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from([header, event].join('\n') + '\n', 'utf8')))
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    assert.equal(ledger.cacheKnown(), false)
    const data = usageData(ledger, { sessionId: 'session-ccc' }, 'zh-CN')
    assert.equal(data.today.hit, '—')
    const notes = turnNoteData(ledger, { sessionId: 'session-ccc' }, 'zh-CN')
    assert.equal(notes['1'].text, '110')
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the panel explains a vanished log instead of showing zero history', async () => {
  const home = homeWithLog()
  const ledger = new UsageLedger({ home, now: () => NOW })
  await ledger.refresh()
  const file = join(home, 'sessions', 'proj', 'session-aaa', 'session.v4.jsonl.zstd')
  rmSync(file)
  try {
    await ledger.refresh()
    const data = usageData(ledger, { sessionId: 'session-aaa' }, 'zh-CN')
    assert.equal(data.all.total, '6.09k', 'the numbers read from that log stay counted')
    assert.equal(data.historyNote, '1 个日志已不存在，历史按缓存保留')
    assert.ok(data.updated.includes('历史按缓存保留'), data.updated)
    assert.match(usageData(ledger, {}, 'en-US').historyNote, /log\(s\) gone/)
    // Verify must not call this a mismatch: the log is gone, not the number wrong.
    const line = verifyLine(ledger, await ledger.recount(), 'zh-CN')
    assert.ok(line.startsWith('核对：一致'), line)
    assert.ok(line.includes('1 个日志已丢失'), line)
  } finally {
    ledger.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('a host with no logs at all says so; a healthy host says nothing extra', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'dsh-bare-'))
  try {
    mkdirSync(join(bare, 'sessions', 'proj'), { recursive: true })
    const ledger = new UsageLedger({ home: bare, now: () => NOW })
    await ledger.refresh()
    const data = usageData(ledger, {}, 'zh-CN')
    assert.equal(data.historyNote, '本机没有会话日志，只含实时调用')
    assert.ok(data.updated.includes('只含实时调用'))
    ledger.dispose()
  } finally {
    rmSync(bare, { recursive: true, force: true })
  }

  // A host where the sessions root cannot be read at all gets its own wording.
  const noRoot = mkdtempSync(join(tmpdir(), 'dsh-noroot-view-'))
  const orphan = new UsageLedger({ home: noRoot, now: () => NOW })
  await orphan.refresh()
  try {
    assert.equal(usageData(orphan, {}, 'zh-CN').historyNote, '找不到会话日志目录，历史不可用')
    assert.equal(usageData(orphan, {}, 'en-US').historyNote, 'No session log folder — history unavailable')
  } finally {
    orphan.dispose()
    rmSync(noRoot, { recursive: true, force: true })
  }

  const home = homeWithLog()
  const ledger = new UsageLedger({ home, now: () => NOW })
  await ledger.refresh()
  try {
    const data = usageData(ledger, {}, 'zh-CN')
    assert.equal(data.historyNote, '')
    assert.ok(data.updated.startsWith('已更新'))
    assert.ok(!data.updated.includes('·'))
  } finally {
    ledger.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('verifyLine: a live call the log already holds is not a diff', async () => {
  // The engine can persist a settlement before the next scan folds it. The panel
  // counts it as a live entry, the recount counts it in the log: still one call,
  // so Verify must not report the pending tokens as a difference.
  const home = homeWithLog()
  const ledger = new UsageLedger({ home, now: () => NOW })
  await ledger.refresh()
  try {
    appendFileSync(
      join(home, 'sessions', 'proj', 'session-aaa', 'session.v4.jsonl.zstd'),
      zlib.zstdCompressSync(Buffer.from(call(4, 4, 40, 4000, 20) + '\n', 'utf8')),
    )
    ledger.noteLive('session-aaa', 4, NOW, { input: 40, cached: 4000, cacheWrite: 0, output: 20, reasoning: 0, calls: 1 }, 'm1', 4, 'p')
    const recount = await ledger.recount()
    const comparison = ledger.compareRecount(recount)
    assert.equal(comparison.unexplainedTokens, 0, JSON.stringify(comparison))
    assert.equal(comparison.unexplainedCalls, 0)
    assert.equal(comparison.pendingTotals.calls, 1)
    assert.ok(verifyLine(ledger, recount, 'zh-CN').startsWith('核对：一致'))
    assert.ok(verifyLine(ledger, recount, 'en-US').startsWith('Verified'))
  } finally {
    ledger.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('verifyLine: consistent, pending live calls, and the plain diff', async () => {
  const home = homeWithLog()
  const ledger = new UsageLedger({ home, now: () => NOW })
  await ledger.refresh()
  try {
    assert.equal(verifyLine(ledger, await ledger.recount(), 'zh-CN'), '核对：一致 · 6.09k · 3 次')
    // A live call the file has not caught up with is accounted for, not a mismatch.
    ledger.noteLive('session-aaa', 99, NOW, { input: 1, cached: 10, cacheWrite: 0, output: 1, reasoning: 0, calls: 1 }, 'm1', 4, 'p')
    assert.equal(verifyLine(ledger, await ledger.recount(), 'zh-CN'), '核对：一致 · 6.1k · 4 次')
    assert.ok(verifyLine(ledger, await ledger.recount(), 'en-US').startsWith('Verified'))
    // A genuine mismatch inside a readable log is still reported as a diff.
    const rec = [...ledger.records.values()][0]
    rec.days[Object.keys(rec.days)[0]].input += 1000
    rec.totals.input += 1000
    assert.equal(verifyLine(ledger, await ledger.recount(), 'zh-CN'), '核对：差 1k tokens')
  } finally {
    ledger.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

function homeWithTwoChats() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mixed-'))
  const mk = (id, lines) => {
    const dir = join(home, 'sessions', 'proj', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8')))
  }
  const official = (provider, model, u) => JSON.stringify({
    type: 'assistant/message', seq: 1, time: NOW,
    data: { turn: 1, step: 1, usage: u, message: { source: { provider, model } } },
  })
  mk('session-aaa', [JSON.stringify({ type: 'session', version: 4, id: 'session-aaa', createdAt: NOW, cwd: '/p' }),
    official('deepseek-account', 'm1', { inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0, outputTokens: 5 })])
  mk('session-ccc', [JSON.stringify({ type: 'session', version: 4, id: 'session-ccc', createdAt: NOW, cwd: '/p' }),
    official('custom-relay', 'm2', { inputTokens: 100, outputTokens: 10 })])
  return home
}

test('cache hit rate is per chat: a relay chat shows a dash on a mixed host', async () => {
  const home = homeWithTwoChats()
  const ledger = new UsageLedger({ home, now: () => NOW })
  await ledger.refresh()
  try {
    const official = usageData(ledger, { sessionId: 'session-aaa' }, 'zh-CN')
    const relay = usageData(ledger, { sessionId: 'session-ccc' }, 'zh-CN')
    assert.equal(official.session.hit, '90%')
    assert.equal(relay.session.hit, '—', 'relay chat must not read as a 0% cache hit rate')
    assert.match(relay.all.hit, /^≈\d/, 'a mixed ledger shows an approximate rate, not a fake 0%')
    assert.match(relay.today.hit, /^≈\d/)
    const relayNotes = turnNoteData(ledger, { sessionId: 'session-ccc' }, 'zh-CN')
    assert.equal(relayNotes['1'].text, '110', 'no fabricated hit rate on its turn note')
    const officialNotes = turnNoteData(ledger, { sessionId: 'session-aaa' }, 'zh-CN')
    assert.match(officialNotes['1'].text, /命中90%/)
    assert.ok(summaryText(ledger, { sessionId: 'session-ccc' }, 'zh-CN').includes('命中率 ≈'))
  } finally {
    ledger.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('dynamic panel strings follow the locale', async () => {
  const home = homeWithLog()
  const ledger = new UsageLedger({ home, now: () => NOW })
  await ledger.refresh()
  try {
    const en = usageData(ledger, { sessionId: 'session-aaa' }, 'en-US')
    assert.match(en.updated, /^Updated /)
    assert.equal(en.lastVerify, 'Not verified')
    const zh = usageData(ledger, { sessionId: 'session-aaa' }, 'zh-CN')
    assert.match(zh.updated, /^已更新 /)
    assert.equal(zh.lastVerify, '未核对')
  } finally {
    ledger.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('turn notes stay inside 16 characters even with huge numbers', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-huge-'))
  try {
    const dir = join(home, 'sessions', 'proj', 'session-huge')
    mkdirSync(dir, { recursive: true })
    const big = { inputTokens: 1, cacheReadTokens: 1_250_000_000_000, cacheWriteTokens: 0, outputTokens: 1 }
    const event = JSON.stringify({
      type: 'assistant/message', seq: 1, time: NOW,
      data: { turn: 1, step: 1, usage: big, message: { source: { provider: 'p', model: 'm1' } } },
    })
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from([JSON.stringify({ type: 'session', version: 4, id: 'session-huge', createdAt: NOW, cwd: '/p' }), event].join('\n') + '\n')))
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    for (const locale of ['zh-CN', 'en-US']) {
      const notes = turnNoteData(ledger, { sessionId: 'session-huge' }, locale)
      for (const note of Object.values(notes)) assert.ok([...note.text].length <= 16, `${locale}: ${note.text}`)
    }
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('verify names lost history instead of a fake token diff', async () => {
  const { home, file } = (() => {
    const h = mkdtempSync(join(tmpdir(), 'dsh-lost-verify-'))
    const dir = join(h, 'sessions', 'proj', 'session-aaa')
    mkdirSync(dir, { recursive: true })
    return { home: h, file: join(dir, 'session.v4.jsonl.zstd') }
  })()
  const moved = mkdtempSync(join(tmpdir(), 'dsh-lost-moved-'))
  try {
    writeFileSync(file, zlib.zstdCompressSync(Buffer.from([header, call(1, 1, 10, 100, 5), call(2, 2, 20, 200, 6)].join('\n') + '\n')))
    const first = new UsageLedger({ home, now: () => NOW })
    await first.refresh()
    first.dispose()
    // The moved home keeps the cache but only a shorter copy of the log exists.
    cpSync(join(home, 'sessions'), join(moved, 'sessions'), { recursive: true })
    cpSync(join(home, 'cache'), join(moved, 'cache'), { recursive: true })
    writeFileSync(join(moved, 'sessions', 'proj', 'session-aaa', 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from([header, call(1, 1, 10, 100, 5)].join('\n') + '\n')))
    const ledger = new UsageLedger({ home: moved, now: () => NOW })
    await ledger.refresh()
    assert.equal(totalTokens(ledger.allTime()), 341, 'cached history is kept')
    const line = verifyLine(ledger, await ledger.recount(), 'zh-CN')
    assert.ok(line.startsWith('核对：一致'), line)
    assert.ok(line.includes('1 个日志已丢失'), line)
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(moved, { recursive: true, force: true })
  }
})

test('verify skips when the sessions root is gone', async () => {
  const home = homeWithLog()
  const ledger = new UsageLedger({ home, now: () => NOW })
  await ledger.refresh()
  try {
    rmSync(join(home, 'sessions'), { recursive: true, force: true })
    await ledger.refresh()
    const line = verifyLine(ledger, await ledger.recount(), 'zh-CN')
    assert.equal(line, '核对：跳过（找不到会话日志目录）')
    assert.equal(verifyLine(ledger, await ledger.recount(), 'en-US'), 'Verify skipped: no session log folder')
  } finally {
    ledger.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('historyNote mentions logs it could not read', async () => {
  const home = homeWithLog()
  const brokenDir = join(home, 'sessions', 'proj', 'session-broken')
  try {
    mkdirSync(brokenDir, { recursive: true })
    writeFileSync(join(brokenDir, 'session.v4.jsonl.zstd'), Buffer.from('not a zstd frame at all'))
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    assert.equal(ledger.sourceState().scanErrors, 1)
    assert.equal(historyNote(ledger, 'zh-CN'), '1 个日志读不了，统计可能偏少')
    assert.match(historyNote(ledger, 'en-US'), /unreadable/)
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a chat with no ledger record shows dashes instead of zeros', async () => {
  const home = homeWithLog()
  const ledger = new UsageLedger({ home, now: () => NOW })
  await ledger.refresh()
  try {
    const data = usageData(ledger, { sessionId: 'session-unknown' }, 'zh-CN')
    assert.equal(data.session.total, '—')
    assert.equal(data.session.calls, '—')
    assert.equal(data.session.output, '—')
  } finally {
    ledger.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})
