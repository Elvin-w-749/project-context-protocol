# Deterministic routing

Routing starts only after the current user has explicitly selected the absolute context-store path and record layout for this session. Routing must never discover or infer either value from archived state, local folders, environment variables, or prior conversations.

Only `project-context-protocol` may be invoked implicitly. After `resume` and a new-session `begin`, call:

```text
contextctl route --repo <path> --store <path> --store-confirmed-by-user --record-layout <layout> --run <run_id> --session <session_token> --event <comma-signals>
```

The command returns exactly one `mode`, a reason, `executable`, `recordingReady`, and a credential. Validation additionally returns `valid` and `readinessBlockers`. The mode selects one reference contract inside the entry Skill; it does not select another Skill or prescribe the solution method. `valid` means the signed credential still matches current bound facts. `recordingReady` means context/provenance prerequisites are present. `executable` describes only whether the standalone protocol has a native continuation for that routed action; it never means the host action is authorized. A high-risk host route can therefore be valid and recording-ready while remaining non-executable by the protocol. Current user/platform authorization stays external. Unknown or empty signals fail with `ROUTE_SIGNAL_UNKNOWN`/`ROUTE_SIGNAL_EMPTY`. `session-start` and `continue` are explicit ordinary signals.

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
contextctl route --repo <path> --store <path> --store-confirmed-by-user --record-layout <layout> --run <run_id> --session <session_token> --event <same-signals> --validate <credential> [--authority <current text> --current-session-authority]
```

Any binding change invalidates it. Trust, current-session authority declarations, sensitive-Git preflight, and run presence are reported separately as recording-readiness prerequisites rather than being disguised as cryptographic mismatches. HMAC authenticates origin and integrity relative to the local store key, but it is not proof of human identity, authorship, or user authorization. High-risk execution authority remains outside the protocol with the current user and host platform; the standalone process records routes and observed results without launching the operation itself. Agents remain free to choose diagnosis, implementation, tooling, and verification methods inside that external authorization boundary.

## Capability boundary

| Level | Meaning |
|---|---|
| supported | Local Git observation, generation/run/event state, derived views, maps, and evidence handled by `contextctl` |
| observable | CLI-mediated actions plus changes and external/child actions explicitly reported at a checkpoint |
| manual | Semantic decisions, hypotheses, risks, and authorization supplied by the active Agent/user |
| degraded | Unwrapped tools, unsupported lifecycle platforms, other devices without imported records, and hidden child-Agent actions |

Skill metadata cannot guarantee startup on an unknown platform. A separately trusted Harness Hook can strengthen coverage only for the events it actually mediates; the standalone adapter does not launch arbitrary child programs.

The common lifecycle entry is `context-adapter session-start`; an installed Harness may call the same adapter with `--hook-mediated`. Heartbeats are authenticated checkpoints and never grant authority. The adapter manages session lifecycle, not Git or deployment execution. Expired leases force `recover-context`; routing must not issue an executable credential for the disconnected run.
