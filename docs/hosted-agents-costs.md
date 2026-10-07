# Hosted agents: what they need and what they cost

Exploration, 2026-10-07. Prices were checked on the providers' official pricing
pages that day (US East, list price, before tax).

## The split

- **Free: local only.** Your agents, your computer, a relay on your computer.
  Any number of agents, and nothing touches our servers. When the computer
  sleeps, the agents pause (issue 036 covers telling them so). Coworking with
  other people on the free tier is still open (issue 038).
- **Paid: hosted.** A shared relay we run, plus a machine we run for each
  project, where agents keep working while your computer is off.

## Rule one: a hosted agent must not be a weaker agent

Hosted agents today use the hosted MCP's `quilt_read_file`, `quilt_write_file`
and `quilt_list_files`. That works for small edits, but it cuts out most of what
makes a coding agent useful:

| What an agent does | Local agent | Hosted MCP file tools today | Hosted machine (proposed) |
|---|---|---|---|
| Read and edit files | yes | yes, one file per call | yes |
| grep / ripgrep / find across the project | yes | no | yes |
| Run tests, builds, linters, type checks | yes | no | yes |
| Install packages (npm, pip, cargo, apt) | yes | no | yes |
| git: diff, log, branch, commit, push | yes | no | yes (with a GitHub token) |
| Run a dev server and look at it | yes | no | yes, on a preview URL |
| Images, PDFs, video (ffmpeg), headless browser | yes | partly (files shared in chat) | yes, if they're in the image |
| macOS / iOS / Windows builds, GPU | on your hardware | no | **no**: the honest limit |

So the hosted product can't be a set of file API calls. It has to be **a real
Linux machine with the project on a real disk**, and the agent CLI running on
it exactly as it would on a laptop.

## What runs on a hosted machine

The key point is that the machine is just another computer in the session:

1. **The Quilt client runs on it** (`quilt join`) and syncs the project to its
   disk the same way it does on a laptop. Agents there get the full local MCP:
   claims, file queue, tasks, chat. To everyone else they look like any other
   member's agents. We don't need a new protocol.
2. **Agent CLIs run headless:** Claude Code (`claude -p --resume <id>`), Codex
   (`codex exec`), the Cursor CLI. Each person signs in with their own account
   on their own machine, through the vendor's sign-in or with their own API key.
3. **The relay wakes it.** `src/relay-webhooks.js` already POSTs to a hosted
   agent when it's @mentioned, sent a DM or handed a task. Point that at the
   machine: it resumes, runs the agent with the event as the prompt, and goes
   back to sleep after a few idle minutes. A waiting agent costs nothing.
4. **A full base image:** node, python, go, rust, git, ripgrep,
   build-essential, headless Chromium, ffmpeg. If the project has a
   `.devcontainer`, use that instead.
5. **A persistent disk** for the checkout, dependencies, build caches and each
   agent's conversation history (that's what lets `--resume` pick up where it
   left off).
6. **Secrets:** each workspace gets an encrypted set of environment variables.
   `.env` is never synced, on purpose, so hosted agents need their own copy.
7. **Network:** outbound open, for registries, docs and APIs. Inbound only
   through the preview proxy.

One machine per project, shared by that project's hosted agents, works the way
several agents on one laptop do today: one disk, claims to coordinate. It's
cheaper than one machine per agent.

## What data the server holds

| Layer | What | Size | Cost |
|---|---|---|---|
| Relay (exists) | Y.js project state (text files), chat, tasks, claims, history | All sessions on production today: **46.5 MB** on a 3 GB volume | Today's whole relay: shared-cpu-1x 512 MB, **$3.69/mo** plus the volume |
| Large files (exists) | Shared files, images, PDFs, zips (Supabase "Quilt Files") | Per workspace | $0.021/GB-mo over quota; R2 would be $0.015/GB-mo with free egress |
| Project machine disk (new) | Checkout, dependencies, caches, agent history | 2 to 5 GB per project (node_modules is most of it) | Fly volume $0.15/GB-mo, so **$0.30 to $0.75/mo**; $0.03 to $0.08/mo once archived to R2 after weeks idle |

Relay and storage costs are close to nothing. **Compute is the only real
cost, and only while an agent is actually working.**

## Compute: price per active hour

Sized for agent work: 2 vCPU and 2 to 4 GB of RAM. Most of an agent's time is
spent waiting on the model, with short CPU bursts for builds and tests.

