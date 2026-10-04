import AppHeader from '@/components/AppHeader.js'
import Notice from '@/components/Notice.js'
import WorkspaceList from '@/components/WorkspaceList.js'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { createWorkspace } from './actions.js'

export const metadata = { title: 'Workspaces' }

export default async function Workspaces ({ searchParams }) {
  const q = await searchParams
  const user = await requireUser('/dashboard/workspaces')
  const r = await apiCall(user, 'GET', '/v1/me/workspaces', undefined, { expect404: true })
  const off = r.status === 404
  const workspaces = r.data?.workspaces || []
  return (
    <>
      <AppHeader user={user} space='personal' />
      <main className='wrap page stack'>
        <h1 style={{ fontSize: 32 }}>Workspaces</h1>
        <Notice q={q} />
        {off && <p className='muted'>Workspaces are not turned on yet.</p>}
        {!off && !r.ok && <p className='notice bad'>Could not load your workspaces right now.</p>}
        {r.ok && <WorkspaceList workspaces={workspaces} hrefFor={(w) => (w.space?.kind === 'org' ? `/org/${w.space.slug}/workspaces/${w.id}` : `/dashboard/workspaces/${w.id}`)} create={createWorkspace} />}
      </main>
    </>
  )
}
