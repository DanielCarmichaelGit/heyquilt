import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TASK_WORKFLOW, TASK_WORKFLOW_MD, pickupReminder, pickupBrief, doneRefusal, verifiedEnough, extractChecklist, pickChecklist, CHECKLIST_SCAFFOLD, verifiedLine, qaRefusal, qaNotesEnough, qaNotesLine } from '../src/agent-task-workflow.js'
import { AGENT_GUIDE, setup, scaffoldChecklist } from '../src/setup.js'
import { MCP_INSTRUCTIONS } from '../src/mcp.js'
import { INSTRUCTIONS, HOSTED_INSTRUCTIONS } from '../src/relay-mcp.js'

const STEPS = [
  [/grok/i, 'grok'],
  [/plan/i, 'plan'],
  [/build/i, 'build'],
  [/test/i, 'test'],
  [/\bqa\b/i, 'qa'],
]

function assertWorkflow (text, label) {
  assert.match(text, /pick up a ticket/i, `${label} should mention picking up a ticket`)
  for (const [re, name] of STEPS) {
    assert.match(text, re, `${label} should include ${name}`)
  }
}

test('TASK_WORKFLOW spells grok → plan → build → test', () => {
  assertWorkflow(TASK_WORKFLOW, 'TASK_WORKFLOW')
  assert.doesNotMatch(TASK_WORKFLOW, /\u2014/, 'no em dashes')
})

test('TASK_WORKFLOW_MD lists the four steps', () => {
  assertWorkflow(TASK_WORKFLOW_MD, 'TASK_WORKFLOW_MD')
  assert.match(TASK_WORKFLOW_MD, /\*\*Grok\*\*/)
  assert.match(TASK_WORKFLOW_MD, /\*\*Plan\*\*/)
  assert.match(TASK_WORKFLOW_MD, /\*\*Build\*\*/)
  assert.match(TASK_WORKFLOW_MD, /\*\*Test\*\*/)
})

test('pickupReminder restates the workflow when starting a ticket', () => {
  const text = pickupReminder('Fix login')
  assert.match(text, /^Picked up "Fix login"\./)
  assertWorkflow(text, 'pickupReminder')
})

test('AGENT_GUIDE includes the shared markdown workflow', () => {
  assert.ok(AGENT_GUIDE.includes(TASK_WORKFLOW_MD), 'AGENT_GUIDE embeds TASK_WORKFLOW_MD')
  assertWorkflow(AGENT_GUIDE, 'AGENT_GUIDE')
})

test('local MCP instructions include TASK_WORKFLOW', () => {
  assert.ok(MCP_INSTRUCTIONS.includes(TASK_WORKFLOW), 'MCP_INSTRUCTIONS embeds TASK_WORKFLOW')
  assertWorkflow(MCP_INSTRUCTIONS, 'MCP_INSTRUCTIONS')
})

test('relay MCP instructions include TASK_WORKFLOW', () => {
  assert.ok(INSTRUCTIONS.includes(TASK_WORKFLOW), 'INSTRUCTIONS embeds TASK_WORKFLOW')
  assert.ok(HOSTED_INSTRUCTIONS.includes(TASK_WORKFLOW), 'HOSTED_INSTRUCTIONS embeds TASK_WORKFLOW')
  assertWorkflow(INSTRUCTIONS, 'INSTRUCTIONS')
  assertWorkflow(HOSTED_INSTRUCTIONS, 'HOSTED_INSTRUCTIONS')
})

