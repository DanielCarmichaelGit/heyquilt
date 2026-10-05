import WorkspaceCard from './WorkspaceCard.js'

/** A grid of workspace cards and, when `create` is given, a New workspace form card. */
export default function WorkspaceList ({ workspaces, hrefFor, create, orgSlug = '' }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
      {workspaces.map((w) => <WorkspaceCard key={w.id} w={w} href={hrefFor(w)} />)}
      {create && (
        <form action={create} className='card stack' style={{ padding: 16, borderStyle: 'dashed', boxShadow: 'none' }}>
          {orgSlug && <input type='hidden' name='slug' value={orgSlug} />}
          <b>New workspace</b>
          <input className='input' name='name' placeholder='Name' maxLength={80} required aria-label='Workspace name' />
          <span className='muted'>Colour and a description can be set once it exists.</span>
          <button className='btn primary'>Create</button>
        </form>)}
    </div>
  )
}
