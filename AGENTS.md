# Working on Quilt

## Verifying a change

Every agent reads this when it picks up a ticket and must run these checks before moving
it to QA. Put a description of the changes and how you self-validated them in `qaNotes`
when moving to QA. Moving to Done still needs `verified` (what you ran and what you saw).

- `npm test` passes (note the count). Two tests fail on main today for unrelated reasons;
  anything else failing is yours.
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
