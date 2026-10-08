// Agents' keys. An access key (qa_, 1 hour) signs an agent in; a refresh key
// (qr_, 30 days, single use) swaps for a new pair. Pairs minted by refreshing
// share a family, and presenting a spent refresh key revokes the whole family:
// someone copied it, and we can't tell which holder is the real agent. Every
// agent also gets a resume key (qs_) when it joins, which never expires: it swaps
// for a pair in a new family once the refresh key stopped working, so a revoke
// never locks an agent out (only a person revoking the agent does).
// An app key (qk_) is for apps that can only hold one pasted key (Pipedream, Zapier,
// a script): it signs the agent in like an access key but never runs out. Its owner
// makes and revokes it on heyquilt.com.
import crypto from 'node:crypto'
import { newToken, hashToken } from './tokens.js'
import { HttpError } from './http.js'

export const ACCESS_TTL_MS = 60 * 60 * 1000
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000
// last_used_at is for people reading the dashboard; once a minute is plenty.
const TOUCH_EVERY_MS = 60 * 1000
export const REUSED = "This key was already used, so this agent's keys were revoked. Get new ones with your resume key: POST /v1/agents/resume with {\"resumeKey\": \"<resumeKey>\"}."
const REVOKED = "This agent's keys were revoked. Get new ones with your resume key: POST /v1/agents/resume with {\"resumeKey\": \"<resumeKey>\"}."

/** 'active' while some key can still refresh; 'reused' once a family was revoked; otherwise 'expired'. */
export function keyStatus (rows, at) {
  if (rows.some((k) => !k.revokedAt && k.refreshExpiresAt > at)) return 'active'
  return rows.some((k) => k.revokedAt) ? 'reused' : 'expired'
}

/** Whether a bearer key is an agent's: an access key or an app key. */
export const isAgentKey = (key) => key.startsWith('qa_') || key.startsWith('qk_')

