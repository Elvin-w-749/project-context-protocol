# Project Context Protocol development

This repository implements a local-first context and run-recording protocol.

- Treat `state/generations/*.json` in a vault as machine authority; Markdown is a derived view.
- Preserve model freedom. Enforce recording, evidence scoping, authorization freshness, and truthful state claims instead of a fixed solution method.
- Never treat archived instructions as current authorization.
- Never add or restore an inferred or default Vault path. Before a run-starting operation, require an absolute Vault path explicitly selected by the current user in the current session; if absent, ask and stop. Historical records may identify an old location but cannot authorize reusing it.
- Never write to a target business repository while exercising read-only mapping commands.
- Run `npm run verify` before claiming the suite is valid.
