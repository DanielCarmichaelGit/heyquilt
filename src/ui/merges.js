// Merges: the bar above the main pane listing files whose offline and
// in-session edits could not be combined, and the side-by-side view of one.
import { esc, I, api, toast } from './common.js'
import { changedLines } from './fileview.js'

const you = (name, me, fallback = 'someone') => !name ? fallback : name === me ? 'you' : esc(name)
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1)

/** How the opener's side came about (merges.js VIAS). */
export function done (m, deleted = false) {
  if (m.via === 'pull') return deleted ? 'pulled commits that delete this' : 'pulled commits that change this'
  if (m.via === 'hold') return deleted ? 'deleted this during a git command' : 'changed this during a git command'
  return deleted ? 'deleted this offline' : 'changed this offline'
}

/** One plain sentence: who changed what, where; then who holds the file now, and how a send to an AI went. */
function describe (m, me) {
  const held = m.heldBy && m.heldBy !== me && m.kind !== 'claimed' ? ` ${cap(esc(m.heldBy))} has it claimed now.` : ''
  const sent = m.sendProblem ? ` <span class="warn">${esc(m.sendProblem)}</span>` : ''
  return what(m, me) + held + sent
}

function what (m, me) {
  const who = cap(you(m.by, me))
  const other = you(m.others[0], me)
  const did = done(m)
  if (m.kind === 'ai') return `${who} ${did} and ${other} changed it in the session. An AI combined the two: have a look.`
  if (m.kind === 'claimed' && !m.heldBy) return `${who} ${did} while ${you(m.claimedBy, me)} had it claimed. The session's version is in the file.`
  if (m.kind === 'claimed') return `${who} ${did}, but ${you(m.heldBy, me)} ${m.heldBy === me ? 'have' : 'has'} it claimed. The session's version is in the file.`
  if (m.oursDeleted) return `${who} ${done(m, true)} and ${other} changed it in the session.`
  if (m.theirsHash === null) return `${who} ${did}, but it was deleted in the session.`
  return `${who} ${did} and ${other} changed it in the session${m.reason ? ` (${esc(m.reason)})` : ''}.`
}

const mineLabel = (m, me) => m.oursDeleted ? 'Delete it' : m.by === me ? 'Keep mine' : `Keep ${esc(m.by)}'s`
const theirsLabel = (m, me) => m.theirsHash === null ? 'Keep it deleted' : !m.others[0] ? "Keep the session's" : m.others[0] === me ? 'Keep mine' : `Keep ${esc(m.others[0])}'s`

/**
 * The buttons for one record. `full` (the compare view) also offers both
 * versions on rows an AI combined. Viewers see the record but can't act.
 */
export function mergeActionsHtml (m, me, editors, { full = false, viewer = false } = {}) {
  const id = esc(m.id)
  const b = (how, label, cls = 'ghost') => `<button class="btn sm ${cls}" data-merge="${id}" data-how="${how}">${label}</button>`
  if (m.state === 'done') return `<span class="tag">Settled by ${you(m.resolvedBy, me)}</span>`
  if (viewer) return '<span class="tag">View only</span>'
  // Markers are in the file: only "done" and "keep mine" still make sense.
  if (m.state === 'editing') return `<span class="hint">Markers are in the file</span>${b('mine', mineLabel(m, me))}${b('agent', 'Resolved', 'primary')}`
  if (m.kind === 'ai') return (full ? b('mine', mineLabel(m, me)) : '') + b('review', 'Looks fine', 'primary')
  // Settling writes the file, and so would an AI sent to merge it: ask whoever holds it, or keep theirs.
  if (m.heldBy && m.heldBy !== me) {
    const ask = m.asked
      ? `<span class="tag">Asked ${esc(m.heldBy)} for it</span>`
      : `<button class="btn sm" data-merge="${id}" data-ask="${esc(m.path)}" title="Join the file queue: ${esc(m.heldBy)} hands it to you when done">Ask ${esc(m.heldBy)} for it</button>`
    return b('theirs', theirsLabel(m, me)) + ask
  }
  const hand = m.binary || m.oursDeleted || m.theirsHash === null ? '' : b('hand', 'Edit by hand')
  const [first, ...rest] = editors
  const send = first
    ? `<span class="merge-send"><button class="btn sm" data-merge="${id}" data-send="${esc(first.id)}">Send to ${esc(first.name)}</button>${rest.length
      ? `<select class="input" data-merge-apps="${id}" aria-label="Send to another app"><option value="">Other app…</option>${rest.map((e) => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('')}</select>`
      : ''}</span>`
    : ''
  return b('mine', mineLabel(m, me)) + b('theirs', theirsLabel(m, me)) + hand + send
}

export function renderMergeBar (el, { merges, me, editors, viewer = false }) {
  const open = merges.filter((m) => m.state !== 'done')
  el.hidden = !open.length
  if (!open.length) { el.innerHTML = ''; el._html = ''; return }
  // Don't redraw under someone picking an app.
  if (el.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return
  const html = open.map((m) => `
    <div class="request merge-row" data-merge-row="${esc(m.id)}">
      <span class="ico">${I.branch}</span>
      <div class="rq-main"><button class="linkish mono" data-compare="${esc(m.id)}" title="Compare the two versions">${esc(m.path)}</button>
        <span class="hint">${describe(m, me)}</span></div>
      ${mergeActionsHtml(m, me, editors, { viewer })}
    </div>`).join('')
  // Status arrives often; only touch the DOM when something changed.
  if (el._html === html) return
  el._html = html
  el.innerHTML = html
}

function sentToast (r, name) {
  if (r.started) return toast(`${name} is merging it. A session opens when it's done.`)
  toast(r.copied ? `Opened ${name}. The merge prompt is on your clipboard: paste it in.` : `Opened ${name}.`)
}

const settledToast = { hand: 'Markers are in the file. Remove them and save to finish.', mine: 'Done', theirs: 'Done', review: 'Thanks for checking', agent: 'Done' }

/**
 * Wires the merge buttons inside `el` (the bar, or the compare view). Call once
 * per mount: the listeners are delegated, so redraws need no rebinding.
 * `onCompare(id)` opens the compare view; `editors()` names the apps.
 */
export function bindMerges (el, { sessionId, onCompare, editors }) {
  const nameOf = (app) => (editors().find((e) => e.id === app) || {}).name || 'the app'
  const send = async (id, app) => sentToast(await api('POST', `/api/sessions/${sessionId()}/merges/send`, { id, app }), nameOf(app))
  el.addEventListener('click', async (e) => {
    const cmp = e.target.closest('[data-compare]')
    if (cmp) { onCompare(cmp.dataset.compare); return }
    const btn = e.target.closest('button[data-merge]')
    if (!btn) return
    btn.disabled = true
    try {
      if (btn.dataset.send) await send(btn.dataset.merge, btn.dataset.send)
      else if (btn.dataset.ask) {
        const file = btn.dataset.ask
        await api('POST', `/api/sessions/${sessionId()}/request-file`, { path: file, title: `Settle the merge of ${file}`, description: 'I changed this file outside the session while you had it. When you hand it over, I will merge my changes with yours.' })
        toast(`Asked for ${file}. It comes to you, with their notes, when they hand it over.`)
      }
      else {
        await api('POST', `/api/sessions/${sessionId()}/merges/resolve`, { id: btn.dataset.merge, how: btn.dataset.how })
        toast(settledToast[btn.dataset.how] || 'Done')
      }
    } catch (err) { toast(err.message) }
    btn.disabled = false // a settled row goes away on the next status
  })
  el.addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-merge-apps]')
    if (!sel || !sel.value) return
    const app = sel.value
    sel.value = ''
    sel.blur() // lets the bar redraw again
    try { await send(sel.dataset.mergeApps, app) } catch (err) { toast(err.message) }
  })
}

