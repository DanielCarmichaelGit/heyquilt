import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

test("the website's copy of the public mail domains matches the API's", () => {
  assert.equal(fs.readFileSync('web/lib/domains.js', 'utf8'), fs.readFileSync('src/api/domains.js', 'utf8'),
    'web/lib/domains.js is out of date: cp src/api/domains.js web/lib/domains.js')
})
