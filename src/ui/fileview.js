// A read-only view of one shared file, with who's editing it, its claim, and
// freshly changed lines highlighted for a few seconds. Its Changes tab lists
// every change to the file with its diff (diffview.js).
import { esc, bytes, I } from './common.js'
import { claimFolder, claimHolder, claimTitle } from './tree.js'
import { historyMarkup, changeCount } from './diffview.js'

const MAX_LINES = 20000

/**
 * @param {HTMLElement} el
 * @param {object} o
 * @param {object|null} o.file   response from /file, or { missing: true }
 * @param {object|null} o.meta   tree entry ({ edited, claim })
 * @param {string} o.me
 * @param {string|null} o.prevText previous text, to highlight what changed
 * @param {'file'|'changes'} [o.tab] which tab is shown
 * @param {object[]|null} [o.history] the file's changes, newest first (null: not loaded yet)
 * @param {object} [o.people] { who, colorOf } for the Changes tab
 * @param {object|null} [o.summary] the file's totals in this session (changes.js fileChanges)
 */
export function renderFileView (el, { path, file, meta, me, prevText, bannerOnly = false, tab = 'file', history = null, people, summary = null }) {
  const scroller = el.querySelector('.fv-scroll')
  const keep = scroller && scroller.dataset.path === path ? scroller.scrollTop : 0

  const edited = meta && meta.edited
  const claim = meta && meta.claim
  const editedText = edited ? `Edited by ${edited.by === me ? 'you' : esc(edited.by)} ${agoLong(edited.ts)}` : 'Not edited recently'
  const claimText = claim
    ? `<span class="fv-claim" title="${esc(claimTitle(claim, me))}">${I.lock}Claimed by ${esc(claimHolder(claim, me))}${claimFolder(claim.pattern) !== path ? ` (via <code>${esc(claim.pattern)}</code>)` : ''}${claim.note ? `: ${esc(claim.note)}` : ''}${claim.queue && claim.queue.length ? ` · ${claim.queue.length} waiting` : ''}</span>`
    : '<span class="hint">Not claimed</span>'
  let action = ''
  if (!file || !file.missing) {
    if (!claim) action = `<button class="btn sm" data-fv="claim">${I.lock}Claim</button>`
    else if (claim.by === me && !(claim.queue || []).length) action = `<button class="btn sm ghost" data-fv="release" data-pattern="${esc(claim.pattern)}">Release</button>`
  }

  const banner = `<div class="fv-banner"><span class="fv-path mono">${esc(path)}</span><span class="fv-edited">${editedText}</span>${claimText}<span class="spacer"></span>${action}<span class="tag">Read-only</span></div>`
  // Refresh who-edited/claim info without re-rendering (and un-highlighting) the code.
  const existing = el.querySelector('.fv-banner')
  if (bannerOnly && existing && scroller && scroller.dataset.path === path) { existing.outerHTML = banner; return }

  let body
  if (tab === 'changes') body = history ? `<div class="fv-history">${historyMarkup(history, { ...people, summary })}</div>` : '<div class="fv-note">Reading what changed…</div>'
  else if (!file) body = '<div class="fv-note">Loading…</div>'
  else if (file.missing) body = `<div class="fv-note">${file.deleted ? 'This file was deleted.' : 'This file isn’t in the session. It may be too large to sync, or ignored.'}</div>`
  else if (file.binary) body = `<div class="fv-note">${I.file} Binary file · ${bytes(file.size)}. Only text files can be shown here.</div>`
  else {
    const lines = file.text.split('\n')
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
    const changed = prevText != null && prevText !== file.text ? changedLines(prevText.split('\n'), lines) : new Set()
    const shown = lines.slice(0, MAX_LINES)
    body = `<table class="fv-code"><tbody>${shown.map((l, i) =>
      `<tr${changed.has(i) ? ' class="chg"' : ''}><td class="ln">${i + 1}</td><td class="lc">${esc(l) || ' '}</td></tr>`).join('')}</tbody></table>
      ${lines.length > MAX_LINES ? `<div class="fv-note">Showing the first ${MAX_LINES.toLocaleString()} lines.</div>` : ''}`
  }

  el.innerHTML = `<div class="fv">${banner}${tabsMarkup(tab, history, summary)}<div class="fv-scroll" data-path="${esc(path)}" data-tab="${tab}">${body}</div></div>`
  const s = el.querySelector('.fv-scroll')
  if (scroller && scroller.dataset.path === path && scroller.dataset.tab !== s.dataset.tab) { s.scrollTop = 0; return } // the other tab starts at the top
  const first = s.querySelector('tr.chg')
  if (first && prevText != null) {
    // Bring the change into view if it's off screen.
    s.scrollTop = keep
    const top = first.offsetTop
    if (top < s.scrollTop || top > s.scrollTop + s.clientHeight - 40) s.scrollTop = Math.max(0, top - 80)
  } else {
    s.scrollTop = keep
  }
}

const tabsMarkup = (tab, history, summary) => `<div class="fv-tabs segmented" role="tablist" aria-label="File or its changes">
    <button type="button" role="tab" data-fvtab="file" class="${tab === 'file' ? 'on' : ''}" aria-selected="${tab === 'file'}">File</button>
    <button type="button" role="tab" data-fvtab="changes" class="${tab === 'changes' ? 'on' : ''}" aria-selected="${tab === 'changes'}" title="Every change to this file, with who made it and what changed">Changes${history ? ` <span class="n">${changeCount(history, summary)}</span>` : ''}</button>
  </div>`

/** Updates the tabs (the Changes count) without re-rendering, so freshly changed lines stay lit. */
export function renderFileTabs (el, { tab, history, summary = null }) {
  const tabs = el.querySelector('.fv-tabs')
  if (tabs) tabs.outerHTML = tabsMarkup(tab, history, summary)
}

function agoLong (ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return new Date(ts).toLocaleDateString()
}

/** Indexes of lines in `b` that are new or changed compared with `a`. */
export function changedLines (a, b) {
  const out = new Set()
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB-- }
  if (endB < start) return out // only deletions
  const midA = a.slice(start, endA + 1)
  const midB = b.slice(start, endB + 1)
  if (midA.length * midB.length > 1_000_000) {
    for (let i = start; i <= endB; i++) out.add(i)
    return out
  }
  // Longest common subsequence over the changed middle section.
  const n = midA.length
  const m = midB.length
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  let i = 0
  let j = 0
  while (j < m) {
    if (i < n && midA[i] === midB[j]) { i++; j++ } else if (i < n && dp[i + 1][j] >= dp[i][j + 1]) i++
    else { out.add(start + j); j++ }
  }
  return out
}
