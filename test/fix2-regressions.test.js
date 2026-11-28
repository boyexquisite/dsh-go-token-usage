// 2026-11-28 第 2 轮补修的回归测试：锁的陈旧判定与属主校验、retry 关闭槽的实时口径、
// 等锁不再冻结事件循环、home 内软链缓存目录、更新的缓存只读、retry 槽持久化。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { UsageLedger } from '../lib/ledger.js'
import { totalTokens } from '../lib/tally.js'
import { historyNote } from '../lib/view.js'

const NOW = new Date(2026, 10, 12, 12, 0, 0).getTime()
const SESSION = 'session-aaa'
const POSIX = process.platform !== 'win32'

const header = (id = SESSION) => JSON.stringify({ type: 'session', version: 4, id, createdAt: NOW, cwd: '/p' })
const call = (seq, { turn = 1, step = 1, input = 10, cached = 100, output = 5, model = 'm1' } = {}) =>
  JSON.stringify({
    type: 'assistant/message',
    seq,
    time: NOW,
    data: {
      turn,
      step,
      usage: { inputTokens: input, cacheReadTokens: cached, cacheWriteTokens: 0, outputTokens: output },
      message: { source: { provider: 'p', model } },
    },
  })
const retryStarted = (seq, turn, step) => JSON.stringify({ type: 'llm/retry-started', seq, time: NOW, data: { turn, step, retryId: 'r1' } })
const frame = (lines) => zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'))
const usage = (input, cached, output) => ({ input, cached, cacheWrite: 0, output, reasoning: 0, calls: 1 })

function makeHome() {
  const root = mkdtempSync(join(tmpdir(), 'fix2-'))
  const dir = join(root, 'sessions', 'proj', SESSION)
  mkdirSync(dir, { recursive: true })
  return { root, dir, file: join(dir, 'session.v4.jsonl.zstd'), cache: join(root, 'cache', 'dsh-go-token-usage') }
}
const tokens = (ledger) => totalTokens(ledger.allTime())
const readCache = (home) => JSON.parse(readFileSync(join(home, 'cache', 'dsh-go-token-usage', 'index.json'), 'utf8'))
const old = (ms) => new Date(Date.now() - ms)

// ── 复审 P1：陈旧锁回收不能删掉「活着」的锁 ─────────────────────────────────

