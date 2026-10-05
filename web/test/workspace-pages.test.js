// The workspace pages and their actions read the id from the address or the form: it goes
// into API paths encoded, and an org's page shows only that org's workspaces.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = (f) => fs.readFileSync(new URL(`../app/${f}`, import.meta.url), 'utf8')
const FILES = ['dashboard/workspaces/[id]/page.js', 'org/[slug]/workspaces/[id]/page.js', 'dashboard/workspaces/actions.js', 'org/[slug]/workspaces/actions.js']

test('every workspace API path encodes the id', () => {
  for (const f of FILES) {
    const s = src(f)
    assert.ok(s.includes('/v1/workspaces/${'), f)
    assert.doesNotMatch(s, /\/v1\/workspaces\/\$\{id\}/, f)
  }
})

test("an org's workspace page is 404 for another org's workspace", () => {
  const s = src('org/[slug]/workspaces/[id]/page.js')
  assert.ok(s.includes('const { org } = await orgMe(user.accessToken, slug)'))
  assert.ok(s.includes('if (w.orgId !== org.id) notFound()'))
})
