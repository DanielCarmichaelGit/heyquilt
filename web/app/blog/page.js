import Link from 'next/link'
import { getPosts, formatDate } from '@/lib/blog.js'

// Fully static: the list of posts in web/content/blog, newest first.
export const metadata = { title: 'Blog' }

export default function BlogIndex () {
  const posts = getPosts()
  return (
    <>
      <h1 className='blog-title'>Blog</h1>
      <ol className='blog-list'>
        {posts.map((p) => (
          <li key={p.slug}>
            <h2><Link href={`/blog/${p.slug}`}>{p.title}</Link></h2>
            <time className='blog-meta' dateTime={p.date}>{formatDate(p.date)}</time>
            {p.description && <p>{p.description}</p>}
          </li>
        ))}
      </ol>
    </>
  )
}
