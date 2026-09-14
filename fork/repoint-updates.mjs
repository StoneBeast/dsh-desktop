#!/usr/bin/env node
/**
 * Point this fork's "check for updates" at the fork's own releases.
 *
 * DSH Desktop has no update-feed configuration: the version endpoint and both
 * installer endpoints are hardcoded string constants in each of the two Desktop
 * workspaces, so repointing them is a source change. This script rewrites all
 * six constants and regenerates the two version-feed documents.
 *
 * Because the feeds are channel-specific (stable versions carry no prerelease,
 * beta versions are `X.Y.Z-beta.N`, and the checker rejects a mismatched
 * `channel` field), the stable and beta workspaces get separate feed URLs.
 *
 * Usage:
 *   node fork/repoint-updates.mjs --repo <owner>/<name> [--branch master]
 *   node fork/repoint-updates.mjs --urls-only      # source constants only, never the feed
 *   node fork/repoint-updates.mjs --feed-only
 *   node fork/repoint-updates.mjs --restore        # back to upstream endpoints
 *
 * `--urls-only` exists for the upstream-sync path: merging a new upstream release
 * bumps the version in package.json, and regenerating the feed then would
 * advertise a version whose Release does not exist yet -- the app would offer an
 * update, download the previous installer, and loop. Only the release workflow,
 * which runs after the assets are published, may write the feed.
 *
 * Downloads use `releases/latest/download/<asset>`, which GitHub answers with a
 * 302 to the asset. The Desktop downloader follows redirects, and it validates
 * only magic bytes (PE for .exe, DMG trailer for .dmg), so stable, version-less
 * asset names from the release workflow work as feed targets.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const UPSTREAM_VERSION_ENDPOINT = 'https://www.dshdesktop.cn/api/desktop/version'
const UPSTREAM_MAC_URL = 'https://www.dshdesktop.cn/api/downloads/mac'
const UPSTREAM_WINDOWS_URL = 'https://www.dshdesktop.cn/api/downloads/windows'

const WINDOWS_ASSET = 'DSH-Desktop-windows-x64-Setup.exe'
const MAC_ASSET = 'DSH-Desktop-mac-universal.dmg'

const STABLE_WORKSPACE = 'dsh-plugin-desktop'
const BETA_WORKSPACE = 'dsh-plugin-desktop-beta'

const VERSION_ENDPOINT_PATTERN = /(export const DESKTOP_VERSION_ENDPOINT = ')([^']*)(')/u
const MAC_URL_PATTERN = /(\bdarwin: ')([^']*)(')/u
const WINDOWS_URL_PATTERN = /(\bwin32: ')([^']*)(')/u

const root = resolve(import.meta.dirname, '..')
const fail = message => {
  console.error(`\nrepoint-updates: ${message}\n`)
  process.exit(1)
}

function parseArgs(argv) {
  const options = { branch: 'master', feedOnly: false, restore: false, urlsOnly: false, repo: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--feed-only') options.feedOnly = true
    else if (arg === '--urls-only') options.urlsOnly = true
    else if (arg === '--restore') options.restore = true
    else if (arg === '--repo') options.repo = argv[++index]
    else if (arg.startsWith('--repo=')) options.repo = arg.slice('--repo='.length)
    else if (arg === '--branch') options.branch = argv[++index]
    else if (arg.startsWith('--branch=')) options.branch = arg.slice('--branch='.length)
    else fail(`unknown argument ${JSON.stringify(arg)}`)
  }
  return options
}

/**
 * Apply every edit only after all patterns matched, so a shape change upstream
 * cannot leave the tree half-repointed.
 * @param edits - `{ file, pattern, value, label }` records to validate and apply.
 * @param changed - accumulator receiving every file this run rewrote.
 */
