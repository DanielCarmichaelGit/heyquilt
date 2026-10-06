'use server'
import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { isSlug } from '@/lib/space.js'
import { orgAction, enc } from '@/lib/org-actions.js'
import { inviteFromForm, splitFolders } from '@/lib/agent-form.js'
import { placementFromForm } from '@/lib/agent-placement.js'

export async function setRole (formData) {
  await orgAction(formData, 'people', 'PUT', `/members/${enc(formData.get('id'))}`, { roleId: String(formData.get('roleId') || '') })
}

// Removing an agent member revokes the agent.
export async function removeMember (formData) {
  await orgAction(formData, 'people', 'DELETE', `/members/${enc(formData.get('id'))}`)
}

// An agent's access and folders in one team.
export async function setAgentTeam (formData) {
  await orgAction(formData, 'people', 'PUT', `/teams/${enc(formData.get('id'))}/members/${enc(formData.get('memberId'))}`, {
    access: String(formData.get('access') || ''),
    scopes: splitFolders(formData.get('folders'))
  })
}

// The invite link is shown once, so it comes back to the form rather than through a redirect.
export async function createOrgAgentInvite (prev, formData) {
  const slug = String(formData.get('slug') || '')
  if (!isSlug(slug)) return { error: 'Something went wrong. Try again.' }
  const user = await requireUser(`/org/${slug}/people`)
  const r = await apiCall(user, 'POST', `/v1/orgs/${slug}/agent-invites`, inviteFromForm(formData))
  if (!r.ok) return { error: r.data?.error || 'Couldn’t make an invite link. Try again.' }
  revalidatePath(`/org/${slug}/people`)
  return { link: r.data.link, id: r.data.invite.id, slug }
}

// Whether a shown invite link is still waiting, so the page can notice the agent join.
export async function orgAgentInviteWaiting (id, slug) {
  if (!isSlug(slug)) return false
  const user = await requireUser(`/org/${slug}/people`)
  const r = await apiCall(user, 'GET', `/v1/orgs/${slug}/agent-invites`)
  if (!r.ok) return true
  return (r.data?.invites || []).find((i) => i.id === id)?.status === 'waiting'
}

export async function cancelOrgAgentInvite (formData) {
  await orgAction(formData, 'people', 'DELETE', `/agent-invites/${enc(formData.get('id'))}`)
}

// Where one of the org's agents works (workspaces on, Agents: Update). The answer comes back
// to the form, which shows "Saved." or the API's reason.
export async function saveOrgAgentPlacement (prev, formData) {
  const slug = String(formData.get('slug') || '')
  if (!isSlug(slug)) return { error: 'Something went wrong. Try again.' }
  const user = await requireUser(`/org/${slug}/people`)
  const id = String(formData.get('id') || '')
  const r = await apiCall(user, 'PUT', `/v1/orgs/${slug}/agents/${encodeURIComponent(id)}/placement`, placementFromForm(formData))
  if (!r.ok) return { error: r.data?.error || 'Couldn’t save where it works. Try again.' }
  revalidatePath(`/org/${slug}/people`)
  return { saved: true }
}
