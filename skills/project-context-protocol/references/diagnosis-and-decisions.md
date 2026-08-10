# Diagnosis and decision records

Use this reference when routing selects `diagnose-and-decide`. It defines what must be left behind, not which diagnostic method, tool, test order, architecture, or Agent topology to use.

## Durable chain

Keep stable IDs so a later Agent can recover the reasoning without loading the whole run:

```yaml
issue:
  id: ISSUE-...
  statement: observable problem and reproduction boundary
  status: open | resolved | blocked | inconclusive
  impact: affected behavior, users, or components
  evidence: [EVID-...]
  next_discriminator: unique next evidence or action

fact:
  id: FACT-...
  statement: directly observed fact without an unmarked causal claim
  scope: file, component, request, data, or environment
  evidence: [EVID-...]

hypothesis:
  id: HYP-...
  statement: testable explanation
  status: pending | confirmed | rejected | unresolved
  supports: [EVID-...]
  contradicts: [EVID-...]
  next_discriminator: evidence that would change the status

decision:
  id: DECISION-...
  selected_path: next path, not an invented completion claim
  based_on: [FACT-..., HYP-..., EVID-...]
  alternatives: deferred or rejected options with concise reasons
  risks: uncertainty and rollback concerns
  authorization_boundary: allowed scope

attempt:
  id: ATTEMPT-...
  action: action taken
  target: files or systems
  result: success | failure | partial | inconclusive
  evidence: [EVID-...]
  side_effects_or_rollback: observed effects and recovery
```

Preserve rejected hypotheses and failed attempts because they prevent repeated work. A conclusion must cite evidence and retain remaining uncertainty. A correction appends a new record that points to the superseded record; it never rewrites history.

## Checkpoint delta

Record only new or changed entries plus the active issue, affected files/architecture, evidence locators, remaining uncertainty, authorization boundary, and unique next objective. Do not store hidden chain-of-thought, duplicate unchanged history, or paste unrelated logs.
