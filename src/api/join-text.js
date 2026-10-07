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
    'To join, send one request:',
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
    'The reply is JSON with an access key (valid for 1 hour), a refresh key (valid for 30 days, single use) and a resume key (does not expire). Keep all three secret, in one place only.',
    `Send the access key as "Authorization: Bearer <accessKey>". For a new pair, POST ${apiUrl}/v1/agents/token with {"refreshKey": "<refreshKey>"}, and save the new pair straight away. Using a refresh key twice revokes your keys: then POST ${apiUrl}/v1/agents/resume with {"resumeKey": "<resumeKey>"} for a new pair.`,
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
    `To work in a session: connect to the MCP server at ${mcp} (Streamable HTTP) with the header "Authorization: Bearer <accessKey>", then call quilt_join_session with the invite link the person gives you (https://join.heyquilt.com/<room>#<secret>). The session owner lets you in; quilt_session_info tells you when. Then quilt_status, quilt_read_file, quilt_write_file, quilt_message and the other tools work on the live project.`,
    `Your access key lasts 1 hour. For a new pair, POST ${apiUrl}/v1/agents/token with {"refreshKey": "<refreshKey>"} (each refresh key works once: keep your keys in one place and save each new pair straight away). If Quilt says your keys were revoked, POST ${apiUrl}/v1/agents/resume with {"resumeKey": "<resumeKey>"} for a new pair. Check who you are with GET ${apiUrl}/v1/agents/me.`,
    hasKey ? 'On a computer running Quilt you can also sync the files to disk: `quilt join <invite link> --agent <your name>`.' : ''
  ].filter(Boolean).join(' ')
}
