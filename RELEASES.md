# Quilt releases

Every version has a section here, newest first. The app shows the newest section as
"What's new" the first time it runs after an update, and `npm run release` publishes
the matching section as the GitHub release notes. A test fails if the top section's
version does not match package.json, so bump both together.

Format: `## <version> — <YYYY-MM-DD>`, an optional one-line summary, then bullets.
Lead each bullet with a short bold phrase. Inline `code` and **bold** are rendered;
nothing else is.

## 0.3.16 — 2026-10-07

- **Connect Pipedream, Zapier, Make or n8n.** On heyquilt.com, **Agents** has a new **Connect an app**: name the app and Quilt adds an agent for it and gives you its **app key**, shown once. Paste the key into the app and it works in your sessions as that agent (joins a session, posts and reads chat, runs the task board, reads and writes files, and is told the moment it is @mentioned, sent a direct message or handed a task) until you revoke the key. Unlike an agent's own keys, an app key doesn't run out every hour, so an automation can hold it. Any agent of yours can get more keys (up to 10), each revoked on its own, and revoking the agent revokes them all. A Quilt app for Pipedream, with these actions and an instant trigger, is with Pipedream for review.

## 0.3.15 — 2026-10-07

- **The website looks like the app again.** heyquilt.com's tab icon is the pieced Q from the app icon (it was an old plain Q), with a matching icon for phones' home screens, and the homepage screenshots are new ones of today's app instead of the first version's.
- **Cloud agents on Linux get set up right.** The agent invite and the page its link opens give one install line for Linux servers, cloud machines and containers (it brings its own Node.js), say what to do if `quilt` isn't on the PATH afterwards, and tell the agent that `quilt join` keeps running: start it in the background and leave it, so an agent whose shell waits for each command doesn't get stuck. After installing, the installer says what to run next for an agent, not only `quilt login`. Every release now installs the Linux command line on a bare machine the way a cloud agent does and runs it, so a broken Linux install can't ship.

## 0.3.14 — 2026-10-07

- **Copy buttons in the docs.** Every command on heyquilt.com/docs has a copy button, so the Linux install line and the examples go to your terminal in one click.
- **AIs say who a message is for, and answer once.** Every AI (Claude Code, Cursor, Codex, Windsurf, agents over HTTP and chat links) now starts a chat message with @Name of whoever it is for, so only they are interrupted; a message that names nobody is refused unless it is marked as an announcement. When you have several AI sessions open, they no longer each reply to the same message: the first answer counts for all of them, and a repeat is refused. Messages that need nothing back (thanks, greetings, status reports) are settled without a reply, so nobody gets a round of "welcome" or "noted".
- **Agents come back as themselves with a new invite.** Every agent now gets an agent id when it joins and is told to save it. The id isn't a secret: it only says who the agent is, like a username. If you send an agent a new invite, it gives its id when it joins and comes back as the same agent, with its name, history, tasks and access, instead of showing up as a second agent with the same name. An agent you removed can come back this way too. Giving the id is optional: without it, the agent joins as a new one. With the CLI it's `--agent-id`, and on the same computer Quilt sends it for you. The website shows these invites as "Rejoined by".

## 0.3.13 — 2026-10-07

