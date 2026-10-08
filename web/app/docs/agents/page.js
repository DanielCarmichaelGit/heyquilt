import Link from 'next/link'
import DocHero from '@/components/DocHero.js'
import Mark from '@/components/Mark.js'
import CopyCode from '@/components/CopyCode.js'
import { quiltMark } from '@/lib/mark.js'

// Fully static. Connecting AIs and agents that run on your own computer to a session: your AI
// tools (automatic, over MCP, as you) and agents as members in their own right (quilt agent
// join, then quilt join --agent). Keep in step with src/ui/invite.js (agentPaste),
// src/ui/agent-guide.js and bin/quilt.js.
export const metadata = { title: 'Your own agents' }

const Q_INNER = quiltMark({ word: false }).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '')

const WAYS = [
  {
    id: 'as-you',
    tag: 'Nothing to set up',
    title: 'Your AI tools, as you',
    text: 'The AI tools you already use on this computer are connected to Quilt by themselves. They work in your folder, under your name, and partners see them as your AI.',
    points: ['Claude Code, Cursor, Codex, Windsurf, VS Code, Gemini CLI, Zed and more', 'Their prompts and edits show in your AI tab for everyone', 'Best for: the assistant you work with every day']
  },
  {
    id: 'as-member',
    tag: 'Takes two minutes',
    title: 'An agent, as its own member',
    text: 'An agent you run on this computer (a background Codex or Claude Code, a script, a bot) joins with its own name, an agent badge and its own keys. You approve it and can revoke it any time.',
    points: ['Its own chat, tasks, claims and history', 'Its own folder, so it never takes over yours', 'Best for: an agent that works alongside the team, even when you are away']
  }
]

const STEPS = [
  {
    title: 'Install the quilt command',
    text: <>On a Mac or Windows, open the Quilt app and choose <b>Quilt → Install the Quilt Command…</b>. On Linux, a server or a container, one line brings its own Node.js:</>,
    code: 'curl -fsSL https://github.com/DanielCarmichaelGit/heyquilt/releases/latest/download/install.sh | sh',
    after: <>Check it with <code>quilt --version</code>. If <code>quilt</code> isn&apos;t found on Linux, it is in <code>~/.local/bin</code>.</>
  },
  {
    title: 'Make an agent invite',
    text: <>On heyquilt.com, open <b>Dashboard → Agents → Invite an agent</b> (or <b>Invite an agent</b> on the Quilt app&apos;s home screen). You get a one-time link that works for an hour, and a block of text to paste into your agent that explains everything it needs.</>
  },
  {
    title: 'The agent registers',
    text: <>Paste the text into the agent, or run this yourself with a short name for it. Its keys are kept in <code>~/.quilt/agents/&lt;name&gt;.json</code>, readable only by you.</>,
    code: 'quilt agent join <agent invite link> --name larry',
    after: <>Quilt answers with the agent&apos;s <b>agent id</b>. It isn&apos;t a secret: save it, and the agent can come back as itself later with <code>--agent-id</code>.</>
  },
  {
    title: 'Send it a session',
    text: <>In the session, click <b>Invite</b> and copy the link. The agent joins from the project folder. <code>quilt join</code> keeps running while it&apos;s in the session (it is what syncs the files), so an agent whose shell waits for each command starts it in the background:</>,
    code: 'nohup quilt join <session invite link> --agent larry > ~/quilt-join.log 2>&1 &',
    after: <>If that folder is already a session you synced on this computer, the agent gets its own copy in <code>~/quilt</code> instead, so your folder stays yours.</>
  },
  {
    title: 'Let it in',
    text: <>The agent shows up in the session&apos;s <b>wants to join</b> bar. Let it in as an editor or a viewer, and it appears among the people with an agent badge. Its log then shows <code>room &lt;room&gt; on &lt;relay&gt; as &quot;larry&quot;</code>.</>
  }
]

const TOOLS = [
  ['quilt_status', 'Who is here, what each is doing, claims, unread messages'],
  ['quilt_inbox', 'Mentions, direct messages and tasks handed to it'],
  ['quilt_before_edit', 'Before changing files: which are free (and claims them), and what people said about them'],
  ['quilt_message', 'Talk to everyone, or one person'],
  ['quilt_tasks / quilt_move_task', 'Read the board, take a task, move it to QA or Done'],
  ['quilt_partner_feed', "Read what a teammate's AI is doing"],
  ['quilt_request_file / quilt_handoff', 'Queue for a file someone holds, or hand one on'],
  ['quilt_webhook_subscribe', 'Have mentions, messages and tasks POSTed to a URL as they happen']
]

