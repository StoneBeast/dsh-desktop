#!/usr/bin/env node
/**
 * Fork guard: the vendored opencode-go session-header patch must still be wired
 * up after a merge from upstream.
 *
 * Upstream bumps `upstream.json`'s runtime version on most releases. When that
 * happens, `scripts/sync-vendored-runtime.mjs` regenerates the `file:`
 * resolutions, `patches/dsh-llm-pi-ai@<old>.patch` stops being referenced, and
 * the fix silently disappears -- while every normal gate still passes. This
 * script fails loudly instead, and checks that the patch still applies to the
 * tarball the lockfile actually resolves.
 *
 * Usage: node fork/verify-patch-retained.mjs
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PACKAGE = '@deepseek-ai/dsh-llm-pi-ai'
const PATCH_BASENAME = 'dsh-llm-pi-ai'
const root = resolve(import.meta.dirname, '..')
const readJson = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'))
const fail = message => {
  console.error(`\nverify-patch-retained: ${message}\n`)
  process.exit(1)
}

const upstream = readJson('upstream.json')
const channel = upstream.activeChannel
const runtimeVersion = upstream.channels?.[channel]?.runtimePackageVersion
if (typeof runtimeVersion !== 'string') {
  fail(`upstream.json has no runtimePackageVersion for the active '${channel}' channel`)
}

const patchRelative = `patches/${PATCH_BASENAME}@${runtimeVersion}.patch`
const patchPath = resolve(root, patchRelative)
if (!existsSync(patchPath)) {
  fail(
    `missing ${patchRelative}.\n` +
      `Upstream moved the vendored runtime to ${runtimeVersion}: re-port the patch and run\n` +
      `  corepack yarn install   # rewrites the patch: resolution and yarn.lock`,
  )
}

const resolutions = readJson('package.json').resolutions ?? {}
const selectors = Object.keys(resolutions).filter(key => key.startsWith(`${PACKAGE}@npm:`))
if (selectors.length === 0) fail(`package.json has no resolution for ${PACKAGE}`)
for (const selector of selectors) {
  const value = resolutions[selector]
  if (!value.startsWith('patch:')) {
    fail(`${selector} resolves to '${value}', expected a patch: resolution.\nThe fork fix is not being applied.`)
  }
  if (!value.endsWith(`#./${patchRelative}`)) {
    fail(`${selector} points at a different patch than ${patchRelative}:\n  ${value}`)
  }
}

// The strongest check: the patch must still apply to the tarball the lockfile
// resolves, not merely exist on disk.
const tarballRelative = `vendor/dsh-runtime/${runtimeVersion}/deepseek-ai-${PATCH_BASENAME}-${runtimeVersion}.tgz`
const tarballPath = resolve(root, tarballRelative)
if (!existsSync(tarballPath)) fail(`missing vendored tarball ${tarballRelative}`)

const scratch = mkdtempSync(join(tmpdir(), 'fork-patch-check-'))
try {
  // GNU tar and bsdtar both read `E:\dir` or `/tmp/x:y` as a remote host spec,
  // so stage the tarball inside the scratch directory and use relative paths.
  copyFileSync(tarballPath, join(scratch, 'package.tgz'))
  execFileSync('tar', ['-xzf', 'package.tgz', '--strip-components=1'], { cwd: scratch, stdio: 'pipe' })
  try {
    execFileSync('git', ['apply', '--check', '-p1', patchPath], { cwd: scratch, stdio: 'pipe' })
  } catch (cause) {
    const detail = cause.stderr?.toString().trim() ?? String(cause)
    fail(
      `${patchRelative} no longer applies to ${tarballRelative}:\n${detail}\n` +
        'The upstream bundle changed under the patch; re-port it before releasing.',
    )
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(
  `verify-patch-retained: ${PACKAGE} @ ${runtimeVersion} is patched via ${patchRelative} ` +
    `(${selectors.length} resolutions, patch applies cleanly)`,
)