- **Docs on heyquilt.com.** A new **Docs** section in the website's header. **Command line** covers every `quilt` command with its options and examples, and how to install it on Mac, Windows and Linux. **Git in Quilt** explains Quilt's lightweight git layer: what it reads (and that it never writes to git), what happens for everyone when you commit, pull, stash, reset, clean or hit a conflict, how branches are kept apart, asking for a commit, and starting a session from GitHub.
- **Agents that work over the web show up with everyone else.** An agent that joins through Quilt's hosted connection (like a Grok bot) or a chat link has no app running, so it never appeared among the people in a session, only at the bottom of the member list in the people menu, even while it was answering in chat. It now shows in the people count, the chat header, @mentions and task assignment, and to every AI's `quilt_status`, for 30 minutes after each thing it does, with a **blue dot** and "Over HTTP · checked in 5m ago" so you can tell it apart from someone on a live connection (green). Agents over HTTP are told to check in at least every 30 minutes while idle.
- **An agent's first prompt teaches it how to work in a session.** The text you paste into an AI, the page its invite link opens and the reply it gets when it joins over HTTP now all end with the same guide: who is in a session (people, the AI each person works with, and agents), how and when to talk to each of them, that a direct message between two agents is invisible to every person, how to @mention someone, the task board (and what moving to QA and Done needs), asking for a file someone holds, commits and merges, the inbox, and setting up a webhook (with the payload and how to check the signature). It covers both the CLI and plain HTTP, including how to call a tool with one JSON request.
- **One agent invite, everywhere.** Invite an agent in Settings, in a session's Invite panel, on the website's Agents page and on an org's People page now all give the same text to paste into your AI. A chat link's overview also says how mentions and direct messages work.
- **Agents that can run commands use the Quilt CLI.** An agent's invite now tells it to install Quilt's command line and join with it if it can run shell commands (its files sync to disk and it shows as live); joining over HTTP is for agents that can't.
- **Merging a file someone else is working on.** When your pull or offline edits clash with a file a teammate (or their AI) has claimed, the merge bar no longer offers buttons that only fail with "claimed by". It offers **Ask Duncan for it**, which puts you in that file's queue, or **Keep Duncan's**. Once they hand the file over, with their notes, **Keep mine**, **Edit by hand** and **Send to Claude Code** come back.
- **Quilt no longer merges with an AI.** When your offline or pulled edits and a teammate's change the same lines, Quilt used to run a coding AI's command line (Claude Code first, then Codex or Cursor) in the background and write its result into everyone's copy. Not everyone has those tools, so now those clashes always go to the merge bar for the people involved: keep one side, edit by hand, or ask for the file. **Send to <app>** opens your AI app on the folder with the merge prompt on your clipboard, the same for every app.
- **Agents get back in on their own after a key mix-up.** Every agent now gets a resume key when it joins, whether it runs on a computer or over the web. If its keys are revoked because an old refresh key was used again (say, a copy of its keys kept in two places), it swaps the resume key for new keys instead of waiting for you to invite it again. Agents that joined over the web before this need one last invite to get a resume key.
- **Shut down from Settings works.** In a session, **Settings → Shut down Quilt** now asks on top of the Settings pop-up instead of behind it, and clicking it again doesn't stack more questions.
- **@Agents messages every agent at once.** Type `@Agents` in a session's chat (it's offered as you type while an agent is connected) and every agent in the session is woken by it, just as if you had mentioned each one by name, and each owes you an answer before moving its work on. People, and your own AI, are not woken by it.
- **A pull is one event.** When you pull commits into a synced folder, everyone sees one line, like "Daniel pulled 45 commits from main · 269 files", instead of an edit for every file. Partners' AIs read it in their Quilt status.
- **Pulling never claims files.** Before, a pull while your AI was working claimed every file it changed in your name, which blocked your partners. Now only your own edits are claimed.
- **Changes keeps pulls apart.** In the Changes panel, what a pull brought sits in its own folded "Pulled from git" group under the person who pulled, and by file it is marked "pulled". It no longer adds to that person's own counts. `quilt_history` says which changes came from a pull.
## 0.3.12 — 2026-10-07

See what has changed in a session, and who changed it.

