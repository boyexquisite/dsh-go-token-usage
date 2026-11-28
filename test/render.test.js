import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import zlib from 'node:zlib'
import { UsageLedger } from '../lib/ledger.js'
import { canRender, cardData, ensureRenderer, pickTempDir, renderUsageImage, safeEnsureDir } from '../lib/render.js'
import { resolveExecutable } from '../lib/exec.js'
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
const EXEC_URL = pathToFileURL(join(PKG_ROOT, 'lib', 'exec.js')).href
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
  const modes = join(captureDir, 'modes.txt')
  const wrapper = join(captureDir, 'python-wrapper.sh')
  // 2026-11-28 审查 P2-3：记录渲染进程**真正看到**的输入文件与它的临时目录的权限
  // （$2 的父目录），而不是测试自己建的 captureDir。
  const statCode = 'const fs=require("node:fs"),p=require("node:path");const f=process.argv[1];fs.writeFileSync(process.argv[2],[(fs.statSync(f).mode&0o777).toString(8),(fs.statSync(p.dirname(f)).mode&0o777).toString(8)].join("\\n"))'
  writeFileSync(wrapper, `#!/bin/sh\ncase "$1" in\n  -c) exec /usr/bin/env python3 "$@" ;;\nesac\ncp "$2" ${JSON.stringify(capture)}\n${JSON.stringify(process.execPath)} -e ${JSON.stringify(statCode)} "$2" ${JSON.stringify(modes)}\nexec /usr/bin/env python3 "$@"\n`)
  chmodSync(wrapper, 0o755)
  // 2026-11-28: 清理只发生在插件自己的 base（`dsh-usage-<uid>`）里面，而且只按
  // `run-` 前缀 + 年龄删。base 之外的任何同名条目都不再触碰。
  const uid = process.getuid?.()
  const base = join(tempRoot, `dsh-usage-${uid === undefined ? 'u' : uid}`)
  mkdirSync(base, { mode: 0o700 })
  chmodSync(base, 0o700)
  const previousTmp = process.env.TMPDIR
  const previousPython = process.env.DSH_TOKEN_USAGE_PYTHON
  try {
    const old = Date.now() / 1000 - 2 * 60 * 60
    // Our own crashed render: inside the base, `run-*`, older than an hour.
    const stale = join(base, 'run-stale')
    mkdirSync(stale, { recursive: true })
    writeFileSync(join(stale, 'card.json'), '{}')
    utimesSync(stale, old, old)
    // A recent one from a concurrent draw: must survive.
    const fresh = join(base, 'run-fresh')
    mkdirSync(fresh, { recursive: true })
    // An unrelated directory with our prefix, at the shared TMPDIR root.
    const foreign = join(tempRoot, 'dsh-usage-someone-else')
    mkdirSync(foreign, { recursive: true })
    writeFileSync(join(foreign, 'keep.txt'), 'keep')
    utimesSync(foreign, old, old)
    // A symlinked `dsh-usage-*` entry: following it (old code) would unlink it.
    const linkTarget = join(tempRoot, 'link-target')
    mkdirSync(linkTarget)
    utimesSync(linkTarget, old, old)
    const link = join(tempRoot, 'dsh-usage-link')
    symlinkSync(linkTarget, link)
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
    // 0600 的卡 JSON，放在 0700 的私有临时目录里（这里查的是插件实际用的那个目录）。
    assert.deepEqual(existsSync(modes) ? readFileSync(modes, 'utf8').trim().split('\n') : [], ['600', '700'])
    assert.equal(statSync(base).mode & 0o777, 0o700, 'the plugin base stays 0700')
    // 先断言"不越界"，旧实现会最先倒在这里（它把 base 外的同名目录和链接一起删了）。
    assert.equal(existsSync(foreign), true, 'an unrelated dsh-usage-* dir outside the base must survive')
    assert.equal(readFileSync(join(foreign, 'keep.txt'), 'utf8'), 'keep', 'its contents must be untouched')
    assert.equal(lstatSync(link).isSymbolicLink(), true, 'a dsh-usage-* symlink must not be unlinked')
    assert.equal(existsSync(linkTarget), true)
    assert.equal(existsSync(stale), false, 'a stale run-* dir inside the base must be swept')
    assert.equal(existsSync(fresh), true, 'a recent run-* dir inside the base must survive')
    const leftovers = readdirSync(base).filter((name) => name.startsWith('run-') && name !== 'run-fresh')
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
      // 测试直接跑仓内 render.py，别在 scripts/ 下留 __pycache__。
      env.PYTHONDONTWRITEBYTECODE = '1'
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
  // importlib 加载 render.py 时同样会写 __pycache__，测试里一律关掉。
  const worst = execFileSync('python3', ['-c', script, RENDER_PY], {
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  }).trim()
  assert.ok(Number(worst) >= 4.5, `worst contrast ${worst}`)
})

