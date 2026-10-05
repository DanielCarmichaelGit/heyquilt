// Pure, no Next imports, so it can be unit-tested directly.

/**
 * The PATCH body for a workspace's settings form. `archived` goes only when the toggle
 * changed (the form carries `was_archived`), so saving a name doesn't reset when it was archived.
 */
export function workspacePatch (formData) {
  const patch = { name: formData.get('name'), description: formData.get('description') || '', color: formData.get('color') || '' }
  const archived = formData.get('archived') === 'on'
  if (archived !== (formData.get('was_archived') === 'on')) patch.archived = archived
  return patch
}
