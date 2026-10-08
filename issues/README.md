# Issues

Problems found while using Quilt, one file per issue, worked through in order.
Each file says what's wrong, what we know, the likely causes, and what's
needed to close it. Keep the file after it's fixed and mark it **Fixed** with
the commit, so the history stays in one place.

| # | Issue | Status |
|---|---|---|
| [001](001-cursor-messages-missing.md) | Cursor messages still don't show up | Needs info from a Cursor machine (`quilt doctor --watch 30`) |
| [002](002-cloud-sessions-dont-share.md) | Cloud sessions (Claude Code / Cursor cloud) share nothing | Diagnosed; fix needs a public relay (deploy) |
| [003](003-claude-code-not-offered.md) | "Open in Claude Code" missing when Claude Code is installed | Open; detection only finds the desktop app |
| [004](004-open-in-cursor-wrong-folder.md) | "Open in Cursor" opens Cursor but not the session folder | **Fixed** (748a583): opens a classic Cursor window on the folder |
| [005](005-website-needs-signed-identities.md) | The website and relay-hosted AI tools can't join since identities became signed | Won't fix: browser version shelved; relay-hosted AI moves to 002 |
| [006](006-approved-member-not-shown-as-present.md) | Someone let into a session only shows in Access, not in the people bubble | Likely caused by 007; recheck in a fresh session |
| [007](007-relay-crashes-on-oversized-session.md) | Nothing syncs: the relay crashes when a session holds a build folder | **Fixed** (1ab736c): nested ignore files, relay size guard |
| [008](008-invite-links-break.md) | Invite links stop working | Needs info: what the link does when it breaks |
| [009](009-relay-crashes-on-bad-input.md) | Any client can crash the relay with one request (bad %-escape; unhandled socket error, crashed production 2026-10-01) | **Fixed** (4637800) |
| [010](010-production-relay-sign-in-off.md) | Production relay has sign-in off: 0.3.1 clients get 403 starting sessions, names unchecked | **Fixed** (deployed 2026-10-02) |
| [031](031-peer-can-unignore-env.md) | A partner's `.gitignore` edit un-ignores `.env` and your secrets sync into the room | **Fixed** (4637800) |
| [011](011-secrets-in-websocket-urls.md) | Room secrets, relay key and passes travel in WebSocket URLs and were logged by Fly's proxy | **Fixed** (7028258): headers, with a query fallback for one release; rotate the leaked key |
| [012](012-release-tag-and-default-branch.md) | GitHub default branch is a stale `claude/*` branch; v0.3.1 tagged on 27 Sept code; relay image stale | **Fixed** (GitHub, 2026-10-02); delete the ghcr `elegy-relay` package by hand |
| [013](013-client-stops-reconnecting.md) | The app stops reconnecting after a 429 or a proxy 502/503 (relay restarts) | **Fixed** (7028258) |
| [014](014-session-ownership-first-come.md) | Session ownership and creation go to whoever connects first | **Fixed** (7028258): only the creator becomes owner; creation by a view link needs a client-side join flag |
| [015](015-relay-disk-errors.md) | A disk error stops the relay; a half-written session file is deleted on restart | **Fixed** (7028258); a relay-wide free-space cap is still to do |
| [021](021-chat-xss.md) | Stored XSS in the chat panel through a peer-controlled message id | **Fixed** (a95063c): id encoded and escaped, non-hex ids dropped, CSP on the page |
| [032](032-remote-write-failure-reverts-edits.md) | One unwritable file drops the rest of an update and reverts the partner's edit; first-join name collisions abort | **Fixed** (26262b4) |
| [033](033-symlink-read-on-rejoin.md) | On rejoin, a shared path under a local symlink reads a file outside the project into the room | **Fixed** (83e39bf) |
| [034](034-chat-attachment-lands-in-project.md) | A crafted chat message id puts an attachment in the project root; a malformed message breaks status for everyone | **Fixed** (53c067d) |
| [016](016-relay-limits-bypass-and-leaks.md) | Relay limits bypassable (X-Forwarded-For), rooms pinned in memory, pending guests stranded, quotas by declared size | Open, medium |
| [017](017-public-keys-not-canonical.md) | API accepts public keys with junk, defeating one-key-per-agent/computer | Open, medium |
| [018](018-names-not-cleaned.md) | Person and computer names not cleaned: bidi/invisible characters reach passes, sessions, the approve page | Open, medium |
| [019](019-api-small-gaps.md) | Accounts API: 413 handling, first-org lock-out, missing rate limits, no row pruning, HEAD 404, and more | Open, low |
| [020](020-supabase-configuration.md) | Supabase: files bucket also created in the accounts project; leaked-password protection off; auth settings to check | Open, medium |
| [022](022-presence-colour-css-injection.md) | A peer's presence colour is CSS-injected and can cover the whole window | Open, medium |
| [023](023-chat-sender-spoofing.md) | Chat messages and DMs can be sent under anyone's name | Open, medium |
| [024](024-desktop-ux-defects.md) | Desktop app UX and shell defects (empty recent list, cwd `/` prefill, no Windows CLI install, heights, casing, more) | Open, medium |
| [025](025-auth-redirect-host.md) | Auth callback/sign-out build redirects from the request URL (deploy host seen once); Netlify env unverified | Needs info |
| [026](026-website-missing-pieces.md) | Website: no share metadata or Safari/iOS icons, unstyled 404, pricing and "coming soon" copy contradict the product | Open, medium |
| [027](027-website-polish.md) | Website layout, CSS and small flow defects | Open, low |
| [028](028-docs-vs-code.md) | README, docs/hosting.md and `--help` disagree with the code (limits, commands, MCP tools, Node version) | Open, medium |
| [029](029-repo-and-ci-hygiene.md) | CI skips the website; .dockerignore ships 970 MB; stale secrets, lockfiles, dirs and issue statuses | Open, medium |
| [030](030-mail-dns-and-headers.md) | Mail DNS incomplete (no DMARC/SPF on hq); Fly apps send no hardening headers | Open, low |
| [035](035-sync-data-loss-edge-cases.md) | Sync edge cases: case-only collisions, delete-vs-edit race, `.quilt/` committable, 1 s rescan cost, more | Open, medium |
| [036](036-app-crash-leaves-agents-working.md) | App crash or shutdown mid-session leaves agents working blind; no last-ditch "pause" signal | Open, high |
| [037](037-agent-join-writes-claude-hooks.md) | Agent join writes Claude Code hooks into the shared project for non-Claude agents | Open, medium · **Assignee: Brandon** |
| [038](038-local-only-coworking-unsolved.md) | A local-only free tier has no answer for coworking between people, identity or tracking | Open, product decision |

Issues 009 to 035 come from the full audit of 2026-10-01 (relay, sync client, accounts API, Supabase, website, desktop app, deploy and docs). 009, 010 and 031 and the highs (011, 013, 014, 015, 021, 032, 033, 034) are fixed; 012 is done on GitHub.

Feature ideas (not bugs) go in [unlocks.md](unlocks.md).

## Adding an issue

Copy this into `NNN-short-name.md`:

```
# NNN: <what's wrong, in a sentence>

**Status:** Open · **Reported:** YYYY-MM-DD · **Seen on:** <tool, OS, how quilt was run>

## What happens
## What should happen
## What we know
## Likely causes
## Next steps
```

Statuses: **Open** (not looked at), **Investigating**, **Needs info**, **Blocked** (on something named), **Fixed** (commit), **Won't fix** (why).
