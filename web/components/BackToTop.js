'use client'

// A round button in the bottom-right corner that appears once the reader is about a screen
// down a page and glides back to the top. It takes the #section off the address, so the
// header's section highlight lets go too.
import { useEffect, useState } from 'react'
import { showBackToTop } from '@/lib/nav.js'
import { smoothBehavior } from './HeaderNav.js'

export default function BackToTop () {
  const [shown, setShown] = useState(false)

  useEffect(() => {
    let frame = 0
    const check = () => { frame = 0; setShown(showBackToTop(window.scrollY, window.innerHeight)) }
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(check) }
    check()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      cancelAnimationFrame(frame)
    }
  }, [])

  const top = () => {
    window.scrollTo({ top: 0, behavior: smoothBehavior() })
    if (window.location.hash) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
  }

  return (
    <button
      type='button'
      className={`back-to-top${shown ? ' shown' : ''}`}
      onClick={top}
      aria-label='Back to top'
      title='Back to top'
      tabIndex={shown ? 0 : -1}
      aria-hidden={shown ? undefined : true}
    >
      <svg viewBox='0 0 24 24' aria-hidden='true' width='20' height='20'>
        <path fill='none' stroke='currentColor' strokeWidth='2.25' strokeLinecap='round' strokeLinejoin='round' d='M12 19V5M5.5 11.5 12 5l6.5 6.5' />
      </svg>
    </button>
  )
}
