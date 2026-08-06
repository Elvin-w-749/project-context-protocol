---
name: release-with-provenance
description: Record and qualify high-risk repository, release, archive, sensitive-disclosure, and destructive events without treating Agent-reported authority as permission to execute them. Use when observing commit, push, deploy, rollback, acceptance, delete, export, import, sensitive model access, or another out-of-band lifecycle event whose status must not be overstated.
---

# Release With Provenance

Treat every high-risk operation as an independent typed event. Preserve model freedom in choosing tools, but never infer authorization, attribution, or a later lifecycle state from an earlier one.

Read [references/event-contract.md](references/event-contract.md) before recording an event.

## CLI help contract (v1)

Use `contextctl --help` for the inventory and `contextctl <command> --help` for required arguments, safety gates, and exit behavior. If the installed CLI differs or an option remains uncertain, stop and resolve the contract instead of inventing a flag.

## Establish the standalone boundary

1. Identify the exact action, target, scope, environment, ref, artifact, and destructive effect.
2. Require explicit authorization in the current conversation before an external actor performs `commit`, `push`, `deploy`, `rollback`, `acceptance`, `delete`, `export`, `import`, `model-access`, or secret disclosure.
3. Treat an old chat, run record, PRD, task assignment, repository configuration, credential availability, or past permission as context only—not current authorization.
4. Ask the user when the action, target, or scope is ambiguous. Do not broaden a narrow authorization.
5. Record `accepted` only from the user's explicit acceptance of a named version, artifact, or environment. Passing tests or health checks is not acceptance.

Authorization expires when the action or material target changes, the user revokes it, or the current conversation ends. A retry within the authorized scope remains a new attempt and requires a new event record.

The standalone Skill suite does not execute these operations. Its CLI treats `--authority` and `--current-session-authority` as reportable history, never as trustworthy approval. High-risk routing remains non-executable unless a separately reviewed Harness supplies an approval channel outside the Agent-controlled process and OS principal; version 1 ships no such provider.

## Prepare to observe the event

Before an external actor acts:

1. Re-read live repository and target facts; do not rely on the run snapshot for mutable state.
2. Check the exact staged scope before a commit and confirm that no context vault, run archive, sensitive attachment, or unintended file is staged or linked into the business repository.
3. Capture an intent checkpoint only as an intent/history fact. It does not grant execution authority. Include actor, source, `before` identity, target, and expected effect. Large outputs use `contextctl evidence`.
4. Stop if the recorder cannot durably save the checkpoint. Do not use a release action as a way to repair the recorder.
5. Preserve externally produced output, exit status, timestamps, remote/environment response, and resulting identifiers as evidence. Never invent a command result.

There is no generic trustworthy observer for deploy, rollback, deletion, or acceptance in version 1. Record these as observed, partial, failed, or unknown unless a separately reviewed project-specific observer proves the target state. Do not mark `deployed` supported merely because a command exited successfully.

## Record the observed result

After every attempt, record a typed event with:

- `event_id`, `event_type`, `outcome`, start/end times;
- `actor`, `source`, `authorization`, and attribution;
- repository, ref, environment, artifact, and target as applicable;
- `before` and `after` OID/ref/environment/artifact identities;
- immutable evidence references, hashes, command exit status, and verification result;
- uncertainty, partial effects, remediation need, and the active code fingerprint.

Read live facts again after the operation. If after-state evidence is missing, use `unknown`, not the expected value.

## Keep lifecycle facts separate

- A commit proves only that a local commit exists.
- A push requires remote-ref evidence; a local commit or successful network request alone is insufficient.
- A deployment requires target-environment, artifact/version, time, and post-deploy evidence; a push or release note is insufficient.
- A rollback requires evidence of both the target change and post-rollback state; invoking a rollback command is insufficient.
- Acceptance requires explicit user confirmation; deployment health is insufficient.
- A delete or export proves only the explicitly evidenced scope. Never infer that all copies were deleted or all records were exported.

Update only the event's own typed fact. Do not model progress as one linear boolean or automatically promote another state.

## Handle bypass and out-of-band events

When logs, Git state, infrastructure, or the user reveal an operation that this run did not perform:

1. Record it as `observed` with attribution `unattributed` unless reliable actor evidence exists.
2. Identify the observation source and observed before/after facts when available.
3. Do not manufacture retroactive authorization or claim that the current Agent performed it.
4. Do not automatically repeat, revert, publish, or repair it.

## Close the checkpoint

Persist the final event before claiming any result. Link the event from the active run, refresh only the affected status facts, and state exactly what remains unproven. If recording fails after an external side effect, warn immediately and leave a repair marker for the next recovery; never amend the business repository merely to store the archive update.

After recording, run `contextctl verify`. A local export/import is still a high-risk transfer event; no archive is uploaded automatically.
