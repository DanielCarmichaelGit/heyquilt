import Link from 'next/link'

const COVERS = { lilac: '#d9c6ea', mint: '#cfe6d4', peach: '#f6dcc0', rose: '#f3d3d0', periwinkle: '#e0dcf0', sky: '#cfe0ee' }

/** One workspace as a card, like the app's grid. `href` is the workspace's page. */
export default function WorkspaceCard ({ w, href }) {
  const initial = [...(w.name || '?')][0].toUpperCase()
  return (
    <Link href={href} className='card ws-card' style={{ textDecoration: 'none', color: 'inherit', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ height: 56, background: COVERS[w.color] || COVERS.lilac, position: 'relative' }}>
        <span style={{ position: 'absolute', left: 12, top: 12, width: 32, height: 32, borderRadius: 8, background: 'rgba(255,255,255,.85)', display: 'grid', placeItems: 'center', fontWeight: 700 }}>{initial}</span>
        {w.counts?.open > 0 && <span className='pill' style={{ position: 'absolute', right: 10, top: 10 }}>{w.counts.open} open</span>}
      </div>
      <div className='stack' style={{ padding: '14px 16px', gap: 6, flex: 1 }}>
        <b style={{ fontSize: 16 }}>{w.name} <span className='pill'>{w.space?.kind === 'org' ? w.space.name : 'Personal'}</span></b>
        <span className='muted'>{w.description || ''}</span>
        <span className='muted' style={{ fontSize: 12 }}>{w.counts?.sessions ?? 0} sessions · {w.counts?.members ?? 0} members{w.archivedAt ? ' · archived' : ''}</span>
      </div>
    </Link>
  )
}
