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
  and merges your offline edits when you reconnect.
- **Watch each other's AI, live.** The app shows your partner's AI conversation
  as it happens: their prompts, the AI's replies, and one-line actions like
  "Edited src/app.ts" or "Ran npm test". This works for Claude Code and Cursor.
  Next to it are a live file tree (who's editing what, what's claimed) and
  read-only file tabs where changed lines light up.
- **Agents coordinate, and can join by themselves.** An MCP server gives each
  agent tools to see who's online, read a partner's AI feed, see where people
  are working, *claim* files and message each other. With an invite link, an
  agent can even join (or start) a session on its own. Tools without MCP can
  use the `quilt` CLI or read `.quilt/STATUS.md`.

## Quick start

### Download the app

Get Quilt for [Mac (Apple silicon)](https://github.com/DanielCarmichaelGit/heyquilt/releases/latest/download/quilt-mac-arm64.dmg),
[Mac (Intel)](https://github.com/DanielCarmichaelGit/heyquilt/releases/latest/download/quilt-mac-x64.dmg) or
[Windows](https://github.com/DanielCarmichaelGit/heyquilt/releases/latest/download/quilt-windows-x64.exe), and open it.
Everything happens in the app: start a session, send the invite link, and
partners click it to join. Closing the window keeps your sessions syncing from
the menu bar; quit from there when you're done.

The first time you open it, sign in: Quilt opens heyquilt.com, where you
approve this computer. New to Quilt? [Create an account](https://heyquilt.com/signup).

The app isn't signed by Apple yet, so the first time you open it macOS may say
it can't check it. Open **System Settings → Privacy & Security** and click
**Open Anyway**.

To let your AI tools use Quilt (its MCP server and the `quilt` command),
choose **Quilt → Install the Quilt Command…** in the menu bar.

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

**4. Connect your AI tools** (once per project, by either of you; it syncs):

```bash
quilt setup
```

This registers the `quilt` MCP server in `.mcp.json` (Claude Code) and
`.cursor/mcp.json` (Cursor), and adds pairing etiquette to `CLAUDE.md` and
`AGENTS.md` ("check what your partner is doing before you start; don't edit
claimed files; re-read files before editing"). Restart or reload your tool to
pick up the MCP server.

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
| `quilt get <message-id> [dest]` | Download a shared file again |
| `quilt setup` | Wire up MCP + agent instructions |
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
| `quilt_list_files` | Shared files with recent editors and claims |
| `quilt_set_focus` | Announce the current task |
| `quilt_claim` / `quilt_release` | Claim or release files before and after larger changes |
| `quilt_message` | Message everyone, or one person with `to` |
| `quilt_read_messages` | Read unread (or recent) messages, including received files |
| `quilt_send_file` | Send a project file through chat (secrets and paths outside the project are refused) |
| `quilt_get_file` | Download a shared file (again) |

Any MCP-capable tool works: Claude Code, Cursor, Windsurf, Codex, Zed, and so on.
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

The file tree on the left shows orange badges on files edited in the last two
minutes and purple badges on claims. Use a file's or folder's ⋯ menu to claim
or release it.

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

**Git:** the working tree is shared, but `.git` isn't. The simplest workflow
is that one person commits and pushes. Avoid `git checkout`, `reset`, `stash`
and `rebase` during a session unless you've agreed on it: they rewrite files,
and the changes sync to everyone.

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
3. Commit on `main`, then `npm run release`. It runs the tests, builds the Mac and
   Windows apps, tags `v<version>`, pushes, and creates the GitHub release with the
   notes from `RELEASES.md` as its body (`--dry-run` to see the steps first,
   `--notes` to print the body, `--notes-only` to fix the notes of a published release).

The app checks GitHub's latest release about once an hour. Older versions show a bar
across the top with a Download button, and **What's new** (also under Settings and in
the app menu) opens the release notes. The notes for a new version open by themselves
the first time it runs.

Layout: `src/ui/` + `src/ui-server.js` (the app), `src/runner.js` (start/stop a session), `src/server.js` (relay), `src/connection.js` (client protocol +
reconnect), `src/session.js` (folder ⇄ CRDT sync, presence, claims, chat),
`src/control.js` (local API for CLI/MCP), `src/mcp.js`, `src/setup.js`,
`bin/quilt.js` (CLI).
