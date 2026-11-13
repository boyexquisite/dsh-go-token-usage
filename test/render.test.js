import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import zlib from 'node:zlib'
import { UsageLedger } from '../lib/ledger.js'
import { canRender, cardData, ensureRenderer, pickTempDir, renderUsageImage, safeEnsureDir } from '../lib/render.js'
import { imagePanelData, usageView } from '../lib/view.js'

const NOW = new Date(2026, 10, 12, 12, 0, 0).getTime()
const call = (seq, provider, model, input, cached, output) =>
  JSON.stringify({
    type: 'assistant/message',
    seq,
    time: NOW - (10 - seq) * 60_000,
    data: {
      turn: seq + 1,
      step: 1,
      usage: { inputTokens: input, cacheReadTokens: cached, cacheWriteTokens: 0, outputTokens: output },
      message: { source: { provider, model } },
    },
  })

function homeWithLog() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-render-'))
  const dir = join(home, 'sessions', 'proj', 'session-aaa')
  mkdirSync(dir, { recursive: true })
  return { home, dir }
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

test('usageView: one panel with the image at the bottom and four actions', () => {
  const view = usageView({}, { locale: 'zh-CN' })
  assert.equal(view.v, 2)
  const image = collect(view, 'image')[0]
  assert.deepEqual(image.src, { $: 'data.imageSrc' })
  assert.deepEqual(image.aspect, { $: 'data.imageAspect' })
  const actions = collect(view, 'actions')[0].items.map((item) => item.action)
  assert.deepEqual(actions, ['copy', 'export', 'verify', 'refresh'])
  assert.ok(JSON.stringify(view).length < 32 * 1024)
})

test('imagePanelData: placeholder until a render exists, then the asset reference', () => {
  const empty = imagePanelData(null, 'zh-CN')
  assert.equal(empty.imageSrc, 'asset:placeholder.png')
  assert.ok(empty.imageCaption.includes('生成图片'))
  const ready = imagePanelData({ src: 'asset:usage-20260101-000000.png', aspect: 0.66, caption: '今日 1M tokens' }, 'zh-CN')
  assert.equal(ready.imageSrc, 'asset:usage-20260101-000000.png')
  assert.equal(ready.imageAspect, 0.66)
  assert.equal(ready.imageCaption, '今日 1M tokens')
})

