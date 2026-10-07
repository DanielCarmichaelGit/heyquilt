// Pure: the git operations the Git in Quilt page lists, grouped. Each: commands, a status tag
// (`kind` picks its colour), what happens, and a quieter second line.

export const GIT_GROUPS = [
  {
    id: 'saving',
    title: 'Saving and syncing',
    note: "New commits, yours or a teammate's",
    patch: 'c',
    ops: [
      { cmds: ['git commit', 'git push'], tag: 'nothing to do', kind: 'none', text: 'Committing changes no files, so nothing is sent.', more: 'Teammates who pull later get content they already have.' },
      { cmds: ['git pull', 'git merge', 'fast-forward'], tag: 'merged', kind: 'merged', text: "New commits are merged into the session's work line by line.", more: 'Overlaps are handed to you and your AI; real clashes show in the Merges bar.' },
      { cmds: ['git rebase', 'git cherry-pick', 'git revert'], tag: 'merged', kind: 'merged', text: 'Treated like a pull: only files that changed between the two commits are touched.', more: 'Everything else stays as the session has it.' },
      { cmds: ['stash, pull, pop'], tag: 'merged once', kind: 'merged', text: 'A stash, a pull and a pop land as one merge once git settles.', more: 'Your partners never see files flicker away and back.' }
    ]
  },
  {
    id: 'undoing',
    title: 'Undoing',
    note: "Your undo is yours, not everyone's",
    patch: 'b',
    ops: [
      { cmds: ['git stash', 'git stash -u'], tag: 'session kept', kind: 'kept', text: "Your files revert as git does, then the session's work comes back.", more: 'Your stash still has your copy.' },
      { cmds: ['reset --hard', 'checkout -- .', 'git restore'], tag: 'session kept', kind: 'kept', text: "A git command on one computer can't wipe the room's work.", more: "Quilt holds that folder until git settles, then puts the session's files back." },
      { cmds: ['git clean', 'rm'], tag: 'shared', kind: 'shared', text: 'Deleting untracked files deletes them for everyone, as you meant.', more: 'Unlike a stash, a clean is not put away.' },
      { cmds: ['git rm', 'git mv'], tag: 'shared', kind: 'shared', text: 'Removing or moving files is an edit like any other.', more: 'Partners see the file go, or move.' }
    ]
  },
  {
    id: 'midway',
    title: 'In the middle of something',
    note: "Git's work in progress stays on your computer",
    patch: 'd',
    ops: [
      { cmds: ['merge in progress', 'rebase in progress'], tag: 'held', kind: 'paused', text: 'While git is mid-way, your folder sends nothing and queues what comes in.', more: 'The top bar says git is busy.' },
      { cmds: ['CONFLICT', 'stash pop clash'], tag: 'paused', kind: 'paused', text: 'Your folder pauses with "resolve the git conflict". Partners never see git\'s markers.', more: 'Once you git add your fix, it is shared as it is.' },
      { cmds: ['index.lock'], tag: 'noticed', kind: 'none', text: "A lock left behind by a git that crashed is recognised and set aside, so it can't hold you up forever.", more: 'Deleting it is still yours to do.' },
      { cmds: ["git won't run"], tag: 'paused', kind: 'paused', text: 'If git stops answering in a folder Quilt has synced with git before, that folder waits rather than guessing.' }
    ]
  },
  {
    id: 'edges',
    title: 'Edge cases',
    note: 'The ones that usually cost an afternoon',
    patch: 'a',
    ops: [
      { cmds: ['untracked files would be overwritten'], tag: 'one line', kind: 'none', text: 'When a teammate commits files the session already gave you, Quilt names them and gives your AI the line that pulls.', more: 'See below.' },
      { cmds: ['.gitignore', '.quiltignore'], tag: 'respected', kind: 'none', text: 'Ignored files never leave your computer, nested ignore files included.', more: ".quilt/ is added to .gitignore so git clean can't take the session's state." },
      { cmds: ['git init', 'no git'], tag: 'just works', kind: 'none', text: 'A folder with no git syncs the same.', more: 'Start git whenever you like; nothing changes for anyone.' },
      { cmds: ['git worktree'], tag: 'just works', kind: 'none', text: 'Each worktree is just a folder on a branch.', more: 'Join a session from any of them.' }
    ]
  }
]

export const GIT_NEVER = ['Never commits', 'Never pushes', 'Never merges history', 'Never touches GitHub', 'Never switches branches', 'Never runs an AI to merge']