// ── 2026-11-28: DSH_TOKEN_USAGE_PYTHON 覆盖值必须过同一道信任检查 ──────────
test('an untrusted DSH_TOKEN_USAGE_PYTHON override is never probed', { skip: !canRender() && 'host has no python3 + Pillow' }, () => {
  const tools = mkdtempSync(join(tmpdir(), 'dsh-bad-python-'))
  const marker = join(tools, 'executed')
  const canary = (path) => {
    writeFileSync(path, `#!/bin/sh\n: > ${JSON.stringify(marker)}\nexit 0\n`)
    chmodSync(path, 0o755)
  }
  try {
    chmodSync(tools, 0o700)
    // ① 世界可写文件 ② 可写祖先目录下的文件 ③ 别人 uid 的文件
    const world = join(tools, 'world.sh')
    canary(world)
    chmodSync(world, 0o777)
    const loose = join(tools, 'loose')
    mkdirSync(loose)
    chmodSync(loose, 0o777)
    const under = join(loose, 'under.sh')
    canary(under)
    const overrides = [world, under]
    if (process.getuid?.() === 0) {
      const foreign = join(tools, 'foreign.sh')
      canary(foreign)
      chownSync(foreign, 65534, 65534)
      overrides.push(foreign)
    }
    const code = `
      process.env.DSH_TOKEN_USAGE_PYTHON = process.env.BAD_PYTHON;
      Promise.all([import(${JSON.stringify(RENDER_URL)}), import(${JSON.stringify(EXEC_URL)})]).then(async ([render, exec]) => {
        // 同步 canRender() 先跑一遍（同样要跳过坏覆盖），再走异步探测。
        const can = render.canRender();
        const bin = await render.ensureRenderer();
        console.log(JSON.stringify({ bin, can, canAfter: render.canRender(), trusted: exec.isTrustedExecutable(bin) }));
      }).catch((error) => { console.error(error); process.exit(3); });
    `
    for (const bad of overrides) {
      const result = JSON.parse(runNodeChild(code, { timeout: 20_000, env: { BAD_PYTHON: bad } }).trim())
      assert.notEqual(result.bin, bad, `an untrusted override must not win: ${bad}`)
      assert.equal(result.trusted, true, `the fallback for ${bad} must be a trusted interpreter`)
      assert.equal(result.can, true, 'canRender() must also skip the untrusted override')
      assert.equal(result.canAfter, true)
    }
    assert.equal(existsSync(marker), false, 'no untrusted candidate may be probed or executed')
  } finally {
    rmSync(tools, { recursive: true, force: true })
  }
})

