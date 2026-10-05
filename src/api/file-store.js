// Where workspace files' bytes live. The API only hands out short-lived links: apps upload
// and download straight to storage (Supabase) or, without storage settings, to the API's
// own disk through signed links the API serves itself.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

export const LINK_MS = 10 * 60 * 1000
const KEY = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/\d+$/

const checkKey = (key) => { if (!KEY.test(String(key))) throw new Error('not a storage key'); return key }

/** Files on the API's disk, reached through HMAC-signed links the API serves (tests, --memory, self-hosting). */
export class DiskStore {
  constructor (dir, { now = Date.now, signing = crypto.randomBytes(32) } = {}) {
    this.dir = dir
    this.now = now
    this.signing = signing
  }

  file (key) { return path.join(this.dir, ...checkKey(key).split('/')) }

  sign (key, method, exp, size) {
    return crypto.createHmac('sha256', this.signing).update(`${method} ${key} ${exp} ${size ?? ''}`).digest('hex')
  }

  verify (key, method, exp, sig, size) {
    if (!KEY.test(String(key)) || !(Number(exp) > this.now())) return false
    const want = Buffer.from(this.sign(key, method, exp, size), 'hex')
    const got = Buffer.from(String(sig || ''), 'hex')
    return got.length === want.length && crypto.timingSafeEqual(got, want)
  }

  async uploadTarget (key, size) {
    checkKey(key)
    const exp = this.now() + LINK_MS
    return { method: 'PUT', url: `/v1/file-data/${key}?m=PUT&exp=${exp}&sig=${this.sign(key, 'PUT', exp, size)}&n=${size}`, headers: {} }
  }

  async downloadTarget (key, { name = '', type = '' } = {}) {
    checkKey(key)
    const exp = this.now() + LINK_MS
    const q = new URLSearchParams({ m: 'GET', exp: String(exp), sig: this.sign(key, 'GET', exp), name, type })
    return { url: `/v1/file-data/${key}?${q}` }
  }

  async exists (key) {
    try { return { size: fs.statSync(this.file(key)).size } } catch { return null }
  }

  async remove (keys) { for (const k of keys) fs.rmSync(this.file(k), { force: true }) }
}

/** Files in a private Supabase Storage bucket in the Quilt Files project. */
export class SupabaseStore {
  constructor ({ url, key, bucket, client }) {
    const c = client || createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
    this.bucket = c.storage.from(bucket)
  }

  async uploadTarget (key, size) {
    const { data, error } = await this.bucket.createSignedUploadUrl(checkKey(key), { upsert: false })
    if (error) throw new Error(`storage: ${error.message}`)
    return { method: 'PUT', url: data.signedUrl, headers: {} }
  }

  async downloadTarget (key, { name = '', type = '' } = {}) {
    const { data, error } = await this.bucket.createSignedUrl(checkKey(key), LINK_MS / 1000, name ? { download: name } : {})
    if (error) throw new Error(`storage: ${error.message}`)
    return { url: data.signedUrl }
  }

  async exists (key) {
    checkKey(key)
    const prefix = key.slice(0, key.lastIndexOf('/'))
    const leaf = key.slice(key.lastIndexOf('/') + 1)
    const { data, error } = await this.bucket.list(prefix, { limit: 100, search: leaf })
    if (error) throw new Error(`storage: ${error.message}`)
    const hit = (data || []).find((f) => f.name === leaf)
    return hit ? { size: Number(hit.metadata?.size || 0) } : null
  }

  async remove (keys) {
    if (!keys.length) return
    const { error } = await this.bucket.remove(keys.map(checkKey))
    if (error) throw new Error(`storage: ${error.message}`)
  }
}

export function makeFileStore (cfg, dir) {
  if (!cfg.storageUrl !== !cfg.storageKey) throw new Error('Workspace file storage is half set up: set both QUILT_STORAGE_URL and QUILT_STORAGE_KEY to use Supabase Storage, or neither to keep files on this server\'s disk.')
  if (cfg.storageUrl && cfg.storageKey) return new SupabaseStore({ url: cfg.storageUrl, key: cfg.storageKey, bucket: cfg.storageBucket || 'workspace-files' })
  return new DiskStore(dir)
}
