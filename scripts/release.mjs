#!/usr/bin/env node
// Release helper: bump the version, commit, tag and push atomically. GitHub
// Actions publishes to npm and creates the release from the tag.
//
//   node scripts/release.mjs 0.2.8
//   node scripts/release.mjs 0.2.8 --dry-run          # preflight only, no changes
//   node scripts/release.mjs 0.2.8 --branch main      # expected branch (default main)
//
// Safety model: every check runs BEFORE anything is written. The version bump,
// commit, tag and push then happen as one sequence; the push is atomic, so the
// remote never ends up with a tag but no branch (or vice versa). When a local
// step fails after the bump, a rollback hint is printed.
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const BRANCH = /^[A-Za-z0-9._/-]+$/
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const pkgPath = join(repoRoot, 'package.json')
const changelogPath = join(repoRoot, 'CHANGELOG.md')

function fail(message) {
  console.error(message)
  process.exit(1)
}

const usage = `usage: node scripts/release.mjs <major.minor.patch> [--branch <name>] [--dry-run]

Runs only on the expected branch (default: main) from a clean worktree, refuses
downgrades, existing tags and a version with no CHANGELOG section, then bumps
package.json, commits, tags and pushes branch + tag atomically.

  --branch <name>  branch the release must run on (default: main)
  --dry-run        run every preflight check and print the plan; change nothing
  -h, --help       show this help`

// ── arguments ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
let version
let branch = 'main'
let dryRun = false
let help = false
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]
  if (arg === '--dry-run') { dryRun = true; continue }
  if (arg === '--help' || arg === '-h') { help = true; continue }
  if (arg === '--branch') {
    branch = args[(i += 1)]
    continue
  }
  if (arg.startsWith('--branch=')) { branch = arg.slice('--branch='.length); continue }
  if (arg.startsWith('-')) fail(`unknown option: ${arg}\n\n${usage}`)
  if (version !== undefined) fail(`unexpected argument: ${arg}\n\n${usage}`)
  version = arg
}
if (help) {
  console.log(usage)
  process.exit(0)
}
if (version === undefined || !SEMVER.test(version)) {
  fail(`invalid version: ${version ?? '(missing)'} — expected strict major.minor.patch (no leading zeros)\n\n${usage}`)
}
if (branch === undefined || branch === '' || !BRANCH.test(branch)) fail(`invalid branch name: ${branch}`)

// ── git helpers (always run inside this repository, never in the caller's cwd) ─
function git(argv, options = {}) {
  try {
    return execFileSync('git', argv, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
  } catch (error) {
    const stderr = String(error?.stderr ?? '').trim()
    // Preflight failures happen before anything is written, so there is nothing
    // to roll back; report them without a stack trace.
    fail(`git ${argv.join(' ')} failed${stderr === '' ? '' : `: ${stderr}`}`)
  }
}
function gitRun(argv) {
  execFileSync('git', argv, { cwd: repoRoot, stdio: 'inherit' })
}
function isAncestor(rev, ancestorOf) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', rev, ancestorOf], { cwd: repoRoot, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// ── preflight: repository root ──────────────────────────────────────────────
// package.json is resolved from the script location, so it is only safe when the
// caller is standing in this same worktree. Otherwise git would act on a
// different repository than the file we bump.
let cwdTop = null
try {
  // Deliberately run in the caller's cwd: this is the check that catches running
  // the script from a different repository.
  cwdTop = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
} catch {
  cwdTop = null
}
if (cwdTop === null || realpathSync(cwdTop) !== realpathSync(repoRoot)) {
  fail(`refusing to release: run this script from the repository root (${repoRoot}), not from "${process.cwd()}"`)
}

// ── preflight: branch, worktree, version, changelog, tags ───────────────────
const currentBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()
if (currentBranch !== branch) {
  fail(`refusing to release from branch "${currentBranch}": releases run on "${branch}".
Check out that branch first, or pass --branch <name> to declare the expected branch.`)
}

const dirty = git(['status', '--porcelain']).trim()
if (dirty !== '') {
  fail('working tree is not clean; commit the changes before releasing:\n' + dirty)
}

let pkg
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
} catch (error) {
  fail(`cannot read package.json: ${error.message}`)
}
const previous = String(pkg.version ?? '')
const previousParts = SEMVER.test(previous) ? previous.split('.').map(Number) : null
if (previousParts === null) fail(`package.json has a non-semver version: ${previous}`)
const nextParts = version.split('.').map(Number)
const order = nextParts[0] - previousParts[0] || nextParts[1] - previousParts[1] || nextParts[2] - previousParts[2]
if (order === 0) fail(`package.json is already at ${version}`)
if (order < 0) fail(`refusing to downgrade: ${previous} → ${version} (new version must be higher)`)

