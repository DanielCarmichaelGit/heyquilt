'use client'
import { useActionState, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { agentInvitePaste } from '../lib/agent-view.js'

function TeamRow ({ teams }) {
  return (
    <div className='row'>
      <select className='input' name='teamId' defaultValue='' aria-label='Team'>
        <option value=''>Pick a team</option>
        {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      <select className='input' name='access' defaultValue='viewer' aria-label='Access'>
        <option value='viewer'>Viewer</option>
        <option value='editor'>Editor</option>
      </select>
      <input className='input' name='folders' placeholder='Folders, e.g. src, docs (optional)' aria-label='Folders' style={{ flex: '1 1 200px' }} />
    </div>
  )
}

// For an org: an optional role, and the teams the agent joins.
function OrgChoices ({ roles, teams }) {
  const [rows, setRows] = useState(teams.length ? 1 : 0)
  return (
    <div className='stack'>
      {roles.length > 0 && (
        <div className='field'>
          <label htmlFor='invite-role'>Org role</label>
          <select id='invite-role' className='input' name='roleId' defaultValue=''>
            <option value=''>No role (team access only)</option>
            {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>)}
      {teams.length > 0 && (
        <div className='stack'>
          <b>Teams</b>
          {Array.from({ length: rows }, (_, i) => <TeamRow key={i} teams={teams} />)}
          {rows < teams.length && <button type='button' className='btn ghost' onClick={() => setRows(rows + 1)}>Add another team</button>}
          <p className='muted'>Agents start as viewers. Folders limit it to parts of the project; leave them empty for all of it.</p>
        </div>)}
    </div>
  )
}

/** "Invite an agent": makes a one-time link and shows it once, with Copy. */
export default function AgentInvite ({ action, waiting, slug, roles, teams }) {
  const [state, formAction, pending] = useActionState(action, null)
  const router = useRouter()
  // Done hides the link without touching the action state, so it isn't shown again until a new invite.
  const [shown, setShown] = useState(true)
  const [copied, setCopied] = useState(false)
  const forOrg = Array.isArray(roles) || Array.isArray(teams)

  // While the link is shown, check every few seconds whether an agent used it;
  // once it has, close the link and refresh so the new agent shows up.
  const watching = Boolean(state?.id && shown && waiting)
  useEffect(() => {
    if (!watching) return
    let stopped = false
    const timer = setInterval(async () => {
      const still = await waiting(state.id, state.slug).catch(() => true)
      if (stopped || still) return
      stopped = true
      clearInterval(timer)
      setShown(false)
      router.refresh()
    }, 3000)
    return () => { stopped = true; clearInterval(timer) }
  }, [watching, state, waiting, router])

  const copyLink = async () => {
    await navigator.clipboard.writeText(agentInvitePaste(state.link))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  if (state?.link && shown) {
    return (
      <div className='stack notice'>
        <b>Paste this into your AI.</b>
        <code style={{ wordBreak: 'break-all' }}>{agentInvitePaste(state.link)}</code>
        <div className='row'>
          <button type='button' className='btn primary' onClick={copyLink}>{copied ? 'Copied' : 'Copy'}</button>
          <button type='button' className='btn ghost' onClick={() => setShown(false)}>Done</button>
        </div>
        <p className='muted'>It works once, within an hour. Anyone with the link can use it, so only give it to your own AI.</p>
      </div>
    )
  }
  return (
    <form action={formAction} className='stack' onSubmit={() => setShown(true)}>
      {slug && <input type='hidden' name='slug' value={slug} />}
      {forOrg && <OrgChoices roles={roles || []} teams={teams || []} />}
      <div className='row'><button className='btn primary' disabled={pending}>{pending ? 'Making a link…' : 'Invite an agent'}</button></div>
      {state?.error && <p className='notice bad'>{state.error}</p>}
    </form>
  )
}
