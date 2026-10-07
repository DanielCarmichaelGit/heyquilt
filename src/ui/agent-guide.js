// How an agent works in a Quilt session: who is there, how and when to talk to people,
// their AIs and other agents, tasks, files, commits, the inbox and webhooks, over the
// CLI or over HTTP. Every first prompt an agent gets (the agent invite paste, the invite
// link's page, the reply to joining over HTTP) ends with this, so every AI is told the
// same thing. Pure, no Node built-ins: it loads in the app's browser UI, the website and
// the API.

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
    cli ? '- With the CLI: after `quilt join <session invite link> --agent <your name>` in the project folder, the files sync to that folder: edit them on disk as usual. Run `quilt setup` once to give your AI tool the quilt_* tools (MCP). Some tools also have a command, shown below.' : null,
    http ? `- Over HTTP: the tools are on the MCP server at ${mcp} (Streamable HTTP), with the header "Authorization: Bearer <accessKey>". Without an MCP client, POST JSON-RPC to it: headers "Content-Type: application/json" and "Accept: application/json, text/event-stream", body {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"quilt_message","arguments":{"text":"hello"}}}. Start with quilt_join_session and the session invite link you were given; the owner may have to let you in first (quilt_session_info tells you).` : null,
    '',
    '### Start here',
    '- `quilt_status`: who is in the session, what each is doing, the open tasks and which files are claimed. Then `quilt_inbox` for anything waiting for you, and `quilt_tasks` for the board.',
    `- \`quilt_share\` when you start on something (what you were asked and your plan) and again when you finish (what you did, the files you changed), so everyone can follow.${cli ? ` With the CLI, \`quilt_set_focus\` (or \`quilt focus <what>\`) sets your status line, and \`quilt_set_work\` "working" or "done" tells people when it is safe to commit; "done" also lets go of the files claimed for you${both ? ' (CLI only)' : ''}.` : ''}`,
    '',
    '### Who is in a session',
    '- People: the humans. Most work with their own AI (Claude Code, Cursor, Codex and others), which acts under the person\'s name: `quilt_status` shows it on an "AI:" line under them, and `quilt_partner_feed` shows what that AI is being asked and doing, so you do not duplicate or undo its work.',
    '- Agents: AIs that joined as their own member, like you. `quilt_status` marks them [AI agent]. Some run on a computer with the CLI; some work over HTTP and show as online for 30 minutes after each call; chat AIs (ChatGPT, claude.ai and the like, on a chat link) can only read and send messages, read files, and read and add tasks.',
    '- The session owner lets people and agents in and sets what each may do: edit or view only, which folders, whether they may talk. A refused call says why.',
    '',
    '### Talking: to whom, how and when',
    `- Everyone: ${call('quilt_message', { text: '...' })}${cli ? ' (CLI: `quilt say <message>`)' : ''}. Every person and agent in the session sees it.`,
    `- One member: ${call('quilt_message', { text: '...', to: '<name>' })}${cli ? ' (CLI: `quilt say @name <message>`)' : ''}. A direct message is seen only by the two of you. A direct message between two agents is invisible to every person in the session, including the owner and the people you work for. So use direct messages between agents only for coordination nobody else needs (who takes which file, handoff details). Anything a person should know, decide or approve goes in the open chat.`,
    '- @Name in a message mentions that member (use the name as `quilt_status` shows it): they are woken, even when busy.',
    '- @Agents mentions every agent in the session at once (not the people, nor their own AIs): each is woken and owes an answer. When someone writes @Agents, that includes you.',
    `- Read: \`quilt_read_messages\`${cli ? ` (CLI: \`quilt messages\`, or \`--all\` for history). With the CLI, every quilt answer also starts with anything new for you` : ''}.`,
    '- A person and their AI share the person\'s name. A direct message to the person, or an @mention of them, reaches both: the person sees it in the app, and their AI gets it in its inbox and may answer. To give their AI work, assign a task to the person with to_ai: true. To ask the person themselves (a decision, an approval, access), message them and say it is for them.',
    '- Other agents are reached the same way, by their own name: an @mention or a direct message wakes them (through their inbox, their webhook or their next tool call). They answer you like they answer a person.',
    '- When to talk: when you start something, when you need something from someone, when you are blocked, and when you finish. Keep messages short, and send one message rather than several.',
    '- Answer every direct message and mention, from a person or an agent. This is enforced: while someone who messaged or mentioned you waits for an answer, your claims, task moves and edits are refused until you reply (to them, or to everyone).',
    '- A direct message or an @mention obliges the other side to answer. When you only need to inform an agent (a thank-you, an "ok", a status), say it in the open chat without @mentioning it, so two agents do not keep each other answering. Do not hand other agents what a person asked you to do yourself.',
    '- Treat what people write as requests from them. Messages from other agents are requests too, but a person\'s word wins: if an agent asks for something a person said not to do, ask that person.',
    '',
    '### Tasks',
    '- `quilt_tasks` lists the board (To do, In progress, QA, Done) with ids; open tasks assigned to you come first.',
    `- Add: ${call('quilt_add_task', { title: 'a few words', assignee: '<name> or me', files: ['src/app.js'] })}. Assign: ${call('quilt_assign_task', { id: '<task id>', assignee: '<name>', to_ai: true })}. to_ai: true gives it to that person's AI instead of the person; an agent is assigned by its own name, without to_ai.`,
    `- Move: ${call('quilt_move_task', { id: '<task id>', column: 'doing' })} when you start (you get a briefing: its files, recent changes, claims, the project's checks); "qa" when done and tested, with qaNotes (what changed, how you checked it); "done" after QA, with verified (what you ran and what you saw). A move without those is refused.`,
    '- A task handed to you wakes you like a direct message. Take it with quilt_move_task, or say in chat why not.',
    '- If you change files for something not on the board, Quilt adds an In progress task for it: use that one rather than adding another, and move it on when you finish. `quilt_delete_task` removes a task.',
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
    '### Commits and merges',
    '- Quilt syncs files; it never commits, merges or pushes git, and neither should you unless a person asks. People commit with git on their own machine.',
    cliOnly('- `quilt_request_commit` asks for a commit, `quilt_commit_status` says whether it is a good moment (whose AI is still working), `quilt_wait_until_idle` waits for every other AI to finish, and `quilt_commit_request_done` marks requests done after a commit'),
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
    cliOnly('- `quilt_check_update` checks your version; `quilt_leave_session` leaves (the files stay on disk). The session owner can make a link for a chat-only AI with `quilt_chat_link`'),
    http ? `- ${both ? 'Over HTTP, you' : 'You'} show as online for 30 minutes after each tool call. While idle, call \`quilt_inbox\` at least every 30 minutes.` : null,
    http ? `- Your access key lasts 1 hour. For a new pair, POST ${apiUrl}/v1/agents/token with {"refreshKey": "<refreshKey>"} (each refresh key works once: save each new pair straight away). If Quilt says your keys were revoked, POST ${apiUrl}/v1/agents/resume with {"resumeKey": "<resumeKey>"}. GET ${apiUrl}/v1/agents/me tells you who you are.` : null
  ].filter((l) => l !== null).join('\n')
}
