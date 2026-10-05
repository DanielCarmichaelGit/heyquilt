// Download a workspace file: the API signs a short-lived link for the signed-in person and we send them there.
import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'

export async function GET (req, { params }) {
  const { id, fileId } = await params
  const user = await currentUser()
  if (!user) return new Response('sign in first', { status: 401 })
  const version = new URL(req.url).searchParams.get('version')
  const r = await apiCall(user, 'GET', `/v1/workspaces/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}` + '/download' + (version ? `?version=${encodeURIComponent(version)}` : ''), undefined, { expect404: true })
  if (r.status === 404) return new Response('not found', { status: 404 })
  if (r.status === 403) return new Response('you can only view this workspace', { status: 403 })
  if (!r.ok || !r.data?.url) return new Response('the file could not be fetched right now', { status: 502 })
  return NextResponse.redirect(r.data.url, { status: 302 })
}