test('cardData: rows, colors and provider labels for the image', async () => {
  const { home } = homeWithLog()
  try {
    const dir = join(home, 'sessions', 'proj', 'session-aaa')
    const header = JSON.stringify({ type: 'session', version: 4, id: 'session-aaa', createdAt: NOW, cwd: '/p' })
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from([header, call(0, 'deepseek-account', 'm1', 10, 100, 5), call(1, 'custom-sta1n', 'm2', 10, 200, 6)].join('\n') + '\n', 'utf8')))
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    const data = cardData({ ledger, scope: { sessionId: 'session-aaa' }, locale: 'zh-CN', now: NOW })
    assert.equal(data.title, 'Token 用量')
    assert.deepEqual(data.rows.map((row) => row.label), ['累计', '本对话', '今日', '近 7 天', '近 30 天'])
    assert.equal(data.rows[0].color, '#3D6FD6')
    assert.match(data.rows[0].value, /^\d+(\.\d+)?[kMB]?$/)
    assert.deepEqual(data.models.map((m) => m.source), ['中转 · sta1n', '官方 · 账号'])
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('renderUsageImage draws a PNG the bridge can serve', { skip: !canRender() && 'host has no python3 + Pillow' }, async () => {
  const { home } = homeWithLog()
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-render-out-'))
  try {
    const dir = join(home, 'sessions', 'proj', 'session-aaa')
    const header = JSON.stringify({ type: 'session', version: 4, id: 'session-aaa', createdAt: NOW, cwd: '/p' })
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from([header, call(0, 'deepseek-account', 'm1', 10, 100, 5)].join('\n') + '\n', 'utf8')))
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    const out = await renderUsageImage({ ledger, scope: { sessionId: 'session-aaa' }, locale: 'zh-CN', now: NOW, outDir })
    assert.match(out.src, /^asset:usage-\d{8}-\d{6}-[a-z0-9]+\.png$/)
    assert.ok(out.aspect > 0.25 && out.aspect < 4)
    assert.ok(statSync(out.file).size > 5000, 'PNG has real pixels')
    assert.ok(out.caption.includes('tokens'))
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('cardData: unknown chat keeps a dashes row, lists six models, clips labels', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-render-edge-'))
  try {
    const dir = join(home, 'sessions', 'proj', 'session-aaa')
    mkdirSync(dir, { recursive: true })
    const header = JSON.stringify({ type: 'session', version: 4, id: 'session-aaa', createdAt: NOW, cwd: '/p' })
    const lines = [header]
    for (let i = 0; i < 7; i += 1) {
      lines.push(JSON.stringify({
        type: 'assistant/message', seq: i, time: NOW,
        data: {
          turn: i, step: i,
          usage: { inputTokens: 10, cacheReadTokens: 100 + i, cacheWriteTokens: 0, outputTokens: 5 },
          message: { source: { provider: `custom-very-long-relay-provider-name-${i}`, model: `a-very-long-model-name-${i}` } },
        },
      }))
    }
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n')))
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    const data = cardData({ ledger, scope: { sessionId: 'session-unknown' }, locale: 'zh-CN', now: NOW })
    assert.deepEqual(data.rows.map((row) => row.label), ['累计', '本对话', '今日', '近 7 天', '近 30 天'])
    assert.equal(data.rows[1].value, '—', 'a chat with no ledger record still gets its row')
    assert.equal(data.models.length, 6, 'the image lists the same six models as the panel')
    for (const model of data.models) {
      assert.ok([...model.name].length <= 28, model.name)
      assert.ok([...model.source].length <= 18, model.source)
    }
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})


const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const RENDER_URL = pathToFileURL(join(PKG_ROOT, 'lib', 'render.js')).href
const LEDGER_URL = pathToFileURL(join(PKG_ROOT, 'lib', 'ledger.js')).href
const RENDER_PY = join(PKG_ROOT, 'scripts', 'render.py')

/** Run a snippet in a fresh node process (module state must not leak between tests). */
function runNodeChild(code, { timeout = 30_000, env = {} } = {}) {
  return execFileSync(process.execPath, ['-e', code], {
    encoding: 'utf8',
    timeout,
    killSignal: 'SIGKILL',
    env: { ...process.env, ...env },
  })
}

function writeRenderableHome(home) {
  const dir = join(home, 'sessions', 'proj', 'session-aaa')
  mkdirSync(dir, { recursive: true })
  const header = JSON.stringify({ type: 'session', version: 4, id: 'session-aaa', createdAt: NOW, cwd: '/p' })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from([header, call(0, 'deepseek-account', 'deepseek-flash', 10, 100, 5)].join('\n') + '\n')))
}

// ── V-01: hostile model/provider labels must not break image export ─────────
test('renderUsageImage draws a card when model/provider names contain newlines and controls', { skip: !canRender() && 'host has no python3 + Pillow' }, async () => {
  const { home } = homeWithLog()
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-render-hostile-'))
  try {
    const dir = join(home, 'sessions', 'proj', 'session-aaa')
    const header = JSON.stringify({ type: 'session', version: 4, id: 'session-aaa', createdAt: NOW, cwd: '/p' })
    const events = [
      header,
      call(0, 'custom-evil\tprovider\nname', 'evil\nmodel\u0001', 10, 100, 5),
      call(1, 'custom-x', 'n'.repeat(5000), 10, 100, 6),
    ]
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(events.join('\n') + '\n')))
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    const data = cardData({ ledger, scope: { sessionId: 'session-aaa' }, locale: 'zh-CN', now: NOW })
    for (const model of data.models) {
      assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(model.name), JSON.stringify(model.name))
      assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(model.source), JSON.stringify(model.source))
      assert.ok([...model.name].length <= 28, model.name)
    }
    const out = await renderUsageImage({ ledger, scope: { sessionId: 'session-aaa' }, locale: 'zh-CN', now: NOW, outDir })
    assert.match(out.src, /^asset:usage-\d{8}-\d{6}-[a-z0-9]+\.png$/)
    assert.ok(statSync(out.file).size > 5000, 'PNG has real pixels')
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
})

