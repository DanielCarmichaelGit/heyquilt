// The audit trail as a CSV file, for the session owner (the accounts API checks that).
import { currentUser } from '@/lib/session.js'
import { isRoom } from '@/lib/activity-view.js'

export async function GET (request, { params }) {
  const { room } = await params
  if (!isRoom(room)) return new Response('Not found', { status: 404 })
  const user = await currentUser()
  if (!user) return Response.redirect(new URL(`/signin?next=${encodeURIComponent(`/dashboard/sessions/${room}/audit`)}`, request.url), 303)
  let res
  try {
    res = await fetch(`${process.env.QUILT_API_URL}/v1/me/sessions/${room}/audit?format=csv`, {
      headers: { authorization: `Bearer ${user.accessToken}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(30000)
    })
  } catch {
    return new Response('Could not reach Quilt right now. Try again in a minute.', { status: 502 })
  }
  if (res.status === 403) return new Response('Only the session owner can download its audit trail.', { status: 403 })
  if (!res.ok) return new Response(res.status === 404 ? 'Not found' : 'Could not load the audit trail right now.', { status: res.status === 404 ? 404 : 502 })
  const day = new Date().toISOString().slice(0, 10)
  return new Response(await res.text(), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="quilt-audit-${room}-${day}.csv"`,
      'cache-control': 'no-store'
    }
  })
}
