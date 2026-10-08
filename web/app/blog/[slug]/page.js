import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getPosts, getPost, formatDate } from '@/lib/blog.js'

// Fully static: one page per file in web/content/blog. Any other slug is a 404.
export const dynamicParams = false

export function generateStaticParams () {
  return getPosts().map((p) => ({ slug: p.slug }))
}

export async function generateMetadata ({ params }) {
  const { slug } = await params
  const post = getPosts().find((p) => p.slug === slug)
  if (!post) return {}
  return { title: post.title, description: post.description || undefined }
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
      <div className='post-body' dangerouslySetInnerHTML={{ __html: post.html }} />
      <p className='post-back'><Link href='/blog'>All posts</Link></p>
    </article>
  )
}
