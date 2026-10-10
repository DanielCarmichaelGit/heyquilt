// What changed in one file: its history entries (src/history.js), newest first,
// each with who made it, when, the task it was for and the diff in green and red.
// The file view's Changes tab shows it. The history keeps a session's latest
// changes only, while the per-file totals (changes.js) count everything: anyone
// whose changes are counted but no longer kept is listed after the diffs.
import { esc, ago, avatar, colorFor } from './common.js'

const kindTag = (k) => k === 'created' ? '<span class="chg-kind new">new</span>' : k === 'deleted' ? '<span class="chg-kind gone">deleted</span>' : ''

/**
 * Who changed a file (its totals, from changes.js fileChanges) but has no history left for it:
 * their changes rolled off. Only who is compared, not how much: totals add up every save, the
 * history keeps a burst of saves as one net diff, so their line counts differ anyway.
 * @param {object[]} entries the file's kept history
 * @param {{ by?: { name: string, pulled?: boolean }[] }|null} summary
 */
export function rolledOff (entries, summary) {
  if (!summary) return []
  const kept = new Set(entries.map((e) => `${e.by}\0${e.pulled ? 1 : 0}`))
  return (summary.by || []).filter((b) => !kept.has(`${b.name}\0${b.pulled ? 1 : 0}`))
}

/** How many items the Changes tab lists: each kept change, and each person whose changes rolled off. */
export const changeCount = (entries, summary) => entries.length + rolledOff(entries, summary).length

/**
 * @param {object[]} entries history entries for one file, newest first
 * @param {object} o
 * @param {(name: string) => string} o.who  how to show a name ("you" for me)
 * @param {(name: string) => string} [o.colorOf]
 * @param {object|null} [o.summary] the file's totals (changes.js fileChanges), to list what rolled off
 */
export function historyMarkup (entries, { who = (n) => n, colorOf = () => null, summary = null } = {}) {
  const gone = rolledOff(entries, summary)
  if (!entries.length && !gone.length) return '<div class="fv-note">No changes to this file are kept. A session keeps its latest 2,000 changes, so older ones may have rolled off.</div>'
  return entries.map((e) => {
    const span = e.from && e.ts - e.from > 60000 ? ` · over ${Math.round((e.ts - e.from) / 60000)}m` : ''
    const tag = e.pulled ? '<span class="chg-kind pulled">pulled from git</span>' : kindTag(e.kind)
    const body = e.diff
      ? `<pre class="chg-diff">${diffLines(e.diff)}</pre>`
      : `<p class="hint">${e.detail && !/^\+\d+ -\d+$/.test(e.detail) ? `Not a text file (${esc(e.detail)}).` : 'No lines changed.'}</p>`
    return `
      <article class="chg-entry">
        <div class="chg-row">${avatar(e.by, colorFor(e.by, colorOf(e.by)))}<b>${esc(who(e.by))}</b>${tag}
          <span class="hint">${esc(ago(e.ts))}${span}</span><span class="spacer"></span>${e.diff ? `<span class="chg-delta"><span class="add">+${e.added}</span> <span class="del">−${e.removed}</span></span>` : ''}</div>
        ${e.task ? `<p class="hint chg-task">For “${esc(e.task.title)}”</p>` : ''}
        ${body}
      </article>`
  }).join('') + (gone.length ? goneMarkup(gone, { who, colorOf, alone: !entries.length }) : '')
}

// Counted in the totals, no longer in the history: who, their +/- and when, without a diff.
function goneMarkup (gone, { who, colorOf, alone }) {
  return `
    <section class="chg-gone">
      <h4>${alone ? 'Changes' : 'Earlier changes'} without a diff</h4>
      <ul>${gone.map((b) => `
        <li>${avatar(b.name, colorFor(b.name, colorOf(b.name)))}<b>${esc(who(b.name))}</b>${b.pulled ? '<span class="chg-kind pulled">pulled from git</span>' : ''}
          <span class="hint">${esc(ago(b.ts))}</span><span class="spacer"></span><span class="chg-delta"><span class="add">+${b.added}</span> <span class="del">−${b.removed}</span></span></li>`).join('')}
      </ul>
      <p class="hint">Their line-by-line diff is no longer kept. A session keeps its latest 2,000 changes, and a big one, like moving many files, can push older ones out. The totals still count them.</p>
    </section>`
}

/** A unified diff as coloured lines, each hunk headed "Line N". */
export function diffLines (diff) {
  return String(diff).split('\n').map((line) => {
    const h = /^@@ -(\d+),\d+ \+(\d+),\d+ @@/.exec(line)
    if (h) return `<span class="ln hunk">Line ${+h[2] || +h[1] || 1}</span>`
    if (line.startsWith('… ')) return `<span class="ln hunk">${esc(line)}</span>`
    const cls = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx'
    return `<span class="ln ${cls}"><i>${cls === 'add' ? '+' : cls === 'del' ? '−' : ' '}</i>${esc(line.slice(1)) || ' '}</span>`
  }).join('')
}
