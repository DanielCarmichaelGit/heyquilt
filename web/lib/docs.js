// Pure, no Next imports: the docs pages' table of contents and the CLI reference, so a test
// can check every command in `quilt --help` (bin/quilt.js) is documented here.

/** The docs pages, in the order the sidebar lists them. */
export const DOCS_NAV = [
  { href: '/docs', label: 'Command line' },
  { href: '/docs/agents', label: 'Agents' },
  { href: '/docs/git', label: 'Git in Quilt' }
]

/**
 * The CLI reference, in groups. Each command: `name` (what follows `quilt`, as `quilt --help`
 * names it), `usage`, `text`, and optional `flags` ([flag, meaning]) and `example`.
 */
export const CLI_GROUPS = [
  {
    id: 'account',
    title: 'Your account',
    text: 'Every session signs in, as you or as an agent you approved. A computer you signed in once signs itself back in.',
    commands: [
      { name: 'login', usage: 'quilt login [--no-browser]', text: 'Sign this computer in to your heyquilt.com account. It prints a link and a short code; open the link, check the code matches and approve the computer.', flags: [['--no-browser', "Don't open the page; just print the link, for a server or a remote shell."]] },
      { name: 'logout', usage: 'quilt logout', text: 'Sign this computer out of your account.' },
      { name: 'whoami', usage: 'quilt whoami', text: 'Show which account this computer is signed in to.' }
    ]
  },
  {
    id: 'sessions',
    title: 'Sessions',
    text: 'A session is one project folder kept in step between everyone in it. Run these in the project folder.',
    commands: [
      { name: 'ui', usage: 'quilt ui [--port 7420] [--no-open]', text: 'Open the Quilt app in your browser: start or join sessions, chat, the task board and the file tree. Keep the terminal open while you work.', flags: [['--port <n>', 'The local port for the app (7420 by default).'], ['--no-open', "Start it without opening a browser."]] },
      { name: 'join', usage: 'quilt join [<invite-link>] [options]', text: "With a link, join a partner's session in this folder. Without one, rejoin this folder's last session, or start a new one and print its invite link.", example: 'quilt join https://join.heyquilt.com/room-602e#…', flags: [['--dir <folder>', 'The project folder (the current folder by default).'], ['--tool <tool>', "What you're coding with, such as cursor or codex, shown to others."], ['--prefer local', 'On a first join, keep your version of files that differ. By default you take the session\'s version and yours is backed up to .quilt/conflicts/.'], ['--agent <name>', 'Join as an agent saved with quilt agent join, instead of as you.'], ['--room <name> --secret <secret>', 'Join or create a named room instead of using an invite.']] },
      { name: 'invite', usage: 'quilt invite', text: "Print the invite link for this folder's session, to send to a partner." },
      { name: 'status', usage: 'quilt status', text: "Who is in the session, which files are claimed, recent activity and chat. It's the same picture every AI gets." },
      { name: 'stop', usage: 'quilt stop', text: 'Shut down everything Quilt is running on this computer: the app and every folder it syncs.' }
    ]
  },
  {
    id: 'talking',
    title: 'Chat and files',
    text: 'The session chat, from a terminal. People, their AIs and agents all read the same chat.',
    commands: [
      { name: 'chat', usage: 'quilt chat', text: 'Live chat in this terminal. Type a message, @name for a direct message, /send <file>, /get <id>, /who or /quit.' },
      { name: 'say', usage: 'quilt say [@name] <message>', text: 'Send one message to everyone, or to one person with @name.', example: 'quilt say @sam pricing table is ready for a look' },
      { name: 'send', usage: 'quilt send <file> [@name] [message]', text: "Share a file in chat. It isn't added to the project." },
      { name: 'messages', usage: 'quilt messages [--all] [--with name] [--grep text] [--before id] [-n 30]', text: 'Show your unread messages, or read back: your whole conversation with one person, a search, or earlier messages. Quilt keeps the chat past the session\'s newest 500 messages.', flags: [['--all', 'Show the history, not just unread.'], ['--with <name>', 'Your conversation with one person: direct messages either way, and messages that @mention one of you.'], ['--grep <text>', 'Only messages containing this text.'], ['--before <id>', 'Only messages before this one, to page further back.'], ['-n <count>', 'How many to show.']] },
      { name: 'get', usage: 'quilt get <message-id> [dest]', text: 'Download a file someone shared in chat again.' }
    ]
  },
  {
    id: 'working',
    title: 'Working together',
    text: 'Tell the room what you are doing and keep two people (or two AIs) off the same file.',
    commands: [
      { name: 'focus', usage: "quilt focus <what you're doing>", text: "Tell everyone what you're working on. It shows next to your name." },
      { name: 'claim', usage: 'quilt claim <path|glob> [reason]', text: "Mark files as yours for now. Others' edits to them are refused and they can queue for them. Your edits claim files for you anyway; this is for claiming ahead.", example: 'quilt claim "src/pricing/**" reworking plans' },
      { name: 'release', usage: 'quilt release <path|glob|*>', text: 'Let go of a claim, or of all of yours with *.' },
      { name: 'history', usage: 'quilt history [path] [--by name] [--since 2h] [--task id] [--diff] [-n 30]', text: 'Who changed what, when, and for which task.', flags: [['--by <name>', "One person's (or one AI's) changes."], ['--since <time>', 'Only changes since then, such as 30m or 2h.'], ['--task <id>', 'Changes made for one task on the board.'], ['--diff', 'Show each change as a diff.'], ['-n <count>', 'How many to show.']] },
      { name: 'commit', usage: 'quilt commit <message> [--files a,b] [--branch name] [--pr] [--with-others] [--task id]', text: "Commit your work to GitHub from the session's copy, with no git or credentials needed here and nobody else online. Exactly those files go in (by default, your changes on record). Agents commit to a branch of their own unless the session owner lets them commit to any branch; people may commit anywhere. Needs the session owner's GitHub connected (Connect GitHub, in the app's commit panel).", example: 'quilt commit "Blog covers" --files web/public/blog/cover.webp,web/app/blog/page.js --pr', flags: [['--files <a,b>', 'The files to commit, deleted ones too.'], ['--branch <name>', 'Where to commit; by default a branch of your own, or the session\'s branch when allowed.'], ['--pr', 'Open a pull request from your branch to the session\'s branch.'], ['--with-others', "Also commit files that hold someone else's uncommitted changes (they're named as co-authors)."], ['--task <id>', "The task this was for: its title is the message and its changes the files."]] },
      { name: 'commit-request', usage: 'quilt commit-request <message> [--files a,b] [--task id]', text: "Ask a person to commit for you, when quilt commit can't (agents may not commit in this session, or the repository isn't on GitHub). A person with git on the branch commits exactly those files from their app, and you are told the commit." },
      { name: 'commits', usage: 'quilt commits', text: 'Open commit requests and recent commits.' },
      { name: 'github-token', usage: 'quilt github-token [--clear]', text: "Owner: a GitHub token for the session's repository, read from stdin, instead of connecting GitHub. With read access the relay brings in commits while everyone's offline; with write access agents can commit. It stays on the relay and is never shown again." },
      { name: 'workspace', usage: 'quilt workspace list|files|get|put|write|mkdir|mv|rm', text: "The workspace library: pictures, video, documents and data the workspace's people and agents share. Run it in your session folder: an agent's own folder acts as that agent, anywhere else as the person signed in on this computer. A workspace is its name or id.", example: 'quilt workspace put Launch cuts/teaser.mp4 ./teaser.mp4 --note "first cut"', flags: [['list', 'The workspaces you can reach.'], ['files <workspace> [folder] [--glob g]', 'What is in the library.'], ['get <workspace> <path> [--version n]', 'Read a file: text is printed, anything else saved and its path printed.'], ['put <workspace> <path> <file> [--note n]', 'Upload a file from this project; the same path again adds a version.'], ['write <workspace> <path> <text>', 'Save text as a file.'], ['mkdir <workspace> <folder>', 'Make a folder.'], ['mv <workspace> <path> <new path>', 'Rename or move a file or folder.'], ['rm <workspace> <path>', 'Delete a file or folder.']] }
    ]
  },
  {
    id: 'ais',
    title: 'AIs and agents',
    text: 'Your own AI tools see the session through Quilt\'s MCP server. Agents join as members in their own right.',
    commands: [
      { name: 'setup', usage: 'quilt setup', text: "Connect the AI tools on this computer to Quilt's MCP server: Claude Code, Cursor, Codex, Windsurf, VS Code, Gemini CLI, Zed and more. The app does this by itself whenever it starts; a tool that was already open picks it up when it restarts." },
      { name: 'agent', usage: 'quilt agent join <link> --name <name>', text: 'Join Quilt as an agent, with an invite link from the website. Someone approves it and sets what it can do; then it joins sessions with quilt join --agent <name>.', flags: [['--agent-id <id>', 'An agent that joined before comes back as itself, with its history, tasks and access.'], ['--provider <p>', 'Who makes the agent, shown on its badge.'], ['--type <t>', 'What kind of agent it is.'], ['--description <d>', 'A line about what it does.']], also: 'quilt agent whoami --name <name> shows who a joined agent is.' },
      { name: 'chat-link', usage: 'quilt chat-link [name] [--minutes N]', text: 'Session owner: make a link for an AI that lives in a chat window (ChatGPT, claude.ai, Grok). It joins by opening the link and can chat, read files and tasks, and add new files. A link works for 10 minutes.', also: 'quilt chat-link extend <name> <minutes> keeps it working longer.' },
      { name: 'doctor', usage: 'quilt doctor [folder] [--watch 30]', text: "Check what Quilt can see of your AI tools' chats in a folder. --watch keeps looking for that many seconds while you prompt." },
      { name: 'mcp', usage: 'quilt mcp', text: 'Run the MCP server. AI tools start this themselves once quilt setup has connected them.' },
      { name: 'hook', usage: 'quilt hook', text: "Claude Code's hook, installed by quilt setup. It reads the event on stdin; you never run it by hand." }
    ]
  },
  {
    id: 'hosting',
    title: 'Hosting',
    text: 'Quilt runs a relay for you at relay.heyquilt.com. These are for running your own.',
    commands: [
      { name: 'serve', usage: 'quilt serve [--port 4321] [--data ./quilt-data] [--key <key>]', text: 'Run a relay server: the one piece everyone in a session connects to. One small Node process and a data folder.', flags: [['--port <n>', 'The port to listen on (4321, or $PORT).'], ['--data <folder>', 'Where sessions are kept (./quilt-data, or $QUILT_DATA).'], ['--key <key>', 'Only people with this key can start sessions (or set QUILT_RELAY_KEY).']] },
      { name: 'api', usage: 'quilt api [--port 8787] [--memory]', text: 'Run the accounts API. It needs SUPABASE_URL and friends; --memory keeps everything in memory for local testing.' }
    ]
  }
]

/** Every command name the reference documents. */
export const CLI_COMMANDS = CLI_GROUPS.flatMap((g) => g.commands.map((c) => c.name))

/** Environment variables a person running the command line might set. */
export const CLI_ENV = [
  ['QUILT_DEBUG', 'Set to anything to print debug lines while a folder syncs.'],
  ['QUILT_SECRET', "A room's secret, for quilt join --room without --secret."],
  ['QUILT_RELAY_KEY', 'For quilt serve: the key needed to start sessions on your relay.'],
  ['QUILT_DATA', 'For quilt serve: where the relay keeps sessions.']
]
