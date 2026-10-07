import Header from '@/components/Header.js'
import Footer from '@/components/Footer.js'
import DocsNav from '@/components/DocsNav.js'
import './docs.css'

// Every docs page: the marketing header, the docs sidebar and the page. Fully static.
export const metadata = { title: { default: 'Docs', template: '%s · Quilt docs' } }

export default function DocsLayout ({ children }) {
  return (
    <>
      <Header />
      <div className='wrap docs'>
        <DocsNav />
        <main className='docs-main'>{children}</main>
      </div>
      <Footer />
    </>
  )
}
