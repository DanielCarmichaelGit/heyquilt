// The accounts API's data, in memory. Used by tests and `quilt api --memory`;
// production uses supabase-store.js, which has the same methods.
import crypto from 'node:crypto'
import { FALLBACK_TYPE } from '../session-access.js'

const uuid = () => crypto.randomUUID()
const copy = (o) => (o ? structuredClone(o) : null)
// Postgres's unique-violation code, which the API turns into a 409.
const duplicate = (what) => Object.assign(new Error(`${what} already exists`), { code: '23505' })
// The one unique-violation the API gives its own message: it checks the constraint
// name, the message and the details for 'public_key', the way a real Postgres error
// (constraint "agents_public_key_key", detail "Key (public_key)=(...) already exists.") would read.
const duplicatePublicKey = () => Object.assign(new Error('duplicate key value violates unique constraint "agents_public_key_key"'), {
  code: '23505', constraint: 'agents_public_key_key', details: 'Key (public_key)=(...) already exists.'
})
// Postgres's foreign-key-violation code, mirrored for the checks the schema
// enforces with NO ACTION (a delete blocked by a live reference) and for
// composite-FK checks at insert time (a row that doesn't point at a valid
// parent) — `verb` lets each call site read correctly for which case it is.
const fkViolation = (what, verb = 'is still referenced') => Object.assign(new Error(`${what} ${verb}`), { code: '23503' })
// Postgres's check-violation code, mirrored for the checks the schema makes.
const checkViolation = (what) => Object.assign(new Error(what), { code: '23514' })
const tooManyFolders = (scopes) => { if (scopes.length > 20) throw checkViolation('at most 20 folders') }

