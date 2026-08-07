# Deterministic routing

Routing starts only after the current user has explicitly selected the absolute Vault path for this session. Routing must never discover or infer a Vault location from archived state, local folders, environment variables, or prior conversations.

Only `project-context-protocol` may be invoked implicitly. After `resume` and a new-session `begin`, call:

```text
contextctl route --repo <path> --vault <path> --run <run_id> --session <session_token> --event <comma-signals>
```

The command returns exactly one `mode`, a reason, an `executable` flag, and a credential. Do not choose a focused Skill from descriptions alone.

## Priority

The implemented fail-closed priority is:

1. missing/stale/conflicting/blocked state → `recover-context`;
2. missing new-session run or task/authority change → `confirm-intent`;
3. commit, push, deploy, rollback, acceptance, delete, export, import, model access, or secret disclosure → `release-with-provenance`;
4. error, contradiction, or failed check → `diagnose-and-decide`;
5. impact/architecture question → `map-impact`;
6. completion or handoff claim → `verify-and-handoff`;
7. session end or compaction → `checkpoint-handoff`;
8. otherwise → `continue-current-task`.

The high-risk route precedes ordinary diagnosis so an error signal cannot bypass an operation gate.

## Credential

The vault's non-exported local signing key authenticates the credential. It binds key ID, repository, workspace, context, branch/detached state, HEAD/tree, dirty-content fingerprint, task/PRD hash, state generation/hash, active run/session hash, normalized signals, unique mode, authority fingerprint/current-session declaration, issue time, and expiry. Validate it with:

```text
contextctl route --repo <path> --vault <path> --run <run_id> --session <session_token> --event <same-signals> --validate <credential> [--authority <current text> --current-session-authority]
```

Any binding change invalidates it. HMAC authenticates origin and integrity relative to the local vault key, but it is not proof of human identity, authorship, or user authorization. Standalone version 1 never makes a high-risk route executable: authority text and the explicit current-session flag are historical declarations only. A future executor would require a separately reviewed approval boundary outside the Agent-controlled process and OS principal.

## Capability boundary

| Level | Meaning |
|---|---|
| supported | Local Git observation, generation/run/event state, derived views, maps, and evidence handled by `contextctl` |
| observable | CLI-mediated actions plus changes and external/child actions explicitly reported at a checkpoint |
| manual | Semantic decisions, hypotheses, risks, and authorization supplied by the active Agent/user |
| degraded | Unwrapped tools, unsupported lifecycle platforms, other devices without imported records, and hidden child-Agent actions |

Skill metadata cannot guarantee startup on an unknown platform. A separately trusted Harness Hook can strengthen coverage only for the events it actually mediates; standalone version 1 does not launch arbitrary child programs.

The common lifecycle entry is `context-adapter session-start`; an installed Harness may call the same adapter with `--hook-mediated`. Heartbeats are authenticated checkpoints and never grant authority. The adapter manages session lifecycle, not Git or deployment execution. Expired leases force `recover-context`; routing must not issue an executable credential for the disconnected run.
