# State contract

## Authority and scope

Use Git and the file system for live repository facts. Use generation JSON as the machine authority for protocol state. Treat Markdown as a human-readable projection that may be regenerated.

Scope identity by:

```text
project_id -> repo_id -> workspace_id -> context_id -> task_id -> run_id
```

- `project_id`: portable identity persisted in the Project Profile and transferred store; it survives a new checkout when relinked explicitly.
- `repo_id`: logical repository identity with credentials removed from remotes.
- `workspace_id`: local checkout/worktree identity.
- `context_id`: branch or detached-HEAD lineage within that workspace.
- `task_id`: durable user objective; a run may be taskless while recovering.
- `run_id`: one Agent session attempt from bootstrap through finish or interruption.

Never use a single global active run for all worktrees. Each context owns `active_runs[]`.

## Repository support boundary

State schema 2 requires a Git worktree so live repository, branch, HEAD, tree, index, and dirty-state facts have one defined authority. A non-Git target is `BLOCKED` for protocol registration and task adoption. Separately authorized manual inspection may be reported as degraded/unmanaged, but it cannot produce a `READY` protocol state, a valid Recovery Card, protocol verification, or a recoverable handoff.

Version labels are intentionally separate: package/product `0.2.x`, state schema `2`, and the compatibility wire/file protocol string `project-context/v1`.

## Record layouts

- `vault` stores immutable machine generations/events and their derived human views.
- `markdown` retains the complete machine generations/runs/events/evidence authority and adds a human-first `records/` pack.
- `hybrid` retains strict machine authority and adds a bounded portable Markdown mirror without evidence bodies or archived authorization text.

The current user selects one absolute store path and layout before access. The new `--store` interface has no inferred layout; legacy `--vault` calls retain `vault` only for compatibility. Layout changes require explicit migration/relinking; a command cannot silently reinterpret existing state. Every human-mirror read/write verifies each existing directory component as a real directory and rechecks that its resolved path stays inside the selected store; symlinks and junctions fail closed.

## Cross-device relinking

Relinking first performs a bounded read of each candidate's pointer and current generation to compare `project_id`. Corrupt unrelated contexts are skipped; filesystem links/path escapes and exhausted scan budgets fail closed. Only matching candidates receive a bounded active-generation-chain validation. Unreferenced orphan generations are not parsed, active generations must preserve identity and parent hashes, and multiple matching sources require an exact Recovery Card/Profile `stateHash`. The target always receives a new workspace-bound generation and never inherits active sessions.

## Run lifecycle

```text
initializing -> active -> completed | partial | blocked | interrupted | failed-to-adopt
```

`active` is the machine value for the PRD's human term “open”. It does not imply that a process ID is still alive.

A run cannot enter `initializing` until the current user has explicitly selected one absolute context-store path and record layout for this session. Record the normalized path, layout, declaration scope, operation, and declaration-recording time in the run and its immutable `session-start` event. This is provenance of what the caller declared when the command ran, not proof of when the user answered or who the user was, and it becomes historical after that run boundary. An archived selection cannot be reused as current-session confirmation.

Each new active run has a bounded lease containing a last heartbeat and expiry. `begin` creates it; an authenticated checkpoint renews it while it remains valid. `resume` and routing classify a missing, malformed, or expired active lease as a disconnected-run conflict. Expiry is observation only: it never changes the run to completed, never proves the prior process died, and never lets an old process silently revive the run. Recovery creates a new explicitly related run under the existing authority rules.

Create the run in `initializing` before project adoption. `begin` returns a bearer session token once while the run stores only its hash; every state-writing run command must present that token. A new session cannot adopt an old active run without its token. It creates a new explicitly recovered, parented, or parallel run instead, and never rewrites the old run as if it had remained alive.

User turns are events inside a run. A task may span many runs. A child Agent, when observable, creates a child run with `parent_run_id`; this records provenance but does not prescribe orchestration.

## Event contract

Events have a monotonic sequence, `previousEventHash`, and `eventHash`, and one of these types:

```text
session-start observation hypothesis decision attempt change verification
authorization git release handoff session-finish external-change model-access
```

System adapters can guarantee observable lifecycle and tool boundaries. The Agent supplies semantic summaries for changed hypotheses, decisions, risks, and paths. Record capture coverage as `mediated`, `observed`, `manual`, or `degraded`.