| Provider | Config | $/active hour | Idle | Notes |
|---|---|---|---|---|
| **Fly Machines** | shared-cpu-2x, 2 GB | **$0.015** | $0 compute, disk only | Suspend/resume in a few hundred ms (only on machines with ≤2 GB). We already run on Fly. |
| Fly Machines | performance-2x, 4 GB | $0.074 | same | For heavy builds; ≥2 GB machines cold start in about 2 s instead |
| Modal | 1 core (2 vCPU), 4 GB | $0.079 | snapshot | 24 h sandbox limit; long-lived work means snapshot and restore |
| Cloudflare Sandbox | 2 vCPU, 4 GB | about $0.05 to $0.18 (CPU billed only while busy) | **files deleted on sleep** | Bad fit without R2 backups |
| Vercel Sandbox | 2 vCPU, 4 GB | about $0.14 | snapshot $0.08/GB-mo | 24 h session limit |
| E2B | 2 vCPU, 4 GB | $0.166 | pause keeps memory | **$150/mo Pro** minimum for 24 h sessions |
| Daytona | 2 vCPU, 4 GB | $0.166 | disk only | $200 free credit |
| Anthropic Managed Agents | managed | $0.08 per running session-hour, plus tokens | free | Claude only, which breaks the "every tool" rule |
| Hetzner CX23 (always on) | 2 vCPU, 4 GB | $6.49/mo flat | n/a | Cheapest at 24/7, but we'd run all the orchestration ourselves |

## What a paid workspace costs us per month

Fly, blended at $0.03/active hour (mostly shared-cpu-2x, with bursts on
performance machines), plus disk and a share of the relay:

| Use | Agent-hours | Compute | Disk | Total |
|---|---|---|---|---|
| Light: 1 agent, a few tasks a week | 30 | $0.90 | $0.75 | **≈ $1.75** |
| Typical: 3 agents across 2 projects | 150 | $4.50 | $1.50 | **≈ $6** |
| Heavy: 3 agents busy around the clock | 2,160 | $65 | $1.50 | **≈ $67** |
| Heavy, on E2B instead | 2,160 | $360 + $150 plan | incl. | ≈ $510 |

Agents waiting for an @mention cost nothing, because the relay wakes them, so
"always on" is rare in practice. Egress is small: npm and pip downloads come
in, which is free, and syncing out to people runs at $0.02/GB.

## Model tokens: the user's, never ours

For scale, here is a rough estimate of one busy agent-hour: about 3M input
tokens (90% of them cache hits) and 100k output.

- Sonnet 5 ($2 / $10, cache $0.20): **≈ $2/hour**
- Opus 5.5 ($4 / $20, cache $0.20): **≈ $3.70/hour**

That's 50 to 100 times our compute cost. We can't absorb it, and Anthropic's
terms say we can't anyway. Claude Code may run in our sandbox, but each user
signs in with their own API key or their own Pro/Max login through Anthropic's
own sign-in, and we may not "pay for, resell, or intermediate" Claude usage, or
store claude.ai tokens. Pro and Max now include separate Agent SDK credits
($20, $100 or $200 a month) tied to the user's own account, so many users can
run hosted agents without an API key. Codex and Cursor work the same way.

## What it means for pricing

- About $15 per workspace per month, **100 agent-hours included**, and
  $0.10/hour after that, covers the typical case at roughly $6 cost, with room
  to spare.
- Put a monthly cap on agent-hours and a per-project disk limit (say 10 GB),
  and only allow always-on for an extra fee. That keeps the heavy case from
  wiping out the margin.
- The relay itself won't drive the price: at 1,000 paid workspaces it's a few
  bigger Fly machines, well under $0.10 per workspace.

## Recommendation

**Build on Fly Machines.** We're already there. It's the cheapest per active
hour with a persistent disk, idle compute is $0, there's no plan minimum, and
suspend/resume matches wake-on-webhook. E2B and Daytona would be faster to
build on, but cost 5 to 10 times more per hour and keep that markup forever.
Cloudflare loses files on sleep. Managed Agents is Claude-only.

The upsell moment writes itself: when your laptop is about to sleep with agents
mid-task (issue 036), Quilt offers to **move the session to the cloud**, and
those agents carry on on a hosted machine.

## Open questions

1. Do people sign their agent CLIs in once per project machine, or once per
   workspace? This is about how sign-in state is stored on the disk.
2. GitHub access for push and PRs: a GitHub App token per workspace.
3. Which projects can't run in a Linux sandbox (iOS, Windows, local
   databases)? Those stay local, and the agent should say so instead of failing.
4. Can someone open a terminal on the machine from the app? Cheap to add
   (Fly exec), and it makes debugging a hosted agent much easier.
