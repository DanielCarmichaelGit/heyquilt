import Notice from '@/components/Notice.js'
import InvitesWaiting from '@/components/InvitesWaiting.js'
import { requireUser } from '@/lib/session.js'
import { orgMe } from '@/lib/org.js'
import { leaveOrg } from './actions.js'

export const metadata = { title: 'Org' }

export default async function OrgHome ({ params, searchParams }) {
  const { slug } = await params
  const q = await searchParams
  const user = await requireUser(`/org/${slug}`)
  const me = await orgMe(user.accessToken, slug)
  return (
    <>
      <InvitesWaiting user={user} back={`/org/${slug}`} />
      <section className='card stack'>
        <Notice q={q} />
        <p>{me.isOwner ? 'You own this org.' : `Your role here: ${me.role?.name || 'none'}.`}</p>
        <p className='muted'>Use the tabs above to see its teams{me.isOwner ? ', people, roles and settings' : ''}.</p>
        {!me.isOwner && (
          <form action={leaveOrg}>
            <input type='hidden' name='slug' value={slug} />
            <button className='btn ghost danger'>Leave {me.org.name}</button>
          </form>)}
      </section>
    </>
  )
}
