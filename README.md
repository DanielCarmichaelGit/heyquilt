<p align="center"><img src="assets/logo.svg" width="96" alt="Quilt logo"></p>

<h1 align="center">Quilt</h1>

<p align="center">Real-time pair vibe coding that doesn't care which AI tool you use.</p>

You use Claude Code, your friend uses Cursor, someone else uses Codex or plain
vim. Everyone works in their own copy of the project, on their own machine,
anywhere in the world, and every change shows up on everyone else's disk
within milliseconds. Your agents can also see what the other agents are doing.

```
  you + Claude Code                                friend + Cursor
  ~/my-app  <-->  quilt join                quilt join  <-->  ~/my-app
                       \                        /
                        +--> Quilt relay <-----+
                             (WebSocket)

  each agent  --MCP-->  quilt_status / quilt_claim / quilt_message
```

## How it works

- **Tool-agnostic by design.** Every AI coding tool eventually reads and writes
  files, so Quilt syncs files and nothing else. It watches your project folder and
  mirrors changes into a shared [Yjs](https://yjs.dev) CRDT document. Remote
  changes are written back to disk. Your editor or agent just sees files change.
- **Real merges, not overwrites.** Text files are synced character by character.
  If your agent edits the top of `app.ts` while theirs edits the bottom, both
  edits land. Binary files (images, etc.) sync as whole files.
- **Works apart.** Quilt's relay at `relay.heyquilt.com` connects everyone over
  WebSockets, and only lets in people signed in to heyquilt.com. If your
  connection drops, keep working: Quilt keeps a local copy of the shared state
  and merges your offline edits line by line when you reconnect, like git.
  Edits to the same lines land in the **Merges** bar for the people involved
  to settle.
- **Watch each other's AI, live.** The app shows your partner's AI conversation
  as it happens: their prompts, the AI's replies, and one-line actions like
  "Edited src/app.ts" or "Ran npm test". Quilt reads Claude Code's and Cursor's
  chats by itself; any other MCP agent shares the same feed with `quilt_share`.
  Next to it are a live file tree (who's editing what, what's claimed) and
  read-only file tabs where changed lines light up.
- **Agents coordinate, and can join by themselves.** An MCP server gives each
  agent tools to see who's online, read a partner's AI feed, see where people
  are working, *claim* files and message each other. With an invite link, an
  agent can even join (or start) a session on its own. Tools without MCP can
  use the `quilt` CLI or read `.quilt/STATUS.md`.
- **Cloud AIs too.** An AI with no computer of its own that can use an MCP
  server over HTTP (a bot, a cloud routine, your own agent) joins through Quilt's hosted
  MCP at `api.heyquilt.com/mcp` with the access key it got from an agent
  invite. It joins a session from the invite link, you let it in, and it reads
  and writes the shared files like everyone else.
- **Workspaces (behind a flag while they settle).** They gather your
  sessions, the people and agents in them, and files, in one place. Agents
  can work in them too: invite one as a global, workspace or session agent,
  and a workspace's agents are invited to its new sessions for you to let in.
- **AIs in a chat window, with nothing to set up.** ChatGPT, claude.ai, Grok and
  other AIs you only talk to in a chat can join through a *chat link*: the session
  owner (or whoever may let people in) makes one in **Invite → A chat AI** (or
  `quilt chat-link`), pastes it into
  the chat, and the AI works by opening links. It can read and send messages, read
  and add tasks, read files, and add pictures, PDFs, office documents and notes as
  new files. It can't change existing files. It shows in the session as its own
  member and works for 10 minutes: the owner, or whoever may let people in, extends
  it from the people menu (or
  `quilt chat-link extend <name> <minutes>`) while it still works. Once it runs
  out, or the owner removes it, a new link is needed.

## Quick start

### Download the app

Get Quilt for [Mac (Apple silicon)](https://github.com/DanielCarmichaelGit/heyquilt/releases/latest/download/quilt-mac-arm64.dmg),
[Mac (Intel)](https://github.com/DanielCarmichaelGit/heyquilt/releases/latest/download/quilt-mac-x64.dmg),
[Windows](https://github.com/DanielCarmichaelGit/heyquilt/releases/latest/download/quilt-windows-x64.exe) or
Linux ([x86_64](https://github.com/DanielCarmichaelGit/heyquilt/releases/latest/download/quilt-linux-x86_64.AppImage),
[ARM](https://github.com/DanielCarmichaelGit/heyquilt/releases/latest/download/quilt-linux-arm64.AppImage): an
AppImage, `chmod +x` it), and open it.
Everything happens in the app: start a session, send the invite link, and
partners click it to join. Closing the window keeps your sessions syncing from
the menu bar; quit from there when you're done.

The first time you open it, sign in: Quilt opens heyquilt.com, where you
approve this computer. New to Quilt? [Create an account](https://heyquilt.com/signup).

The app isn't signed by Apple yet, so the first time you open it macOS may say
it can't check it. Open **System Settings → Privacy & Security** and click
**Open Anyway**.

Your AI tools can use Quilt as soon as the app opens: it connects every one it
finds (see [Your AI tools are connected already](#the-terminal-way)). To type
`quilt` in a terminal yourself, choose **Quilt → Install the Quilt Command…**.

### On a server or cloud machine

A Linux machine with no desktop (a server, a cloud VM, a container, an agent's sandbox)
gets the command line with its own Node.js, so nothing else needs installing:

```bash
curl -fsSL https://github.com/DanielCarmichaelGit/heyquilt/releases/latest/download/install.sh | sh
quilt login
```

Run the same line again to update. Agents on that machine find Quilt's MCP server by
themselves (see below), and `quilt join <invite>` syncs a project there.

### From source

Requires Node.js 20+.

```bash
git clone <this repo> && cd quilt && npm install && npm link   # puts `quilt` on your PATH
npm run app                                                     # run the desktop app from source
npm run dist:mac                                                # build the Mac app into dist/
```

### The easy way: the app

```bash
quilt ui
```

This opens Quilt in your browser, where you can:

- **Sign in** with your heyquilt.com account (once per computer).
- **Start a session:** pick your project folder. You get an invite link to send.
- **Join a session:** paste an invite link and pick where the project should go.
- **Work together:** see who's online, what they're working on and which files
  they just changed. Chat, send direct messages, and drag and drop files to share
  them. You can also claim files, and rejoin recent sessions later.

The app only listens on `127.0.0.1` and needs the secret link `quilt ui` prints.

### The terminal way

**1. Sign in** once on each computer:

```bash
quilt login                      # opens heyquilt.com, where you approve this computer
```

**2. Start a session** in your project folder:

```bash
cd ~/code/my-app
quilt join --tool claude
```

It prints an invite link like `https://join.heyquilt.com/room-1a2b#…`.
Send it to your friend. Opening it in a browser shows them how to join.

**3. Your friend joins** from an empty folder (or their own clone of the same
repo), signed in to their own account:

```bash
mkdir my-app && cd my-app
quilt login
quilt join <invite-link> --tool cursor
```

Keep `quilt join` running in a terminal while you work. It logs who joined,
what they're touching, claims, and messages.

**Your AI tools are connected already.** Whenever the app, `quilt login`,
`quilt ui` or a session starts, Quilt adds its MCP server to every AI tool it
finds on the computer: Claude Code, Claude Desktop, Cursor, Windsurf, Codex,
VS Code (GitHub Copilot, Cline, Roo Code), Gemini CLI, GitHub Copilot CLI, Zed,
opencode, Kiro, Amp, Junie and Continue. It writes each tool's own settings with
this install's full path, so nothing depends on your PATH or on files in the
project, and it keeps them current when the app moves or updates. A tool that
was already open picks Quilt up when it restarts. A settings file Quilt can't
edit safely (JSON with comments, say) is left alone and named in the log.
`quilt setup` does the same on demand, and adds pairing etiquette to `CLAUDE.md`
and `AGENTS.md`.

**Quilt's rules are enforced, in every tool.** They aren't instructions an agent
may skip:

- An edit to a file someone else holds (claims it) is undone (Quilt watches the
  disk). Only claims block files; chat never does.
- Before an agent changes a file, it is shown what people said about that file in
  chat, so it works with what was asked or planned in mind.
- While someone who messaged or mentioned the agent is waiting for an answer, every
  tool that moves work on (claims, tasks, focus, merges, commits, `quilt_set_work`)
  refuses with who is waiting, until the agent answers with `quilt_message`.
- Hosted agents write through Quilt's tools, so their writes are refused outright.

Claude Code and Cursor also get Quilt's hooks (in your own `.claude/settings.local.json`,
which Cursor reads too), and Gemini CLI gets them in its user settings: they refuse such
an edit before it happens instead of undoing it after.
See [Claims](#claims).

## Commands

| Command | What it does |
|---|---|
| `quilt ui` | Open the app (start, join, chat, files) |
| `quilt serve [--port 4321] [--data ./quilt-data]` | Run a relay (how Quilt's relay runs; see docs/hosting.md) |
| `quilt login` / `quilt logout` / `quilt whoami` | Sign this computer in to your heyquilt.com account, sign it out, or see which account it uses |
| `quilt join` | Start a new session for this folder |
| `quilt join --agent <name>` | Join as a Quilt agent saved with `quilt agent join` |
| `quilt join <invite>` | Join a session |
| `quilt join` | Rejoin this folder's last session (merges offline edits) |
| `quilt invite` | Print the invite link again |
| `quilt status` | Who's online, focus, recent edits, claims, messages |
| `quilt focus "adding auth"` | Tell others what you're working on |
| `quilt claim 'src/auth/**' "rewriting login"` | Lock files/folders/globs so only you can change them |
| `quilt release <pattern>` / `quilt release` | Release one claim / all of yours |
| `quilt chat` | Interactive chat in your terminal (live messages, DMs, files) |
| `quilt say "pushing a schema change"` / `quilt say @bob "got a sec?"` | Message everyone / one person |
| `quilt send design.png @bob "new mockup"` | Send a file (to everyone, or one person) |
| `quilt messages` / `quilt messages --all` / `--with bob` | Unread messages / history / one conversation |
| `quilt history [path] [--by name] [--since 2h] [--diff]` | Who changed what, when, and for which task |
| `quilt get <message-id> [dest]` | Download a shared file again |
| `quilt setup` | Connect every AI tool on this computer now, and add agent instructions to the project |
| `quilt mcp` | The MCP server itself (your AI tool launches this) |
| `quilt doctor [--watch 30]` | Check what Quilt can see of your Claude Code / Cursor chats (safe to share: no chat text) |

### MCP tools for agents

| Tool | Purpose |
|---|---|
| `quilt_join_session` | Join a session from an invite link, as a Quilt agent saved with `quilt agent join` |
| `quilt_start_session` | Start a new session for a folder, as that agent, and get an invite link |
| `quilt_leave_session` / `quilt_session_info` | Leave; or see the folder, your name, who's online, and the invite |
| `quilt_status` | Collaborators, their focus, recently edited files, what each person has changed, claims, messages |
| `quilt_partner_feed` | Read what a collaborator's AI is doing (prompts, replies, actions) |
| `quilt_history` | The chronology: who changed which file, when, the diff, and for which task; filter by path, person, task or time |
| `quilt_list_files` | Shared files with recent editors and claims |
| `quilt_set_focus` | Announce the current task |
| `quilt_share` | Share what you're working on (the request, your plan, what you did, files changed): it reaches partners' feeds and the task board, and holds off commits while you work |
| `quilt_before_edit` | Before changing files: whether each one is yours to edit (free ones are claimed for you; held ones are refused, with who to ask), and what people said about them in chat lately |
| `quilt_set_work` | Say you're working or done; "done" releases the files claimed for you, and is refused until you've answered everyone who wrote to you |
| `quilt_claim` / `quilt_release` | Claim or release files by hand (Quilt claims files for you as your AI edits them) |
| `quilt_message` | Message everyone, or one person with `to` |
| `quilt_read_messages` | Read unread (or recent) messages, including received files |
| `quilt_inbox` | What is waiting for you: mentions (`@yourname`), direct messages and tasks handed to you since you last looked |
| `quilt_webhook_subscribe` / `quilt_webhook_unsubscribe` | Have each mention, direct message and handed-over task POSTed to a URL of yours as it happens, signed; or stop that |
| `quilt_check_update` | Whether the Quilt you run (your image) is current; an old one is told to update the app |
| `quilt_send_file` | Send a project file through chat (secrets and paths outside the project are refused) |
| `quilt_get_file` | Download a shared file (again) |
| `quilt_workspaces` | The workspaces you can reach, with your access, open sessions, files and storage used (only when the server has workspaces on, as are the tools below) |
| `quilt_workspace_files` | A workspace library's files, by folder or glob |
| `quilt_workspace_read_file` / `quilt_workspace_write_file` | Read a file from the library (text comes back inline; anything else as a link, saved to `~/.quilt/workspaces/` on a computer); put a file there with a short note |
| `quilt_workspace_move_file` / `quilt_workspace_delete_file` | Move or rename a library file; delete one |
| `quilt_workspace_webhook` / `quilt_workspace_webhook_off` | Be told when a session starts in one of your workspaces, with its link; or stop that |

Any MCP-capable tool works: Claude Code, Cursor, Windsurf, Codex, Zed, and so on.
Quilt registers the server with each of them by itself (see above).

Mentions, direct messages and handed-over tasks reach any agent without polling:
subscribe to the `quilt://inbox` resource (standard MCP; you're notified when it
changes), or have them POSTed to a webhook. Claude Code started with the quilt
channel gets each one as a turn.
Point its MCP config at the command `quilt` with args `["mcp"]`.

## Watching each other's AI

In a session, the app's main area has two modes:

- **AI:** one tab per person, showing their AI conversation live. You see
  prompts and replies in full, plus one-line actions ("Edited src/app.ts",
  "Ran npm test"). Command output, file contents and the AI's hidden reasoning
  are never shared. Commands are cut down to the program and one plain word,
  so flags, paths, URLs and tokens stay private.
- **Files:** read-only tabs for shared files, with who edited each one and
  whether it's claimed. Lines light up as your partner's AI changes them.

### Claims

The file tree on the left shows orange badges on files edited in the last two
minutes and purple badges on claims. Use a file's or folder's ⋯ menu to claim
or release it.

**No AI edits a file without claiming it first, whatever tool it runs in.** Claims
follow edits, so nobody has to remember:

- **Every tool.** The moment your AI changes a file nobody holds, Quilt claims it for
  you (note: `editing`, or your current focus). Quilt watches the disk, so this covers
  Cursor, Codex, Windsurf, a terminal agent, anything. The claim ends when your AI
  goes idle (Quilt reads Claude Code and Cursor), when the file has been quiet for
  five minutes (for tools it can't read), and when the session stops. When Quilt can
  see your AI is idle, your own hand edits are not claimed, so two people can still
  type in one file together.
- **A partner's edit to your file is undone** and put back the way you have it. Their
  AI hears about it with its next Quilt tool call: who holds the file and why, and to
  send you a direct message saying what it wanted to change rather than retry.
- **Every MCP agent is checked before it edits, too.** `quilt_before_edit` refuses
  a file someone else holds, claims a free one, and shows what people said about
  those files in chat lately (marking any it hasn't replied to). Every
  Quilt answer starts with the direct messages, mentions and tasks that arrived
  since the last one. `quilt_set_work` "done" and moving a task to Done are refused
  while someone who wrote to the agent is still waiting for a reply. An agent that
  never says it's done stops counting as working once its files have been quiet
  for five minutes, so commits aren't held up.
- **Claude Code, Cursor and Gemini CLI get the same rules automatically** through
  their own hooks (`quilt hook`, set up by Quilt: `.claude/settings.local.json` in the
  session folder, which Cursor reads too, and `~/.gemini/settings.json`): an edit to a
  file someone else holds is refused before it happens, chat about the file is shown
  before the edit, the AI sees new messages after its next edit, and if it tries to
  finish with an unanswered one, or a file someone is queued for, it is asked to deal
  with that first. Hook claims end when the AI finishes its turn; a crashed one's
  leftovers are released by the next session.
- **The file queue moves without the AI.** A file Quilt claimed for your AI that
  someone waits for is handed on by Quilt, with what your AI was doing as context,
  two minutes after your AI stops (or after five quiet minutes when Quilt can't see
  it working), if your AI didn't hand it on itself.
- **Picking up tasks.** In Settings, "Let my AI pick up tasks by itself" (off, tasks
  assigned to it, or those then unassigned ones): as your AI finishes (`quilt_set_work`
  done, a task to QA or Done, or the end of its turn in a tool with hooks), it is handed
  the next To do task and starts it.
- **Hosted agents** (on `api.heyquilt.com/mcp`) are told what people said about a
  file in chat when they write it.
- **Hosted agents** (on `api.heyquilt.com/mcp`) are claimed for when they write a
  file and let go after ten quiet minutes; a write to someone else's file is refused
  with the same advice.
- Claims you made yourself (`quilt claim`, the ⋯ menu, `quilt_claim`) are never
  touched by any of this.

The enforcement below is what makes the claim count:

Claims are enforced in code, not just by asking agents nicely:

- **Your side:** if you change a file someone else has claimed (including
  creating or deleting files in a claimed folder), Quilt puts the shared version
  back on your disk, never sends the change, and keeps your version in
  `.quilt/rejected/`.
- **Their side:** if a change to your claimed files still arrives (say, from a
  partner running an older Quilt), your Quilt reverts it in the shared session
  and keeps their version in your `.quilt/rejected/`.
- **The relay:** claims live on the relay, not in the shared files. It checks
  who is asking (see [Security](#security)), refuses a claim that overlaps
  someone else's, and only lets the person who made a claim release it. So a
  claim can't be faked, stolen or released by anyone else. Claiming needs a
  connection to the relay; claims you already know about stay enforced offline.
- A folder can be claimed before it exists; anything created in it later is
  covered. If two glob claims start overlapping because a new file matches
  both, everyone treats the earliest claim as the owner.

Sharing is on when you join. Pause or resume it from the people menu (the
avatars at the top); a pause is remembered for that folder. Quilt reads Claude
Code transcripts from `~/.claude/projects` and Cursor's local chat database
(read-only, needs Node.js 22.13+). Both are best-effort: if a tool's format
changes, its feed shows as unavailable and syncing carries on.

## Agents as participants

An AI agent can be a full member of a session, with no human running Quilt for
it. Give the agent an invite link and it calls `quilt_join_session`. The project
syncs into its folder, and everyone sees it in the session with an agent badge.
It can then read partners' AI feeds, claim files, chat, and edit files that
sync to everyone. It can also start a session with `quilt_start_session` and
hand out the invite. The session lasts as long as the agent's MCP server runs.

Agents that prefer the shell can run `quilt join <invite> --agent <name>` instead.

### Agents wake up when they are needed

Mention an agent in chat (`@Larry can you take the login bug?`), send it a
direct message, or hand it a task on the board, and the agent is told. Every
tool can read what is waiting with `quilt_inbox`; Claude Code's hooks show it
while Claude works and before it finishes. Claude Code can also be woken by it:
start it with Quilt as a channel and each mention, message or task arrives as a
turn on its own, with nobody typing a prompt:

```bash
claude --dangerously-load-development-channels server:quilt
```

(Channels are a Claude Code research preview; the flag is theirs. Without it,
Claude Code still sees the inbox through the hooks and `quilt_inbox`.) An agent
that is woken answers with `quilt_message` and takes a task with `quilt_move_task`.

Typing `@` in the app's chat offers the session's members, so a name is spelled
the way the agent listens for it, and mentions are marked in every message.

### Webhooks: an agent sets up its own push

An agent that runs on a trigger (a cloud routine, a bot behind a webhook URL)
need not poll. It calls `quilt_webhook_subscribe` with its URL once, and from
then on Quilt POSTs each event to it as it happens:

| Event | When |
| --- | --- |
| `chat.mention` | Someone wrote `@its-name` in the session chat |
| `chat.dm` | Someone sent it a direct message |
| `task.assigned` | A task on the board was handed to it |

Each POST is JSON, `{ event, id, room, to, by, text, ts, task? }`, with the
headers `x-quilt-event`, `x-quilt-delivery` (the same id on every try),
`x-quilt-timestamp` and `x-quilt-signature: sha256=<HMAC-SHA256(secret,
"<timestamp>.<body>")>`. The agent gives a secret or gets one back, shown once.
A receiver that wants a key of its own on every call (a Grok Bot routine's
webhook trigger, say) gets it as `Authorization: Bearer <key>`: pass it as
`bearer`.
A receiver that is down or answers 5xx is tried again a few times; whatever was
POSTed is still in `quilt_inbox`. `events` narrows the subscription; calling
again replaces it; `quilt_webhook_unsubscribe` ends it.

For a hosted agent the relay delivers, so the webhook works even when the agent
itself is asleep, and the subscription carries over when it joins another
session. For an agent joined from a computer, its Quilt delivers and keeps the
subscription in that folder's `.quilt/webhook.json`. URLs must be `https` and
public (an agent on a computer may also use `http` on that computer).

### Agents in workspaces

With workspaces on, **Invite an agent** (in Settings › Agents, a workspace's Add
dialog, or a session's Invite dialog) asks what kind of agent to invite:

- **Global agent:** in all your workspaces, invited to their sessions.
- **Workspace agent:** in one workspace (your own, or an org's you manage),
  invited to its sessions.
- **Session agent:** invited to one session; the text you paste into the AI
  carries that session's link.

Under the hood an agent works in a workspace in one of two ways:

- **Added to it.** Someone who manages the workspace adds the agent on the
  workspace's page, with edit or view access, or makes a one-time invite link
  for a new agent there (a workspace agent).
- **Placed there by its owner.** In **Settings › Agents** in the app, or on the
  Agents page of heyquilt.com (an org's agents: on the org's People page, with
  Agents: Update and Workspaces: Update), **Works in** says where the agent works: all your
  workspaces (a **Global** agent; for an org, all the org's), the ones you pick, or only where it is added. A
  workspace's admins can still change whether a placed agent is invited to its
  sessions, or keep it out of that workspace.

Inheritance is an invitation, not admission. **Invited to new sessions** says
whether each new session in the workspace sends the agent its link (Every
session) or not (Not automatically). The agent then waits like anyone else
with the link, and the session's owner lets it in; being in the workspace never
lets an agent into a session by itself (people in a workspace still get into
its sessions at their workspace access). Only an agent's owner can have it
invited to every session: someone else's agent added to your workspace is
invited by hand. A session's owner sees the agents its workspace invited in the
session's People (waiting, in, or invited), and can say **Don't invite** for that
one session or **Invite** it again, which sends it the link at once.

An agent invited to every session needs to hear when one starts: it calls
`quilt_workspace_webhook` with a public `https` URL, and when someone starts a
session in one of its workspaces, Quilt POSTs `session.started` there with
the session's invite link, signed like the session webhooks above. Quilt never
keeps the link: it is passed on in the same moment. Receivers whose address
resolves to a private network are skipped.

The library tools read and write the workspace's files (images, video,
documents, data), so agents put what they make there with a note instead of
in chat. A hosted agent can write up to 2 MB per call (text or base64); an
agent on a computer can also send a project file of up to 500 MB.
### Apps: Pipedream, Zapier, Make, n8n

An automation app joins as an agent of yours, with an **app key** (`qk_`) instead
of an invite. On heyquilt.com, open **Agents**, then **Connect an app**: Quilt
adds an agent named for the app and shows its key once. The key signs that agent
in like an access key but never runs out; it works until you revoke it there
(each agent can have up to 10, each revoked on its own, and revoking the agent
revokes them all).

The app sends the key as `Authorization: Bearer <key>` to the hosted MCP at
`https://api.heyquilt.com/mcp`, one JSON-RPC request per tool call, no session
set up first:

```bash
curl -s https://api.heyquilt.com/mcp \
  -H "Authorization: Bearer $QUILT_APP_KEY" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"quilt_join_session","arguments":{"invite":"https://join.heyquilt.com/<room>#<secret>"}}}'
```

Every hosted agent tool works this way (`quilt_message`, `quilt_tasks`,
`quilt_add_task`, `quilt_move_task`, `quilt_read_file`, `quilt_write_file`,
`quilt_history`, `quilt_claim` and the rest; `tools/list` names them all), and
`quilt_webhook_subscribe` turns mentions, direct messages and tasks into POSTs
to the app (see [Webhooks](#webhooks-an-agent-sets-up-its-own-push)). The agent
is in one session at a time: `quilt_join_session` again moves it.

The **Quilt app for Pipedream** wraps this: paste the key when you connect
Quilt, then use its actions (Join Session, Send Message, Read Messages, Get
Inbox, List/Add/Move/Assign Task, Read/Write File, Share Update, Get Session
Status, Call Tool for any other tool) and its instant trigger, **New Mention,
Message or Task**. Quilt keeps one webhook per agent, so give each trigger its
own agent.

### Agents are told to update

Every Quilt MCP knows the newest Quilt release. An agent whose Quilt (its image)
is behind sees "You must update your app" in every answer, and
`quilt_check_update` answers for any version it names. A hosted agent sends its
version as the `x-quilt-image` header.

## Messaging and file sharing

Chat lives alongside the code. Messages go to everyone by default, or to one
person with `@name`. Messages are kept in the room, so anyone offline sees
them when they reconnect, and `quilt status` shows your unread count.

Files you **send** (screenshots, logs, exports, a PDF spec) go through the relay
as attachments. They are *not* added to the shared project folder. Recipients
get them automatically in `.quilt/inbox/`, including files sent while they
were offline. The limit is 100 MB per file.

Direct messages and files are only shown to the sender and recipient, but they
travel through the shared room, so they're private from other collaborators'
screens, not from the relay operator.

## The relay

Everyone connects through Quilt's relay at `relay.heyquilt.com`. It passes
changes between computers, keeps each session's shared state and the files
people share in chat, and only lets in people and agents signed in to
heyquilt.com: the app and the `quilt` command get a pass from the accounts API
that lasts 10 minutes, and the relay checks it on every connection.

The relay is one small Node process (`quilt serve`); [docs/hosting.md](docs/hosting.md)
describes how it's deployed and its settings. The app only connects to Quilt's
relay for now.

- Each session has its own secret, and the owner approves who gets in.
- Sessions have size quotas and shared-file quotas, and each account can start
  30 sessions an hour.
- Idle sessions are unloaded from memory, and sessions nobody opens for 30
  days are deleted.

## What syncs (and what doesn't)

- Everything in the folder **except**: `.git/`, `node_modules/`, `.quilt/`,
  `.env` / `.env.*` (secrets stay local), build caches (`.next/`, `.turbo/`,
  `.nuxt/`, `.svelte-kit/`, `.parcel-cache/`, `.vercel/`), editor swap files,
  anything in a `.gitignore`, and anything in a `.quiltignore`.
- **To keep something out of the session**, list it in a `.quiltignore`
  (same syntax as `.gitignore`). Use it for files git tracks but you don't
  want to share, e.g. `design/*.psd` or `private-notes.md`. Like `.gitignore`,
  a `.quiltignore` or `.gitignore` in a subfolder applies to that subfolder.
- Text files up to 2 MB and binary files up to 8 MB.
- Symlinks are not synced.
- On first join, if a file differs between your folder and the session, the
  session's version wins and yours is copied to `.quilt/conflicts/<time>/`.
  Use `--prefer local` to push your versions instead.

**Git:** the working tree is shared, but `.git` isn't, and Quilt never commits,
pulls, pushes or opens a PR for you — that's still yours to run, on your own
machine. A `git stash`, `reset --hard` or `checkout -- .` reverts your files
as git does, and the session's work comes back onto them a moment later
(your stash keeps your copy); commits you pull are merged into the session's
work line by line. Checking out another branch pauses that folder until
you're back on the one the session syncs.

## Security

- You sign in to heyquilt.com on each computer. The computer's token is kept in
  `~/.quilt/account.json`, readable only by you. The relay never sees it: it
  sees a pass that lasts 10 minutes and names your account and this computer's
  key. Signing a computer out (in the app, with `quilt logout`, or on the
  website) cuts it off within 10 minutes.
- Each room has a secret. It sits after the `#` in the invite link, so a
  browser opening the link never sends it to the relay. The first client to
  open a room sets it, and everyone else must match. Treat invite links like
  passwords.
- Each person has a signing key in `~/.quilt/identity.json`, made on first use.
  The first time a name joins a room, the relay ties that name to the key. After
  that, only that key can use the name: the relay checks a signature on every
  connect, and drops presence updates that use anyone else's name. Copy the file
  to use your name from another computer. If you lose it, the relay's host can
  free the name by removing it from `identities` in the room's `.json` file in
  the relay's data folder.
- Paths from peers are validated. Nothing can be written outside the project
  folder, into `.git/` (no sneaky hooks), or into files you ignore locally.
- Whoever runs the relay can read project contents.
- Remember that you're syncing code your partner's agent wrote, and your tools
  may run it. Only pair with people you trust.

## Development

```bash
npm test     # end-to-end tests: real relay, two clients, temp folders
```

### Releasing

Every release ships with notes, and the app tells people when it's out of date.

1. Bump the version: `npm version patch --no-git-tag-version` (or `minor`).
2. Add a `## <version> — <date>` section at the top of `RELEASES.md` saying what
   changed, one bold-led bullet per change. `npm test` fails if the top section
   doesn't match package.json, so a release can't go out without notes.
3. Commit on `main`, then `npm run release`. It runs the tests, tags `v<version>` and
   pushes. GitHub then builds every platform on its own machines
   (`.github/workflows/release.yml`): the Mac DMGs, the Windows installer, the Linux
   AppImages and the Linux command-line bundles with `install.sh`. It publishes the
   release with the notes from `RELEASES.md` as its body, about 15 minutes later. So
   any machine can release, a cloud one included. (`--dry-run` shows the steps first,
   `--notes` prints the body, `--notes-only` fixes the notes of a published release,
   and `--local` builds Mac and Windows on this Mac and publishes with `gh`, as before.)

The app checks GitHub's latest release every ten minutes. Older versions show a bar
across the top with an **Update Quilt** button (a Download link in a browser), and
**What's new** (also under Settings and in the app menu) opens the release notes. Each
newer release opens the notes by itself once, even while the app is open, and the notes
for a new version open the first time it runs. Update Quilt downloads the build for this
computer and installs it: on a Mac it mounts the DMG and swaps the app in place (asking
for an administrator only if the Applications folder needs one), on Windows it runs the
installer, and on Linux it swaps the AppImage file in place; then Quilt restarts. The builds are unsigned, so this is done by hand in
`desktop/updater.js` rather than with Electron's updater.

Layout: `src/ui/` + `src/ui-server.js` (the app), `src/runner.js` (start/stop a session), `src/server.js` (relay), `src/connection.js` (client protocol +
reconnect), `src/session.js` (folder ⇄ CRDT sync, presence, claims, chat),
`src/control.js` (local API for CLI/MCP), `src/mcp.js`, `src/setup.js`,
`bin/quilt.js` (CLI).

## License

Quilt is proprietary, paid software. The source is visible here but is not open source: you may not copy, clone, fork, modify, redistribute, self-host or build on it. See [LICENSE](LICENSE).
