# Claim and evidence contract

Represent every completion claim independently.

```markdown
- claim_id: C-<id>
  task_id: <task ID>
  issue_id: <issue ID or null>
  type: analyzed|implemented|verified|reviewed|committed|pushed|deployed|accepted
  statement: <bounded claim>
  status: supported|failed|inconclusive|stale
  scope: <requirement, behavior, component, files, and exclusions>
  revision: <commit, artifact ID, code fingerprint, or file hashes>
  environment: <local/remote target and material runtime/config/data>
  observed_at: <timestamp>
  evidence: [E-<id>]
  actor: <observed actor>
  source: <run/event/user/tool source>
  confidence: <bounded confidence>
  limits: <unverified edges and residual risk>
  stale_reason: <reason or null>
  supersedes_claim_id: <prior claim or null>
```

## Minimum evidence by claim type

| Type | Evidence must establish |
|---|---|
| `analyzed` | Inspected scope, facts, hypotheses, conclusions, and open uncertainty |
| `implemented` | The scoped change exists in the identified worktree/revision |
| `verified` | Selected checks exercised the bounded claim on the identified revision and environment |
| `reviewed` | Reviewer/process identity, reviewed scope/revision, findings, and disposition |
| `committed` | Commit SHA and proof that the commit contains the intended scope |
| `pushed` | Remote and ref plus proof that it contains the commit |
| `deployed` | Target environment, deployed artifact/revision, deployment event, and observed post-deploy state |
| `accepted` | Explicit authorized acceptance tied to scope and version |

The table defines what a claim must prove, not how to prove it.

## Staleness rules

- A changed code or worktree fingerprint can stale implementation-linked verification and review evidence.
- A different commit, artifact, configuration, dependency set, data contract, or target environment can stale verification or deployment evidence.
- Acceptance applies only to the explicitly accepted scope and version.
- Later evidence does not erase earlier evidence; append a superseding claim and link the prior claim.
- Missing evidence produces `inconclusive`, not `supported`.
- Split a claim when targets, revisions, data, or environments differ; one successful target cannot support another.
- Acceptance evidence must cite the current-conversation user instruction and the exact version/environment accepted.

## Handoff claim table

Use one row per layer:

```markdown
| Layer | Status | Scope/revision/environment | Evidence | Limits |
|---|---|---|---|---|
| analyzed | ... | ... | ... | ... |
| implemented | ... | ... | ... | ... |
| verified | ... | ... | ... | ... |
| reviewed | ... | ... | ... | ... |
| committed | ... | ... | ... | ... |
| pushed | ... | ... | ... | ... |
| deployed | ... | ... | ... | ... |
| accepted | ... | ... | ... | ... |
```

Do not use `not applicable` to hide uncertainty. Use `not attempted`, `not authorized`, `unsupported`, or `unknown` in handoff prose when no claim exists.
