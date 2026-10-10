// Every module the UI imports must be on the UI server's static allowlist, or the
// import answers 401 and the whole page fails to load (it happened: tool-logo.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { STATIC } from '../../src/ui-server.js'

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'ui')

test('every src/ui module imported by the UI is served', () => {
  const served = new Set(Object.values(STATIC).map(([file]) => file))
  const missing = new Set()
  for (const f of fs.readdirSync(UI).filter((n) => n.endsWith('.js') || n.endsWith('.html'))) {
    const text = fs.readFileSync(path.join(UI, f), 'utf8')
    const refs = [
      ...text.matchAll(/from\s+['"]\.\/([\w-]+\.js)['"]/g),
      ...text.matchAll(/import\(\s*['"]\.\/([\w-]+\.js)['"]/g),
      ...text.matchAll(/src=['"]\/([\w-]+\.js)['"]/g),
      ...text.matchAll(/href=['"]\/([\w-]+\.css)['"]/g)
    ]
    for (const m of refs) if (!served.has(m[1])) missing.add(`${f} → ${m[1]}`)
  }
  assert.deepEqual([...missing], [], 'add these to STATIC in src/ui-server.js')
  for (const [file] of Object.values(STATIC)) assert.ok(fs.existsSync(path.join(UI, file)), `${file} is listed but missing`)
})
