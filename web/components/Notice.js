import { createElement } from 'react'
import { safeMessage } from '../lib/org-view.js'

// "Saved." after a form went through, a specific success message, or the reason it didn't.
// Written with createElement (not JSX) so the plain node test runner, which has no JSX
// transform, can import and call it directly to check what it rendered.
export default function Notice ({ q }) {
  if (q?.saved) return createElement('p', { className: 'notice' }, 'Saved.')
  const m = safeMessage(q?.message)
  if (m) return createElement('p', { className: 'notice' }, m)
  const e = safeMessage(q?.error)
  return e ? createElement('p', { className: 'notice bad' }, e) : null
}
