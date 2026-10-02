# Quilt releases

Every version has a section here, newest first. The app shows the newest section as
"What's new" the first time it runs after an update, and `npm run release` publishes
the matching section as the GitHub release notes. A test fails if the top section's
version does not match package.json, so bump both together.

Format: `## <version> — <YYYY-MM-DD>`, an optional one-line summary, then bullets.
Lead each bullet with a short bold phrase. Inline `code` and **bold** are rendered;
nothing else is.

## 0.3.3 — 2026-10-02

See what has changed in a session, and who changed it.

- **Changes, by person or by file.** A new **Changes** button in the session bar lists every file changed in this session with lines added and removed. Switch between *By person* (each person's files) and *By file* (each file, with everyone's share). Click a file to open it. Everyone sees the same breakdown, because the counts live in the shared session.
- **Every edit counts.** Quick successive edits to one file used to fold into a single "edited" entry; the Changes counts now add up every one of them. Files a folder brings to the room when it joins are its starting point, not changes.
- **Agents see it too.** `.quilt/STATUS.md`, `quilt status` and the `quilt_status` tool have a **Changes** section with the same breakdown.

## 0.3.2 — 2026-10-02

Invite links open the app in one click, and you can invite your AI from the app.

- **Invite links just work.** Clicking a join.heyquilt.com link takes you to heyquilt.com, asks you to sign in (or create an account) if you aren't, remembers the invite while you do, and then opens the session in Quilt. No more copying the link into Join a session. People without the app see where to download it.
- **Invite your AI from the app.** The session's Invite dialog has an **Invite an AI agent** button: it makes a one-time agent invite and gives you one block of text to paste into your AI, with this session's link included. Settings has a new **Agents** card that lists your agents and makes invites too, so you never need the website for it.

## 0.3.1 — 2026-10-01

Sign in once, and invites open straight into the app.

- **Sign in to use Quilt.** The app signs in to your heyquilt.com account before anything else, and sessions on the hosted relay need that sign-in. Sign out from Settings. Your name in sessions comes from your account.
- **Invites are join.heyquilt.com links.** Open one in a browser and click **Open in Quilt**; it opens the app straight into the join screen. Older relay invite links redirect there.
- **Command line:** `quilt login`, `quilt logout` and `quilt whoami`.
- **Open Quilt from the website.** After linking a computer on heyquilt.com, an Open Quilt button brings the app forward.
- **Agent invites tidy up.** Invites on the website close themselves once the agent has joined.

## 0.3.0 — 2026-10-01

Agents join as members, large files sync encrypted, and the app gets its Sherbet look.

- **AI agents can join.** Paste a one-time invite link from heyquilt.com into your AI, or run `quilt agent join <link>`. Agents show up as their own members with roles and folder limits. `quilt agent whoami` shows who an agent is signed in as.
- **Large files** are stored encrypted outside the session, so big assets sync without slowing everything else down.
- **End a session for everyone** (owners only).
- **Easier-to-read people menu:** a card for you, plain switches for sharing your AI chat, and sections for everyone else.
- **Styled dropdowns** replace the system menus throughout the app.
- **Fewer settings:** relay settings are hidden, since everyone uses the hosted relay at relay.heyquilt.com.
- **In-app dialogs.** Leave, remove, end session and shut down are now in-app and work everywhere.
- **New Sherbet look** for the app icon and logo, and a proper installer window.

## 0.2.1 — 2026-09-30

Sessions that stopped syncing after a partner joined are fixed.

- **Sync works again** in sessions where nothing synced (files, chat, presence) after a partner joined. Build caches like `.next/` were being shared, which made the session too big for the relay.
- **Nested ignore files.** `.gitignore` and `.quiltignore` files in subfolders now apply to their subfolder, like git.
- **Build caches are never shared:** `.next`, `.turbo`, `.nuxt`, `.svelte-kit`, `.parcel-cache` and `.vercel`.
- **`.quiltignore`** (same syntax as `.gitignore`) keeps any other files out of a session.

## 0.2.0 — 2026-09-30

- **Quilt** is the new name. Real-time, tool-agnostic pair vibe coding: a project folder stays live-synced between collaborators and their AI coding agents, whatever editor or AI tool each of them uses.

## 0.1.0 — 2026-09-28

First desktop release.

- **Download, open, and click an invite link** to join a session.
- **Mac:** the app isn't signed by Apple yet. The first time, open System Settings → Privacy & Security and click Open Anyway.
- **Windows:** SmartScreen may warn about an unknown publisher; choose More info → Run anyway.
