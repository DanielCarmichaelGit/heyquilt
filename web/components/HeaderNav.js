'use client'

// The segmented pill nav, plus the sub-760px collapse into a menu button that opens a small
// panel. usePathname highlights the current page's item: an exact match, or a page under it
// unless the item says exact (an org's Overview, which every org page sits under).
// In-page items (How it works, Agents) light up while their section is in view, and clicking
// one on its own page glides there instead of jumping.
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { isOn, isSectionOn, sectionOf, sectionPage, currentSection } from '@/lib/nav.js'

const MARKETING = [
  { href: '/#how', label: 'How it works' },
  { href: '/#agents', label: 'Agents' },
  { href: '/docs', label: 'Docs' },
  { href: '/blog', label: 'Blog' },
  { href: '/pricing', label: 'Pricing' }
]

const LINE = 120 // just under the sticky header (html scroll-padding-top is 88px)

export function smoothBehavior () {
  if (typeof window === 'undefined' || !window.matchMedia) return 'smooth'
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
}

export default function HeaderNav ({ items = MARKETING, label = 'Main' }) {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const [section, setSection] = useState('')
  // While a click glides to a section, keep that item lit instead of flickering through
  // the sections scrolled past on the way.
  const target = useRef('')

  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const ids = items.filter((item) => sectionOf(item) && sectionPage(item) === pathname).map(sectionOf)
  const idsKey = ids.join(' ')

  useEffect(() => {
    if (!idsKey) { setSection(''); return }
    const list = idsKey.split(' ')
    let frame = 0
    let settle = 0
    const measure = () => {
      frame = 0
      const boxes = list.map((id) => {
        const el = document.getElementById(id)
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { id, top: r.top, bottom: r.bottom }
      })
      const seen = currentSection(boxes, LINE)
      if (target.current) {
        if (seen !== target.current) return
        target.current = ''
      }
      setSection(seen)
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure)
      // A glide that ends short of its line (the page bottom) still has to let go.
      clearTimeout(settle)
      settle = setTimeout(() => { if (target.current) { target.current = ''; measure() } }, 180)
    }
    measure()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      cancelAnimationFrame(frame)
      clearTimeout(settle)
    }
  }, [idsKey])

  const go = useCallback((item, e) => {
    const id = sectionOf(item)
    if (!id || sectionPage(item) !== pathname) return
    const el = document.getElementById(id)
    if (!el || e.defaultPrevented || e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    target.current = id
    setSection(id)
    el.scrollIntoView({ behavior: smoothBehavior(), block: 'start' })
    if (window.location.hash !== `#${id}`) window.history.pushState(window.history.state, '', `#${id}`)
  }, [pathname])

  const link = (item, close) => {
    const on = sectionOf(item) ? isSectionOn(item, pathname, section) : isOn(item, pathname)
    const onClick = (e) => { go(item, e); close?.() }
    return (
      <Link key={item.href} className={`qh-link${on ? ' on' : ''}`} href={item.href} onClick={onClick} aria-current={on ? (sectionOf(item) ? 'location' : 'page') : undefined}>
        {item.label}
      </Link>
    )
  }

  return (
    <>
      <nav className='qh-mid' aria-label={label}>{items.map((item) => link(item))}</nav>
      <button
        type='button'
        className='qh-menu-btn'
        aria-expanded={open}
        aria-controls='qh-mobile-panel'
        aria-label='Menu'
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox='0 0 24 24' aria-hidden='true' width='20' height='20'>
          <path fill='currentColor' d='M3 6h18v2H3zM3 11h18v2H3zM3 16h18v2H3z' />
        </svg>
      </button>
      {open && (
        <div id='qh-mobile-panel' className='qh-mobile-panel'>
          {items.map((item) => link(item, () => setOpen(false)))}
        </div>
      )}
    </>
  )
}
