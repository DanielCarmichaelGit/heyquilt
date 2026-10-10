// Release notes and the update check: RELEASES.md is parsed into versions, the newest
// section must match package.json, and the app knows when GitHub has a newer build.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-releases-home-'))
process.env.HOME = process.env.USERPROFILE = process.env.USERPROFILE = home

const { parseReleases, compareVersions, currentVersion, localReleases, latestRelease, downloadUrl, releaseNotesBody, seenVersion, markSeen, ROOT } = await import('../../src/releases.js')

const SAMPLE = `# Quilt releases

Preamble that is not a release.

## 1.2.0 — 2026-10-05

A summary line.

- **Big thing.** Details with \`code\`.
- **Small thing.**

## 1.1.0 — 2026-10-01
- **Only bullets** here.
`

test('parseReleases splits sections into versions, dates, summaries and items', () => {
  const r = parseReleases(SAMPLE)
  assert.equal(r.length, 2)
  assert.deepEqual(r[0], {
    version: '1.2.0',
    date: '2026-10-05',
    summary: 'A summary line.',
    items: ['**Big thing.** Details with `code`.', '**Small thing.**']
  })
  assert.deepEqual(r[1], { version: '1.1.0', date: '2026-10-01', summary: '', items: ['**Only bullets** here.'] })
})

test('compareVersions orders semver, ignoring a leading v', () => {
  assert.equal(compareVersions('0.3.1', 'v0.3.1'), 0)
  assert.ok(compareVersions('0.3.2', '0.3.1') > 0)
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0)
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0)
  assert.ok(compareVersions('0.3.1', '0.4.0') < 0)
  assert.ok(compareVersions('garbage', '0.1.0') < 0)
})

test('the newest section of RELEASES.md is for the version in package.json', () => {
  const notes = localReleases()
  assert.ok(notes.length >= 5)
  assert.equal(notes[0].version, currentVersion(), 'bump RELEASES.md together with package.json: every release has notes')
  assert.match(notes[0].date, /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(notes[0].items.length > 0, 'the newest release has at least one note')
  // Versions are unique and newest first.
  for (let i = 1; i < notes.length; i++) assert.ok(compareVersions(notes[i - 1].version, notes[i].version) > 0, `${notes[i - 1].version} should be newer than ${notes[i].version}`)
})

test('RELEASES.md ships inside the desktop app', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.ok(pkg.files.includes('RELEASES.md'))
  assert.ok(pkg.build.files.includes('RELEASES.md'))
})

test('downloadUrl picks the asset for this platform', () => {
  const base = 'https://github.com/DanielCarmichaelGit/heyquilt/releases/latest/download/'
  assert.equal(downloadUrl('darwin', 'arm64'), base + 'quilt-mac-arm64.dmg')
  assert.equal(downloadUrl('darwin', 'x64'), base + 'quilt-mac-x64.dmg')
  assert.equal(downloadUrl('win32', 'x64'), base + 'quilt-windows-x64.exe')
  assert.equal(downloadUrl('linux', 'x64'), base + 'quilt-linux-x86_64.AppImage')
  assert.equal(downloadUrl('linux', 'arm64'), base + 'quilt-linux-arm64.AppImage')
  assert.equal(downloadUrl('freebsd', 'x64'), 'https://github.com/DanielCarmichaelGit/heyquilt/releases/latest')
})

test('releaseNotesBody turns a section into the GitHub release body', () => {
  const body = releaseNotesBody(parseReleases(SAMPLE)[0])
  assert.match(body, /^\*\*What's new in 1\.2\.0\*\*\n\nA summary line\.\n\n- \*\*Big thing\.\*\* Details with `code`\.\n- \*\*Small thing\.\*\*\n/)
  assert.match(body, /\*\*Downloads\*\*/)
  assert.match(body, /quilt-mac-arm64\.dmg/)
  assert.match(body, /Open Anyway/)
})

test('latestRelease asks GitHub once, caches, and survives a failure', async () => {
  let hits = 0
  let status = 200
  const gh = http.createServer((req, res) => {
    hits++
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ tag_name: 'v9.9.9', name: 'Quilt 9.9.9', html_url: 'https://github.com/x/releases/tag/v9.9.9', published_at: '2026-10-09T00:00:00Z', body: "**What's new in 9.9.9**\n- **Flies.** Now with wings.\n\n**Downloads**\n- x" }))
  })
  await new Promise((r) => gh.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${gh.address().port}/latest`
  try {
    let now = 1000
    const opts = { url, now: () => now }
    const a = await latestRelease(opts)
    assert.deepEqual(a, { version: '9.9.9', url: 'https://github.com/x/releases/tag/v9.9.9', date: '2026-10-09', summary: '', items: ['**Flies.** Now with wings.'] })
    const b = await latestRelease(opts)
    assert.equal(hits, 1, 'second call within ten minutes is served from the cache')
    assert.deepEqual(b, a)
    now += 2 * 60 * 60 * 1000
    status = 500
    const c = await latestRelease(opts)
    assert.equal(hits, 2)
    assert.deepEqual(c, a, 'a failed refresh keeps the last good answer')
  } finally {
    gh.close()
  }
})

test('latestRelease is null when GitHub cannot be reached and nothing is cached', async () => {
  const r = await latestRelease({ url: 'http://127.0.0.1:9/nope', now: () => 5, timeoutMs: 500 })
  assert.equal(r, null)
})

test('seenVersion is remembered in ~/.quilt, not the page', () => {
  assert.equal(seenVersion(), '')
  markSeen('0.3.1')
  assert.equal(seenVersion(), '0.3.1')
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.quilt', 'settings.json'), 'utf8')).seenRelease, '0.3.1')
})

test('the release workflow publishes every file the release notes and the app point people to', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8')
  const publish = yml.slice(yml.indexOf('gh release create'))
  const body = releaseNotesBody({ version: '9.9.9', summary: '', items: [] })
  const named = [...body.matchAll(/quilt-[\w.-]+\.(?:dmg|exe|AppImage)/g)].map((m) => m[0])
  assert.ok(named.length >= 5)
  for (const f of named) assert.ok(publish.includes(`out/${f}`), `${f} is published`)
  for (const [p, a] of [['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64'], ['linux', 'x64'], ['linux', 'arm64']]) {
    assert.ok(publish.includes(`out/${downloadUrl(p, a).split('/').pop()}`), `the ${p}-${a} update is published`)
  }
  for (const f of ['quilt-cli-linux-x64.tar.gz', 'quilt-cli-linux-arm64.tar.gz', 'install.sh']) assert.ok(publish.includes(`out/${f}`), f)
  const install = fs.readFileSync(path.join(ROOT, 'scripts', 'install.sh'), 'utf8')
  assert.match(install, /quilt-cli-linux-\$arch\.tar\.gz/, 'the installer asks for the bundles the workflow builds')
  assert.match(body, /releases\/latest\/download\/install\.sh \| sh/)
})
