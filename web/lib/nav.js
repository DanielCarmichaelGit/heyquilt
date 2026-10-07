// Pure, no Next imports, so it can be unit-tested directly.

// The personal space's tabs. Dashboard is exact: Computers, Agents and Access types sit under it but have
// their own tabs.
export const PERSONAL_NAV = [
  { href: '/dashboard', label: 'Dashboard', exact: true },
  { href: '/dashboard/computers', label: 'Computers' },
  { href: '/dashboard/agents', label: 'Agents' },
  { href: '/dashboard/access', label: 'Access types' }
]

/** Whether a nav item is the current page: an exact match, or a page under it unless the item says exact. In-page (#) links never are. */
export function isOn (item, pathname) {
  const path = item.href.split('#')[0]
  if (!path || item.href.includes('#')) return false
  return pathname === path || (!item.exact && pathname.startsWith(path + '/'))
}

/** The in-page section an item points at (`/#how` is `how`), or '' for a plain page link. */
export function sectionOf (item) {
  const i = item.href.indexOf('#')
  return i === -1 ? '' : item.href.slice(i + 1)
}

/** The page an in-page item lives on: `/#how` is on `/`. */
export function sectionPage (item) {
  return item.href.split('#')[0] || '/'
}

/** Whether an in-page item is on: we're on its page and its section is the one in view. */
export function isSectionOn (item, pathname, section) {
  const id = sectionOf(item)
  return !!id && !!section && id === section && sectionPage(item) === pathname
}

/**
 * Which section is in view, from each section's box relative to the viewport (`top`/`bottom`
 * as from getBoundingClientRect). A section counts once its top has passed `line` (just under
 * the sticky header) and until its bottom has. Between or above sections, nothing is.
 */
export function currentSection (boxes, line = 120) {
  let on = ''
  for (const b of boxes) {
    if (b && b.top <= line && b.bottom > line) on = b.id
  }
  return on
}

/** The back-to-top button shows once the reader is about a screen down the page. */
export function showBackToTop (scrollY, viewport = 800) {
  return scrollY > Math.max(480, viewport * 0.9)
}
