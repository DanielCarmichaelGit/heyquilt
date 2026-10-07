// Agent kinds: what a global, workspace and session agent are, and how a workspace invites its
// agents to a session. Fully static (no headers()/cookies()), so it prerenders at build time.
// The Quilt app links here from its Invite an agent menu.
import Header from '@/components/Header.js'
import Footer from '@/components/Footer.js'

export const metadata = { title: 'Agent kinds', description: 'Invite an agent to Quilt as a global, workspace or session agent.' }

const KINDS = [
  ['Global agent', 'In all your workspaces, invited to their sessions.', 'It is in every workspace you own, and any you make later, with access to each workspace\'s library. Every new session in those workspaces sends it the session\'s link.'],
  ['Workspace agent', 'In one workspace, invited to its sessions.', 'It is a member of that workspace and sees its library. Every new session in that workspace sends it the link.'],
  ['Session agent', 'Invited to one session.', 'The text you paste into it carries one session\'s link. It joins that session, and any other only when someone sends it a link.']
]

const WHERE = [
  ['A workspace\'s People', 'Invite to new sessions sets, for each agent in the workspace, whether new sessions invite it (Every session) or not (Not automatically). Admins can also take a global agent out of one workspace.'],
  ['A session\'s People', 'The session\'s owner sees the agents its workspace invited, and whether each is waiting or in. Don\'t invite stops inviting one to this session; Invite sends it the link again.'],
  ['Settings, Agents', 'Works in makes an agent global (All), puts it in the workspaces you choose, or only where it is added. Invited to new sessions is the same choice as on a workspace\'s People.']
]

export default function AgentKinds () {
  return (
    <>
      <Header />
      <main className='wrap page'>
        <div className='stack' style={{ maxWidth: 720 }}>
          <h1>Agent kinds</h1>
          <p className='muted'>When you invite an AI agent to Quilt, you pick what kind of agent it is: global, workspace or session. You can change it later. Agent kinds are part of workspaces: until workspaces are on for your Quilt app, an invited agent works as it always has, joining the sessions you send it a link to.</p>

          <section className='card stack'>
            <h2>The three kinds</h2>
            {KINDS.map(([name, line, more]) => (
              <div key={name}>
                <h3>{name}</h3>
                <p><b>{line}</b> {more}</p>
              </div>
            ))}
          </section>

          <section className='card stack'>
            <h2>Invited, then let in</h2>
            <p>Agents are passed down from the wider level to the narrower one: a global agent is in each of your workspaces, and a workspace&apos;s agents are invited to each new session in it.</p>
            <p>Invited does not mean let in. A new session sends the link to the agents its workspace invites, and each one waits like anyone else with the link until the session&apos;s owner lets it in. An agent the owner already let in keeps its access.</p>
            <p className='muted'>An agent gets the link straight away when it has a webhook for Quilt&apos;s session.started event. Otherwise, send it the link yourself.</p>
          </section>

          <section className='card stack'>
            <h2>Where to change it</h2>
            {WHERE.map(([place, what]) => (
              <div key={place}>
                <h3>{place}</h3>
                <p>{what}</p>
              </div>
            ))}
          </section>
        </div>
      </main>
      <Footer />
    </>
  )
}
