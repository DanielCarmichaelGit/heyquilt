import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

test("the website's copy of the Quilt mark matches the app's", () => {
  assert.equal(fs.readFileSync('web/lib/mark.js', 'utf8'), fs.readFileSync('src/ui/mark.js', 'utf8'),
    'web/lib/mark.js is out of date: cp src/ui/mark.js web/lib/mark.js')
})
