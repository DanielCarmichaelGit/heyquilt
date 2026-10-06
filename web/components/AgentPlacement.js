'use client'
import { useActionState, useState } from 'react'
import { reachOptions, REACH_HINTS, JOINS_OPTIONS, placementOf, placementChoices } from '@/lib/agent-placement.js'

/**
 * Where an agent works: Available in (only where it is added, every workspace, or the ones
 * ticked) and Joins (when invited, or every session as it starts). `agent.placement` is what
 * the API has; `workspaces` are the ones it can be placed in. Access and folder limits aren't
 * shown here and go back as they were, as do ticked workspaces this person can't see.
 */
export default function AgentPlacement ({ agent, workspaces, action, slug, allLabel }) {
  const place = placementOf(agent.placement)
  const { shown, hidden } = placementChoices(agent.placement, workspaces)
  const [state, formAction, pending] = useActionState(action, null)
  const [reach, setReach] = useState(place.reach)
  // "Saved." is about what was sent: any change after it hides it until the next save.
  const [changed, setChanged] = useState(false)
  const key = `place-${agent.id}`
  return (
    <form action={(data) => { setChanged(false); return formAction(data) }} onChange={() => setChanged(true)} className='stack' style={{ gap: 8 }}>
      {slug && <input type='hidden' name='slug' value={slug} />}
      <input type='hidden' name='id' value={agent.id} />
      <input type='hidden' name='access' value={place.access} />
      {place.scopes.map((s) => <input key={s} type='hidden' name='scope' value={s} />)}
      {reach === 'workspaces' && hidden.map((id) => <input key={id} type='hidden' name='workspaceId' value={id} />)}
      <fieldset className='choice'>
        <legend>Available in</legend>
        {reachOptions(allLabel).map(([value, label]) => (
          <label key={value}>
            <input type='radio' name='reach' value={value} checked={reach === value} onChange={() => setReach(value)} /> {label}
          </label>))}
      </fieldset>
      {reach === 'workspaces'
        ? (
          <fieldset className='choice'>
            <legend>Workspaces</legend>
            {!shown.length && <span className='muted'>Make a workspace first.</span>}
            {shown.map((w) => (
              <label key={w.id}>
                <input type='checkbox' name='workspaceId' value={w.id} defaultChecked={place.workspaceIds.includes(w.id)} /> {w.name}
              </label>))}
          </fieldset>)
        : <span className='muted'>{REACH_HINTS[reach]}</span>}
      <div className='row'>
        <label htmlFor={`${key}-joins`} className='muted'>Joins</label>
        {/* Joins means nothing for an agent that is only where it is added: kept as it was. */}
        {reach === 'manual' && <input type='hidden' name='sessions' value={place.sessions} />}
        <select id={`${key}-joins`} className='input' name='sessions' defaultValue={place.sessions} disabled={reach === 'manual'} aria-label={`When ${agent.name} joins sessions`}>
          {JOINS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <button className='btn ghost' disabled={pending}>{pending ? 'Saving…' : 'Save'}</button>
        {state?.saved && !pending && !changed && <span className='muted'>Saved.</span>}
      </div>
      {state?.error && <p className='notice bad'>{state.error}</p>}
    </form>
  )
}
