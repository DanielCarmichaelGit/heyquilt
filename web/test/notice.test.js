import { test } from 'node:test'
import assert from 'node:assert/strict'
import Notice from '../components/Notice.js'

test('Notice renders a success notice for a safe message', () => {
  const el = Notice({ q: { message: 'Removed.' } })
  assert.equal(el.props.children, 'Removed.')
  assert.equal(el.props.className, 'notice')
})

test('Notice still renders "Saved." for saved, and the bad notice for an error', () => {
  const saved = Notice({ q: { saved: true } })
  assert.equal(saved.props.children, 'Saved.')
  assert.equal(saved.props.className, 'notice')

  const err = Notice({ q: { error: 'Could not save.' } })
  assert.equal(err.props.children, 'Could not save.')
  assert.equal(err.props.className, 'notice bad')
})

test('Notice renders nothing when there is no saved, message or error', () => {
  assert.equal(Notice({ q: {} }), null)
  assert.equal(Notice({ q: undefined }), null)
})
