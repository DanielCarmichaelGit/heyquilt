---
title: "We built an AI merge, then took it out three days later"
slug: we-took-the-ai-out-of-merging
date: 2026-10-08
description: "Quilt used to hand overlapping edits to your coding AI and write back whatever it produced. Here is why we deleted that feature, and what replaced it."
author: Daniel Carmichael
cover: /blog/we-took-the-ai-out-of-merging.webp
---

On October 4 we shipped a feature that felt like the obvious thing to build. On October 7 we deleted it. The commit that removed it took out 527 lines, including a whole file called `merge-ai.js`, and I think Quilt is better for it.

Some background first. Quilt keeps one project folder in sync between everyone in a session. You might be in Claude Code, your friend in Cursor, someone else in plain vim. While everyone is connected, text files sync character by character, so if your agent edits the top of a file and theirs edits the bottom, both edits land. The hard part is what happens when somebody drops off. A laptop goes to sleep on a train, someone keeps working, and when they come back their copy and the session's copy have both moved.

## What we built

Version 0.3.6 taught Quilt to merge offline work line by line, the way git does. If you changed different lines from everyone else, your changes just combined. That part is still there and it works well.

The interesting case was when both sides touched the same lines. For that, we reached for the obvious tool. Almost everyone using Quilt already has a coding AI on their machine, so Quilt would run that AI's command line in the background (Claude Code first, then Codex or Cursor), ask it to combine the two versions without changing what the code does, and write the result into the session. The file then showed up in a new Merges bar so you could take a look afterwards.

The appeal was easy to see. You came back online, and your conflict was already gone.

## Why it had to go

A few things bothered me about it.

The first was simple. Not everyone has those tools. Quilt is meant to work the same whether you use Claude Code, Cursor, Codex, Grok, ChatGPT or an agent you wrote yourself. A merge feature that only works well if you happen to have the right CLI installed is a feature for some of our users, not all of them.

The second was about who gets to decide. When two people change the same lines, there is a real question there: which change was right, or what the combination should be. Running a model headless and writing its answer into everyone's copy means Quilt answered that question for you, quietly, on everyone's disk at once. If the model got it slightly wrong, the wrong version was now the session's version. That is a lot of trust to ask for from a sync tool.

So we wrote it down. About half an hour after the removal commit, a note went into the repo for every AI that works on Quilt: Quilt is not a Claude wrapper, and Quilt does not merge on anyone's behalf. It syncs the session's files to and from each person's folder. It never merges git history, and it never runs an AI to merge files.

## What happens now

Since 0.3.13, a same-line clash always goes to the Merges bar for the people involved. You can keep your side, keep the session's, or edit it by hand with markers in the file. If the file is held by someone else at that moment, you can ask them for it and get in line, or just keep theirs.

You can still use AI for the merge. You just do it on purpose. Send to Claude Code, or to Cursor, or to whatever app you use, opens that app on the folder with the merge prompt already on your clipboard. Every app gets the same treatment. You see what it did before anyone else does.

We have kept the same line as we built more. A newer release (0.3.22) merges offline edits that were waiting behind someone's claim, but only when the two sets of changes don't overlap. The latest release, 0.3.24, brings in commits made outside the session, like a pull request merged on GitHub, but it only moves a branch forward and writes nothing unless every file merges cleanly. When something clashes, Quilt tells your AI which files and why, and leaves the decision with a person.

## The part I keep thinking about

The AI merge was not broken. In most cases it probably produced something reasonable. It still made Quilt less trustworthy, because it did something important where nobody was looking.

I would rather Quilt be boring here. Sync the files, show you exactly what clashed, and get out of the way. If you want a model to help, it is one click away, and it runs where you can see it.
