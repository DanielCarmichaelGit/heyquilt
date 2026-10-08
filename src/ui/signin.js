// The sign-in screen. Until this computer is linked to a heyquilt.com account the
// app shows only this. Signing in opens the website, where you approve this computer.
import { $, esc, api } from './common.js'
import { quiltMark } from './mark.js'

const SIGNUP = 'https://heyquilt.com/signup'
let poller = null

function screen (inner) {
  clearInterval(poller)
  $('#app').innerHTML = `<div class="signin"><div class="card signin-card">
    <div class="signin-mark">${quiltMark({ word: false })}</div>
    ${inner}
  </div></div>`
}

/** Shows the sign-in screen. `onSignedIn` runs once this computer is approved. */
export function renderSignIn (message = '', onSignedIn = () => window.location.reload()) {
  screen(`
    <h1>Sign in to Quilt</h1>
    ${message ? `<p class="signin-note">${esc(message)}</p>` : ''}
    <button class="btn primary signin-btn" id="signin-go">Sign in</button>
    <p class="hint">New to Quilt? <a href="${SIGNUP}" target="_blank" rel="noopener">Create an account</a></p>
    <p class="error" id="signin-error"></p>`)
  $('#signin-go').onclick = () => begin(onSignedIn)
}

async function begin (onSignedIn) {
  const btn = $('#signin-go')
  btn.disabled = true
  try {
    const acc = await api('POST', '/api/account/start')
    // A computer linked before is signed straight back in: nothing to approve.
    if (acc.signedIn) return onSignedIn()
    window.open(acc.link.verificationUrl, '_blank', 'noopener')
    waiting(acc.link, onSignedIn)
  } catch (err) {
    btn.disabled = false
    $('#signin-error').textContent = err.message
  }
}

function waiting (link, onSignedIn) {
  screen(`
    <h1>Sign in to Quilt</h1>
    <p>Approve this computer in your browser</p>
    <div class="signin-code" aria-label="Your code">${esc(link.userCode)}</div>
    <p class="hint">Check the page shows this code.</p>
    <div class="signin-actions"><button class="btn" id="signin-cancel">Cancel</button><button class="btn primary" id="signin-again">Open the page again</button></div>`)
  $('#signin-again').onclick = () => window.open(link.verificationUrl, '_blank', 'noopener')
  $('#signin-cancel').onclick = async () => {
    await api('POST', '/api/account/cancel').catch(() => {})
    renderSignIn('', onSignedIn)
  }
  poller = setInterval(async () => {
    let acc
    try { acc = await api('GET', '/api/account') } catch { return }
    if (acc.signedIn) { clearInterval(poller); onSignedIn(); return }
    // No link any more (cancelled elsewhere, or the app restarted): nothing left to wait for.
    if (!acc.link) return over('That sign-in was stopped. Start over to get a new code.', onSignedIn)
    const st = acc.link.state
    if (st === 'expired') over('That code expired. Start over to get a new one.', onSignedIn)
    else if (st === 'denied') over('This computer was not approved. Start over to try again.', onSignedIn)
    else if (st === 'failed') over(acc.link.error || 'Signing in did not work. Start over to try again.', onSignedIn)
  }, 2000)
}

function over (message, onSignedIn) {
  screen(`
    <h1>Sign in to Quilt</h1>
    <p class="signin-note">${esc(message)}</p>
    <button class="btn primary signin-btn" id="signin-go">Start over</button>`)
  $('#signin-go').onclick = () => begin(onSignedIn)
}