function applyEdits(edits, changed) {
  const loaded = new Map()
  for (const edit of edits) {
    const path = resolve(root, edit.file)
    if (!loaded.has(path)) loaded.set(path, readFileSync(path, 'utf8'))
    if (!edit.pattern.test(loaded.get(path))) {
      fail(`${edit.file}: could not find ${edit.label}; upstream changed its shape`)
    }
  }

  for (const edit of edits) {
    const path = resolve(root, edit.file)
    const before = loaded.get(path)
    const after = before.replace(edit.pattern, (_match, head, _old, tail) => `${head}${edit.value}${tail}`)
    if (before !== after) {
      loaded.set(path, after)
      if (!changed.includes(edit.file)) changed.push(edit.file)
    }
  }

  for (const path of loaded.keys()) writeFileSync(path, loaded.get(path))
}

/** Regenerate the two version-feed documents from the workspaces' own versions. */
function writeFeeds(changed) {
  const directory = resolve(root, 'fork/update-feed')
  mkdirSync(directory, { recursive: true })
  for (const [channel, workspace] of [['stable', STABLE_WORKSPACE], ['beta', BETA_WORKSPACE]]) {
    const version = JSON.parse(readFileSync(resolve(root, workspace, 'package.json'), 'utf8')).version
    if (channel === 'stable' && version.includes('-')) {
      fail(`${STABLE_WORKSPACE} version ${version} has a prerelease tag; the stable feed requires plain X.Y.Z`)
    }
    if (channel === 'beta' && !/^\d+\.\d+\.\d+-beta\.\d+$/u.test(version)) {
      fail(`${BETA_WORKSPACE} version ${version} must look like X.Y.Z-beta.N for the beta feed`)
    }
    const relative = `fork/update-feed/${channel}.json`
    const body = `${JSON.stringify({ version, channel }, null, 2)}\n`
    let current
    try {
      current = readFileSync(resolve(root, relative), 'utf8')
    } catch {
      current = undefined
    }
    if (current !== body) {
      writeFileSync(resolve(root, relative), body)
      changed.push(relative)
    }
  }
}

function report(changed, options = {}) {
  if (changed.length === 0) {
    console.log(`repoint-updates: no changes needed${options.restore ? ' (already upstream)' : ''}`)
    return
  }
  console.log(`repoint-updates: ${options.restore ? 'restored' : 'updated'} ${changed.length} file(s)`)
  for (const file of changed) console.log(`  ${file}`)
  if (!options.restore) {
    console.log(
      '\nThe update feed now points at this fork. Rebuild and release, then the packaged app\n' +
        "will offer the fork's own installers instead of upstream's.",
    )
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const changed = []

  if (options.feedOnly) {
    writeFeeds(changed)
    report(changed)
    return
  }

  if (!options.restore && options.repo === undefined) {
    fail('pass --repo <owner>/<name>, or --restore, or --feed-only')
  }

  const rawBase = options.restore ? undefined : `https://raw.githubusercontent.com/${options.repo}/${options.branch}`
  const releaseBase = options.restore ? undefined : `https://github.com/${options.repo}/releases/latest/download`

  const edits = []
  for (const [workspace, channel] of [[STABLE_WORKSPACE, 'stable'], [BETA_WORKSPACE, 'beta']]) {
    edits.push({
      file: `${workspace}/src/update-checker.ts`,
      pattern: VERSION_ENDPOINT_PATTERN,
      value: options.restore ? UPSTREAM_VERSION_ENDPOINT : `${rawBase}/fork/update-feed/${channel}.json`,
      label: 'DESKTOP_VERSION_ENDPOINT',
    })
    edits.push({
      file: `${workspace}/src/update-download.ts`,
      pattern: MAC_URL_PATTERN,
      value: options.restore ? UPSTREAM_MAC_URL : `${releaseBase}/${MAC_ASSET}`,
      label: 'DESKTOP_DOWNLOAD_URLS.darwin',
    })
    edits.push({
      file: `${workspace}/src/update-download.ts`,
      pattern: WINDOWS_URL_PATTERN,
      value: options.restore ? UPSTREAM_WINDOWS_URL : `${releaseBase}/${WINDOWS_ASSET}`,
      label: 'DESKTOP_DOWNLOAD_URLS.win32',
    })
  }

  applyEdits(edits, changed)
  if (!options.restore && !options.urlsOnly) writeFeeds(changed)
  report(changed, options)
}

main()
