// The shared project's file tree: who edited what recently, what's claimed.
import { esc, I } from './common.js'

export const RECENT_MS = 2 * 60 * 1000

const shortAgo = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  return s < 60 ? `${s}s` : `${Math.round(s / 60)}m`
}

/** Who holds a claim, as the tree shows it: "you", "Duncan", or "Duncan (away)" when they aren't in the session. */
export const claimHolder = (c, me) => c.by === me && c.active !== false ? 'you' : `${c.by}${c.active === false ? ' (away)' : ''}`

/** A claim's tooltip: who, since when, their note, and the account that holds it. */
export const claimTitle = (c, me) => [
  `Claimed by ${claimHolder(c, me)}${c.ts ? ` at ${new Date(c.ts).toLocaleString()}` : ''}`,
  c.note || '',
  c.byId ? `Account: ${c.byId}` : '',
  c.active === false ? 'Released automatically after 20 minutes away' : ''
].filter(Boolean).join('\n')

/** "src/auth", "src/auth/", "src/auth/**" all claim the folder src/auth. */
export const claimFolder = (pattern) => String(pattern).replace(/\/\*\*$/, '').replace(/\/+$/, '')

function buildTree (files) {
  const root = { name: '', path: '', dirs: new Map(), files: [] }
  for (const f of files) {
    const parts = f.path.split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join('/')
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { name: parts[i], path: p, dirs: new Map(), files: [] })
      node = node.dirs.get(parts[i])
    }
    node.files.push({ ...f, name: parts[parts.length - 1] })
  }
  return root
}

function hasRecent (node, me) {
  return node.files.some((f) => f.edited && f.edited.by !== me && Date.now() - f.edited.ts < RECENT_MS) ||
    [...node.dirs.values()].some((d) => hasRecent(d, me))
}

/**
 * @param {HTMLElement} el
 * @param {{ files: object[], claims: object[] }} tree
 * @param {{ me: string, expanded: object, selected: string|null, filter: string }} view
 */
export function renderTree (el, tree, { me, expanded, selected }) {
  if (!tree) { el.innerHTML = '<div class="empty-note" style="padding:12px 14px">Loading files…</div>'; return }
  if (!tree.files.length) { el.innerHTML = '<div class="empty-note" style="padding:12px 14px">No shared files yet.</div>'; return }
  const folderClaims = new Map()
  for (const c of tree.claims) folderClaims.set(claimFolder(c.pattern), c)
  const root = buildTree(tree.files)
  const rows = []

  const claimBadge = (c) => c ? `<span class="t-badge claim${c.active === false ? ' away' : ''}" title="${esc(claimTitle(c, me))}">${I.lock}${esc(claimHolder(c, me))}</span>` : ''
  const walk = (node, depth) => {
    const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))
    for (const d of dirs) {
      const open = expanded[d.path] ?? depth === 0
      const claim = folderClaims.get(d.path)
      rows.push(`<div class="t-row t-dir" role="treeitem" aria-expanded="${open}" tabindex="-1" data-dir="${esc(d.path)}" style="--depth:${depth}">
        <span class="t-caret${open ? ' open' : ''}">${I.caret}</span><span class="t-name">${esc(d.name)}</span>
        ${!open && hasRecent(d, me) ? '<span class="t-dot" title="Recently edited inside"></span>' : ''}${claimBadge(claim)}
        <button class="t-more" data-more="${esc(d.path)}" data-kind="dir" aria-label="More for ${esc(d.name)}">${I.more}</button></div>`)
      if (open) walk(d, depth + 1)
    }
    for (const f of node.files.sort((a, b) => a.name.localeCompare(b.name))) {
      const recent = f.edited && Date.now() - f.edited.ts < RECENT_MS
      const byOther = recent && f.edited.by !== me
      const ownClaim = f.claim && claimFolder(f.claim.pattern) === f.path ? f.claim : null
      rows.push(`<div class="t-row t-file${selected === f.path ? ' on' : ''}" role="treeitem" tabindex="-1" data-file="${esc(f.path)}" style="--depth:${depth}" title="${esc(f.path)}">
        <span class="t-ico">${I.file}</span><span class="t-name">${esc(f.name)}</span>
        ${recent ? `<span class="t-badge ${byOther ? 'edit' : 'mine'}">${esc(f.edited.by === me ? 'you' : f.edited.by)} · ${shortAgo(f.edited.ts)}</span>` : ''}
        ${claimBadge(ownClaim)}
        <button class="t-more" data-more="${esc(f.path)}" data-kind="file" aria-label="More for ${esc(f.name)}">${I.more}</button></div>`)
    }
  }
  walk(root, 0)
  el.innerHTML = `<div class="t-list" role="tree">${rows.join('')}</div>`
}

