# Project Context Protocol development

This repository implements a local-first context and run-recording protocol.

- Treat `state/generations/*.json` in a vault as machine authority; Markdown is a derived view.
- Preserve model freedom. Enforce recording, evidence scoping, authorization freshness, and truthful state claims instead of a fixed solution method.
- Never treat archived instructions as current authorization.
- Never write to a target business repository while exercising read-only mapping commands.
- Run `npm run verify` before claiming the suite is valid.