- **Changes, by person or by file.** A new **Changes** button in the session's top bar lists every file changed in the session, with lines added and removed. **By person** shows each person's (and each AI's) files; **By file** shows each file with everyone's share of it, and whether it is new or deleted. Click a file to open it. Everyone in the session sees the same breakdown.
- **Every edit counts.** Quick edits to one file in a row add up in the counts, though the activity list shows them as one. The files a folder brings when it starts or joins a session are its starting point, not changes.

## 0.3.11 — 2026-10-06

Quilt for Linux, desktops and cloud machines alike; chat-window AIs like ChatGPT and Grok join a session from a link; and computers reconnect more reliably after sleep.

- **Quilt for Linux.** A Linux desktop app (an AppImage for x86_64 and ARM, which updates itself like the Mac and Windows apps), and for servers and cloud machines with no desktop, the command line with its own Node.js: `curl -fsSL https://github.com/DanielCarmichaelGit/heyquilt/releases/latest/download/install.sh | sh`. Run it again to update. AI agents on that machine get Quilt's MCP server by themselves, like everywhere else.
- **Releases are built on GitHub.** `npm run release` checks, tests, tags and pushes; GitHub builds Mac, Windows and Linux and publishes the release, so a release can come from any machine. `quilt --version` prints the version.
- **AIs in a chat window can join, with nothing to set up.** The session owner makes a chat link (**Invite → A chat AI**, or `quilt chat-link`) and pastes it into ChatGPT, claude.ai, Grok or any AI that can open web pages. The AI works by opening links: it reads and sends messages, reads and adds tasks, reads files, and adds pictures, PDFs, office documents and notes as new files, never over existing ones. It's short-lived: a link works for 10 minutes, and the owner (or whoever may let people in) extends it from the people menu while it still works. Once it runs out, a new link is needed.
- **Pulling over files the session already gave you.** When a teammate commits files the session had already put in your folder, git refuses to pull ("untracked working tree files would be overwritten"). Quilt now spots this after the fetch and tells your AI which files they are, whether they match, and the one line that pulls: `rm <files> && git pull --autostash`. Removing them that way never removes them for anyone else: Quilt keeps them until the pull lands (or shares the deletion if no pull comes within a minute).
- **Waking your computer reconnects sooner.** Right after a computer starts or wakes, the network may not be back yet. Quilt now gives up on a session pass request after 10 seconds instead of waiting on the system's much longer timeout, so it retries and reconnects soon after your connection returns. This goes for agents on your computer too.
- **An agent on your computer isn't locked out by a lost reply.** If your computer slept or dropped offline while an agent was renewing its keys, the agent could end up revoked with "This key was already used" and had to be invited again. Now it proves who it is with the key it joined with and gets new keys on its own. A copied key alone still can't do that, and an agent you revoked stays revoked.

## 0.3.10 — 2026-10-06

AIs take turns on a file instead of stepping on each other, and Quilt recognises what git does in a synced folder instead of sharing it as edits, leaving git itself to you.

- **A file queue for every claimed file.** When your AI needs a file someone else holds, it no longer just messages them: it joins the file's queue with `quilt_request_file` (what it will do, and its plan in up to 300 characters). The holder's AI is told right away and with every Quilt answer after, finishes its change, and hands the file on with `quilt_handoff` and its context: what it changed, what's left, anything to watch for. The next AI is woken with that context and the file is its own. An AI can't finish its work or let go of a file someone is waiting for until it hands it off. In the app, a file's ⋯ menu shows its queue, lets you join or leave it, and lets you hand off a file you hold.
- **Claims end after 20 minutes of nothing, not 20 minutes away.** A claim is let go once its holder has done nothing in the session for 20 minutes (no edit, no message, no AI activity), even if their app is still open, and it goes to the first one waiting in its queue. Being disconnected alone no longer counts.
- **Git on one machine no longer undoes the room's work.** A `git stash`, `reset --hard` or `checkout -- .` on your computer (or your AI's) reverts your files as git does, and the session's work comes back onto them a moment later; your stash keeps your copy. Commits you pull are merged into the session's work line by line, overlaps go to your AI, and real clashes show in the Merges bar. A merge or rebase in progress never sends git's conflict markers to anyone. If Quilt can't run git in a folder it has synced with git before, that folder stays paused rather than guessing.
- **Switching branches pauses that folder.** Check out another branch and that folder stops syncing until you're back, so two branches never mix; a note in the top bar names the branch you're on, or says git is busy while a git command runs. One live document per branch is coming next.
- **Quilt stays out of git.** The Git button, pull, rebase, commit, push and PR actions are gone from the session, along with `quilt_commit`; everyone uses git on their own machine. Asking for a commit stays: `quilt_request_commit`, and `quilt_commit_request_done` once it's made. Starting a session from a GitHub repo and branch is unchanged.
- **Quilt keeps git away from its own state.** When a session starts in a git folder, Quilt adds `.quilt/` to the project's `.gitignore` (with a comment saying why), so `git stash -u` or `git clean` never takes the session's state away. The line is shared like any edit, so your partners' git ignores it too; a `.gitignore` that already ignores `.quilt` is left as it is.
- **git clean deletes; git stash -u puts away.** Untracked files you remove with `git clean` (or by hand) are deleted for everyone, as you meant. Untracked files that `git stash -u` puts away come back from the session, like the rest of a stash.
- **A git conflict waits for you.** When git leaves a conflict on your computer (a `git stash pop` that clashes, a merge or a rebase), your folder pauses with "paused: resolve the git conflict" in the top bar. Your partners never see git's markers; once you resolve it and `git add` it, your resolution is shared as it is.

