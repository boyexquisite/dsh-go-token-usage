// release.mjs safety checks: every rejection happens BEFORE the version bump,
// so the repository (and the remote) must be byte-for-byte unchanged afterwards.
// All repositories here are throwaway ones under the OS temp directory; nothing
// touches the real origin.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(PKG, 'scripts', 'release.mjs')
const CHANGELOG = `# Changelog

## 0.3.0

- future

## 0.2.0

- next

## 0.1.0

- initial
`

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'release-'))
  mkdirSync(join(root, 'scripts'), { recursive: true })
  copyFileSync(SCRIPT, join(root, 'scripts', 'release.mjs'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'release-test', version: '0.1.0' }, null, 2) + '\n')
  writeFileSync(join(root, 'CHANGELOG.md'), CHANGELOG)
  const remoteParent = mkdtempSync(join(tmpdir(), 'release-remote-'))
  const remote = join(remoteParent, 'origin.git')
  execFileSync('git', ['init', '--bare', '-q', remote], { stdio: 'ignore' })
  git(root, ['init', '-q', '-b', 'main'])
  git(root, ['config', 'user.email', 'release-test@example.invalid'])
  git(root, ['config', 'user.name', 'release test'])
  git(root, ['add', '-A'])
  git(root, ['commit', '-qm', 'initial 0.1.0'])
  git(root, ['remote', 'add', 'origin', remote])
  git(root, ['push', '-q', 'origin', 'main'])
  return { root, remote, remoteParent }
}

function destroy(ctx) {
  rmSync(ctx.root, { recursive: true, force: true })
  rmSync(ctx.remoteParent, { recursive: true, force: true })
}

function run(ctx, args, cwd = ctx.root) {
  return spawnSync(process.execPath, [join(ctx.root, 'scripts', 'release.mjs'), ...args], { cwd, encoding: 'utf8' })
}

function snapshot(ctx) {
  return {
    version: JSON.parse(readFileSync(join(ctx.root, 'package.json'), 'utf8')).version,
    head: git(ctx.root, ['rev-parse', 'HEAD']),
    tags: git(ctx.root, ['tag', '--list']),
    status: git(ctx.root, ['status', '--porcelain']),
    remoteHead: git(ctx.remote, ['rev-parse', 'main']),
    remoteTags: git(ctx.remote, ['tag', '--list']),
  }
}

