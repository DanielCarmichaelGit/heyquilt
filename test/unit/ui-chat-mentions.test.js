// @mentions in the app's chat: marked up in messages, and completed as you type.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { textHtml, mentionAt, mentionCandidates, completeMention } = await import('../../src/ui/chat.js')

test('textHtml marks up whole-name mentions of members, any case, and escapes the rest', () => {
  const names = ['Dana', 'Grok Bot', 'a.b-c']
  assert.equal(textHtml('hi @dana <b>', names), 'hi <span class="mention">@dana</span> &lt;b&gt;')
  assert.equal(textHtml('@Grok Bot: go', names), '<span class="mention">@Grok Bot</span>: go', 'names with spaces')
  assert.equal(textHtml('mail dan@dana.dev', names), 'mail dan@dana.dev', 'an email address is not a mention')
  assert.equal(textHtml('@Danas unite', names), '@Danas unite', '@Danas is not @Dana')
  assert.equal(textHtml('(@a.b-c?)', names), '(<span class="mention">@a.b-c</span>?)', 'regex characters in names are literal')
  assert.equal(textHtml('@dana look', names, 'dana'), '<span class="mention me">@dana</span> look', 'a mention of the reader is theirs')
  assert.equal(textHtml('@nobody here', names), '@nobody here')
  assert.equal(textHtml('<i>', []), '&lt;i&gt;')
  assert.equal(textHtml(null, names), '')
})

test('mentionAt finds the @word before the caret, and only there', () => {
  assert.deepEqual(mentionAt('hello @da', 9), { start: 6, query: 'da' })
  assert.deepEqual(mentionAt('@', 1), { start: 0, query: '' })
  assert.deepEqual(mentionAt('hello @dana and', 9), { start: 6, query: 'da' }, 'the caret in the middle of the word')
  assert.equal(mentionAt('hello @dana and', 15), null, 'past the mention')
  assert.equal(mentionAt('dan@dana', 8), null, 'an email address')
  assert.equal(mentionAt('plain', 5), null)
  assert.equal(mentionAt('', 0), null)
})

test('mentionCandidates: by the start of a name or of a word in it, any case, no duplicates, sorted, at most 8', () => {
  const names = ['dana', 'Grok Bot', 'Duncan', 'Dana', 'martha']
  assert.deepEqual(mentionCandidates(names, 'd'), ['dana', 'Duncan'])
  assert.deepEqual(mentionCandidates(names, 'bo'), ['Grok Bot'])
  assert.deepEqual(mentionCandidates(names, ''), ['dana', 'Duncan', 'Grok Bot', 'martha'])
  assert.deepEqual(mentionCandidates(names, 'zz'), [])
  assert.equal(mentionCandidates(Array.from({ length: 12 }, (_, i) => `n${i}`), 'n').length, 8)
})

test('completeMention replaces the typed part with the whole name and a space', () => {
  assert.deepEqual(completeMention('hello @gr and', mentionAt('hello @gr and', 9), 'Grok Bot'), { text: 'hello @Grok Bot and', caret: 16 })
  assert.deepEqual(completeMention('@', { start: 0, query: '' }, 'dana'), { text: '@dana ', caret: 6 })
})

test('textHtml renders lightweight markdown: bold, italic, headings, rules; still escapes and keeps mentions', () => {
  const names = ['Dana', 'Grok Bot']
  assert.equal(textHtml('see **this** and *that*', []), 'see <strong>this</strong> and <em>that</em>')
  assert.equal(textHtml('## Next steps', []), '<span class="md-h">Next steps</span>')
  assert.equal(textHtml('### Detail', []), '<span class="md-h">Detail</span>')
  assert.equal(textHtml('----', []), '<hr class="md-hr">')
  assert.equal(textHtml('---', []), '<hr class="md-hr">')
  assert.equal(
    textHtml('## Go\n@dana please\n----\n**done**', names),
    '<span class="md-h">Go</span>\n<span class="mention">@dana</span> please\n<hr class="md-hr">\n<strong>done</strong>'
  )
  assert.equal(textHtml('**@dana** look', names), '<strong><span class="mention">@dana</span></strong> look')
  assert.equal(textHtml('**a <b> tag**', []), '<strong>a &lt;b&gt; tag</strong>', 'emphasis does not create tags from user text')
  assert.equal(textHtml('not -- a rule', []), 'not -- a rule', 'short dashes stay plain')
  assert.equal(textHtml('#alone', []), '#alone', 'a bare # without a space is not a heading')
})
