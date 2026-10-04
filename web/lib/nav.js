// Pure, no Next imports, so it can be unit-tested directly.

// The personal space's tabs. Dashboard is exact: Computers, Agents and Access types sit under it but have
// their own tabs.
export const PERSONAL_NAV = [
  { href: '/dashboard', label: 'Dashboard', exact: true },
  { href: '/dashboard/workspaces', label: 'Workspaces' },
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