test('rejects a release from a non-main branch without changing anything', () => {
  const ctx = setup()
  try {
    git(ctx.root, ['checkout', '-q', '-b', 'feature-x'])
    const before = snapshot(ctx)
    const result = run(ctx, ['0.2.0'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /refusing to release from branch "feature-x"/)
    const declared = run(ctx, ['0.2.0', '--branch', 'main'])
    assert.equal(declared.status, 1, '--branch must not override the checked-out branch')
    assert.deepEqual(snapshot(ctx), before)
  } finally {
    destroy(ctx)
  }
})

test('rejects a downgrade without changing anything', () => {
  const ctx = setup()
  try {
    const before = snapshot(ctx)
    const result = run(ctx, ['0.0.9'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /refusing to downgrade/)
    assert.deepEqual(snapshot(ctx), before)
  } finally {
    destroy(ctx)
  }
})

test('rejects invalid version arguments without changing anything', () => {
  const ctx = setup()
  try {
    const before = snapshot(ctx)
    for (const bad of ['01.2.3', 'v1.2.3', '1.2', '1.2.3.4', '0.1']) {
      const result = run(ctx, [bad])
      assert.equal(result.status, 1, `version ${bad} must be rejected`)
      assert.match(result.stderr, /invalid version/, bad)
    }
    const missing = run(ctx, [])
    assert.equal(missing.status, 1)
    assert.deepEqual(snapshot(ctx), before)
  } finally {
    destroy(ctx)
  }
})

test('rejects a dirty working tree before touching package.json', () => {
  const ctx = setup()
  try {
    const before = snapshot(ctx)
    writeFileSync(join(ctx.root, 'dirty.txt'), 'x')
    const result = run(ctx, ['0.2.0'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /working tree is not clean/)
    const after = snapshot(ctx)
    for (const key of ['version', 'head', 'tags', 'remoteHead', 'remoteTags']) assert.deepEqual(after[key], before[key], key)
    assert.equal(after.status, '?? dirty.txt')
  } finally {
    destroy(ctx)
  }
})

test('rejects a version whose local tag already exists', () => {
  const ctx = setup()
  try {
    git(ctx.root, ['tag', '-a', 'v0.2.0', '-m', 'taken'])
    const before = snapshot(ctx)
    const result = run(ctx, ['0.2.0'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /already exists locally/)
    assert.deepEqual(snapshot(ctx), before)
  } finally {
    destroy(ctx)
  }
})

test('rejects a version whose tag already exists on the remote', () => {
  const ctx = setup()
  try {
    git(ctx.root, ['tag', '-a', 'v0.3.0', '-m', 'taken'])
    git(ctx.root, ['push', '-q', 'origin', 'v0.3.0'])
    git(ctx.root, ['tag', '-d', 'v0.3.0'])
    const before = snapshot(ctx)
    const result = run(ctx, ['0.3.0'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /already exists on origin/)
    assert.deepEqual(snapshot(ctx), before)
  } finally {
    destroy(ctx)
  }
})

test('rejects a version with no CHANGELOG section', () => {
  const ctx = setup()
  try {
    const before = snapshot(ctx)
    const result = run(ctx, ['0.4.0'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /CHANGELOG\.md has no "## 0\.4\.0" section/)
    assert.deepEqual(snapshot(ctx), before)
  } finally {
    destroy(ctx)
  }
})

test('rejects a version with an empty CHANGELOG section', () => {
  const ctx = setup()
  try {
    writeFileSync(join(ctx.root, 'CHANGELOG.md'), CHANGELOG + '\n## 0.5.0\n')
    git(ctx.root, ['add', 'CHANGELOG.md'])
    git(ctx.root, ['commit', '-qm', 'empty 0.5.0 section'])
    const before = snapshot(ctx)
    const result = run(ctx, ['0.5.0'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /section "## 0\.5\.0" is empty/)
    assert.deepEqual(snapshot(ctx), before)
  } finally {
    destroy(ctx)
  }
})

test('rejects a release when the caller is standing in a different repository', () => {
  const ctx = setup()
  const otherParent = mkdtempSync(join(tmpdir(), 'release-other-'))
  const other = join(otherParent, 'other-repo')
  try {
    mkdirSync(other)
    git(other, ['init', '-q', '-b', 'main'])
    git(other, ['config', 'user.email', 'release-test@example.invalid'])
    git(other, ['config', 'user.name', 'release test'])
    writeFileSync(join(other, 'package.json'), '{"name":"other","version":"1.0.0"}\n')
    git(other, ['add', '-A'])
    git(other, ['commit', '-qm', 'other repo'])
    const before = snapshot(ctx)
    const result = run(ctx, ['0.2.0'], other)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /run this script from the repository root/)
    assert.deepEqual(snapshot(ctx), before)
    assert.equal(git(other, ['status', '--porcelain']), '')
  } finally {
    rmSync(otherParent, { recursive: true, force: true })
    destroy(ctx)
  }
})

test('rejects a release when the local branch is behind origin', () => {
  const ctx = setup()
  try {
    writeFileSync(join(ctx.root, 'note.txt'), 'x')
    git(ctx.root, ['add', 'note.txt'])
    git(ctx.root, ['commit', '-qm', 'ahead of local branch'])
    git(ctx.root, ['push', '-q', 'origin', 'main'])
    git(ctx.root, ['reset', '--hard', 'HEAD~1'])
    const before = snapshot(ctx)
    const result = run(ctx, ['0.2.0'])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /behind or diverged from origin\/main/)
    assert.deepEqual(snapshot(ctx), before)
  } finally {
    destroy(ctx)
  }
})

test('--dry-run prints the plan and changes nothing', () => {
  const ctx = setup()
  try {
    const before = snapshot(ctx)
    const result = run(ctx, ['0.2.0', '--dry-run'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /\[dry-run\]/)
    assert.match(result.stdout, /0\.1\.0 → 0\.2\.0/)
    assert.match(result.stdout, /git push --atomic origin HEAD:refs\/heads\/main refs\/tags\/v0\.2\.0/)
    assert.deepEqual(snapshot(ctx), before)
  } finally {
    destroy(ctx)
  }
})

test('a clean release on main bumps, commits, tags and pushes atomically', () => {
  const ctx = setup()
  try {
    const before = snapshot(ctx)
    const result = run(ctx, ['0.2.0'])
    assert.equal(result.status, 0, result.stderr + result.stdout)
    assert.equal(JSON.parse(readFileSync(join(ctx.root, 'package.json'), 'utf8')).version, '0.2.0')
    assert.equal(git(ctx.root, ['tag', '--list']), 'v0.2.0')
    assert.equal(git(ctx.root, ['status', '--porcelain']), '')
    assert.equal(git(ctx.remote, ['tag', '--list']), 'v0.2.0')
    assert.equal(git(ctx.remote, ['rev-parse', 'main']), git(ctx.root, ['rev-parse', 'HEAD']))
    assert.equal(git(ctx.root, ['rev-parse', 'HEAD~1']), before.head)
    assert.equal(readFileSync(join(ctx.root, 'CHANGELOG.md'), 'utf8'), CHANGELOG)
  } finally {
    destroy(ctx)
  }
})
