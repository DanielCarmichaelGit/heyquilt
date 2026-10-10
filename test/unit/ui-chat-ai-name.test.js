// A person's AI sessions as one name in the app (src/ui/chat.js): "Daniel's AI".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aiName, foldPersonas, aiOwners, shownName, ownAiChatter } from '../../src/ui/chat.js'
import { mentioned } from '../../src/inbox.js'

const peers = [
  { name: 'Brandon' },
  { name: 'Daniel · branch sync', persona: true, of: 'Daniel', tool: 'Claude Code', focus: 'branch sync' },
  { name: 'Daniel · Claude Code 23', persona: true, of: 'Daniel', tool: 'Claude Code' },
  { name: 'Daniel · Codex', persona: true, of: 'Daniel', tool: 'Codex', mine: true },
  { name: 'Brandon · docs', persona: true, of: 'Brandon', tool: 'Cursor' }
]

test("a person's AI sessions fold into one \"<person>'s AI\" entry, listing each session", () => {
  const out = foldPersonas(peers)
  assert.deepEqual(out.map((p) => p.name), ['Brandon', "Daniel's AI", "Brandon's AI"])
  assert.deepEqual(out[1].sessions.map((x) => x.name), ['Daniel · branch sync', 'Daniel · Claude Code 23', 'Daniel · Codex'])
  assert.deepEqual(out[1].agents, ['Claude Code', 'Codex'])
  assert.equal(out[1].mine, undefined, 'mine comes from the first session seen')
  assert.equal(aiName('Daniel'), "Daniel's AI")
})

test('names are shown as their person\'s AI: from peers, from the message, or from an older "<first name> · <label>" name', () => {
  const owners = aiOwners({
    peers,
    messages: [{ by: 'Sam · gone', of: 'Sam Lee' }, { by: 'Daniel · old chat', text: 'hi' }, { by: 'Mallory', of: 'Daniel' }],
    people: ['Daniel', 'Brandon', 'Sam Lee']
  })
  assert.equal(shownName('Daniel · Codex', owners), "Daniel's AI")
  assert.equal(shownName('Sam · gone', owners), "Sam Lee's AI")
  assert.equal(shownName('Daniel · old chat', owners), "Daniel's AI")
  assert.equal(shownName('Brandon', owners), 'Brandon')
  assert.equal(shownName('Mallory', owners), 'Mallory', 'a message cannot pass its sender off as someone\'s AI')
})

test("a person's AI sessions writing to each other is left out; writing to people is not", () => {
  const owners = aiOwners({ peers })
  const by = 'Daniel · Codex'
  assert.equal(ownAiChatter({ by, to: 'Daniel · branch sync' }, owners), true)
  assert.equal(ownAiChatter({ by, to: "Daniel's AI" }, owners), true)
  assert.equal(ownAiChatter({ by, text: '@Daniel · branch sync rebase first' }, owners), true)
  assert.equal(ownAiChatter({ by, to: 'Daniel' }, owners), false, 'to its own person')
  assert.equal(ownAiChatter({ by, text: '@Daniel done' }, owners), false)
  assert.equal(ownAiChatter({ by, text: '@Brandon · docs and @Daniel · branch sync' }, owners), false, 'someone else is in it')
  assert.equal(ownAiChatter({ by, text: 'no mention' }, owners), false)
  assert.equal(ownAiChatter({ by: 'Brandon', to: "Daniel's AI" }, owners), false)
})

test("@Daniel's AI is a mention of Daniel's AI, not of Daniel", () => {
  assert.deepEqual(mentioned("@Daniel's AI which branch?", ['Daniel', "Daniel's AI"]), ["Daniel's AI"])
  assert.deepEqual(mentioned("@Daniel's car is here", ['Daniel']), ['Daniel'])
})