/**
 * The ⋯ menu for a file or folder: claim it (with an optional note) or
 * release your claim. Others' claims are shown; the owner may release them, and
 * anyone may release a claim left under their own name by an account that's gone.
 */
export function openTreeMenu (anchor, { path, kind, claim, me, owner, onClaim, onRelease, onClearAway, onOpen }) {
  closeTreeMenu()
  const menu = document.createElement('div')
  menu.className = 'popover tree-menu'
  menu.setAttribute('role', 'menu')
  const isAway = claim && claim.active === false
  const mine = claim && claim.by === me && !isAway
  const theirs = claim && !mine
  // The owner may release anyone's claim; anyone may release one held under their name from before.
  const canRelease = theirs && (owner || (isAway && claim.by === me))
  menu.innerHTML = `
    <div class="pop-title">${esc(path)}</div>
    ${kind === 'file' ? `<button class="pop-item" data-act="open" role="menuitem">${I.file}Open</button>` : ''}
    ${mine ? `<button class="pop-item" data-act="release" role="menuitem">${I.lock}Release your claim</button>` : ''}
    ${theirs ? `<div class="pop-note" title="${esc(claimTitle(claim, me))}">${I.lock}Claimed by <b>${esc(claimHolder(claim, me))}</b>${claim.note ? `: ${esc(claim.note)}` : ''}</div>` : ''}
    ${canRelease ? `<button class="pop-item" data-act="release" role="menuitem">${I.lock}Release ${esc(claim.by)}'s claim</button>` : ''}
    ${isAway && owner && onClearAway ? '<button class="pop-item" data-act="clear-away" role="menuitem">Release every claim held by someone away</button>' : ''}
    ${!claim ? `<form class="pop-form"><label class="label" for="claim-note">Claim this ${kind === 'dir' ? 'folder' : 'file'}</label>
      <input class="input" id="claim-note" placeholder="What are you doing? (optional)" autocomplete="off">
      <button class="btn sm primary" type="submit">${I.lock}Claim</button></form>` : ''}`
  document.body.appendChild(menu)
  const r = anchor.getBoundingClientRect()
  const w = 260
  menu.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`
  menu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8)}px`
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]')
    if (!b) return
    if (b.dataset.act === 'open') onOpen()
    if (b.dataset.act === 'release') onRelease()
    if (b.dataset.act === 'clear-away') onClearAway()
    closeTreeMenu()
  })
  const form = menu.querySelector('form')
  if (form) {
    form.onsubmit = (e) => { e.preventDefault(); onClaim(menu.querySelector('#claim-note').value.trim()); closeTreeMenu() }
    setTimeout(() => menu.querySelector('#claim-note').focus(), 0)
  } else {
    menu.querySelector('.pop-item')?.focus()
  }
  const away = (e) => { if (!menu.contains(e.target) && e.target !== anchor) closeTreeMenu() }
  const esc_ = (e) => { if (e.key === 'Escape') { closeTreeMenu(); anchor.focus?.() } }
  setTimeout(() => document.addEventListener('mousedown', away), 0)
  document.addEventListener('keydown', esc_)
  closeTreeMenu.cleanup = () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc_); menu.remove() }
}

export function closeTreeMenu () {
  if (closeTreeMenu.cleanup) { closeTreeMenu.cleanup(); closeTreeMenu.cleanup = null }
}