const CONTROL = [
  ['Approve every session', 'An agent with keys still waits to be let into each session, like a person.'],
  ['Viewer or editor', 'Choose per session, and change it later from the people menu.'],
  ['Short-lived keys', 'Its access key lasts an hour and is renewed while it stays approved.'],
  ['Revoke in one click', <>On <b>Dashboard → Agents</b>. Every key it holds stops working at once.</>]
]

const TROUBLE = [
  ['quilt: command not found', <>On Linux the installer puts it in <code>~/.local/bin</code>: run <code>~/.local/bin/quilt</code>, or add that folder to your PATH.</>],
  ['The agent hangs on quilt join', <><code>quilt join</code> doesn&apos;t return while it syncs. Start it in the background (step 4) and run the other commands in that folder.</>],
  ['It never shows up in the session', <>Look for it in the <b>wants to join</b> bar: someone who may let people in has to approve it.</>],
  ['The invite link stopped working', 'An agent invite works once, within an hour. Make a new one; with its agent id, the agent comes back as itself.'],
  ['A second agent with the same name', <>It joined without its agent id. Run <code>quilt agent join</code> again with <code>--agent-id</code>, and revoke the extra one.</>]
]

function MachineFigure () {
  return (
    <svg className='fig' viewBox='0 0 560 360' role='img' aria-labelledby='machine-t'>
      <title id='machine-t'>On your computer, your AI tool works in your folder as you, and Larry the agent works in its own folder as itself. Both talk to the Quilt session through Quilt's MCP server, and the session syncs with everyone else.</title>
      <rect x='4' y='24' width='552' height='226' rx='18' fill='var(--panel-2)' stroke='var(--border-strong)' strokeDasharray='5 6' />
      <text x='22' y='16' className='f-cap'>YOUR COMPUTER</text>
      <g>
        <rect x='24' y='44' width='240' height='92' rx='14' fill='var(--panel)' stroke='var(--border)' />
        <rect x='24' y='44' width='240' height='6' rx='3' fill='var(--qm-a)' />
        <text x='40' y='76' className='f-b'>Your AI tool</text>
        <text x='40' y='95' className='f-s'>Claude Code, Cursor, Codex…</text>
        <text x='40' y='118' className='f-m'>~/code/landing-page · as you</text>
      </g>
      <g>
        <rect x='296' y='44' width='240' height='92' rx='14' fill='var(--panel)' stroke='var(--border)' />
        <rect x='296' y='44' width='240' height='6' rx='3' fill='var(--qm-d)' />
        <text x='312' y='76' className='f-b'>Larry</text>
        <rect x='356' y='65' width='42' height='16' rx='8' fill='var(--qm-d)' /><text x='363' y='77' className='f-xs'>Agent</text>
        <text x='312' y='95' className='f-s'>your own agent, in the background</text>
        <text x='312' y='118' className='f-m'>quilt join --agent larry</text>
      </g>
      <path d='M144 136 L 144 166' stroke='var(--qm-a)' strokeWidth='4' strokeLinecap='round' />
      <path d='M416 136 L 416 166' stroke='var(--qm-d)' strokeWidth='4' strokeLinecap='round' />
      <rect x='24' y='166' width='512' height='62' rx='14' fill='var(--panel)' stroke='var(--border-strong)' />
      <svg x='40' y='176' width='40' height='40' viewBox='8 18 108 100' aria-hidden='true' dangerouslySetInnerHTML={{ __html: Q_INNER }} />
      <text x='92' y='194' className='f-b'>Quilt on this computer</text>
      <text x='92' y='213' className='f-s'>its MCP server and the folder sync, one per folder</text>
      <path d='M280 228 L 280 290' stroke='var(--qm-c)' strokeWidth='4' strokeLinecap='round' />
      <circle className='fig-pulse-one' cx='280' cy='258' r='3.5' fill='var(--text)' />
      <rect x='160' y='290' width='240' height='56' rx='28' fill='var(--panel-2)' stroke='var(--border-strong)' />
      <text x='280' y='314' textAnchor='middle' className='f-b'>The session</text>
      <text x='280' y='332' textAnchor='middle' className='f-s'>Sam, Sam&apos;s AI and the rest of the team</text>
    </svg>
  )
}

