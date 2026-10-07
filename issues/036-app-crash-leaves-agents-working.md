# 036: When the app fails mid-session, agents keep working blind

**Status:** Open · **Reported:** 2026-10-02 · **Seen on:** Quilt app (desktop or `quilt join`) crashing or exiting while a Claude Code or Cursor agent is in the middle of a task

## What happens
The Quilt process dies (crash, `quilt stop`, Shut down button, machine sleep,
relay unreachable for good) while one or more agents are mid-task. Nothing
tells the agents. They keep editing, claiming and messaging through MCP tools
that now fail or hang, their edits no longer sync to partners, claims are no
longer honoured, and partners' edits no longer arrive. Two agents can end up
editing the same file on different machines without knowing it.

## What should happen
Before (or as) the app goes down, every agent in the session gets a last-ditch
signal to **pause**: finish the current edit, stop taking new work, and wait
for Quilt to come back or for a person to say so. The signal should reach
agents whether Quilt dies cleanly or not. When Quilt is back, agents should be
told they can resume and re-read the files they touched.

## What we know
- Agents reach Quilt through `src/mcp.js` (local, via the daemon in
  `src/control.js`) and `src/relay-mcp.js` (hosted). Every tool call goes
  through `withDaemon`/`withSession`. When the daemon is gone the tool errors,
  but nothing in the error says "stop working", and an agent that is not
  calling a Quilt tool at that moment never hears anything.
- `src/procs.js` `stopProcesses()` sends SIGTERM, waits 5 s, then SIGKILL.
  `src/mcp.js:465` handles SIGINT/SIGTERM by calling `leave()`. So a clean
  shutdown has a window to say goodbye, but nothing is sent to agents in it.
- There is no handler for `uncaughtException` or `unhandledRejection` in the
  app, so a crash gives no window at all. A "hail mary" has to be something
  that works after the fact too.
- Claude Code hooks (`src/setup.js`, `src/hooks.js`) already run on the
  agent's side on every edit (claim-before-edit). A hook can check whether the
  daemon is alive and refuse or warn, which works even when Quilt died
  without notice. Cursor has no equivalent hook; its only channel is the MCP
  tool results and the chat it reads.
- `quilt_message` and `quilt_read_messages` exist in both MCP servers, so a
  pause can be worded as a chat message from Quilt itself ("Quilt is down,
  pause until it is back"), which the agent sees next time it reads messages.
- Agent behaviour must live in the shared MCP tools and guide text, not in one
  tool's hooks (see the project rule), so the hook path is a backstop, not the
  main mechanism.

## Likely causes
1. No shutdown path ever addresses agents; only sessions and sync are flushed.
2. Crashes bypass even that path (no process-level error handlers).
3. Agents only learn about Quilt by calling it; there is no push and no
   on-the-agent-side liveness check.

## Next steps
1. **Clean shutdown:** in the SIGTERM/SIGINT and Shut down paths, before
   leaving, post a system chat message to the session ("Quilt on <computer> is
   shutting down. Pause work on this project until it is back.") and make the
   next MCP tool result for each connected agent carry the same text.
2. **Crash:** add `uncaughtException`/`unhandledRejection` handlers that try
   the same message (best effort, short timeout), then exit.
3. **Agent side, after the fact:** make every MCP tool error when the daemon
   is gone say plainly "Quilt is not running; pause and ask the person before
   continuing", and have the Claude Code edit hook block edits with the same
   message while the daemon is dead. Put the matching guidance in the MCP
   instructions (`MCP_INSTRUCTIONS`, `INSTRUCTIONS`, `HOSTED_INSTRUCTIONS`).
4. **Resume:** when the app starts and finds a prior session with agents
   active, post "Quilt is back; re-read files you were editing before
   continuing" and clear stale claims from the dead process.
5. Test with a Claude Code agent mid-edit: kill the app with SIGKILL, confirm
   the next edit is blocked and the next tool call explains why; restart and
   confirm the resume message.
