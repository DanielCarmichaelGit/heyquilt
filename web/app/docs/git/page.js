import DocHero from '@/components/DocHero.js'
import Mark from '@/components/Mark.js'
import GitLogo, { GIT_PATH, GIT_RED } from '@/components/GitLogo.js'
import DownloadButtons from '@/components/DownloadButtons.js'
import { quiltMark } from '@/lib/mark.js'
import { GIT_GROUPS, GIT_NEVER } from '@/lib/git-ops.js'

// Fully static. How Quilt's lightweight git layer handles git in a synced folder: it reads git,
// never writes it. Keep this in step with src/gitstate.js and RELEASES.md (0.3.10 on).
export const metadata = { title: 'Git in Quilt' }

// The Q on its own, for drawing inside the diagrams' SVG.
const Q_INNER = quiltMark({ word: false }).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '')
function QIn ({ x, y, size }) {
  return <svg x={x} y={y} width={size} height={size} viewBox='8 18 108 100' aria-hidden='true' dangerouslySetInnerHTML={{ __html: Q_INNER }} />
}

const PROMISES = [
  ['c', 'Reads git, never writes it', 'No commits, pushes or branch changes, ever.', <><path d='M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z' /><circle cx='12' cy='12' r='3' /></>],
  ['b', 'Nothing to manage', 'No setup, no settings, nothing to remember.', <path d='M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1' />],
  ['a', 'Git or no git', 'Folders without git, and cloud agents, sync just the same.', <path d='M3 6.5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' />]
]

const BRANCH_STEPS = [
  ['Check out another branch', 'That folder pauses, so your feature branch never leaks into everyone else\'s main.'],
  ['Everyone else keeps going', "Partners on main carry on live. Your top bar names the branch you're on."],
  ['Come back, catch up', 'Switch back and your folder rejoins, merging in what the room did while you were away.']
]

function Folder ({ x, name, tool, branch, color, agent }) {
  return (
    <g>
      <rect x={x} y='150' width='160' height='84' rx='14' fill='var(--panel)' stroke='var(--border)' />
      <rect x={x} y='150' width='160' height='6' rx='3' fill={color} />
      <text x={x + 16} y='182' className='f-b'>{name}</text>
      {agent && <><rect x={x + 62} y='171' width='42' height='16' rx='8' fill='var(--qm-d)' /><text x={x + 69} y='183' className='f-xs'>Agent</text></>}
      <text x={x + 16} y='200' className='f-s'>{tool}</text>
      <text x={x + 16} y='220' className={branch ? 'f-m f-ok' : 'f-m'}>{branch ? `⎇ ${branch}` : 'no git, still live'}</text>
    </g>
  )
}

