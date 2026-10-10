// What's new and the update check: a bar across the top when a newer Quilt is out, and the
// release notes in a quilted pop-up (shown by itself the first time a new version runs, and
// again when a newer release appears). In the desktop app, "Update Quilt" installs it.
import { I, state, $, esc, api, remember, recall, toast } from './common.js'
import { quiltMark } from './mark.js'

const RECHECK_MS = 10 * 60 * 1000
let shownUnseen = false
let hiddenBar = false

/** Asks the app about versions, shows the update bar, and opens the notes after an update or a new release. */
export async function checkRelease () {
  try { state.release = await api('GET', '/api/version') } catch { return }
  const r = state.release
  // Each newer release is announced once per computer: when it is cut while the app is open, or at the next launch.
  // Not one you said not to show again.
  if (r.outOfDate && !r.barHidden && recall('announced-release') !== r.latest.version) {
    remember('announced-release', r.latest.version)
    hiddenBar = false
    openReleaseNotes()
  } else if (r.unseen && !shownUnseen) {
    openReleaseNotes()
  }
  if (r.unseen && !shownUnseen) {
    shownUnseen = true
    api('POST', '/api/version/seen').catch(() => {})
    r.unseen = false
  }
  renderUpdateBar()
  if (!checkRelease.timer) checkRelease.timer = setInterval(() => checkRelease().catch(() => {}), RECHECK_MS)
}

// ------------------------------------------------------------- update --
const desktop = () => window.quiltDesktop?.installUpdate ? window.quiltDesktop : null
let update = null // { phase: 'downloading' | 'installing' | 'restarting' | 'failed', received, total, error }

/** Downloads and installs the newest Quilt from inside the desktop app. */
async function startUpdate () {
  const d = desktop()
  if (!d || (update && update.phase !== 'failed')) return
  if (!startUpdate.listening) { startUpdate.listening = true; d.onUpdateProgress?.((p) => { update = { ...update, ...p }; refreshUpdateControls() }) }
  update = { phase: 'downloading', received: 0, total: 0 }
  refreshUpdateControls()
  try {
    await d.installUpdate()
    update = { phase: 'restarting' }
  } catch (err) {
    update = { phase: 'failed', error: String(err?.message || err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '') }
  }
  refreshUpdateControls()
}

/** The button that gets the newer Quilt: installs it in the desktop app, downloads it elsewhere. */
export function updateControl () {
  const r = state.release
  const download = `<a class="btn sm primary" href="${esc(r.downloadUrl)}" target="_blank" rel="noopener">${I.down}<span>Download</span></a>`
  if (!desktop()) return `<span class="update-ctl">${download}</span>`
  const phase = update?.phase
  if (!phase) return `<span class="update-ctl"><button class="btn sm primary" type="button" data-update>${I.down}<span>Update Quilt</span></button></span>`
  if (phase === 'failed') {
    return `<span class="update-ctl update-failed"><span class="update-err" title="${esc(update.error)}">${esc(update.error)}</span><button class="btn sm primary" type="button" data-update>${I.refresh}<span>Try again</span></button>${download}</span>`
  }
  const pct = phase === 'downloading' && update.total ? ` ${Math.min(99, Math.floor(update.received / update.total * 100))}%` : ''
  const label = phase === 'downloading' ? `Downloading…${pct}` : phase === 'installing' ? 'Installing…' : 'Restarting…'
  return `<span class="update-ctl"><button class="btn sm primary update-busy" type="button" disabled><span class="spin" aria-hidden="true"></span><span>${esc(label)}</span></button></span>`
}

/** Redraws every update button (the bar's and the pop-up's) in place. */
function refreshUpdateControls () {
  if (!state.release) return
  for (const el of document.querySelectorAll('.update-ctl')) el.outerHTML = updateControl()
}

/** The bar at the top of the window: this version is out of date. */
export function renderUpdateBar () {
  const r = state.release
  let bar = $('#update-bar')
  const show = !!r?.outOfDate && !hiddenBar && !r.barHidden
  document.body.classList.toggle('has-update', show)
  if (!show) { bar?.remove(); return }
  if (!bar) {
    bar = document.createElement('div')
    bar.id = 'update-bar'
    bar.setAttribute('role', 'status')
    document.body.prepend(bar)
  }
  bar.innerHTML = `
    <span class="ub-dot"></span>
    <span class="ub-text"><b>Quilt ${esc(r.latest.version)} is out.</b> You have ${esc(r.version)}.</span>
    <button class="btn sm ghost" type="button" data-release-notes>What's new</button>
    ${updateControl()}
    <label class="ub-never" title="Hide this bar until a newer Quilt than ${esc(r.latest.version)} is out"><input type="checkbox" data-update-never><span class="ub-long">Don't show this again</span><span class="ub-short">Don't show again</span></label>
    <button class="btn sm ghost icon ub-x" type="button" data-hide-update aria-label="Hide until next time" title="Hide until Quilt starts again">${I.x}</button>`
}

