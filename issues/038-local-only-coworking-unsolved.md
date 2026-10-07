# 038: A local-only (free) Quilt has no answer for coworking between people or for tracking it

**Status:** Open · **Reported:** 2026-10-07 · **Seen on:** product plan, not a running build

## What happens
The plan is for the free version to be local only: agents run on your own
computer and talk through a relay on that computer, so they can coordinate
(claims, file queue, tasks, chat) without touching our servers. Paid users get
a shared relay we host, plus agents that keep working when your computer is off
(see `docs/hosted-agents-costs.md`).

That works for one person and their agents. It leaves open:

1. **Two people on the free version.** A relay on one person's laptop is only
   reachable from that machine (or its LAN). Their partner can't connect
   unless one of them exposes it (port forward, tunnel, Tailscale), and the
   session stops when the host's laptop sleeps.
2. **Tracking.** Today the hosted relay reports presence to the accounts API
   (`QUILT_API_URL`, `RELAY_API_SECRET`), which feeds dashboards, session
   history and the "who is in which session" views. A local relay has neither
   secret, so none of that exists for free users, and we can't tell how many
   free sessions, agents or people there are.
3. **Identity.** The hosted relay checks passes signed by the accounts API. A
   local relay either trusts everyone on the machine (fine for one person) or
   needs the API's public key and a network connection to check passes from
   other people.
4. **Moving up.** A free local session someone upgrades should move to the
   hosted relay with its history, tasks and claims, not start over.

## What should happen
Decide what "free" means for more than one person before we build the local
relay as a product, and decide what (if anything) a local relay reports home.

## What we know
- A local relay already runs for development: `quilt serve` (`bin/quilt.js`)
  with `QUILT_SERVER=ws://localhost:<port>`. `src/settings.js` only lets the
  app use Quilt's own relay outside development, and `src/runner.js` refuses
  links to other relays on purpose (a crafted link must not hand this
  computer's pass and files to someone else's relay).
- The relay is one Node process with a data folder; it needs nothing hosted
  except for sign-in passes, presence reports and Supabase file storage, all
  optional.

## Likely options
- **Free is solo (plus your own agents); people need paid.** Simplest, and
  the line is easy to explain. Coworking is the thing worth paying for.
- **Free allows peers through a tunnel or LAN** the host sets up, with the
  host's relay checking passes against the API's public key. Costs us nothing
  but support.
- **Free gets a small hosted allowance** (e.g. one shared session, two people,
  no hosted agents). Keeps the "invite a friend" loop, costs a few cents per
  session.
- **Telemetry:** an opt-in daily count (sessions, agents, people, no names or
  files) from local relays, sent to the API.

## Next steps
1. Pick the free-tier line for people (above).
2. Decide what local relays report, and make it opt-in.
3. Design the local → hosted move (export the room's Y.js state, files and
   tasks; import on the hosted relay under the same session id).
4. Lift the "Quilt's own relay only" rule in `src/settings.js` for a relay
   the app itself started on this computer.