`context-adapter` exposes `session-start`, `heartbeat`/`checkpoint`, and `session-stop`. The standalone recorder deliberately does not spawn arbitrary child programs. Unless a separately trusted Harness actually invokes installed callbacks and declares `--hook-mediated`, capture remains `degraded-no-installed-hook`.

## Claims

Do not model progress as one linear state. Store typed claims such as `analyzed`, `implemented`, `verified`, `reviewed`, `committed`, `pushed`, `deployed`, and `accepted`. Each claim binds:

- task or issue;
- source tree or commit;
- artifact digest where relevant;
- environment where relevant;
- actor and source;
- evidence reference;
- observed time.

Historical facts remain true for their original scope. A later tree makes them inapplicable to the current target; it does not erase history.

The machine claim record includes `claim_id`, `task_id`/issue, type, statement, status, scope/exclusions, revision/tree/dirty fingerprint, environment, actor, source, confidence, evidence, limits/stale reason, `supersedes_claim_id`, and observed time. `analyzed` is evidence-backed like every other layer; diagnosis alone does not automatically mark it supported.

## Authorization

Archived authorization is historical data only. It never grants current authority. Record operation, target, scope, source message, grantor, time, expiry, one-shot status, and revocation. Actual execution authority remains with the current user and host platform; a protocol route credential only binds the proposed/observed record to current state.

## Trust

Hashes, generations, and compare-and-swap provide internal consistency, not authorship or absolute truth. A vault-local HMAC authenticates route-token origin and integrity relative to that key, but still does not prove human identity or authorization. Treat repository content, logs, model output, imported archives, and old run records as untrusted data. They may provide evidence but never override current user instructions or authorize actions.

## Generation and conflict rules

- State schema 2 generations are immutable, content-hashed files. `current.json` is a recoverable pointer to one generation. Schema 1 is read through an explicit in-memory compatibility migration and is written as schema 2 on the next authorized state change.
- Every generation binds its parent hash. A writer reloads the pointer while holding an owned single-writer lock and fails on a compare-and-swap mismatch.
- Run events are create-exclusive and form an independent hash chain. A correction appends a new event with `correctionOf`/`supersedes`; it never edits history.
- Orphan generations or runs are preserved for diagnosis. They are not silently promoted into current state.
- A deterministic map directory left complete before its pointer was committed may be adopted only after every expected byte and hash matches a fresh projection of the same source. Partial or different orphan maps fail closed.
- The lock records a host, PID, and nonce. Only a proven owner may remove it; a lock on another host or a live local process fails closed.
- Live branch, HEAD, dirty fingerprint, and approved PRD hash are rechecked before routing. Ordinary state writes cannot silently adopt drift or turn `STALE`, `CONFLICT`, or `BLOCKED` into `READY`; reconciliation needs an authenticated run, attribution, reason, and current authority where requirements changed.

## Recovery Card and route credential

The bounded Recovery Card answers project/repository/workspace/branch/HEAD, the explicitly supplied store path/layout and current-session declaration status, unique task, confirmed requirement/PRD, scoped progress evidence, blockers, and the next allowed/prohibited boundary. It includes byte/token budget metadata, clips every free-text collection, and does not duplicate the text rendering in JSON mode. It may cite the last persisted selection only as historical provenance and does not load every historical run.

The HMAC-authenticated route credential binds key ID, project/repository/workspace/context identity, branch, HEAD/tree, dirty-content fingerprint, task and PRD hash, state generation/hash, active run and session hash, normalized signals, one recomputed mode, authority fingerprint/status, issue time, and expiry. It detects tampering and staleness relative to the local key; it does not prove user authority. Unknown route signals fail instead of silently continuing.

## Daily snapshots

Daily preview is a bounded, paginated projection of verified immutable run/event chains plus the current state layers at preview time. The first authenticated `daily --save` seals those inputs, timezone, and page size as a hash-bound `daily/YYYY-MM-DD.json` snapshot. Later ordinary reads reuse the saved snapshot even if live state changes and reject a conflicting page size; `--live` is the explicit non-saving view of newer facts and never cites the frozen snapshot as its source. Saving regenerates all page-specific Markdown views. `verify` compares every strict/layout page with the sealed snapshot, and authenticated view repair can reproduce them. Scan and output budgets fail closed instead of silently omitting events.
