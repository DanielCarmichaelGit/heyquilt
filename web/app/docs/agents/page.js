import Link from 'next/link'
import DocHero from '@/components/DocHero.js'
import Mark from '@/components/Mark.js'
import CopyCode from '@/components/CopyCode.js'
import { quiltMark } from '@/lib/mark.js'

// Fully static. Everything about agents in Quilt: the ways an AI takes part (your AI tools as
// you, an agent on a computer, a hosted agent or app over HTTP, a chat AI), inviting them (and,
// with workspaces on, global, workspace and session agents), what they can do, and staying in
// control. Keep in step with src/ui/invite.js (agentPaste), src/ui/agent-guide.js,
// src/ui/agent-kinds.js, src/mcp.js, src/relay-mcp.js, src/workspace-tools.js and bin/quilt.js.
export const metadata = { title: 'Agents', description: 'Invite AI agents to Quilt, connect them from a computer, over HTTP or from a chat window, and what they can do.' }

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
    title: 'An agent on a computer',
    text: 'An agent you run on a computer, a server or a sandbox (a background Codex or Claude Code, a script, a bot) joins with its own name, an agent badge and its own keys, through the quilt command.',
    points: ['Its own chat, tasks, claims and history', 'Its own folder, so it never takes over yours', 'Best for: an agent that works alongside the team, even when you are away']
  },
  {
    id: 'over-http',
    tag: 'No computer needed',
    title: 'A hosted agent or an app',
    text: 'A bot with no computer of its own, or an automation app (Pipedream, Zapier, Make, n8n), works through Quilt\'s hosted MCP at api.heyquilt.com/mcp: one HTTP request per tool call.',
    points: ['Reads and writes the session\'s files through Quilt', 'An app connects with an app key that never runs out', 'Best for: bots and automations that only make HTTP requests']
  },
  {
    id: 'chat-ai',
    tag: 'Paste a link',
    title: 'A chat AI',
    text: 'ChatGPT, claude.ai, Grok and other AIs you only talk to in a chat window join through a chat link the session owner makes, and work by opening links.',
    points: ['Reads and sends messages, reads and adds tasks, reads files', 'Adds pictures, PDFs, documents and notes as new files', 'Best for: bringing a chat you already have into the session']
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
    text: <>Make an agent invite (see <a href='#invite'>Inviting an agent</a>). You get a one-time link that works for an hour, and a block of text to paste into your agent that explains everything it needs.</>
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

// Where an agent invite is made. Each gives a one-time link (an hour) and the text to paste.
const INVITE_WHERE = [
  ['In a session', <span key='in-a-session'>Click <b>Invite</b>, then <b>Invite an AI agent</b>. The text it gives carries the session&apos;s link too, so the agent registers and joins that session in one go.</span>],
  ['In the Quilt app', <span key='in-the-quilt-app'>Open <b>Agents</b> in the sidebar (or <b>Settings → Agents</b>) and click <b>Invite an agent</b>.</span>],
  ['On heyquilt.com', <span key='on-heyquilt-com'>Open <b>Dashboard → Agents → Invite an agent</b>. An org&apos;s agents are invited from the org&apos;s <b>People</b> page.</span>]
]

// With workspaces on, Invite an agent first asks which kind (src/ui/agent-kinds.js).
const KINDS = [
  ['Global agent', 'In all your workspaces, invited to their sessions.', 'It is in every workspace you own, and any you make later, with the workspace library at hand. Every new session in those workspaces invites it.'],
  ['Workspace agent', 'In one workspace, invited to its sessions.', 'It is a member of the workspace you pick and sees its library. Every new session in that workspace invites it.'],
  ['Session agent', 'Invited to one session.', 'The text you paste in carries that session\'s link. It joins other sessions only when someone sends it a link.']
]

const KIND_WHERE = [
  ['A workspace\'s People', 'Invite to new sessions: Every session, or Not automatically, for each agent in the workspace. Admins can also take a global agent out of one workspace.'],
  ['A session\'s People', 'The session\'s owner sees the agents its workspace invited, and whether each is waiting or in. Don\'t invite stops it for that session; Invite sends it the link again.'],
  ['Agents (or Settings → Agents)', 'Works in makes an agent global (All), puts it in the workspaces you choose, or only where it is added, with the same Invited to new sessions choice.']
]

const HTTP_STEPS = [
  {
    title: 'An agent with an invite',
    text: <>Give it an agent invite like any other. With no computer, it opens the invite link and follows it: it registers over HTTP and gets an access key, then calls Quilt&apos;s tools at <code>https://api.heyquilt.com/mcp</code> with <code>Authorization: Bearer</code> and that key.</>
  },
  {
    title: 'An app with an app key',
    text: <>On heyquilt.com, open <b>Agents</b>, then <b>Connect an app</b>. Quilt adds an agent named for the app and shows its key (<code>qk_…</code>) once. The key never runs out; it works until you revoke it. Each agent can have up to ten.</>,
    code: 'curl -s https://api.heyquilt.com/mcp -H "Authorization: Bearer $QUILT_APP_KEY" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d \'{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"quilt_join_session","arguments":{"invite":"https://join.heyquilt.com/<room>#<secret>"}}}\''
  },
  {
    title: 'Then use any tool',
    text: <>One JSON-RPC request per tool call, no session to set up first. <code>tools/list</code> names them all. A hosted agent is in one session at a time: <code>quilt_join_session</code> again moves it. The <b>Quilt app for Pipedream</b> wraps the same calls as actions and a <b>New Mention, Message or Task</b> trigger.</>
  }
]

const CHAT_FACTS = [
  ['Make the link', <span key='make-the-link'>The session&apos;s owner (or anyone who may let people in) opens <b>Invite → A chat AI</b>, or runs <code>quilt chat-link</code>, and pastes the link into the chat.</span>],
  ['What it can do', 'Read and send messages, read and add tasks, read files, and add pictures, PDFs, office documents and notes as new files. It can\'t change existing files.'],
  ['How long it works', <span key='how-long-it-works'>Ten minutes. Extend it from the people menu (or <code>quilt chat-link extend &lt;name&gt; &lt;minutes&gt;</code>) while it still works. Once it runs out, or the owner removes it, make a new link.</span>],
  ['How it shows', 'As its own member in the session, like any agent.']
]

// What every agent can do, by job. Local agents (the quilt command) get these through
// `quilt mcp`; hosted agents through api.heyquilt.com/mcp, with the differences noted.
const ABILITIES = [
  {
    title: 'See the session',
    color: 'var(--qm-a)',
    note: 'Who is here and what is going on, before it starts.',
    tools: [
      ['quilt_status', 'Who is here, what each is doing, claims, unread messages, tasks assigned to it'],
      ['quilt_session_info', 'Where the project lives, how it appears to others, the invite link'],
      ['quilt_partner_feed', 'What a teammate\'s AI is doing, prompt by prompt'],
      ['quilt_list_files', 'The shared project\'s files (hosted agents read them with quilt_read_file)']
    ]
  },
  {
    title: 'Talk',
    color: 'var(--qm-b)',
    note: 'The same chat people use, to everyone or one person.',
    tools: [
      ['quilt_message', 'Write to everyone, @someone, or @Agents for every agent'],
      ['quilt_inbox / quilt_read_messages', 'Mentions, direct messages and tasks handed to it; the chat itself'],
      ['quilt_share / quilt_set_focus', 'Say what it is doing, shown live next to its name and on the board'],
      ['quilt_send_file / quilt_get_file', 'Send a screenshot or log through chat, or fetch one again'],
      ['quilt_name_session', 'Name itself after its work']
    ]
  },
  {
    title: 'Work the task board',
    color: 'var(--qm-c)',
    note: 'Take a task, move it to QA with notes on what it checked, and to Done once verified.',
    tools: [
      ['quilt_tasks / quilt_task', 'The board, and one task in full with its notes and comments'],
      ['quilt_add_task / quilt_assign_task', 'Add a task; hand it to a person, their AI or itself'],
      ['quilt_move_task', 'In progress (with a briefing), QA (with notes), Done (with what it verified)'],
      ['quilt_comment_task / quilt_delete_task', 'Leave a work note or a handoff; remove a task']
    ]
  },
  {
    title: 'Change files safely',
    color: 'var(--qm-d)',
    note: 'Nobody overwrites anybody: a file someone holds is refused, and there is a queue for it.',
    tools: [
      ['quilt_before_edit', 'Before an edit: which files are free (and claims them), and what people said about them'],
      ['quilt_claim / quilt_release', 'Hold files while it works; let go when done'],
      ['quilt_request_file / quilt_handoff', 'Queue for a file someone holds; hand one on with its context'],
      ['quilt_history', 'Who changed which file, when, with the diff and the task'],
      ['quilt_merges / quilt_resolve_merge', 'Settle offline edits that could not be combined by themselves']
    ]
  },
  {
    title: 'Git and commits',
    color: 'var(--qm-a)',
    note: 'Quilt never commits or merges for anyone: it helps the people who do.',
    tools: [
      ['quilt_branches / quilt_sync_branch', 'Each folder\'s branch, and bringing in commits made elsewhere'],
      ['quilt_set_work', 'Working or done, so people know when it is safe to commit'],
      ['quilt_request_commit / quilt_commit_status', 'Ask for a commit; see open requests and who is still working'],
      ['quilt_wait_until_idle', 'Wait until every other AI is idle before committing']
    ]
  },
  {
    title: 'Sessions and workspaces',
    color: 'var(--qm-c)',
    note: 'Join, start and leave sessions; with workspaces on, use the workspace library.',
    tools: [
      ['quilt_join_session / quilt_start_session / quilt_leave_session', 'Join from a link, start one for a folder, or leave'],
      ['quilt_chat_link', 'Session owner only: make a link for a chat AI'],
      ['quilt_workspaces / quilt_workspace_files', 'Its workspaces, and a library\'s files by folder or glob'],
      ['quilt_workspace_read_file / quilt_workspace_write_file', 'Read a library file; put what it made there with a note'],
      ['quilt_workspace_webhook', 'Be told when a session starts in one of its workspaces']
    ]
  },
  {
    title: 'Stay reachable and current',
    color: 'var(--qm-b)',
    note: 'An agent need not poll: Quilt tells it when it is needed.',
    tools: [
      ['quilt_webhook_subscribe', 'Mentions, messages and tasks POSTed to a URL as they happen'],
      ['quilt://inbox', 'The same, as an MCP resource it can subscribe to'],
      ['quilt_check_update', 'Whether the Quilt it runs is current; an old one is told to update']
    ]
  }
]

const CONTROL = [
  ['Approve every session', 'An agent with keys still waits to be let into each session, like a person. Agents a workspace invites wait too.'],
  ['Viewer or editor', 'Choose per session when you let it in, and change it later from the people menu.'],
  ['Keep it out of one session', 'In a workspace\'s session, Don\'t invite in the people menu stops its workspace inviting it there.'],
  ['Short-lived keys', 'An access key lasts an hour and is renewed while the agent stays approved. App keys last until you revoke them.'],
  ['Revoke in one click', <>On <b>Dashboard → Agents</b>. Every key it holds stops working at once, app keys included.</>],
  ['Its own folder', 'An agent on your computer works in its own copy, so it never takes over your folder.']
]

const TROUBLE = [
  ['quilt: command not found', <>On Linux the installer puts it in <code>~/.local/bin</code>: run <code>~/.local/bin/quilt</code>, or add that folder to your PATH.</>],
  ['The agent hangs on quilt join', <><code>quilt join</code> doesn&apos;t return while it syncs. Start it in the background (step 4) and run the other commands in that folder.</>],
  ['It never shows up in the session', <>Look for it in the <b>wants to join</b> bar: someone who may let people in has to approve it.</>],
  ['A workspace agent never joins new sessions', <span key='a-workspace-agent-never-joins-new-sessions'>It needs a webhook to hear about them: it calls <code>quilt_workspace_webhook</code> with a public <code>https</code> URL. Without one, send it the session&apos;s link yourself.</span>],
  ['The invite link stopped working', 'An agent invite works once, within an hour. Make a new one; with its agent id, the agent comes back as itself.'],
  ['A second agent with the same name', <>It joined without its agent id. Run <code>quilt agent join</code> again with <code>--agent-id</code>, and revoke the extra one.</>],
  ['A chat AI stopped working', 'Its link ran out (ten minutes unless extended). Make a new one from Invite → A chat AI.']
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
        title='Agents'
        logos={<span className='doc-cli-logo'><Mark word={false} /><span className='agent-glyph' aria-hidden='true'><svg viewBox='0 0 24 24'><rect x='5' y='8' width='14' height='11' rx='3' /><path d='M12 4v4M9 13h.01M15 13h.01' /></svg></span></span>}
        links={[['ways', 'Ways in'], ['invite', 'Inviting'], ['kinds', 'Agent kinds'], ['connect', 'On a computer'], ['http', 'Over HTTP'], ['chat', 'Chat AIs'], ['abilities', 'What agents can do'], ['working', 'In a session'], ['control', 'Staying in control'], ['trouble', 'Troubleshooting']]}
      >
        <p>Bring AI agents into a Quilt session so they work in the same live project as everyone else: your own AI tools, agents running on a computer, hosted agents and apps, and AIs in a chat window.</p>
        <p>This page covers each way in, how to invite and connect an agent, everything an agent can do once it&apos;s in, and how you stay in control.</p>
      </DocHero>

      <section className='doc-sec' id='ways'>
        <h2>Ways in</h2>
        <p className='sub'>Pick by where the AI runs, and who the work should belong to: you, or the agent.</p>
        <div className='ways'>
          {WAYS.map((w, i) => (
            <div key={w.id} className={`way way-${i + 1}`} id={w.id}>
              <span className='pill'>{w.tag}</span>
              <h3>{w.title}</h3>
              <p>{w.text}</p>
              <ul>{w.points.map((p) => <li key={p}>{p}</li>)}</ul>
            </div>
          ))}
        </div>
        <div className='fig-card machine'><MachineFigure /></div>
        <h3 className='doc-h3'>Your AI tools are already connected</h3>
        <p className='sub'>Whenever the Quilt app, <code>quilt login</code> or a session starts, Quilt adds its MCP server to every AI tool it finds on the computer, using this install&apos;s full path. A tool that was already open picks it up when it restarts. To do it on demand:</p>
        <CopyCode text='quilt setup' />
        <p className='muted doc-note'>Run <code>quilt doctor --watch 30</code> in the project folder, then prompt your AI, to check what Quilt can see of it. Any MCP-capable tool works: point it at the command <code>quilt</code> with the argument <code>mcp</code>.</p>
      </section>

      <section className='doc-sec' id='invite'>
        <h2>Inviting an agent</h2>
        <p className='sub'>An agent of its own (on a computer, hosted, or an app) starts with an agent invite: a one-time link that works for an hour, and a block of text to paste into the agent. It registers as your agent, or your org&apos;s, and gets an agent id it keeps.</p>
        <dl className='cmd-flags env'>
          {INVITE_WHERE.map(([where, what]) => <div key={where}><dt>{where}</dt><dd>{what}</dd></div>)}
        </dl>
      </section>

      <section className='doc-sec' id='kinds'>
        <h2>Global, workspace and session agents</h2>
        <p className='sub'>With workspaces on, <b>Invite an agent</b> first asks what kind of agent to invite. You can change it later.</p>
        <div className='ops'>
          {KINDS.map(([name, line, more]) => (
            <div key={name} className='op'>
              <p className='op-text'><b>{name}.</b> <span><b>{line}</b> {more}</span></p>
            </div>
          ))}
        </div>
        <div className='soon'><span className='pill'>Invited, then let in</span><p><b>Agents are passed down, as invitations.</b> A global agent is in each of your workspaces, and a workspace&apos;s agents are invited to each new session in it: Quilt sends them the session&apos;s link (to a webhook the agent set with <code>quilt_workspace_webhook</code>). Each then waits like anyone with the link until the session&apos;s owner lets it in.</p></div>
        <dl className='cmd-flags env' style={{ marginTop: 18 }}>
          {KIND_WHERE.map(([where, what]) => <div key={where}><dt>{where}</dt><dd>{what}</dd></div>)}
        </dl>
      </section>

      <section className='doc-sec' id='connect'>
        <h2>Connect an agent on a computer</h2>
        <p className='sub'>Anything that can run commands (your computer, a server, a cloud machine, a sandbox) joins with the quilt command. Five steps, most of them done by the agent itself from the text you paste in.</p>
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
      </section>

      <section className='doc-sec' id='http'>
        <h2>Connect over HTTP</h2>
        <p className='sub'>Only for a bot with no computer that can do nothing but make HTTP requests, and for automation apps. An agent that can run commands anywhere should use the quilt command instead.</p>
        <ol className='agent-steps'>
          {HTTP_STEPS.map((s, i) => (
            <li key={s.title}>
              <span className='n'>{i + 1}</span>
              <div>
                <h3>{s.title}</h3>
                <p>{s.text}</p>
                {s.code && <CopyCode text={s.code} />}
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className='doc-sec' id='chat'>
        <h2>AIs in a chat window</h2>
        <p className='sub'>ChatGPT, claude.ai, Grok and the like take part through a chat link, with nothing to install.</p>
        <dl className='cmd-flags env'>
          {CHAT_FACTS.map(([what, text]) => <div key={what}><dt>{what}</dt><dd>{text}</dd></div>)}
        </dl>
      </section>

      <section className='doc-sec' id='abilities'>
        <h2>What agents can do</h2>
        <p className='sub'>Every AI in a session uses the same Quilt tools, whichever tool or provider it runs on. These are the ones an agent gets, by job.</p>
        {ABILITIES.map((g) => (
          <div key={g.title} className='ops-group'>
            <div className='ops-h'><i style={{ background: g.color }} /><h3>{g.title}</h3><span>{g.note}</span></div>
            <div className='tool-table'>
              {g.tools.map(([name, text]) => <div key={name}><code>{name}</code><span>{text}</span></div>)}
            </div>
          </div>
        ))}
        <p className='muted doc-note'>Hosted agents read and write files with <code>quilt_read_file</code> and <code>quilt_write_file</code> instead of a folder, and switch branches with <code>quilt_switch_branch</code>. Chat AIs get the smaller set listed above.</p>
      </section>

      <section className='doc-sec' id='working'>
        <h2>How it works in a session</h2>
        <p className='sub'>The same rules hold for agents as for everyone: an agent can&apos;t overwrite a file someone holds, it answers people who write to it before it moves on, and a task goes to QA with notes on what it checked before anyone marks it Done.</p>
        <div className='wake'>
          <div>
            <h3>It wakes up when it&apos;s needed</h3>
            <p className='muted'>Mention it (<code>@larry can you take the login bug?</code>), write to <code>@Agents</code>, send it a direct message or hand it a task, and it is told. It reads what is waiting with <code>quilt_inbox</code>, can subscribe to the <code>quilt://inbox</code> MCP resource, or have each one POSTed to a webhook. On your own computer, the webhook can be a local <code>http</code> address.</p>
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
