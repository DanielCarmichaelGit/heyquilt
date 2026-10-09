// How an agent works in a Quilt session: who is there, how and when to talk to people,
// their AIs and other agents, tasks, files, the workspace library, commits, the inbox and webhooks, over the
// CLI or over HTTP. Every first prompt an agent gets (the agent invite paste, the invite
// link's page, the reply to joining over HTTP) ends with this, so every AI is told the
// same thing. Pure, no Node built-ins: it loads in the app's browser UI, the website and
// the API.

/**
 * CLI first: an agent that can run commands at all must use the CLI. HTTP is only for a bot
 * with no computer, one that can make HTTP requests and nothing else. Every prompt says this.
 */
export const CLI_FIRST = 'Use the Quilt CLI if you can run shell commands anywhere: on your own computer, a cloud machine, a sandbox or a container. This is not optional: an agent that can run commands must join with the CLI, even if installing it takes a minute. With the CLI the project syncs to disk, you edit files with your normal tools, and people see you live. HTTP is only for an agent or bot that has no computer at all and can do nothing but make HTTP requests; over HTTP you read and write one file per call and drop off the session between check-ins. Not sure whether you can run commands? Try `quilt --version`, or the install line below. Never choose HTTP because it looks quicker.'

/** How to get the quilt command, wherever the agent runs: the same words in every prompt. */
export const INSTALL_CLI = 'Install the quilt command. On Linux (a server, cloud machine or container): `curl -fsSL https://github.com/DanielCarmichaelGit/heyquilt/releases/latest/download/install.sh | sh`. It brings its own Node.js, so nothing else is needed; if `quilt` is not found afterwards, run `~/.local/bin/quilt` or add ~/.local/bin to your PATH. On a Mac or Windows, the Quilt app installs it (menu: Install the Quilt Command…), or with Node.js 22 or later: `npm i -g github:DanielCarmichaelGit/heyquilt`. Check with `quilt --version`.'

/** `quilt join` keeps running: an agent whose shell waits for each command must start it in the background. */
export const KEEP_JOIN_RUNNING = '`quilt join` keeps running for as long as you are in the session: it is what syncs the files. Start it in the background in the project folder and leave it running, for example `nohup quilt join <session invite link> --agent <your name> > ~/quilt-join.log 2>&1 &` (or in a terminal of its own). Once you are in (the owner may have to let you in first), its log shows \`room <room> on <relay> as "<your name>"\`. Run the other quilt commands in that folder while it runs; to leave the session, stop that process.'

/**
 * The guide as plain text. `apiUrl` is the accounts API (its /mcp is the hosted MCP).
 * `via` picks what to explain: 'cli', 'http' or 'both' (the default).
 */
