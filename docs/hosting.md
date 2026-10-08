# Hosting the Quilt relay

The relay is the one piece everyone in a session connects to. Host it once,
and starting a session becomes one click with no tunnels or networking to
think about. Anyone you invite just pastes the invite link.

The relay is a single small Node process with a data folder:

- It holds each session's shared state and the files people share in chat.
- It needs one always-on machine with a disk. Rooms live in that machine's
  memory, so run exactly one instance.
- 512 MB of RAM is plenty for a group of friends.

## 1. Pick where to run it

### Fly.io (recommended)

About $2–5 a month for a small always-on machine with a 3 GB volume.

```bash
fly auth login
fly launch --copy-config --no-deploy      # choose a unique app name when asked
fly volumes create cowove_data --size 3
fly secrets set QUILT_RELAY_KEY=$(openssl rand -base64 24)
fly deploy
fly secrets list                          # the key is stored; keep your copy
```

Your relay is at `wss://<app-name>.fly.dev`.

### Render

1. In Render, choose **New → Blueprint** and pick this repository. It uses
   [`render.yaml`](../render.yaml): a Docker web service with a 5 GB disk.
   Disks need a paid instance type.
2. Render generates `QUILT_RELAY_KEY` for you. Copy it from the service's
   **Environment** tab.

Your relay is at `wss://<service-name>.onrender.com`.

### Any Linux server (VPS) with Docker

This setup includes Caddy, which gets and renews an HTTPS certificate
automatically. Point a DNS name at the server first, then:

```bash
git clone <this repo> && cd quilt/deploy
export QUILT_DOMAIN=relay.example.com
export QUILT_RELAY_KEY=$(openssl rand -base64 24); echo "$QUILT_RELAY_KEY"
docker compose up -d
```

Your relay is at `wss://relay.example.com`.

### Just Docker

A prebuilt image is published from this repo's `main` branch:

```bash
docker run -d --name quilt-relay -p 4321:4321 -v quilt-data:/data \
  -e QUILT_RELAY_KEY=... ghcr.io/danielcarmichaelgit/quilt-relay:latest
```

