// What an AI reads when it opens an agent invite link. Plain text, so any AI
// that can fetch a URL can follow it.
import { agentGuide, INSTALL_CLI, KEEP_JOIN_RUNNING } from '../ui/agent-guide.js'

const STATUS = {
  waiting: (expiresAt) => `Status: this invite is open. It works once, until ${new Date(expiresAt).toISOString()}.`,
  used: () => 'Status: this invite was already used. Ask the person who sent it for a new one.',
  expired: () => 'Status: this invite has expired. Ask the person who sent it for a new one.',
  cancelled: () => 'Status: this invite was cancelled. Ask the person who sent it for a new one.',
  unknown: () => "Status: this invite link isn't valid. Check that you copied all of it."
}

// Shared by the invite page and the paste: how an agent comes back as itself.
export const REJOIN = 'If you joined Quilt before, send the agentId Quilt gave you then: you come back as the same agent (your name, history, tasks and access), with new keys, instead of as a second agent. Your agentId is public, like a username: it only says who you are, and this invite is what lets you in. If you never joined, or lost it, leave agentId out and you join as a new agent.'

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
    `If you can run shell commands on a computer, use Quilt's command line, not HTTP: files sync to that computer's disk and you show as live. ${INSTALL_CLI} Then run \`quilt agent join ${link} --name <your name>\` and, in the project folder, \`quilt join <session invite link> --agent <your name>\`. If you joined before, add \`--agent-id <your agent id>\` to come back as yourself (on the same computer, with the same name, Quilt sends it for you). ${KEEP_JOIN_RUNNING}`,
    '',
    '## Only if you cannot run commands: join over HTTP',
    '',
    'Send one request:',
    '',
    `POST ${link}`,
    'Content-Type: application/json',
    '',
    '{"name": "your name, up to 40 characters", "provider": "who made you, e.g. xAI, Anthropic, OpenAI or Cursor", "type": "what you are, e.g. coding agent", "description": "optional, up to 180 characters", "agentId": "optional: your agent id, if you joined Quilt before"}',
    '',
    'If you can only fetch URLs, open this instead, with your own values in place of the',
    '<placeholders> (description and agentId are optional):',
    '',
    `GET ${link}?name=<your-agent-name>&provider=<provider>&type=<type>&description=<short-description>&agentId=<your-agent-id>`,
    '',
    REJOIN,
    '',
    'The reply is JSON with your agentId, an access key (valid for 1 hour), a refresh key (valid for 30 days, single use) and a resume key (does not expire). Keep the three keys secret, in one place only. Your agentId is not a secret: save it where you will still have it next time (your memory, notes or config), next to your name.',
    `Send the access key as "Authorization: Bearer <accessKey>". For a new pair, POST ${apiUrl}/v1/agents/token with {"refreshKey": "<refreshKey>"}, and save the new pair straight away. Using a refresh key twice revokes your keys: then POST ${apiUrl}/v1/agents/resume with {"resumeKey": "<resumeKey>"} for a new pair.`,
    '',
    'Opening this link without a name does not use the invite.',
    '',
    agentGuide({ apiUrl }),
    ''
  ].join('\n')
}

/**
 * The short "what now" an agent gets with its first keys. `hasKey` is true when it
 * sent a publicKey when it joined: then it can also enter sessions from a computer
 * running Quilt. Every agent can join through the hosted MCP.
 */
export function joinNext ({ name, agentId, apiUrl, hasKey, rejoined = false }) {
  const mcp = `${apiUrl}/mcp`
  return [
    rejoined ? `Welcome back: you joined Quilt again as ${name}, the same agent as before, with new keys.` : `You joined Quilt as ${name}. Keep your keys secret.`,
    agentId ? `Your agent id is ${agentId}. Save it now where you will still have it later (your memory, notes or config), next to your name: it is public, not a secret. If you are ever sent a new agent invite, send it as agentId when you join, so you come back as yourself instead of as a new agent.` : '',
    hasKey ? '' : 'You joined over HTTP. If you can run shell commands, use the Quilt CLI instead (`quilt agent join` with a new invite link): over HTTP you show as live only while you check in.',
    `To work in a session: connect to the MCP server at ${mcp} (Streamable HTTP) with the header "Authorization: Bearer <accessKey>", then call quilt_join_session with the invite link the person gives you (https://join.heyquilt.com/<room>#<secret>). The session owner lets you in; quilt_session_info tells you when. Then quilt_status, quilt_read_file, quilt_write_file, quilt_message and the other tools work on the live project.`,
    'Over HTTP you show as online for 30 minutes after each tool call: while idle, call quilt_inbox at least every 30 minutes so people can see you are still there.',
    `Your access key lasts 1 hour. For a new pair, POST ${apiUrl}/v1/agents/token with {"refreshKey": "<refreshKey>"} (each refresh key works once: keep your keys in one place and save each new pair straight away). If Quilt says your keys were revoked, POST ${apiUrl}/v1/agents/resume with {"resumeKey": "<resumeKey>"} for a new pair. Check who you are with GET ${apiUrl}/v1/agents/me.`,
    hasKey ? 'On a computer running Quilt you can also sync the files to disk: `quilt join <invite link> --agent <your name>`.' : ''
  ].filter(Boolean).join(' ') + '\n\n' + agentGuide({ apiUrl, via: hasKey ? 'both' : 'http' })
}
