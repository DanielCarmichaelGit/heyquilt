import Link from 'next/link'
import DocHero from '@/components/DocHero.js'
import Mark from '@/components/Mark.js'
import { CLI_GROUPS, CLI_ENV } from '@/lib/docs.js'

// Fully static: the CLI reference, from lib/docs.js (a test keeps it in step with `quilt --help`).
export const metadata = { title: { absolute: 'Command line · Quilt docs' } }

const INSTALL = [
  ['Mac and Windows', <>Install the app from the <Link href='/'>download page</Link>, then choose <b>Quilt → Install the Quilt Command…</b> to put <code>quilt</code> on your PATH.</>],
  ['Linux, servers and cloud machines', <>One line installs the command line with its own Node.js. Run it again to update.</>, 'curl -fsSL https://github.com/DanielCarmichaelGit/heyquilt/releases/latest/download/install.sh | sh']
]

function Command ({ c }) {
  return (
    <article className='cmd' id={`cmd-${c.name}`}>
      <div className='cmd-top'>
        <h3><code>quilt {c.name}</code></h3>
        <a className='cmd-anchor' href={`#cmd-${c.name}`} aria-label={`Link to quilt ${c.name}`}>#</a>
      </div>
      {c.usage !== `quilt ${c.name}` && <pre className='cmd-usage'><code>{c.usage}</code></pre>}
      <p>{c.text}</p>
      {c.flags && (
        <dl className='cmd-flags'>
          {c.flags.map(([flag, text]) => (
            <div key={flag}><dt><code>{flag}</code></dt><dd>{text}</dd></div>
          ))}
        </dl>
      )}
      {c.example && <pre className='cmd-example'><code><span aria-hidden='true'>$ </span>{c.example}</code></pre>}
      {c.also && <p className='muted cmd-also'>{c.also}</p>}
    </article>
  )
}

export default function CliDocs () {
  return (
    <>
      <DocHero
        title='The quilt command line'
        logos={<span className='doc-cli-logo'><Mark word={false} /><code>&gt;_</code></span>}
        links={[['install', 'Install'], ...CLI_GROUPS.map((g) => [g.id, g.title]), ['env', 'Environment']]}
      >
        <p>Everything the Quilt app does, from a terminal: sign in, start or join a session, chat, claim files, read the history, and bring in AIs and agents.</p>
        <p>Use it on a server or a cloud machine with no desktop, in scripts, or wherever you'd rather type than click. Run <code>quilt --help</code> for the short version.</p>
      </DocHero>

      <section className='doc-sec' id='install'>
        <h2>Install</h2>
        <div className='install'>
          {INSTALL.map(([title, text, cmd]) => (
            <div key={title} className='install-card'>
              <h3>{title}</h3>
              <p>{text}</p>
              {cmd && <pre className='cmd-example'><code><span aria-hidden='true'>$ </span>{cmd}</code></pre>}
            </div>
          ))}
        </div>
        <p className='muted doc-note'>Then sign in with <code>quilt login</code>, and run <code>quilt join</code> in a project folder to start a session.</p>
      </section>

      {CLI_GROUPS.map((g) => (
        <section key={g.id} className='doc-sec' id={g.id}>
          <h2>{g.title}</h2>
          <p className='sub'>{g.text}</p>
          <div className='cmds'>{g.commands.map((c) => <Command key={c.name} c={c} />)}</div>
        </section>
      ))}

      <section className='doc-sec' id='env'>
        <h2>Environment</h2>
        <p className='sub'>Nothing needs setting for everyday use. These are for debugging and for running your own relay.</p>
        <dl className='cmd-flags env'>
          {CLI_ENV.map(([name, text]) => <div key={name}><dt><code>{name}</code></dt><dd>{text}</dd></div>)}
        </dl>
      </section>
    </>
  )
}
