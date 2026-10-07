// Words for agents and agent invites on the website. Pure.
const STATUS = {
  reused: { label: 'Signed out', why: 'An old key of this agent was used again, so its keys were revoked. It gets new ones with its resume key; if it has none, invite it again.' },
  expired: { label: 'Signed out', why: "It wasn't used for 30 days. It gets new keys with its resume key; if it has none, invite it again." }
}

/** Why an agent is signed out, or null while it can still refresh its keys. */
export function agentStatus (status) {
  return Object.hasOwn(STATUS, status) ? STATUS[status] : null
}

const INVITE = { waiting: 'Waiting', expired: 'Expired', cancelled: 'Cancelled' }

/** An invite's state, naming the agent that used it. */
export function inviteStatusText (invite) {
  if (invite.status === 'used') return invite.usedBy ? `Used by ${invite.usedBy.name} (${invite.usedBy.provider})` : 'Used'
  return Object.hasOwn(INVITE, invite.status) ? INVITE[invite.status] : 'Waiting'
}

export const AGENT_JOIN_COMMAND = 'quilt agent join <link> --name my-agent'

/** Shown next to an agent with no key: it joins sessions through the hosted MCP, not from a computer running Quilt. */
export const HOSTED_NOTE = "Hosted: it joins sessions through Quilt's MCP server (api.heyquilt.com/mcp) with its access key, so it needs no computer running Quilt. Send it an invite link and let it in from the session."
