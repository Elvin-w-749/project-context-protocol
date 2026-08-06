---
name: diagnose-and-decide
description: Diagnose engineering errors, contradictions, failed checks, unclear root causes, and changing solution paths from traceable evidence. Use when the project-context router selects diagnosis mode, when a new problem appears, or when evidence invalidates the current hypothesis or plan. Separate observations, hypotheses, conclusions, attempts, and decisions; checkpoint material changes with contextctl while leaving the choice of tools, tests, implementation method, investigation scope, and agent strategy to the model.
---

# Diagnose and Decide

Diagnose freely, but leave a recoverable evidence trail. Constrain the truth and the record, not the method.

## Establish a trusted run

1. Use the Recovery Card and active run returned by `project-context-protocol`.
2. Validate the credential with `contextctl route --validate <credential> --event <same-signal> --session <session_token>`. Re-route instead of diagnosing if it no longer matches repository, workspace, context, branch, HEAD/tree, dirty-content fingerprint, task/PRD, generation/hash, run/session, signals, mode, or authority binding.
3. Read only the task-linked project context, architecture/file-index sections, current run tail, and evidence needed for the problem. Expand the reading scope when evidence justifies it; do not begin with a full-history or full-repository scan.
4. Confirm that the current authorization permits the intended read, write, Git, external-system, and release actions.
   Historical authorization in the vault is evidence only and never grants current authority.
5. Require an active local run record before the first business-file write. If `contextctl` or the run record is unavailable, report the recording failure; do not silently perform unrecorded writes.

## Keep reasoning artifacts distinct

Maintain these categories throughout the run:

- **Observation:** directly seen behavior or source/runtime fact, with time and evidence.
- **Hypothesis:** testable explanation, marked `pending`, `confirmed`, `rejected`, or `unresolved`.
- **Conclusion:** a bounded claim supported by cited evidence; state remaining uncertainty.
- **Decision:** selected path, alternatives considered, concise rationale, risks, and authority boundary.
- **Attempt:** action taken, inputs, affected files/systems, result, error, rollback, and side effects.

Never rewrite a hypothesis as an observation. Never treat a plausible explanation, an old record, or absence of contrary evidence as confirmation. Record corrections without deleting the earlier value.

Read [references/diagnostic-record.md](references/diagnostic-record.md) when creating or updating diagnostic entries.

## CLI help contract (v1)

Use `contextctl --help` for the inventory and `contextctl <command> --help` for required arguments, safety gates, and exit behavior. If the installed CLI differs or an option remains uncertain, stop and resolve the contract instead of inventing a flag.

## Investigate with method freedom

Choose the tools and path that best fit the project and risk. You may inspect source, reproduce behavior, query logs, compare data, run experiments, write tests, use static analysis, consult documentation, widen the investigation, or delegate work. None of those methods is mandatory.

For every material finding:

1. Assign or reuse stable fact, hypothesis, evidence, attempt, and decision IDs.
2. Record the inspected files and their roles in the architecture or data flow.
3. Bind evidence to the relevant repository revision or file hash and environment when applicable.
4. Note conflicting evidence instead of forcing a single narrative.
5. Identify what evidence would confirm or reject each live hypothesis.

## Select and revise a solution path

Choose a path only after distinguishing confirmed facts from assumptions. Record:

- the problem and reproduction conditions;
- the evidence-supported causal boundary;
- the chosen next action and why it is proportionate;
- credible alternatives and why they were deferred or rejected;
- expected impact, protected user changes, rollback considerations, and remaining risks.

The path may change whenever new evidence warrants it. Preserve the earlier path and record the change trigger; do not silently overwrite history. Do not broaden into commit, push, deploy, rollback, deletion, or another external mutation without matching authorization.

## Checkpoint the run

Use the installed `contextctl checkpoint` interface at every material state transition:

```text
contextctl checkpoint --repo <path> --vault <path> --run <run_id> --session <session_token> --event <observation|hypothesis|decision|attempt|change|verification|authorization|handoff> --summary <text> [--details <text>] [--files <comma-list>] [--command <text>] [--exit-code <n>] [--next <text>]
```

Use `contextctl checkpoint --help` when the installed checkpoint interface is not already known; do not guess flags from an archived example.

Checkpoint at least:

- after establishing the problem and initial evidence;
- when a key fact or issue is discovered;
- whenever a hypothesis becomes confirmed, rejected, or materially revised;
- before the first business-file write;
- when selecting, changing, or abandoning a solution path;
- after a meaningful attempt or coherent batch of changes;
- after each material verification or authorization change;
- before context compaction or returning control to the user.

Store large raw outputs through `contextctl evidence --run <run_id> --session <session_token> --file <path> --label <purpose>` so the machine manifest and hash are authoritative. Standalone version 1 keeps `model-access` non-executable; do not try to turn authority text into disclosure permission. Only a future separately trusted Harness approval boundary could enable that path. Local archives may contain relevant sensitive material, but do not copy unrelated secrets and never place the archive inside the business repository or upload it.

## Exit diagnosis mode

Before routing onward, checkpoint:

- confirmed facts and conclusions with evidence IDs;
- pending, rejected, and unresolved hypotheses;
- attempts, failures, reversals, and side effects;
- inspected architecture/files and the affected change surface;
- the selected path or current blocker;
- modified files and their attribution/verification state;
- the unique next objective, prerequisites, forbidden actions, and unresolved risks.

Use `verify-and-handoff` before claiming success. Diagnosis can provide evidence for an `analyzed` claim; only scoped verification may mark it supported. It never implies `implemented`, `verified`, `committed`, `pushed`, `deployed`, or `accepted`.
