// Webhooks for hosted agents, delivered by the relay: it holds every hosted agent's
// subscription (in hosted-agents.json, beside which session the agent is in), watches
// each room's chat and task board, and POSTs to the agent when it is mentioned, sent a
// direct message or handed a task (see webhooks.js). Delivery from the relay works
// even when the agent itself is asleep, which is the point: its webhook wakes it.
//
// Each subscription keeps its own inbox state (what it has already been told), separate
// from quilt_inbox's, so a POSTed event still shows there when the agent asks.
import { scanInbox } from './inbox.js'
import { readTasks } from './tasks.js'
import { deliverEvents, makeSubscription } from './webhooks.js'

/** The chat `me` can see: public messages, and direct ones to or from them. */
const chatFor = (doc, me) => doc.getArray('chat').toArray().filter((m) => m && m.id && (!m.to || m.to === me || m.by === me))

const scan = (doc, name, state) => scanInbox({ messages: chatFor(doc, name), tasks: readTasks(doc.getMap('tasks')), reader: { name, asAi: false, agent: true } }, state)

/**
 * `hosted` is the relay's map of hosted agents (account id -> { room, ..., webhook? });
 * `saveHosted` writes it. `fetch` and `delays` are for tests.
 */
export function hostedWebhooks ({ hosted, saveHosted, log = () => {}, fetch, delays } = {}) {
  const sending = new Map() // account -> the delivery in flight, so one agent's POSTs keep their order
  const watched = new WeakSet()
  const opts = { log, ...(fetch ? { fetch } : {}), ...(delays ? { delays } : {}) }

  /** Looks for new events in `room` for every subscribed hosted agent in it, and POSTs them. */
  const check = (room) => {
    let changed = false
    for (const [account, h] of hosted) {
      const sub = h && h.webhook
      if (!sub || h.room !== room.name) continue
      // Only a member gets told: an agent still waiting to be let in sees nothing yet.
      if (room.controlled && !room.meta.members[account]) continue
      const r = scan(room.doc, sub.name, sub.state)
      sub.state = r.state
      changed = true
      if (!r.events.length) continue
      const events = r.events
      const prev = sending.get(account) || Promise.resolve()
      const next = prev.then(() => deliverEvents(sub, events, { room: room.name, to: sub.name }, opts)).catch(() => {})
      sending.set(account, next)
      next.then(() => { if (sending.get(account) === next) sending.delete(account) })
    }
    if (changed) saveHosted()
  }

  /** Watches a room's chat and board; safe to call more than once for the same room. */
  const watch = (room) => {
    if (watched.has(room)) return
    watched.add(room)
    const run = () => { try { check(room) } catch (err) { log(`[${room.name}] webhooks: ${err.message}`) } }
    room.doc.getArray('chat').observe(run)
    room.doc.getMap('tasks').observeDeep(run)
  }

  /**
   * Makes `account` (named `name`, in `room`) a subscription from what the agent gave,
   * taking stock of the room so nothing already there is POSTed. Returns it.
   */
  const subscribe = (account, { name, room }, given) => {
    const h = hosted.get(account)
    if (!h) throw new Error('not in a session')
    const sub = makeSubscription(given)
    h.webhook = { url: sub.url, secret: sub.secret, events: sub.events, since: sub.since, name, state: scan(room.doc, name, null).state, ...(sub.bearer ? { bearer: sub.bearer } : {}) }
    saveHosted()
    return { ...h.webhook, made: sub.made }
  }

  /** Keeps a subscription when the agent joins a session (again), taking stock of the new room. */
  const rejoin = (sub, { name, room }) => sub ? { ...sub, name, state: scan(room.doc, name, null).state } : undefined

  const unsubscribe = (account) => {
    const h = hosted.get(account)
    const had = !!(h && h.webhook)
    if (had) { delete h.webhook; saveHosted() }
    return had
  }

  /** Waits for every POST in flight (tests, shutdown). */
  const idle = () => Promise.all([...sending.values()])

  return { check, watch, subscribe, rejoin, unsubscribe, idle }
}
