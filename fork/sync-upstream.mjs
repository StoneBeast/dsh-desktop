#!/usr/bin/env node
/**
 * Merge anywhere-labs/dsh-desktop master into this fork, repairing the fork's
 * own changes where that is provably safe, and refusing otherwise.
 *
 * Why this is not a plain `git merge`: the fork's two changes (the vendored
 * opencode-go patch resolution, and the update-feed URLs) live on lines and in
 * files upstream also edits on every release. A runtime-bumping release rewrites
 * the very `package.json` resolution lines the patch touches, so the merge
 * conflicts every time.
 *
 * The rule applied here is narrow and checked, not assumed: for each conflicted
 * file, the fork side must differ from the MERGE BASE only in fork-owned values
 * (compared against the base, not against upstream -- during a conflict upstream
 * already carries every unrelated change). When that holds, upstream's version is
 * taken and the fork's values are re-applied by `repoint-updates.mjs` and the
 * patch re-wiring below. When it does not hold, the merge is aborted and a human
 * decides; this script never guesses.
 *
 * The merge is staged with `--no-commit` and committed once, together with the
 * repair, so a failure leaves no merged-but-broken commit behind.
 *
 * Usage:
 *   node fork/sync-upstream.mjs --repo <owner>/<name> [--upstream-ref master] [--dry-run]
 *
 * Exit codes: 0 = done (with or without changes), 2 = needs a human.
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const UPSTREAM_URL = 'https://github.com/anywhere-labs/dsh-desktop.git'
const PATCH_PACKAGE = '@deepseek-ai/dsh-llm-pi-ai'
const PATCH_UNSCOPED = 'dsh-llm-pi-ai'
const VENDOR_DIR = 'vendor/dsh-runtime'
const HEADER_LITERAL = 'x-opencode-session'
const BOT_NAME = 'github-actions[bot]'
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com'

/** The only paths a fork repair may stage; everything else is upstream-owned. */
const REPAIR_PATHS = [
  'package.json',
  'yarn.lock',
  'patches',
  'dsh-plugin-desktop/src',
  'dsh-plugin-desktop-beta/src',
]

/** Conflicted files the fork has no independent edits in: upstream's side wins outright. */
const TAKE_THEIRS_ALWAYS = new Set(['yarn.lock'])

const root = resolve(import.meta.dirname, '..')

class SyncError extends Error {}

function git(args, options = {}) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim()
}

function tryGit(args) {
  try {
    return { ok: true, out: git(args) }
  } catch (cause) {
    return { ok: false, out: String(cause.stderr ?? cause.message) }
  }
}

const log = message => console.log(`sync-upstream: ${message}`)
const fail = message => {
  throw new SyncError(message)
}

/** Merge commits need an identity; a fresh runner may have none configured. */
function ensureIdentity() {
  if (!tryGit(['config', '--get', 'user.name']).ok) git(['config', 'user.name', BOT_NAME])
  if (!tryGit(['config', '--get', 'user.email']).ok) git(['config', 'user.email', BOT_EMAIL])
}

/** stage 1 = merge base, stage 2 = ours, during a conflicted merge. */
const stageFile = (stage, path) => git(['show', `:${String(stage)}:${path}`])

/**
 * Strip the fork-owned values so the rest of a file can be compared.
 * @returns normalized text, identical to the base's iff the fork changed nothing else.
 */
