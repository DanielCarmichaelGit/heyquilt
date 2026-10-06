// The app's screens for access types: the approve picker, the people menu's Access
// section, the invite panel, and a chat you can't post to. (There's no browser here:
// these check the code the app serves; ui-access.test.js checks what it calls.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const ui = (f) => fs.readFileSync(new URL(`../src/ui/${f}`, import.meta.url), 'utf8')
const EM_DASH = String.fromCharCode(0x2014)

test('the approve control picks an access type, defaulting to Can edit', () => {
  const s = ui('session.js')
  assert.ok(s.includes('name="typeId" aria-label="Let $' + '{esc(p.name)} in as"'))
  assert.ok(s.includes('{ key: f.dataset.key, typeId: f.typeId.value }'))
  assert.ok(s.includes("toast(r.warning || 'Let in')"))
  // The picker is a button (startDropdowns): the bar must not redraw under it while it's open.
  assert.ok(s.includes("if (bar.contains(active) && !active.closest('[type=submit],[data-deny]')) return"))
  assert.ok(ui('common.js').includes("export function typeOptions (selected = 'builtin:edit')"))
  assert.ok(ui('common.js').includes("api('GET', '/api/access-types')"))
})

test('removing someone shows the warning when their access could not be taken away', () => {
  assert.ok(ui('session.js').includes("toast(r.warning || 'Removed')"))
})

test("the owner's Access section changes the type and narrows it", () => {
  const s = ui('session.js')
  for (const bit of ['class="pm-member edit pm-access"', 'name="viewOnly"', 'View only', 'name="noTalk"', 'No posting', 'name="foldersRemove"', '/members/access', '/grants']) assert.ok(s.includes(bit), bit)
})

test('the Access section waits for the grants, offers Retry when they fail, and redraws from fresh ones', () => {
  const s = ui('session.js')
  for (const bit of ["from './access-form.js'", 'accessFormValues(grantLoad, m)', 'data-retry-grants', 'accessSaveBody(grantLoad, state.accessTypes', 'next = grantsFailed(err)', 'renderPeopleMenu({ force: true })']) assert.ok(s.includes(bit), bit)
  assert.ok(!s.includes('catch {}\n}\n\nfunction renderPeopleMenu'), 'a failed load is not swallowed')
})

test('the invite panel invites as a type, from people you have worked with or by email, and lists pending invites', () => {
  const a = ui('app.js')
  for (const bit of ['Invite as', "People you've worked with", 'data-invite-account', 'Invite by email', 'Send invite', 'Pending invites', 'data-cancel-invite', '/api/collaborators', '/invites/cancel']) assert.ok(a.includes(bit), bit)
})

test('without posting rights the chat input is disabled and says why', () => {
  const s = ui('session.js')
  assert.ok(ui('common.js').includes('export const NO_POSTING = "You can\'t post in this session."'))
  for (const bit of ['input.disabled = muted', "$('#attach-btn').disabled = muted", 'input.placeholder = NO_POSTING', 'if (mayNotPost()) return toast(NO_POSTING)']) assert.ok(s.includes(bit), bit)
})

test('without posting rights the Share my AI chat switch is disabled and says why', () => {
  const s = ui('session.js')
  for (const bit of ['const muted = mayNotPost()', "muted ? NO_POSTING : 'Others see", 'data-share $' + "{sharing ? 'checked' : ''} $" + "{muted ? 'disabled' : ''}"]) assert.ok(s.includes(bit), bit)
})

test('no em dashes in the app', () => {
  for (const f of ['app.js', 'session.js', 'common.js', 'app.css']) assert.ok(!ui(f).includes(EM_DASH), f)
})

test('the people menu lets the owner set who can let people into the session', () => {
  const s = ui('session.js')
  for (const bit of ['Who can let people in', 'data-admit-by', '/admit-by', 'Anyone who can edit', 'Anyone in the session', 'Only the owner']) {
    assert.ok(s.includes(bit), bit)
  }
  // Non-owners who may admit pick a role; access types stay with the owner.
  assert.ok(s.includes('const asType = !!(state.accessTypes && acc.owner)'))
})