test('quilt setup writes the workflow into AGENTS.md and CLAUDE.md, and scaffolds the checklist once', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-workflow-'))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-workflow-home-'))
  fs.mkdirSync(path.join(home, '.cursor'))
  const changed = setup(root, { home })
  assert.ok(changed.some((c) => c.endsWith('(Cursor MCP server)')), 'the tools on this computer get the server')
  assert.ok(changed.some((c) => c.startsWith('AGENTS.md (Cursor')))
  assert.ok(changed.some((c) => c.startsWith('CLAUDE.md')))
  assert.ok(changed.some((c) => c.includes('Verifying a change')))
  // MCP servers go in each AI tool's own settings on this computer, not in the (synced) project.
  for (const f of ['.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json']) assert.equal(fs.existsSync(path.join(root, f)), false, f)
  for (const file of ['AGENTS.md', 'CLAUDE.md']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8')
    assert.ok(text.includes(TASK_WORKFLOW_MD), `${file} should contain TASK_WORKFLOW_MD`)
    assertWorkflow(text, file)
    assert.match(text, /QA without notes is refused/)
  }
  const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')
  assert.ok(agents.includes(CHECKLIST_SCAFFOLD), 'the template is in AGENTS.md')
  assert.ok(agents.indexOf('<!-- quilt:end -->') < agents.indexOf('## Verifying a change'), 'outside the quilt block, so owners can edit it')
  // The owner fills it in; setup again keeps their text and does not add a second section.
  fs.writeFileSync(path.join(root, 'AGENTS.md'), agents.replace(/## Verifying a change[\s\S]*$/, '## Verifying a change\n\n- npm test\n- open the app\n'))
  const again = setup(root, { home })
  assert.ok(!again.some((c) => c.includes('Verifying a change')))
  assert.equal((fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8').match(/## Verifying a change/g) || []).length, 1)
  assert.equal(extractChecklist(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')), '- npm test\n- open the app')
  // A checklist already in CLAUDE.md counts too.
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'quilt-workflow-'))
  fs.writeFileSync(path.join(root2, 'CLAUDE.md'), '## Verify\n\n- make check\n')
  assert.equal(scaffoldChecklist(root2), false)
  assert.ok(!fs.existsSync(path.join(root2, 'AGENTS.md')))
})

test('extractChecklist takes the section under a "Verif…" heading, up to the next heading', () => {
  assert.equal(extractChecklist(''), '')
  assert.equal(extractChecklist('# Guide\n\nno checks here\n'), '')
  assert.equal(extractChecklist('# Guide\n\n## Verifying a change\n\n- a\n- b\n\n## Other\n\n- c\n'), '- a\n- b')
  assert.equal(extractChecklist('## verification\n- only\n'), '- only')
  assert.equal(extractChecklist('### Verify (deep)\n- x\n'), '', 'only level-two headings')
  assert.equal(pickChecklist('', '## Verify\n- from claude\n'), '- from claude')
  assert.equal(pickChecklist('## Verify\n- from agents\n', '## Verify\n- from claude\n'), '- from agents')
})

test('pickupBrief: files, their recent changes, other people\'s claims, the workflow and the checks', () => {
  const now = Date.parse('2026-10-02T12:00:00Z')
  const task = { id: 'abcdef0123456789', title: 'Pricing page', files: ['src/ui/home.js', 'src/ui/app.css'] }
  const history = [
    { by: 'Duncan', path: 'src/ui/home.js', kind: 'edited', detail: '+4 -1', ts: now - 3600e3, task: { title: 'Logos' } },
    { by: 'Dana', path: 'src/ui/app.css', kind: 'edited', detail: '+2 -0', ts: now - 120e3, task: null }
  ]
  const claims = [{ by: 'Dana', pattern: 'src/ui/**', note: 'editing' }, { by: 'Sam', pattern: 'src/ui/app.css', note: 'theme' }]
  const brief = pickupBrief({ task, history, claims, checklist: '- npm test\n- open the app', me: 'Dana', now })
  const lines = brief.split('\n')
  assert.equal(lines[0], 'Picked up "Pricing page" [abcdef0123456789].')
  assert.equal(lines[1], 'Files: src/ui/home.js, src/ui/app.css')
  assert.match(brief, /Recent changes to these files \(oldest first\):\n- \[1h ago\] Duncan edited src\/ui\/home\.js \(\+4 -1\) for "Logos"\n- \[2m ago\] you edited src\/ui\/app\.css \(\+2 -0\)\n/)
  assert.match(brief, /Read the diffs with quilt_history/)
  assert.match(brief, /Claims to respect[^\n]*\n- src\/ui\/app\.css by Sam \(theme\)\n/)
  assert.doesNotMatch(brief, /by Dana/, 'my own claims are not warnings')
  assert.ok(brief.includes(TASK_WORKFLOW))
  assert.match(brief, /This project's checks \(from AGENTS\.md\):\n- npm test\n- open the app$/)

  const bare = pickupBrief({ task: { id: 'x', title: 'T', files: [] }, history: [], claims: [], checklist: '', now })
  assert.match(bare, /Files: none listed\. Add them with quilt_assign_task/)
  assert.match(bare, /No recorded changes yet\./)
  assert.match(bare, /no "Verifying a change" section in AGENTS\.md yet/)
  assert.doesNotMatch(bare, /Claims to respect/)

  const template = pickupBrief({ task: { id: 'x', title: 'T' }, checklist: extractChecklist(CHECKLIST_SCAFFOLD), now })
  assert.match(template, /still the template: ask the owner/)
  // Only the newest eight changes, so the brief stays short.
  const many = Array.from({ length: 20 }, (_, i) => ({ by: 'D', path: 'f', kind: 'edited', detail: '+1 -0', ts: now - (20 - i) * 1000 }))
  assert.equal((pickupBrief({ task: { id: 'x', title: 'T', files: ['f'] }, history: many, now }).match(/^- \[/gm) || []).length, 8)
})

test('Done needs real evidence; the refusal says what to give and quotes the checks', () => {
  assert.equal(verifiedEnough(''), false)
  assert.equal(verifiedEnough('tested'), false)
  assert.equal(verifiedEnough('   works   '), false)
  assert.equal(verifiedEnough('npm test passed, 612 tests'), true)
  const r = doneRefusal({ task: { title: 'Pricing page' }, checklist: '- npm test' })
  assert.match(r, /^Not moved: "Pricing page" needs `verified` before it can be Done\./)
  assert.match(r, /what you ran and what you saw/)
  assert.match(r, /This project's checks \(from AGENTS\.md\):\n- npm test$/)
  assert.match(doneRefusal({}), /this ticket needs `verified`/)
  assert.equal(verifiedLine({ verified: '  npm   test\npassed ' }), 'npm test passed')
  assert.equal(verifiedLine({ verified: 'x'.repeat(200) }), `${'x'.repeat(157)}…`)
  assert.equal(verifiedLine({}), '')
})

test('qaNotesEnough and qaRefusal gate the move to QA', () => {
  assert.equal(qaNotesEnough(''), false)
  assert.equal(qaNotesEnough('done'), false)
  assert.equal(qaNotesEnough('Added QA column; npm test passed'), true)
  const r = qaRefusal({ task: { title: 'QA column' }, checklist: '- npm test\n' })
  assert.match(r, /^Not moved: "QA column" needs `qaNotes` before it can go to QA\./)
  assert.match(r, /npm test/)
  assert.match(qaRefusal({}), /this ticket needs `qaNotes`/)
  assert.equal(qaNotesLine({ qaNotes: '  added   QA\ncolumn ' }), 'added QA column')
  assert.equal(qaNotesLine({ qaNotes: 'x'.repeat(200) }), `${'x'.repeat(157)}…`)
  assert.equal(qaNotesLine({}), '')
})

test('TASK_WORKFLOW steers agents to QA with qaNotes before Done', () => {
  assert.match(TASK_WORKFLOW, /move the ticket to QA/)
  assert.match(TASK_WORKFLOW, /qaNotes/)
  assert.match(TASK_WORKFLOW_MD, /\*\*QA\*\*/)
  assert.match(TASK_WORKFLOW_MD, /`qaNotes`/)
})
