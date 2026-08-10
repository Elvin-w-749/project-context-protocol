# Claim and evidence contract

Use this reference when routing selects `verify-and-handoff` or whenever a completion layer changes.

Represent every layer independently:

```yaml
claim:
  id: CLAIM-...
  task_id: TASK-...
  type: analyzed | implemented | verified | reviewed | committed | pushed | deployed | accepted
  statement: bounded claim
  status: supported | failed | inconclusive | stale
  scope: requirement, behavior, component, files, and exclusions
  revision: commit, artifact, worktree fingerprint, or file hashes
  environment: local or remote target plus material runtime/config/data
  evidence: [EVID-...]
  limits: unverified edges and residual risk
  supersedes: prior claim or null
```

| Layer | Evidence must establish |
|---|---|
| analyzed | Inspected scope, facts, hypotheses, conclusions, and open uncertainty |
| implemented | The scoped change exists in the identified worktree or revision |
| verified | Selected checks exercised the bounded claim on the identified revision and environment |
| reviewed | Reviewer/process identity, reviewed scope/revision, findings, and disposition |
| committed | Commit SHA and proof that the commit contains the intended scope |
| pushed | Remote and ref plus proof that it contains the commit |
| deployed | Target environment, deployed artifact/revision, deployment event, and observed post-deploy state |
| accepted | Explicit authorized acceptance tied to the exact scope and version |

The table states what must be established, never how to establish it. Missing evidence is `inconclusive`; changed code, configuration, dependency, data, artifact, or environment makes affected evidence `stale`. Never infer one layer from another.

The handoff must list every layer, exact evidence used, what was not checked, open blockers, user-owned changes to preserve, capture limitations, and one next objective. `implemented` is not `verified`; `committed` is not `pushed`; `deployed` is not `accepted`.
