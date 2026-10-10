// The blog: one markdown file per post in web/content/blog/<slug>.md, with frontmatter
// (title, slug, date, description, author). No Next imports, so a test can load it directly.
// Every page that uses it is prerendered, so this only reads the files at build time.
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import matter from 'gray-matter'
import { remark } from 'remark'
import html from 'remark-html'

export const BLOG_DIR = path.join(process.cwd(), 'content', 'blog')

// YAML reads `date: 2026-10-08` (or `2026-10-08T09:30:00Z`) as a Date; keep the full time for
// ordering and the plain YYYY-MM-DD for showing.
function isoStamp (value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString()
  return String(value || '')
}

/** "8 October 2026", the way the terms page writes dates. */
export function formatDate (iso) {
  const d = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d)
}

function readPost (file, dir) {
  const { data, content } = matter(readFileSync(path.join(dir, file), 'utf8'))
  return {
    slug: String(data.slug || file.replace(/\.md$/, '')),
    title: String(data.title || ''),
    date: isoStamp(data.date).slice(0, 10),
    sortKey: isoStamp(data.date),
    description: String(data.description || ''),
    author: String(data.author || ''),
    cover: String(data.cover || ''),
    content
  }
}

// Which post lists first when two share a date (and time): the merge post was to go out first.
const SAME_DAY = ['we-took-the-ai-out-of-merging', 'teaching-ais-to-take-turns', 'everyones-ai-work-at-once']
function sameDayRank (slug) {
  const i = SAME_DAY.indexOf(slug)
  return i === -1 ? SAME_DAY.length : i
}

/** Every post, newest first. A date can carry a time to order posts from the same day; otherwise SAME_DAY, then slug, so the order never shifts between builds. */
export function getPosts (dir = BLOG_DIR) {
  let files = []
  try { files = readdirSync(dir).filter((f) => f.endsWith('.md')) } catch { return [] }
  return files.map((f) => readPost(f, dir))
    .sort((a, b) => b.sortKey.localeCompare(a.sortKey) || sameDayRank(a.slug) - sameDayRank(b.slug) || a.slug.localeCompare(b.slug))
}

/** One post by its slug, with its body rendered to HTML, or null. */
export async function getPost (slug, dir = BLOG_DIR) {
  const post = getPosts(dir).find((p) => p.slug === slug)
  if (!post) return null
  const body = String(await remark().use(html).process(post.content))
  return { ...post, html: body }
}
