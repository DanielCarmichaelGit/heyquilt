// "While you were away": the card above the main pane after a rejoin, saying
// who changed which files meanwhile, what became of your own offline edits,
// and where any copy of yours that the session replaced was kept. Stays until
// "Got it" (the session keeps it, so agents read the same in quilt_status).
import { I, esc, ago, avatar, colorFor, api, toast } from './common.js'

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`
const delta = (x) => `<span class="chg-delta"><span class="add">+${x.added}</span> <span class="del">−${x.removed}</span></span>`
const kindTag = (k) => k === 'created' ? '<span class="chg-kind new">new</span>' : k === 'deleted' ? '<span class="chg-kind gone">deleted</span>' : ''
const fileBtn = (p) => `<button type="button" class="linkish mono" data-open="${esc(p)}" title="Open ${esc(p)}">${esc(p)}</button>`

function fileRow (f) {
  const name = f.kind === 'deleted'
    ? `<span class="chg-file gone"><code title="${esc(f.path)}">${esc(f.path)}</code></span>`
    : `<button type="button" class="chg-file" data-open="${esc(f.path)}" title="Open ${esc(f.path)}"><code>${esc(f.path)}</code></button>`
  return `<li>${name}${kindTag(f.kind)}${f.pulled ? '<span class="hint">pulled from git</span>' : ''}<span class="hint">${esc(ago(f.ts))}</span>${f.kind === 'deleted' ? '' : delta(f)}</li>`
}

/** The card's markup ('' when there's nothing to show). `colors`: name -> color. */
export function catchUpHtml (c, { colors = new Map(), open = new Set() } = {}) {
  if (!c) return ''
  const rows = []
  if (c.first && c.pulled) rows.push(`<div class="cu-line">${I.down}<span>The session put ${plural(c.pulled, 'file')} in this folder when you joined.</span></div>`)
  for (const p of c.people) {
    const n = Math.max(p.fileCount || 0, p.files.length)
    const more = n > p.files.length ? `<li class="hint">and ${n - p.files.length} more (see Changes)</li>` : ''
    rows.push(`<details class="cu-person" data-name="${esc(p.name)}"${open.has(p.name) ? ' open' : ''}>
      <summary>${avatar(p.name, colorFor(p.name, colors.get(p.name)))}<span><b>${esc(p.name)}</b> changed ${plural(n, 'file')}</span><span class="hint">${esc(ago(p.ts))}</span><span class="spacer"></span>${delta(p)}${I.down}</summary>
      <ul>${p.files.map(fileRow).join('')}${more}</ul>
    </details>`)
  }
  if (c.partial) rows.push('<div class="cu-line hint">Older changes from while you were away are no longer in the history.</div>')
  const m = c.mine || {}
  if (m.shared) rows.push(`<div class="cu-line">${I.check}<span>${plural(m.shared, 'change')} you made while away went into the session.</span></div>`)
  if (m.merged?.length) rows.push(`<div class="cu-line">${I.check}<span>Your changes were combined with the session's in ${m.merged.map(fileBtn).join(', ')}.</span></div>`)
  if (m.conflicts?.length) rows.push(`<div class="cu-line warn">${I.branch}<span>Your changes clashed with the session's in ${m.conflicts.map(fileBtn).join(', ')}. The session's version is in the file; yours is in the merge below.</span></div>`)
  if (c.backups?.length) {
    rows.push(`<div class="cu-line warn">${I.branch}<span>Your copies of ${plural(c.backups.length, 'file')} differed from the session's and were replaced. Yours are kept:</span></div>
      <ul class="cu-backups">${c.backups.map((b) => `<li>${fileBtn(b.path)}<span class="hint">→</span><code title="${esc(b.copy)}">${esc(b.copy)}</code></li>`).join('')}</ul>`)
  }
  if (!rows.length) return ''
  return `<div class="cu-head"><b>While you were away</b>${c.since ? `<span class="hint">you left ${esc(ago(c.since))}</span>` : ''}<span class="spacer"></span><button type="button" class="btn sm" data-cu-dismiss>Got it</button></div>${rows.join('')}`
}

/** Draws the card into `el` (hidden when empty), only touching the DOM on a change. */
export function renderCatchUp (el, c, opts = {}) {
  const open = el._open || (el._open = new Set())
  const html = catchUpHtml(c, { ...opts, open })
  el.hidden = !html
  if (el._html === html) return
  el._html = html
  el.innerHTML = html
}

/** Clicks: open a file, dismiss. `sessionId()`: the session shown. */
export function bindCatchUp (el, { sessionId, onOpen }) {
  el.addEventListener('toggle', (e) => {
    const d = e.target.closest('details.cu-person')
    if (!d) return
    const open = el._open || (el._open = new Set())
    d.open ? open.add(d.dataset.name) : open.delete(d.dataset.name)
  }, true)
  el.addEventListener('click', async (e) => {
    const f = e.target.closest('[data-open]')
    if (f) { onOpen(f.dataset.open); return }
    const b = e.target.closest('[data-cu-dismiss]')
    if (!b) return
    b.disabled = true
    try {
      await api('POST', `/api/sessions/${sessionId()}/catch-up/dismiss`)
      el.hidden = true
    } catch (err) {
      b.disabled = false
      toast(err.message)
    }
  })
}
