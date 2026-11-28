// 2026-11-28 第 1 轮修复的回归测试：统计口径（跨日归桶、同槽重结算、部分缓存命中率、
// 溢出）、跨实例并发保存、缓存目录/硬链接边界、跳过原因的可见性。
// 每条都对应审查报告里的一条发现；旧实现在这些断言下会失败（见每条的注释）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { UsageLedger } from '../lib/ledger.js'
import { hitRateText } from '../lib/view.js'
import { dayKey, totalTokens } from '../lib/tally.js'

const NOW = new Date(2026, 10, 12, 12, 0, 0).getTime() // 2026-11-12 12:00 local
const DAY = 24 * 60 * 60 * 1000
const SESSION = 'session-aaa'
const POSIX = process.platform !== 'win32'

const header = (id = SESSION) => JSON.stringify({ type: 'session', version: 4, id, createdAt: NOW, cwd: '/p' })
/** A settlement; `cache` false leaves the cache counters out, like a relay that omits them. */
const call = (seq, { time = NOW, turn = 1, step = 1, input = 10, cached = 100, output = 5, model = 'm1', cache = true } = {}) => {
  const usage = { inputTokens: input, outputTokens: output }
  if (cache) {
    usage.cacheReadTokens = cached
    usage.cacheWriteTokens = 0
  }
  return JSON.stringify({
    type: 'assistant/message',
    seq,
    time,
    data: { turn, step, usage, message: { source: { model, provider: 'p' } } },
  })
}
const retryStarted = (seq, turn, step) => JSON.stringify({ type: 'llm/retry-started', seq, time: NOW, data: { turn, step, retryId: 'r1' } })
const frame = (lines) => zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'))

function makeHome() {
  const root = mkdtempSync(join(tmpdir(), 'fix1-'))
  const dir = join(root, 'sessions', 'proj', SESSION)
  mkdirSync(dir, { recursive: true })
  return { root, dir, file: join(dir, 'session.v4.jsonl.zstd'), cache: join(root, 'cache', 'dsh-go-token-usage') }
}
const tokens = (ledger) => totalTokens(ledger.allTime())

// ── P1-7：同额跨日重结算要迁移到重结算那一天 ────────────────────────────────

