'use server'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/session.js'
import { apiCall } from '@/lib/api.js'
import { workspacePatch } from '@/lib/workspace-form.js'
import { isSlug } from '@/lib/space.js'

const enc = (v) => encodeURIComponent(String(v ?? ''))
const back = (path, q) => redirect(`${path}?${new URLSearchParams(q)}`)

function baseOf (formData) {
  const slug = String(formData.get('slug') || '')
  if (!isSlug(slug)) redirect('/dashboard')
  return { slug, base: `/org/${slug}/workspaces` }
}

export async function createWorkspace (formData) {
  const { slug, base } = baseOf(formData)
  const user = await requireUser(base)
  const r = await apiCall(user, 'POST', '/v1/workspaces', { name: formData.get('name'), description: formData.get('description') || '', color: formData.get('color') || '', org: slug })
  if (!r.ok) return back(base, { error: r.data?.error || 'Could not create the workspace.' })
  revalidatePath(base)
  redirect(`${base}/${r.data.workspace.id}`)
}

export async function updateWorkspace (formData) {
  const { base } = baseOf(formData)
  const id = String(formData.get('id'))
  const user = await requireUser(base)
  const r = await apiCall(user, 'PATCH', `/v1/workspaces/${enc(id)}`, workspacePatch(formData))
  revalidatePath(`${base}/${id}`)
  back(`${base}/${id}`, r.ok ? { message: 'Saved.' } : { error: r.data?.error || 'Could not save.' })
}

export async function deleteWorkspace (formData) {
  const { base } = baseOf(formData)
  const id = String(formData.get('id'))
  const user = await requireUser(base)
  const r = await apiCall(user, 'DELETE', `/v1/workspaces/${enc(id)}`)
  revalidatePath(base)
  if (!r.ok) return back(`${base}/${id}`, { error: r.data?.error || 'Could not delete.' })
  back(base, { message: 'Deleted. Its sessions are now outside any workspace.' })
}

export async function setMember (formData) {
  const { base } = baseOf(formData)
  const id = String(formData.get('id')); const account = String(formData.get('account'))
  const user = await requireUser(base)
  const r = await apiCall(user, 'PUT', `/v1/workspaces/${enc(id)}/members/${enc(account)}`, { access: formData.get('access') })
  revalidatePath(`${base}/${id}`)
  back(`${base}/${id}`, r.ok ? { message: 'Saved.' } : { error: r.data?.error || 'Could not save.' })
}

export async function removeMember (formData) {
  const { base } = baseOf(formData)
  const id = String(formData.get('id')); const account = String(formData.get('account'))
  const user = await requireUser(base)
  const r = await apiCall(user, 'DELETE', `/v1/workspaces/${enc(id)}/members/${enc(account)}`)
  revalidatePath(`${base}/${id}`)
  back(`${base}/${id}`, r.ok ? { message: 'Removed.' } : { error: r.data?.error || 'Could not remove.' })
}