export function createMemoryStore ({ now = Date.now } = {}) {
  const links = new Map(); const devices = new Map(); const profiles = new Map(); const agents = new Map(); const resumeHashes = new Map() // resume key hash -> agent id
  const users = new Map(); const orgs = new Map(); const roles = new Map(); const members = new Map()
  const teams = new Map(); const teamMembers = new Map(); const invites = new Map(); const requests = new Map()
  const agentInvites = new Map(); const keyRows = new Map(); const appKeys = new Map()
  const events = new Map(); const issues = new Map()
  const relaySessions = new Map(); const visits = new Map(); const seenEvents = new Map(); const actions = new Map()
  const accessTypes = new Map(); const grants = new Map(); const sessionInvites = new Map()
  const workspaces = new Map(); const workspaceMembers = new Map()
  const workspaceFiles = new Map(); const workspaceFileVersions = new Map()
  const agentPlacements = new Map(); const workspaceAgentOverrides = new Map()
  const sessionAgentExclusions = new Map(); const agentWebhooks = new Map()
  const wmKey = (workspaceId, account) => `${workspaceId}\n${account}`
  const grantKey = (room, account) => `${room}\n${account}`
  const waoKey = (workspaceId, agentId) => `${workspaceId}\n${agentId}`
  const saeKey = (room, agentId) => `${room}\n${agentId}`
  const inviteOpenAt = (i, at) => !i.usedAt && !i.cancelledAt && i.expiresAt > at
  const all = (m, keep) => [...m.values()].filter(keep)
  const nameOf = (userId) => profiles.get(userId)?.name || ''
  const findMember = (orgId, userId) => all(members, (m) => m.orgId === orgId && m.userId === userId)[0]
  // Mirrors the composite (role_id, org_id) foreign key: a role from another org can't be attached here.
  const roleInOrg = (roleId, orgId) => roleId == null || roles.get(roleId)?.orgId === orgId
  // An invite still holds its role open only while it's neither accepted nor
  // cancelled nor expired; deleteRole and roleInUse agree on this one definition.
  const inviteOpen = (i) => !i.acceptedAt && !i.cancelledAt && i.expiresAt > now()
  // Leaving an org also leaves its teams, like the cascade in Postgres.
  const dropMember = (id) => {
    members.delete(id)
    for (const [k, tm] of teamMembers) if (tm.memberId === id) teamMembers.delete(k)
  }
  // Hard-deletes a workspace file and cascades its versions, like the FK in Postgres.
  const removeFile = (id) => {
    workspaceFiles.delete(id)
    for (const k of [...workspaceFileVersions.keys()]) if (k.startsWith(`${id}\n`)) workspaceFileVersions.delete(k)
  }
  // An org member is a person (named by their profile) or an agent (named when it joined).
  const memberName = (m) => (m?.agentId ? agents.get(m.agentId)?.name || '' : nameOf(m?.userId))
  // Deleting an agent takes its keys and membership with it, like the cascades in
  // Postgres; an invite it used only forgets it (on delete set null). Its workspace
  // placement, any workspace's say over it, session keep-outs and its webhook go too.
  const dropAgent = (id) => {
    agents.delete(id)
    for (const [h, a] of resumeHashes) if (a === id) resumeHashes.delete(h)
    for (const [k, key] of keyRows) if (key.agentId === id) keyRows.delete(k)
    for (const [k, key] of appKeys) if (key.agentId === id) appKeys.delete(k)
    for (const [k, m] of members) if (m.agentId === id) dropMember(k)
    for (const i of agentInvites.values()) if (i.usedByAgentId === id) i.usedByAgentId = null
    agentPlacements.delete(id)
    for (const [k, o] of workspaceAgentOverrides) if (o.agentId === id) workspaceAgentOverrides.delete(k)
    for (const [k, e] of sessionAgentExclusions) if (e.agentId === id) sessionAgentExclusions.delete(k)
    agentWebhooks.delete(id)
  }

  // Deleting an account takes the sessions it owns (with everyone's visits in them) and its
  // own visits, like delete_account_activity.
  const dropActivity = (accounts) => {
    for (const [room, s] of relaySessions) if (accounts.includes(s.ownerAccount)) relaySessions.delete(room)
    for (const [id, v] of visits) if (accounts.includes(v.account) || !relaySessions.has(v.room)) visits.delete(id)
    dropOrphans()
  }
  // Grants, invites and agent keep-outs go with their session (on delete cascade).
  const dropOrphans = () => {
    // What visits did goes with them (on delete cascade).
    const live = new Set(all(visits, () => true).map((v) => v.eventStartId))
    for (const [id, a] of actions) if (!live.has(a.visitStartId)) actions.delete(id)
    for (const [k, g] of grants) if (!relaySessions.has(g.room)) grants.delete(k)
    for (const [id, i] of sessionInvites) if (!relaySessions.has(i.room)) sessionInvites.delete(id)
    for (const [k, e] of sessionAgentExclusions) if (!relaySessions.has(e.room)) sessionAgentExclusions.delete(k)
  }
  // Mirrors delete_account_access.
  const dropAccess = (accounts) => {
    for (const [id, t] of accessTypes) if (accounts.includes(t.ownerAccount)) accessTypes.delete(id)
    for (const [k, g] of grants) if (accounts.includes(g.account)) grants.delete(k)
    for (const [id, i] of sessionInvites) if (accounts.includes(i.account)) sessionInvites.delete(id)
  }

  return {
    addUser (userId, { name = '', email = '', confirmed = true, kind = 'personal' } = {}) {
      profiles.set(userId, { id: userId, name: name || email.split('@')[0] || 'You', color: null, tool: null, kind })
      users.set(userId, { email, confirmed })
    },
    async createLink (l) {
      const row = { id: uuid(), status: 'pending', userId: null, deviceId: null, createdAt: now(), ...l }
      links.set(row.id, row); return { ...row }
    },
    async linkByDeviceCode (h) { const l = [...links.values()].find((x) => x.deviceCodeHash === h); return l ? { ...l } : null },
    async linkByUserCode (c) { const l = [...links.values()].find((x) => x.userCode === c); return l ? { ...l } : null },
    async updateLink (id, patch) { const l = links.get(id); Object.assign(l, patch); return { ...l } },
    // Check-and-set: only flips status if it's still fromStatus, so two concurrent
    // callers can't both win the same link (e.g. handing out a device token twice).
    async claimLink (id, fromStatus, toStatus) {
      const l = links.get(id)
      if (!l || l.status !== fromStatus) return false
      l.status = toStatus
      return true
    },
    // One row per (account, key): someone else approving a link for this key gets
    // their own row, never this one. A relink retires the old token.
    async upsertDevice ({ userId, name, platform, publicKey }) {
      let d = [...devices.values()].find((x) => x.userId === userId && x.publicKey === publicKey)
      if (d) Object.assign(d, { name, platform, tokenHash: null, revokedAt: null })
      else devices.set((d = { id: uuid(), userId, name, platform, publicKey, tokenHash: null, createdAt: now(), lastSeenAt: now(), revokedAt: null }).id, d)
      return { ...d }
    },
    async setDeviceToken (id, tokenHash) { devices.get(id).tokenHash = tokenHash },
    async deviceByToken (h) { const d = [...devices.values()].find((x) => x.tokenHash === h && !x.revokedAt); return d ? { ...d } : null },
    async touchDevice (id) { devices.get(id).lastSeenAt = now() },
    // The linked (not unlinked) computer holding this key: the most recently seen, if more than one account linked it.
    async deviceByPublicKey (publicKey) {
      const d = [...devices.values()].filter((x) => x.publicKey === publicKey && !x.revokedAt).sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0]
      return d ? { ...d } : null
    },
    // Whether this account has linked this key before (unlinked since or not).
    async userHasDevice (userId, publicKey) { return [...devices.values()].some((x) => x.userId === userId && x.publicKey === publicKey) },
    async revokeDevice (id) { Object.assign(devices.get(id), { revokedAt: now(), tokenHash: null }) },
    async profile (userId) { const p = profiles.get(userId); return p ? { ...p } : null },
    // 'personal' or 'org': set once at sign-up, and the only thing POST /v1/orgs checks.
    async profileKind (userId) { return profiles.get(userId)?.kind || null },
    async updateProfile (userId, patch) {
      const p = profiles.get(userId)
      for (const k of ['name', 'color', 'tool']) if (patch[k] !== undefined) p[k] = patch[k]
      return { ...p }
    },
    // Agents hold their own keys; at most a public key is kept here. Mirrors
    // agents_one_home (a person's or an org's, never both) and the unique public_key.
    async createAgent ({ name, provider, type, description = '', publicKey = null, resumeHash = null, ownerUserId = null, orgId = null, invitedBy = null }) {
      if ((ownerUserId == null) === (orgId == null)) throw Object.assign(new Error('an agent belongs to one person or one org'), { code: '23514' })
      if (publicKey && all(agents, (a) => a.publicKey === publicKey).length) throw duplicatePublicKey()
      const row = { id: uuid(), name, provider, type, description, publicKey, ownerUserId, orgId, invitedBy, createdAt: now(), lastUsedAt: null, revokedAt: null }
      agents.set(row.id, row)
      // Kept apart from the row, like the database never selecting it with the agent.
      if (resumeHash) resumeHashes.set(resumeHash, row.id)
      return copy(row)
    },
    async agentById (id) { return copy(agents.get(id)) },
    async agentByResume (hash) { return copy(agents.get(resumeHashes.get(hash))) },
    async agentByPublicKey (publicKey) { return publicKey ? copy(all(agents, (a) => a.publicKey === publicKey)[0]) : null },
    async listPersonalAgents (userId) {
      return all(agents, (a) => a.ownerUserId === userId && !a.revokedAt).sort((a, b) => a.createdAt - b.createdAt).map(copy)
    },
    // The org's own agents, live ones only, by name (for placement pickers).
    async listOrgAgents (orgId) {
      return all(agents, (a) => a.orgId === orgId && !a.revokedAt).sort((a, b) => a.name.localeCompare(b.name)).map(copy)
    },
    async touchAgent (id) { const a = agents.get(id); if (a) a.lastUsedAt = now() },
    // Revoking an agent kills every key it holds at once.
    async revokeAgent (id) {
      const a = agents.get(id)
      if (!a || a.revokedAt) return false
      a.revokedAt = now()
      for (const k of keyRows.values()) if (k.agentId === id && !k.revokedAt) k.revokedAt = now()
      for (const k of appKeys.values()) if (k.agentId === id && !k.revokedAt) k.revokedAt = now()
      return true
    },
    // An agent coming back with a new invite: its new profile and resume key, and back
    // from revoked. A publicKey left out keeps the one it has.
    async rejoinAgent (id, { name, provider, type, description = '', publicKey = null, resumeHash }) {
      const a = agents.get(id)
      if (!a) throw fkViolation('agent', 'does not exist')
      if (publicKey && all(agents, (x) => x.publicKey === publicKey && x.id !== id).length) throw duplicatePublicKey()
      Object.assign(a, { name, provider, type, description, revokedAt: null }, publicKey ? { publicKey } : {})
      for (const [h, agentId] of resumeHashes) if (agentId === id) resumeHashes.delete(h)
      if (resumeHash) resumeHashes.set(resumeHash, id)
      return copy(a)
    },
    // Only for undoing a half-finished join.
    async deleteAgent (id) { dropAgent(id) },
    // Agent invites: only the token's hash is kept. Mirrors the one-home and
    // no-role-without-an-org checks and the composite (role_id, org_id) key.
    async createAgentInvite ({ tokenHash, ownerUserId = null, orgId = null, createdBy = null, roleId = null, teams = [], expiresAt, workspaceId = null, workspaceAccess = null, workspaceSessions = null, global = false }) {
      if ((ownerUserId == null) === (orgId == null) || (roleId && !orgId)) throw checkViolation('an invite is for one person or one org')
      if (!roleInOrg(roleId, orgId)) throw fkViolation('role', 'is not in this org')
      const row = { id: uuid(), tokenHash, ownerUserId, orgId, createdBy, roleId, teams: copy(teams), expiresAt, workspaceId, workspaceAccess, workspaceSessions, global: !!global, usedAt: null, usedByAgentId: null, rejoined: false, cancelledAt: null, createdAt: now() }
      agentInvites.set(row.id, row); return copy(row)
    },
    async agentInviteByToken (h) { return copy(all(agentInvites, (i) => i.tokenHash === h)[0]) },
    async agentInviteById (id) { return copy(agentInvites.get(id)) },
    async listAgentInvites ({ ownerUserId, orgId }) {
      return all(agentInvites, (i) => (orgId ? i.orgId === orgId : i.ownerUserId === ownerUserId))
        .sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).map(copy)
    },
    // Check-and-set: an invite is used once, and only while it's open.
    async claimAgentInvite (id) {
      const i = agentInvites.get(id)
      if (!i || i.usedAt || i.cancelledAt || i.expiresAt <= now()) return false
      i.usedAt = now(); return true
    },
    // Undoes a claim when making the agent failed, so the link can be tried again.
    async releaseAgentInvite (id) { const i = agentInvites.get(id); if (i) Object.assign(i, { usedAt: null, usedByAgentId: null, rejoined: false }) },
    async setInviteAgent (id, agentId, rejoined = false) { Object.assign(agentInvites.get(id), { usedByAgentId: agentId, rejoined }) },
    // Check-and-set: only a waiting invite is cancelled.
    async cancelAgentInvite (id) {
      const i = agentInvites.get(id)
      if (!i || i.usedAt || i.cancelledAt || i.expiresAt <= now()) return false
      i.cancelledAt = now(); return true
    },

    // App keys (qk_): hashes only, and they don't run out.
    async createAgentAppKey ({ agentId, name, keyHash }) {
      if (!agents.has(agentId)) throw fkViolation('agent', 'does not exist')
      const row = { id: uuid(), agentId, name, keyHash, createdAt: now(), lastUsedAt: null, revokedAt: null }
      appKeys.set(row.id, row); return copy(row)
    },
    async agentAppKeyByHash (h) { return copy(all(appKeys, (k) => k.keyHash === h)[0]) },
    async listAgentAppKeys (agentId) {
      return all(appKeys, (k) => k.agentId === agentId && !k.revokedAt).sort((a, b) => a.createdAt - b.createdAt).map(copy)
    },
    async touchAgentAppKey (id) { const k = appKeys.get(id); if (k) k.lastUsedAt = now() },
    // Only a key of this agent, and only once.
    async revokeAgentAppKey (agentId, id) {
      const k = appKeys.get(id)
      if (!k || k.agentId !== agentId || k.revokedAt) return false
      k.revokedAt = now(); return true
    },

    // Agent keys: hashes only.
    async createAgentKeys (k) {
      if (!agents.has(k.agentId)) throw fkViolation('agent', 'does not exist')
      const row = { id: uuid(), refreshedAt: null, revokedAt: null, createdAt: now(), ...k }
      keyRows.set(row.id, row); return copy(row)
    },
    async agentKeyByAccess (h) { return copy(all(keyRows, (k) => k.accessHash === h)[0]) },
    async agentKeyByRefresh (h) { return copy(all(keyRows, (k) => k.refreshHash === h)[0]) },
    async listAgentKeys (agentId) { return all(keyRows, (k) => k.agentId === agentId).map(copy) },
    // Check-and-set: a refresh key is spent once, and never after it was revoked.
    async claimRefresh (id) {
      const k = keyRows.get(id)
      if (!k || k.refreshedAt || k.revokedAt) return false
      k.refreshedAt = now(); return true
    },
    async revokeFamily (familyId) {
      for (const k of keyRows.values()) if (k.familyId === familyId && !k.revokedAt) k.revokedAt = now()
    },
    // Undoes a claim when minting the new pair failed, so the same refresh key can retry.
    async releaseRefresh (id) {
      const k = keyRows.get(id)
      if (k && !k.revokedAt) k.refreshedAt = null
    },
    async deleteUser (userId) {
      const accounts = [`person:${userId}`, ...all(agents, (a) => a.ownerUserId === userId).map((a) => `agent:${a.id}`)]
      dropAccess(accounts)
      dropActivity(accounts)
      profiles.delete(userId); users.delete(userId)
      for (const [id, d] of devices) if (d.userId === userId) devices.delete(id)
      for (const [id, a] of agents) if (a.ownerUserId === userId) dropAgent(id)
      for (const a of agents.values()) if (a.invitedBy === userId) a.invitedBy = null
      for (const [id, i] of agentInvites) if (i.ownerUserId === userId) agentInvites.delete(id)
      for (const i of agentInvites.values()) if (i.createdBy === userId) i.createdBy = null
      for (const [id, m] of members) if (m.userId === userId) dropMember(id)
      for (const [id, r] of requests) if (r.userId === userId) requests.delete(id)
      for (const [k, w] of workspaces) if (w.ownerUserId === userId) { for (const s of relaySessions.values()) if (s.workspaceId === k) s.workspaceId = null; for (const [mk, m] of workspaceMembers) if (m.workspaceId === k) workspaceMembers.delete(mk); workspaces.delete(k) }
    },

    // The address a person signs in with, and whether they've confirmed it.
    async userEmail (userId) { const u = users.get(userId); return u ? { ...u } : null },

    // Session activity, as the relay reports it (routes/relay.js). Mirrors ingest_presence:
    // events apply in order, each once; returns how many were new.
    async ingestPresence (events, receivedAt) {
      let applied = 0
      for (const e of events) {
        if (seenEvents.has(e.id)) continue
        seenEvents.set(e.id, receivedAt)
        applied++
        const s = relaySessions.get(e.room)
        if (e.type === 'start') {
          if (!s) relaySessions.set(e.room, { room: e.room, name: '', ownerAccount: e.owner ? e.account : null, createdAt: e.at, lastActiveAt: e.at, renamedAt: null, workspaceId: null, workspaceLinkedBy: null })
          else {
            if (!s.ownerAccount && e.owner) s.ownerAccount = e.account
            s.lastActiveAt = Math.max(s.lastActiveAt, e.at)
          }
          if (!all(visits, (v) => v.eventStartId === e.id).length) {
            const v = { id: uuid(), eventStartId: e.id, room: e.room, account: e.account, accountName: e.name || '', kind: e.account.split(':')[0], startedAt: e.at, endedAt: null, via: e.via || null, tool: e.tool || null, endReason: null }
            visits.set(v.id, v)
          }
        } else if (e.type === 'end') {
          for (const v of visits.values()) if (v.eventStartId === e.start && v.endedAt == null) Object.assign(v, { endedAt: Math.max(v.startedAt, e.at), endReason: e.reason || null })
          if (s) s.lastActiveAt = Math.max(s.lastActiveAt, e.at)
        } else if (e.type === 'act') {
          // An act whose visit never arrived (its start was dropped from a full queue) is skipped.
          const v = all(visits, (x) => x.eventStartId === e.start)[0]
          if (v && !actions.has(e.id)) actions.set(e.id, { id: e.id, visitStartId: v.eventStartId, room: v.room, account: v.account, action: e.action, target: e.target || '', at: e.at })
        } else if (e.type === 'name') {
          if (!s) relaySessions.set(e.room, { room: e.room, name: e.name, ownerAccount: null, createdAt: e.at, lastActiveAt: e.at, renamedAt: null, workspaceId: null, workspaceLinkedBy: null })
          else if (s.renamedAt == null) s.name = e.name
        }
      }
      return applied
    },
    // The sessions an account was in: the `limit` most recently active, plus any active since `since`.
    async accountSessions (account, { since, limit }) {
      const rooms = new Set(all(visits, (v) => v.account === account).map((v) => v.room))
      const list = all(relaySessions, (s) => rooms.has(s.room)).sort((a, b) => b.lastActiveAt - a.lastActiveAt || a.room.localeCompare(b.room))
      const keep = new Set(list.slice(0, limit))
      return list.filter((s) => keep.has(s) || s.lastActiveAt >= since).map(copy)
    },
    async sessionByRoom (room) { return copy(relaySessions.get(room)) },
    async visitsInRooms (rooms) {
      const set = new Set(rooms)
      return all(visits, (v) => set.has(v.room)).sort((a, b) => a.startedAt - b.startedAt).map(copy)
    },
    // The owner's rename: from now on the relay's name events leave it alone.
    async renameSession (room, name, at) {
      const s = relaySessions.get(room)
      if (!s) return null
      Object.assign(s, { name, renamedAt: at })
      return copy(s)
    },
    // Mirrors prune_activity.
    // What was done in a session in [from, to), oldest first, at most `limit` (actions_in_room).
    async actionsInRoom (room, { from, to, limit }) {
      return all(actions, (a) => a.room === room && a.at >= from && a.at < to)
        .sort((a, b) => a.at - b.at).slice(0, limit).map(copy) // stable: ties keep arrival order
    },
    async pruneActivity ({ before, seenBefore }) {
      for (const [id, v] of visits) if (v.endedAt != null && v.endedAt < before) visits.delete(id)
      for (const [room, s] of relaySessions) if (s.lastActiveAt < before && !all(visits, (v) => v.room === room).length) relaySessions.delete(room)
      for (const [id, at] of seenEvents) if (at < seenBefore) seenEvents.delete(id)
      dropOrphans()
    },

    // Access types (see 20261002010000_access_types_and_invites.sql). The built-ins live in
    // session-access.js, not here.
    async listAccessTypes (ownerAccount) {
      return all(accessTypes, (t) => t.ownerAccount === ownerAccount).sort((a, b) => a.createdAt - b.createdAt).map(copy)
    },
    async accessTypeById (id) { return copy(accessTypes.get(id)) },
    async createAccessType ({ ownerAccount, name, files, folders = [], talk = true }) {
      if (folders.length > 20) throw checkViolation('at most 20 folders')
      const row = { id: uuid(), ownerAccount, name, files, folders: [...folders], talk, createdAt: now(), updatedAt: now() }
      accessTypes.set(row.id, row); return copy(row)
    },
    async updateAccessType (id, patch) {
      const t = accessTypes.get(id)
      if (!t) return null
      for (const k of ['name', 'files', 'folders', 'talk']) if (patch[k] !== undefined) t[k] = copy(patch[k])
      t.updatedAt = now()
      return copy(t)
    },
    // Mirrors delete_access_type: grants and invites that used it fall back to View only.
    async deleteAccessType (id, ownerAccount) {
      const t = accessTypes.get(id)
      if (!t || t.ownerAccount !== ownerAccount) return false
      accessTypes.delete(id)
      for (const g of grants.values()) if (g.typeId === id) Object.assign(g, { typeId: FALLBACK_TYPE, updatedAt: now() })
      for (const i of sessionInvites.values()) if (i.typeId === id) i.typeId = FALLBACK_TYPE
      return true
    },

    // Grants: one per (room, account). Mirrors the foreign key to relay_sessions.
    async grantFor (room, account) { return copy(grants.get(grantKey(room, account))) },
    async listGrants (room) { return all(grants, (g) => g.room === room).sort((a, b) => a.createdAt - b.createdAt).map(copy) },
    async putGrant ({ room, account, typeId, tighten = {}, grantedBy }) {
      if (!relaySessions.has(room)) throw fkViolation('session', 'does not exist')
      const k = grantKey(room, account)
      const old = grants.get(k)
      const row = { room, account, typeId, tighten: copy(tighten), grantedBy, createdAt: old ? old.createdAt : now(), updatedAt: now() }
      grants.set(k, row); return copy(row)
    },
    async deleteGrant (room, account) { return grants.delete(grantKey(room, account)) },

    // Session invites: the link is never kept.
    // Mirrors the unique indexes on open invites, and clearing that key's expired ones first.
    async createSessionInvite ({ room, email = null, account = null, accountName = '', typeId, invitedBy, expiresAt, at = now() }) {
      if (!relaySessions.has(room)) throw fkViolation('session', 'does not exist')
      if ((email == null) === (account == null)) throw checkViolation('an invite is for an email or an account')
      email = email && email.toLowerCase()
      const same = (i) => i.room === room && (email ? i.email === email : i.account === account) && !i.usedAt && !i.cancelledAt
      for (const [id, i] of sessionInvites) if (same(i) && i.expiresAt <= at) sessionInvites.delete(id)
      if (all(sessionInvites, same).length) throw duplicate('an open invite')
      const row = { id: uuid(), room, email: email && email.toLowerCase(), account, accountName, typeId, invitedBy, createdAt: now(), expiresAt, usedAt: null, usedBy: null, cancelledAt: null }
      sessionInvites.set(row.id, row); return copy(row)
    },
    async listSessionInvites (room) {
      return all(sessionInvites, (i) => i.room === room).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).map(copy)
    },
    async sessionInviteById (room, id) { const i = sessionInvites.get(id); return i && i.room === room ? copy(i) : null },
    async openSessionInvite (room, { email = null, account = null }, at, exceptId = null) {
      const found = all(sessionInvites, (i) => i.room === room && i.id !== exceptId && (email ? i.email === email : i.account === account) && inviteOpenAt(i, at))
      return copy(found[0] || null)
    },
    // Check-and-set: only a waiting invite is cancelled.
    async cancelSessionInvite (id) {
      const i = sessionInvites.get(id)
      if (!i || i.usedAt || i.cancelledAt) return false
      i.cancelledAt = now(); return true
    },
    // Mirrors delete_unused_grant.
    async deleteUnusedGrant (room, account, at) {
      const email = account.startsWith('email:') ? account.slice('email:'.length) : null
      if (all(sessionInvites, (i) => i.room === room && (email ? i.email === email : i.account === account) && inviteOpenAt(i, at)).length) return false
      return grants.delete(grantKey(room, account))
    },
    // Mirrors claim_email_invites: the open invites are used, and the email's grant becomes the account's.
    async claimEmailInvites (room, email, account) {
      const at = now()
      const open = all(sessionInvites, (i) => i.room === room && i.email === email && inviteOpenAt(i, at))
      if (!open.length) return 0
      for (const i of open) Object.assign(i, { usedAt: at, usedBy: account })
      const from = grants.get(grantKey(room, `email:${email}`))
      if (from) {
        const old = grants.get(grantKey(room, account))
        grants.set(grantKey(room, account), { ...copy(from), account, createdAt: old ? old.createdAt : at, updatedAt: at })
        grants.delete(grantKey(room, `email:${email}`))
      }
      return open.length
    },
    // An invited account came in: its open invites are used.
    async useAccountInvites (room, account) {
      const at = now()
      for (const i of sessionInvites.values()) if (i.room === room && i.account === account && inviteOpenAt(i, at)) Object.assign(i, { usedAt: at, usedBy: account })
    },

    // Orgs. Creating one makes its three built-in roles and its owner together.
    // first: true mirrors create_org's advisory lock for "a team" sign-ups: if
    // the owner is already in an org (this call or another one that won the
    // race), that org comes back instead of a second one.
    async createOrg ({ name, slug, ownerId, grants, first = false }) {
      if (first) {
        const already = all(members, (m) => m.userId === ownerId)[0]
        if (already) return copy(orgs.get(already.orgId))
      }
      if (all(orgs, (o) => o.slug === slug).length) throw duplicate('org')
      const org = { id: uuid(), name, slug, ownerId, domain: null, domainRequests: false, createdAt: now() }
      orgs.set(org.id, org)
      let ownerRole
      for (const [builtin, roleName] of [['owner', 'Owner'], ['admin', 'Admin'], ['member', 'Member']]) {
        const r = { id: uuid(), orgId: org.id, name: roleName, builtin, grants: copy(grants[builtin]), createdAt: now() }
        roles.set(r.id, r)
        if (builtin === 'owner') ownerRole = r
      }
      const m = { id: uuid(), orgId: org.id, userId: ownerId, agentId: null, roleId: ownerRole.id, joinedAt: now() }
      members.set(m.id, m)
      return copy(org)
    },
    async orgBySlug (slug) { return copy(all(orgs, (o) => o.slug === slug)[0]) },
    async orgById (id) { return copy(orgs.get(id)) },
    async orgsForUser (userId) {
      return all(members, (m) => m.userId === userId)
        .map((m) => ({ ...copy(orgs.get(m.orgId)), roleId: m.roleId }))
        .sort((a, b) => a.name.localeCompare(b.name))
    },
    async orgsByDomain (domain) { return all(orgs, (o) => o.domain === domain && o.domainRequests).map(copy) },
    async updateOrg (id, patch) {
      const o = orgs.get(id)
      for (const k of ['name', 'domain', 'domainRequests']) if (patch[k] !== undefined) o[k] = patch[k]
      return copy(o)
    },
    async deleteOrg (id) {
      orgs.delete(id)
      for (const [k, a] of agents) if (a.orgId === id) dropAgent(k)
      for (const [k, i] of agentInvites) if (i.orgId === id) agentInvites.delete(k)
      for (const [k, m] of members) if (m.orgId === id) dropMember(k)
      for (const [k, t] of teams) if (t.orgId === id) teams.delete(k)
      for (const [k, r] of roles) if (r.orgId === id) roles.delete(k)
      for (const [k, i] of invites) if (i.orgId === id) invites.delete(k)
      for (const [k, r] of requests) if (r.orgId === id) requests.delete(k)
      for (const [k, w] of workspaces) if (w.orgId === id) { for (const s of relaySessions.values()) if (s.workspaceId === k) s.workspaceId = null; for (const [mk, m] of workspaceMembers) if (m.workspaceId === k) workspaceMembers.delete(mk); workspaces.delete(k) }
    },
    // Ownership moves in one step: the old owner becomes an Admin. Mirrors
    // transfer_org's own errcodes (QO003/QO002/QO001) for the same checks.
    async transferOrg (orgId, fromUserId, toUserId) {
      const o = orgs.get(orgId)
      // fromUserId is the owner the caller saw when they clicked transfer; if
      // ownership already moved, refuse instead of transferring it a second time.
      if (o.ownerId !== fromUserId) throw Object.assign(new Error('not the owner'), { code: 'QO003' })
      const to = findMember(orgId, toUserId)
      if (!to) throw Object.assign(new Error('target is not a member of this org'), { code: 'QO002' })
      const from = findMember(orgId, o.ownerId)
      if (!from) throw Object.assign(new Error('current owner is not a member of this org'), { code: 'QO001' })
      const builtin = (b) => all(roles, (r) => r.orgId === orgId && r.builtin === b)[0]
      from.roleId = builtin('admin').id
      to.roleId = builtin('owner').id
      o.ownerId = toUserId
    },

    // Roles.
    async listRoles (orgId) { return all(roles, (r) => r.orgId === orgId).map(copy) },
    async roleById (orgId, id) { const r = roles.get(id); return r && r.orgId === orgId ? copy(r) : null },
    async createRole ({ orgId, name, grants }) {
      if (all(roles, (r) => r.orgId === orgId && r.name === name).length) throw duplicate('role')
      const r = { id: uuid(), orgId, name, builtin: null, grants: copy(grants), createdAt: now() }
      roles.set(r.id, r); return copy(r)
    },
    async updateRole (id, { name, grants }) {
      const r = roles.get(id)
      if (name !== undefined && all(roles, (x) => x.orgId === r.orgId && x.name === name && x.id !== id).length) throw duplicate('role')
      if (name !== undefined) r.name = name
      if (grants !== undefined) r.grants = copy(grants)
      return copy(r)
    },
    // A deleted role's closed invites (accepted, cancelled or expired) go with
    // it; an open invite still referencing the role blocks the delete, mirroring
    // the (role_id, org_id) foreign key's NO ACTION in Postgres.
    async deleteRole (id) {
      for (const [k, i] of invites) {
        if (i.roleId === id && !inviteOpen(i)) invites.delete(k)
      }
      if (all(invites, (i) => i.roleId === id).length) throw fkViolation('role')
      // agent_invites' role key is "on delete set null (role_id)": the invite keeps going without a role.
      for (const i of agentInvites.values()) if (i.roleId === id) i.roleId = null
      roles.delete(id)
    },
    // In use: someone holds it, or an open invite would hand it out.
    async roleInUse (id) {
      return all(members, (m) => m.roleId === id).length > 0 ||
        all(invites, (i) => i.roleId === id && inviteOpen(i)).length > 0
    },
    // Members.
    async memberOf (orgId, userId) { return copy(findMember(orgId, userId)) },
    async memberById (orgId, id) { const m = members.get(id); return m && m.orgId === orgId ? copy(m) : null },
    async listMembers (orgId) {
      return all(members, (m) => m.orgId === orgId)
        .map((m) => {
          const a = m.agentId ? agents.get(m.agentId) : null
          return { ...copy(m), name: memberName(m), provider: a?.provider ?? null, type: a?.type ?? null, publicKey: a?.publicKey ?? null }
        })
        .sort((a, b) => a.joinedAt - b.joinedAt)
    },
    async addMember ({ orgId, userId, roleId }) {
      const existing = findMember(orgId, userId)
      if (existing) return copy(existing)
      if (!roleInOrg(roleId, orgId)) throw fkViolation('role')
      const m = { id: uuid(), orgId, userId, agentId: null, roleId, joinedAt: now() }
      members.set(m.id, m); return copy(m)
    },
    async setMemberRole (id, roleId) {
      const m = members.get(id)
      if (!roleInOrg(roleId, m.orgId)) throw fkViolation('role')
      m.roleId = roleId; return copy(m)
    },
    async removeMember (id) { dropMember(id) },
    // Mirrors the composite (agent_id, org_id) foreign key: only the org's own agents join it.
    async addAgentMember ({ orgId, agentId, roleId = null }) {
      if (agents.get(agentId)?.orgId !== orgId) throw fkViolation('agent', 'is not in this org')
      if (!roleInOrg(roleId, orgId)) throw fkViolation('role')
      if (all(members, (m) => m.orgId === orgId && m.agentId === agentId).length) throw duplicate('member')
      const m = { id: uuid(), orgId, userId: null, agentId, roleId, joinedAt: now() }
      members.set(m.id, m); return copy(m)
    },
    async memberByAgent (orgId, agentId) { return copy(all(members, (m) => m.orgId === orgId && m.agentId === agentId)[0]) },

    // Teams.
    async listTeams (orgId) { return all(teams, (t) => t.orgId === orgId).sort((a, b) => a.name.localeCompare(b.name)).map(copy) },
    async teamById (orgId, id) { const t = teams.get(id); return t && t.orgId === orgId ? copy(t) : null },
    async createTeam ({ orgId, name }) {
      if (all(teams, (t) => t.orgId === orgId && t.name === name).length) throw duplicate('team')
      const t = { id: uuid(), orgId, name, createdAt: now() }
      teams.set(t.id, t); return copy(t)
    },
    async renameTeam (id, name) {
      const t = teams.get(id)
      if (all(teams, (x) => x.orgId === t.orgId && x.name === name && x.id !== id).length) throw duplicate('team')
      t.name = name; return copy(t)
    },
    async deleteTeam (id) {
      teams.delete(id)
      for (const [k, tm] of teamMembers) if (tm.teamId === id) teamMembers.delete(k)
    },
    async listTeamMembers (teamId) {
      return all(teamMembers, (tm) => tm.teamId === teamId).sort((a, b) => a.addedAt - b.addedAt)
        .map((tm) => {
          const m = members.get(tm.memberId)
          return { ...copy(tm), name: memberName(m), kind: m?.agentId ? 'agent' : 'person' }
        })
    },
    async teamsOfMember (memberId) {
      return all(teamMembers, (tm) => tm.memberId === memberId).map((tm) => ({ teamId: tm.teamId, access: tm.access, scopes: [...tm.scopes] }))
    },
    // Mirrors the composite (team_id, org_id) / (member_id, org_id) foreign
    // keys: a team and the member it holds must be in the same org.
    async addTeamMember ({ teamId, memberId, access, scopes = [] }) {
      const team = teams.get(teamId)
      const member = members.get(memberId)
      if (!team || !member || team.orgId !== member.orgId) throw fkViolation('team or member', 'is not in this org')
      tooManyFolders(scopes)
      const key = `${teamId}:${memberId}`
      const tm = teamMembers.get(key) || { teamId, memberId, addedAt: now() }
      tm.access = access
      tm.scopes = [...scopes]
      teamMembers.set(key, tm); return copy(tm)
    },
    // Folders only change when given, so an access-only change keeps them.
    async setTeamAccess (teamId, memberId, access, scopes) {
      const tm = teamMembers.get(`${teamId}:${memberId}`)
      if (!tm) return null
      if (scopes !== undefined) tooManyFolders(scopes)
      tm.access = access
      if (scopes !== undefined) tm.scopes = [...scopes]
      return copy(tm)
    },
    async removeTeamMember (teamId, memberId) { return teamMembers.delete(`${teamId}:${memberId}`) },

    // Invites: only the token's hash is kept. Mirrors org_invites.email's
    // lowercase check constraint.
    async createInvite (i) {
      const row = { id: uuid(), acceptedAt: null, cancelledAt: null, createdAt: now(), ...i, email: i.email.toLowerCase() }
      invites.set(row.id, row); return copy(row)
    },
    async inviteByToken (h) { return copy(all(invites, (i) => i.tokenHash === h)[0]) },
    async inviteById (orgId, id) { const i = invites.get(id); return i && i.orgId === orgId ? copy(i) : null },
    async listInvites (orgId) { return all(invites, (i) => i.orgId === orgId && !i.acceptedAt && !i.cancelledAt).map(copy) },
    async updateInvite (id, patch) { const i = invites.get(id); Object.assign(i, patch); return copy(i) },
    // Check-and-set, so one invite can't be accepted twice, after it was
    // cancelled, or once it's expired — the same "open invite" definition inviteOpen uses.
    async claimInvite (id) {
      const i = invites.get(id)
      if (!i || !inviteOpen(i)) return false
      i.acceptedAt = now(); return true
    },

    // Domain join requests: at most one pending per person per org. Mirrors
    // join_requests.email's lowercase check constraint.
    async createJoinRequest ({ orgId, userId, email }) {
      const pending = all(requests, (r) => r.orgId === orgId && r.userId === userId && r.status === 'pending')[0]
      if (pending) return copy(pending)
      const r = { id: uuid(), orgId, userId, email: email.toLowerCase(), status: 'pending', decidedBy: null, decidedAt: null, createdAt: now() }
      requests.set(r.id, r); return copy(r)
    },
    async joinRequestById (orgId, id) { const r = requests.get(id); return r && r.orgId === orgId ? copy(r) : null },
    async listJoinRequests (orgId) {
      return all(requests, (r) => r.orgId === orgId && r.status === 'pending').map((r) => ({ ...copy(r), name: nameOf(r.userId) }))
    },
    async joinRequestsForUser (userId) { return all(requests, (r) => r.userId === userId).map(copy) },
    // Check-and-set: a request is decided once.
    async decideJoinRequest (id, { status, decidedBy }) {
      const r = requests.get(id)
      if (!r || r.status !== 'pending') return false
      Object.assign(r, { status, decidedBy, decidedAt: now() }); return true
    },
    // Issue reports. One event per outcome; a failure also opens (or counts up) its
    // issue by fingerprint. Mirrors record_events(jsonb) in Postgres.
    async recordEvents (list) {
      for (const e of list) {
        let issueId = null
        if (e.outcome !== 'ok') {
          let issue = issues.get(e.fingerprint)
          if (!issue) {
            issue = { id: uuid(), fingerprint: e.fingerprint, surface: e.surface, kind: e.kind, name: e.name, message: e.message, count: 0, firstSeenAt: e.occurredAt, lastSeenAt: e.occurredAt, resolvedAt: null }
            issues.set(e.fingerprint, issue)
          }
          issue.count += 1
          issue.lastSeenAt = Math.max(issue.lastSeenAt, e.occurredAt)
          issue.resolvedAt = null
          issueId = issue.id
        }
        const row = { id: uuid(), ...copy(e), issueId, createdAt: now() }
        delete row.fingerprint
        events.set(row.id, row)
      }
      return list.length
    },
    async pruneEvents (before) {
      let n = 0
      for (const [id, e] of events) if (e.occurredAt < before) { events.delete(id); n++ }
      return n
    },
    // Issues people haven't seen in a long while, so the one table meant to be read
    // doesn't grow forever (scanners hitting unknown routes, abandoned reports, …).
    async pruneIssues (before) {
      let n = 0
      for (const [key, i] of issues) if (i.lastSeenAt < before) { issues.delete(key); n++ }
      return n
    },
    // Workspaces (see 20261004000000_workspaces.sql).
    async createWorkspace ({ ownerUserId = null, orgId = null, name, description = '', color = '', createdBy }) {
      if ((ownerUserId == null) === (orgId == null)) throw checkViolation('a workspace belongs to a person or an org')
      const row = { id: uuid(), ownerUserId, orgId, name, description, color, createdBy, createdAt: now(), archivedAt: null, quotaBytes: 5368709120, usedBytes: 0, fileCount: 0 }
      workspaces.set(row.id, row); return copy(row)
    },
    async workspaceById (id) { return copy(workspaces.get(id)) },
    async listWorkspacesOwnedBy (userId) { return all(workspaces, (w) => w.ownerUserId === userId).sort((a, b) => a.name.localeCompare(b.name)).map(copy) },
    async listWorkspacesOfOrg (orgId) { return all(workspaces, (w) => w.orgId === orgId).sort((a, b) => a.name.localeCompare(b.name)).map(copy) },
    async listWorkspacesForMember (account) {
      return all(workspaceMembers, (m) => m.account === account)
        .map((m) => ({ ...copy(workspaces.get(m.workspaceId)), memberAccess: m.access }))
        .filter((w) => w.id)
        .sort((a, b) => a.name.localeCompare(b.name))
    },
    async updateWorkspace (id, patch) {
      const w = workspaces.get(id)
      if (!w) return null
      for (const k of ['name', 'description', 'color', 'archivedAt']) if (patch[k] !== undefined) w[k] = patch[k]
      return copy(w)
    },
    async deleteWorkspace (id) {
      for (const s of relaySessions.values()) if (s.workspaceId === id) s.workspaceId = null
      for (const [k, m] of workspaceMembers) if (m.workspaceId === id) workspaceMembers.delete(k)
      for (const [k, f] of workspaceFiles) {
        if (f.workspaceId !== id) continue
        for (const vk of [...workspaceFileVersions.keys()]) if (vk.startsWith(`${f.id}\n`)) workspaceFileVersions.delete(vk)
        workspaceFiles.delete(k)
      }
      for (const [k, o] of workspaceAgentOverrides) if (o.workspaceId === id) workspaceAgentOverrides.delete(k)
      // As Postgres cascades agent_invites.workspace_id: a link for this workspace goes with it.
      for (const [k, i] of agentInvites) if (i.workspaceId === id) agentInvites.delete(k)
      workspaces.delete(id)
    },
    async workspaceMember (workspaceId, account) { return copy(workspaceMembers.get(wmKey(workspaceId, account))) },
    async listWorkspaceMembers (workspaceId) { return all(workspaceMembers, (m) => m.workspaceId === workspaceId).sort((a, b) => a.addedAt - b.addedAt).map(copy) },
    // sessions only changes when given: an upsert that omits it keeps whatever the
    // member already had, and a brand new member defaults to 'invited'.
    async putWorkspaceMember ({ workspaceId, account, access, addedBy, sessions }) {
      if (!workspaces.has(workspaceId)) throw fkViolation('workspace', 'does not exist')
      const k = wmKey(workspaceId, account)
      const old = workspaceMembers.get(k)
      const row = { workspaceId, account, access, addedBy, sessions: sessions !== undefined ? sessions : (old ? old.sessions : 'invited'), addedAt: old ? old.addedAt : now() }
      workspaceMembers.set(k, row); return copy(row)
    },
    async removeWorkspaceMember (workspaceId, account) { return workspaceMembers.delete(wmKey(workspaceId, account)) },
    // Links a room to a workspace (or none), recording who linked it. The relay may not have
    // reported the room yet: then the API makes the row, with no owner (only the relay sets that).
    async setSessionWorkspace (room, workspaceId, { linkedBy = null, at }) {
      if (workspaceId && !workspaces.has(workspaceId)) throw fkViolation('workspace', 'does not exist')
      let s = relaySessions.get(room)
      if (!s) { s = { room, name: '', ownerAccount: null, createdAt: at, lastActiveAt: at, renamedAt: null, workspaceId: null, workspaceLinkedBy: null }; relaySessions.set(room, s) }
      s.workspaceId = workspaceId || null
      s.workspaceLinkedBy = linkedBy || null
      return copy(s)
    },
    async listWorkspaceSessions (workspaceId) { return all(relaySessions, (s) => s.workspaceId === workspaceId).sort((a, b) => b.lastActiveAt - a.lastActiveAt).map(copy) },

    // Workspace agents (see 20261007000001_workspace_agents.sql). Where an agent works,
    // a workspace's say over one that reaches it, per-session keep-outs, and its webhook.
    async agentPlacement (agentId) { return copy(agentPlacements.get(agentId)) },
    async putAgentPlacement ({ agentId, reach = 'manual', workspaceIds = [], sessions = 'invited', access = 'edit', scopes = [], updatedBy }) {
      if (!agents.has(agentId)) throw fkViolation('agent', 'does not exist')
      if (scopes.length > 20) throw checkViolation('at most 20 folders')
      const row = { agentId, reach, workspaceIds: [...workspaceIds], sessions, access, scopes: [...scopes], updatedBy, updatedAt: now() }
      agentPlacements.set(agentId, row); return copy(row)
    },
    async listAgentPlacements (agentIds) { return agentIds.map((id) => agentPlacements.get(id)).filter(Boolean).map(copy) },
    async workspaceAgentOverride (workspaceId, agentId) { return copy(workspaceAgentOverrides.get(waoKey(workspaceId, agentId))) },
    async putWorkspaceAgentOverride ({ workspaceId, agentId, sessions = null, excluded = false }) {
      if (!workspaces.has(workspaceId)) throw fkViolation('workspace', 'does not exist')
      if (!agents.has(agentId)) throw fkViolation('agent', 'does not exist')
      const row = { workspaceId, agentId, sessions, excluded }
      workspaceAgentOverrides.set(waoKey(workspaceId, agentId), row); return copy(row)
    },
    async deleteWorkspaceAgentOverride (workspaceId, agentId) { return workspaceAgentOverrides.delete(waoKey(workspaceId, agentId)) },
    async listWorkspaceAgentOverrides (workspaceId) { return all(workspaceAgentOverrides, (o) => o.workspaceId === workspaceId).map(copy) },
    async addSessionAgentExclusion ({ room, agentId, excludedBy }) {
      if (!relaySessions.has(room)) throw fkViolation('session', 'does not exist')
      if (!agents.has(agentId)) throw fkViolation('agent', 'does not exist')
      const k = saeKey(room, agentId)
      const old = sessionAgentExclusions.get(k)
      const row = { room, agentId, excludedBy, createdAt: old ? old.createdAt : now() }
      sessionAgentExclusions.set(k, row); return copy(row)
    },
    async removeSessionAgentExclusion (room, agentId) { return sessionAgentExclusions.delete(saeKey(room, agentId)) },
    async sessionAgentExcluded (room, agentId) { return sessionAgentExclusions.has(saeKey(room, agentId)) },
    async listSessionAgentExclusions (room) { return all(sessionAgentExclusions, (r) => r.room === room).map(copy) },
    async agentWebhook (agentId) { return copy(agentWebhooks.get(agentId)) },
    async putAgentWebhook ({ agentId, url, secret }) {
      if (!agents.has(agentId)) throw fkViolation('agent', 'does not exist')
      const old = agentWebhooks.get(agentId)
      const row = { agentId, url, secret, createdAt: old ? old.createdAt : now(), updatedAt: now() }
      agentWebhooks.set(agentId, row); return copy(row)
    },
    async deleteAgentWebhook (agentId) { return agentWebhooks.delete(agentId) },

    // Workspace files (see 20261005000000_workspace_files.sql).
    async createWorkspaceFile ({ workspaceId, path, kind, size = 0, mime = '', sha256 = '', objectKey = '', note = '', uploadedBy }) {
      if (!workspaces.has(workspaceId)) throw fkViolation('workspace', 'does not exist')
      if (all(workspaceFiles, (f) => f.workspaceId === workspaceId && f.path === path && !f.deletedAt).length) throw duplicate('file')
      const row = { id: uuid(), workspaceId, path, kind, size, mime, sha256, version: 1, objectKey, note, uploadedBy, uploadedAt: now(), confirmedAt: null, deletedAt: null }
      workspaceFiles.set(row.id, row); return copy(row)
    },
    async workspaceFileById (id) { return copy(workspaceFiles.get(id)) },
    async workspaceFileByPath (workspaceId, path) { return copy(all(workspaceFiles, (f) => f.workspaceId === workspaceId && f.path === path && !f.deletedAt)[0]) },
    async listWorkspaceFiles (workspaceId, { includeDeleted = false } = {}) {
      return all(workspaceFiles, (f) => f.workspaceId === workspaceId && (includeDeleted || !f.deletedAt))
        .sort((a, b) => (a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === 'folder' ? -1 : 1)).map(copy)
    },
    async newWorkspaceFileVersion (id, { size, mime, sha256, objectKey, note = '', uploadedBy, at, keep = 10 }) {
      const f = workspaceFiles.get(id)
      if (!f) return null
      workspaceFileVersions.set(`${id}\n${f.version}`, { fileId: id, version: f.version, size: f.size, sha256: f.sha256, objectKey: f.objectKey, note: f.note, uploadedBy: f.uploadedBy, uploadedAt: f.uploadedAt })
      Object.assign(f, { version: f.version + 1, size, mime, sha256, objectKey, note, uploadedBy, uploadedAt: at, confirmedAt: null })
      const old = all(workspaceFileVersions, (v) => v.fileId === id).sort((a, b) => b.version - a.version).slice(keep)
      for (const v of old) workspaceFileVersions.delete(`${id}\n${v.version}`)
      return { file: copy(f), droppedKeys: old.map((v) => v.objectKey).filter(Boolean) }
    },
    async listWorkspaceFileVersions (id) { return all(workspaceFileVersions, (v) => v.fileId === id).sort((a, b) => b.version - a.version).map(copy) },
    async confirmWorkspaceFile (id, { size, at }) { const f = workspaceFiles.get(id); if (!f) return null; Object.assign(f, { size, confirmedAt: at }); return copy(f) },
    async updateWorkspaceFile (id, { path, note }) {
      const f = workspaceFiles.get(id)
      if (!f) return null
      if (path !== undefined && path !== f.path && all(workspaceFiles, (x) => x.workspaceId === f.workspaceId && x.path === path && !x.deletedAt && x.id !== id).length) throw duplicate('file')
      if (path !== undefined) f.path = path
      if (note !== undefined) f.note = note
      return copy(f)
    },
    // Moves a folder and everything in it: 'cuts' -> 'final' renames 'cuts', 'cuts/a', 'cuts/x/b'.
    async renameWorkspaceFolder (workspaceId, from, to, at) {
      const rows = all(workspaceFiles, (f) => f.workspaceId === workspaceId && !f.deletedAt && (f.path === from || f.path.startsWith(from + '/')))
      for (const f of rows) f.path = to + f.path.slice(from.length)
      return rows.length
    },
    async deleteWorkspaceFile (id, at) {
      const f = workspaceFiles.get(id)
      if (!f) return null
      const rows = f.kind === 'folder' ? all(workspaceFiles, (x) => x.workspaceId === f.workspaceId && !x.deletedAt && (x.id === id || x.path.startsWith(f.path + '/'))) : [f]
      for (const x of rows) x.deletedAt = at
      return copy(f)
    },
    async unconfirmedWorkspaceFiles (before) { return all(workspaceFiles, (f) => f.kind === 'file' && !f.confirmedAt && f.uploadedAt < before).map(copy) },
    async removeWorkspaceFile (id) { removeFile(id) },
    async sweepDeletedWorkspaceFiles (before) {
      const gone = all(workspaceFiles, (f) => f.deletedAt && f.deletedAt < before)
      const keys = []
      for (const f of gone) {
        if (f.objectKey) keys.push(f.objectKey)
        for (const v of all(workspaceFileVersions, (v) => v.fileId === f.id)) if (v.objectKey) keys.push(v.objectKey)
        removeFile(f.id)
      }
      return keys
    },
    async workspaceUsage (workspaceId) {
      const live = all(workspaceFiles, (f) => f.workspaceId === workspaceId && !f.deletedAt && f.kind === 'file')
      let usedBytes = 0
      for (const f of live) {
        if (f.confirmedAt) usedBytes += f.size
        for (const v of all(workspaceFileVersions, (v) => v.fileId === f.id)) usedBytes += v.size
      }
      return { usedBytes, fileCount: live.length }
    },
    async setWorkspaceUsage (workspaceId, { usedBytes, fileCount }) { const w = workspaces.get(workspaceId); if (w) Object.assign(w, { usedBytes, fileCount }) },
    async setWorkspaceFileObjectKey (id, objectKey) { const f = workspaceFiles.get(id); if (!f) return null; f.objectKey = objectKey; return copy(f) },
    // Undoes a version bump that never confirmed: restores the newest kept version's bytes
    // onto the file row (with that version's own version number and confirmedAt), and removes
    // the version row. A file with no earlier version is returned unchanged.
    async revertWorkspaceFileVersion (id) {
      const f = workspaceFiles.get(id)
      if (!f) return null
      const v = all(workspaceFileVersions, (v) => v.fileId === id).sort((a, b) => b.version - a.version)[0]
      if (!v) return copy(f)
      Object.assign(f, { version: v.version, size: v.size, sha256: v.sha256, objectKey: v.objectKey, note: v.note, uploadedBy: v.uploadedBy, uploadedAt: v.uploadedAt, confirmedAt: v.uploadedAt })
      workspaceFileVersions.delete(`${id}\n${v.version}`)
      return copy(f)
    },

    // Test-only views (production reads the tables in the Supabase dashboard).
    listEvents () { return [...events.values()].map(copy) },
    listIssues () { return [...issues.values()].map(copy) },
    async resolveIssue (id) { for (const i of issues.values()) if (i.id === id) i.resolvedAt = now() }
  }
}
