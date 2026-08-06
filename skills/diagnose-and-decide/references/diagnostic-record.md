# Diagnostic record contract

Use compact, stable IDs so a later Agent can follow the chain without loading the whole run.

## Active problem or issue

```markdown
- issue_id: ISSUE-<id>
  statement: <observable problem and reproduction boundary>
  status: open|resolved|blocked|inconclusive
  impact: <affected behavior/users/components>
  evidence: [E-<id>]
  next_discriminator: <unique next evidence or action>
```

## Observation

```markdown
- fact_id: F-<id>
  statement: <what was directly observed>
  observed_at: <timestamp>
  scope: <file, component, request, or environment>
  evidence: [E-<id>]
  confidence: confirmed
```

An observation must not contain an unmarked causal explanation.

## Evidence

```markdown
- evidence_id: E-<id>
  kind: <source|command|runtime|log|diff|document|user-instruction|other>
  locator: <path, command, attachment, URL, or event reference>
  revision: <HEAD, code fingerprint, file hash, or not-applicable>
  environment: <local/runtime/target details or not-applicable>
  captured_at: <timestamp>
  result: <relevant result; include exit status when applicable>
```

## Hypothesis

```markdown
- hypothesis_id: H-<id>
  statement: <testable explanation>
  status: pending|confirmed|rejected|unresolved
  supports: [E-<id>]
  contradicts: [E-<id>]
  next_discriminator: <evidence that would change the status>
```

Only mark `confirmed` when the evidence supports the stated scope. Preserve rejected hypotheses because they prevent repeated work.

## Decision and attempt

```markdown
- decision_id: D-<id>
  selected_path: <next path, not an invented completion claim>
  based_on: [F-<id>, H-<id>, E-<id>]
  alternatives: <deferred/rejected options and concise reasons>
  risks: <known uncertainty and rollback concern>
  authorization: <allowed boundary>

- attempt_id: A-<id>
  action: <what was done>
  target: <files or systems>
  result: <success, failure, partial, or inconclusive>
  evidence: [E-<id>]
  side_effects_or_rollback: <observed effects and recovery>
```

## Conclusion, correction, and file change

```markdown
- conclusion_id: CON-<id>
  statement: <bounded evidence-supported conclusion>
  based_on: [F-<id>, H-<id>, E-<id>]
  remaining_uncertainty: <what is not established>

- correction_id: CORR-<id>
  corrects: <prior fact/hypothesis/conclusion/decision ID>
  reason: <new evidence or human correction>
  evidence: [E-<id>]

- change_id: CHG-<id>
  operation: create|modify|move|delete|format|generate
  files: [<path>]
  purpose: <why this change belongs to the task>
  before_hash: <hash or unavailable>
  after_hash: <hash or unavailable>
  diff_reference: <evidence ID or locator>
```

## Current authorization evidence

```markdown
- authorization_id: AUTH-<id>
  source_current_session: <current message/event reference>
  grantor: <user identity as observed>
  operation_scope: <exact action and target>
  granted_at: <time>
  expires_at: <time/current-conversation>
  one_shot: <true|false>
  revoked_at: <time or null>
```

The route credential recorded with an entry binds repo/workspace/context, branch, HEAD/tree, dirty fingerprint, task, generation/hash, run, mode, authority fingerprint, and expiry. It is a staleness guard, not proof of authorization.

## Minimum checkpoint delta

Each diagnostic checkpoint should contain only new or changed entries plus:

- active problem or issue ID;
- route credential/run ID;
- changed hypothesis or decision IDs;
- evidence IDs and attachment references;
- affected architecture/files;
- unique next objective;
- remaining uncertainty and prohibited actions.

Do not paste unrelated logs, duplicate unchanged history, or record hidden chain-of-thought. Preserve concise, reviewable engineering reasons and evidence.
