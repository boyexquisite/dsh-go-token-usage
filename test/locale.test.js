// Locale / caption / verify-note contracts shared by the panel and the image.
//
// These tests use fake ledger objects on purpose: the shapes below are the
// contract with ledger-audit's sourceState()/compareRecount() fields
// (unavailableDirs, cacheDropped, skippedDirs) and must stay stable even while
// the real ledger is being changed in parallel.
import test from 'node:test'
import assert from 'node:assert/strict'
import { historyNote, imagePanelData, sourceLabel, verifyLine, words } from '../lib/view.js'

const totals = (input = 0, cached = 0, cacheWrite = 0, output = 0, calls = 0) => ({
  input, cached, cacheWrite, output, reasoning: 0, calls,
})

function fakeLedger(state = {}, comparison = {}) {
  const fullState = {
    scanned: true,
    logFiles: 2,
    rootMissing: false,
    lostFiles: 0,
    unavailableDirs: 0,
    errors: 0,
    scanErrors: 0,
    emptyLogs: 0,
    oversizedLogs: 0,
    cacheDamaged: false,
    cacheDenied: false,
    cacheDropped: 0,
    ...state,
  }
  const fullComparison = {
    shownTotals: totals(6000, 90, 0, 10, 3),
    recountTotals: totals(6000, 90, 0, 10, 3),
    pendingTotals: totals(),
    lostTokens: 0,
    lostCalls: 0,
    lostFiles: 0,
    unexplainedTokens: 0,
    unexplainedCalls: 0,
    skippedDirs: 0,
    lagging: 0,
    ...comparison,
  }
  return { sourceState: () => fullState, compareRecount: () => fullComparison }
}

const len = (text) => [...text].length

test('historyNote: unreadable dirs and dropped cache records get their own honest line', () => {
  assert.equal(historyNote(fakeLedger({ unavailableDirs: 2 }), 'zh-CN'), '2 个目录读不了，新日志可能没计入')
  assert.equal(historyNote(fakeLedger({ unavailableDirs: 2 }), 'en-US'), '2 dir(s) unreadable — new logs may be missing')
  assert.equal(historyNote(fakeLedger({ cacheDropped: 3 }), 'zh-CN'), '3 条缓存记录损坏，历史可能不全')
  assert.equal(historyNote(fakeLedger({ cacheDropped: 3 }), 'en-US'), '3 cache record(s) corrupt — history may be incomplete')
  // A vanished log is the bigger story; it keeps priority over both new lines.
  assert.equal(historyNote(fakeLedger({ lostFiles: 1, unavailableDirs: 2, cacheDropped: 3 }), 'zh-CN'), '1 个日志已不存在，历史按缓存保留')
  // Healthy / unscanned states are unchanged.
  assert.equal(historyNote(fakeLedger(), 'zh-CN'), '')
  assert.equal(historyNote(fakeLedger({ scanned: false }), 'zh-CN'), '')
})

test('verifyLine names skipped dirs inside the 40-char toast budget', () => {
  const line = verifyLine(fakeLedger({}, { skippedDirs: 2 }), undefined, 'zh-CN')
  assert.ok(line.startsWith('核对：一致'), line)
  assert.ok(line.includes('2 处读不了'), line)
  assert.ok(len(line) <= 40, `${len(line)}: ${line}`)
  const en = verifyLine(fakeLedger({}, { skippedDirs: 2 }), undefined, 'en-US')
  assert.ok(en.includes('2 dir(s) unreadable'), en)
  assert.ok(len(en) <= 40, `${len(en)}: ${en}`)
  // Never returns a number cut by the budget.
  const long = verifyLine(fakeLedger({}, { skippedDirs: 1234, lostFiles: 99 }), undefined, 'zh-CN')
  assert.ok(len(long) <= 40, `${len(long)}: ${long}`)
  assert.ok(!long.includes('…'), 'the toast budget must drop segments, not cut them')
})

test('imagePanelData rebuilds the caption in the current locale', () => {
  const image = {
    src: 'asset:usage-20260101-000000.png',
    aspect: 0.66,
    caption: '今日 4.02k tokens · 命中率 90%',
    tokens: '4.02k',
    hit: '90%',
  }
  assert.equal(imagePanelData(image, 'zh-CN').imageCaption, '今日 4.02k tokens · 命中率 90%')
  assert.equal(imagePanelData(image, 'en-US').imageCaption, 'Today 4.02k tokens · Hit rate 90%')
  // Old stored image objects (caption only) still render their caption.
  assert.equal(imagePanelData({ src: image.src, aspect: image.aspect, caption: '旧语言' }, 'en-US').imageCaption, '旧语言')
  // The placeholder keeps following the locale.
  assert.match(imagePanelData(null, 'en-US').imageCaption, /Generate image/)
})

test('unknown locales fall back to Chinese, matching the manifest fallback', () => {
  // The manifest resolves fr-FR to English, but the panel has always shown zh for
  // anything that is not en*; we keep zh (a documented, deliberate choice) and
  // this test makes the behaviour explicit instead of accidental.
  assert.equal(words('fr-FR').today, '今日')
  assert.equal(words('').today, '今日')
  assert.equal(words(undefined).today, '今日')
  assert.equal(words('en-GB').today, 'Today')
  assert.equal(words('EN-us').today, 'Today')
  assert.equal(sourceLabel('custom-', 'zh-CN'), '未知来源')
  assert.equal(sourceLabel('custom-', 'en-US'), 'unknown source')
})
