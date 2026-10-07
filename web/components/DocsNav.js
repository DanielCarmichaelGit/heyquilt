'use client'

// The docs sidebar: every docs page, with the current one lit. Under 900px it becomes a row of
// pills above the page.
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { DOCS_NAV } from '@/lib/docs.js'

export default function DocsNav () {
  const pathname = usePathname()
  return (
    <nav className='docs-nav' aria-label='Docs'>
      <span className='docs-nav-h'>Docs</span>
      {DOCS_NAV.map((item) => {
        const on = pathname === item.href
        return <Link key={item.href} href={item.href} className={on ? 'on' : undefined} aria-current={on ? 'page' : undefined}>{item.label}</Link>
      })}
    </nav>
  )
}