// ── 2026-11-28: 出图文件在 Python 启动前就必须是 0600 ──────────────────────
test('the card file is created 0600 before the renderer opens it', { skip: !canRender() && 'host has no python3 + Pillow' }, () => {
  const { home } = homeWithLog()
  writeRenderableHome(home)
  const tools = mkdtempSync(join(tmpdir(), 'dsh-mode-'))
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-mode-out-'))
  const marker = join(tools, 'mode.txt')
  const python = resolveExecutable('python3') ?? '/usr/bin/python3'
  const wrapper = join(tools, 'python-wrapper.sh')
  writeFileSync(wrapper, [
    '#!/bin/sh',
    `if [ "$1" = "-c" ]; then exec ${JSON.stringify(python)} "$@"; fi`,
    // 记录 render.py 打开目标文件那一刻的权限：node -e code <marker> <target>
    `${JSON.stringify(process.execPath)} -e 'const fs=require("node:fs");fs.writeFileSync(process.argv[1], (fs.statSync(process.argv[2]).mode & 0o777).toString(8))' ${JSON.stringify(marker)} "$3"`,
    `exec ${JSON.stringify(python)} "$@"`,
    '',
  ].join('\n'))
  chmodSync(wrapper, 0o755)
  const failing = join(tools, 'python-failing.sh')
  writeFileSync(failing, `#!/bin/sh\nif [ "$1" = "-c" ]; then exec ${JSON.stringify(python)} "$@"; fi\nexit 7\n`)
  chmodSync(failing, 0o755)
  const code = (bin) => `
    process.env.DSH_TOKEN_USAGE_PYTHON = ${JSON.stringify(bin)};
    Promise.all([import(${JSON.stringify(RENDER_URL)}), import(${JSON.stringify(LEDGER_URL)})]).then(async ([render, { UsageLedger }]) => {
      const ledger = new UsageLedger({ home: ${JSON.stringify(home)}, now: () => ${NOW} });
      await ledger.refresh();
      try {
        const out = await render.renderUsageImage({ ledger, scope: { sessionId: 'session-aaa' }, locale: 'zh-CN', now: ${NOW}, outDir: ${JSON.stringify(outDir)} });
        ledger.dispose();
        console.log(JSON.stringify({ ok: true, file: out.file }));
      } catch (error) {
        ledger.dispose();
        console.log(JSON.stringify({ ok: false, message: error.message }));
      }
    }).catch((error) => { console.error(error); process.exit(3); });
  `
  try {
    const good = JSON.parse(runNodeChild(code(wrapper), { timeout: 30_000 }).trim())
    assert.equal(good.ok, true, good.message)
    assert.equal(readFileSync(marker, 'utf8').trim(), '600', 'Python must see a 0600 file from the very start')
    assert.equal(statSync(good.file).mode & 0o777, 0o600)
    rmSync(good.file, { force: true })
    // 失败路径：解释器报错时，预创建的空文件不能留下来。
    const bad = JSON.parse(runNodeChild(code(failing), { timeout: 30_000 }).trim())
    assert.equal(bad.ok, false, 'a failing renderer must surface as an error')
    assert.equal(readdirSync(outDir).filter((name) => name.endsWith('.png')).length, 0, 'no half-written PNG may survive')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(tools, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
})

// ── 2026-11-28: 可信的覆盖值（自建 0700 目录里的脚本）仍然能出图 ──────────
test('a trusted DSH_TOKEN_USAGE_PYTHON override can still draw the card', { skip: !canRender() && 'host has no python3 + Pillow' }, () => {
  const { home } = homeWithLog()
  writeRenderableHome(home)
  const tools = mkdtempSync(join(tmpdir(), 'dsh-trust-py-'))
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-trust-out-'))
  const fake = join(tools, 'python')
  // 最小假解释器：`-c 'import PIL'` 直接成功；渲染时写 PNG 签名并打印尺寸 JSON。
  writeFileSync(fake, [
    '#!/bin/sh',
    'if [ "$1" = "-c" ]; then exit 0; fi',
    'printf "\\211PNG\\r\\n\\032\\n" > "$3"',
    'printf "{\\"width\\":1080,\\"height\\":1500}"',
    '',
  ].join('\n'))
  chmodSync(fake, 0o755)
  const code = `
    process.env.DSH_TOKEN_USAGE_PYTHON = ${JSON.stringify(fake)};
    Promise.all([import(${JSON.stringify(RENDER_URL)}), import(${JSON.stringify(LEDGER_URL)})]).then(async ([render, { UsageLedger }]) => {
      const ledger = new UsageLedger({ home: ${JSON.stringify(home)}, now: () => ${NOW} });
      await ledger.refresh();
      try {
        const out = await render.renderUsageImage({ ledger, scope: { sessionId: 'session-aaa' }, locale: 'zh-CN', now: ${NOW}, outDir: ${JSON.stringify(outDir)} });
        ledger.dispose();
        console.log(JSON.stringify({ ok: true, src: out.src, aspect: out.aspect, file: out.file }));
      } catch (error) {
        ledger.dispose();
        console.log(JSON.stringify({ ok: false, message: error.message }));
      }
    }).catch((error) => { console.error(error); process.exit(3); });
  `
  try {
    const out = JSON.parse(runNodeChild(code, { timeout: 30_000 }).trim())
    assert.equal(out.ok, true, out.message)
    assert.match(out.src, /^asset:usage-\d{8}-\d{6}-[a-z0-9]+\.png$/)
    assert.equal(out.aspect, 0.72)
    assert.equal(statSync(out.file).mode & 0o777, 0o600)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(tools, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
})