test('P1-7: an identical settlement on a later day moves the call to that day', async () => {
  const h = makeHome()
  try {
    const yesterday = NOW - DAY
    // 同额、同槽、跨日，之后没有第三条不同金额的结算。
    writeFileSync(h.file, frame([header(), call(1, { time: yesterday }), call(2, { time: NOW, model: 'm2' })]))
    const ledger = new UsageLedger({ home: h.root, now: () => NOW })
    await ledger.refresh()
    assert.equal(tokens(ledger), 115, 'one call, counted once')
    assert.equal(ledger.allTime().calls, 1)
    assert.equal(totalTokens(ledger.window(1)), 115, 'the call is booked today, not on the day it was first settled')
    assert.equal(dayKey(NOW), ledger.today())
    const yesterdayBucket = ledger.days.get(dayKey(yesterday))
    assert.equal(yesterdayBucket === undefined ? 0 : totalTokens(yesterdayBucket), 0, 'nothing is billed on the old day')
    // 同额时模型也必须跟着重结算更新（旧实现只挪了 seq）。
    assert.deepEqual(ledger.todayModels(5).map(([provider, model]) => [provider, model]), [['p', 'm2']])
    ledger.dispose()
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('P1-7: a later different amount still debits the migrated day (no negative buckets)', async () => {
  const h = makeHome()
  try {
    writeFileSync(h.file, frame([
      header(),
      call(1, { time: NOW - DAY }),
      call(2), // identical, migrates to today
      call(3, { input: 20, cached: 200, output: 6 }), // replaces again, new amount
    ]))
    const ledger = new UsageLedger({ home: h.root, now: () => NOW })
    await ledger.refresh()
    assert.equal(tokens(ledger), 226)
    for (const [day, bucket] of ledger.days) {
      for (const [key, value] of Object.entries(bucket)) assert.ok(value >= 0, `${day}.${key} = ${value} must not go negative`)
    }
    ledger.dispose()
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

// ── P1-6：同槽实时重结算不能把已入日志的旧值再加一遍 ────────────────────────

test('P1-6: a live re-settlement replaces the slot already in the log', async () => {
  const h = makeHome()
  try {
    writeFileSync(h.file, frame([header(), call(1)])) // turn 1 step 1, 115 tokens
    const ledger = new UsageLedger({ home: h.root, now: () => NOW })
    await ledger.refresh()
    assert.equal(tokens(ledger), 115)
    ledger.noteLive(SESSION, 2, NOW, { input: 20, cached: 200, cacheWrite: 0, output: 6, reasoning: 0, calls: 1 }, 'm1', 1, 'p', 1)
    assert.equal(tokens(ledger), 226, 'provisional view must be the replacement, not old + new (was 341)')
    assert.equal(ledger.allTime().calls, 1)
    // 日志追平后数字不变。
    writeFileSync(h.file, frame([header(), call(1), call(2, { input: 20, cached: 200, output: 6 })]))
    await ledger.refresh()
    assert.equal(tokens(ledger), 226)
    assert.equal(ledger.pendingCount(), 0)
    ledger.dispose()
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('P1-6: a live zero settlement clears the logged slot until the log catches up', async () => {
  const h = makeHome()
  try {
    writeFileSync(h.file, frame([header(), call(1)]))
    const ledger = new UsageLedger({ home: h.root, now: () => NOW })
    await ledger.refresh()
    ledger.noteLive(SESSION, 2, NOW, { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, calls: 1 }, 'm1', 1, 'p', 1)
    assert.equal(tokens(ledger), 0, 'the slot was replaced with nothing')
    assert.equal(ledger.allTime().calls, 0)
    assert.equal(ledger.pendingCount(), 0, 'a cleared slot is not a pending call')
    writeFileSync(h.file, frame([header(), call(1), call(2, { input: 0, cached: 0, output: 0 })]))
    await ledger.refresh()
    assert.equal(tokens(ledger), 0)
    ledger.dispose()
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('P1-6: a saved live slot still replaces its log slot after a restart', async () => {
  const h = makeHome()
  try {
    writeFileSync(h.file, frame([header(), call(1)]))
    const first = new UsageLedger({ home: h.root, now: () => NOW })
    await first.refresh()
    first.noteLive(SESSION, 2, NOW, { input: 7, cached: 70, cacheWrite: 0, output: 3, reasoning: 0, calls: 1 }, 'm1', 1, 'p', 1)
    assert.equal(tokens(first), 80)
    first.dispose()
    // 重启：pending 与槽位都从缓存恢复，不能变成「旧值 + 新值」，也不能变成两次调用。
    const second = new UsageLedger({ home: h.root, now: () => NOW })
    assert.equal(tokens(second), 80, 'the restored slot still shadows the logged settlement')
    second.noteLive(SESSION, 3, NOW, { input: 50, cached: 500, cacheWrite: 0, output: 8, reasoning: 0, calls: 1 }, 'm1', 1, 'p', 1)
    assert.equal(tokens(second), 558, 'a second re-settlement replaces the first')
    assert.equal(second.allTime().calls, 1)
    second.dispose()
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('P1-6: a retry closes the slot, so the next settlement is an extra call', async () => {
  const h = makeHome()
  try {
    writeFileSync(h.file, frame([header(), call(1)]))
    const ledger = new UsageLedger({ home: h.root, now: () => NOW })
    await ledger.refresh()
    ledger.noteLive(SESSION, 2, NOW, { input: 7, cached: 70, cacheWrite: 0, output: 3, reasoning: 0, calls: 1 }, 'm1', 1, 'p', 1)
    assert.equal(tokens(ledger), 80)
    ledger.noteRetryStarted(SESSION, 1, 1)
    ledger.noteLive(SESSION, 3, NOW, { input: 7, cached: 70, cacheWrite: 0, output: 3, reasoning: 0, calls: 1 }, 'm1', 1, 'p', 1)
    assert.equal(tokens(ledger), 160, 'the retried call is billed on top of the replacement')
    assert.equal(ledger.pendingCount(), 2)
    // 日志里带着 retry 标记追平：数字不变。
    writeFileSync(h.file, frame([
      header(),
      call(1),
      call(2, { input: 7, cached: 70, output: 3 }),
      retryStarted(3, 1, 1),
      call(4, { input: 7, cached: 70, output: 3 }),
    ]))
    await ledger.refresh()
    assert.equal(tokens(ledger), 160)
    assert.equal(ledger.allTime().calls, 2)
    ledger.dispose()
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

// ── P1-3：两个实例交错保存时不能互相覆盖 ────────────────────────────────────

test('P1-3: two instances sharing one home both keep their bookings', async () => {
  const h = makeHome()
  try {
    writeFileSync(h.file, frame([header(), call(1)]))
    // 两个实例都先从同一个 home 加载，再各自记录不同的会话，最后依次保存。
    const a = new UsageLedger({ home: h.root, now: () => NOW })
    const b = new UsageLedger({ home: h.root, now: () => NOW })
    await a.refresh()
    await b.refresh()
    a.noteLive('session-a', 5, NOW, { input: 1, cached: 10, cacheWrite: 0, output: 1, reasoning: 0, calls: 1 }, 'm1', 1, 'p', 1)
    b.noteLive('session-b', 6, NOW, { input: 2, cached: 20, cacheWrite: 0, output: 2, reasoning: 0, calls: 1 }, 'm1', 1, 'p', 2)
    a.dispose()
    b.dispose() // 旧实现在这里用自己那份过期快照覆盖，session-a 的调用就没了
    const restarted = new UsageLedger({ home: h.root, now: () => NOW })
    assert.equal(restarted.pendingCount(), 2, 'both bookings must survive the second save')
    assert.equal(restarted.session('session-a').calls, 1)
    assert.equal(restarted.session('session-b').calls, 1)
    restarted.dispose()
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('P1-3: the same session written by two instances keeps both log positions', async () => {
  const h = makeHome()
  try {
    writeFileSync(h.file, frame([header(), call(1)]))
    const a = new UsageLedger({ home: h.root, now: () => NOW })
    const b = new UsageLedger({ home: h.root, now: () => NOW })
    await a.refresh()
    await b.refresh()
    a.noteLive(SESSION, 7, NOW, { input: 1, cached: 10, cacheWrite: 0, output: 1, reasoning: 0, calls: 1 }, 'm1', 2, 'p', 1)
    b.noteLive(SESSION, 8, NOW, { input: 2, cached: 20, cacheWrite: 0, output: 2, reasoning: 0, calls: 1 }, 'm1', 3, 'p', 1)
    a.dispose()
    b.dispose()
    const restarted = new UsageLedger({ home: h.root, now: () => NOW })
    assert.equal(restarted.pendingCount(), 2)
    assert.equal(tokens(restarted), 115 + 12 + 24)
    restarted.dispose()
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('P1-3: a lock held by another process is waited for, a stale one is stolen', { skip: !POSIX && 'posix lock semantics' }, async () => {
  const h = makeHome()
  try {
    writeFileSync(h.file, frame([header(), call(1)]))
    mkdirSync(h.cache, { recursive: true })
    const lock = join(h.cache, 'index.json.lock')
    // 另一个实例正在合并：拿住锁 250ms。
    const holder = spawn(process.execPath, ['-e', `
      const fs = require('node:fs')
      fs.writeFileSync(${JSON.stringify(lock)}, 'holder')
      setTimeout(() => { try { fs.unlinkSync(${JSON.stringify(lock)}) } catch {} }, 250)
    `], { stdio: 'ignore' })
    try {
      const deadline = Date.now() + 5000
      while (!existsSync(lock) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
      assert.ok(existsSync(lock), 'the holder created the lock')
      const ledger = new UsageLedger({ home: h.root, now: () => NOW })
      ledger.noteLive(SESSION, 2, NOW, { input: 1, cached: 1, cacheWrite: 0, output: 1, reasoning: 0, calls: 1 }, 'm1', 2, 'p', 1)
      const started = Date.now()
      ledger.dispose()
      const waited = Date.now() - started
      assert.ok(waited >= 120, `the save waited for the other process (${waited}ms)`)
      assert.ok(existsSync(join(h.cache, 'index.json')), 'the snapshot was written after the lock was released')
      assert.equal(existsSync(lock), false, 'the lock is released')
    } finally {
      holder.kill('SIGKILL')
    }
    // 崩溃的实例留下的旧锁不会把账本锁死。
    writeFileSync(lock, 'stale')
    const old = new Date(Date.now() - 60 * 60 * 1000)
    utimesSync(lock, old, old)
    const again = new UsageLedger({ home: h.root, now: () => NOW })
    again.noteLive(SESSION, 3, NOW, { input: 2, cached: 2, cacheWrite: 0, output: 2, reasoning: 0, calls: 1 }, 'm1', 3, 'p', 1)
    const t0 = Date.now()
    again.dispose()
    assert.ok(Date.now() - t0 < 1000, 'a stale lock is stolen instead of blocking the save')
    assert.equal(existsSync(lock), false)
    again.dispose()
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

// ── P1-4：cache 目录在创建前就要确认没越界 ──────────────────────────────────

test('P1-4: a symlinked cache parent never gets the plugin directory created outside', () => {
  const h = makeHome()
  const outside = mkdtempSync(join(tmpdir(), 'fix1-outside-'))
  try {
    mkdirSync(join(h.root, 'cache'), { recursive: true })
    // $DSH_HOME/cache 指向 home 外，且目标下还没有插件目录（旧实现会先 mkdir 再检查）。
    rmSync(join(h.root, 'cache'), { recursive: true, force: true })
    symlinkSync(outside, join(h.root, 'cache'))
    const ledger = new UsageLedger({ home: h.root, now: () => NOW })
    ledger.noteLive(SESSION, 2, NOW, { input: 1, cached: 1, cacheWrite: 0, output: 1, reasoning: 0, calls: 1 }, 'm1', 1, 'p', 1)
    ledger.dispose()
    assert.deepEqual(readdirSync(outside), [], 'nothing may be created outside the home')
  } finally {
    rmSync(join(h.root, 'cache'), { recursive: true, force: true })
    rmSync(h.root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

// ── P1-5：硬链接的缓存不能改掉别人的文件权限 ────────────────────────────────

test('P1-5: loading a hard-linked cache never chmods the linked file', { skip: !POSIX && 'posix modes only' }, () => {
  const h = makeHome()
  try {
    const target = join(h.root, 'other-index.json')
    writeFileSync(target, JSON.stringify({ v: 10, files: {} }), { mode: 0o644 })
    chmodSync(target, 0o644)
    mkdirSync(h.cache, { recursive: true })
    linkSync(target, join(h.cache, 'index.json'))
    const ledger = new UsageLedger({ home: h.root, now: () => NOW })
    assert.equal(statSync(target).mode & 0o777, 0o644, 'the other name keeps its mode')
    ledger.dispose()
    assert.equal(statSync(target).mode & 0o777, 0o644)
    assert.equal(readFileSync(target, 'utf8'), JSON.stringify({ v: 10, files: {} }))
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

// ── P2-2：被跳过的日志要一直可见 ────────────────────────────────────────────

test('P2-2: empty and oversized log warnings survive warm scans', async () => {
  const h = makeHome()
  try {
    const emptyDir = join(h.root, 'sessions', 'proj', 'session-empty')
    mkdirSync(emptyDir, { recursive: true })
    writeFileSync(join(emptyDir, 'session.v4.jsonl.zstd'), '')
    const bigDir = join(h.root, 'sessions', 'proj', 'session-big')
    mkdirSync(bigDir, { recursive: true })
    const big = join(bigDir, 'session.v4.jsonl.zstd')
    writeFileSync(big, Buffer.alloc(64))
    truncateSync(big, 10 * 1024 * 1024)
    writeFileSync(h.file, frame([header(), call(1)]))
    const ledger = new UsageLedger({ home: h.root, now: () => NOW, maxLogBytes: 1024 })
    await ledger.refresh()
    assert.equal(ledger.sourceState().emptyLogs, 1)
    assert.equal(ledger.sourceState().oversizedLogs, 1)
    // 第二次（以及之后的）刷新时文件没变，但跳过原因必须继续上报，否则面板悄悄漏账。
    await ledger.refresh()
    assert.equal(ledger.sourceState().emptyLogs, 1, 'the empty log is still reported as empty')
    assert.equal(ledger.sourceState().oversizedLogs, 1, 'the oversized log is still reported')
    await ledger.refresh()
    assert.equal(ledger.sourceState().oversizedLogs, 1)
    // 文件恢复正常后警告消失，用量正常计入。
    writeFileSync(big, frame([header('session-big'), call(1)]))
    await ledger.refresh()
    assert.equal(ledger.sourceState().oversizedLogs, 0)
    assert.equal(tokens(ledger), 230)
    ledger.dispose()
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

// ── P2-3：荒谬的计数不能把账本写成 null ─────────────────────────────────────

test('P2-3: absurd counters are refused instead of overflowing the cache', async () => {
  const h = makeHome()
  try {
    const huge = JSON.stringify({
      type: 'assistant/message',
      seq: 2,
      time: NOW,
      data: { turn: 2, step: 1, usage: { inputTokens: 1e308, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1e308 }, message: { source: { model: 'm1', provider: 'p' } } },
    })
    writeFileSync(h.file, frame([header(), call(1), huge]))
    const ledger = new UsageLedger({ home: h.root, now: () => NOW })
    await ledger.refresh()
    assert.equal(tokens(ledger), 115, 'the normal call is still counted')
    assert.ok(Number.isFinite(tokens(ledger)))
    assert.ok(ledger.sourceState().scanErrors > 0, 'the log is flagged as incomplete instead of being silently zeroed')
    ledger.dispose()
    const cache = JSON.parse(readFileSync(join(h.cache, 'index.json'), 'utf8'))
    for (const rec of Object.values(cache.files ?? {})) {
      for (const bucket of Object.values(rec.days ?? {})) {
        for (const [key, value] of Object.entries(bucket)) assert.ok(Number.isFinite(value), `${key} must stay a finite number`)
      }
    }
    const reloaded = new UsageLedger({ home: h.root, now: () => NOW })
    assert.equal(reloaded.cacheDropped, 0, 'no record had to be thrown away on load')
    reloaded.dispose()
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

// ── P2-1：部分上报时命中率只用上报的那部分算 ────────────────────────────────

test('P2-1: a partially reported cache hit rate uses only the reporting calls', async () => {
  const h = makeHome()
  try {
    // 第 1 笔上报缓存（cached 100, 未缓存输入 0，命中率 100%）；第 2 笔是只报输入的中转。
    writeFileSync(h.file, frame([
      header(),
      call(1, { input: 0, cached: 100, step: 1 }),
      call(2, { input: 1000, cached: 0, output: 10, step: 2, cache: false }),
    ]))
    const ledger = new UsageLedger({ home: h.root, now: () => NOW })
    await ledger.refresh()
    const totals = ledger.window(1)
    const coverage = ledger.windowCacheCoverage(1)
    assert.equal(coverage.calls, 2)
    assert.equal(coverage.withCounters, 1)
    assert.equal(coverage.prompt, 100, 'only the reporting call contributes a denominator')
    assert.equal(hitRateText(totals, coverage), '≈100%', 'the unknown call must not be counted as a miss (was ≈9%)')
    // 全部上报时没有「≈」，仍是精确值；一笔都没上报时是「—」。
    assert.equal(hitRateText({ ...totals, input: 100, cached: 0 }, { calls: 1, withCounters: 1, prompt: 100 }), '0%')
    assert.equal(hitRateText(totals, { calls: 2, withCounters: 0, prompt: 0 }), '—')
    ledger.dispose()
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})
