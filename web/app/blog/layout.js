import Header from '@/components/Header.js'
import Footer from '@/components/Footer.js'
import './blog.css'

// The blog index and every post: the marketing header, one readable column, the footer. Fully static.
export const metadata = { title: { default: 'Blog', template: '%s · Quilt blog' } }

export default function BlogLayout ({ children }) {
  return (
    <>
      <Header />
      <main className='wrap page blog'>{children}</main>
      <Footer />
    </>
  )
}
