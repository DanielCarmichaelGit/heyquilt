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
          <input className='input' name='description' placeholder='What it is for (optional)' maxLength={500} aria-label='Description' />
          <select className='input' name='color' defaultValue='lilac' aria-label='Colour'>
            {['lilac', 'mint', 'peach', 'rose', 'periwinkle', 'sky'].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <button className='btn primary'>Create</button>
        </form>)}
    </div>
  )
}
