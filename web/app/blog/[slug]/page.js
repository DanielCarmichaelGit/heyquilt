import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getPosts, getPost, formatDate } from '@/lib/blog.js'
import { SITE_URL } from '@/lib/join.js'

// Fully static: one page per file in web/content/blog. Any other slug is a 404.
export const dynamicParams = false

export function generateStaticParams () {
  return getPosts().map((p) => ({ slug: p.slug }))
}

export async function generateMetadata ({ params }) {
  const { slug } = await params
  const post = getPosts().find((p) => p.slug === slug)
  if (!post) return {}
  const meta = { title: post.title, description: post.description || undefined }
  if (post.cover) {
    const url = post.cover.startsWith('http') ? post.cover : `${SITE_URL}${post.cover}`
    meta.openGraph = { images: [{ url }] }
    meta.twitter = { card: 'summary_large_image', images: [url] }
  }
  return meta
}

export default async function BlogPost ({ params }) {
  const { slug } = await params
  const post = await getPost(slug)
  if (!post) notFound()
  return (
    <article>
      <header className='post-head'>
        <h1>{post.title}</h1>
        <p className='blog-meta'>
          <time dateTime={post.date}>{formatDate(post.date)}</time>
          {post.author && <> · {post.author}</>}
        </p>
      </header>
      {post.cover && (
        <img className='post-cover' src={post.cover} alt={post.title} />
      )}
      <div className='post-body' dangerouslySetInnerHTML={{ __html: post.html }} />
      <p className='post-back'><Link href='/blog'>All posts</Link></p>
    </article>
  )
}
