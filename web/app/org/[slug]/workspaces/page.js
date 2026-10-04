import Notice from '@/components/Notice.js'
import WorkspaceList from '@/components/WorkspaceList.js'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { orgMe } from '@/lib/org.js'
import { allowed } from '@/lib/org-view.js'
import { createWorkspace } from './actions.js'

export const metadata = { title: 'Workspaces' }

export default async function Workspaces ({ params, searchParams }) {
  const { slug } = await params
  const q = await searchParams
  const user = await requireUser(`/org/${slug}/workspaces`)
  const me = await orgMe(user.accessToken, slug)
  const r = await apiCall(user, 'GET', '/v1/me/workspaces', undefined, { expect404: true })
  const off = r.status === 404
  const workspaces = (r.data?.workspaces || []).filter((w) => w.space?.kind === 'org' && w.space.slug === slug)
  return (
    <div className='stack'>
      <Notice q={q} />
      {off && <p className='muted'>Workspaces are not turned on yet.</p>}
      {!off && !r.ok && <p className='notice bad'>Could not load workspaces right now.</p>}
      {r.ok && <WorkspaceList workspaces={workspaces} hrefFor={(w) => `/org/${slug}/workspaces/${w.id}`} create={allowed(me, 'workspaces', 'c') ? createWorkspace : null} orgSlug={slug} />}
    </div>
  )
}
