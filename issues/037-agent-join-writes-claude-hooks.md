# 037: Agent join writes Claude Code hooks into the shared project for non-Claude agents

**Status:** Open · **Reported:** 2026-10-02 · **Seen on:** `quilt join --agent nightshade` (Cursor/cloud agent on Linux, Quilt 0.3.4) · **Assignee:** Brandon

## What happens
When Nightshade (a non-Claude agent) joined room `room-602ec304`, Quilt created and synced `.claude/settings.json` into the shared project (hooks for SessionStart / PreToolUse / PostToolUse / Stop calling `quilt hook`). Partners saw it as a file create from nightshade. The agent is not Claude Code; the hooks file is still pushed into everyone's tree.

## What should happen
Claude Code hook scaffolding should only land when the joiner is actually using Claude Code, or should stay local to that machine and not sync into the shared project. A Cursor/cloud agent join should not add `.claude/` config for the whole room.

## What we know
- Activity line after join: nightshade created `.claude/settings.json` (+61 -0).
- File content is the standard `quilt hook` wiring from setup (SessionStart, Edit|Write matchers, Stop).
- Brandon had not asked for the hooks file; it appeared as a side effect of agent join.
- `quilt setup` / join path likely always writes this when `.claude/settings.json` is missing, without checking the agent tool.

## Likely causes
1. Join/setup unconditionally scaffolds Claude Code hooks when the file is absent.
2. `.claude/settings.json` is treated as a normal shared file instead of machine-local tooling state.

## Next steps
- Confirm whether join or `quilt setup` writes the file for `--agent` joins.
- Either gate the write on Claude Code being the active tool, or keep `.claude/settings.json` out of sync (ignore / local-only).
- Decide whether the existing file in this room should be removed or kept for Claude Code partners.
