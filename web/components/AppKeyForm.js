'use client'
import { useActionState, useState } from 'react'

/**
 * Makes an app key (qk_) and shows it once, with Copy. `agentId` set: another key for
 * that agent. Without it: connect an app, which makes a new agent named for it.
 */
export default function AppKeyForm ({ action, agentId, label = 'Connect', placeholder = 'Pipedream', defaultName = '' }) {
  const [state, formAction, pending] = useActionState(action, null)
  const [shown, setShown] = useState(true)
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    await navigator.clipboard.writeText(state.key)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  if (state?.key && shown) {
    return (
      <div className='stack notice'>
        <b>{state.agent}’s app key</b>
        <code style={{ overflowWrap: 'anywhere', display: 'block' }}>{state.key}</code>
        <div className='row'>
          <button type='button' className='btn primary' onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
          <button type='button' className='btn ghost' onClick={() => setShown(false)}>Done</button>
        </div>
        <p className='muted'>Paste it into the app as its Quilt API key. It is shown once and works until you revoke it here, so keep it out of chats and code. Apps that speak MCP can also use it as <code>Authorization: Bearer &lt;key&gt;</code> at <code>{state.mcp}</code>.</p>
      </div>
    )
  }
  return (
    <form action={formAction} className='stack' onSubmit={() => setShown(true)}>
      {agentId && <input type='hidden' name='agentId' value={agentId} />}
      <div className='row'>
        <input className='input' name='name' required maxLength={40} defaultValue={defaultName} placeholder={placeholder} aria-label={agentId ? 'Key name' : 'App name'} style={{ flex: '1 1 160px' }} />
        <button className={agentId ? 'btn ghost' : 'btn primary'} disabled={pending}>{pending ? 'Making a key…' : label}</button>
      </div>
      {state?.error && <p className='notice bad'>{state.error}</p>}
    </form>
  )
}
