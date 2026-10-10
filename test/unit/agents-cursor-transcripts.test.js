import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startCursorTranscriptReader, cursorProjectSlug, cursorPromptText, slugCursorPath } from '../../src/agents/cursor-transcripts.js'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function writeTranscript (projects, dir, id, records) {
  const slug = cursorProjectSlug(dir)
  const file = path.join(projects, slug, 'agent-transcripts', id, `${id}.jsonl`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return file
}

test('cursor prompts keep only the typed message', () => {
  const raw = '<timestamp>Monday, Sep 28, 2026, 12:44 AM (UTC-4)</timestamp>\n<user_query>\njust testing some stuff\n</user_query>'
  assert.equal(cursorPromptText(raw), 'just testing some stuff')
  assert.equal(cursorPromptText('plain prompt'), 'plain prompt')
})

test('shares prompts, replies, and actions, and drops thinking', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-cursor-tx-'))
  const dir = path.join(root, 'room')
  const projects = path.join(root, 'projects')
  fs.mkdirSync(dir)
  writeTranscript(projects, dir, 'chat1', [
    { role: 'user', message: { content: [{ type: 'text', text: 'Add a button' }] } },
    { role: 'assistant', message: { content: [
      { type: 'thinking', thinking: 'secret plan' },
      { type: 'text', text: 'Adding it.' },
      { type: 'tool_use', name: 'read_file', input: { target_file: 'src/app.js' } }
    ] } },
    { type: 'turn_ended', status: 'success' }
  ])
  const entries = []
  const states = []
  const r = startCursorTranscriptReader({
    dir, projectsDir: projects, pollMs: 20,
    onEntries: (e) => entries.push(...e),
    onState: (s) => states.push(s)
  })
  await wait(80)
  r.stop()
  assert.deepEqual(entries.map((e) => [e.kind, e.text]), [
    ['prompt', 'Add a button'],
    ['reply', 'Adding it.'],
    ['action', 'Read src/app.js']
  ])
  assert.ok(entries.every((e) => e.tool === 'Cursor' && e.conv === 'chat1'))
  assert.equal(states.at(-1).status, 'idle')
})

test('slug follows Cursor for any path characters', () => {
  assert.equal(slugCursorPath('C:\\Users\\bjmik\\Desktop\\Quilt Test'), 'C-Users-bjmik-Desktop-Quilt-Test')
  assert.equal(slugCursorPath('c:\\Users\\bjmik\\Desktop\\Quilt Test'), 'c-Users-bjmik-Desktop-Quilt-Test')
  assert.equal(slugCursorPath('C:\\Users\\bjmik\\quilt\\room-1fe78d15'), 'C-Users-bjmik-quilt-room-1fe78d15')
  assert.equal(slugCursorPath('C:\\work\\My App (v2)'), 'C-work-My-App-v2')
  assert.equal(slugCursorPath('/Users/bjmik/My App (v2)'), 'Users-bjmik-My-App-v2')
  assert.equal(slugCursorPath('/tmp/café & co'), 'tmp-caf-co')
  assert.equal(slugCursorPath('\\\\server\\share\\Quilt Test'), 'server-share-Quilt-Test')
})

test('reads a project whose folder name has spaces and punctuation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-cursor-tx-'))
  const dir = path.join(root, 'Quilt Test (1)')
  const projects = path.join(root, 'projects')
  fs.mkdirSync(dir)
  const slug = cursorProjectSlug(dir)
  assert.equal(slug.includes(' '), false)
  assert.match(slug, /Quilt-Test-1$/)
  const id = 'chat-space'
  const file = path.join(projects, slug, 'agent-transcripts', id, `${id}.jsonl`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'Hello from Quilt Test' }] } }) + '\n')
  const decoy = path.join(projects, `${slug}-other`, 'agent-transcripts', 'nope', 'nope.jsonl')
  fs.mkdirSync(path.dirname(decoy), { recursive: true })
  fs.writeFileSync(decoy, JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'Not this project' }] } }) + '\n')
  const entries = []
  const r = startCursorTranscriptReader({
    dir, projectsDir: projects, pollMs: 20,
    onEntries: (e) => entries.push(...e),
    onState: () => {}
  })
  await wait(80)
  r.stop()
  assert.deepEqual(entries.map((e) => e.text), ['Hello from Quilt Test'])
})

test('matches the project folder when the drive letter case differs', { skip: process.platform !== 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-cursor-tx-'))
  const dir = path.join(root, 'room')
  const projects = path.join(root, 'projects')
  fs.mkdirSync(dir)
  const slug = cursorProjectSlug(dir)
  const flipped = slug.replace(/^([A-Za-z])/, (d) => d === d.toLowerCase() ? d.toUpperCase() : d.toLowerCase())
  assert.notEqual(flipped, slug)
  const id = 'chat2'
  const file = path.join(projects, flipped, 'agent-transcripts', id, `${id}.jsonl`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'Hello from the room' }] } }) + '\n')
  const entries = []
  const r = startCursorTranscriptReader({
    dir, projectsDir: projects, pollMs: 20,
    onEntries: (e) => entries.push(...e),
    onState: () => {}
  })
  await wait(80)
  r.stop()
  assert.deepEqual(entries.map((e) => e.text), ['Hello from the room'])
})
