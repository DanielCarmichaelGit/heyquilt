'use server'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { workspacePatch } from '@/lib/workspace-form.js'

const back = (path, q) => redirect(`${path}?${new URLSearchParams(q)}`)

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
  const r = await apiCall(user, 'PUT', `/v1/workspaces/${encodeURIComponent(id)}/members/${encodeURIComponent(account)}`, { access: formData.get('access') })
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