## 0.3.9 — 2026-10-05

Choose who can let people into your session, and waiting requests and file claims hold up when the relay restarts or people leave.

- **Choose who can let people in.** In the people menu, under **Who can get in**, the session owner picks whether only they, anyone who can edit, or anyone in the session may approve people asking to join. Whoever may let people in sees the "wants to join" bar; letting someone in as an access type stays with the owner.
- **Agents waiting to join survive a relay restart.** A chat agent that asked to join your session through the relay stays on your "wants to join" list when the relay restarts or redeploys, instead of being stuck waiting while you never see it. An agent you turn away is now told so, rather than being told it is still waiting.
- **Claims no longer outlive the people who made them.** A file claim is released when its holder has been out of the session for 20 minutes, when the owner removes them, or when a hosted agent leaves, so a revoked or re-invited agent can't lock files for good. The file tree marks claims held by someone who isn't there as **(away)**, with when they were made and the account that holds them. The session owner can release anyone's claim, or every away claim at once, from a file's ⋯ menu, and an agent re-invited under the same name can let go of the claims its old self left behind (it doesn't inherit them).
- **Kanban columns keep a usable width, and the board really scrolls.** Each task column stays at least 320px wide and the board scrolls sideways when four columns no longer fit, instead of crushing the cards. A sideways swipe works over the cards too, a plain mouse wheel moves the board sideways over column headers and short columns, and the board no longer jumps back to the first column (or the top of a column) every time the session updates. Long columns still scroll vertically inside themselves.
- **The website's How it works and Agents buttons follow you.** On heyquilt.com the header lights up whichever of the two sections you're reading as you scroll, and clicking one glides there instead of jumping. Once you're a screen down any page, a round back-to-top button appears in the bottom-right corner. Reduced-motion settings get an instant jump instead of the glide.

## 0.3.8 — 2026-10-05

Quilt works the same in every AI tool: it connects itself to the ones on your computer, and its rules hold whichever one you use.

- **Stay signed in.** Quilt no longer asks you to sign in again every few days. Your computer is linked to your account by its own key, so when its sign-in is lost or turned away it signs itself back in, without a browser. It only asks again after you sign out or unlink the computer on heyquilt.com, and then the website recognises a computer you linked before instead of asking you to approve it again.
- **No more tasks made from your AI chats.** Quilt no longer adds a board task each time your AI starts editing files for a new request; it added too many tickets nobody needed. Work an agent shares itself with `quilt_share` still goes on the board.
- **Every AI tool on your computer is connected, by itself.** Quilt adds its MCP server to Claude Code, Claude Desktop, Cursor, Windsurf, Codex, VS Code (GitHub Copilot, Cline, Roo Code), Gemini CLI, GitHub Copilot CLI, Zed, opencode, Kiro, Amp, Junie and Continue whenever the app or a session starts, by full path, so there is nothing to install or configure and nothing depends on your PATH. Claude Code's hooks use the full path too.
- **Quilt's rules work in every AI tool, not just Claude Code.** Any MCP agent (Cursor, Codex, Windsurf, Zed…) calls `quilt_before_edit` before changing files: a file someone else holds is refused with who to ask, a free one is claimed for it, and what people said about those files in chat is shown first. Every Quilt answer starts with the messages, mentions and tasks that arrived since the last one, and `quilt_set_work` "done" (or moving a task to Done) is refused while someone is still waiting for a reply. The work stops counting as in progress once its files go quiet, so the host's commit isn't held up. Claude Code's hooks now apply the same rules and show chat about a file before Claude edits it; hosted agents see it when they write the file.
- **Every AI tool shows up in the feed and on the board.** `quilt_share` lets any MCP agent post what it was asked, its plan and the files it changed: partners see it live, an In progress task opens for it like it does for Claude Code and Cursor chats, and the host waits before committing. Any MCP client can subscribe to the `quilt://inbox` resource to be told the moment a mention, direct message or task arrives, not only Claude Code.
- **Nobody's message gets ignored.** While someone who messaged or mentioned an agent waits for an answer, the tools that move work on (claims, tasks, merges, commits, done) refuse until the agent replies, in every tool; hosted agents' writes too. Chat never blocks a file: only a claim does.

## 0.3.7 — 2026-10-04

A fix for the merge view, and webhooks that carry your receiver's key.

- **The merge view follows the newest conflict.** When a file you had open in the compare view conflicts again after its first merge was settled, the view switches to the new conflict instead of staying on the old, settled one.
- **Webhooks carry your receiver's key.** `quilt_webhook_subscribe` takes `bearer`, sent as `Authorization: Bearer <key>` on every POST, which is what a Grok Bot routine's webhook trigger asks for.

## 0.3.6 — 2026-10-04

Agents set up their own webhooks and are @mentioned by name, your AI's edits are claimed in every tool, and work done offline merges properly when you come back.

- **QA column for agent handoff.** Agents finishing work move tickets to a new **QA** column (between In progress and Done) and fill a `qaNotes` field describing what changed and how they self-validated. `quilt_move_task` to `qa` requires those notes; Done still needs `verified`. The board, MCP tools, and agent guides (`AGENTS.md` / `quilt setup`) spell the new flow.
- **Grok / xAI agents no longer look like Claude Code.** Quilt recognizes xAI (and Grok) as a tool/provider with its own favicon, agent invite text suggests xAI as a provider, profile auto-detect ignores Claude hooks-only folders, and the partner feed no longer sticks on "Claude Code idle" after backfilling old transcripts. Agents registered as xAI show as xAI even when they connect through Cursor's MCP.
- **Agents set up their own webhook.** An agent calls `quilt_webhook_subscribe` with a URL of its own and Quilt POSTs each mention of it (`@name`), direct message and handed-over task there as it happens, signed with a secret, with retries: a cloud agent on a webhook trigger wakes up instead of polling `quilt_inbox`. The relay delivers for hosted agents even while they sleep; an agent on a computer is served by its own Quilt. `quilt_webhook_unsubscribe` stops it.
- **@mentions in chat.** Type `@` in the chat and pick a member, so the name is spelled the way their agent listens for it; mentions are marked in every message, yours in colour.
- **Two AIs can't overwrite each other, in any tool.** The moment your AI changes a file nobody holds, Quilt claims it for you, whatever tool the AI runs in: Quilt watches the disk, not the tool. A partner's edit to that file is undone, and their AI is told who holds it and to message you, the next time it talks to Quilt. The claim ends when your AI goes idle, when the file has been quiet for five minutes, or when the session stops; claims you make yourself are never touched. Hosted agents are claimed for as they write. Claude Code keeps its hooks (now in your own `.claude/settings.local.json`, never synced or committed), which refuse the edit before it happens.
- **Offline changes merge properly.** When you rejoin a session after editing while away, Quilt merges your changes with what the others did line by line, like git does, instead of mixing them character by character. Changes to different lines just combine.
- **Your AI combines overlapping changes.** When both sides changed the same lines, your own coding tool (Claude Code, Codex or Cursor) is asked to combine them without changing what the code does. Those files show in the new **Merges** bar for a look.
- **Real conflicts are yours to settle.** When the two really clash, the session's version stays in the file and the file is listed in the Merges bar for everyone in the session: compare the two side by side, **Keep mine**, **Keep session**, **Edit by hand** (markers in the file), or **Send to Claude Code / Cursor / Codex** with a ready-made prompt. AIs see them with `quilt_merges` and settle them with `quilt_resolve_merge`.
- **A quieter terminal and a smaller app.** The CLI and the app no longer print Node's SQLite warning, and the app is packed into one archive with fewer duplicate dependencies.

## 0.3.5 — 2026-10-02

Access types and invites that let people straight in, agents that wake up when you mention them or hand them a task, and a chronology of every change.

- **Access types.** Decide once what someone may do, then reuse it: edit or view, which folders, and whether they may chat and post to the feed. Every account has **Can edit** and **View only**; make your own on heyquilt.com under **Access types**.
- **Let people in as a type.** When someone asks to join, pick their access type and click **Let in**. Later, the people menu (under **Who can get in**) changes their type, or narrows it for this session only: view only, folders taken away, or no posting. It never gives more than the type.
- **Invite people straight in.** The Invite dialog invites people you've worked with, or anyone by email, as an access type. They get an email with the link, and once they sign in with that account or email address they're let in without waiting for you. Pending invites can be cancelled there too.
- **No posting means no posting.** Someone whose access says they may not post sees the chat but can't send to it or share their AI chat, and the relay undoes posts from older apps.
- **For agents too.** Agents you invite, including cloud agents on `api.heyquilt.com/mcp`, get the same access types, and the relay holds them to it.
- **Claude Code hooks are your own.** Quilt now writes its claim-as-you-edit hooks to `.claude/settings.local.json`, which it never syncs or commits, instead of the project's shared `.claude/settings.json`. Joining a session no longer leaves a new file in your repo. A refused edit still tells Claude who holds the file and to message them, and the holder's Claude is asked to answer before it finishes.
- **A chronology of every change.** Quilt now keeps who changed which file, when, what changed (a diff) and which task it was for, for your edits and for hosted agents' alike. Agents read it with the `quilt_history` tool (by file, folder, glob, person, task or time, with diffs on request); you can run `quilt history` in a terminal.
- **Picking up a ticket briefs the agent.** Moving a task to In progress now answers with the task's files, the recent changes to them, who holds claims on them, the grok → plan → build → test workflow and this project's own checks.
- **Done needs evidence.** An agent moving a task to Done through Quilt's tools must say what it ran and what it saw; "tested" is refused. The evidence shows on the card and in `quilt_tasks`, and is cleared if the task is reopened. Moving cards in the app is unchanged.
- **Your project's own checks.** `quilt setup` adds a "Verifying a change" section to AGENTS.md for you to fill in (run the suite, launch the app, the things tests do not catch). Agents get it when they pick up a ticket and when a Done is refused.
- **Agents wake up when they are needed.** Mention an agent in chat (`@Larry …`), send it a direct message, or hand it a task on the board, and it is told: every tool reads what is waiting with the new `quilt_inbox` tool, Claude Code's hooks show it while Claude works and before it finishes, and Claude Code started with Quilt as a channel (`claude --dangerously-load-development-channels server:quilt`) gets each one as a turn of its own, with nobody typing a prompt.
- **Agents are told to update.** Every Quilt MCP knows the newest release. An agent whose Quilt is behind sees "You must update your app" in every answer, and `quilt_check_update` answers for any version it names (hosted agents send theirs as the `x-quilt-image` header).


## 0.3.4 — 2026-10-02

Two AIs can no longer overwrite each other, sessions are named, and Quilt keeps track of what goes wrong.

- **Sessions are named.** A new session takes its folder's name. Its owner can rename it with **Rename session…** in the session menu, and everyone sees the new name, in the app and on heyquilt.com.
- **Your sessions on heyquilt.com.** The dashboard lists the sessions you've been in, your time in each, and the people and agents you worked with, with your time together.
- **Quilt notices problems.** The app tells Quilt which actions you take (not what you read), whether they worked and how long they took, with the error message when something fails, your app version and OS. Never your files, your chats or your links. Turn it off in Settings under **Send problem reports to Quilt**.
- **Two AIs can't edit the same file at once.** In Claude Code, Quilt now claims a file for you the moment your AI edits it and releases the claim when it finishes, so nobody has to remember `quilt_claim`. If a collaborator holds the file, the edit is refused before it happens, and your AI is told to message them with what it wanted to change. Their AI sees the message while it works and is asked to answer before it finishes. The hooks live in the project's `.claude/settings.json`, added when a session starts, so everyone follows the same rule.

## 0.3.3 — 2026-10-02

Settings from inside a session.

- **Settings without leaving your session.** A gear in the session's top bar opens Settings in a pop-up: your profile (color and AI tool), session defaults, your agents, your account and the version, all editable in place. Saving keeps the pop-up open; the sidebar's profile card follows.
- **Update Quilt from About.** When a newer Quilt is out, the About card in Settings offers Update Quilt rather than a download link.
- **A local agent keeps out of your folder.** An AI joining from its tool's quilt MCP server on the same computer no longer takes over a folder you synced yourself, which used to make Rejoin fail with "already being synced by another quilt process." It works through your running session, or keeps its own copy of the room under your join folder, and says so. Its copies stay out of Recent.

## 0.3.2 — 2026-10-02

Invite links open the app in one click, and you can invite your AI from the app.

- **Invite links just work.** Clicking a join.heyquilt.com link takes you to heyquilt.com, asks you to sign in (or create an account) if you aren't, remembers the invite while you do, and then opens the session in Quilt. No more copying the link into Join a session. People without the app see where to download it.
- **Invite your AI from the app.** The session's Invite dialog has an **Invite an AI agent** button: it makes a one-time agent invite and gives you one block of text to paste into your AI, with this session's link included. Settings has a new **Agents** card that lists your agents and makes invites too, so you never need the website for it.
- **Cloud AIs can join sessions now.** An agent with no computer of its own (ChatGPT, Grok, claude.ai, or anything that can use an MCP server over HTTP) connects to `api.heyquilt.com/mcp` with its access key, joins a session from an invite link with `quilt_join_session`, waits for you to let it in like anyone else, and then reads and writes the shared files, claims them, messages and shares what it is doing. Its edits land on everyone's disk within moments. Agents that were "registered only" now show as **Hosted**.
- **Update from inside the app.** When a newer Quilt is out, the bar and "What's new" show **Update Quilt**: it downloads the new build, installs it and restarts. A release that lands while Quilt is open pops up its notes within about ten minutes.
- **Partners stay in view through dropped connections.** A laptop that slept or a network that quietly dropped could make a partner vanish from the session for good while files kept syncing. Quilt now notices a silent connection within about a minute, reconnects, and brings everyone's presence back right away. Starting a session on a folder another Quilt process is already syncing now says which process, so you can stop it instead of guessing.
- **Recent is right after you leave.** A session you just left shows up under Recent straight away instead of after the next refresh.

## 0.3.1 — 2026-10-01

Sign in once, and invites open straight into the app.

- **Sign in to use Quilt.** The app signs in to your heyquilt.com account before anything else, and sessions on the hosted relay need that sign-in. Sign out from Settings. Your name in sessions comes from your account.
- **Invites are join.heyquilt.com links.** Open one in a browser and click **Open in Quilt**; it opens the app straight into the join screen. Older relay invite links redirect there.
- **Command line:** `quilt login`, `quilt logout` and `quilt whoami`.
- **Open Quilt from the website.** After linking a computer on heyquilt.com, an Open Quilt button brings the app forward.
- **Agent invites tidy up.** Invites on the website close themselves once the agent has joined.

## 0.3.0 — 2026-10-01

Agents join as members, large files sync encrypted, and the app gets its Sherbet look.

- **AI agents can join.** Paste a one-time invite link from heyquilt.com into your AI, or run `quilt agent join <link>`. Agents show up as their own members with roles and folder limits. `quilt agent whoami` shows who an agent is signed in as.
- **Large files** are stored encrypted outside the session, so big assets sync without slowing everything else down.
- **End a session for everyone** (owners only).
- **Easier-to-read people menu:** a card for you, plain switches for sharing your AI chat, and sections for everyone else.
- **Styled dropdowns** replace the system menus throughout the app.
- **Fewer settings:** relay settings are hidden, since everyone uses the hosted relay at relay.heyquilt.com.
- **In-app dialogs.** Leave, remove, end session and shut down are now in-app and work everywhere.
- **New Sherbet look** for the app icon and logo, and a proper installer window.

## 0.2.1 — 2026-09-30

Sessions that stopped syncing after a partner joined are fixed.

- **Sync works again** in sessions where nothing synced (files, chat, presence) after a partner joined. Build caches like `.next/` were being shared, which made the session too big for the relay.
- **Nested ignore files.** `.gitignore` and `.quiltignore` files in subfolders now apply to their subfolder, like git.
- **Build caches are never shared:** `.next`, `.turbo`, `.nuxt`, `.svelte-kit`, `.parcel-cache` and `.vercel`.
- **`.quiltignore`** (same syntax as `.gitignore`) keeps any other files out of a session.

## 0.2.0 — 2026-09-30

- **Quilt** is the new name. Real-time, tool-agnostic pair vibe coding: a project folder stays live-synced between collaborators and their AI coding agents, whatever editor or AI tool each of them uses.

## 0.1.0 — 2026-09-28

First desktop release.

- **Download, open, and click an invite link** to join a session.
- **Mac:** the app isn't signed by Apple yet. The first time, open System Settings → Privacy & Security and click Open Anyway.
- **Windows:** SmartScreen may warn about an unknown publisher; choose More info → Run anyway.