function normalizeForComparison(path, text) {
  if (path === 'package.json') {
    const value = JSON.parse(text)
    for (const key of Object.keys(value.resolutions ?? {})) {
      if (key.startsWith(`${PATCH_PACKAGE}@npm:`)) delete value.resolutions[key]
    }
    return JSON.stringify(value, null, 2)
  }
  if (path.endsWith('update-checker.ts')) {
    return text.replace(/(export const DESKTOP_VERSION_ENDPOINT = ')[^']*(')/gu, '$1<URL>$2')
  }
  if (path.endsWith('update-download.ts')) {
    return text
      .replace(/(\bdarwin: ')[^']*(')/gu, '$1<URL>$2')
      .replace(/(\bwin32: ')[^']*(')/gu, '$1<URL>$2')
  }
  return text
}

/** The patch file the current vendored runtime requires, and any older ones. */
function patchState() {
  const upstream = JSON.parse(readFileSync(join(root, 'upstream.json'), 'utf8'))
  const channel = upstream.activeChannel
  const runtime = upstream.channels?.[channel]?.runtimePackageVersion
  if (typeof runtime !== 'string') fail(`upstream.json has no runtime for channel '${channel}'`)
  const patchDir = join(root, 'patches')
  const patches = existsSync(patchDir)
    ? readdirSync(patchDir).filter(name => name.startsWith(`${PATCH_UNSCOPED}@`))
    : []
  return { runtime, patches, current: `patches/${PATCH_UNSCOPED}@${runtime}.patch` }
}

/** Extract the vendored tarball so its real content can be inspected. */
function withExtractedBundle(runtime, use) {
  const relative = `${VENDOR_DIR}/${runtime}/deepseek-ai-${PATCH_UNSCOPED}-${runtime}.tgz`
  const tarball = join(root, relative)
  if (!existsSync(tarball)) fail(`missing vendored tarball ${relative}`)
  const scratch = mkdtempSync(join(tmpdir(), 'fork-sync-'))
  try {
    // GNU tar and bsdtar read `E:\dir` as a remote host, so stage the tarball
    // inside the scratch directory and use relative paths only.
    copyFileSync(tarball, join(scratch, 'package.tgz'))
    execFileSync('tar', ['-xzf', 'package.tgz', '--strip-components=1'], { cwd: scratch, stdio: 'pipe' })
    return use(scratch)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function patchApplies(patchPath, scratch) {
  try {
    execFileSync('git', ['apply', '--check', '-p1', patchPath], { cwd: scratch, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/** Rewrite the two `@deepseek-ai/dsh-llm-pi-ai` resolutions to match `runtime`. */
function writeResolutions(runtime, patchRelative) {
  const path = join(root, 'package.json')
  const value = JSON.parse(readFileSync(path, 'utf8'))
  const source = `file:${VENDOR_DIR}/${runtime}/deepseek-ai-${PATCH_UNSCOPED}-${runtime}.tgz`
  const patched = patchRelative === undefined
    ? source
    : `patch:${PATCH_PACKAGE}@${source.replace(':', '%3A')}#./${patchRelative}`
  let changed = false
  for (const key of Object.keys(value.resolutions ?? {})) {
    if (!key.startsWith(`${PATCH_PACKAGE}@npm:`)) continue
    if (value.resolutions[key] !== patched) {
      value.resolutions[key] = patched
      changed = true
    }
  }
  if (changed) writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
  return changed
}

/**
 * Make the fork's patch state consistent with the vendored runtime now on disk.
 *
 * Two outcomes are automatic: the patch still applies under the new runtime
 * version (re-ported by rename), or upstream shipped the fix itself (detected by
 * the header literal appearing in the bundle, so the patch is dropped rather than
 * duplicated). Anything else stops for a human.
 */
function reconcilePatch() {
  const { runtime, patches, current } = patchState()
  if (patches.length === 0) {
    log(`no ${PATCH_UNSCOPED} patch present; nothing to reconcile`)
    return { action: 'none' }
  }

  return withExtractedBundle(runtime, scratch => {
    const bundle = readFileSync(join(scratch, 'lib', 'index.js'), 'utf8')
    const upstreamFixed = bundle.includes(HEADER_LITERAL)

    if (upstreamFixed) {
      for (const name of patches) unlinkSync(join(root, 'patches', name))
      writeResolutions(runtime, undefined)
      log(`upstream now sends ${HEADER_LITERAL} itself; dropped ${patches.join(', ')} and restored file: resolutions`)
      return { action: 'dropped' }
    }

    if (existsSync(join(root, current))) {
      if (!patchApplies(join(root, current), scratch)) {
        fail(`${current} does not apply to the ${runtime} bundle; re-port it by hand`)
      }
      const changed = writeResolutions(runtime, current)
      log(`patch ${current} applies to ${runtime}${changed ? '; resolutions rewired' : ''}`)
      return { action: 'verified' }
    }

    // The runtime moved: carry the patch forward under its new name when the
    // anchors survived, which is the ordinary case for an additive patch.
    const oldest = [...patches].sort()[0]
    const candidate = join(root, current)
    copyFileSync(join(root, 'patches', oldest), candidate)
    if (!patchApplies(candidate, scratch)) {
      unlinkSync(candidate)
      fail(
        `the vendored bundle changed under ${oldest} and the patch no longer applies.\n` +
          `Re-port it against ${runtime} by hand, then re-run this workflow.`,
      )
    }
    for (const name of patches) unlinkSync(join(root, 'patches', name))
    writeResolutions(runtime, current)
    log(`re-ported ${oldest} -> ${current} for runtime ${runtime}`)
    return { action: 'reported' }
  })
}

/**
 * Stage the upstream merge, resolving only conflicts proven to be fork-owned.
 * Leaves the merge uncommitted so the repair can join it in one commit.
 */
function stageUpstreamMerge(upstreamUrl, upstreamRef) {
  if (tryGit(['remote', 'get-url', 'upstream']).ok) {
    git(['remote', 'set-url', 'upstream', upstreamUrl])
  } else {
    git(['remote', 'add', 'upstream', upstreamUrl])
  }
  git(['fetch', '--no-tags', 'upstream', upstreamRef])

  // Resolve through FETCH_HEAD: the fetch may target a branch, a tag, or a bare
  // SHA, and a remote-tracking ref only exists for the first of those.
  const target = git(['rev-parse', 'FETCH_HEAD'])
  if (tryGit(['merge-base', '--is-ancestor', target, 'HEAD']).ok) {
    log(`fork already contains upstream ${target.slice(0, 10)}`)
    return { merged: false }
  }
  const upstreamSha = target.slice(0, 10)

  const attempted = tryGit(['merge', '--no-commit', '--no-ff', target])
  if (attempted.ok) {
    log(`staged upstream ${upstreamSha} cleanly`)
    return { merged: true, upstreamSha }
  }

  // Conflicted: decide file by file whether the fork's edits are confined to
  // fork-owned values. A failure that left no conflict is something else
  // (identity, a dirty tree, a lock) and is reported rather than papered over.
  const conflicted = git(['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean)
  if (conflicted.length === 0) {
    fail(`merge of upstream ${upstreamSha} failed without conflicts:\n${attempted.out}`)
  }

  const unsafe = []
  for (const path of conflicted) {
    if (TAKE_THEIRS_ALWAYS.has(path)) continue
    let base
    let ours
    try {
      base = stageFile(1, path)
      ours = stageFile(2, path)
    } catch {
      unsafe.push(`${path} (no common ancestor, or deleted on one side)`)
      continue
    }
    // The fork side must differ from the merge base ONLY in fork-owned values.
    if (normalizeForComparison(path, ours) !== normalizeForComparison(path, base)) {
      unsafe.push(`${path} (the fork changed more than its own values)`)
    }
  }

  if (unsafe.length > 0) {
    fail(
      `upstream merge conflicts outside the fork-owned values:\n  - ${unsafe.join('\n  - ')}\n` +
        'Resolve locally with `git fetch upstream && git merge upstream/master`.',
    )
  }

  for (const path of conflicted) git(['checkout', '--theirs', '--', path])
  git(['add', '--', ...conflicted])
  log(`staged upstream ${upstreamSha}, resolving ${String(conflicted.length)} fork-owned conflict(s): ${conflicted.join(', ')}`)
  return { merged: true, upstreamSha, conflicts: conflicted }
}

function run(argv) {
  let repo
  let upstreamRef = 'master'
  let upstreamUrl = UPSTREAM_URL
  let dryRun = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--repo') repo = argv[++index]
    else if (arg.startsWith('--repo=')) repo = arg.slice('--repo='.length)
    else if (arg === '--upstream-ref') upstreamRef = argv[++index]
    else if (arg === '--upstream-url') upstreamUrl = argv[++index]
    else if (arg === '--dry-run') dryRun = true
    else fail(`unknown argument ${JSON.stringify(arg)}`)
  }
  if (repo === undefined) fail('pass --repo <owner>/<name> so the feed URLs can be re-applied')

  ensureIdentity()
  const merge = stageUpstreamMerge(upstreamUrl, upstreamRef)
  if (!merge.merged) {
    console.log('changed=false')
    return
  }

  const patch = reconcilePatch()

  // Re-apply the update-feed URLs: a conflicted update-checker.ts/update-download.ts
  // was resolved to upstream's side above, which restores upstream's endpoints.
  // `--urls-only` is deliberate: merging a release bumps package.json's version,
  // and rewriting the feed here would advertise a version whose Release does not
  // exist yet. Only fork-release.yml, after publishing the assets, writes the feed.
  const repoint = execFileSync(
    process.execPath,
    [join(root, 'fork', 'repoint-updates.mjs'), '--repo', repo, '--urls-only'],
    { cwd: root, encoding: 'utf8' },
  )
  const repointed = !repoint.includes('no changes needed')

  // Stage only the paths this repair owns: a bare `git add -A` would sweep
  // untracked scratch files into the commit.
  git(['add', '-A', '--', ...REPAIR_PATHS])
  const staged = git(['diff', '--cached', '--name-only']).length > 0

  if (staged && !dryRun) {
    git([
      '-c', `user.name=${BOT_NAME}`, '-c', `user.email=${BOT_EMAIL}`,
      'commit', '-m', `Merge upstream ${merge.upstreamSha} into master with the fork patch re-wired`,
    ])
    log('committed the merge and the fork repair')
  }

  log(`summary: merged=${String(merge.merged)} patch=${patch.action} repointed=${String(repointed)} staged=${String(staged)}`)
  console.log('changed=true')
}

/** Abort a half-applied merge so a failed run never leaves a merged-but-broken tree. */
function main() {
  try {
    run(process.argv.slice(2))
  } catch (error) {
    if (!(error instanceof SyncError)) throw error
    if (existsSync(join(root, '.git', 'MERGE_HEAD'))) {
      tryGit(['merge', '--abort'])
      log('merge aborted; the fork is unchanged')
    }
    console.error(`\nsync-upstream: ${error.message}\n`)
    process.exit(2)
  }
}

// Importable for tests; only the direct invocation performs the merge.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()

export { normalizeForComparison, patchState, TAKE_THEIRS_ALWAYS }