function LayersFigure () {
  return (
    <svg className='fig' viewBox='0 0 560 430' role='img' aria-labelledby='layers-t'>
      <title id='layers-t'>A Quilt session keeps three folders live: yours in Claude Code, Sam's in Cursor, and Larry the agent's in the cloud. Below the line, each computer commits, pushes and pulls with origin in git, as usual.</title>
      <defs><marker id='ah' viewBox='0 0 10 10' refX='8' refY='5' markerWidth='7' markerHeight='7' orient='auto-start-reverse'><path d='M0 0L10 5L0 10z' fill='var(--muted)' /></marker></defs>
      <text x='0' y='14' className='f-cap'>LIVE · EVERY EDIT, IN SECONDS</text>
      <rect x='180' y='30' width='200' height='54' rx='27' fill='var(--panel-2)' stroke='var(--border-strong)' />
      <QIn x={192} y={37} size={40} />
      <text x='240' y='54' className='f-b'>Quilt session</text>
      <text x='240' y='71' className='f-s'>relay.heyquilt.com</text>
      <g fill='none' strokeWidth='4' strokeLinecap='round'>
        <path d='M215 84 C 180 110, 95 110, 90 150' stroke='var(--qm-a)' />
        <path d='M280 84 L 280 150' stroke='var(--qm-c)' />
        <path d='M345 84 C 380 110, 465 110, 470 150' stroke='var(--qm-d)' />
      </g>
      <g className='fig-pulse' fill='var(--text)'><circle cx='128' cy='109' r='3.5' /><circle cx='280' cy='117' r='3.5' /><circle cx='432' cy='109' r='3.5' /></g>
      <Folder x={10} name='Your folder' tool='Claude Code' branch='main' color='var(--qm-a)' />
      <Folder x={200} name="Sam's folder" tool='Cursor' branch='main' color='var(--qm-c)' />
      <Folder x={390} name='Larry' tool='Codex, in the cloud' color='var(--qm-d)' agent />
      <line x1='0' y1='262' x2='560' y2='262' stroke='var(--border-strong)' strokeDasharray='4 6' />
      <text x='560' y='284' textAnchor='end' className='f-cap'>HISTORY · ON EACH COMPUTER</text>
      <g fill='none' stroke='var(--muted)' strokeWidth='1.6' strokeDasharray='5 5'>
        <path d='M90 236 C 90 320, 170 352, 196 360' markerEnd='url(#ah)' />
        <path d='M330 356 C 350 320, 320 280, 290 238' markerEnd='url(#ah)' />
      </g>
      <text x='0' y='318' className='f-m'>commit · push</text>
      <text x='346' y='318' className='f-m'>pull</text>
      <rect x='200' y='340' width='160' height='58' rx='14' fill='var(--panel)' stroke='var(--border-strong)' />
      <g transform='translate(214 354) scale(.33)'><path fill={GIT_RED} d={GIT_PATH} /></g>
      <text x='254' y='366' className='f-b'>origin</text>
      <text x='254' y='384' className='f-s'>GitHub, GitLab…</text>
      <rect x='10' y='404' width='540' height='24' rx='12' fill='#f1ebff' />
      <text x='280' y='420' textAnchor='middle' className='f-s f-violet'>Quilt's git layer reads each folder's git, so pulls and stashes are never sent as edits</text>
    </svg>
  )
}

function BranchFigure () {
  return (
    <svg className='fig' viewBox='0 0 560 320' role='img' aria-labelledby='branch-t'>
      <title id='branch-t'>You check out feature/x and your folder pauses while Sam keeps editing main live. When you check out main again, Sam's changes are merged into your folder line by line.</title>
      <rect x='118' y='2' width='174' height='26' rx='8' fill='var(--text)' /><text x='130' y='19' className='f-m f-inv'>git checkout feature/x</text>
      <path d='M205 28 L 205 44' stroke='var(--text)' strokeWidth='1.5' />
      <rect x='374' y='2' width='132' height='26' rx='8' fill='var(--text)' /><text x='386' y='19' className='f-m f-inv'>git checkout main</text>
      <path d='M440 28 L 440 44' stroke='var(--text)' strokeWidth='1.5' />
      <text x='0' y='62' className='f-m f-ok'>main</text>
      <line x1='70' y1='58' x2='550' y2='58' stroke='var(--qm-c)' strokeWidth='6' strokeLinecap='round' />
      <text x='0' y='182' className='f-m f-violet'>feature/x</text>
      <path d='M205 58 C 235 58, 235 178, 270 178 L 370 178 C 410 178, 410 58, 440 58' fill='none' stroke='var(--qm-d)' strokeWidth='6' strokeLinecap='round' strokeDasharray='1 11' />
      <g stroke='var(--panel)' strokeWidth='2'>
        {[250, 290, 330, 370, 410].map((x) => <circle key={x} cx={x} cy='58' r='7' fill='var(--qm-c)' />)}
        {[110, 160, 480, 520].map((x) => <circle key={x} cx={x} cy='58' r='7' fill='var(--qm-a)' />)}
      </g>
      <text x='252' y='100' className='f-s'>Sam keeps editing main</text>
      <rect x='252' y='160' width='128' height='36' rx='18' fill='#f1ebff' stroke='var(--qm-d)' />
      <text x='316' y='183' textAnchor='middle' className='f-s f-violet'>your folder · paused</text>
      <path d='M440 64 L 440 232' stroke='var(--ok)' strokeWidth='1.5' strokeDasharray='3 4' />
      <rect x='330' y='232' width='226' height='64' rx='14' fill='#e3f6ee' />
      <text x='346' y='257' className='f-b f-ok'>Back on main</text>
      <text x='346' y='277' className='f-s f-ok'>Sam's 5 changes merged in</text>
      <circle cx='16' cy='255' r='6' fill='var(--qm-a)' /><text x='28' y='259' className='f-s'>your edits</text>
      <circle cx='16' cy='279' r='6' fill='var(--qm-c)' /><text x='28' y='283' className='f-s'>Sam's edits</text>
      <line x1='10' y1='303' x2='24' y2='303' stroke='var(--qm-d)' strokeWidth='5' strokeDasharray='1 5' strokeLinecap='round' /><text x='28' y='307' className='f-s'>your feature/x work, kept on your computer</text>
    </svg>
  )
}

