'use server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/session.js'
import { createClient } from '@/lib/supabase/server.js'
import { apiCall } from '@/lib/api.js'
import { rememberSpace } from '@/lib/space-cookie.js'
import { isSlug } from '@/lib/space.js'
import { isRoom } from '@/lib/activity-view.js'
import { placementFromForm } from '@/lib/agent-placement.js'

// The Computers and Agents pages, and the overview that counts them. These actions don't
// redirect: the form re-renders the page it was on, so revalidating that page (and the
// overview's counts) is enough.
const COMPUTERS = '/dashboard/computers'
const AGENTS = '/dashboard/agents'
function refresh (page) {
  revalidatePath(page)
  revalidatePath('/dashboard')
}

// Unlinking goes straight through row-level security: people may set revoked_at on their own computers.
export async function unlinkComputer (formData) {
  await requireUser(COMPUTERS)
  const supabase = await createClient()
  await supabase.from('devices').update({ revoked_at: new Date().toISOString() }).eq('id', String(formData.get('id'))).is('revoked_at', null)
  refresh(COMPUTERS)
}

// An agent invite link is shown once, so it comes back to the form rather than through a redirect.
export async function createAgentInvite () {
  const user = await requireUser(AGENTS)
  const r = await apiCall(user, 'POST', '/v1/agent-invites', {})
  if (!r.ok) return { error: r.data?.error || 'Couldn’t make an invite link. Try again.' }
  refresh(AGENTS)
  return { link: r.data.link, id: r.data.invite.id }
}

// Whether a shown invite link is still waiting, so the page can notice the agent join.
export async function agentInviteWaiting (id) {
  const user = await requireUser(AGENTS)
  const r = await apiCall(user, 'GET', '/v1/agent-invites')
  if (!r.ok) return true
  return (r.data?.invites || []).find((i) => i.id === id)?.status === 'waiting'
}

export async function cancelAgentInvite (formData) {
  const user = await requireUser(AGENTS)
  await apiCall(user, 'DELETE', `/v1/agent-invites/${encodeURIComponent(String(formData.get('id')))}`)
  refresh(AGENTS)
}

export async function revokeAgent (formData) {
  const user = await requireUser(AGENTS)
  await apiCall(user, 'DELETE', `/v1/agents/${encodeURIComponent(String(formData.get('id')))}`)
  refresh(AGENTS)
}

// App keys (qk_) are shown once, so they come back to the form rather than through a redirect.
// Connecting an app makes a new agent for it with its first key; an agent of yours can get more.
export async function connectApp (prev, formData) {
  const user = await requireUser(AGENTS)
  const name = String(formData.get('name') || '').trim()
  const r = await apiCall(user, 'POST', '/v1/agents/apps', { name, provider: name })
  if (!r.ok) return { error: r.data?.error || 'Couldn’t connect the app. Try again.' }
  refresh(AGENTS)
  return { key: r.data.key.key, agent: r.data.agent.name, mcp: r.data.mcp }
}

export async function newAppKey (prev, formData) {
  const user = await requireUser(AGENTS)
  const id = String(formData.get('agentId') || '')
  const r = await apiCall(user, 'POST', `/v1/agents/${encodeURIComponent(id)}/keys`, { name: String(formData.get('name') || '').trim() })
  if (!r.ok) return { error: r.data?.error || 'Couldn’t make a key. Try again.' }
  refresh(AGENTS)
  return { key: r.data.key.key, agent: r.data.agent.name, mcp: r.data.mcp }
}

export async function revokeAppKey (formData) {
  const user = await requireUser(AGENTS)
  await apiCall(user, 'DELETE', `/v1/agents/${encodeURIComponent(String(formData.get('agentId')))}/keys/${encodeURIComponent(String(formData.get('id')))}`)
  refresh(AGENTS)
}

// Where one of your agents works (workspaces on): its Available in and Joins. The answer
// comes back to the form, which shows "Saved." or the API's reason.
export async function saveAgentPlacement (prev, formData) {
  const user = await requireUser(AGENTS)
  const id = String(formData.get('id') || '')
  const r = await apiCall(user, 'PUT', `/v1/me/agents/${encodeURIComponent(id)}/placement`, placementFromForm(formData))
  if (!r.ok) return { error: r.data?.error || 'Couldn’t save where it works. Try again.' }
  revalidatePath(AGENTS)
  return { saved: true }
}

// Renaming a session you own, from the dashboard or its page (the API checks you own it).
// Returns the new name, or an error for the form to show.
export async function renameSession (prev, formData) {
  const user = await requireUser('/dashboard')
  const room = String(formData.get('room') || '')
  if (!isRoom(room)) return { error: 'That session wasn’t found.' }
  const r = await apiCall(user, 'PUT', `/v1/me/sessions/${room}`, { name: String(formData.get('name') || '') })
  if (!r.ok) return { error: r.data?.error || 'Couldn’t rename the session. Try again.' }
  revalidatePath('/dashboard')
  revalidatePath(`/dashboard/sessions/${room}`)
  return { name: r.data.session.name }
}

// An org sign-up carries its org's name in the account until the org exists.
// Only for people in no org yet (not, say, someone who accepted an invite first).
// first: true tells the API to guard this server-side: two tabs (or a double
// click) that both call this at once still end up with exactly one org.
// There's no way to dismiss this: org_name only clears once the org is made,
// so a failed attempt can only be retried, not skipped.
export async function createFirstOrg () {
  const user = await requireUser('/dashboard')
  if (!user.orgName) return { error: 'There’s no org waiting to be created.' }
  const made = await apiCall(user, 'POST', '/v1/orgs', { name: user.orgName, first: true })
  if (!made.ok) return { error: made.data?.error || 'Couldn’t create your org. Try again.' }
  const supabase = await createClient()
  await supabase.auth.updateUser({ data: { org_name: null } })
  await rememberSpace(made.data.org.slug)
  return { slug: made.data.org.slug }
}

// Domain join requests: the API checks the person's confirmed email matches the org's domain.
export async function askToJoin (formData) {
  const user = await requireUser('/dashboard')
  const slug = String(formData.get('slug') || '')
  if (!isSlug(slug)) redirect('/dashboard')
  const r = await apiCall(user, 'POST', `/v1/orgs/${slug}/requests`, {})
  redirect(r.ok ? '/dashboard?asked=1' : `/dashboard?error=${encodeURIComponent(r.data?.error || 'Could not send your request. Try again.')}`)
}
