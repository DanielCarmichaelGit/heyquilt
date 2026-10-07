// What an AI reads when it opens an agent invite link. Plain text, so any AI
// that can fetch a URL can follow it.
const STATUS = {
  waiting: (expiresAt) => `Status: this invite is open. It works once, until ${new Date(expiresAt).toISOString()}.`,
  used: () => 'Status: this invite was already used. Ask the person who sent it for a new one.',
  expired: () => 'Status: this invite has expired. Ask the person who sent it for a new one.',
  cancelled: () => 'Status: this invite was cancelled. Ask the person who sent it for a new one.',
  unknown: () => "Status: this invite link isn't valid. Check that you copied all of it."
}

export function joinInstructions ({ link, apiUrl, status, expiresAt }) {
  return [
    '# Join Quilt as an agent',
    '',
    STATUS[status](expiresAt),
    '',
    'Quilt lets people and AI agents work in the same project folder in real time. A person invited you to join as their agent.',
    '',
    '## If you can run commands: use the Quilt CLI',
    '',
    `If you can run shell commands on a computer, use Quilt's command line, not HTTP: files sync to that computer's disk and you show as live. Install it (Linux: \`curl -fsSL https://github.com/DanielCarmichaelGit/heyquilt/releases/latest/download/install.sh | sh\`; Mac or Windows with Node.js: \`npm i -g github:DanielCarmichaelGit/heyquilt\`), then run \`quilt agent join ${link} --name <your name>\` and, in the project folder, \`quilt join <session invite link> --agent <your name>\`.`,
    '',
    '## Only if you cannot run commands: join over HTTP',
    '',
    'Send one request:',
    '',
    `POST ${link}`,
    'Content-Type: application/json',
    '',
    '{"name": "your name, up to 40 characters", "provider": "who made you, e.g. Anthropic, OpenAI or Cursor", "type": "what you are, e.g. coding agent", "description": "optional, up to 180 characters"}',
    '',
    'If you can only fetch URLs, open this instead, with your own values in place of the',
    '<placeholders> (description is optional):',
    '',
    `GET ${link}?name=<your-agent-name>&provider=<provider>&type=<type>&description=<short-description>`,
    '',
    'The reply is JSON with an access key (valid for 1 hour) and a refresh key (valid for 30 days, single use). Keep both secret.',
    `Send the access key as "Authorization: Bearer <accessKey>". For a new pair, POST ${apiUrl}/v1/agents/token with {"refreshKey": "<refreshKey>"}. Using a refresh key twice revokes your keys.`,
    '',
    'Opening this link without a name does not use the invite.',
    ''
  ].join('\n')
}

/**
 * The short "what now" an agent gets with its first keys. `hasKey` is true when it
 * sent a publicKey when it joined: then it can also enter sessions from a computer
 * running Quilt. Every agent can join through the hosted MCP.
 */
export function joinNext ({ name, apiUrl, hasKey }) {
  const mcp = `${apiUrl}/mcp`
  return [
    `You joined Quilt as ${name}. Keep your keys secret.`,
    hasKey ? '' : 'You joined over HTTP. If you can run shell commands, use the Quilt CLI instead (`quilt agent join` with a new invite link): over HTTP you show as live only while you check in.',
    `To work in a session: connect to the MCP server at ${mcp} (Streamable HTTP) with the header "Authorization: Bearer <accessKey>", then call quilt_join_session with the invite link the person gives you (https://join.heyquilt.com/<room>#<secret>). The session owner lets you in; quilt_session_info tells you when. Then quilt_status, quilt_read_file, quilt_write_file, quilt_message and the other tools work on the live project.`,
    'Over HTTP you show as online for 30 minutes after each tool call: while idle, call quilt_inbox at least every 30 minutes so people can see you are still there.',
    `Your access key lasts 1 hour. For a new pair, POST ${apiUrl}/v1/agents/token with {"refreshKey": "<refreshKey>"} (each refresh key works once). Check who you are with GET ${apiUrl}/v1/agents/me.`,
    hasKey ? 'On a computer running Quilt you can also sync the files to disk: `quilt join <invite link> --agent <your name>`.' : ''
  ].filter(Boolean).join(' ')
}
