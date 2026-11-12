#!/usr/bin/env node
// Bump the version, commit, tag and push. GitHub Actions publishes to npm and
// creates the release from the tag. Usage:
//   node scripts/release.mjs 0.1.1
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const version = process.argv[2]
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('usage: node scripts/release.mjs <major.minor.patch>')
  process.exit(1)
}
// A dirty tree would be left out of the tag (only package.json is committed here),
// so the published tarball would silently ship the previous code. Check before
// touching package.json, otherwise this script's own bump counts as dirt.
const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()
if (dirty !== '') {
  console.error('working tree is not clean; commit the changes before releasing:\n' + dirty)
  process.exit(1)
}
const file = new URL('../package.json', import.meta.url)
const pkg = JSON.parse(readFileSync(file, 'utf8'))
const previous = pkg.version
if (previous === version) {
  console.error(`package.json already at ${version}`)
  process.exit(1)
}
pkg.version = version
writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' })
run('git', ['add', 'package.json'])
run('git', ['commit', '-m', `Release ${version}`])
run('git', ['tag', '-a', `v${version}`, '-m', `dsh-go-token-usage ${version}`])
run('git', ['push', 'origin', 'HEAD'])
run('git', ['push', 'origin', `v${version}`])
console.log(`\nPushed v${version} (${previous} → ${version}); watch the publish workflow on GitHub.`)
