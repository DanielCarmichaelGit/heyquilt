// The Quilt website: sign-in, accounts and downloads (the app itself is the desktop app).
export default {
  poweredByHeader: false,
  // join.heyquilt.com/<room> and .../<room>/ must both serve the invite page (no redirect):
  // proxy.js (joinPath) handles the trailing slash itself.
  skipTrailingSlashRedirect: true,
  // Orgs are only made by signing up as an org; the old "create an org" page moved.
  async redirects () {
    return [
      { source: '/orgs/new', destination: '/signup/org', permanent: false },
      // Agent kinds became a section of the agents page.
      { source: '/docs/agent-kinds', destination: '/docs/agents#kinds', permanent: true }
    ]
  },
  // /link's Approve button must never be clickjacked into an invisible iframe
  async headers () {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" }
      ]
    }]
  }
}
