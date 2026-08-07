# Project Context Protocol

Project Context Protocol is a local-first Skill suite and deterministic CLI for recovering project state, recording each Agent run, mapping repository structure, and preserving evidence-backed handoffs without prescribing how a model must solve a problem.

This repository is a focused redesign inspired by the MIT-licensed `superpowers` workflow collection. It keeps the original license attribution while replacing the broad workflow set with the four context-control responsibilities below. The source checkout used for reference is never modified by this project.

The full local vault is stored outside the target Git worktree and is never uploaded by the suite. The only optional network-capable operation is an explicitly requested, credential-free, read-only `git ls-remote` observation used to verify one exact pushed ref over allowlisted HTTPS or Git transport; a local-file remote needs no network. SSH, HTTP, UNC/network shares, remote-host `file://`, embedded credentials, and custom helpers are rejected. All other network or model activity belongs to the surrounding Agent/Harness. This does not imply that an Agent or remote model reading vault content keeps that content on the machine.

The suite has no default Vault location. Before every new Agent session, the Agent or trusted Harness must ask the current user for the absolute local path to open or store the Vault. A path found in old state, a previous conversation, an environment variable, a familiar drive, or an existing directory is not current-session confirmation. The CLI is intentionally non-interactive: it fails closed when the caller has not supplied the selected path and the required session-start declaration.

## 使用指南

- [项目上下文控制协议 Skills 使用指南（PDF）](docs/项目上下文控制协议_Skills使用指南.pdf)

## Skills

- `project-context-protocol`: trusted recovery, routing, run lifecycle, architecture and file maps.
- `diagnose-and-decide`: evidence-led diagnosis with freedom to choose tools and solution paths.
- `verify-and-handoff`: scoped claim verification and recoverable handoff.
- `release-with-provenance`: precise, independently qualified Git/deployment observations and authorization boundaries.

## Install and verify

The suite has no runtime package dependencies and requires Node.js 20.9 or newer, Git, and (for repository publication only) GitHub CLI.

```powershell
git clone https://github.com/wangyixin19898-png/project-context-protocol.git H:\superpowers-context
Set-Location H:\superpowers-context
npm run verify
npm link
contextctl --help
context-adapter --help
```

`npm link` exposes the two local commands without installing a Hook or changing a target repository. An Agent/Harness integration must call `context-adapter` explicitly; otherwise capture is correctly reported as degraded.

To upgrade, preserve the external vault, pull a reviewed suite revision, run `npm run verify`, run `npm link` again, ask the current user to select the Vault path, and then run `contextctl doctor --repo <path> --vault <selected-absolute-path> --vault-confirmed-by-user` against each managed project. Do not migrate a non-empty pre-protocol vault by inventing an ACL marker: move it aside under explicit user control or implement and review a migration. Protocol generations remain immutable.

To uninstall the commands, run `npm unlink -g project-context-protocol` (or `npm uninstall -g project-context-protocol` if installed globally). Uninstalling never deletes any user-selected Vault; archive or delete that local sensitive data only with explicit user authorization.

## CLI

```powershell
$Vault = Read-Host 'Absolute local Vault path selected for this Agent session'
node skills/project-context-protocol/scripts/contextctl.mjs resume --repo H:\Project --vault $Vault --vault-confirmed-by-user
# Only when the Recovery Card says UNMANAGED:
node skills/project-context-protocol/scripts/contextctl.mjs register --repo H:\Project --vault $Vault --vault-confirmed-by-user --task "Current task"
node skills/project-context-protocol/scripts/contextctl.mjs begin --repo H:\Project --vault $Vault --vault-confirmed-by-user --request "User request"
node skills/project-context-protocol/scripts/contextctl.mjs route --repo H:\Project --vault $Vault --run RUN-... --session SESSION-... --event error
```

Run `contextctl --help` for the command inventory and `contextctl <command> --help` for that command's required arguments, safety gates, and exit behavior. If an option is uncertain, stop and resolve the contract instead of inventing a flag. Run `npm run verify` before installation or publication.

Each new Agent session follows `ask for the absolute Vault path and wait → resume → register if needed → begin → route`. `begin` is required even for an already registered project. A recovered session creates a new run with `--recover`; it never rewrites the interrupted run.

For a single lifecycle entry point, use the bundled adapter:

