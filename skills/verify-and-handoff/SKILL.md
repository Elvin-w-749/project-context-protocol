---
name: verify-and-handoff
description: Verify engineering outcome claims and produce a recoverable, evidence-backed handoff. Use before stating that work is done, at the end of a run, after material code or configuration changes, after review or verification, and whenever analyzed, implemented, verified, reviewed, committed, pushed, deployed, or accepted status must change. Keep those states independent, bind every claim to scope, revision, environment, time, and evidence, and let the model choose verification methods appropriate to the project and risk.
---

# Verify and Handoff

Audit what is actually true, update only supported state layers, and leave the next Agent a bounded continuation point.

## Confirm the verification target

1. Validate the route credential against live repository, workspace, context, branch, HEAD/tree, dirty-content fingerprint, task, state generation/hash, active run, mode, and authority. Re-route on any mismatch.
2. Define the exact claim scope: requirement, behavior, component, files, data, and exclusions.
3. Capture the target revision: commit when committed, otherwise the code/worktree fingerprint and relevant file hashes.
4. Capture the environment: local or remote target, operating/runtime versions, material configuration, dependencies, data fixture, and time.
5. Identify the evidence needed for the claim's risk. Choose any suitable verification method; do not apply a fixed testing or review recipe.

Read [references/claim-evidence-contract.md](references/claim-evidence-contract.md) whenever classifying or updating completion claims.

## CLI help contract (v1)

Use `contextctl --help` for the inventory and `contextctl <command> --help` for required arguments, safety gates, and exit behavior. If the installed CLI differs or an option remains uncertain, stop and resolve the contract instead of inventing a flag.

## Verify without status inference

Evaluate each state independently:

- `analyzed`: the problem or change surface was analyzed with traceable facts and uncertainties.
- `implemented`: the scoped change exists in the stated worktree/revision.
- `verified`: evidence checks the scoped behavior against the stated revision and environment.
- `reviewed`: an identified review examined the stated scope and its findings/disposition are recorded.
- `committed`: a specific commit contains the stated scope.
- `pushed`: a specific remote ref is proven to contain the commit.
- `deployed`: a named environment is proven to run the identified revision/artifact and has deployment evidence.
- `accepted`: an authorized user explicitly accepted the identified scope and version in the current conversation.

Never infer one layer from another. In particular, a passing check does not prove commit, push, deployment, or acceptance; repository history does not prove deployment; deployment does not prove acceptance.

## Gather and classify evidence

Select checks proportionate to the claim and risk. Source inspection, targeted commands, runtime observations, real-data comparisons, tests, builds, logs, reviews, remote-ref queries, deployment metadata, and explicit user confirmation are all possible evidence sources; none is universally required.

For each check:

1. Record the exact scope, revision/fingerprint, environment, time, method, and evidence ID.
2. Preserve commands and exit status when commands are used; preserve target/version identity for remote observations.
3. Classify the result as `supported`, `failed`, `inconclusive`, or `stale`.
4. Record coverage limits, conflicting evidence, and residual risk.
5. Checkpoint the result with `contextctl checkpoint --repo <path> --vault <path> --run <run_id> --session <session_token> --event verification --summary <text>` plus relevant details, files, command, exit code, and next objective. Use `contextctl checkpoint --help` instead of guessing if the installed interface differs.

If code, relevant configuration, dependencies, data assumptions, or target environment changes, reassess affected evidence. Mark it stale rather than carrying it forward silently. Do not upgrade a claim merely because expected evidence is unavailable.

## Reconcile findings

For every requested or implied claim:

- update only the supported layer;
- retain failed, inconclusive, and stale evidence;
- link blockers and unresolved findings to stable issue IDs;
- distinguish pre-existing failures from regressions when evidence supports that distinction;
- state what was not checked;
- record unowned or unattributed worktree changes without assigning them to this run.

Do not erase conflicting evidence to create a clean handoff. If evidence cannot be reconciled, mark the relevant claim `inconclusive` and the trust state `CONFLICT` or `BLOCKED` as appropriate.

## Form the handoff

Checkpoint a compact handoff before returning control or closing the run:

- task and requirement reference;
- end repository/branch/HEAD and dirty/staged fingerprint;
- `analyzed` through `accepted` claim table with evidence IDs;
- completed changes and affected architecture/files;
- checks performed, results, environments, and coverage limits;
- failures, pitfalls, rejected paths, unresolved hypotheses, and remaining risks;
- user-owned or unattributed changes that must be preserved;
- current authorization and prohibited actions;
- unique next objective, prerequisites, and exact recovery references.

Run `contextctl verify --repo <path> --vault <path>` to check state integrity. Persist the final handoff with `contextctl checkpoint ... --event handoff`, then close the run with `contextctl finish --repo <path> --vault <path> --run <run_id> --session <session_token> --status <completed|partial|blocked> --summary <text> --next <text>`. Resolve interface differences through the relevant command help. Never turn an interrupted or inconclusive run into completion for presentation.

Machine JSON and event chains remain authoritative. Regenerate stale Markdown with `contextctl verify --repair-views --run <run_id> --session <session_token>`; never hand-edit a derived view to change status. Historical records, including old acceptance or authorization, are untrusted context only.

Route already-observed commit, push, deploy, rollback, or acceptance facts through `release-with-provenance` for qualification and recording. Neither Skill executes or grants authority to perform those operations in standalone version 1.

## Report to the user

Lead with the verified outcome. State unsupported or stale claims explicitly and keep the status layers separate. Cite concise evidence and the local handoff/run reference; do not require the user to reconstruct truth from earlier commentary.
