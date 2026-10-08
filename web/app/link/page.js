import AppHeader from '@/components/AppHeader.js'
import SubmitButtons from '@/components/SubmitButtons.js'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { decide } from './actions.js'

export const metadata = { title: 'Link a computer' }
const PLATFORMS = { darwin: 'Mac', win32: 'Windows', linux: 'Linux' }

export default async function LinkPage ({ searchParams }) {
  const q = await searchParams
  const code = String(q.code || '')
  const user = await requireUser(`/link?code=${encodeURIComponent(code)}`)
  let body
  let done = q.done
  // A computer this account linked before (its key, not just its name): approve it without
  // asking again. Only the computer holding that key can collect the sign-in.
  const first = !done && code ? await apiCall(user, 'GET', `/v1/device/link/${encodeURIComponent(code)}`) : null
  if (first?.ok && first.data.known) {
    const a = await apiCall(user, 'POST', '/v1/device/approve', { userCode: first.data.userCode, approve: true })
    if (a.ok) done = 'approved'
  }
  if (done === 'approved') body = <><h2>Computer linked</h2><p className='muted'>The Quilt app is signed in now.</p><div className='row'><a className='btn primary' href='quilt://open'>Open Quilt</a></div></>
  else if (done === 'denied') body = <><h2>Not linked</h2><p className='muted'>That computer won't be signed in.</p></>
  else {
    const r = first || (code ? await apiCall(user, 'GET', `/v1/device/link/${encodeURIComponent(code)}`) : { ok: false, status: 404 })
    if (!r.ok) {
      const errorMsg = r.status === 410 ? 'It expired or was already used.' : (r.status === 0 || r.status >= 500) ? 'Quilt is having trouble right now. Try again in a minute.' : 'Check the code in the Quilt app, or start signing in again there.'
      body = <><h2>That code didn't work</h2><p className='muted'>{errorMsg}</p>{q.done === 'failed' && <p className='notice bad'>Something went wrong. Try again.</p>}</>
    } else {
      const d = r.data
      body = (
        <>
          <h2>Link this computer to your account?</h2>
          <p><b>{d.deviceName}</b> {PLATFORMS[d.platform] ? <span className='pill'>{PLATFORMS[d.platform]}</span> : null}</p>
          <p className='muted'>Check the Quilt app shows this code: <code style={{ fontSize: 16 }}>{d.userCode}</code></p>
          <p className='muted'>Only approve if you just started signing in to Quilt on your own computer.</p>
          <p className='muted'>Signed in as {user.email}</p>
          <form action={decide} className='row'>
            <input type='hidden' name='code' value={d.userCode} />
            {q.done === 'failed' && <p className='notice bad'>That didn't go through. Try again.</p>}
            <SubmitButtons />
          </form>
        </>
      )
    }
  }
  return (
    <>
      <AppHeader user={user} space='personal' />
      <main className='wrap page stack'>
        <h1 style={{ fontSize: 32 }}>Link a computer</h1>
        <section className='card stack'>{body}</section>
      </main>
    </>
  )
}
