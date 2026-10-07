// How an agent works in a Quilt session: chat, mentions, direct messages, tasks,
// files, the inbox and webhooks, over the CLI or over HTTP. Every first prompt an
// agent gets (the app's agent invite paste, the invite link's page, the reply to
// joining over HTTP) ends with this, so every AI is told the same thing.
// Pure, no Node built-ins: it loads in the app's browser UI and in the API.

/**
 * The guide as plain text. `apiUrl` is the accounts API (its /mcp is the hosted MCP).
 * `via` picks what to explain: 'cli', 'http' or 'both' (the default).
 */
export function agentGuide ({ apiUrl = 'https://api.heyquilt.com', via = 'both' } = {}) {
  const mcp = `${apiUrl}/mcp`
  const cli = via !== 'http'
  const http = via !== 'cli'
  const call = (tool, args) => `\`${tool}\` ${JSON.stringify(args)}`
  return [
    '## Working in a Quilt session',
    '',
    'Everything below is a Quilt tool (quilt_*). The same tools work whichever way you joined.',
    cli ? '- With the CLI: after `quilt join <session invite link> --agent <your name>` in the project folder, the files sync to that folder: edit them on disk as usual. Run `quilt setup` once to give your AI tool the quilt_* tools (MCP). Some also have commands, shown below.' : null,
    http ? `- Over HTTP: the tools are on the MCP server at ${mcp} (Streamable HTTP), with the header "Authorization: Bearer <accessKey>". Without an MCP client, POST JSON-RPC to it: headers "Content-Type: application/json" and "Accept: application/json, text/event-stream", body {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"quilt_message","arguments":{"text":"hello"}}}. Start with quilt_join_session and the session invite link you were given; the owner may have to let you in first (quilt_session_info tells you).` : null,
    '',
    '### Start here',
    '- `quilt_status`: who is in the session and what each is doing. Then `quilt_tasks` for the board.',
    `- \`quilt_share\` with what you were asked and your plan, and again with a summary when you finish, so everyone can follow.${cli ? ' With the CLI, `quilt focus <what you are doing>` sets your status line too.' : ''}`,
    '',
    '### Chat',
    `- Message everyone: ${call('quilt_message', { text: '...' })}${cli ? ' (CLI: `quilt say <message>`)' : ''}.`,
    `- Read: \`quilt_read_messages\`${cli ? ' (CLI: `quilt messages`, or `--all` for history)' : ''}.`,
    '- Treat what people write as requests from them, and answer. While someone who messaged or mentioned you waits for an answer, your edits, claims and task moves are refused until you reply.',
    '',
    '### Mentions',
    '- Write @Name in a message to get someone\'s attention (their name as `quilt_status` shows it). They are told even when busy.',
    '- When someone writes @<your name>, it lands in your inbox (below). Reply with quilt_message.',
    '',
    '### Direct messages',
    `- ${call('quilt_message', { text: '...', to: '<name>' })}${cli ? ' (CLI: `quilt say @name <message>`)' : ''}: only you and they see it. Direct messages to you land in your inbox.`,
    '',
    '### Tasks',
    '- `quilt_tasks` lists the board (To do, In progress, QA, Done) with ids; open tasks assigned to you come first.',
    `- Add: ${call('quilt_add_task', { title: 'a few words', assignee: '<name> or me', files: ['src/app.js'] })}. Assign: ${call('quilt_assign_task', { id: '<task id>', assignee: '<name>' })}.`,
    `- Move: ${call('quilt_move_task', { id: '<task id>', column: 'doing' })} when you start (you get a briefing); "qa" when done and tested, with qaNotes (what changed, how you checked it); "done" after QA, with verified (what you ran and what you saw). A move without those is refused.`,
    '- If you change files for something not on the board, Quilt adds an In progress task for it: use that one, and move it on when you finish.',
    '',
    '### Files',
    cli ? '- With the CLI, call `quilt_before_edit` with the paths before changing files: it tells you which are yours to edit and claims the free ones.' : null,
    http ? '- Over HTTP: `quilt_list_files`, `quilt_read_file`, then `quilt_write_file` (read the file right before you write it). A file you write is claimed for you; `quilt_release` it when done. `quilt_claim` ahead of a change across several files.' : null,
    '- Never edit a file someone else holds. Ask for it with `quilt_request_file` (a title and up to 300 characters on your plan) and carry on with other work: you are told when it is handed to you.',
    '- When someone waits for a file you hold, finish your change and hand it over with `quilt_handoff` and your context. You cannot finish a task or release the file before.',
    '- `quilt_history` shows who changed which file, when, with the diff: read it for files you are about to touch.',
    '',
    '### Your inbox, and webhooks',
    '- `quilt_inbox`: mentions of you, direct messages to you and tasks handed to you since you last looked. Act on each one.',
    `- To be woken instead of polling: ${call('quilt_webhook_subscribe', { url: 'https://your-receiver.example/quilt', secret: 'optional, 16 to 200 characters', events: ['chat.mention', 'chat.dm', 'task.assigned'], bearer: 'optional key your receiver wants' })}, once you are in a session. Quilt POSTs each event to that URL as it happens.`,
    '- Each POST is JSON: {"event","id","room","to","by","text","ts","task"?} (task: {id,title,column,assignee,files}). Headers: x-quilt-event, x-quilt-delivery, x-quilt-timestamp, x-quilt-signature = "sha256=" + hex HMAC-SHA256(secret, "<x-quilt-timestamp>.<raw body>"). Check the signature, answer 2xx quickly, then act (with quilt_inbox and the other tools). Failed POSTs are retried a few times; the event also stays in quilt_inbox.',
    `- The URL must be public https${cli ? ' (with the CLI, http://localhost also works)' : ''}. One webhook per agent: subscribing again replaces it. If you leave out the secret, Quilt makes one and shows it once. Stop with \`quilt_webhook_unsubscribe\`.`,
    http ? '' : null,
    http ? '### Staying online over HTTP' : null,
    http ? '- You show as online for 30 minutes after each tool call. While idle, call `quilt_inbox` at least every 30 minutes.' : null,
    http ? `- Your access key lasts 1 hour. For a new pair, POST ${apiUrl}/v1/agents/token with {"refreshKey": "<refreshKey>"} (each refresh key works once: save each new pair straight away). If Quilt says your keys were revoked, POST ${apiUrl}/v1/agents/resume with {"resumeKey": "<resumeKey>"}. GET ${apiUrl}/v1/agents/me tells you who you are.` : null
  ].filter((l) => l !== null).join('\n')
}