```powershell
$Vault = Read-Host 'Absolute local Vault path selected for this Agent session'
context-adapter session-start --repo H:\Project --vault $Vault --vault-confirmed-by-user --task "Current task"
context-adapter heartbeat --repo H:\Project --vault $Vault --run RUN-... --session SESSION-...
context-adapter session-stop --repo H:\Project --vault $Vault --run RUN-... --session SESSION-...
```

`session-start` performs recovery, optional first registration, run creation, deterministic routing, and returns the bounded Recovery Card. `heartbeat` is an authenticated checkpoint that renews the active-run lease. `session-stop` records a handoff and defaults to `partial`; it never infers completion. The standalone adapter never launches child programs, because an arbitrary child could bypass routing and perform a high-risk action. Without a genuinely installed lifecycle Hook, every adapter result is explicitly marked `degraded-no-installed-hook`; it cannot observe bypassed tools or hidden Agents.

The current CLI provides `register`, `begin`, `resume`, `route`, `checkpoint`, `map`, `evidence`, `verify`, `finish`, and `doctor`. `export` and `import` are reserved command contracts but remain fail-closed in standalone version 1; no archive is copied, uploaded, or adopted through them.

## Git and release observations

The standalone suite never executes `commit`, `push`, `deploy`, `rollback`, `delete`, or `acceptance`. It records those operations only after they happen outside the suite, with attribution such as `observed` or `unattributed` and with the strongest available live evidence. A local commit does not prove a push, a push does not prove deployment, and health does not prove user acceptance.

High-risk routes are deliberately non-executable in standalone version 1. `--authority` and `--current-session-authority` are historical declarations, not cryptographic proof that the current user approved an operation. Enabling automatic execution requires a separately reviewed Harness integration whose approval channel is outside the Agent-controlled process and operating-system principal. This repository does not ship or bootstrap such a provider.

## Safety boundaries

- Vault records are local files and are not automatically committed or synchronized.
- After the user selects a Vault location, version 1 stores its records as local plaintext. Review OS permissions and prefer an encrypted volume before storing real credentials or customer data.
- The CLI never uploads vault data. An explicitly opted-in, credential-free push observation may query one exact HTTPS/Git remote ref with `git ls-remote`; local-file remotes stay local, and SSH/HTTP/UNC/custom transports are rejected. A remote Agent/model can separately transmit any vault content it reads.
- A historical or Agent-reported authorization record never authorizes a new commit, push, deployment, rollback, deletion, export, or secret disclosure.
- Every new run has a bounded heartbeat lease. An expired, missing, or malformed active-run lease is a disconnected-run conflict; it is never promoted to completed and cannot be silently revived by an old process.
- On Windows, a newly created vault root is fail-closed unless its ACL is protected and restricted to the current identity, SYSTEM, and Builtin Administrators. The root marker contains only status/fingerprint metadata. Non-Windows builds report ACL enforcement as degraded.
- The adapter mediates session lifecycle only; it is not a Git or deployment executor. Out-of-band changes are detected later and recorded as observed/unattributed.
- Every supported progress layer, including `analyzed`, is bound to the recorded revision, tree, and dirty-content fingerprint. A later source change preserves the claim as history but marks it stale before it can be reused as current project truth.
- Fresh clones do not have another device's local vault unless the user explicitly transfers it.
- Hashes, route credentials, and event chains detect internal inconsistency and stale bindings; they do not prove identity, user authorization, or absolute truth.

## Repository support boundary

Version 1 requires the target to be a valid Git worktree. A non-Git target is `BLOCKED` for protocol registration and trusted task adoption; it is not `READY`. An Agent may separately perform a user-authorized manual inspection as degraded/unmanaged work, but must not claim a valid Recovery Card, protocol verification, or recoverable handoff for that target.

## Portability boundary

The generic mapper inventories manifests, top-level structure, candidate layers, relative imports, declarations, and literal route-registration candidates. It contains no project-specific architecture rules. Semantic architecture, current bottlenecks, and cross-layer impact are added only as evidence-scoped claims from bounded source inspection.

Only `project-context-protocol` allows implicit invocation. Focused Skills are selected by deterministic `contextctl route` output. Unknown Agent platforms still require an installed lifecycle Hook, a root instruction, or manual startup; the suite never claims universal automatic triggering or ships an arbitrary-program launcher.
