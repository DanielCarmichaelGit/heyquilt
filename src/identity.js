// Per-person identity: an Ed25519 key pair kept in ~/.quilt/identity.json.
// The relay ties each name in a room to the first key that used it, and
// checks a signature on every connect, so nobody can act under someone
// else's name (for example to fake or release their claims).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { quiltHome } from './legacy.js'

const AUTH_CONTEXT = 'cowove-auth-v1'
// Linking a computer to an account signs the device code in a context of its own,
// so a signature made to link a computer can never be replayed to join a session,
// and a relay can never collect one by posing as a session.
const DEVICE_LINK_CONTEXT = 'quilt-device-link-v1'
// Signing a linked computer back in (a new token, no browser) has its own context too.
const DEVICE_RESUME_CONTEXT = 'quilt-device-resume-v1'
// An agent on a computer proves it holds the key it joined with, to get new keys (agent-join.js).
const AGENT_RESUME_CONTEXT = 'quilt-agent-resume-v1'
// The room name device links used to be signed for. The relay client refuses it.
export const RESERVED_ROOM = 'device-link'

export const identityFile = () => path.join(quiltHome(), 'identity.json')

export function generateIdentity () {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url')
  }
}

/** Loads this machine's identity, creating it on first use. */
export function loadIdentity (file = identityFile()) {
  try {
    const id = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (id.publicKey && id.privateKey) return id
  } catch {}
  const id = generateIdentity()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(id), { mode: 0o600 })
  return id
}

const privateKeyOf = (identity) => crypto.createPrivateKey({ key: Buffer.from(identity.privateKey, 'base64url'), format: 'der', type: 'pkcs8' })
const payload = (room, nonce) => Buffer.concat([Buffer.from(`${AUTH_CONTEXT}\0${room}\0`), Buffer.from(nonce)])

export function signChallenge (identity, room, nonce) {
  if (room === RESERVED_ROOM) throw new Error(`"${RESERVED_ROOM}" is not a session name`)
  return new Uint8Array(crypto.sign(null, payload(room, nonce), privateKeyOf(identity)))
}

/** Parses a public key sent by a client; null unless it's a valid Ed25519 key. */
export function parsePublicKey (b64) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(String(b64), 'base64url'), format: 'der', type: 'spki' })
    return key.asymmetricKeyType === 'ed25519' ? key : null
  } catch { return null }
}

export function verifyChallenge (key, room, nonce, signature) {
  try { return crypto.verify(null, payload(room, nonce), key, Buffer.from(signature)) } catch { return false }
}

const linkPayload = (deviceCode) => Buffer.from(`${DEVICE_LINK_CONTEXT}\0${deviceCode}`)

/** Proves this computer holds its key when it collects its account token. Returns base64url. */
export function signDeviceLink (identity, deviceCode) {
  return crypto.sign(null, linkPayload(String(deviceCode)), privateKeyOf(identity)).toString('base64url')
}

export function verifyDeviceLink (key, deviceCode, signature) {
  if (!key || typeof signature !== 'string') return false
  try { return crypto.verify(null, linkPayload(String(deviceCode)), key, Buffer.from(signature, 'base64url')) } catch { return false }
}

const resumePayload = (at) => Buffer.from(`${DEVICE_RESUME_CONTEXT}\0${Number(at)}`)

/** Proves this computer holds its key when it asks for a new token at time `at` (ms). Returns base64url. */
export function signDeviceResume (identity, at) {
  return crypto.sign(null, resumePayload(at), privateKeyOf(identity)).toString('base64url')
}

export function verifyDeviceResume (key, at, signature) {
  if (!key || typeof signature !== 'string') return false
  try { return crypto.verify(null, resumePayload(at), key, Buffer.from(signature, 'base64url')) } catch { return false }
}

const agentResumePayload = (agentId, at) => Buffer.from(`${AGENT_RESUME_CONTEXT}\0${agentId}\0${Number(at)}`)

/** Proves an agent holds the key it joined with when it asks for new keys at time `at` (ms). Returns base64url. */
export function signAgentResume (identity, agentId, at) {
  return crypto.sign(null, agentResumePayload(String(agentId), at), privateKeyOf(identity)).toString('base64url')
}

export function verifyAgentResume (key, agentId, at, signature) {
  if (!key || typeof signature !== 'string') return false
  try { return crypto.verify(null, agentResumePayload(String(agentId), at), key, Buffer.from(signature, 'base64url')) } catch { return false }
}