export default function GitDocs () {
  return (
    <>
      <DocHero
        title='Git in Quilt'
        logos={<><Mark word={false} /><span className='doc-hero-x'>works with</span><GitLogo size={38} label='Git' /></>}
        links={[['how', 'How it fits'], ['operations', 'Every operation'], ['branches', 'Branches'], ['commits', 'Commits and pulls'], ['github', 'Start from GitHub']]}
      >
        <p>Git keeps the history; Quilt keeps everyone in step. Quilt runs a lightweight git layer in every folder, so a pull, a stash or a branch switch on one computer never scrambles anyone else's work.</p>
        <p>Nobody has to manage it. This page covers what the layer reads, every git operation it handles, how it respects branches, and how commits fit in.</p>
      </DocHero>

      <section className='doc-sec' id='how'>
        <div className='git-how'>
          <div>
            <h2>Two layers, one folder</h2>
            <p className='sub'>Above the line, Quilt carries every edit between everyone in seconds, AIs and cloud agents included. Below it, git works the way it always has: each person commits, pushes and pulls on their own computer.</p>
            <div className='promises'>
              {PROMISES.map(([patch, title, text, icon]) => (
                <div key={title} className='promise'>
                  <span className='promise-ic' style={{ background: `var(--qm-${patch})` }}><svg viewBox='0 0 24 24' aria-hidden='true'>{icon}</svg></span>
                  <div><b>{title}</b><span>{text}</span></div>
                </div>
              ))}
            </div>
          </div>
          <div className='fig-wrap'>
            <div className='quilt-patch' aria-hidden='true' />
            <div className='fig-card'><LayersFigure /></div>
          </div>
        </div>
      </section>

      <section className='git-band'>
        <div>
          <h2>A lightweight git layer, built in</h2>
          <p>Each folder in a session has Quilt's git layer watching it. It asks git what just happened (an edit, a pull, a stash, a branch switch) and handles it, so the session's work stays apart from what git did on one computer. You keep using git exactly as you do now.</p>
          <p className='git-band-l'>All it reads</p>
          <div className='git-band-reads'><code>HEAD</code><code>git status</code><code>a file at a commit</code><code>merge or rebase in progress</code><code>.gitignore</code></div>
        </div>
        <ul className='git-never'>
          {GIT_NEVER.map((n) => <li key={n}>{n}</li>)}
          <li className='only'><span>The one change it makes: <code>.quilt/</code> in your .gitignore</span></li>
        </ul>
      </section>

      <section className='doc-sec' id='operations'>
        <h2>Every git operation, handled</h2>
        <p className='sub'>Run any of these on your computer, or let your AI run them. Here is what happens for everyone else in the session.</p>
        {GIT_GROUPS.map((g) => (
          <div key={g.id} className='ops-group'>
            <div className='ops-h'><i style={{ background: `var(--qm-${g.patch})` }} aria-hidden='true' /><h3>{g.title}</h3><span>{g.note}</span></div>
            <div className='ops'>
              {g.ops.map((op) => (
                <div key={op.cmds.join()} className='op'>
                  <div className='op-cmds'>{op.cmds.map((c) => <code key={c}>{c}</code>)}</div>
                  <span className={`op-tag ${op.kind}`}>{op.tag}</span>
                  <p className='op-text'>{op.text}{op.more && <span> {op.more}</span>}</p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className='doc-sec git-branches' id='branches'>
        <div>
          <h2>Branches never mix</h2>
          <p className='sub'>A session is one shared folder, and git says which branch it is on. Quilt follows what git says, computer by computer.</p>
          <ol className='branch-steps'>
            {BRANCH_STEPS.map(([title, text], i) => <li key={title}><span className='n'>{i + 1}</span><div><b>{title}</b><span>{text}</span></div></li>)}
          </ol>
          <div className='soon'><span className='pill'>Coming soon</span><p><b>One live copy per branch.</b> Each branch gets its own live session, so you can work with whoever is on feature/x while main carries on.</p></div>
        </div>
        <div className='fig-card'>
          <BranchFigure />
          <div className='topbar'><span>⎇ <code>feature/x</code> · paused until you're back on <code>main</code></span><span>git is busy…</span></div>
        </div>
      </section>

      <section className='doc-sec git-two' id='commits'>
        <div>
          <h3>Ask for a commit</h3>
          <p className='muted'>Any AI in the session can ask for a commit when work is ready. Whoever commits marks it done, and the request closes for everyone.</p>
          <div className='chat-mock' role='img' aria-label='Larry the agent says the hero copy and pricing table are ready to commit and asks with quilt_request_commit. You commit them and mark the request done.'>
            <div className='msg'><span className='av' style={{ background: 'var(--qm-d)' }}>L</span><div><b>Larry</b><span className='badge'>Agent</span><br />Hero copy and pricing table are done, ready to commit.<br /><span className='tool'>quilt_request_commit</span></div></div>
            <div className='msg'><span className='av' style={{ background: 'var(--qm-a)' }}>D</span><div><b>You</b><br /><code>git commit -m &quot;Hero copy, pricing table&quot;</code><br /><span className='tool done'>✓ quilt_commit_request_done</span></div></div>
          </div>
        </div>
        <div>
          <h3>Pull past the session's files</h3>
          <p className='muted'>When a teammate commits files the session already gave you, git refuses to pull. Quilt names the files and gives your AI the one line that works, without removing them for anyone else.</p>
          <pre className='term' aria-label='A terminal: git pull fails because untracked files would be overwritten; Quilt says both match the commit, and rm with git pull --autostash fast-forwards.'><code>
            <span className='t-p'>$</span> git pull{'\n'}
            <span className='t-r'>error:</span> untracked working tree files would be overwritten:{'\n'}
            {'  '}src/hero.js  src/pricing.js{'\n'}
            <span className='t-d'># Quilt: both match the commit. Pull with:</span>{'\n'}
            <span className='t-p'>$</span> <span className='t-y'>rm src/hero.js src/pricing.js &amp;&amp; git pull --autostash</span>{'\n'}
            <span className='t-d'>Fast-forward, 2 files changed</span>
          </code></pre>
        </div>
      </section>

      <section className='doc-sec' id='github'>
        <div className='git-gh'>
          <div>
            <h2>Start a session from GitHub</h2>
            <p className='sub'>Pick a repository and a branch, or name a new one, and Quilt clones it once for you. From then on it's a folder like any other, and git is yours.</p>
          </div>
          <div className='dlg' role='img' aria-label='The New session dialog on its GitHub tab: repository acme/landing-page, branch main, and a Start session button.'>
            <div className='dlg-tabs'><span>Folder</span><span className='on'>GitHub</span></div>
            <div className='dlg-body'>
              <div className='fld'><span>Repository</span><div><GitLogo size={16} /> acme/landing-page</div></div>
              <div className='fld'><span>Branch</span><div>⎇ main</div></div>
              <div className='dlg-go'><span className='btn primary'>Start session</span></div>
            </div>
          </div>
        </div>
      </section>

      <section className='git-close'>
        <div className='quilt-patch' aria-hidden='true' />
        <div className='quilt-stitch' aria-hidden='true' />
        <div className='git-close-in'>
          <div className='doc-hero-logos'><Mark word={false} /><span className='doc-hero-x'>+</span><GitLogo size={34} /></div>
          <h2>Keep git. Add everyone.</h2>
          <p className='muted'>Free for everything on your own network.</p>
          <DownloadButtons />
        </div>
      </section>
    </>
  )
}
