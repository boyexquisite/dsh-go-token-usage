import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, chownSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { UsageLedger } from '../lib/ledger.js'
import { verifyLine } from '../lib/view.js'
import { totalTokens } from '../lib/tally.js'
import { resolveExecutable } from '../lib/exec.js'

const now = new Date(2026, 10, 12, 12).getTime()
const day = 86400000
const header = JSON.stringify({ type: 'session', id: 'session-x', createdAt: now })
const event = (seq, time, n) => JSON.stringify({ type: 'assistant/message', seq, time, data: { turn: 1, step: 1, usage: { inputTokens: n, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, message: { source: { provider: 'p', model: 'm' } } } })
const frame = (s) => zlib.zstdCompressSync(Buffer.from(s + '\n'))
function home() {
  const root = mkdtempSync(join(tmpdir(), 'usage-regression-'))
  const dir = join(root, 'sessions', 'p', 'session-x')
  mkdirSync(dir, { recursive: true })
  return { root, file: join(dir, 'session.v4.jsonl.zstd') }
}

test('identical cross-day settlement keeps original slot for later replacement', async () => {
  const { root, file } = home()
  try {
    writeFileSync(file, frame([header, event(1, now-day, 10), event(2, now, 10), event(3, now, 20)].join('\n')))
    const ledger = new UsageLedger({ home: root, now: () => now })
    await ledger.refresh()
    assert.equal(totalTokens(ledger.allTime()), 20)
    assert.equal(totalTokens(ledger.window(1)), 20)
    assert.equal(ledger.allTime().calls, 1)
    ledger.dispose()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('cache symlink and old predictable temp symlink never change target', () => {
  const { root } = home()
  try {
    const cache = join(root, 'cache', 'dsh-go-token-usage')
    mkdirSync(cache, { recursive: true })
    const secret = join(root, 'secret')
    writeFileSync(secret, 'secret', { mode: 0o644 })
    chmodSync(secret, 0o644)
    symlinkSync(secret, join(cache, 'index.json'))
    symlinkSync(secret, join(cache, `index.json.${process.pid}.tmp`))
    const ledger = new UsageLedger({ home: root })
    assert.equal(statSync(secret).mode & 0o777, 0o644)
    ledger.dispose()
    assert.equal(readFileSync(secret, 'utf8'), 'secret')
    assert.equal(statSync(secret).mode & 0o777, 0o644)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('torn tail is disclosed; corruption and decoded size errors are not swallowed', async () => {
  for (const kind of ['torn', 'bad-magic', 'bad-frame', 'limit']) {
    const { root, file } = home()
    try {
      const first = frame([header, event(1, now, 10)].join('\n'))
      let tail = frame(event(2, now, 20))
      if (kind === 'torn') tail = tail.subarray(0, tail.length - 2)
      if (kind === 'bad-magic') tail = Buffer.from('invalid!')
      if (kind === 'bad-frame') { tail = Buffer.from(tail); tail[4] |= 0x08 }
      if (kind === 'limit') tail = frame('x'.repeat(10000))
      writeFileSync(file, Buffer.concat([first, tail]))
      const ledger = new UsageLedger({ home: root, now: () => now, maxDecodedBytes: kind === 'limit' ? 1000 : undefined })
      await ledger.refresh()
      const recount = await ledger.recount()
      assert.ok(ledger.sourceState().scanErrors > 0, kind)
      assert.match(verifyLine(ledger, recount, 'en'), /incomplete/i, kind)
      assert.equal(totalTokens(ledger.allTime()), kind === 'torn' ? 10 : 0, kind)
      ledger.dispose()
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('executable beneath writable ancestor or foreign owner is rejected', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'exec-regression-'))
  const oldPath = process.env.PATH
  try {
    const bin = join(root, 'bin')
    mkdirSync(bin)
    const tool = join(bin, 'tool')
    writeFileSync(tool, '#!/bin/sh\n', { mode: 0o755 })
    process.env.PATH = bin
    assert.equal(resolveExecutable('tool'), tool)
    chmodSync(root, 0o777)
    assert.equal(resolveExecutable('tool'), undefined)
    chmodSync(root, 0o700)
    if (process.getuid?.() === 0) {
      chownSync(tool, 65534, 65534)
      assert.equal(lstatSync(tool).uid, 65534)
      assert.equal(resolveExecutable('tool'), undefined)
    }
  } finally { process.env.PATH = oldPath; rmSync(root, { recursive: true, force: true }) }
})