// ── V-02: /proc or /sys under TMPDIR must never wedge the host ─────────────
test('pickTempDir never hangs on a /proc or /sys TMPDIR (child process timeout guard)', () => {
  const fallbackHome = mkdtempSync(join(tmpdir(), 'dsh-temp-home-'))
  try {
    for (const bad of ['/proc/definitely-not-writable', '/sys/definitely-not-writable']) {
      const code = `
        process.env.TMPDIR = ${JSON.stringify(bad)};
        process.env.TMP = ''; process.env.TEMP = '';
        import(${JSON.stringify(RENDER_URL)}).then((m) => {
          const dir = m.pickTempDir({ home: ${JSON.stringify(fallbackHome)} });
          if (!dir) { console.error('no temp dir'); process.exit(2); }
          console.log(dir);
        }).catch((error) => { console.error(error); process.exit(3); });
      `
      const out = runNodeChild(code, { timeout: 10_000 })
      assert.ok(out.trim().startsWith(join(fallbackHome, 'cache')), `${bad} -> ${out}`)
      // The refused pseudo-fs candidate must not have been created by us.
      assert.equal(existsSync(join(bad, 'dsh-usage-x')), false)
    }
    const code = `
      import(${JSON.stringify(RENDER_URL)}).then((m) => {
        if (m.safeEnsureDir('/proc/definitely-not-writable')) process.exit(2);
        console.log('refused');
      }).catch(() => process.exit(3));
    `
    assert.equal(runNodeChild(code, { timeout: 10_000 }).trim(), 'refused')
  } finally {
    rmSync(fallbackHome, { recursive: true, force: true })
  }
})

