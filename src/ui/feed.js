// A person's AI conversations, read-only: their prompts, the AI's replies and
// one-line actions ("Edited src/app.ts"). Each agent session (a Claude Code
// session, a Cursor chat, ...) is its own conversation, picked from a strip
// at the top; the feed follows the newest one until the reader picks another.
import { esc, clock, avatar, I } from './common.js'
import { toolLogo } from './tool-logo.js'
import { conversations, pickConversation } from './feed-convs.js'

/**
 * Renders the feed into `el` (the scrolling main area). Keeps the reader's
 * scroll position unless they were already at the bottom. `convSel` is the
 * pinned conversation id (undefined: follow the newest).
 */
export function renderFeed (el, { entries, person, isMe, color, agent, online, convSel }) {
  const scroller = el.querySelector('.feed-scroll')
  const atBottom = !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60
  const prevCount = scroller ? Number(scroller.dataset.count || 0) : 0
  const prevTop = scroller ? scroller.scrollTop : 0
  const prevConv = scroller ? scroller.dataset.conv : undefined

  const who = isMe ? 'You' : person
  const whose = isMe ? 'your' : `${person}'s`
  const sharing = !agent || agent.sharing !== false
  const working = sharing && agent && agent.status === 'working'
  let body
  let strip = ''
  let shownConv = ''
  let liveShown = true // the shown conversation is the newest, where the AI is working

  if (!entries.length) {
    let title, hint
    if (!sharing) {
      title = isMe ? 'You paused sharing your AI chat' : `${person} paused sharing`
      hint = isMe ? 'Turn sharing back on in Session settings when you want partners to follow along.' : 'Their AI conversation shows up here when they resume.'
    } else if (agent && agent.status === 'unavailable') {
      title = `${isMe ? 'Your' : `${person}'s`} ${agent.tool || 'AI'} feed isn't available`
      hint = agent.reason || ''
    } else if (isMe) {
      title = 'Nothing from your AI yet'
      hint = 'When you chat with Claude Code or Cursor in this folder, the conversation shows up here for your partners. Actions are shown as one line; command output and file contents never leave your machine.'
    } else {
      title = `No AI activity from ${person} yet`
      hint = online ? `When ${person} chats with Claude Code or Cursor, you'll see it here live.` : `${person} is offline right now.`
    }
    body = `<div class="feed-empty">${avatar(person, color, online)}<div class="t">${esc(title)}</div>${hint ? `<div class="hint">${esc(hint)}</div>` : ''}</div>`
  } else {
    const convs = conversations(entries)
    const conv = pickConversation(convs, convSel)
    const shown = entries.filter((e) => e.kind === 'paused' || e.kind === 'resumed' || (e.conv || '') === conv)
    const parts = []
    let actions = []
    const flush = () => {
      if (!actions.length) return
      parts.push(`<div class="f-actions">${actions.map((a) => `<div class="f-action"><span class="chev">›</span><span>${esc(a.text)}</span></div>`).join('')}</div>`)
      actions = []
    }
    for (const e of shown) {
      if (e.kind === 'paused' || e.kind === 'resumed') {
        flush()
        parts.push(`<div class="feed-divider"><span>${esc(who)} ${e.kind === 'paused' ? 'paused' : 'resumed'} sharing · ${esc(clock(e.ts))}</span></div>`)
        continue
      }
      if (e.kind === 'action') { actions.push(e); continue }
      flush()
      if (e.kind === 'prompt') {
        parts.push(`<div class="f-prompt">${avatar(person, color)}<div class="f-body">
          <div class="head"><b>${esc(who)}</b><span>${esc(clock(e.ts))}</span>${e.summary ? '<span class="tag summary" title="Summarized before sharing">summary</span>' : ''}</div>
          <div class="bubble"><div class="text">${esc(visiblePrompt(e.text))}</div></div></div></div>`)
      } else if (e.kind === 'reply') {
        parts.push(`<div class="f-reply"><div class="head"><span class="ai-badge">${toolLogo(e.tool)}</span><span>${esc(clock(e.ts))}</span>${e.summary ? '<span class="tag summary" title="Summarized before sharing">summary</span>' : ''}</div>
          <div class="md">${markdown(e.text)}</div></div>`)
      }
    }
    flush()
    if (!sharing) parts.push(`<div class="feed-note">${esc(isMe ? 'You paused sharing' : `${person} paused sharing`)}</div>`)
    body = parts.join('')
    if (convs.length > 1) {
      strip = `<div class="feed-convs" role="tablist" aria-label="Conversations">${convs.map((c, i) => {
        const on = c.conv === conv
        const live = working && i === 0
        return `<button class="conv-chip${on ? ' on' : ''}" role="tab" aria-selected="${on}" data-conv="${esc(c.conv)}" title="${esc(c.tool || '')}${c.tool ? ' · ' : ''}${esc(clock(c.ts))}">${live ? '<span class="pulse"></span>' : ''}<span class="tool">${toolLogo(c.tool)}</span><span class="nm">${esc(c.label)}</span></button>`
      }).join('')}</div>`
    }
    shownConv = conv
    liveShown = conv === convs[0].conv
  }

  const workingHtml = working && liveShown
    ? `<div class="f-working"><span class="dots"><i></i><i></i><i></i></span>${esc(isMe ? 'Your AI is working…' : `${whose} AI is working…`)}</div>`
    : ''

  el.innerHTML = `${strip}<div class="feed-scroll" data-count="${entries.length}" data-conv="${esc(shownConv)}"><div class="feed">${body}${workingHtml}</div></div>
    <button class="btn sm new-activity" hidden>${I.down}<span>New activity</span></button>`
  const s = el.querySelector('.feed-scroll')
  const jump = el.querySelector('.new-activity')
  if (atBottom || !scroller || prevConv !== shownConv) s.scrollTop = s.scrollHeight
  else {
    s.scrollTop = prevTop
    if (entries.length > prevCount) jump.hidden = false
  }
  jump.onclick = () => { s.scrollTo({ top: s.scrollHeight, behavior: 'smooth' }); jump.hidden = true }
  s.addEventListener('scroll', () => { if (s.scrollHeight - s.scrollTop - s.clientHeight < 60) jump.hidden = true })
}

