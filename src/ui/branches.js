// The branch menu in the session's top bar: which branch each folder, AI
// session and worktree is on, and how each stands against its upstream. Read
// only: nobody switches branches from here (a folder's branch is its own, and
// its AIs work on it). Commits pushed or merged elsewhere come in by
// themselves; "Bring in now" asks this folder to look at once.
import { esc, ago } from './common.js'

/** One line on how a branch stands against its upstream ('' without one). */
export function upstreamText (u) {
  if (!u || !u.name) return ''
  const n = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`
  if (u.diverged) return `diverged from ${u.name}: ${n(u.ahead, 'commit')} here, ${n(u.behind, 'commit')} there`
  const clash = Array.isArray(u.conflicts) ? u.conflicts.length : u.conflicts
  if (clash) return `${n(u.behind, 'commit')} behind ${u.name}; ${n(clash, 'file')} clash with the session's work`
  if (u.waiting) return `${n(u.behind, 'commit')} behind ${u.name}; waiting: ${u.waiting}`
  if (u.behind) return `${n(u.behind, 'commit')} behind ${u.name}`
  if (u.ahead) return `${n(u.ahead, 'commit')} ahead of ${u.name}`
  return `up to date with ${u.name}`
}

/** Whether the label should draw the eye: this folder is behind and Quilt can't bring it in by itself. */
export function needsHand (u) {
  return !!(u && (u.diverged || (Array.isArray(u.conflicts) ? u.conflicts.length : u.conflicts)))
}

/** The menu's markup. `git`: this folder's (status.git); `branches`: status.branches; `me`: our name. */
export function branchMenuHtml ({ git, branches = [], me = '', syncing = false, now = Date.now() }) {
  const u = git && git.upstream
  const here = git ? `<div class="br-here">
      <div class="br-title">This folder is on <b>${esc(git.key)}</b></div>
      ${u ? `<div class="br-sub${needsHand(u) ? ' warn' : ''}">${esc(upstreamText(u))}</div>` : '<div class="br-sub">No upstream: nothing to bring in.</div>'}
      ${u && Array.isArray(u.conflicts) && u.conflicts.length ? `<ul class="br-clash">${u.conflicts.slice(0, 6).map((c) => `<li><code>${esc(c.path)}</code> ${esc(c.why)}</li>`).join('')}</ul><div class="br-hint">Ask your AI to pull and resolve these: Quilt brings nothing in until they're settled.</div>` : ''}
      ${u && u.diverged ? '<div class="br-hint">Quilt never merges git history: ask your AI to pull or rebase, and the session takes in the result.</div>' : ''}
      ${u && u.brought && u.brought.at && !needsHand(u) ? `<div class="br-sub">Brought in ${u.brought.count ? `${u.brought.count} commit${u.brought.count === 1 ? '' : 's'}` : 'commits'} ${esc(ago(u.brought.at, now))} by itself</div>` : ''}
      ${u ? `<button type="button" class="btn sm ghost br-sync" data-branch-sync ${syncing ? 'disabled' : ''}>${syncing ? 'Looking…' : needsHand(u) ? 'Check again' : 'Check for new commits'}</button>` : ''}
    </div>` : ''
  const rows = branches.map((b) => {
    const who = [
      ...b.folders.map((f) => `<span class="br-who${needsHand(f.upstream) ? ' warn' : ''}" title="${esc(`${f.name === me ? 'Your folder' : `${f.name}'s folder`}${f.upstream ? `: ${upstreamText(f.upstream)}` : ''}`)}">${esc(f.name === me ? 'you' : f.name)}</span>`),
      ...b.ais.map((n) => `<span class="br-who ai" title="AI session">${esc(n)}</span>`),
      ...b.worktrees.map((w) => `<span class="br-who wt" title="${esc(`Worktree ${w}`)}">${w === b.name ? 'worktree' : `worktree ${esc(w)}`}</span>`)
    ].join('')
    const status = upstreamText(b.upstream)
    const last = b.last && b.last.ts ? `${esc(b.last.author || 'someone')} · ${esc(ago(b.last.ts, now))}` : ''
    return `<li class="br-row${git && b.name === git.key ? ' on' : ''}">
        <div class="br-line"><span class="br-name" title="${esc(b.name)}">${esc(b.name)}</span>${who ? `<span class="br-people">${who}</span>` : ''}</div>
        ${status || last ? `<div class="br-meta">${[status && `<span class="${needsHand(b.upstream) ? 'warn' : ''}">${esc(status)}</span>`, last && `<span title="${esc(b.last.subject || '')}">last commit ${last}</span>`].filter(Boolean).join(' · ')}</div>` : ''}
      </li>`
  }).join('')
  return `${here}${rows ? `<div class="br-head">Branches</div><ul class="br-list">${rows}</ul>` : ''}`
}
