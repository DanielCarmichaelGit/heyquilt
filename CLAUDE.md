# Quilt: notes for Claude

Read `AGENTS.md` first: it has the checks every change needs before QA.

## Quilt is not a Claude wrapper

Quilt is used across AI providers (Claude Code, Cursor, Codex, Grok, ChatGPT, hosted agents
over HTTP). Don't over-index on Claude:

- Never build a feature that runs, requires or is tuned for one AI tool. Agent behavior lives
  in the shared MCP tools, the relay and the guide text, so every provider gets it the same way.
- Never tell people to fix something in one AI tool (e.g. "run `claude /login`") to use Quilt.
- Quilt does not merge on anyone's behalf. It syncs the session's files to and from each
  person's folder. It never merges git history or anything on GitHub, and never runs an AI
  (headless or otherwise) to merge files.