test('P1: a lock held by a live process is never stolen, however old its mtime looks', () => {
  const h = makeHome()
  try {
    writeFileSync(h.file, frame([header(), call(1)]))
    mkdirSync(h.cache, { recursive: true })
    const lock = join(h.cache, 'index.json.lock')
    // 一个持有者：pid 是活的（就是本测试进程），但 mtime 已经一小时前——大缓存慢 fsync、
    // 进程被 SIGSTOP、或校时把时钟往前跳，都会长成这样。旧实现只看 mtime，会把它删掉。
    writeFileSync(lock, `${process.pid} 1\n`)
    // 2 分钟前：已经超过「陈旧」阈值（60s），但远没到「死活都要抢」的 30 分钟。
    const stale = old(2 * 60 * 1000)
    utimesSync(lock, stale, stale)
    const before = lstatSync(lock)
    const ledger = new UsageLedger({ home: h.root, now: () => NOW })
    ledger.noteLive(SESSION, 2, NOW, usage(1, 1, 1), 'm1', 2, 'p', 1)
    ledger.dispose()
    assert.equal(existsSync(join(h.cache, 'index.json')), false, 'the save must not run while a live holder owns the lock')
    const after = lstatSync(lock)
    assert.equal(after.ino, before.ino, "the live holder's lock file must not be deleted or re-created")
    // 持有者放开后，下一次保存照常进行。
    rmSync(lock)
    const again = new UsageLedger({ home: h.root, now: () => NOW })
    again.noteLive(SESSION, 2, NOW, usage(1, 1, 1), 'm1', 2, 'p', 1)
    again.dispose()
    assert.equal(existsSync(join(h.cache, 'index.json')), true)
    assert.equal(existsSync(lock), false, 'our own lock is released')
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('P1: a lock whose owner is gone is still reclaimed', () => {
  const h = makeHome()
  try {
    writeFileSync(h.file, frame([header(), call(1)]))
    mkdirSync(h.cache, { recursive: true })
    const lock = join(h.cache, 'index.json.lock')
    writeFileSync(lock, '999999 1\n') // a pid that is certainly not running
    const stale = old(2 * 60 * 1000)
    utimesSync(lock, stale, stale)
    const ledger = new UsageLedger({ home: h.root, now: () => NOW })
    ledger.noteLive(SESSION, 2, NOW, usage(1, 1, 1), 'm1', 2, 'p', 1)
    ledger.dispose()
    assert.equal(existsSync(join(h.cache, 'index.json')), true, 'a crashed holder must not block the save forever')
    assert.equal(existsSync(lock), false)
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('P1: an ancient lock is reclaimed even if its pid looks alive', () => {
  const h = makeHome()
  try {
    writeFileSync(h.file, frame([header(), call(1)]))
    mkdirSync(h.cache, { recursive: true })
    const lock = join(h.cache, 'index.json.lock')
    writeFileSync(lock, `${process.pid} 1\n`)
    const ancient = old(30 * 60 * 1000) // > 10 minutes: a live pid cannot explain this
    utimesSync(lock, ancient, ancient)
    const ledger = new UsageLedger({ home: h.root, now: () => NOW })
    ledger.noteLive(SESSION, 2, NOW, usage(1, 1, 1), 'm1', 2, 'p', 1)
    ledger.dispose()
    assert.equal(existsSync(join(h.cache, 'index.json')), true, 'a 30-minute-old lock is dead, whoever the pid says')
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('P1: a foreign object at the lock path blocks the save visibly', { skip: !POSIX && 'posix symlink semantics' }, async () => {
  const h = makeHome()
  try {
    writeFileSync(h.file, frame([header(), call(1)]))
    mkdirSync(h.cache, { recursive: true })
    const target = join(h.root, 'not-a-lock')
    writeFileSync(target, 'x')
    symlinkSync(target, join(h.cache, 'index.json.lock'))
    const ledger = new UsageLedger({ home: h.root, now: () => NOW })
    await ledger.refresh()
    ledger.noteLive(SESSION, 2, NOW, usage(1, 1, 1), 'm1', 2, 'p', 1)
    ledger.dispose()
    assert.equal(existsSync(join(h.cache, 'index.json')), false, 'never write through a foreign lock path')
    assert.equal(readFileSync(target, 'utf8'), 'x', 'the symlink target is untouched')
    assert.equal(ledger.sourceState().cacheLocked, true, 'the panel must be able to say the cache is locked')
    assert.match(historyNote(ledger, 'zh-CN'), /缓存被其他程序占用/)
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

// ── 复审 P2：retry 之后的新结算是另一次调用，实时面板不能先少算 ───────────────

test('P2: a retry without a live settlement still makes the next one an extra call', async () => {
  const h = makeHome()
  try {
    writeFileSync(h.file, frame([header(), call(1)])) // turn 1 step 1 = 115, already in the log
    const ledger = new UsageLedger({ home: h.root, now: () => NOW })
    await ledger.refresh()
    assert.equal(tokens(ledger), 115)
    // 插件这一轮没有该槽的活结算（在两次事件之间重载过）：retry 事件照样要记下关闭状态。
    ledger.noteRetryStarted(SESSION, 1, 1)
    ledger.noteLive(SESSION, 2, NOW, usage(7, 70, 3), 'm1', 1, 'p', 1)
    assert.equal(tokens(ledger), 195, 'the log call stays and the retried call adds: 115 + 80')
    assert.equal(ledger.allTime().calls, 2)
    // 日志带着 retry 标记追平：口径不变，不跳变。
    writeFileSync(h.file, frame([header(), call(1), retryStarted(2, 1, 1), call(3, { input: 7, cached: 70, output: 3 })]))
    await ledger.refresh()
    assert.equal(tokens(ledger), 195)
    assert.equal(ledger.allTime().calls, 2)
    assert.equal(ledger.pendingCount(), 0)
    ledger.dispose()
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

test('P2: a retry recorded before a restart still counts the next settlement once more', async () => {
  const h = makeHome()
  try {
    writeFileSync(h.file, frame([header(), call(1)]))
    const first = new UsageLedger({ home: h.root, now: () => NOW })
    await first.refresh()
    first.noteRetryStarted(SESSION, 1, 1)
    first.dispose() // the closed slot has to survive the restart
    const second = new UsageLedger({ home: h.root, now: () => NOW })
    second.noteLive(SESSION, 2, NOW, usage(7, 70, 3), 'm1', 1, 'p', 1)
    assert.equal(tokens(second), 195, 'the retried slot is an extra call, not a replacement')
    assert.equal(second.allTime().calls, 2)
    second.dispose()
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

// ── 复审 P2：等锁不能冻结宿主的事件循环 ────────────────────────────────────

test('P2: waiting for the cache lock does not freeze the event loop', { skip: !POSIX && 'posix lock file semantics' }, async () => {
  const h = makeHome()
  try {
    writeFileSync(h.file, frame([header(), call(1)]))
    mkdirSync(h.cache, { recursive: true })
    const lock = join(h.cache, 'index.json.lock')
    // 另一个宿主（手机 App / verify CLI）正拿着锁 300ms。
    const holder = spawn(process.execPath, ['-e', `
      const fs = require('node:fs')
      fs.writeFileSync(${JSON.stringify(lock)}, process.pid + '\\n')
      setTimeout(() => { try { fs.unlinkSync(${JSON.stringify(lock)}) } catch {} }, 300)
    `], { stdio: 'ignore' })
    try {
      const deadline = Date.now() + 5000
      while (!existsSync(lock) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
      assert.ok(existsSync(lock), 'the holder created the lock')
      const ledger = new UsageLedger({ home: h.root, now: () => NOW, saveDebounceMs: 5 })
      ledger.noteLive(SESSION, 2, NOW, usage(1, 1, 1), 'm1', 2, 'p', 1)
      // 保存进入等待时，事件循环必须还在转：定时器应当照常触发。
      let ticks = 0
      const timer = setInterval(() => { ticks += 1 }, 20)
      try {
        const stop = Date.now() + 1200
        while (!existsSync(join(h.cache, 'index.json')) && Date.now() < stop) await new Promise((resolve) => setTimeout(resolve, 20))
      } finally {
        clearInterval(timer)
      }
      assert.equal(existsSync(join(h.cache, 'index.json')), true, 'the save completed once the holder released the lock')
      assert.ok(ticks >= 3, `timers kept firing while the save waited (${ticks})`)
      ledger.dispose()
    } finally {
      holder.kill('SIGKILL')
    }
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

// ── 复审 P2：home 内的软链缓存目录要照常可用 ────────────────────────────────

test('P2: a cache directory symlinked inside the home still gets written', { skip: !POSIX && 'posix symlink semantics' }, () => {
  const h = makeHome()
  try {
    writeFileSync(h.file, frame([header(), call(1)]))
    const real = join(h.root, 'real-cache')
    mkdirSync(real, { recursive: true })
    symlinkSync(real, join(h.root, 'cache'))
    const ledger = new UsageLedger({ home: h.root, now: () => NOW })
    ledger.noteLive(SESSION, 2, NOW, usage(1, 1, 1), 'm1', 2, 'p', 1)
    ledger.dispose()
    assert.equal(existsSync(join(real, 'dsh-go-token-usage', 'index.json')), true, 'the cache lands under the real path')
    const state = ledger.sourceState()
    assert.equal(state.cacheDenied, false)
    assert.equal(state.cacheLocked, false)
    assert.equal(state.cacheDamaged, false, 'nothing to warn about: this layout is fine')
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

// ── 复审 P3：比自己新的缓存只读不写 ────────────────────────────────────────

test('P3: a cache written by a newer build is never overwritten', async () => {
  const h = makeHome()
  try {
    writeFileSync(h.file, frame([header(), call(1)]))
    mkdirSync(h.cache, { recursive: true })
    const body = JSON.stringify({ v: 99, files: {}, pending: {}, future: true })
    writeFileSync(join(h.cache, 'index.json'), body)
    const ledger = new UsageLedger({ home: h.root, now: () => NOW })
    await ledger.refresh()
    assert.equal(ledger.sourceState().cacheNewer, true)
    assert.match(historyNote(ledger, 'zh-CN'), /更新的版本/)
    ledger.noteLive(SESSION, 2, NOW, usage(1, 1, 1), 'm1', 2, 'p', 1)
    ledger.dispose()
    assert.equal(readFileSync(join(h.cache, 'index.json'), 'utf8'), body, 'a downgraded build must leave the newer cache alone')
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})

// ── 复审 P3：slots / closedSlots 不再无限增长 ───────────────────────────────

test('P3: saved live slots are pruned once the log holds the call', async () => {
  const h = makeHome()
  try {
    writeFileSync(h.file, frame([header(), call(1)]))
    const ledger = new UsageLedger({ home: h.root, now: () => NOW })
    await ledger.refresh()
    ledger.noteLive(SESSION, 2, NOW, usage(1, 1, 1), 'm1', 2, 'p', 1) // a live call nobody wrote yet
    ledger.dispose()
    assert.ok(readCache(h.root).slots?.aaa !== undefined, 'a pending session keeps its slot')
    // 日志追平后 pending 清空，槽位信息就没有保存价值了。
    writeFileSync(h.file, frame([header(), call(1), call(2, { turn: 2, input: 1, cached: 1, output: 1 })]))
    const again = new UsageLedger({ home: h.root, now: () => NOW })
    await again.refresh()
    again.dispose()
    assert.equal(readCache(h.root).slots?.aaa, undefined, 'a settled session no longer writes a slot')
  } finally {
    rmSync(h.root, { recursive: true, force: true })
  }
})
