---
title: "Everyone's AI work, all at once"
slug: everyones-ai-work-at-once
date: 2026-10-08
description: "A Quilt session used to hide most of what the AIs were doing behind tabs. Version 0.3.25 puts every person's AI lane in the middle of the window so you can see who is working on what side by side."
author: Daniel Carmichael
cover: /blog/everyones-ai-work-at-once.webp
---

For a long time the middle of a Quilt session was just your own AI chat. That made sense when one person and one model were doing the work. It stops making sense the moment three people each have an AI open on the same folder.

You would hear someone say their agent just finished a ticket, or see a file change in the tree, and still have no picture of what the other AIs were actually doing. Their turns lived behind a tab. By the time you clicked over, the moment had passed.

Version 0.3.25 changes that. The middle of the window now opens on Everyone.

## A lane for each person

Everyone is a feed of lanes, one per person in the session. Each turn with their AI (what they asked, what it did, which files it changed, its reply) shows up as a card in their lane, next to their chat messages and task notes. Time runs down the page like a timeline, so you can see who was busy and when.

If two lanes touched the same file within fifteen minutes, those turns are stitched together, with a small mark where the overlap happened. Hover a file on a card or in the file tree and every turn that touched it lights up. Click a card to open it in place, or open the whole conversation from it. While an AI is working, a needle at the bottom of its lane stitches the file it last changed.

Your own AI chat is still one tab away. Everyone does not replace that. It just stops the rest of the room from being invisible.

## Crowding without sideways scrolling

A session with a lot of people used to mean a lot of horizontal scrolling, or lanes you never saw. Now the quieter lanes fold into thin strips. Each thing that person did becomes a knot in the same rows as everyone else, so you still see when they were busy and threads still reach them. Hover a knot to see what it was. Click the strip to open the lane, and the lane used least recently folds to make room.

Working AIs, you, and the last two lanes you opened stay open first. Pin a lane if you want it to stay open for good. Past six strips, the quietest share one column at the end, with a +N list of everyone in it. On a narrow window the view collapses to one column on its own.

## Brief messages, clearer room

The same release also tightened how AIs talk in chat. The guide every AI reads now asks for a sentence or two, one message rather than several, with no play-by-play, recaps, logs or pasted code. Notes on tasks follow the same rule.

That matters more once you can see everyone's lanes. A room full of long status dumps is hard to read even when they are side by side. Short turns keep the feed usable.

## Why this felt worth shipping

Quilt already stops two AIs from overwriting the same file, and it already refuses to merge overlapping edits on anyone's behalf. Those rules keep the folder safe. They do not tell you what is happening.

Everyone is the missing half. You can watch three agents work without opening three tabs, spot when two of them landed on the same file, and jump into the turn that matters. The session stops being a stack of private chats and starts looking like a room of people working together.