export function makeAgentAuth ({ store, now, bearer }) {
  /** A fresh pair for an agent, in a new family unless one is given. The keys are shown once. */
  async function mintKeys (agentId, familyId = crypto.randomUUID()) {
    const accessKey = newToken('qa_'); const refreshKey = newToken('qr_')
    const at = now()
    const accessExpiresAt = at + ACCESS_TTL_MS; const refreshExpiresAt = at + REFRESH_TTL_MS
    await store.createAgentKeys({ agentId, familyId, accessHash: hashToken(accessKey), refreshHash: hashToken(refreshKey), accessExpiresAt, refreshExpiresAt })
    return { agentId, accessKey, accessExpiresAt, refreshKey, refreshExpiresAt }
  }

  /** Swaps a refresh key for a new pair in the same family, once. */
  async function refresh (refreshKey) {
    const key = typeof refreshKey === 'string' && refreshKey.startsWith('qr_') ? refreshKey : ''
    const row = key && await store.agentKeyByRefresh(hashToken(key))
    if (!row) throw new HttpError(401, "This key isn't valid. Invite the agent again.")
    if (row.revokedAt) throw new HttpError(401, REVOKED)
    if (row.refreshedAt) { await store.revokeFamily(row.familyId); throw new HttpError(401, REUSED) }
    if (row.refreshExpiresAt <= now()) throw new HttpError(401, 'This key has expired. Invite the agent again.')
    const agent = await store.agentById(row.agentId)
    if (!agent || agent.revokedAt) throw new HttpError(401, 'This agent was revoked.')
    // Two refreshes racing with one key: only one spends it, and the other is a reuse.
    if (!await store.claimRefresh(row.id)) { await store.revokeFamily(row.familyId); throw new HttpError(401, REUSED) }
    let pair
    try {
      pair = await mintKeys(agent.id, row.familyId)
    } catch (err) {
      // Minting failed after the claim went through: release it rather than
      // leave the key stuck "spent" with no pair to show for it.
      await store.releaseRefresh(row.id)
      throw err
    }
    // A reuse caught while this pair was being made (the family revoked
    // meanwhile) must not leave this new pair working.
    if ((await store.agentKeyByRefresh(hashToken(key)))?.revokedAt) { await store.revokeFamily(row.familyId); throw new HttpError(401, REUSED) }
    return pair
  }

  /** A new resume key for an agent that is joining: the key, and the hash to store. */
  function newResumeKey () {
    const resumeKey = newToken('qs_')
    return { resumeKey, resumeHash: hashToken(resumeKey) }
  }

  /**
   * New keys for an agent that proved who it is (its resume key, or a signature with the
   * key it joined with: routes/agents.js), after its refresh key stopped working: a reply
   * lost while offline, or a copy of the keys used in two places, leaves it holding a spent
   * key, which revokes its keys. Every key it had is revoked and it starts a new family.
   * Never for an agent a person revoked.
   */
  async function resume (agent) {
    if (agent.revokedAt) throw new HttpError(401, 'This agent was revoked. Invite it again.')
    const families = new Set((await store.listAgentKeys(agent.id)).filter((k) => !k.revokedAt).map((k) => k.familyId))
    for (const f of families) await store.revokeFamily(f)
    return mintKeys(agent.id)
  }

  /** resume() for the agent whose resume key this is. */
  async function resumeByKey (resumeKey) {
    const key = typeof resumeKey === 'string' && resumeKey.startsWith('qs_') ? resumeKey : ''
    const agent = key && await store.agentByResume(hashToken(key))
    if (!agent) throw new HttpError(401, "This resume key isn't valid. Invite the agent again.")
    return resume(agent)
  }

  /** A new app key (qk_) for an agent: shown once, only its hash is stored. */
  async function mintAppKey (agentId, name) {
    const key = newToken('qk_')
    const row = await store.createAgentAppKey({ agentId, name, keyHash: hashToken(key) })
    return { id: row.id, name: row.name, createdAt: row.createdAt, key }
  }

  /** The agent behind an app key, or a 401. App keys don't run out: they work until revoked. */
  async function agentFromAppKey (key) {
    const row = await store.agentAppKeyByHash(hashToken(key))
    if (!row) throw new HttpError(401, "this key isn't valid; make a new one on heyquilt.com (Agents)")
    if (row.revokedAt) throw new HttpError(401, 'this key was revoked; make a new one on heyquilt.com (Agents)')
    const agent = await store.agentById(row.agentId)
    if (!agent || agent.revokedAt) throw new HttpError(401, 'this agent was revoked')
    if (!row.lastUsedAt || now() - row.lastUsedAt >= TOUCH_EVERY_MS) await store.touchAgentAppKey(row.id)
    if (!agent.lastUsedAt || now() - agent.lastUsedAt >= TOUCH_EVERY_MS) await store.touchAgent(agent.id)
    return { agent, keyRow: null, appKey: row }
  }

  /** The agent behind a request's `qa_` (access) or `qk_` (app) bearer key, or a 401. */
  async function agentFromRequest (req) {
    const key = bearer(req)
    if (key.startsWith('qk_')) return agentFromAppKey(key)
    const keyRow = key.startsWith('qa_') ? await store.agentKeyByAccess(hashToken(key)) : null
    if (!keyRow) throw new HttpError(401, 'sign the agent in first')
    if (keyRow.revokedAt) throw new HttpError(401, "this agent's keys were revoked; get new ones with your resume key (POST /v1/agents/resume)")
    if (keyRow.accessExpiresAt <= now()) throw new HttpError(401, 'this access key has expired; refresh it')
    const agent = await store.agentById(keyRow.agentId)
    if (!agent || agent.revokedAt) throw new HttpError(401, 'this agent was revoked')
    if (!agent.lastUsedAt || now() - agent.lastUsedAt >= TOUCH_EVERY_MS) await store.touchAgent(agent.id)
    return { agent, keyRow }
  }

  return { mintKeys, newResumeKey, refresh, resume, resumeByKey, agentFromRequest, mintAppKey }
}
