import 'server-only'
import { cache } from 'react'
import { apiCall } from './api.js'

/** Whether the API has workspaces turned on (off, its route answers 404). Cached per request. */
export const workspacesOn = cache(async (accessToken) => {
  const r = await apiCall({ accessToken }, 'GET', '/v1/me/workspaces', undefined, { expect404: true })
  return r.ok
})