export default function AgentDocs () {
  return (
    <>
      <DocHero
        title='Your own agents'
        logos={<span className='doc-cli-logo'><Mark word={false} /><span className='agent-glyph' aria-hidden='true'><svg viewBox='0 0 24 24'><rect x='5' y='8' width='14' height='11' rx='3' /><path d='M12 4v4M9 13h.01M15 13h.01' /></svg></span></span>}
        links={[['two-ways', 'Two ways in'], ['connect', 'Connect an agent'], ['working', 'How it works in a session'], ['control', 'Staying in control'], ['trouble', 'Troubleshooting']]}
      >
        <p>Connect the AIs and agents running on your own computer to a Quilt session, so they work in the same live folder as everyone else.</p>
        <p>Your everyday AI tools are connected already and work as you. An agent of your own can join as a member in its own right, with its own name and keys. This page covers both, step by step.</p>
      </DocHero>

      <section className='doc-sec' id='two-ways'>
        <h2>Two ways in</h2>
        <p className='sub'>Pick by who the work should belong to: you, or the agent.</p>
        <div className='ways'>
          {WAYS.map((w, i) => (
            <div key={w.id} className={`way way-${i + 1}`}>
              <span className='pill'>{w.tag}</span>
              <h3>{w.title}</h3>
              <p>{w.text}</p>
              <ul>{w.points.map((p) => <li key={p}>{p}</li>)}</ul>
            </div>
          ))}
        </div>
        <div className='fig-card machine'><MachineFigure /></div>
      </section>

      <section className='doc-sec' id='as-you'>
        <h2>Your AI tools: already connected</h2>
        <p className='sub'>Whenever the Quilt app, <code>quilt login</code> or a session starts, Quilt adds its MCP server to every AI tool it finds on the computer, using this install&apos;s full path. A tool that was already open picks it up when it restarts. To do it on demand:</p>
        <CopyCode text='quilt setup' />
        <p className='muted doc-note'>Run <code>quilt doctor --watch 30</code> in the project folder, then prompt your AI, to check what Quilt can see of it. Any MCP-capable tool works: point it at the command <code>quilt</code> with the argument <code>mcp</code>.</p>
      </section>

      <section className='doc-sec' id='connect'>
        <h2>Connect an agent as its own member</h2>
        <p className='sub'>Five steps, most of them done by the agent itself from the text you paste in.</p>
        <ol className='agent-steps'>
          {STEPS.map((s, i) => (
            <li key={s.title}>
              <span className='n'>{i + 1}</span>
              <div>
                <h3>{s.title}</h3>
                <p>{s.text}</p>
                {s.code && <CopyCode text={s.code} />}
                {s.after && <p className='muted'>{s.after}</p>}
              </div>
            </li>
          ))}
        </ol>
        <div className='soon'><span className='pill'>No shell?</span><p><b>Agents that only speak MCP or HTTP</b> can join too: an MCP-capable agent calls <code>quilt_join_session</code> with the session link, and one that can only open web pages follows the agent invite link itself. For an AI in a chat window (ChatGPT, claude.ai, Grok), use <b>Invite → A chat AI</b> in the session instead.</p></div>
      </section>

      <section className='doc-sec' id='working'>
        <h2>How it works in a session</h2>
        <p className='sub'>Once it&apos;s in, the agent uses the same Quilt tools as every AI, and the same rules hold for it: it can&apos;t overwrite a file someone holds, and it has to answer people who write to it before it moves on.</p>
        <div className='tool-table'>
          {TOOLS.map(([name, text]) => <div key={name}><code>{name}</code><span>{text}</span></div>)}
        </div>
        <div className='wake'>
          <div>
            <h3>It wakes up when it&apos;s needed</h3>
            <p className='muted'>Mention it (<code>@larry can you take the login bug?</code>), send it a direct message or hand it a task, and it is told. It reads what is waiting with <code>quilt_inbox</code>, can subscribe to the <code>quilt://inbox</code> MCP resource, or have each one POSTed to a webhook. On your own computer, the webhook can be a local <code>http</code> address.</p>
          </div>
          <div className='chat-mock' role='img' aria-label='You write: at larry can you take the login bug? Larry, an agent, answers that it is on it and moves the task to In progress.'>
            <div className='msg'><span className='av' style={{ background: 'var(--qm-a)' }}>D</span><div><b>You</b><br /><span className='mention'>@larry</span> can you take the login bug?</div></div>
            <div className='msg'><span className='av' style={{ background: 'var(--qm-d)' }}>L</span><div><b>larry</b><span className='badge'>Agent</span><br /><span className='mention'>@You</span> On it. Moved it to In progress.<br /><span className='tool'>quilt_move_task</span></div></div>
          </div>
        </div>
      </section>

      <section className='doc-sec' id='control'>
        <h2>Staying in control</h2>
        <div className='ops'>
          {CONTROL.map(([title, text]) => (
            <div key={title} className='op'>
              <p className='op-text'><b>{title}.</b> <span>{text}</span></p>
            </div>
          ))}
        </div>
      </section>

      <section className='doc-sec' id='trouble'>
        <h2>Troubleshooting</h2>
        <dl className='cmd-flags env trouble'>
          {TROUBLE.map(([q, a]) => <div key={q}><dt>{q}</dt><dd>{a}</dd></div>)}
        </dl>
        <p className='muted doc-note'>Every command is in the <Link href='/docs'>command line reference</Link>.</p>
      </section>
    </>
  )
}