Put it behind HTTPS (Caddy, nginx, or your platform's proxy) so clients can
use `wss://`. The first time the image is published, GitHub makes the package
private. To pull it without logging in, make it public under your GitHub
profile → **Packages** → `quilt-relay` → **Package settings**. You can also build it yourself with `docker build -t quilt-relay .`

## 2. Turn on sign-in

Quilt's relay only lets in people and agents signed in to heyquilt.com. The
accounts API signs each of them a pass that lasts 10 minutes, and the relay
checks it with the API's public key, which the API publishes. This reads it,
checks it is a real Ed25519 key, and hands it to Fly (if anything is wrong it
stops with a message, Fly gets nothing to set, and the relay keeps its current setting):

```bash
node scripts/relay-pass-key.mjs | fly secrets import --app cowove-relay
```

With it set:

- Every connection needs a pass. Apps too old to get one are refused with
  "Update Quilt and sign in to continue".
- The relay takes each person's name from their pass.
- The relay key isn't used, and new sessions are limited per account
  (`QUILT_MAX_NEW_ROOMS_PER_HOUR`) instead of per address.

Without it the relay works as it always has, with the relay key. The Quilt app
only connects to Quilt's own relay for now; other relays are for development
(`QUILT_SERVER=ws://localhost:4321 quilt ui`).

## Settings

All settings are environment variables on the relay.

| Variable | Default | What it does |
|---|---|---|
| `QUILT_PASS_PUBLIC_KEY` | *(none)* | The accounts API's public key (`/v1/passes/key`). With it, every connection needs a pass from the API. Set it as a secret. |
| `QUILT_API_URL` | *(none)* | The accounts API, e.g. `https://api.heyquilt.com`. With `RELAY_API_SECRET`, the relay reports who is in which session (account, display name and times only) for people's dashboards. Unsent reports wait in `presence-queue.jsonl` in the data folder. Hosted agents' workspace tools need it too: the relay asks the API whether workspaces are on (`/v1/features`) and offers the library tools only while they are. |
| `RELAY_API_SECRET` | *(none)* | Shared with the accounts API; `node scripts/relay-api-secret.mjs` sets it on both. Set it as a secret. Without both settings, the relay reports nothing. |
| `QUILT_WORKSPACES` | off | On the accounts API: `QUILT_WORKSPACES=1` turns on the workspaces routes, agents in workspaces and the agents' library tools (off by default). Off, every one of those routes answers 404 and the agents' tool lists are as before. Either way, apply the migrations `20261004000000_workspaces`, `20261005000000_workspace_files` and `20261007000001_workspace_agents` before deploying the API: it reads their columns even with the flag off (agent invites, for one). |
| `QUILT_STORAGE_URL` / `QUILT_STORAGE_KEY` | *(none)* | On the accounts API: the Quilt Files project's URL and service key; workspace files are stored there in the `workspace-files` bucket. Both unset: files are kept on the API's disk under `QUILT_API_DATA`. |
| `QUILT_STORAGE_WS_BUCKET` | `workspace-files` | On the accounts API: the Supabase Storage bucket workspace files are kept in, when `QUILT_STORAGE_URL`/`QUILT_STORAGE_KEY` are set. |
| `QUILT_API_DATA` | `./quilt-api-data` | On the accounts API: where workspace files are kept on disk, when no Supabase storage is configured. |
| `QUILT_RELAY_KEY` | *(none)* | Required to **start** sessions when sign-in is off. Ignored when `QUILT_PASS_PUBLIC_KEY` is set. |
| `PORT` | `4321` | Port to listen on (Render and Fly set this for you). |
| `QUILT_DATA` | `/data` in Docker | Where sessions and shared files are stored. |
| `QUILT_MAX_ROOM_MB` | `256` | Size limit for one session's shared project. Past it, the session stays readable, but new changes are refused. |
| `QUILT_MAX_ROOM_FILES_MB` | `2048` | Storage for one session's files: those shared in chat (each at most 100 MB) and its stored large files together. |
| `QUILT_MAX_CONNS_PER_IP` | `50` | Connections allowed from one address. |
| `QUILT_MAX_NEW_ROOMS_PER_HOUR` | `30` | New sessions one account (or, with sign-in off, one address) can start per hour (`0` = no limit). Joining existing sessions isn't limited. |
| `QUILT_ROOM_TTL_DAYS` | `30` | Sessions nobody has opened for this long are deleted, files included. Set it to `0` to keep them forever. |
| `QUILT_TRUST_PROXY` | off (on in the provided configs) | Use `X-Forwarded-For` to find client addresses. Only turn it on behind a proxy. |
| `QUILT_STORAGE_URL` | none | On the relay: a Supabase project URL. With `QUILT_STORAGE_KEY`, large files go to Supabase Storage instead of the relay's disk. |
| `QUILT_STORAGE_KEY` | none | On the relay: a Supabase secret key for that project. Set it as a secret, never in `fly.toml`. |
| `QUILT_STORAGE_BUCKET` | `session-files` | The private bucket to use (create it with `supabase/files-project/session_files_bucket.sql`, in a Supabase project of its own). |
| `QUILT_MAX_STORED_FILE_MB` | `100` | The largest file people can share this way. With Supabase Storage, keep it at or under the bucket's file size limit (50 MB in the provided migration). |

## Checking on it

- The relay shows no page at its address: anything other than a session, an
  old invite link (which redirects to join.heyquilt.com) or a shared file
  answers "not found".
- `https://your-relay/healthz` returns JSON for monitoring (`ok`, and whether
  starting sessions needs a key). It doesn't reveal usage.
- `curl https://your-relay/healthz` tests it from any machine.
- Logs show sessions connecting and leaving, but never their contents.
- Session secrets, the relay key and sign-in passes travel in request headers
  (`x-quilt-secret`, `x-quilt-view-secret`, `x-quilt-key`, `x-quilt-pass`),
  never in the URL, so a proxy's access log doesn't record them. The relay
  still reads them from the query string for clients older than 0.3.2; that
  stops in the release after. Make sure your proxy doesn't log request headers.

## Large files

Binary files of 256 KB or more (images, builds, archives) don't travel inside
the session. Each person's Quilt encrypts them with a key made from the
session's secrets, and uploads them to storage: Supabase Storage when
`QUILT_STORAGE_URL` and `QUILT_STORAGE_KEY` are both set, otherwise the relay's
own disk. Set both or neither; the relay won't start with only one.

What that protects against depends on where the files are kept:

- **Supabase Storage.** Supabase only ever holds encrypted files, so it can't
  read them.
- **The relay's own disk.** The files there are encrypted too, but the relay
  sees the session's secrets each time someone connects. Whoever runs the
  relay could use them to open the files, so this only keeps them from people
  who get the disk alone.

Either way, code and small files travel through the relay unencrypted, as
described under Privacy below.

Stored files are deleted when the owner ends the session, when the session is
deleted after `QUILT_ROOM_TTL_DAYS`, and when a file is replaced or removed (a
day later, once the session is idle). They count toward the session's file
quota (`QUILT_MAX_ROOM_FILES_MB`) together with files shared in chat.

## Good to know

- **Privacy.** The relay stores each session's files and chat so people can
  reconnect and catch up. Whoever runs it can read that data, so host it
  yourself or with people you trust. End-to-end encryption would remove this
  requirement, and it's a natural next step.
- **Backups.** Everything lives in the data volume (`/data`). Back it up like
  any other volume, or don't: every collaborator also has the full project on
  their own disk.
- **Updating.** Redeploy (`fly deploy`, a Render redeploy, or
  `docker compose pull && docker compose up -d`). Clients reconnect on their
  own, and edits made during the restart sync once it's back. Quilt's own
  relay deploys itself from GitHub Actions ("Relay deploy") on every push to
  `main` that changes what it runs, or by hand from the Actions tab; the
  workflow uses the `FLY_API_TOKEN` repository secret.
- **One instance.** Don't scale the relay to several machines. People in the
  same session must reach the same process.
