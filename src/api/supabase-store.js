// The accounts API's data in Supabase, using the service role (row-level security is
// for the website; the API is trusted and writes the secrets).
import { createClient } from '@supabase/supabase-js'

const toCamel = (row) => row && Object.fromEntries(Object.entries(row).map(([k, v]) => [k.replace(/_([a-z])/g, (m, c) => c.toUpperCase()), v]))
const toSnake = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase()), v]))
const ts = (v) => (v == null ? v : typeof v === 'number' ? new Date(v).toISOString() : v)
const ms = (v) => (v == null ? v : Date.parse(v))
// Postgres's foreign-key-violation code, for the same checks memory-store.js mirrors.
const fkViolation = (what) => Object.assign(new Error(`${what} is still referenced`), { code: '23503' })
// No secrets live on agents any more; the columns are still named, like every other table.
const AGENT = 'id, name, provider, type, description, public_key, owner_user_id, org_id, invited_by, created_at, last_used_at, revoked_at'
// Named columns for the org tables, so a select never picks up a secret by accident.
const ORG = 'id, name, slug, owner_id, domain, domain_requests, created_at'
const ROLE = 'id, org_id, name, builtin, grants, created_at'
const MEMBER = 'id, org_id, user_id, agent_id, role_id, joined_at'
const TEAM = 'id, org_id, name, created_at'
const TEAM_MEMBER = 'team_id, member_id, access, scopes, added_at'
const INVITE = 'id, org_id, email, role_id, token_hash, invited_by, expires_at, accepted_at, cancelled_at, created_at'
const REQUEST = 'id, org_id, user_id, email, status, decided_by, decided_at, created_at'
const AGENT_INVITE = 'id, token_hash, owner_user_id, org_id, created_by, role_id, teams, expires_at, used_at, used_by_agent_id, cancelled_at, created_at'
const AGENT_KEY = 'id, agent_id, family_id, access_hash, refresh_hash, access_expires_at, refresh_expires_at, refreshed_at, revoked_at, created_at'
const RELAY_SESSION = 'room, name, owner_account, created_at, last_active_at, renamed_at'
const ACCESS_TYPE = 'id, owner_account, name, files, folders, talk, created_at, updated_at'
const GRANT = 'room, account, type_id, tighten, granted_by, created_at, updated_at'
const SESSION_INVITE = 'id, room, email, account, account_name, type_id, invited_by, created_at, expires_at, used_at, used_by, cancelled_at'
// PostgREST hands back at most 1000 rows per request: longer lists are read a page at a time.
const PAGE = 1000

// One mapper for every table: camelCases the columns and turns every `*At` field
// (createdAt, updatedAt, lastSeenAt, lastUsedAt, revokedAt, expiresAt, joinedAt,
// lastActiveAt, ...) from a Postgres timestamp string into epoch milliseconds,
// matching the memory store (the tested reference).
export const rowFrom = (row) => row && Object.fromEntries(Object.entries(toCamel(row)).map(([k, v]) => [k, /At$/.test(k) ? ms(v) : v]))

