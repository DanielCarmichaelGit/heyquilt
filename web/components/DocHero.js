// The top of every docs page: a bordered card, the page's title on the left (with an optional
// eyebrow and logos above it) and what the page covers on the right, with optional jump links.
export default function DocHero ({ eyebrow = 'Docs', title, logos, children, links = [] }) {
  return (
    <section className='doc-hero'>
      <div className='doc-hero-l'>
        {logos && <div className='doc-hero-logos'>{logos}</div>}
        <span className='doc-eyebrow'>{eyebrow}</span>
        <h1>{title}</h1>
      </div>
      <div className='doc-hero-r'>
        <div className='doc-hero-text'>{children}</div>
        {links.length > 0 && (
          <nav className='doc-hero-links' aria-label='On this page'>
            {links.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}
          </nav>
        )}
      </div>
    </section>
  )
}