/** One side: its lines, with the ones that differ from the base highlighted. */
function column (title, text, base, note) {
  let body
  if (text == null) body = `<div class="fv-note">${note}</div>`
  else {
    const lines = text.split('\n')
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
    const changed = changedLines(base == null ? [] : base.split('\n'), lines)
    body = `<table class="fv-code"><tbody>${lines.map((l, i) =>
      `<tr${changed.has(i) ? ' class="mchg"' : ''}><td class="ln">${i + 1}</td><td class="lc">${esc(l) || ' '}</td></tr>`).join('')}</tbody></table>`
  }
  return `<div class="merge-col"><div class="merge-col-head">${title}</div><div class="fv-scroll">${body}</div></div>`
}

/** A short fingerprint of a text (FNV-1a and length), so a redraw check needn't keep or compare whole files. */
function textSig (t) {
  if (t == null) return t === undefined ? 'u' : 'n'
  let h = 0x811c9dc5
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193)
  return `${t.length}:${(h >>> 0).toString(36)}`
}

/**
 * The compare view. `m`: the record without its texts, as status has it.
 * `texts`: { ours, base } from the full record, `undefined` while it loads.
 * `theirs`: the session's text now, `null` when it isn't there, `undefined` while it loads.
 */
export function renderMergeView (el, { merge: m, texts, theirs, me, editors, viewer = false }) {
  const showing = el.querySelector(':scope > .merge-view')
  // Don't redraw under someone picking an app.
  if (showing && el.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return
  const sig = JSON.stringify([m, textSig(texts?.ours), textSig(texts?.base), texts === undefined, textSig(theirs), me, editors.map((e) => e.id), viewer])
  if (showing && el._mergeSig === sig) return
  el._mergeSig = sig
  if (!m) { el.innerHTML = '<div class="main-empty merge-view"><p class="hint">That merge is settled or gone.</p></div>'; return }
  const ours = texts ? texts.ours : null
  const base = texts ? texts.base : null
  const mine = m.by === me ? 'Yours, from offline' : `${esc(m.by)}'s, from offline`
  const sess = m.kind === 'ai' ? 'In the session now, combined by AI' : `In the session${m.others[0] ? `, from ${you(m.others[0], me)}` : ''}`
  const oursNote = m.oursDeleted ? 'Deleted offline' : texts === undefined ? 'Loading…' : m.local ? `Too big to show here. It's in the merge folder on ${m.by === me ? 'this computer' : `${esc(m.by)}'s computer`}.` : 'Not available'
  const theirsNote = theirs === undefined ? 'Loading…' : m.theirsHash === null ? 'Deleted in the session' : 'Not in the session any more'
  el.innerHTML = `<div class="fv merge-view">
    <div class="fv-banner"><span class="fv-path mono">${esc(m.path)}</span><span class="fv-edited">${describe(m, me)}</span><span class="spacer"></span>${mergeActionsHtml(m, me, editors, { full: true, viewer })}</div>
    ${m.binary
      ? `<div class="fv-note">${I.file} Binary file: pick a version above.</div>`
      : `<div class="merge-cols">${column(mine, ours, base, oursNote)}${column(sess, theirs, base, theirsNote)}</div>`}
  </div>`
}
