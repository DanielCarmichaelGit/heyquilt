export default function Footer () {
  return (
    <footer className='site-footer'>
      <div className='wrap row' style={{ justifyContent: 'space-between' }}>
        <span>Quilt: build one project together, everyone in their own AI.</span>
        <span className='row' style={{ gap: 16 }}>
          <a href='/docs'>Docs</a>
          <a href='/blog'>Blog</a>
          <a href='/terms'>Terms</a>
          <a href='https://github.com/DanielCarmichaelGit/heyquilt'>GitHub</a>
        </span>
      </div>
    </footer>
  )
}