/** Prompts already shared may still contain Cursor's timestamp and user_query wrappers. */
export function visiblePrompt (text) {
  const raw = String(text || '')
  const queries = [...raw.matchAll(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/gi)].map((m) => m[1].trim()).filter(Boolean)
  if (queries.length) return queries.join('\n\n')
  return raw.replace(/<timestamp>[\s\S]*?<\/timestamp>/gi, '').trim()
}

// ------------------------------------------------------------ markdown --
// Just enough Markdown for AI replies: code blocks, inline code, bold,
// italics, headings, horizontal rules, lists and links. Everything is escaped first.

export function markdown (text) {
  const out = []
  const chunks = String(text).split(/^```/m)
  chunks.forEach((chunk, i) => {
    if (i % 2 === 1) {
      const nl = chunk.indexOf('\n')
      const code = nl === -1 ? '' : chunk.slice(nl + 1)
      out.push(`<pre class="md-code"><code>${esc(code.replace(/\n$/, ''))}</code></pre>`)
    } else {
      out.push(blocks(chunk))
    }
  })
  return out.join('')
}

function blocks (text) {
  const lines = text.split('\n')
  const out = []
  let para = []
  let list = null
  const endPara = () => { if (para.length) { out.push(`<p>${inline(para.join('\n'))}</p>`); para = [] } }
  const endList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((x) => `<li>${inline(x)}</li>`).join('')}</${list.tag}>`); list = null } }
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/)
    const num = line.match(/^\s*\d+[.)]\s+(.*)$/)
    const head = line.match(/^(#{1,6})\s+(.*)$/)
    if (!line.trim()) { endPara(); endList(); continue }
    if (/^-{3,}\s*$/.test(line)) { endPara(); endList(); out.push('<hr class="md-hr">'); continue }
    if (head) { endPara(); endList(); out.push(`<p class="md-h">${inline(head[2])}</p>`); continue }
    if (bullet || num) {
      endPara()
      const tag = bullet ? 'ul' : 'ol'
      if (list && list.tag !== tag) endList()
      if (!list) list = { tag, items: [] }
      list.items.push((bullet || num)[1])
      continue
    }
    if (list && /^\s{2,}/.test(raw)) { list.items[list.items.length - 1] += ' ' + line.trim(); continue }
    endList()
    para.push(line)
  }
  endPara()
  endList()
  return out.join('')
}

function inline (text) {
  return String(text).split('`').map((part, i) => {
    if (i % 2 === 1) return `<code>${esc(part)}</code>`
    let s = esc(part)
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    s = s.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    s = s.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (m, alt, href) => `<img class="md-img" alt="${alt}" src="${href}" loading="lazy">`)
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, label, href) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`)
    return s.replace(/\n/g, '<br>')
  }).join('')
}
