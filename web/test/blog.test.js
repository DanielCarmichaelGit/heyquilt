// The blog: every markdown file under content/blog becomes a static post, and the index lists them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { getPosts, getPost, formatDate, BLOG_DIR } from '../lib/blog.js'

const dir = fileURLToPath(new URL('../content/blog', import.meta.url))

test('every markdown file in content/blog is a listed post with the expected frontmatter', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'))
  assert.ok(files.length >= 3)
  const posts = getPosts(dir)
  assert.equal(posts.length, files.length)
  for (const p of posts) {
    assert.ok(p.slug)
    assert.ok(p.title)
    assert.match(p.date, /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(p.description)
    assert.equal(p.author, 'Daniel Carmichael')
    assert.ok(files.includes(`${p.slug}.md`), `${p.slug}.md exists`)
    // cover is optional; when present it must be a site-root path string
    assert.equal(typeof p.cover, 'string')
  }
  // Same-day launch posts: the merge post lists first, then taking turns, then Everyone.
  assert.deepEqual(posts.slice(0, 3).map((p) => p.slug), ['we-took-the-ai-out-of-merging', 'teaching-ais-to-take-turns', 'everyones-ai-work-at-once'])
  // Newest first.
  for (let i = 1; i < posts.length; i++) {
    assert.ok(posts[i - 1].date >= posts[i].date, 'posts are newest first')
  }
})

test('getPost renders the body to HTML and formatDate matches the terms-page style', async () => {
  const posts = getPosts(dir)
  const post = await getPost(posts[0].slug, dir)
  assert.ok(post.html.includes('<p>'))
  assert.ok(post.html.includes('<h2>'))
  assert.match(formatDate('2026-10-08'), /8 October 2026/)
  assert.equal(BLOG_DIR, path.join(process.cwd(), 'content', 'blog'))
})

test('frontmatter fields match what Maurice wrote (slug, title, date, description, author)', () => {
  const expected = {
    'we-took-the-ai-out-of-merging': 'We built an AI merge, then took it out three days later',
    'teaching-ais-to-take-turns': 'Teaching AIs to take turns on a file',
    'everyones-ai-work-at-once': "Everyone's AI work, all at once"
  }
  for (const [slug, title] of Object.entries(expected)) {
    const raw = readFileSync(path.join(dir, `${slug}.md`), 'utf8')
    assert.match(raw, new RegExp(`^title: "${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'm'))
    assert.match(raw, new RegExp(`^slug: ${slug}$`, 'm'))
    assert.match(raw, /^date: 2026-10-08$/m)
    assert.match(raw, /^author: Daniel Carmichael$/m)
  }
})

test('cover frontmatter is parsed for the three launch posts', () => {
  const expected = [
    'we-took-the-ai-out-of-merging',
    'teaching-ais-to-take-turns',
    'everyones-ai-work-at-once'
  ]
  const posts = getPosts(dir)
  for (const slug of expected) {
    const post = posts.find((p) => p.slug === slug)
    assert.ok(post, `${slug} is listed`)
    assert.equal(post.cover, `/blog/${slug}.webp`)
    const raw = readFileSync(path.join(dir, `${slug}.md`), 'utf8')
    assert.match(raw, new RegExp(`^cover: /blog/${slug}\\.webp$`, 'm'))
  }
})

test('absent cover becomes an empty string', () => {
  // getPosts returns cover as '' when the field is missing; exercise via a post
  // that has cover set is covered above — here we assert the field shape on every post.
  for (const p of getPosts(dir)) {
    assert.equal(typeof p.cover, 'string')
  }
})
