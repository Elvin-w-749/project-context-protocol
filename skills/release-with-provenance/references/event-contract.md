# Release event contract

Use this compact contract for every release or high-risk event. Omit inapplicable identity fields only when their absence is explicit; never substitute a predicted value for an observed one.

## Common event

```yaml
event_id: EVT-...
event_type: commit | push | deploy | rollback | acceptance | delete | export | import | model-access
outcome: planned | started | succeeded | failed | partial | cancelled | blocked-unauthorized | unknown
attribution: observed | unattributed
scope_binding:
  repo_id: <repository identity>
  workspace_id: <worktree identity>
  context_id: <branch/detached lineage>
  task_id: <task identity>
  run_id: <active run>
  state_generation: <generation and hash>
  route_credential_hash: <credential hash>
  code_fingerprint: <HEAD/tree/dirty fingerprint>
started_at: <timestamp>
ended_at: <timestamp or null>
actor:
  kind: user | agent | service | unknown
  id: <observed identity or unknown>
source:
  kind: user_instruction | command | api | log | repository | environment
  reference: <run/evidence reference>
authorization:
  status: reported-current-session | absent | revoked | not-applicable-observation
  evidence: <current conversation reference or null>
  scope: <authorized action and exact target>
  grantor: <observed grantor>
  granted_at: <time>
  expires_at: <time/current-conversation>
  one_shot: <true|false>
  revoked_at: <time or null>
before:
  oid: <Git/object/artifact digest or null>
  ref: <source or target ref or null>
  environment: <environment identity or null>
  artifact: <artifact/version/digest or null>
after:
  oid: <observed Git/object/artifact digest or null>
  ref: <observed source or target ref or null>
  environment: <observed environment identity or null>
  artifact: <observed artifact/version/digest or null>
evidence:
  - id: EVID-...
    kind: command-output | remote-ref | deployment-response | health-check | user-confirmation | manifest
    locator: <local attachment, command, API response, or event reference>
    hash: <content hash where available>
    captured_at: <timestamp>
    result: <bounded result>
    exit_code: <integer or null>
uncertainty: []
supersedes_event_id: <prior event or null>
```

Use `attribution: observed` when the resulting state is known but the operation happened outside the standalone suite. Use `unattributed` when the actor or causal operation cannot be proven. Standalone version 1 never records `performed`: a future trusted Harness would need a separate schema and an approval/execution boundary outside the Agent-controlled process and OS principal. Do not infer performance or authorization from possession of credentials, Agent-reported authority, or matching timestamps.

## Required evidence by type

| Type | Minimum before facts | Minimum after evidence |
|---|---|---|
| `commit` | previously recorded HEAD and current branch/ref | live commit object, exact first parent, tree, current HEAD/ref, and hashed `diff-tree` file manifest |
| `push` | live local HEAD, configured remote push URL identity, destination full ref | explicitly opted-in `git ls-remote` observation whose exact remote ref OID equals live HEAD |
| `deploy` | environment, source OID, artifact digest/version | target release/version, deployment response, post-deploy verification |
| `rollback` | environment and deployed artifact/version | selected prior artifact/version, target response, post-rollback verification |
| `acceptance` | exact version/artifact/environment under review | explicit user confirmation and its scope/time |
| `delete` | exact resources, locations, retention/copy assumptions | result manifest and independently observable remaining scope where possible |
| `export` | exact source, record/file scope, destination, sensitivity | export manifest, destination identity, hashes/counts, result |
| `import` | source export/archive identity, source repository/state hash, manifest, destination context, current authorization and untrusted-import acknowledgement | manifest integrity result, quarantine import ID/path, copied manifest reference, and `adoptedAsCurrentState: false` |
| `model-access` | exact local evidence ID/hash, disclosure scope, current-session authority, model-access route | evidence metadata and model-access event recording the authorization fingerprint; this records intent/selection, not proof of network transmission |

## Fact rules

- Keep event facts independent. Never derive `pushed`, `deployed`, or `accepted` from `committed`.
- Store attempt outcome rather than a permanent Boolean. A later event may supersede an earlier event but must not erase it.
- Bind verification to the observed `after` identity. If the code, ref, environment, or artifact changes, mark prior evidence stale for the new identity.
- Record `partial` when some targets changed and others did not; list each target separately.
- Record `unknown` when the action may have had side effects but evidence is unavailable.
- Preserve before/after facts and evidence even for failed, cancelled, or unauthorized attempts.
- For standalone observed commit/push events, `succeeded` means the built-in observer proved the named resulting Git state. It does not prove who ran the causal command or when it ran.
- A `supported` committed or pushed claim cites a prior matching typed event with `outcome: succeeded` and an internal live Git observer result; a route credential or attachment alone is never lifecycle evidence.
- Standalone version 1 cannot support `deployed` or `accepted` because it has no generic trusted environment or user-confirmation observer. Record the strongest honest lower state instead.
