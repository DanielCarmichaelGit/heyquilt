// Webhooks: an agent asks to be told, by an HTTP POST to a URL of its own, when
// it is mentioned in chat (@name), sent a direct message, or handed a task. The
// agent sets the subscription itself (quilt_webhook_subscribe), so a cloud agent
// with a routine behind a webhook trigger wakes up instead of polling quilt_inbox.
//
// One POST per event, JSON, signed with the subscription's secret so the agent can
// check it came from Quilt (`x-quilt-signature: sha256=<hmac>` over `<ts>.<body>`).
// A failed delivery is tried again a few times; after that the event is still in
// quilt_inbox, which never depends on the webhook.
//
// The pure parts (shapes, signing, validation) are shared by the relay, which
// delivers for hosted agents, and the local session, which delivers for agents
// joined from a computer.
import crypto from 'node:crypto'

export const WEBHOOK_EVENTS = ['chat.mention', 'chat.dm', 'task.assigned']
export const EVENT_OF_KIND = { mention: 'chat.mention', dm: 'chat.dm', task: 'task.assigned' }
export const MAX_URL = 2000
export const MAX_SECRET = 200
export const MIN_SECRET = 16
export const MAX_BEARER = 500
export const DELIVERY_TIMEOUT_MS = 10_000
// Waits before the second, third and fourth tries.
export const RETRY_DELAYS_MS = [1000, 5000, 25_000]

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])
const isPrivateIp = (host) => {
  const h = host.replace(/^\[|\]$/g, '')
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split('.').map(Number)
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  }
  if (h.includes(':')) return /^(::1|::|fc|fd|fe80)/i.test(h)
  return false
}

/**
 * The URL a subscription may POST to: https, no credentials, and not the relay's own
 * network. `allowLocal` (the local session) also takes http to this computer, for an
 * agent whose receiver runs here.
 */
export function parseWebhookUrl (raw, { allowLocal = false } = {}) {
  const s = String(raw || '').trim()
  if (!s) throw new Error('Give the URL Quilt should POST to.')
  if (s.length > MAX_URL) throw new Error('That URL is too long.')
  let u
  try { u = new URL(s) } catch { throw new Error('That is not a valid URL.') }
  if (u.username || u.password) throw new Error('The URL may not carry a user name or password.')
  const host = u.hostname.toLowerCase()
  const local = LOCAL_HOSTS.has(host) || host.endsWith('.localhost') || isPrivateIp(host)
  if (u.protocol === 'http:') {
    if (!allowLocal || !local) throw new Error('The URL must use https (http is only for a receiver on this computer).')
  } else if (u.protocol !== 'https:') {
    throw new Error('The URL must start with https://.')
  } else if (local && !allowLocal) {
    throw new Error('The URL must be reachable from the internet, not a local or private address.')
  }
  return u.toString()
}

/** The event names in `list` (default: all), or an error naming a bad one. */
export function parseWebhookEvents (list) {
  if (list == null) return WEBHOOK_EVENTS.slice()
  if (!Array.isArray(list)) throw new Error(`events: give a list of ${WEBHOOK_EVENTS.join(', ')}.`)
  const out = []
  for (const e of list) {
    const n = String(e || '').trim()
    if (!WEBHOOK_EVENTS.includes(n)) throw new Error(`Unknown event "${n}". Events: ${WEBHOOK_EVENTS.join(', ')}.`)
    if (!out.includes(n)) out.push(n)
  }
  if (!out.length) throw new Error(`events: give at least one of ${WEBHOOK_EVENTS.join(', ')}.`)
  return out
}

export const newSecret = () => crypto.randomBytes(24).toString('hex')

/**
 * A subscription from what an agent gave: { url, secret, events, since }. A secret the
 * agent chose is kept (16 to 200 characters); without one, a new one is made and the
 * agent is shown it once, in the tool's answer.
 */
export function makeSubscription ({ url, secret, events, bearer } = {}, { allowLocal = false, now = Date.now } = {}) {
  const u = parseWebhookUrl(url, { allowLocal })
  const ev = parseWebhookEvents(events)
  let s = secret == null ? '' : String(secret)
  if (s && (s.length < MIN_SECRET || s.length > MAX_SECRET)) throw new Error(`The secret must be ${MIN_SECRET} to ${MAX_SECRET} characters (or leave it out and Quilt makes one).`)
  const made = !s
  if (made) s = newSecret()
  // A key the receiver wants on every POST (a Grok Bot routine's sender key, for example), sent as Authorization: Bearer <key>.
  const b = bearer == null ? '' : String(bearer).trim()
  if (b.length > MAX_BEARER || /[\r\n]/.test(b)) throw new Error(`The bearer key must be one line of at most ${MAX_BEARER} characters.`)
  return { url: u, secret: s, events: ev, since: now(), made, ...(b ? { bearer: b } : {}) }
}

