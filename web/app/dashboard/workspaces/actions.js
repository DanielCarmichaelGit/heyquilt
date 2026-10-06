'use server'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { workspacePatch } from '@/lib/workspace-form.js'

const back = (path, q) => redirect(`${path}?${new URLSearchParams(q)}`)
const enc = (v) => encodeURIComponent(String(v ?? ''))
/** An agent's Joins from a form: 'all' or 'invited'; nothing (kept as it is) when the form has none. */
const sessionsOf = (formData) => formData.get('sessions') ? (formData.get('sessions') === 'all' ? 'all' : 'invited') : undefined

export async function createWorkspace (formData) {
  const user = await requireUser('/dashboard/workspaces')
  const r = await apiCall(user, 'POST', '/v1/workspaces', { name: formData.get('name'), description: formData.get('description') || '', color: formData.get('color') || '' })
  if (!r.ok) return back('/dashboard/workspaces', { error: r.data?.error || 'Could not create the workspace.' })
  revalidatePath('/dashboard/workspaces')
  redirect(`/dashboard/workspaces/${r.data.workspace.id}`)
}

export async function updateWorkspace (formData) {
  const user = await requireUser('/dashboard/workspaces')
  const id = String(formData.get('id'))
  const r = await apiCall(user, 'PATCH', `/v1/workspaces/${encodeURIComponent(id)}`, workspacePatch(formData))
  revalidatePath(`/dashboard/workspaces/${id}`)
  back(`/dashboard/workspaces/${id}`, r.ok ? { message: 'Saved.' } : { error: r.data?.error || 'Could not save.' })
}

export async function deleteWorkspace (formData) {
  const user = await requireUser('/dashboard/workspaces')
  const id = String(formData.get('id'))
  const r = await apiCall(user, 'DELETE', `/v1/workspaces/${encodeURIComponent(id)}`)
  revalidatePath('/dashboard/workspaces')
  if (!r.ok) return back(`/dashboard/workspaces/${id}`, { error: r.data?.error || 'Could not delete.' })
  back('/dashboard/workspaces', { message: 'Deleted. Its sessions are still yours.' })
}

export async function setMember (formData) {
  const user = await requireUser('/dashboard/workspaces')
  const id = String(formData.get('id')); const account = String(formData.get('account'))
  const r = await apiCall(user, 'PUT', `/v1/workspaces/${encodeURIComponent(id)}/members/${encodeURIComponent(account)}`, { access: formData.get('access'), sessions: sessionsOf(formData) })
  revalidatePath(`/dashboard/workspaces/${id}`)
  back(`/dashboard/workspaces/${id}`, r.ok ? { message: 'Saved.' } : { error: r.data?.error || 'Could not save.' })
}

export async function removeMember (formData) {
  const user = await requireUser('/dashboard/workspaces')
  const id = String(formData.get('id')); const account = String(formData.get('account'))
  const r = await apiCall(user, 'DELETE', `/v1/workspaces/${encodeURIComponent(id)}/members/${encodeURIComponent(account)}`)
  revalidatePath(`/dashboard/workspaces/${id}`)
  back(`/dashboard/workspaces/${id}`, r.ok ? { message: 'Removed.' } : { error: r.data?.error || 'Could not remove.' })
}

// An agent placed here by its owner: the workspace's say over when it joins sessions, keeping
// it out of this workspace, and letting it back in (which drops the workspace's say entirely).
async function agentOverride (formData, method, body, done) {
  const user = await requireUser('/dashboard/workspaces')
  const id = String(formData.get('id')); const agentId = String(formData.get('agentId'))
  const r = await apiCall(user, method, `/v1/workspaces/${enc(id)}/agents/${enc(agentId)}`, body)
  revalidatePath(`/dashboard/workspaces/${id}`)
  back(`/dashboard/workspaces/${id}`, r.ok ? { message: done } : { error: r.data?.error || 'Could not save.' })
}

export async function setAgentJoins (formData) {
  await agentOverride(formData, 'PUT', { sessions: sessionsOf(formData) || 'invited' }, 'Saved.')
}

export async function keepAgentOut (formData) {
  await agentOverride(formData, 'PUT', { excluded: true }, 'It is no longer in this workspace.')
}

export async function letAgentBackIn (formData) {
  await agentOverride(formData, 'DELETE', undefined, 'It is back in this workspace.')
}
