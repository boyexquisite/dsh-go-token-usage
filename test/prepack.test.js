// What prepack does with assets/: remove local usage cards, and FAIL CLOSED when
// anything outside the repository allow-list would otherwise be packed. These
// tests copy the script into a temp package so the real assets/ is never touched.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(PKG, 'scripts', 'clean-assets.mjs')

function makePackage() {
  const root = mkdtempSync(join(tmpdir(), 'prepack-'))
  mkdirSync(join(root, 'scripts'), { recursive: true })
  copyFileSync(SCRIPT, join(root, 'scripts', 'clean-assets.mjs'))
  mkdirSync(join(root, 'assets'), { recursive: true })
  writeFileSync(join(root, 'assets', '.gitkeep'), '')
  writeFileSync(join(root, 'assets', 'placeholder.png'), 'placeholder')
  return root
}

function run(root) {
  try {
    const stdout = execFileSync(process.execPath, [join(root, 'scripts', 'clean-assets.mjs')], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    return { status: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }
  }
}

const assets = (root) => readdirSync(join(root, 'assets')).sort()
const ALLOWED = ['.gitkeep', 'placeholder.png']

test('prepack removes current and legacy usage images and keeps the allow-list', () => {
  const root = makePackage()
  try {
    writeFileSync(join(root, 'assets', 'usage-20261112-120000.png'), 'legacy')
    writeFileSync(join(root, 'assets', 'usage-20261113-010531-9128sy.png'), 'current')
    const result = run(root)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(assets(root), ALLOWED)
    assert.match(result.stdout, /removed 2 local usage image/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('prepack fails closed when an unknown leftover remains in assets/', () => {
  const root = makePackage()
  try {
    // A future/unknown card filename format: must block packing instead of leaking.
    writeFileSync(join(root, 'assets', 'usage-20261113-010531-CARD.png'), 'real usage numbers')
    const result = run(root)
    assert.notEqual(result.status, 0, 'packing must fail instead of shipping an unknown file')
    assert.match(result.stderr, /refusing to pack/)
    assert.match(result.stderr, /usage-20261113-010531-CARD\.png/)
    assert.deepEqual(assets(root), [...ALLOWED, 'usage-20261113-010531-CARD.png'].sort())
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('prepack exits 0 when the package has no assets directory', () => {
  const root = makePackage()
  try {
    rmSync(join(root, 'assets'), { recursive: true, force: true })
    const result = run(root)
    assert.equal(result.status, 0, result.stderr)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('prepack fails closed when a usage image path cannot be removed (root-safe variant)', () => {
  // 原 chmod 测试在 root 下会被 skip；这里用“同名目录 + 非递归 rm”稳定复现删不掉的分支，
  // 保证 fail-closed（拒绝打包）在所有 uid 下都有覆盖。
  const root = makePackage()
  const image = 'usage-20261113-010531-9128sy.png'
  try {
    mkdirSync(join(root, 'assets', image))
    writeFileSync(join(root, 'assets', image, 'not-an-image'), 'x')
    const result = run(root)
    assert.notEqual(result.status, 0, 'a usage image that cannot be removed must block packing')
    assert.match(result.stderr, /cannot remove|refusing to pack/)
    assert.ok(assets(root).includes(image), 'the card path is still there, so packing must have failed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('prepack fails closed when assets is a file instead of a directory', () => {
  const root = makePackage()
  try {
    rmSync(join(root, 'assets'), { recursive: true, force: true })
    writeFileSync(join(root, 'assets'), 'not a directory')
    const result = run(root)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /cannot read assets\//)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('prepack fails closed when a usage image cannot be removed', { skip: (process.getuid?.() === 0 && 'running as root; chmod cannot make a directory unwritable') || false }, () => {
  const root = makePackage()
  const image = 'usage-20261113-010531-9128sy.png'
  try {
    writeFileSync(join(root, 'assets', image), 'real usage numbers')
    chmodSync(join(root, 'assets'), 0o555)
    try {
      const result = run(root)
      assert.notEqual(result.status, 0, 'a card that cannot be removed must block packing')
      assert.match(result.stderr, /cannot remove|refusing to pack/)
      assert.ok(assets(root).includes(image), 'the card is still there, so packing must have failed')
    } finally {
      chmodSync(join(root, 'assets'), 0o755)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
