import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSmtpMailer, createConsoleMailer } from '../../src/api/mailer.js'

test('the SMTP mailer sends from SMTP_FROM with the message it is given', async () => {
  const sent = []
  const m = createSmtpMailer({ from: 'Quilt <invites@heyquilt.com>', transport: { sendMail: async (x) => { sent.push(x) } } })
  await m.send({ to: 'a@acme.com', subject: 'Hi', text: 'Body' })
  assert.deepEqual(sent, [{ from: 'Quilt <invites@heyquilt.com>', to: 'a@acme.com', subject: 'Hi', text: 'Body' }])
})

test('a message can name its own sender', async () => {
  const sent = []
  const m = createSmtpMailer({ from: 'Quilt <invites@heyquilt.com>', transport: { sendMail: async (x) => { sent.push(x) } } })
  await m.send({ to: 'a@acme.com', subject: 'Hi', text: 'Body', from: 'Quilt <hello@hq.heyquilt.com>' })
  assert.equal(sent[0].from, 'Quilt <hello@hq.heyquilt.com>')
})

test('the SMTP mailer builds its transport from SMTP_URL without connecting', () => {
  const m = createSmtpMailer({ url: 'smtp://user:pass@127.0.0.1:2525', from: 'x@quilt.test' })
  assert.equal(typeof m.send, 'function')
})

test('the console mailer prints the email, link included', async () => {
  const lines = []
  await createConsoleMailer((l) => lines.push(l)).send({ to: 'a@acme.com', subject: 'Hi', text: 'Open http://localhost:3000/invite/qi_x' })
  assert.match(lines.join('\n'), /a@acme\.com[\s\S]*qi_x/)
})

test('smtp:// requires TLS explicitly, so a stripped STARTTLS reply cannot expose the password', () => {
  let seen
  createSmtpMailer({
    url: 'smtp://user:pass@127.0.0.1:2525', from: 'x@quilt.test',
    createTransport: (opts) => { seen = opts; return { sendMail: async () => {} } }
  })
  assert.equal(seen.requireTLS, true)
  assert.equal(seen.secure, false)
  assert.deepEqual(seen.auth, { user: 'user', pass: 'pass' })
})

test('SMTP connections give up rather than hang forever', () => {
  let seen
  createSmtpMailer({
    url: 'smtp://user:pass@127.0.0.1:2525', from: 'x@quilt.test',
    createTransport: (opts) => { seen = opts; return { sendMail: async () => {} } }
  })
  assert.equal(seen.connectionTimeout, 10000)
  assert.equal(seen.greetingTimeout, 10000)
  assert.equal(seen.socketTimeout, 15000)
})

test('smtps:// connects secure from the start', () => {
  let seen
  createSmtpMailer({
    url: 'smtps://user:pass@127.0.0.1:465', from: 'x@quilt.test',
    createTransport: (opts) => { seen = opts; return { sendMail: async () => {} } }
  })
  assert.equal(seen.secure, true)
  assert.equal(seen.requireTLS, undefined)
})

test('a bad SMTP_URL is refused, and the error never contains the password', () => {
  assert.throws(() => createSmtpMailer({ url: 'http://user:secret123@smtp.resend.com:587', from: 'x@quilt.test' }), (err) => {
    assert.match(err.message, /smtp:\/\/ or smtps:\/\//)
    assert.doesNotMatch(err.message, /secret123/)
    return true
  })
})
