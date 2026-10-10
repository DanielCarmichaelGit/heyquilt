// Shut down from the Settings pop-up: the "Shut down Quilt?" question has to sit on top
// of Settings (it used to open behind it), and clicking again must not stack questions.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const css = fs.readFileSync(path.join(root, 'src/ui/app.css'), 'utf8')
const commonJs = fs.readFileSync(path.join(root, 'src/ui/common.js'), 'utf8')
const appJs = fs.readFileSync(path.join(root, 'src/ui/app.js'), 'utf8')

function zIndex (selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = css.match(new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`))
  assert.ok(m, `missing CSS rule ${selector}`)
  const z = m[1].match(/z-index:\s*(\d+)/)
  assert.ok(z, `${selector} has no z-index`)
  return Number(z[1])
}

test('confirm dialogs stack above the Settings pop-up', () => {
  assert.match(commonJs, /back\.className = 'modal-back ask-back'/, 'ask() marks its backdrop')
  assert.ok(zIndex('.ask-back') > zIndex('.settings-back'), '.ask-back above .settings-back')
  assert.ok(zIndex('.settings-back') > zIndex('.modal-back'), 'Settings above ordinary modals')
})

test('Shut down asks once, however often it is clicked', () => {
  const fn = appJs.slice(appJs.indexOf('export async function shutdown'), appJs.indexOf("document.addEventListener('click', (e) => { if (e.target.closest('[data-shutdown]'))"))
  assert.match(appJs, /let shuttingDown = false/)
  assert.match(fn, /if \(shuttingDown\) return\s+shuttingDown = true/)
  assert.match(fn, /finally \{\s+shuttingDown = false/)
})