// `client` lets tests pass a stand-in for the supabase client.
export function createSupabaseStore ({ url, serviceKey, client }) {
  const db = client || createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const one = async (q) => { const { data, error } = await q; if (error) throw error; return data }
  const memberOf = async (orgId, userId) => rowFrom(await one(db.from('org_members').select(MEMBER).eq('org_id', orgId).eq('user_id', userId).maybeSingle()))
  // Every row of a query, a page at a time. `build` makes a fresh query (with a stable order) per page.
  const pages = async (build) => {
    const out = []
    for (let from = 0; ; from += PAGE) {
      const rows = await one(build().range(from, from + PAGE - 1))
      out.push(...rows)
      if (rows.length < PAGE) return out
    }
  }

  return {
    async createLink (l) {
      return rowFrom(await one(db.from('device_links').insert(toSnake({ ...l, expiresAt: ts(l.expiresAt) })).select().single()))
    },
    async linkByDeviceCode (h) { return rowFrom(await one(db.from('device_links').select().eq('device_code_hash', h).maybeSingle())) },
    async linkByUserCode (c) { return rowFrom(await one(db.from('device_links').select().eq('user_code', c).maybeSingle())) },
    async updateLink (id, patch) {
      return rowFrom(await one(db.from('device_links').update(toSnake({ ...patch, expiresAt: ts(patch.expiresAt) })).eq('id', id).select().single()))
    },
    // Check-and-set: only flips status if it's still fromStatus, so two concurrent
    // callers can't both win the same link (e.g. handing out a device token twice).
    async claimLink (id, fromStatus, toStatus) {
      const rows = await one(db.from('device_links').update({ status: toStatus }).eq('id', id).eq('status', fromStatus).select('id'))
      return rows.length > 0
    },
    // One row per (account, key), so approving a link for someone else's key makes
    // your own row instead of taking theirs. A relink retires the old token.
    async upsertDevice ({ userId, name, platform, publicKey }) {
      return rowFrom(await one(db.from('devices')
        .upsert({ user_id: userId, name, platform, public_key: publicKey, token_hash: null, revoked_at: null }, { onConflict: 'user_id,public_key' })
        .select().single()))
    },
    async setDeviceToken (id, tokenHash) { await one(db.from('devices').update({ token_hash: tokenHash }).eq('id', id)) },
    async deviceByToken (h) { return rowFrom(await one(db.from('devices').select().eq('token_hash', h).is('revoked_at', null).maybeSingle())) },
    async deviceByPublicKey (publicKey) {
      return rowFrom((await one(db.from('devices').select().eq('public_key', publicKey).is('revoked_at', null).order('last_seen_at', { ascending: false }).limit(1)))[0] || null)
    },
    async userHasDevice (userId, publicKey) {
      return (await one(db.from('devices').select('id').eq('user_id', userId).eq('public_key', publicKey).limit(1))).length > 0
    },
    async touchDevice (id) { await one(db.from('devices').update({ last_seen_at: new Date().toISOString() }).eq('id', id)) },
    async revokeDevice (id) { await one(db.from('devices').update({ revoked_at: new Date().toISOString(), token_hash: null }).eq('id', id)) },
    async profile (userId) { return rowFrom(await one(db.from('profiles').select('id, name, color, tool').eq('id', userId).maybeSingle())) },
    // 'personal' or 'org': set once at sign-up, and the only thing POST /v1/orgs checks.
    async profileKind (userId) { return (await one(db.from('profiles').select('kind').eq('id', userId).maybeSingle()))?.kind || null },
    async updateProfile (userId, { name, color, tool }) {
      return rowFrom(await one(db.from('profiles').update(toSnake({ name, color, tool })).eq('id', userId).select('id, name, color, tool').single()))
    },
    async createAgent ({ name, provider, type, description = '', publicKey = null, ownerUserId = null, orgId = null, invitedBy = null }) {
      return rowFrom(await one(db.from('agents')
        .insert({ name, provider, type, description, public_key: publicKey, owner_user_id: ownerUserId, org_id: orgId, invited_by: invitedBy })
        .select(AGENT).single()))
    },
    async agentById (id) { return rowFrom(await one(db.from('agents').select(AGENT).eq('id', id).maybeSingle())) },
    async agentByPublicKey (publicKey) {
      if (!publicKey) return null
      return rowFrom(await one(db.from('agents').select(AGENT).eq('public_key', publicKey).maybeSingle()))
    },
    async listPersonalAgents (userId) {
      return (await one(db.from('agents').select(AGENT).eq('owner_user_id', userId).is('revoked_at', null).order('created_at'))).map(rowFrom)
    },
    async touchAgent (id) { await one(db.from('agents').update({ last_used_at: new Date().toISOString() }).eq('id', id)) },
    // Revoking an agent kills every key it holds at once.
    async revokeAgent (id) {
      const at = new Date().toISOString()
      const rows = await one(db.from('agents').update({ revoked_at: at }).eq('id', id).is('revoked_at', null).select('id'))
      await one(db.from('agent_keys').update({ revoked_at: at }).eq('agent_id', id).is('revoked_at', null))
      return rows.length > 0
    },
    // Only for undoing a half-finished join; cascades to its keys and membership.
    async deleteAgent (id) { await one(db.from('agents').delete().eq('id', id)) },
    // Agent invites: only the token's hash is stored. A deleted role clears
    // role_id by itself (on delete set null (role_id)).
    async createAgentInvite (i) {
      return rowFrom(await one(db.from('agent_invites').insert(toSnake({ ...i, expiresAt: ts(i.expiresAt) })).select(AGENT_INVITE).single()))
    },
    async agentInviteByToken (h) { return rowFrom(await one(db.from('agent_invites').select(AGENT_INVITE).eq('token_hash', h).maybeSingle())) },
    async agentInviteById (id) { return rowFrom(await one(db.from('agent_invites').select(AGENT_INVITE).eq('id', id).maybeSingle())) },
    async listAgentInvites ({ ownerUserId, orgId }) {
      const q = db.from('agent_invites').select(AGENT_INVITE)
      return (await one((orgId ? q.eq('org_id', orgId) : q.eq('owner_user_id', ownerUserId)).order('created_at', { ascending: false }).limit(50))).map(rowFrom)
    },
    // Check-and-set: an invite is used once, and only while it's open.
    async claimAgentInvite (id) {
      const at = new Date().toISOString()
      const rows = await one(db.from('agent_invites').update({ used_at: at }).eq('id', id).is('used_at', null).is('cancelled_at', null).gt('expires_at', at).select('id'))
      return rows.length > 0
    },
    // Undoes a claim when making the agent failed, so the link can be tried again.
    async releaseAgentInvite (id) { await one(db.from('agent_invites').update({ used_at: null, used_by_agent_id: null }).eq('id', id)) },
    async setInviteAgent (id, agentId) { await one(db.from('agent_invites').update({ used_by_agent_id: agentId }).eq('id', id)) },
    // Check-and-set: only a waiting invite is cancelled.
    async cancelAgentInvite (id) {
      const rows = await one(db.from('agent_invites').update({ cancelled_at: new Date().toISOString() }).eq('id', id).is('used_at', null).is('cancelled_at', null).gt('expires_at', new Date().toISOString()).select('id'))
      return rows.length > 0
    },

    // Agent keys: hashes only.
    async createAgentKeys (k) {
      return rowFrom(await one(db.from('agent_keys')
        .insert(toSnake({ ...k, accessExpiresAt: ts(k.accessExpiresAt), refreshExpiresAt: ts(k.refreshExpiresAt) }))
        .select(AGENT_KEY).single()))
    },
    async agentKeyByAccess (h) { return rowFrom(await one(db.from('agent_keys').select(AGENT_KEY).eq('access_hash', h).maybeSingle())) },
    async agentKeyByRefresh (h) { return rowFrom(await one(db.from('agent_keys').select(AGENT_KEY).eq('refresh_hash', h).maybeSingle())) },
    async listAgentKeys (agentId) { return (await one(db.from('agent_keys').select(AGENT_KEY).eq('agent_id', agentId).order('created_at'))).map(rowFrom) },
    // Check-and-set: a refresh key is spent once, and never after it was revoked.
    async claimRefresh (id) {
      const rows = await one(db.from('agent_keys').update({ refreshed_at: new Date().toISOString() }).eq('id', id).is('refreshed_at', null).is('revoked_at', null).select('id'))
      return rows.length > 0
    },
    async revokeFamily (familyId) {
      await one(db.from('agent_keys').update({ revoked_at: new Date().toISOString() }).eq('family_id', familyId).is('revoked_at', null))
    },
    // Undoes a claim when minting the new pair failed, so the same refresh key can retry.
    async releaseRefresh (id) {
      await one(db.from('agent_keys').update({ refreshed_at: null }).eq('id', id).is('revoked_at', null))
    },
    // Deleting the auth user cascades through profiles, devices, links and agents. Session
    // activity is keyed by 'person:<id>' and 'agent:<id>', not foreign keys, so it goes first.
    async deleteUser (userId) {
      const agents = await one(db.from('agents').select('id').eq('owner_user_id', userId))
      const accounts = [`person:${userId}`, ...agents.map((a) => `agent:${a.id}`)]
      await one(db.rpc('delete_account_access', { p_accounts: accounts }))
      await one(db.rpc('delete_account_activity', { p_accounts: accounts }))
      const { error } = await db.auth.admin.deleteUser(userId)
      if (error) throw error
    },

    // The address a person signs in with, and whether they've confirmed it.
    async userEmail (userId) {
      const { data, error } = await db.auth.admin.getUserById(userId)
      if (error) { if (error.status === 404) return null; throw error }
      const u = data?.user
      return u ? { email: u.email || '', confirmed: !!u.email_confirmed_at } : null
    },

    // Session activity (see 20261002000000_session_activity.sql). Event times are epoch ms.
    async ingestPresence (events, receivedAt) {
      return await one(db.rpc('ingest_presence', { p_events: events, p_received_at: ts(receivedAt) }))
    },
    async accountSessions (account, { since, limit }) {
      return (await pages(() => db.rpc('account_sessions', { p_account: account, p_since: ts(since), p_limit: limit }))).map(rowFrom)
    },
    async sessionByRoom (room) { return rowFrom(await one(db.from('relay_sessions').select(RELAY_SESSION).eq('room', room).maybeSingle())) },
    async visitsInRooms (rooms) {
      if (!rooms.length) return []
      return (await pages(() => db.rpc('visits_in_rooms', { p_rooms: rooms }))).map(rowFrom)
    },
    async renameSession (room, name, at) {
      return rowFrom(await one(db.from('relay_sessions').update({ name, renamed_at: ts(at) }).eq('room', room).select(RELAY_SESSION).maybeSingle()))
    },
    async pruneActivity ({ before, seenBefore }) {
      await one(db.rpc('prune_activity', { p_before: ts(before), p_seen_before: ts(seenBefore) }))
    },

    // Access types, grants and session invites (see 20261002010000_access_types_and_invites.sql).
    async listAccessTypes (ownerAccount) {
      return (await one(db.from('access_types').select(ACCESS_TYPE).eq('owner_account', ownerAccount).order('created_at'))).map(rowFrom)
    },
    async accessTypeById (id) { return rowFrom(await one(db.from('access_types').select(ACCESS_TYPE).eq('id', id).maybeSingle())) },
    async createAccessType ({ ownerAccount, name, files, folders = [], talk = true }) {
      return rowFrom(await one(db.from('access_types').insert({ owner_account: ownerAccount, name, files, folders, talk }).select(ACCESS_TYPE).single()))
    },
    async updateAccessType (id, { name, files, folders, talk }) {
      return rowFrom(await one(db.from('access_types').update(toSnake({ name, files, folders, talk, updatedAt: new Date().toISOString() })).eq('id', id).select(ACCESS_TYPE).maybeSingle()))
    },
    // Its grants and invites fall back to View only, in the same transaction.
    async deleteAccessType (id, ownerAccount) {
      return await one(db.rpc('delete_access_type', { p_id: id, p_owner: ownerAccount }))
    },
    async grantFor (room, account) { return rowFrom(await one(db.from('session_grants').select(GRANT).eq('room', room).eq('account', account).maybeSingle())) },
    async listGrants (room) { return (await one(db.from('session_grants').select(GRANT).eq('room', room).order('created_at'))).map(rowFrom) },
    async putGrant ({ room, account, typeId, tighten = {}, grantedBy }) {
      return rowFrom(await one(db.from('session_grants')
        .upsert({ room, account, type_id: typeId, tighten, granted_by: grantedBy, updated_at: new Date().toISOString() }, { onConflict: 'room,account' })
        .select(GRANT).single()))
    },
    async deleteGrant (room, account) {
      return (await one(db.from('session_grants').delete().eq('room', room).eq('account', account).select('account'))).length > 0
    },
    // One open invite per address or account (a unique index; a second one is a 23505). That
    // key's expired, unused invites go first, so they never block a new one.
    async createSessionInvite ({ room, email = null, account = null, accountName = '', typeId, invitedBy, expiresAt, at = Date.now() }) {
      email = email && email.toLowerCase()
      await one(db.from('session_invites').delete().eq('room', room).eq(email ? 'email' : 'account', email || account)
        .is('used_at', null).is('cancelled_at', null).lte('expires_at', ts(at)))
      return rowFrom(await one(db.from('session_invites')
        .insert({ room, email: email && email.toLowerCase(), account, account_name: accountName, type_id: typeId, invited_by: invitedBy, expires_at: ts(expiresAt) })
        .select(SESSION_INVITE).single()))
    },
    async listSessionInvites (room) {
      return (await one(db.from('session_invites').select(SESSION_INVITE).eq('room', room).order('created_at', { ascending: false }).limit(50))).map(rowFrom)
    },
    async sessionInviteById (room, id) { return rowFrom(await one(db.from('session_invites').select(SESSION_INVITE).eq('room', room).eq('id', id).maybeSingle())) },
    // The open (unused, not cancelled, not expired) invite for an address or account, but `exceptId`.
    async openSessionInvite (room, { email = null, account = null }, at, exceptId = null) {
      let q = db.from('session_invites').select(SESSION_INVITE).eq('room', room).eq(email ? 'email' : 'account', email || account)
        .is('used_at', null).is('cancelled_at', null).gt('expires_at', ts(at))
      if (exceptId) q = q.neq('id', exceptId)
      return rowFrom((await one(q.limit(1)))[0] || null)
    },
    // Check-and-set: only a waiting invite is cancelled.
    async cancelSessionInvite (id) {
      const rows = await one(db.from('session_invites').update({ cancelled_at: new Date().toISOString() }).eq('id', id).is('used_at', null).is('cancelled_at', null).select('id'))
      return rows.length > 0
    },
    // The grant goes unless an open invite for that address or account still needs it (one statement).
    async deleteUnusedGrant (room, account, at) {
      return await one(db.rpc('delete_unused_grant', { p_room: room, p_account: account, p_now: ts(at) }))
    },
    async claimEmailInvites (room, email, account) {
      return await one(db.rpc('claim_email_invites', { p_room: room, p_email: email, p_account: account, p_now: new Date().toISOString() }))
    },
    async useAccountInvites (room, account) {
      const at = new Date().toISOString()
      await one(db.from('session_invites').update({ used_at: at, used_by: account }).eq('room', room).eq('account', account).is('used_at', null).is('cancelled_at', null).gt('expires_at', at))
    },

    // Orgs. create_org makes the org, its three built-in roles and its owner in one
    // transaction. first: true is for "a team" sign-ups, where two tabs (or a double
    // click) can both see no org yet; create_org locks on the owner and hands back
    // whichever org they end up in rather than making a second one.
    async createOrg ({ name, slug, ownerId, grants, first = false }) {
      return rowFrom(await one(db.rpc('create_org', {
        p_name: name, p_slug: slug, p_owner: ownerId, p_owner_grants: grants.owner, p_admin_grants: grants.admin, p_member_grants: grants.member, p_first: first
      })))
    },
    async orgBySlug (slug) { return rowFrom(await one(db.from('orgs').select(ORG).eq('slug', slug).maybeSingle())) },
    async orgById (id) { return rowFrom(await one(db.from('orgs').select(ORG).eq('id', id).maybeSingle())) },
    async orgsForUser (userId) {
      const rows = await one(db.from('org_members').select(`role_id, orgs (${ORG})`).eq('user_id', userId))
      return rows.map((r) => ({ ...rowFrom(r.orgs), roleId: r.role_id })).sort((a, b) => a.name.localeCompare(b.name))
    },
    async orgsByDomain (domain) { return (await one(db.from('orgs').select(ORG).eq('domain', domain).eq('domain_requests', true))).map(rowFrom) },
    async updateOrg (id, { name, domain, domainRequests }) {
      return rowFrom(await one(db.from('orgs').update(toSnake({ name, domain, domainRequests })).eq('id', id).select(ORG).single()))
    },
    // Cascades to roles, members, teams, invites and requests.
    async deleteOrg (id) { await one(db.from('orgs').delete().eq('id', id)) },
    async transferOrg (orgId, fromUserId, toUserId) { await one(db.rpc('transfer_org', { p_org: orgId, p_from: fromUserId, p_to: toUserId })) },

    // Roles.
    async listRoles (orgId) { return (await one(db.from('roles').select(ROLE).eq('org_id', orgId))).map(rowFrom) },
    async roleById (orgId, id) { return rowFrom(await one(db.from('roles').select(ROLE).eq('org_id', orgId).eq('id', id).maybeSingle())) },
    async createRole ({ orgId, name, grants }) {
      return rowFrom(await one(db.from('roles').insert({ org_id: orgId, name, grants }).select(ROLE).single()))
    },
    async updateRole (id, { name, grants }) {
      return rowFrom(await one(db.from('roles').update(toSnake({ name, grants })).eq('id', id).select(ROLE).single()))
    },
    // Closed invites (accepted, cancelled or expired) are cleared first, since
    // org_invites.role_id is NO ACTION, not cascade; an open invite still makes
    // the role delete fail with Postgres's 23503, which `one` rethrows as-is.
    async deleteRole (id) {
      await one(db.from('org_invites').delete().eq('role_id', id)
        .or(`accepted_at.not.is.null,cancelled_at.not.is.null,expires_at.lte.${new Date().toISOString()}`))
      await one(db.from('roles').delete().eq('id', id))
    },
    // In use: someone holds it, or an open (not accepted, not cancelled, not
    // expired) invite would hand it out — the same definition deleteRole uses.
    async roleInUse (id) {
      if ((await one(db.from('org_members').select('id').eq('role_id', id).limit(1))).length) return true
      return (await one(db.from('org_invites').select('id').eq('role_id', id)
        .is('accepted_at', null).is('cancelled_at', null).gt('expires_at', new Date().toISOString()).limit(1))).length > 0
    },

    // Members.
    memberOf,
    async memberById (orgId, id) { return rowFrom(await one(db.from('org_members').select(MEMBER).eq('org_id', orgId).eq('id', id).maybeSingle())) },
    // A member is a person (profiles) or an agent (agents); each row embeds whichever it is.
    async listMembers (orgId) {
      const rows = await one(db.from('org_members').select(`${MEMBER}, profiles (name), agents (name, provider, type, public_key)`).eq('org_id', orgId).order('joined_at'))
      return rows.map(({ profiles, agents, ...r }) => ({ ...rowFrom(r), name: profiles?.name || agents?.name || '', provider: agents?.provider ?? null, type: agents?.type ?? null, publicKey: agents?.public_key ?? null }))
    },
    // Already a member: the upsert does nothing and we return the existing row.
    async addMember ({ orgId, userId, roleId }) {
      const row = await one(db.from('org_members')
        .upsert({ org_id: orgId, user_id: userId, role_id: roleId }, { onConflict: 'org_id,user_id', ignoreDuplicates: true })
        .select(MEMBER).maybeSingle())
      return row ? rowFrom(row) : memberOf(orgId, userId)
    },
    async setMemberRole (id, roleId) { return rowFrom(await one(db.from('org_members').update({ role_id: roleId }).eq('id', id).select(MEMBER).single())) },
    // Cascades to the member's team memberships.
    async removeMember (id) { await one(db.from('org_members').delete().eq('id', id)) },
    // The composite (agent_id, org_id) foreign key keeps other orgs' and personal agents out.
    async addAgentMember ({ orgId, agentId, roleId = null }) {
      return rowFrom(await one(db.from('org_members').insert({ org_id: orgId, agent_id: agentId, role_id: roleId }).select(MEMBER).single()))
    },
    async memberByAgent (orgId, agentId) { return rowFrom(await one(db.from('org_members').select(MEMBER).eq('org_id', orgId).eq('agent_id', agentId).maybeSingle())) },

    // Teams.
    async listTeams (orgId) { return (await one(db.from('teams').select(TEAM).eq('org_id', orgId).order('name'))).map(rowFrom) },
    async teamById (orgId, id) { return rowFrom(await one(db.from('teams').select(TEAM).eq('org_id', orgId).eq('id', id).maybeSingle())) },
    async createTeam ({ orgId, name }) { return rowFrom(await one(db.from('teams').insert({ org_id: orgId, name }).select(TEAM).single())) },
    async renameTeam (id, name) { return rowFrom(await one(db.from('teams').update({ name }).eq('id', id).select(TEAM).single())) },
    async deleteTeam (id) { await one(db.from('teams').delete().eq('id', id)) },
    async listTeamMembers (teamId) {
      const rows = await one(db.from('team_members').select(`${TEAM_MEMBER}, org_members (user_id, agent_id, profiles (name), agents (name))`).eq('team_id', teamId).order('added_at'))
      return rows.map(({ org_members: m, ...r }) => ({ ...rowFrom(r), name: m?.profiles?.name || m?.agents?.name || '', kind: m?.agent_id ? 'agent' : 'person' }))
    },
    async teamsOfMember (memberId) {
      return (await one(db.from('team_members').select('team_id, access, scopes').eq('member_id', memberId))).map((r) => ({ teamId: r.team_id, access: r.access, scopes: r.scopes || [] }))
    },
    // team_members.org_id is not null (composite FKs to teams(id, org_id) and
    // org_members(id, org_id)), so look the team's org up first and stamp it
    // on the upsert; a missing team fails the same way the real FK would.
    async addTeamMember ({ teamId, memberId, access, scopes = [] }) {
      const team = await one(db.from('teams').select('org_id').eq('id', teamId).maybeSingle())
      if (!team) throw fkViolation('team')
      return rowFrom(await one(db.from('team_members')
        .upsert({ team_id: teamId, member_id: memberId, access, scopes, org_id: team.org_id }, { onConflict: 'team_id,member_id' })
        .select(TEAM_MEMBER).single()))
    },
    // Folders only change when given, so an access-only change keeps them.
    async setTeamAccess (teamId, memberId, access, scopes) {
      return rowFrom(await one(db.from('team_members').update(scopes === undefined ? { access } : { access, scopes })
        .eq('team_id', teamId).eq('member_id', memberId).select(TEAM_MEMBER).maybeSingle()))
    },
    async removeTeamMember (teamId, memberId) {
      return (await one(db.from('team_members').delete().eq('team_id', teamId).eq('member_id', memberId).select('team_id'))).length > 0
    },

    // Invites: only the token's hash is stored. org_invites.email must be
    // lowercase (a check constraint), matching the invite flow's
    // case-insensitive match on the invitee's confirmed email.
    async createInvite (i) {
      return rowFrom(await one(db.from('org_invites').insert(toSnake({ ...i, email: i.email.toLowerCase(), expiresAt: ts(i.expiresAt) })).select(INVITE).single()))
    },
    async inviteByToken (h) { return rowFrom(await one(db.from('org_invites').select(INVITE).eq('token_hash', h).maybeSingle())) },
    async inviteById (orgId, id) { return rowFrom(await one(db.from('org_invites').select(INVITE).eq('org_id', orgId).eq('id', id).maybeSingle())) },
    async listInvites (orgId) {
      return (await one(db.from('org_invites').select(INVITE).eq('org_id', orgId).is('accepted_at', null).is('cancelled_at', null).order('created_at'))).map(rowFrom)
    },
    async updateInvite (id, patch) {
      return rowFrom(await one(db.from('org_invites').update(toSnake({ ...patch, expiresAt: ts(patch.expiresAt), cancelledAt: ts(patch.cancelledAt) })).eq('id', id).select(INVITE).single()))
    },
    // Check-and-set, so one invite can't be accepted twice, after it was
    // cancelled, or once it's expired — mirrors roleInUse's open-invite definition.
    async claimInvite (id) {
      const rows = await one(db.from('org_invites').update({ accepted_at: new Date().toISOString() }).eq('id', id)
        .is('accepted_at', null).is('cancelled_at', null).gt('expires_at', new Date().toISOString()).select('id'))
      return rows.length > 0
    },

    // Domain join requests: the partial unique index (join_requests_one_pending)
    // keeps one pending per person per org. The fast-path select below is only
    // that — a fast path — since two concurrent calls can both pass it; the
    // insert is what's race-safe: if it loses the race, its 23505 means someone
    // else's row won, so re-select and hand that one back instead of throwing.
    // join_requests.email must be lowercase (a check constraint).
    async createJoinRequest ({ orgId, userId, email }) {
      const pending = await one(db.from('join_requests').select(REQUEST).eq('org_id', orgId).eq('user_id', userId).eq('status', 'pending').maybeSingle())
      if (pending) return rowFrom(pending)
      try {
        return rowFrom(await one(db.from('join_requests').insert({ org_id: orgId, user_id: userId, email: email.toLowerCase() }).select(REQUEST).single()))
      } catch (err) {
        if (err.code !== '23505') throw err
        return rowFrom(await one(db.from('join_requests').select(REQUEST).eq('org_id', orgId).eq('user_id', userId).eq('status', 'pending').maybeSingle()))
      }
    },
    async joinRequestById (orgId, id) { return rowFrom(await one(db.from('join_requests').select(REQUEST).eq('org_id', orgId).eq('id', id).maybeSingle())) },
    async listJoinRequests (orgId) {
      const rows = await one(db.from('join_requests').select(`${REQUEST}, profiles (name)`).eq('org_id', orgId).eq('status', 'pending').order('created_at'))
      return rows.map(({ profiles, ...r }) => ({ ...rowFrom(r), name: profiles?.name || '' }))
    },
    async joinRequestsForUser (userId) { return (await one(db.from('join_requests').select(REQUEST).eq('user_id', userId))).map(rowFrom) },
    // Check-and-set: a request is decided once.
    async decideJoinRequest (id, { status, decidedBy }) {
      const rows = await one(db.from('join_requests').update({ status, decided_by: decidedBy, decided_at: new Date().toISOString() }).eq('id', id).eq('status', 'pending').select('id'))
      return rows.length > 0
    },
    // Issue reports: one rpc per batch (record_events opens or counts up issues itself).
    async recordEvents (list) {
      if (!list.length) return 0
      const events = list.map((e) => ({ ...toSnake({ ...e, occurredAt: ts(e.occurredAt) }), fingerprint: e.fingerprint ?? null, status: e.status ?? null, duration_ms: e.durationMs ?? null, user_id: e.userId ?? null, device_id: e.deviceId ?? null }))
      return (await one(db.rpc('record_events', { events }))) ?? list.length
    },
    async pruneEvents (before) {
      await one(db.from('events').delete().lt('occurred_at', ts(before)))
      return 0
    },
    async pruneIssues (before) {
      await one(db.from('issues').delete().lt('last_seen_at', ts(before)))
      return 0
    }
  }
}