// ── V-08: 0700 temp dir, 0600 JSON, cleanup after success and stale sweep ──
test('renders use a private temp dir, clean it up and sweep stale ones', { skip: !canRender() && 'host has no python3 + Pillow' }, async () => {
  const { home } = homeWithLog()
  writeRenderableHome(home)
  const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-tmp-root-'))
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-tmp-out-'))
  const captureDir = mkdtempSync(join(tmpdir(), 'dsh-cap-'))
  const capture = join(captureDir, 'input.json')
  const wrapper = join(captureDir, 'python-wrapper.sh')
  writeFileSync(wrapper, `#!/bin/sh\ncase "$1" in\n  -c) exec /usr/bin/env python3 "$@" ;;\nesac\ncp "$2" ${JSON.stringify(capture)}\nexec /usr/bin/env python3 "$@"\n`)
  chmodSync(wrapper, 0o755)
  const previousTmp = process.env.TMPDIR
  const previousPython = process.env.DSH_TOKEN_USAGE_PYTHON
  try {
    // A crashed render's dir (older than an hour) and a fresh one that must survive.
    const stale = join(tempRoot, 'dsh-usage-stale')
    mkdirSync(stale, { recursive: true })
    writeFileSync(join(stale, 'card.json'), '{}')
    const old = Date.now() / 1000 - 2 * 60 * 60
    utimesSync(stale, old, old)
    const fresh = join(tempRoot, 'dsh-usage-fresh')
    mkdirSync(fresh, { recursive: true })
    const code = `
      import(${JSON.stringify(RENDER_URL)}).then(async (render) => {
        const { UsageLedger } = await import(${JSON.stringify(LEDGER_URL)});
        const ledger = new UsageLedger({ home: ${JSON.stringify(home)}, now: () => ${NOW} });
        await ledger.refresh();
        const out = await render.renderUsageImage({ ledger, scope: { sessionId: 'session-aaa' }, locale: 'zh-CN', now: ${NOW}, outDir: ${JSON.stringify(outDir)} });
        ledger.dispose();
        console.log(out.src);
      }).catch((error) => { console.error(error); process.exit(3); });
    `
    const src = runNodeChild(code, {
      timeout: 30_000,
      env: { TMPDIR: tempRoot, DSH_TOKEN_USAGE_PYTHON: wrapper },
    }).trim()
    assert.match(src, /^asset:usage-/)
    // The card JSON was written 0600 inside a 0700 dir, then removed with the dir.
    assert.equal(existsSync(capture), true, 'wrapper did not capture the card JSON')
    assert.equal(statSync(capture).mode & 0o777, 0o600)
    assert.equal(statSync(dirname(capture)).mode & 0o777, 0o700)
    assert.equal(existsSync(stale), false, 'stale dsh-usage-* dir must be swept')
    assert.equal(existsSync(fresh), true, 'recent dsh-usage-* dirs must not be swept')
    const leftovers = readdirSync(tempRoot).filter((name) => name.startsWith('dsh-usage-') && name !== 'dsh-usage-fresh')
    assert.deepEqual(leftovers, [], `leftover temp dirs: ${leftovers}`)
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTmp
    if (previousPython === undefined) delete process.env.DSH_TOKEN_USAGE_PYTHON
    else process.env.DSH_TOKEN_USAGE_PYTHON = previousPython
    rmSync(home, { recursive: true, force: true })
    rmSync(tempRoot, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
    rmSync(captureDir, { recursive: true, force: true })
  }
})

// ── V-09: the async probe keeps the event loop free even with a hung python ─
test('ensureRenderer probes asynchronously (a hanging interpreter does not block the loop)', { skip: !canRender() && 'host has no python3 + Pillow' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hang-'))
  const hang = join(dir, 'python-hang.sh')
  writeFileSync(hang, '#!/bin/sh\nsleep 30\n')
  chmodSync(hang, 0o755)
  try {
    const code = `
      process.env.DSH_TOKEN_USAGE_PYTHON = ${JSON.stringify(hang)};
      import(${JSON.stringify(RENDER_URL)}).then(async (m) => {
        const started = Date.now();
        const probe = m.ensureRenderer();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const tick = Date.now() - started;
        let ok = true;
        try { await probe; } catch { ok = false; }
        console.log(JSON.stringify({ tick, elapsed: Date.now() - started, ok }));
      }).catch((error) => { console.error(error); process.exit(3); });
    `
    const result = JSON.parse(runNodeChild(code, { timeout: 20_000 }).trim())
    assert.ok(result.ok, 'real python is available on this host')
    assert.ok(result.tick < 1000, `event loop blocked for ${result.tick} ms`)
    assert.ok(result.elapsed >= 2500, `the hanging candidate should have hit its 3s timeout, got ${result.elapsed} ms`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── V-04: no CJK font → English label fallback, not silent tofu ────────────
test('render.py falls back to English labels when no CJK font is available', { skip: !canRender() && 'host has no python3 + Pillow' }, async () => {
  const { home } = homeWithLog()
  writeRenderableHome(home)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fallback-'))
  try {
    const ledger = new UsageLedger({ home, now: () => NOW })
    await ledger.refresh()
    const data = cardData({ ledger, scope: { sessionId: 'session-aaa' }, locale: 'zh-CN', now: NOW })
    assert.equal(typeof data.fallback, 'object', 'cardData must carry an English fallback label set')
    const input = join(dir, 'card.json')
    writeFileSync(input, JSON.stringify(data))
    const run = (extraEnv) => {
      const env = { ...process.env, ...extraEnv }
      delete env.DSH_TOKEN_USAGE_PYTHON
      return execFileSync('python3', [RENDER_PY, input, join(dir, 'card.png')], { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', env })
    }
    const forced = JSON.parse(run({ DSH_TOKEN_USAGE_FORCE_ASCII: '1' }))
    assert.equal(forced.cjk, false)
    assert.equal(forced.title, 'Token usage')
    assert.ok(statSync(join(dir, 'card.png')).size > 5000)
    // The host (or CI runner) may or may not have a CJK font: the reported flag
    // and the drawn title must always agree, whichever way it goes.
    const normal = JSON.parse(run({ DSH_TOKEN_USAGE_FORCE_ASCII: '' }))
    if (normal.cjk) assert.equal(normal.title, 'Token 用量')
    else assert.equal(normal.title, 'Token usage')
    ledger.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── V-03: PNG secondary text must reach 4.5:1 on every painted background ──
test('render.py MUTED text meets 4.5:1 contrast on all card backgrounds', { skip: !canRender() && 'host has no python3 + Pillow' }, () => {
  const script = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location('render_card', sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
def lum(rgb):
    def channel(c):
        c = c / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (channel(x) for x in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
def ratio(a, b):
    la, lb = lum(a), lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)
muted = tuple(int(mod.MUTED[i:i + 2], 16) for i in (1, 3, 5))
bgs = [mod.tint(c) for c in ('#3D6FD6', '#258051', '#CA6328', '#167F84', '#8554BB')]
bgs.append((0xF4, 0xF6, 0xFB))
worst = min(ratio(muted, bg) for bg in bgs)
print(round(worst, 3))
sys.exit(0 if worst >= 4.5 else 1)
`
  const worst = execFileSync('python3', ['-c', script, RENDER_PY], { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' }).trim()
  assert.ok(Number(worst) >= 4.5, `worst contrast ${worst}`)
})