/** The subscription as an agent sees it (its secret only when it was just made). */
export function describeSubscription (sub, { showSecret = false } = {}) {
  if (!sub) return 'No webhook: Quilt only answers quilt_inbox when you ask.'
  const lines = [`Webhook: Quilt POSTs to ${sub.url} on ${sub.events.join(', ')}${sub.bearer ? ', with your bearer key in the Authorization header' : ''}.`]
  if (showSecret) lines.push(`Secret (shown once; check x-quilt-signature with it): ${sub.secret}`)
  lines.push('Each POST is JSON ({ event, id, room, to, by, text, ts, task? }) with x-quilt-event, x-quilt-delivery, x-quilt-timestamp and ' +
    'x-quilt-signature: sha256=HMAC-SHA256(secret, "<timestamp>.<body>"). Answer 2xx quickly; a failed POST is retried a few times. ' +
    'What you are told is still in quilt_inbox. Stop with quilt_webhook_unsubscribe.')
  return lines.join('\n')
}

/** The body for one inbox event (see inbox.js) to `to`, in `room`. */
export function webhookPayload (e, { room = '', to = '' } = {}) {
  const p = { event: EVENT_OF_KIND[e.kind] || e.kind, id: String(e.id || ''), room, to, by: String(e.by || ''), text: String(e.text || ''), ts: Number(e.ts) || Date.now() }
  if (e.kind === 'task' && e.task) p.task = { id: e.task.id, title: e.task.title, column: e.task.column, assignee: e.task.assignee ?? null, forAi: !!e.task.forAi, tool: e.task.tool || '', files: e.task.files || [] }
  return p
}

/** `sha256=<hex>`: HMAC-SHA256 with `secret` over `<ts>.<body>`. */
export function signWebhook (secret, ts, body) {
  return 'sha256=' + crypto.createHmac('sha256', String(secret)).update(`${ts}.${body}`).digest('hex')
}

/** For receivers: whether `signature` is right for this body and timestamp. */
export function verifyWebhook (secret, ts, body, signature) {
  const want = Buffer.from(signWebhook(secret, ts, body))
  const got = Buffer.from(String(signature || ''))
  return want.length === got.length && crypto.timingSafeEqual(want, got)
}

/** Whether a response means "try again later". */
const retryable = (status) => status === 408 || status === 429 || status >= 500

/**
 * POSTs `payload` to `sub.url`, signed, trying again after each delay in `delays` when
 * the receiver is down, slow or answers 5xx/429. Resolves { ok, status, attempts, error? };
 * never throws. `fetch`, `delays` and `sleep` are for tests.
 */
export async function deliverWebhook (sub, payload, { fetch = globalThis.fetch, delays = RETRY_DELAYS_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs = DELIVERY_TIMEOUT_MS, now = Date.now, log = () => {} } = {}) {
  const body = JSON.stringify(payload)
  const delivery = crypto.randomUUID()
  let status = 0
  let error = ''
  let attempt = 0
  while (attempt < delays.length + 1) {
    attempt++
    const ts = String(now())
    try {
      const res = await fetch(sub.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'quilt-webhook',
          'x-quilt-event': payload.event,
          'x-quilt-delivery': delivery,
          'x-quilt-timestamp': ts,
          'x-quilt-signature': signWebhook(sub.secret, ts, body),
          ...(sub.bearer ? { authorization: `Bearer ${sub.bearer}` } : {})
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs)
      })
      status = res.status
      error = ''
      if (res.ok) return { ok: true, status, attempts: attempt, delivery }
      if (!retryable(status)) break
    } catch (err) {
      status = 0
      error = err && err.message ? err.message : String(err)
    }
    if (attempt <= delays.length) await sleep(delays[attempt - 1])
  }
  log(`webhook to ${sub.url} failed (${payload.event}): ${error || `HTTP ${status}`}`)
  return { ok: false, status, attempts: attempt, error: error || `HTTP ${status}`, delivery }
}

/** Delivers each of `events` the subscription asks for, one after another (order kept). */
export async function deliverEvents (sub, events, { room = '', to = '' } = {}, opts = {}) {
  const out = []
  for (const e of events || []) {
    const p = webhookPayload(e, { room, to })
    if (!sub.events.includes(p.event)) continue
    out.push(await deliverWebhook(sub, p, opts))
  }
  return out
}
