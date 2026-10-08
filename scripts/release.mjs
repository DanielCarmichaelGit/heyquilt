#!/usr/bin/env node
// Publishes a Quilt release, notes included, so no version ships without them.
//
//   npm run release                 check, test, tag and push: GitHub builds every platform and
//                                   publishes the release (.github/workflows/release.yml), so this
//                                   works from any machine, a cloud one included
//   npm run release -- --dry-run    show what would happen
//   npm run release -- --notes      print the GitHub release body for this version and stop
//   npm run release -- --notes-only update the notes of the existing GitHub release for this version
//   npm run release -- --local      the old way: build Mac + Windows here (a Mac) and publish with gh;
//                                   no Linux builds
//   npm run release -- --skip-tests / --skip-build   (when they just ran)
//
// Before running: bump "version" in package.json (npm version patch --no-git-tag-version)
// and add a matching "## <version> — <date>" section at the top of RELEASES.md.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT, REPO, currentVersion, localReleases, releaseNotesBody } from '../src/releases.js'

const args = new Set(process.argv.slice(2))
const dry = args.has('--dry-run')
const sh = (cmd, a, opts = {}) => execFileSync(cmd, a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts }).trim()
const run = (cmd, a) => {
  console.log(`\n$ ${cmd} ${a.join(' ')}`)
  if (dry) return
  const r = spawnSync(cmd, a, { cwd: ROOT, stdio: 'inherit' })
  if (r.status !== 0) fail(`${cmd} failed`)
}
const fail = (msg) => { console.error(`\nrelease: ${msg}`); process.exit(1) }

const version = currentVersion()
const tag = `v${version}`
const notes = localReleases()[0]
if (!notes || notes.version !== version) fail(`RELEASES.md's newest section is ${notes?.version || 'missing'}, but package.json is ${version}. Add "## ${version} — ${new Date().toISOString().slice(0, 10)}" with what changed.`)
if (!notes.items.length) fail(`the ${version} section of RELEASES.md has no notes`)
if (!notes.date) fail(`the ${version} section of RELEASES.md has no date`)
const body = releaseNotesBody(notes)

if (args.has('--notes')) { process.stdout.write(body); process.exit(0) }

const notesFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-release-')), 'notes.md')
fs.writeFileSync(notesFile, body)

if (args.has('--notes-only')) {
  run('gh', ['release', 'edit', tag, '--repo', REPO, '--title', `Quilt ${version}`, '--notes-file', notesFile])
  console.log(`\nUpdated the notes of ${tag}.`)
  process.exit(0)
}

// A release is cut from a clean main, from a commit that is already on origin.
const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
if (branch !== 'main') fail(`release from main (you are on ${branch})`)
if (sh('git', ['status', '--porcelain'])) fail('commit or stash your changes first')
if (sh('git', ['tag', '-l', tag])) fail(`${tag} already exists; bump package.json and RELEASES.md`)
sh('git', ['fetch', 'origin', 'main', '--tags'])
if (sh('git', ['rev-list', '--count', 'HEAD..origin/main']) !== '0') fail('main is behind origin/main: git pull first, so the release has everything on main')
if (sh('git', ['rev-list', '--count', 'origin/main..HEAD']) !== '0') console.log('note: main has commits origin does not; they are pushed with the tag')

if (!args.has('--skip-tests')) run('npm', ['test'])

if (!args.has('--local')) {
  // GitHub builds Mac, Windows and Linux from the tag and publishes the release.
  run('git', ['tag', '-a', tag, '-m', `Quilt ${version}`])
  run('git', ['push', 'origin', 'main', tag])
  console.log(`\n${dry ? 'Would push' : 'Pushed'} ${tag}. GitHub is building Quilt ${version} for Mac, Windows and Linux and publishes it when every build is done (about 15 minutes):`)
  console.log(`  https://github.com/${REPO}/actions/workflows/release.yml`)
  console.log('Open apps on older versions offer to update within about ten minutes of that.')
  process.exit(0)
}

if (!args.has('--skip-build')) {
  run('npm', ['run', 'dist:mac'])
  run('npm', ['run', 'dist:win'])
}
const assets = ['quilt-mac-arm64.dmg', 'quilt-mac-x64.dmg', 'quilt-windows-x64.exe'].map((f) => path.join(ROOT, 'dist', f))
if (!dry) for (const a of assets) if (!fs.existsSync(a)) fail(`missing ${path.relative(ROOT, a)}`)

run('git', ['tag', '-a', tag, '-m', `Quilt ${version}`])
run('git', ['push', 'origin', 'main', tag])
run('gh', ['release', 'create', tag, '--repo', REPO, '--title', `Quilt ${version}`, '--notes-file', notesFile, '--latest', ...assets])

console.log(`\n${dry ? 'Would release' : 'Released'} Quilt ${version}: https://github.com/${REPO}/releases/tag/${tag}`)
console.log('Open apps on older versions offer to update within about ten minutes.')
