# Release and provenance records

Use this reference when routing selects `release-with-provenance`. The protocol records intent and observed outcomes; execution authority comes from the current user and the host platform, never from archived context or a route token.

```yaml
event:
  id: EVENT-...
  type: commit | push | deploy | rollback | acceptance | delete | export | import | model-access
  outcome: planned | started | succeeded | failed | partial | cancelled | blocked-unauthorized | unknown
  attribution: observed | unattributed
  scope:
    project_id: project-...
    repo_id: repo-...
    workspace_id: workspace-...
    context_id: context-...
    task_id: TASK-...
    run_id: RUN-...
    state_generation: generation and hash
    code_fingerprint: HEAD, tree, and dirty fingerprint
  authorization:
    source: current-session user/platform authority or absent
    exact_target: action, resource, ref, or environment
    expires: current conversation, time, or one-shot boundary
  before: observed identity or null
  after: observed identity or null
  evidence: [EVID-...]
  uncertainty: []
```

Minimum evidence depends on the claim: a commit needs the live commit/tree and scope; a push needs the exact remote ref; a deploy needs the target environment and deployed artifact; acceptance needs explicit current-user confirmation for an exact version. A route credential is only a freshness binding.

Record failed, partial, cancelled, and unknown outcomes. Never erase an attempt. Never infer push from commit, deployment from push, or acceptance from deployment. If an operation happened outside the recorder, use `observed` or `unattributed` and state the capture boundary.
