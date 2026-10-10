// Access types and grants: the built-ins, checking fields, and the maths of what a
// grant comes to and what an owner's live change may narrow it to.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BUILTIN_TYPES, builtinType, cleanFolders, cleanTypeFields, cleanTighten, effectiveAccess, narrowAccess,
  cleanAccess, relayAccess, fromRelay, mayChange, changeRefusal, sameAccess, describeAccess, BAD_FOLDER, TOO_MANY_FOLDERS
} from '../../src/session-access.js'

const type = (files, folders = [], talk = true) => ({ files, folders, talk })

test('two built-in types, with fixed ids', () => {
  assert.deepEqual(BUILTIN_TYPES.map((t) => [t.id, t.name, t.files, t.folders, t.talk]), [
    ['builtin:edit', 'Can edit', 'edit', [], true],
    ['builtin:view', 'View only', 'view', [], true]
  ])
  assert.equal(builtinType('builtin:view').name, 'View only')
  assert.equal(builtinType('nope'), null)
  assert.throws(() => { BUILTIN_TYPES[0].name = 'x' }, TypeError)
})

test('folders are cleaned like agent scopes: at most 20, inside the project', () => {
  assert.deepEqual(cleanFolders([' ./src/ ', 'docs', 'src', '']), ['src', 'docs'])
  for (const bad of [['/etc'], ['../x'], ['a/../b'], ['C:/x'], ['a\\b'], [3], 'src']) assert.throws(() => cleanFolders(bad), { message: BAD_FOLDER }, JSON.stringify(bad))
  assert.throws(() => cleanFolders(Array.from({ length: 21 }, (_, i) => `f${i}`)), { message: TOO_MANY_FOLDERS })
  assert.deepEqual(cleanFolders(undefined), [])
})

test('a type needs a name of 1 to 40 characters, edit or view, and talk true or false', () => {
  assert.deepEqual(cleanTypeFields({ name: '  Reviewer ', files: 'view' }), { name: 'Reviewer', files: 'view', folders: [], talk: true })
  assert.deepEqual(cleanTypeFields({ name: 'Docs bot', files: 'edit', folders: ['docs/'], talk: false }), { name: 'Docs bot', files: 'edit', folders: ['docs'], talk: false })
  assert.throws(() => cleanTypeFields({ name: '', files: 'edit' }), /name of 1 to 40 characters/)
  assert.throws(() => cleanTypeFields({ name: 'x'.repeat(41), files: 'edit' }), /name of 1 to 40 characters/)
  assert.throws(() => cleanTypeFields({ name: 'x', files: 'admin' }), /files must be edit or view/)
  assert.throws(() => cleanTypeFields({ name: 'x', files: 'edit', talk: 'yes' }), /talk must be true or false/)
  assert.deepEqual(cleanTypeFields({ talk: false }, { partial: true }), { talk: false }, 'a change keeps what it did not send')
  const zeroWidth = String.fromCharCode(0x200b)
  assert.equal(cleanTypeFields({ name: `Re${zeroWidth}viewer`, files: 'view' }).name, 'Reviewer', 'nothing invisible')
})

test('tightening keeps only the three narrowing fields', () => {
  assert.deepEqual(cleanTighten({ files: 'view', foldersRemove: ['src/'], talk: false, files2: 'edit' }), { files: 'view', foldersRemove: ['src'], talk: false })
  assert.deepEqual(cleanTighten({ files: 'edit', talk: true }), {}, 'nothing here can widen')
  assert.deepEqual(cleanTighten(null), {})
})