/** Bold and code only; everything else is text. */
export function inline (md) {
  return esc(md)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

const PATCHES = ['a', 'b', 'c', 'd']
const when = (d) => {
  if (!d) return ''
  const t = new Date(`${d}T12:00:00Z`)
  return isNaN(t) ? d : t.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
}

function releaseHtml (rel, i, { current = false, latest = false } = {}) {
  return `
  <section class="rn-rel${latest ? ' rn-latest' : ''}" aria-labelledby="rn-v-${esc(rel.version)}">
    <header class="rn-rel-head">
      <span class="rn-patch rn-patch-${PATCHES[i % PATCHES.length]}" id="rn-v-${esc(rel.version)}">${esc(rel.version)}</span>
      <span class="rn-when">${esc(when(rel.date))}</span>
      ${current ? '<span class="rn-tag">You have this</span>' : ''}
      ${latest ? updateControl() : ''}
    </header>
    ${rel.summary ? `<p class="rn-sum">${inline(rel.summary)}</p>` : ''}
    ${rel.items.length ? `<ul class="rn-list">${rel.items.map((it) => `<li>${inline(it)}</li>`).join('')}</ul>` : ''}
  </section>`
}

/** The release notes pop-up: the logo, then every version newest first (and a newer one from GitHub, if any). */
export function openReleaseNotes () {
  const r = state.release
  if (!r) return
  $('#rn-back')?.remove()
  const back = document.createElement('div')
  back.id = 'rn-back'
  back.className = 'modal-back rn-back'
  const newer = r.outOfDate ? [{ ...r.latest, items: r.latest.items.length ? r.latest.items : ['**A newer Quilt is ready.** Download it to see what changed.'] }] : []
  const rels = r.releases || []
  back.innerHTML = `
  <div class="rn quilt-patch" role="dialog" aria-modal="true" aria-labelledby="rn-title">
    <span class="quilt-stitch" aria-hidden="true"></span>
    <div class="rn-card">
      <header class="rn-head">
        <div class="rn-logo">${quiltMark({ sew: true })}</div>
        <h2 id="rn-title">What's new</h2>
        <p class="rn-lead">${r.outOfDate ? `Quilt <b>${esc(r.latest.version)}</b> is out; you have ${esc(r.version)}.${desktop() ? ' Update takes a minute and restarts Quilt.' : ''}` : `You have the newest Quilt, <b>${esc(r.version)}</b>.`}</p>
        <button class="btn icon ghost rn-close" type="button" data-rn-close aria-label="Close">${I.x}</button>
      </header>
      <div class="rn-body">
        ${newer.map((rel) => releaseHtml(rel, 0, { latest: true })).join('')}
        ${rels.map((rel, i) => releaseHtml(rel, i + newer.length, { current: rel.version === r.version })).join('')}
        <footer class="rn-foot">All releases live on <a href="https://github.com/DanielCarmichaelGit/heyquilt/releases" target="_blank" rel="noopener">GitHub</a>.</footer>
      </div>
    </div>
  </div>`
  document.body.appendChild(back)
  const close = () => back.remove()
  back.addEventListener('mousedown', (e) => { if (e.target === back) close() })
  back.addEventListener('keydown', (e) => { if (e.key === 'Escape') close() })
  back.querySelector('[data-rn-close]').onclick = close
  back.querySelector('[data-rn-close]').focus()
}

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-release-notes]')) {
    if (state.release) openReleaseNotes()
    else checkRelease().then(openReleaseNotes)
  }
  if (e.target.closest('[data-hide-update]')) { hiddenBar = true; renderUpdateBar() }
  if (e.target.closest('[data-update]')) startUpdate()
})

// "Don't show this again": hides the bar now, and for good for this release (a newer one shows it again).
document.addEventListener('change', async (e) => {
  const never = e.target.closest?.('[data-update-never]')
  if (!never || !never.checked || !state.release?.latest) return
  const version = state.release.latest.version
  try {
    await api('POST', '/api/version/hide-bar', { version })
    state.release.barHidden = true
    renderUpdateBar()
    toast(`Hidden until a newer Quilt than ${version} is out. What's New in Quilt still has it.`)
  } catch (err) {
    never.checked = false
    toast(err.message)
  }
})
