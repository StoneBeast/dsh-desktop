#!/usr/bin/env node
/**
 * Fork guard: opencode-go must send `x-opencode-session` in whatever the
 * vendored runtime currently is.
 *
 * Upstream bumps `upstream.json`'s runtime version on most releases. Two things
 * can silently go wrong when it does:
 *
 *   - the fork's patch stops being referenced (upstream regenerated the `file:`
 *     resolutions) and the fix disappears while every ordinary gate still passes;
 *   - upstream ships the fix itself, and the fork's patch is then redundant or
 *     doubles up.
 *
 * Both are covered by one invariant: the header must be provided, either by the
 * fork's patch -- wired up and still applicable to the tarball the lockfile
 * resolves -- or by the vendored bundle directly.
 *
 * Usage: node fork/verify-patch-retained.mjs
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PACKAGE = '@deepseek-ai/dsh-llm-pi-ai'
const PATCH_BASENAME = 'dsh-llm-pi-ai'
const HEADER_LITERAL = 'x-opencode-session'
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

const tarballRelative = `vendor/dsh-runtime/${runtimeVersion}/deepseek-ai-${PATCH_BASENAME}-${runtimeVersion}.tgz`
const tarballPath = resolve(root, tarballRelative)
if (!existsSync(tarballPath)) fail(`missing vendored tarball ${tarballRelative}`)

const patchDirectory = resolve(root, 'patches')
const patches = existsSync(patchDirectory)
  ? readdirSync(patchDirectory).filter(name => name.startsWith(`${PATCH_BASENAME}@`))
  : []
const currentPatchRelative = `patches/${PATCH_BASENAME}@${runtimeVersion}.patch`
const currentPatchPath = resolve(root, currentPatchRelative)

const resolutions = readJson('package.json').resolutions ?? {}
const selectors = Object.keys(resolutions).filter(key => key.startsWith(`${PACKAGE}@npm:`))
if (selectors.length === 0) fail(`package.json has no resolution for ${PACKAGE}`)

// Extract once: both branches need to look inside the bundle.
const scratch = mkdtempSync(join(tmpdir(), 'fork-patch-check-'))
let bundle
try {
  // GNU tar and bsdtar read `E:\dir` as a remote host, so stage the tarball
  // inside the scratch directory and use relative paths.
  copyFileSync(tarballPath, join(scratch, 'package.tgz'))
  execFileSync('tar', ['-xzf', 'package.tgz', '--strip-components=1'], { cwd: scratch, stdio: 'pipe' })
  bundle = readFileSync(join(scratch, 'lib', 'index.js'), 'utf8')

  if (patches.length === 0) {
    // The patch was retired, which is only legitimate because upstream ships it.
    if (!bundle.includes(HEADER_LITERAL)) {
      fail(
        `no ${PATCH_BASENAME} patch and ${tarballRelative} does not send ${HEADER_LITERAL} either.\n` +
          'opencode-go would fail with 400 MissingSessionID. Restore the patch for ' +
          `${runtimeVersion}, or explain where the header now comes from.`,
      )
    }
    for (const selector of selectors) {
      if (resolutions[selector] !== `file:${tarballRelative}`) {
        fail(
          `${selector} resolves to '${resolutions[selector]}', expected 'file:${tarballRelative}' ` +
            'since the patch was retired.',
        )
      }
    }
    console.log(
      `verify-patch-retained: ${PACKAGE} @ ${runtimeVersion} sends ${HEADER_LITERAL} natively ` +
        `(fork patch retired; ${selectors.length} resolutions are file:)`,
    )
    process.exit(0)
  }

  if (!existsSync(currentPatchPath)) {
    fail(
      `missing ${currentPatchRelative} (present: ${patches.join(', ')}).\n` +
        `Upstream moved the vendored runtime to ${runtimeVersion}: re-port the patch and run\n` +
        '  corepack yarn install   # rewrites the patch: resolution and yarn.lock',
    )
  }

  for (const selector of selectors) {
    const value = resolutions[selector]
    if (!value.startsWith('patch:')) {
      fail(`${selector} resolves to '${value}', expected a patch: resolution.\nThe fork fix is not being applied.`)
    }
    if (!value.endsWith(`#./${currentPatchRelative}`)) {
      fail(`${selector} points at a different patch than ${currentPatchRelative}:\n  ${value}`)
    }
  }

  try {
    execFileSync('git', ['apply', '--check', '-p1', currentPatchPath], { cwd: scratch, stdio: 'pipe' })
  } catch (cause) {
    const detail = cause.stderr?.toString().trim() ?? String(cause)
    fail(
      `${currentPatchRelative} no longer applies to ${tarballRelative}:\n${detail}\n` +
        'The upstream bundle changed under the patch; re-port it before releasing.',
    )
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(
  `verify-patch-retained: ${PACKAGE} @ ${runtimeVersion} is patched via ${currentPatchRelative} ` +
    `(${selectors.length} resolutions, patch applies cleanly)`,
)
