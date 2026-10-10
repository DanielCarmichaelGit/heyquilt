// The owner's Access section only offers what it loaded: until this session's grants are
// here it can't save, a failed load says so (with Retry), and a fresh load replaces what
// the form shows. These are the pure rules the people menu draws from.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accessFormValues, accessSaveBody, LOADING_ACCESS, grantsLoading, grantsLoaded, grantsFailed } from '../../src/ui/access-form.js'

const TYPES = [{ id: 'builtin:edit' }, { id: 'builtin:view' }, { id: 'docs' }]
const sam = { key: 'person:sam', role: 'editor' }
const docsGrant = { account: 'person:sam', typeId: 'docs', tighten: { talk: false, foldersRemove: ['docs/private'] } }

test('while the grants load, the form shows that and has nothing to save', () => {
  const load = grantsLoading()
  assert.deepEqual(accessFormValues(load, sam), { state: 'loading', message: LOADING_ACCESS })
  assert.equal(LOADING_ACCESS, 'Loading access…')
  assert.equal(accessSaveBody(load, TYPES, sam.key, { typeId: 'builtin:edit', viewOnly: false, noTalk: true, foldersRemove: '' }), null)
})

test('a failed load shows the error, with nothing to save', () => {
  const load = grantsFailed(new Error('offline'))
  assert.deepEqual(accessFormValues(load, sam), { state: 'error', message: "Couldn't load their access: offline" })
  assert.equal(accessSaveBody(load, TYPES, sam.key, { typeId: 'builtin:edit', viewOnly: false, noTalk: false, foldersRemove: '' }), null)
})

test('loaded grants fill the form: the type and how it is narrowed', () => {
  const load = grantsLoaded([docsGrant])
  assert.deepEqual(accessFormValues(load, sam), { state: 'ready', typeId: 'docs', viewOnly: false, noTalk: true, foldersRemove: 'docs/private' })
  // Someone with no grant: what their access on the relay comes to.
  assert.equal(accessFormValues(load, { key: 'person:vic', role: 'viewer' }).typeId, 'builtin:view')
  // A fresh load replaces it.
  const fresh = grantsLoaded([{ ...docsGrant, typeId: 'builtin:view', tighten: {} }])
  assert.deepEqual(accessFormValues(fresh, sam), { state: 'ready', typeId: 'builtin:view', viewOnly: false, noTalk: false, foldersRemove: '' })
})

test('a save sends only a type the owner has, from loaded grants', () => {
  const load = grantsLoaded([docsGrant])
  assert.deepEqual(accessSaveBody(load, TYPES, sam.key, { typeId: 'docs', viewOnly: true, noTalk: true, foldersRemove: 'docs/private, docs/keys' }),
    { key: 'person:sam', typeId: 'docs', tighten: { files: 'view', talk: false, foldersRemove: ['docs/private', 'docs/keys'] } })
  assert.equal(accessSaveBody(load, TYPES, sam.key, { typeId: 'gone', viewOnly: false, noTalk: false, foldersRemove: '' }), null, 'not one of their types')
  assert.equal(accessSaveBody(load, null, sam.key, { typeId: 'docs', viewOnly: false, noTalk: false, foldersRemove: '' }), null, 'types not loaded')
})
