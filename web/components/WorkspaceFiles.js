import { formatBytes, fileRows } from '@/lib/files-view.js'
import { when } from '@/lib/org-view.js'

/** The workspace's files, download only: uploads happen in the app. */
export default function WorkspaceFiles ({ files, usage, downloadHref }) {
  const rows = fileRows(files)
  return (
    <section className='card stack'>
      <h2>Files</h2>
      {usage && <p className='muted'>{formatBytes(usage.usedBytes)} of {formatBytes(usage.quotaBytes)} used · {usage.fileCount} {usage.fileCount === 1 ? 'file' : 'files'}</p>}
      {!rows.length && <p className='muted'>No files yet. Upload from the app.</p>}
      <div>
        {rows.map((f) => (
          <div key={f.id} className='list-row'>
            <span className='stack' style={{ gap: 2 }}>
              <b>{f.name}{f.folder && <span className='muted'> · {f.folder}</span>} {f.version > 1 && <span className='pill'>v{f.version}</span>}</b>
              <span className='muted'>{formatBytes(f.size)} · {f.uploadedBy?.split(':')[0] || 'someone'} · {when(f.uploadedAt)}{f.note ? ` · ${f.note}` : ''}</span>
            </span>
            <a className='btn' href={downloadHref(f)}>Download</a>
          </div>))}
      </div>
    </section>
  )
}
