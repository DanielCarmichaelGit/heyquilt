---
title: "Teaching AIs to take turns on a file"
slug: teaching-ais-to-take-turns
date: 2026-10-08
description: "Two coding agents in the same folder will happily overwrite each other. How Quilt went from warnings to claims to a proper queue with handoffs."
author: Daniel Carmichael
cover: /blog/teaching-ais-to-take-turns.webp
---

Put two coding agents in the same project folder and they will step on each other within minutes. Neither one is being careless. Each of them reads a file, plans a change, and writes it back, with no idea that another agent did the same thing ten seconds earlier. With people this mostly sorts itself out because we talk. Agents don't, unless something makes them.

Most of the last two weeks of work on Quilt has been about that something. Here is how it went, including the parts we got wrong first.

## Warnings don't work

The very first version of claims was a warning. If you claimed a file and someone else edited it, they got told. That lasted a few hours. On September 27 we changed it so that edits to a claimed file are undone instead of warned about, and later that same day the relay started enforcing claims itself with per-person signing keys, so a client that ignored the rule couldn't get around it.

The lesson was obvious in hindsight. An agent in the middle of a task does not stop because a message says please don't. It needs the edit to actually not happen.

## Claims you don't have to remember

The next problem was that nobody remembers to claim anything. People forget and agents forget more.

In early October Quilt started claiming a file for you the moment your AI edited it, and releasing it when the AI finished. At first that only worked in Claude Code, through its hooks. That was not good enough for a tool that is supposed to work the same everywhere, so in 0.3.6 we moved it down to the sync layer. Quilt watches the disk, not the tool. If your AI changes a file nobody holds, it is yours for now, whether that AI is Claude Code, Cursor, Codex or something we have never heard of. If a partner's AI edits it anyway, the edit is undone and their AI is told who holds the file the next time it talks to Quilt.

## A queue instead of a standoff

Claims stopped the overwriting, but they created a new problem. If I hold a file and your agent needs it, what does your agent do? Early on the answer was to message me and wait. That mostly meant the agent sent a polite note and then sat there.

So 0.3.10 added a queue to every claimed file. An agent that needs a file joins its queue with what it plans to do, in up to 300 characters. The holder's AI is told right away, and is reminded with every Quilt answer after that. When it is done, it hands the file over with its context: what it changed, what is left, anything to watch out for. The next agent wakes up with those notes and the file is now its own.

There is one rule that makes this work. An agent cannot finish its work, or let go of a file, while someone is waiting on it, until it hands it off. Without that rule, a finished agent would just leave and the queue would sit there.

Agents still forget sometimes, so the queue moves without them. If an AI stops working while someone is waiting for a file it was editing, Quilt hands the file on after two minutes, with a note on what that AI was doing. For tools Quilt can't see working, it waits until the file has been quiet for five minutes. And any claim is let go once its holder has done nothing in the session for 20 minutes.

## Getting agents to talk less

Once agents could talk to each other, they talked too much. Every message got a reply, and every reply got a thanks. Put a few agents in one session and you got a little round of welcomes and noted every time someone spoke.

Since 0.3.14 every AI starts a chat message with the name of whoever it is for, so only that person or agent is interrupted. A message that names nobody is refused unless it is marked as an announcement. Messages that need nothing back, like thanks or a greeting, are settled without a reply. If you have several AI sessions open, the first answer counts for all of them and a repeat is refused.

The flip side is that a real question can't be ignored. While someone is waiting on an agent's answer, the tools that move work forward (claims, tasks, merges, finishing up) refuse until it replies.

## Where this leaves us

None of this is clever on its own. It is the same stuff a good team does without thinking: say what you're working on, don't grab a file someone else has open, tell the next person what you changed, and don't reply all to a thank you.

The difference is that agents need it to be enforced rather than suggested. When we relied on an agent choosing to follow a rule, sooner or later one didn't. When we made the rule something Quilt checks, the problem mostly went away.
