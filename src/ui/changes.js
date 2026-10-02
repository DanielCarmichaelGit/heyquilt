// The Changes button and panel in the session top bar: what has changed in
// this session and who changed it, grouped by person or by file. Everyone sees
// it, since the counts live in the shared document.
import { I, state, $, esc, api, ago, avatar, colorFor } from './common.js'

let sid = null // session shown
let data = null // last /changes result: { people, files }
let view = 'people' // 'people' | 'files'
let refreshTimer = null
let openFile = () => {}

export const changesMarkup = () => `
  <div class="chg-wrap" id="chg-wrap">
    <button class="btn sm ghost" id="chg-btn" aria-haspopup="true" aria-expanded="false" aria-controls="chg-panel" title="What has changed, and who changed it">${I.diff}<span class="wide-only">Changes</span><span class="chg-count" id="chg-count" hidden></span></button>
    <div class="popover chg-panel" id="chg-panel" role="dialog" aria-label="Changes in this session" hidden>
      <div class="chg-head"><b>Changes in this session</b><span class="hint" id="chg-sum"></span></div>
      <div class="segmented chg-seg" role="tablist" id="chg-view">
        <button type="button" role="tab" data-view="people" class="on" aria-selected="true">By person</button>
        <button type="button" role="tab" data-view="files" aria-selected="false">By file</button>
      </div>
      <div id="chg-list"></div>
      <p class="error" id="chg-error"></p>
    </div>
  </div>`

/** Mount for session `id`; `onOpen(path)` opens a file tab. */
export function bindChanges (id, signal, { onOpen } = {}) {
  sid = id
  data = null
  openFile = onOpen || (() => {})
  const wrap = $('#chg-wrap')
  const btn = $('#chg-btn')
  const panel = $('#chg-panel')
  const setOpen = (open) => {
    panel.hidden = !open
    btn.setAttribute('aria-expanded', String(open))
    if (open) load()
  }
  btn.onclick = () => setOpen(panel.hidden)
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setOpen(false); btn.focus() } })
  document.addEventListener('mousedown', (e) => { if (!wrap.contains(e.target)) setOpen(false) }, { signal })
  $('#chg-view').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]')
    if (!b) return
    view = b.dataset.view
    paint()
  })
  $('#chg-list').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-path]')
    if (!b) return
    setOpen(false)
    openFile(b.dataset.path)
  })
  load(true)
}

export function unbindChanges () {
  clearTimeout(refreshTimer)
  sid = null
  data = null
}

/** Something changed in the session: refresh the counts shortly. */
export function changesChanged () {
  if (!sid) return
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => load(true), 800)
}

async function load (quiet = false) {
  const id = sid
  if (!id) return
  try {
    const next = await api('GET', `/api/sessions/${id}/changes`)
    if (id !== sid) return
    data = next
    showError('')
  } catch (err) {
    if (id === sid && !quiet) showError(err.message)
  } finally {
    if (id === sid) paint()
  }
}

function showError (msg) {
  const el = $('#chg-error')
  if (el) el.textContent = msg
}

const delta = (x) => `<span class="chg-delta"><span class="add">+${x.added}</span> <span class="del">−${x.removed}</span></span>`
const kindTag = (k) => k === 'created' ? '<span class="chg-kind new">new</span>' : k === 'deleted' ? '<span class="chg-kind gone">deleted</span>' : ''
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`

function paint () {
  const count = $('#chg-count')
  if (!count) return
  const n = data ? data.files.length : 0
  count.hidden = !n
  count.textContent = n
  for (const b of document.querySelectorAll('#chg-view [data-view]')) {
    const on = b.dataset.view === view
    b.classList.toggle('on', on)
    b.setAttribute('aria-selected', String(on))
  }
  const s = state.sessions.get(sid)
  const st = s?.status
  const me = st?.me.name
  const colors = new Map()
  for (const p of st ? [st.me, ...st.peers] : []) colors.set(p.name, p.color)
  const who = (name) => name === me ? 'you' : name
  const sum = $('#chg-sum')
  const list = $('#chg-list')
  if (!data) {
    sum.textContent = ''
    list.innerHTML = '<p class="hint">Reading changes…</p>'
    return
  }
  if (!n) {
    sum.textContent = ''
    list.innerHTML = '<p class="hint">Nothing has changed yet. Edits made in this session show up here, with who made them.</p>'
    return
  }
  const added = data.files.reduce((a, f) => a + f.added, 0)
  const removed = data.files.reduce((a, f) => a + f.removed, 0)
  sum.innerHTML = `${plural(n, 'file')} · ${plural(data.people.length, 'person').replace('persons', 'people')} · ${delta({ added, removed })}`

  const fileRow = (f, extra = '') => f.kind === 'deleted'
    ? `<li><span class="chg-file gone"><code title="${esc(f.path)}">${esc(f.path)}</code></span>${kindTag(f.kind)}${extra}</li>`
    : `<li><button type="button" class="chg-file" data-path="${esc(f.path)}" title="Open ${esc(f.path)}"><code>${esc(f.path)}</code></button>${kindTag(f.kind)}${extra}</li>`

  if (view === 'people') {
    list.innerHTML = data.people.map((p) => `
      <section class="chg-person">
        <div class="chg-row">${avatar(p.name, colorFor(p.name, colors.get(p.name)))}<b>${esc(who(p.name))}</b>
          <span class="hint">${plural(p.fileCount, 'file')} · ${esc(ago(p.ts))}</span><span class="spacer"></span>${delta(p)}</div>
        <ul>${p.files.map((f) => fileRow(f, `<span class="hint">${esc(ago(f.ts))}</span>${delta(f)}`)).join('')}</ul>
      </section>`).join('')
  } else {
    list.innerHTML = `<ul class="chg-files">${data.files.map((f) => fileRow(f, `<span class="hint">${esc(ago(f.ts))}</span>${delta(f)}
      <div class="chg-by">${f.by.map((b) => `<span class="chg-chip" style="--c:${esc(colorFor(b.name, colors.get(b.name)))}">${esc(who(b.name))} <span class="add">+${b.added}</span> <span class="del">−${b.removed}</span></span>`).join('')}</div>`)).join('')}</ul>`
  }
}