test('effective access: view wins, removed folders go, and removing from all folders is kept as exceptions', () => {
  assert.deepEqual(effectiveAccess(type('edit')), { files: 'edit', folders: [], foldersExcept: [], talk: true })
  assert.deepEqual(effectiveAccess(type('edit'), { files: 'view' }).files, 'view')
  assert.deepEqual(effectiveAccess(type('view'), {}).files, 'view')
  assert.deepEqual(effectiveAccess(type('edit', ['src', 'docs']), { foldersRemove: ['docs'] }), { files: 'edit', folders: ['src'], foldersExcept: [], talk: true })
  assert.deepEqual(effectiveAccess(type('edit'), { foldersRemove: ['secrets'] }), { files: 'edit', folders: [], foldersExcept: ['secrets'], talk: true })
  assert.deepEqual(effectiveAccess(type('edit', ['src']), { foldersRemove: ['src/keys'] }), { files: 'edit', folders: ['src'], foldersExcept: ['src/keys'], talk: true })
  assert.deepEqual(effectiveAccess(type('edit', ['src']), { foldersRemove: ['src'] }), { files: 'view', folders: [], foldersExcept: [], talk: true }, 'nothing left to change')
  assert.equal(effectiveAccess(type('edit', [], false)).talk, false)
  assert.equal(effectiveAccess(type('edit'), { talk: false }).talk, false)
})

test('narrowing never widens', () => {
  const all = { files: 'edit', folders: [], foldersExcept: [], talk: true }
  assert.deepEqual(narrowAccess(all, { files: 'edit', folders: ['src'], foldersExcept: [], talk: true }).folders, ['src'])
  assert.deepEqual(narrowAccess({ ...all, folders: ['src'] }, { ...all, folders: [] }).folders, ['src'], 'all folders asks for more than src')
  assert.deepEqual(narrowAccess({ ...all, folders: ['src'] }, { ...all, folders: ['src/ui', 'docs'] }).folders, ['src/ui'])
  assert.equal(narrowAccess({ ...all, folders: ['src'] }, { ...all, folders: ['docs'] }).files, 'view', 'no folder in common')
  assert.equal(narrowAccess({ ...all, files: 'view' }, all).files, 'view')
  assert.deepEqual(narrowAccess({ ...all, foldersExcept: ['a'] }, { ...all, foldersExcept: ['b'] }).foldersExcept, ['a', 'b'])
  assert.equal(narrowAccess({ ...all, talk: false }, all).talk, false)
})

test('access from a pass or a request is checked, and converts to and from the relay shape', () => {
  assert.equal(cleanAccess(null), null)
  assert.equal(cleanAccess({ files: 'admin' }), null)
  assert.equal(cleanAccess({ files: 'edit', folders: ['../x'] }), null)
  const a = cleanAccess({ files: 'edit', folders: ['src/'], foldersExcept: ['src/keys'], talk: false, owner: true })
  assert.deepEqual(a, { files: 'edit', folders: ['src'], foldersExcept: ['src/keys'], talk: false })
  assert.deepEqual(relayAccess(a), { role: 'editor', scopes: ['src'], scopesExcept: ['src/keys'], talk: false })
  assert.deepEqual(fromRelay({ role: 'viewer', scopes: [] }), { files: 'view', folders: [], foldersExcept: [], talk: true }, 'a member saved before types')
  assert.ok(sameAccess(a, fromRelay(relayAccess(a))))
  assert.ok(!sameAccess(a, { ...a, talk: true }))
})

test('what someone may change, and why not', () => {
  const r = { role: 'editor', scopes: ['src'], scopesExcept: ['src/keys'], talk: true }
  assert.equal(mayChange(r, 'src/app.js'), true)
  assert.equal(mayChange(r, 'src/keys/prod.pem'), false)
  assert.equal(mayChange(r, 'docs/a.md'), false)
  assert.equal(mayChange({ role: 'viewer' }, 'src/app.js'), false)
  assert.equal(changeRefusal(r, 'src/keys/prod.pem'), 'you may not change files in src/keys')
  assert.equal(changeRefusal(r, 'docs/a.md'), 'you may only change files in src')
  assert.equal(changeRefusal({ role: 'viewer' }, 'x'), 'you can only view this session')
  assert.equal(changeRefusal(r, 'src/app.js'), null)
})

test('one line that describes access, with no em dashes', () => {
  assert.equal(describeAccess({ files: 'edit', folders: [], foldersExcept: [], talk: true }), 'Can edit · all folders')
  assert.equal(describeAccess({ files: 'edit', folders: ['src', 'docs'], foldersExcept: ['src/keys'], talk: false }), 'Can edit · src, docs · except src/keys · no posting')
  assert.equal(describeAccess({ files: 'view', folders: [], foldersExcept: [], talk: true }), 'View only')
})