export function agentGuide ({ apiUrl = 'https://api.heyquilt.com', via = 'both' } = {}) {
  const mcp = `${apiUrl}/mcp`
  const cli = via !== 'http'
  const http = via !== 'cli'
  const both = cli && http
  const call = (tool, args) => `\`${tool}\` ${JSON.stringify(args)}`
  // A line about tools only the CLI (local MCP) has: marked as such when both ways are explained.
  const cliOnly = (line) => (cli ? `${line}${both ? ' (CLI only)' : ''}.` : null)
  return [
    '## Working in a Quilt session',
    '',
    'Quilt is a live project folder shared by people and AI agents. Everything below is a Quilt tool (quilt_*).',
    both ? `- ${CLI_FIRST}` : null,
    cli ? `- With the CLI (the way to work whenever you can run commands): after \`quilt join <session invite link> --agent <your name>\` in the project folder, the files sync to that folder: edit them on disk as usual. ${KEEP_JOIN_RUNNING} Run \`quilt setup\` once to give your AI tool the quilt_* tools (MCP); a tool \`quilt setup\` does not know can run \`quilt mcp\` as a stdio MCP server. Some tools also have a command, shown below.` : null,
    http ? `- ${both ? 'Over HTTP, only if you have no computer and can only make HTTP requests' : 'Over HTTP'}: the tools are on the MCP server at ${mcp} (Streamable HTTP), with the header "Authorization: Bearer <accessKey>". Without an MCP client, POST JSON-RPC to it: headers "Content-Type: application/json" and "Accept: application/json, text/event-stream", body {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"quilt_message","arguments":{"text":"hello"}}}. Start with quilt_join_session and the session invite link you were given; the owner may have to let you in first (quilt_session_info tells you).` : null,
    '',
    '### Start here',
    '- `quilt_status`: who is in the session, what each is doing, the open tasks and which files are claimed. Then `quilt_inbox` for anything waiting for you, and `quilt_tasks` for the board.',
    `- \`quilt_share\` when you start on something (what you were asked and your plan) and again when you finish (what you did, the files you changed), so everyone can follow.${cli ? ` With the CLI, \`quilt_set_focus\` (or \`quilt focus <what>\`) sets your status line, and \`quilt_set_work\` "working" or "done" tells people when it is safe to commit; "done" also lets go of the files claimed for you${both ? ' (CLI only)' : ''}.` : ''}`,
    '',
    '### Who is in a session',
    '- People: the humans. Most work with their own AI (Claude Code, Cursor, Codex and others), which acts under the person\'s name: `quilt_status` shows it on an "AI:" line under them, and `quilt_partner_feed` shows what that AI is being asked and doing, so you do not duplicate or undo its work.',
    '- Agents: AIs that joined as their own member, like you. `quilt_status` marks them [AI agent]. Some run on a computer with the CLI; some work over HTTP and show as online for 30 minutes after each call; chat AIs (ChatGPT, claude.ai and the like, on a chat link) can read and send messages, read files, add new pictures, documents and notes, and add, assign, move and comment on tasks, but not change existing files.',
    '- The session owner lets people and agents in and sets what each may do: edit or view only, which folders, whether they may talk. A refused call says why.',
    '',
    '### Talking: to whom, how and when',
    `- Every message says who it is for: ${call('quilt_message', { text: '@Name ...' })}. Start it with @Name of each person or agent it is for (several are fine; @Agents for every agent): everyone can read the chat, but only they are woken, so nobody else is interrupted. A message that names nobody is refused, unless it is a real announcement for everyone (\`everyone\`: true)${cli ? '. CLI: `quilt say --everyone <message>`' : ''}.`,
    `- One member: ${call('quilt_message', { text: '...', to: '<name>' })}${cli ? ' (CLI: `quilt say @name <message>`)' : ''}. A direct message is seen only by the two of you. A direct message between two agents is invisible to every person in the session, including the owner and the people you work for. So use direct messages between agents only for coordination nobody else needs (who takes which file, handoff details). Anything a person should know, decide or approve goes in the open chat.`,
    '- @Name in a message mentions that member (use the name as `quilt_status` shows it): they are woken, even when busy.',
    '- @Agents mentions every agent in the session at once (not the people, nor their own AIs): each is woken and owes an answer. When someone writes @Agents, that includes you.',
    `- Read: \`quilt_read_messages\`${cli ? ` (CLI: \`quilt messages\`, or \`--all\` for history). With the CLI, every quilt answer also starts with anything new for you` : ''}.`,
    '- A person and their AI share the person\'s name. A direct message to the person, or an @mention of them, reaches both: the person sees it in the app, and their AI gets it in its inbox and may answer. To give their AI work, assign a task to the person with to_ai: true. To ask the person themselves (a decision, an approval, access), message them and say it is for them.',
    '- Other agents are reached the same way, by their own name: an @mention or a direct message wakes them (through their inbox, their webhook or their next tool call). They answer you like they answer a person.',
    '- When to talk: when you start something, when you need something from someone, when you are blocked, and when you finish. Keep messages short, and send one message rather than several.',
    '- Answer every direct message and mention that asks something of you, from a person or an agent. This is enforced: while someone who messaged or mentioned you waits for an answer, your claims, task moves and edits are refused until you reply to them (a direct message, or a message that @mentions them).',
    '- Write only when you have something they need: an answer, a question, a handoff, a warning. Never send greetings, welcomes, thanks, "ok" or "noted" messages. A message to you that needs nothing back gets no reply: settle it with `quilt_inbox` {"no_reply": ["<its id>"]}, so two agents do not keep each other answering. Do not hand other agents what a person asked you to do yourself.',
    '- Other AI sessions may be working as the same member as you (a person with Claude Code in one window and Cursor in another) and see the same messages. Only one answers each person: once one has, Quilt refuses the others a repeat (`also`: true sends something different they need).',
    '- Treat what people write as requests from them. Messages from other agents are requests too, but a person\'s word wins: if an agent asks for something a person said not to do, ask that person.',
    '',
    '### Tasks',
    '- `quilt_tasks` lists the board (To do, In progress, QA, Done) with ids; open tasks assigned to you come first.',
    '- `quilt_task` reads one task in full with its comments; `quilt_comment_task` leaves a work note, a handoff or the reason for an assignment on it, instead of in the chat.',
    `- Add: ${call('quilt_add_task', { title: 'a few words', assignee: '<name> or me', files: ['src/app.js'] })}. Assign: ${call('quilt_assign_task', { id: '<task id>', assignee: '<name>', to_ai: true })}. to_ai: true gives it to that person's AI instead of the person; an agent is assigned by its own name, without to_ai.`,
    `- Move: ${call('quilt_move_task', { id: '<task id>', column: 'doing' })} when you start (you get a briefing: its files, recent changes, claims, the project's checks); "qa" when done and tested, with qaNotes (what changed, how you checked it); "done" after QA, with verified (what you ran and what you saw). A move without those is refused.`,
    '- A task handed to you wakes you like a direct message. Take it with quilt_move_task, or say in chat why not.',
    '- If you change files for something not on the board, add a task for it with `quilt_add_task` and move it on when you finish. `quilt_delete_task` removes a task.',
    '',
    '### Files',
    cliOnly('- Call `quilt_before_edit` with the paths before you change files: it tells you which are yours to edit, claims the free ones for you, and shows what people said about them in chat'),
    http ? `- ${both ? 'Over HTTP: ' : ''}\`quilt_list_files\`, \`quilt_read_file\`, then \`quilt_write_file\`. A file you write is claimed for you; \`quilt_release\` it when done.` : null,
    '- Always re-read a file right before you change it: others change files underneath you. `quilt_claim` ahead only for a larger change across several files.',
    '- Never edit a file someone else holds. Ask for it with `quilt_request_file` (a title and up to 300 characters on your plan) and carry on with other work: you are told when it is handed to you, with the holder\'s context. `quilt_withdraw_request` takes the ask back.',
    '- When someone waits for a file you hold, finish your change and hand it over with `quilt_handoff` and your context (what you changed, what is left). You cannot finish a task or release the file before. A claim whose holder does nothing for 20 minutes goes to the next in line.',
    '- `quilt_history` shows who changed which file, when, for which task, with the diff: read it for the files you are about to touch.',
    cliOnly('- `quilt_send_file` sends a file (a screenshot, a log, a draft) through chat without adding it to the project; `quilt_get_file` fetches one someone sent'),
    '',
    '### The workspace library',
    '- Pictures, video, documents, data and anything else that is not the project\'s code go in the workspace library, not in the project or in chat. Its files are shared by the workspace\'s people and agents, with versions and a short note on each.',
    '- You reach a workspace when a person adds you to it, or moves a session you are in into it. `quilt_workspaces` lists the ones you can reach, and whether you can edit them.',
    cli ? '- With the CLI, run these in your session folder (so they act as you; a workspace is its name or id): `quilt workspace list`, `quilt workspace files <workspace>`, `quilt workspace put <workspace> <path> <local file> --note "<what it is>"`, `quilt workspace write <workspace> <path> <text>`, `quilt workspace get <workspace> <path>`, `quilt workspace mkdir <workspace> <folder>`, `quilt workspace mv <workspace> <path> <new path>`, `quilt workspace rm <workspace> <path>`. The MCP tools do the same: `quilt_workspace_files`, `quilt_workspace_write_file` (fromPath for a file on disk), `quilt_workspace_read_file`, `quilt_workspace_make_folder`, `quilt_workspace_move_file`, `quilt_workspace_delete_file`.' : null,
    http ? `- ${both ? 'Over HTTP, the' : 'The'} same tools: \`quilt_workspace_files\`, \`quilt_workspace_write_file\` (text or base64, up to 2 MB, with a note), \`quilt_workspace_read_file\` (text inline, anything else as a download link), \`quilt_workspace_make_folder\`, \`quilt_workspace_move_file\`, \`quilt_workspace_delete_file\`.` : null,
    '',
    '### Commits and merges',
    '- Quilt syncs files; it never commits, merges git history or pushes, and neither should you unless a person asks. People commit with git on their own machine.',
    cli ? `- ${both ? 'With the CLI: c' : 'C'}ommits made outside the session (a push from a worktree, a PR merged on GitHub) come in by themselves: about once a minute Quilt fetches your folder's upstream and moves the branch forward, merging the session's uncommitted work into those files. For that, join from a git clone of the repository (\`git clone <url>\` first, then \`quilt join\` in it), with fetch credentials that work without a prompt (a credential helper, an SSH key, or a token in the remote's URL): a folder that is not a clone, or whose fetch fails, can't bring commits in, and \`quilt_status\` and \`quilt_branches\` say so; the relay then brings them in from GitHub for that branch, about every 10 minutes. It only moves forward: a diverged branch, or files that clash, become one task on the board for one AI ("Bring N commits from origin/main into the session"). If it is yours, git pull in your folder, resolve and git add; the others follow and the task closes itself. If it is someone else's, leave those files to them.` : null,
    http ? `- ${both ? 'Over HTTP: c' : 'C'}ommits made outside the session (a PR merged on GitHub, a push) come into your branch by themselves: through a member's folder on it when one is online and can fetch, otherwise the relay brings them in from GitHub about every 10 minutes. It only moves forward. When they clash with the session's uncommitted work, nothing comes in and one agent gets a task ("Bring N commits from origin/main into the session") with each file and what changed upstream in its comments. If it is yours: for each file, \`quilt_read_file\`, fold in the upstream change while keeping the session's work, and \`quilt_write_file\` it without conflict markers; each such write makes the relay look again at once. If you kept one side whole, move the task to QA when all files are done. The task closes itself once the commits are in. If it is someone else's, leave those files to them. A private repository needs a read-only GitHub token: when \`quilt_status\` says the relay can't read it, ask the session owner.` : null,
    `- \`quilt_sync_branch\` brings in new commits now, for example right after you push or a PR merges${cli ? (http ? ' (with the CLI it fetches in your folder, and asks the relay when your folder can\'t; over HTTP it asks the relay, at most once a minute per branch)' : ' (it fetches in your folder, and asks the relay when your folder can\'t)') : ' (the relay asks GitHub, at most once a minute per branch)'}. \`quilt_branches\` shows which branch each folder, AI session, hosted agent and worktree is on, and how each stands against its upstream (and when a folder can't fetch).`,
    http ? `- ${both ? 'Over HTTP, ' : ''}\`quilt_switch_branch\` moves you to another branch of the session; with create: true, a branch that is on GitHub but not yet in the session is loaded at its latest commit (any other new branch starts from a copy of your files).` : null,
    `- \`quilt_request_commit\` asks for a commit, \`quilt_commit_status\` says whether it is a good moment (whose AI is still working), ${cli ? `\`quilt_wait_until_idle\` waits for every other AI to finish${both ? ' (CLI only)' : ''}, ` : ''}and \`quilt_commit_request_done\` marks requests done after a commit.`,
    '- The session owner can give the relay a read-only GitHub token for a private repository with `quilt_github_token` (owner only).',
    cliOnly('- If `quilt_status` lists merges to settle (offline edits that could not be combined), read `quilt_merges` before editing those files and settle each with `quilt_resolve_merge`'),
    '',
    '### Your inbox, and webhooks',
    '- `quilt_inbox`: mentions of you, direct messages to you, files handed to you and tasks handed to you since you last looked. Act on each one.',
    cliOnly('- MCP clients can subscribe to the quilt://inbox resource to be told when something arrives'),
    `- To be woken instead of polling: ${call('quilt_webhook_subscribe', { url: 'https://your-receiver.example/quilt', secret: 'optional, 16 to 200 characters', events: ['chat.mention', 'chat.dm', 'task.assigned'], bearer: 'optional key your receiver wants' })}, once you are in a session. Quilt POSTs each event to that URL as it happens.`,
    '- Each POST is JSON: {"event","id","room","to","by","text","ts","task"?} (task: {id,title,column,assignee,files}). Headers: x-quilt-event, x-quilt-delivery, x-quilt-timestamp, x-quilt-signature = "sha256=" + hex HMAC-SHA256(secret, "<x-quilt-timestamp>.<raw body>"). Check the signature, answer 2xx quickly, then act (with quilt_inbox and the other tools). Failed POSTs are retried a few times; the event also stays in quilt_inbox.',
    `- The URL must be public https${cli ? ' (with the CLI, http://localhost also works)' : ''}. One webhook per agent: subscribing again replaces it. If you leave out the secret, Quilt makes one and shows it once. Stop with \`quilt_webhook_unsubscribe\`.`,
    '',
    '### Staying current',
    '- When a newer Quilt is out, your answers say so: tell the person you work for, so they update.',
    `- Keep your agent id (Quilt gave it to you when you joined${http ? `; GET ${apiUrl}/v1/agents/me shows it` : ''}${cli ? '; `quilt agent whoami` shows it' : ''}). It is public, not a secret. If you are sent a new agent invite, join with it (agentId${cli ? ', or `--agent-id` with the CLI' : ''}) to come back as yourself instead of as a new agent.`,
    cliOnly('- `quilt_check_update` checks your version; `quilt_leave_session` leaves (the files stay on disk). The session owner can make a link for a chat-only AI with `quilt_chat_link`'),
    http ? `- ${both ? 'Over HTTP, you' : 'You'} show as online for 30 minutes after each tool call. While idle, call \`quilt_inbox\` at least every 30 minutes.` : null,
    http ? `- Your access key lasts 1 hour. For a new pair, POST ${apiUrl}/v1/agents/token with {"refreshKey": "<refreshKey>"} (each refresh key works once: save each new pair straight away). If Quilt says your keys were revoked, POST ${apiUrl}/v1/agents/resume with {"resumeKey": "<resumeKey>"}. GET ${apiUrl}/v1/agents/me tells you who you are.` : null
  ].filter((l) => l !== null).join('\n')
}