let changelog
try {
  changelog = readFileSync(changelogPath, 'utf8')
} catch {
  fail('CHANGELOG.md is missing; add a "## <version>" section before releasing')
}
const changelogLines = changelog.split(/\r?\n/)
const heading = changelogLines.findIndex((line) => line.trim() === `## ${version}`)
if (heading === -1) fail(`CHANGELOG.md has no "## ${version}" section; add it before releasing`)
let sectionEnd = changelogLines.length
for (let i = heading + 1; i < changelogLines.length; i += 1) {
  if (/^##\s/.test(changelogLines[i])) { sectionEnd = i; break }
}
if (changelogLines.slice(heading + 1, sectionEnd).join('\n').trim() === '') {
  fail(`CHANGELOG.md section "## ${version}" is empty; describe the release before releasing`)
}

const localTag = git(['tag', '--list', `v${version}`]).trim()
if (localTag !== '') fail(`tag v${version} already exists locally; pick a new version or delete the tag`)

// Remote checks use ls-remote (read-only: it does not move local refs, so
// --dry-run stays side-effect free and there is no need for git fetch).
const remoteTag = git(['ls-remote', '--tags', 'origin', `refs/tags/v${version}`]).trim()
if (remoteTag !== '') fail(`tag v${version} already exists on origin; pick a new version`)

const remoteHeadLine = git(['ls-remote', 'origin', `refs/heads/${branch}`]).trim()
if (remoteHeadLine !== '') {
  const remoteHead = remoteHeadLine.split(/\s+/)[0]
  if (!isAncestor(remoteHead, 'HEAD')) {
    fail(`local branch "${branch}" is behind or diverged from origin/${branch}.
Run "git pull --rebase origin ${branch}" (or reset to origin/${branch}) and try again.`)
  }
}

// ── plan / mutate ───────────────────────────────────────────────────────────
const pushArgs = ['push', '--atomic', 'origin', `HEAD:refs/heads/${branch}`, `refs/tags/v${version}`]
if (dryRun) {
  console.log(`[dry-run] repository: ${repoRoot}`)
  console.log(`[dry-run] branch:     ${branch} (clean)`)
  console.log(`[dry-run] version:    ${previous} → ${version} (CHANGELOG "## ${version}" present)`)
  console.log(`[dry-run] would commit: "Release ${version}"`)
  console.log(`[dry-run] would tag:    v${version}`)
  console.log(`[dry-run] would run:    git ${pushArgs.join(' ')}`)
  console.log('[dry-run] no files or git refs were changed')
  process.exit(0)
}

let written = false
let committed = false
let tagged = false
try {
  pkg.version = version
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  written = true
  gitRun(['add', 'package.json'])
  gitRun(['commit', '-m', `Release ${version}`])
  committed = true
  gitRun(['tag', '-a', `v${version}`, '-m', `dsh-go-token-usage ${version}`])
  tagged = true
  console.log(`Pushing branch ${branch} and tag v${version} atomically…`)
  gitRun(pushArgs)
} catch (error) {
  console.error(`\nrelease failed: ${error.message}`)
  console.error('\nThe remote was NOT changed (the push is atomic). To undo the local steps:')
  if (committed) console.error(`  git reset --hard HEAD~1        # drop the local "Release ${version}" commit (version bump only)`)
  else if (written) console.error('  git restore package.json       # undo the local version bump')
  if (tagged) console.error(`  git tag -d v${version}`)
  console.error('Then fix the reported problem and run the script again.')
  process.exit(1)
}

console.log(`\nPushed v${version} (${previous} → ${version}) to origin/${branch}; watch the publish workflow on GitHub.`)
