import { viaLabel, joinsText, JOINS_OPTIONS } from '@/lib/agent-placement.js'

/** The hidden fields every form here sends: the workspace, and the org for an org's page. */
function Hidden ({ id, slug, children }) {
  return (
    <>
      {slug && <input type='hidden' name='slug' value={slug} />}
      <input type='hidden' name='id' value={id} />
      {children}
    </>
  )
}

function JoinsSelect ({ a }) {
  return (
    <select className='input' name='sessions' defaultValue={a.sessions} aria-label={`When ${a.name} joins sessions here`}>
      {JOINS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select>
  )
}

/**
 * A workspace's agents with why each is here: added to this workspace, or placed here by its
 * owner (or the org). Admins set Joins: an added agent's own setting (with its access), or the
 * workspace's say over a placed one, which they can also keep out of this workspace and let
 * back in. `actions` are the page's server actions.
 */
export default function WorkspaceAgents ({ agents, admin, orgName = '', id, slug, actions }) {
  const { setMember, removeMember, setAgentJoins, keepAgentOut, letAgentBackIn } = actions
  return (
    <section className='card stack'>
      <h2>Agents</h2>
      {!agents.length && <p className='muted'>No agents yet.</p>}
      {agents.map((a) => {
        const member = a.via === 'member'
        return (
          <div key={a.account} className='list-row'>
            <span>
              <b>{a.name}</b> <span className='pill'>Agent</span> <span className='pill'>{viaLabel(a, orgName)}</span>
              <br />
              <span className='muted'>
                {a.provider ? `${a.provider} · ` : ''}
                {a.excluded ? 'Not in this workspace' : `${a.access === 'edit' ? 'Can edit' : 'View only'} · ${joinsText(a.sessions)}`}
              </span>
            </span>
            {admin && member && (
              <span className='row'>
                <form action={setMember} className='row'>
                  <Hidden id={id} slug={slug}><input type='hidden' name='account' value={a.account} /></Hidden>
                  <select className='input' name='access' defaultValue={a.access} aria-label={`Access for ${a.name}`}>
                    <option value='edit'>Edit</option>
                    <option value='view'>View</option>
                  </select>
                  <JoinsSelect a={a} />
                  <button className='btn ghost'>Save</button>
                </form>
                <form action={removeMember}>
                  <Hidden id={id} slug={slug}><input type='hidden' name='account' value={a.account} /></Hidden>
                  <button className='btn ghost danger'>Remove</button>
                </form>
              </span>)}
            {admin && !member && !a.excluded && (
              <span className='row'>
                <form action={setAgentJoins} className='row'>
                  <Hidden id={id} slug={slug}><input type='hidden' name='agentId' value={a.agentId} /></Hidden>
                  <JoinsSelect a={a} />
                  <button className='btn ghost'>Save</button>
                </form>
                <form action={keepAgentOut}>
                  <Hidden id={id} slug={slug}><input type='hidden' name='agentId' value={a.agentId} /></Hidden>
                  <button className='btn ghost danger' title='It keeps its other workspaces, and you can let it back in here.'>Not in this workspace</button>
                </form>
              </span>)}
            {admin && a.excluded && (
              <form action={letAgentBackIn}>
                <Hidden id={id} slug={slug}><input type='hidden' name='agentId' value={a.agentId} /></Hidden>
                <button className='btn ghost'>Let back in</button>
              </form>)}
          </div>
        )
      })}
    </section>
  )
}
