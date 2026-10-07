import Link from 'next/link'
import Mark from './Mark.js'
import HeaderNav from './HeaderNav.js'
import AuthLink from './AuthLink.js'
import HeaderDownload from './HeaderDownload.js'
import StickyHeader from './StickyHeader.js'
import BackToTop from './BackToTop.js'

// The signed-out (marketing) header. Fully static (no headers()/cookies()/currentUser), so any
// page that renders it can still be prerendered; sign-in state and the download pick are both
// resolved client-side (see AuthLink.js and HeaderDownload.js). Signed-in pages use AppHeader.
export default function Header () {
  // BackToTop sits outside StickyHeader: that wrapper slides with a transform, which would
  // pin a fixed-position child to it instead of to the window.
  return (
    <>
      <StickyHeader>
        <header className='qh'>
          <Link href='/' className='brand qh-brand' aria-label='Quilt home'><Mark /></Link>
          <span className='qh-grow' />
          <HeaderNav />
          <span className='qh-grow' />
          <div className='qh-right'>
            <AuthLink />
            <HeaderDownload />
          </div>
        </header>
      </StickyHeader>
      <BackToTop />
    </>
  )
}
