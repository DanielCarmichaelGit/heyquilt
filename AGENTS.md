# Working on Quilt

## Verifying a change

Every agent reads this when it picks up a ticket and must run these checks before moving
it to QA. Put a description of the changes and how you self-validated them in `qaNotes`
when moving to QA. Moving to Done still needs `verified` (what you ran and what you saw).

- While you work, run the tests for what you touched: `npm run test:unit` (seconds) or
  `npm run test:fast` (unit and integration). Before QA, `npm test` (all of it, end-to-end
  included) passes; note the count. Anything failing is yours unless main fails it too.
- If you touched anything under `src/ui/`, `src/ui-server.js` or `desktop/`, start the app
  (`npm run app`, or `quilt ui` for the browser) and confirm the window renders and the
  part you changed works. A blank cream window means a module failed to load: every file
  the UI imports must be listed in `STATIC` in `src/ui-server.js` (the allowlist test
  catches the common case) and allowed by the CSP there.
- If you touched `src/relay-mcp.js`, `src/mcp.js` or `src/hooks.js`, exercise the tool you
  changed from an agent (the hosted and local MCP tests, or a real session).
- If you touched the website (`web/`) or the API (`src/api*.js`), run their tests and load
  the page or endpoint you changed.
- Every user-visible change gets a bullet under the top section of `RELEASES.md`.

## Tests

Tests live in three folders, by what they need. A new test goes in the first one it fits.

- `test/unit/`: pure logic. No sockets, servers, child processes, real git or real
  `Session`. The whole folder runs in seconds (`npm run test:unit`).
- `test/integration/`: in one process, with real pieces: a `Session`, a relay, the UI
  server or the API on a local port (`npm run test:integration`).
- `test/e2e/`: across processes or with real git: the CLI and MCP started as their own
  processes, two clones of a repo syncing through a relay (`npm run test:e2e`).
- `test/helpers/`: what tests share (`api-helpers.js`, `pass-helpers.js`, `git-pair.js`,
  `home.js`, `platform.js`). Import from there instead of copying a helper into another test.

Run one file with `npm run test:file -- test/unit/tasks.test.js`, not plain `node --test`:
every npm test script loads `test/helpers/setup.js` first. It gives the run a throwaway home
folder, makes `os.homedir()` follow `HOME` (Windows reads `USERPROFILE`), and runs git with
no system config, so tests never touch the real `~/.quilt` and see the same git everywhere.

`npm run test:coverage` runs the suite and reports how much of `src/`, `bin/` and `desktop/`
it runs. Unlike Node's own table, it counts files no test loads as not run and lists them,
then the files with the most lines not run: start there when adding tests. Line by line in
`coverage/lcov.info` (ignored by git and Quilt).

Files run in parallel, but the tests in one file run one after another, so a file of slow
tests sets the time for the whole run: split it by theme (as `test/e2e/git-*.test.js` are)
rather than letting it grow. A test that starts a process or server stops it in
`t.after()`, so a failure can't leave it running and hang the run. A child process given a
temporary home gets `homeEnv(dir)` from `test/helpers/home.js`.

A test that needs what a computer may not have skips with the reason from
`test/helpers/platform.js` (`{ skip: NO_SYMLINKS }`): POSIX permissions, symlinks, running a
shell script as a fake `git`/`gh`/`fly`, read-only folders, `*` in a file name. When only
one assertion needs it, guard that line (`if (!NO_POSIX_MODES) ...`) and keep the rest.
CI runs on Linux, where none of these skip.
