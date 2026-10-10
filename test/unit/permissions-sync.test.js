import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

test("the website's copy of the permission grid matches the API's", () => {
  assert.equal(fs.readFileSync('web/lib/permissions.js', 'utf8'), fs.readFileSync('src/api/permissions.js', 'utf8'),
    'web/lib/permissions.js is out of date: cp src/api/permissions.js web/lib/permissions.js')
})
