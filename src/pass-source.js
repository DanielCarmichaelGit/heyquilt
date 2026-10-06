// Session passes from the accounts API. A pass proves who you are to the relay
// for 10 minutes. Clients keep one until 2 minutes before it runs out, and while
// connected they fetch a fresh one every 5 minutes (see connection.js). A session
// asks for passes for its own room: those carry what you may do there.
import { readPass } from './passes.js'
import { apiUrl, accountFile, readAccount, resumeAccount, NOT_SIGNED_IN, SIGNED_OUT } from './account.js'
import { agentAccess, readAgent } from './agent-join.js'

export const PASS_EARLY_MS = 2 * 60 * 1000
export const PASS_REFRESH_MS = 5 * 60 * 1000
// A pass request with no answer gives up after this, so the retry runs: right after a computer
// wakes, the network may be gone for a while and the system's own timeout can take minutes.
// Passes are cheap to ask for again, unlike an agent's key refresh.
export const PASS_TIMEOUT_MS = 10 * 1000
const AGENT_SIGNED_OUT = "This agent's keys stopped working. Invite it again."

/** The API turned the token away: this computer (or agent) is signed out for good. */
export class SignedOutError extends Error {
  constructor (message) {
    super(message)
    this.signedOut = true
  }
}

export class PassSource {
  /** `fetchPass(room)` resolves to { pass, expiresAt }; `room` is '' for a pass that isn't for one room. */
  constructor ({ fetchPass, now = Date.now, earlyMs = PASS_EARLY_MS, room = '' }) {
    this.fetchPass = fetchPass
    this.now = now
    this.earlyMs = earlyMs
    this.room = room
    this.rooms = new Map() // room -> PassSource, for forRoom
    this.current = null // { pass, expiresAt, payload }
    this.pending = null
  }

  /** The same account's passes for one room (kept, one per room). They carry its access there. */
  forRoom (room) {
    if (!room || room === this.room) return this
    if (!this.rooms.has(room)) this.rooms.set(room, new PassSource({ fetchPass: this.fetchPass, now: this.now, earlyMs: this.earlyMs, room }))
    return this.rooms.get(room)
  }

  /** A pass with at least `earlyMs` left, fetching one when needed. */
  get () {
    if (this.current && this.now() < this.current.expiresAt - this.earlyMs) return Promise.resolve(this.current.pass)
    return this.fresh()
  }

  /** Always asks for a new pass. Calls made while one is on its way share it. */
  fresh () {
    if (!this.pending) {
      this.pending = Promise.resolve()
        .then(() => this.fetchPass(this.room))
        .then(({ pass, expiresAt }) => {
          this.current = { pass, expiresAt, payload: readPass(pass) }
          return pass
        })
        .finally(() => { this.pending = null })
    }
    return this.pending
  }

  /**
   * A pass issued after this call. One already on its way may have been issued before
   * something changed (the relay asking for a fresh pass after the owner changed our
   * access): wait for it, then ask again.
   */
  newer () {
    return this.pending ? this.pending.catch(() => {}).then(() => this.fresh()) : this.fresh()
  }

  /** Forgets the cached pass (the relay turned it away), so the next get() fetches one. */
  forget () {
    this.current = null
  }

  /** Who the passes are for ({ sub, kind, name, key, … }), once one has been fetched. */
  get payload () {
    return this.current ? this.current.payload : null
  }
}

async function requestPass (fetchImpl, api, bearer, signedOutMessage, room = '', timeoutMs = PASS_TIMEOUT_MS) {
  let res
  try {
    const body = room ? { headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify({ room }) } : { headers: { authorization: `Bearer ${bearer}` } }
    res = await fetchImpl(`${String(api).replace(/\/+$/, '')}/v1/passes`, { method: 'POST', ...body, signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    throw new Error(`Couldn't reach Quilt (${err.name === 'TimeoutError' ? 'ETIMEDOUT' : err.cause?.code || err.message}).`)
  }
  const body = await res.json().catch(() => null)
  if (res.status === 401) throw new SignedOutError(signedOutMessage)
  if (!res.ok || !body || typeof body.pass !== 'string') throw Object.assign(new Error(body?.error || `Quilt answered ${res.status}.`), { status: res.status })
  return body
}

/**
 * Passes for this computer's account, from its qd_ token. A token turned away isn't the
 * end: another app on this computer may have signed in again since (its token is in
 * account.json), or the computer signs back in with its key. Only a computer that's no
 * longer linked gets SignedOutError.
 */
export function personPasses ({ token, api = apiUrl(), fetch: fetchImpl = globalThis.fetch, now, file = accountFile(), resume = resumeAccount, timeoutMs } = {}) {
  let current = token
  // Whose sign-in this is: a sign-in for someone else since (a different account) doesn't carry on these passes.
  const first = readAccount(file)
  const who = first && first.token === token ? first.account.id : null
  const same = (a) => a && (!who || a.account.id === who)
  return new PassSource({
    now,
    fetchPass: async (room) => {
      try {
        return await requestPass(fetchImpl, api, current, SIGNED_OUT, room, timeoutMs)
      } catch (err) {
        if (!err.signedOut) throw err
        const saved = readAccount(file)
        if (saved && saved.token !== current) {
          if (!same(saved)) throw err
          current = saved.token
        } else {
          const back = await resume({ api, fetch: fetchImpl, file })
          if (!same(back)) throw err
          current = back.token
        }
        return requestPass(fetchImpl, api, current, SIGNED_OUT, room, timeoutMs)
      }
    }
  })
}

/** Passes for a saved agent, from its access key (refreshed with its refresh key when it runs out). */
export function agentPasses ({ name, dir, fetch: fetchImpl = globalThis.fetch, now } = {}) {
  return new PassSource({
    now,
    fetchPass: async (room) => {
      let saved
      try {
        saved = await agentAccess({ name, dir, fetch: fetchImpl, now })
      } catch (err) {
        if (err.status === 401) throw new SignedOutError(err.message)
        throw err
      }
      return requestPass(fetchImpl, saved.api, saved.accessKey, AGENT_SIGNED_OUT, room)
    }
  })
}

/**
 * What a session started here signs in with: a saved agent's passes and key, or
 * this computer's account. `name` is the name saved on this computer, so a
 * session can start before (or without, when offline) its first pass.
 */
export function sessionPasses ({ agent = null, dir } = {}) {
  if (agent) {
    const saved = readAgent({ name: agent, dir })
    return { passes: agentPasses({ name: agent, dir }), identity: saved.identity, kind: 'agent', name: saved.name || agent }
  }
  const account = readAccount()
  if (!account) throw new Error(NOT_SIGNED_IN)
  return { passes: personPasses({ token: account.token }), identity: null, kind: 'human', name: account.account.name || null }
}
