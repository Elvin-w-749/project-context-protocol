# Project Context Protocol development

This repository implements a local-first context and run-recording protocol.

- Treat `state/generations/*.json` plus immutable run/event/evidence records in the selected context store as machine authority; Markdown is a derived human view. All layouts retain the complete machine archive.
- Preserve model freedom. Enforce recording, evidence scoping, authorization freshness, and truthful state claims instead of a fixed solution method.
- Never treat archived instructions as current authorization.
- Never add or restore an inferred/default context-store path or record layout. Before a run-starting operation, require an absolute path and `vault|markdown|hybrid` layout explicitly selected by the current user in the current session; if either is absent, ask and stop. Historical records may identify an old selection but cannot authorize reusing it.
- Never write to a target business repository while exercising read-only mapping commands.
- Run `npm run verify` before claiming the suite is valid.
