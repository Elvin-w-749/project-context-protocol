import { existsSync, openSync, closeSync, fsyncSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import {
  PROTOCOL_VERSION,
  assert,
  assertSafeId,
  atomicCreate,
  atomicWrite,
  canonicalPath,
  ensureDir,
  isWithin,
  inlineMarkdown,
  markdownList,
  nowIso,
  quoteMarkdown,
  randomId,
  randomSecret,
  readJson,
  recoverAtomicTarget,
  sha256,
  stableJson,
  tableMarkdown,
  writeJsonAtomic,
  writeJsonExclusive
} from './util.mjs'

const RUN_STATUSES = new Set(['initializing', 'active', 'completed', 'partial', 'blocked', 'interrupted', 'failed-to-adopt'])
const EVENT_TYPES = new Set(['session-start', 'observation', 'hypothesis', 'decision', 'attempt', 'change', 'verification', 'authorization', 'git', 'release', 'handoff', 'session-finish', 'external-change', 'model-access'])
const RUN_LEASE_PROTOCOL = 'project-context/run-lease/v1'
const VAULT_ACL_PROTOCOL = 'project-context/vault-acl/v1'
const DEFAULT_RUN_LEASE_SECONDS = 15 * 60
const MIN_RUN_LEASE_SECONDS = 5
const MAX_RUN_LEASE_SECONDS = 24 * 60 * 60
const LOCK_INITIALIZATION_RETRY_DELAYS_MS = Object.freeze([2, 4, 8, 16, 32, 50])
const LOCK_INITIALIZATION_WAIT = new Int32Array(new SharedArrayBuffer(4))

function normalizedRunLeaseSeconds(value = DEFAULT_RUN_LEASE_SECONDS) {
  const seconds = Number.parseInt(String(value), 10)
  assert(Number.isInteger(seconds) && seconds >= MIN_RUN_LEASE_SECONDS && seconds <= MAX_RUN_LEASE_SECONDS, `Run lease must be between ${MIN_RUN_LEASE_SECONDS} and ${MAX_RUN_LEASE_SECONDS} seconds`, 'RUN_LEASE_TTL_INVALID')
  return seconds
}

function newRunLease(options = {}) {
  const ttlSeconds = normalizedRunLeaseSeconds(options.ttlSeconds)
  const heartbeatAt = options.heartbeatAt || nowIso()
  return {
    protocol: RUN_LEASE_PROTOCOL,
    heartbeatAt,
    expiresAt: new Date(Date.parse(heartbeatAt) + ttlSeconds * 1000).toISOString(),
    ttlSeconds,
    source: options.source || 'manual-cli',
    holder: {
      host: options.host || os.hostname(),
      recorderPid: options.recorderPid || process.pid
    }
  }
}

export function runLeaseStatus(run, now = Date.now()) {
  if (!run || !['active', 'initializing'].includes(run.status)) return { status: 'not-active', reason: 'The run is not active.' }
  const lease = run.lease
  if (!lease) return { status: 'missing', reason: 'The active run has no lifecycle lease.' }
  const heartbeat = Date.parse(lease.heartbeatAt)
  const expires = Date.parse(lease.expiresAt)
  if (lease.protocol !== RUN_LEASE_PROTOCOL || !Number.isFinite(heartbeat) || !Number.isFinite(expires) || expires <= heartbeat) {
    return { status: 'invalid', reason: 'The active run lifecycle lease is malformed.' }
  }
  if (expires <= now) return { status: 'expired', reason: `The active run lease expired at ${lease.expiresAt}; treat the run as disconnected until explicitly recovered.` }
  return { status: 'active', heartbeatAt: lease.heartbeatAt, expiresAt: lease.expiresAt, ttlSeconds: lease.ttlSeconds, source: lease.source }
}

function windowsAclSnapshot(vault) {
  const script = `$ErrorActionPreference='Stop'
$target=[System.IO.Path]::GetFullPath($env:PCP_VAULT_ACL_PATH)
$acl=[System.IO.Directory]::GetAccessControl($target,[System.Security.AccessControl.AccessControlSections]::Access)
$encode={ param([string]$value) [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value)) }
$tab=[char]9
$protected=if($acl.AreAccessRulesProtected){'1'}else{'0'}
[Console]::Out.WriteLine("P"+$tab+$protected)
[Console]::Out.WriteLine("C"+$tab+(& $encode ([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)))
foreach($rule in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {
  $inherited=if($rule.IsInherited){'1'}else{'0'}
  $fields=@(
    (& $encode $rule.IdentityReference.Value),
    (& $encode $rule.FileSystemRights.ToString()),
    (& $encode $rule.AccessControlType.ToString()),
    $inherited,
    (& $encode $rule.InheritanceFlags.ToString()),
    (& $encode $rule.PropagationFlags.ToString())
  )
  [Console]::Out.WriteLine("R"+$tab+[string]::Join($tab,$fields))
}`
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    env: { ...process.env, PCP_VAULT_ACL_PATH: vault },
    windowsHide: true,
    timeout: 15_000
  }).trim()
  const decode = (value) => Buffer.from(value, 'base64').toString('utf8')
  const result = { protected: false, currentSid: null, rules: [] }
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    const fields = line.split('\t')
    if (fields[0] === 'P') result.protected = fields[1] === '1'
    else if (fields[0] === 'C') result.currentSid = decode(fields[1])
    else if (fields[0] === 'R' && fields.length === 7) {
      result.rules.push({
        sid: decode(fields[1]),
        rights: decode(fields[2]),
        type: decode(fields[3]),
        inherited: fields[4] === '1',
        inheritance: decode(fields[5]),
        propagation: decode(fields[6])
      })
    }
  }
  assert(result.currentSid && /^S-1-\d+(?:-\d+)+$/i.test(result.currentSid), 'Windows ACL snapshot did not return the current SID', 'VAULT_ACL_INSPECTION_INVALID')
  return result
}

function hardenWindowsVaultAcl(vault) {
  const script = `$ErrorActionPreference='Stop'
$target=[System.IO.Path]::GetFullPath($env:PCP_VAULT_ACL_PATH)
$current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$candidates=@(
  $current,
  [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
  [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
)
$required=[System.Collections.Generic.List[System.Security.Principal.SecurityIdentifier]]::new()
$seen=[System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach($sid in $candidates) { if($seen.Add($sid.Value)) { $required.Add($sid) } }
$acl=[System.IO.Directory]::GetAccessControl($target,[System.Security.AccessControl.AccessControlSections]::Access)
$acl.SetAccessRuleProtection($true,$false)
foreach($rule in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) { [void]$acl.RemoveAccessRuleSpecific($rule) }
$inherit=[System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
foreach($sid in $required) {
  $rule=[System.Security.AccessControl.FileSystemAccessRule]::new(
    $sid,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    $inherit,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  [void]$acl.AddAccessRule($rule)
}
[System.IO.Directory]::SetAccessControl($target,$acl)`
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    env: { ...process.env, PCP_VAULT_ACL_PATH: vault },
    windowsHide: true,
    timeout: 15_000
  })
}

export function inspectVaultAcl(vault) {
  if (process.platform !== 'win32') {
    return {
      protocol: VAULT_ACL_PROTOCOL,
      platform: process.platform,
      status: 'degraded-non-windows-not-enforced',
      enforced: false,
      fingerprint: null
    }
  }
  try {
    const snapshot = windowsAclSnapshot(vault)
    const required = new Set([snapshot.currentSid, 'S-1-5-18', 'S-1-5-32-544'])
    const normalizedRules = snapshot.rules.map((rule) => ({
      sid: String(rule.sid),
      rights: String(rule.rights),
      type: String(rule.type),
      inherited: Boolean(rule.inherited),
      inheritance: String(rule.inheritance),
      propagation: String(rule.propagation)
    })).sort((left, right) => stableJson(left, 0).localeCompare(stableJson(right, 0)))
    const unexpected = normalizedRules.filter((rule) => !required.has(rule.sid) || rule.type !== 'Allow' || rule.inherited)
    const missing = [...required].filter((sid) => !normalizedRules.some((rule) => rule.sid === sid && rule.type === 'Allow' && /FullControl/i.test(rule.rights) && !rule.inherited))
    const safe = snapshot.protected === true && unexpected.length === 0 && missing.length === 0
    return {
      protocol: VAULT_ACL_PROTOCOL,
      platform: 'win32',
      status: safe ? 'hardened-and-verified' : 'unsafe-or-incomplete',
      enforced: safe,
      fingerprint: sha256(stableJson({ protected: Boolean(snapshot.protected), rules: normalizedRules }))
    }
  } catch (error) {
    return {
      protocol: VAULT_ACL_PROTOCOL,
      platform: 'win32',
      status: 'inspection-failed',
      enforced: false,
      fingerprint: null
    }
  }
}

function enforceVaultAcl(paths, rootExisted, priorEntries) {
  if (process.platform === 'win32') {
    const markerExisted = existsSync(paths.vaultAcl)
    assert(markerExisted || !rootExisted || priorEntries.length === 0, 'An existing non-empty vault has no ACL marker; explicit one-time ACL migration is required before use', 'VAULT_ACL_MIGRATION_REQUIRED')
    if (!markerExisted) {
      try {
        hardenWindowsVaultAcl(paths.vault)
      } catch (error) {
        const wrapped = new Error(`Failed to harden the new vault root ACL: ${error.message}`)
        wrapped.code = 'VAULT_ACL_HARDENING_FAILED'
        throw wrapped
      }
    }
  }
  const inspected = inspectVaultAcl(paths.vault)
  if (process.platform === 'win32') assert(inspected.enforced, `Vault ACL is not safely enforced (${inspected.status})`, 'VAULT_ACL_UNSAFE')
  writeJsonAtomic(paths.vaultAcl, { ...inspected, checkedAt: nowIso() })
  return inspected
}

function waitForLockInitialization(milliseconds) {
  Atomics.wait(LOCK_INITIALIZATION_WAIT, 0, 0, milliseconds)
}

function validLockOwner(owner) {
  return Boolean(
    owner &&
    typeof owner === 'object' &&
    typeof owner.token === 'string' &&
    owner.token.length > 0 &&
    Number.isInteger(owner.pid) &&
    owner.pid > 0 &&
    typeof owner.host === 'string' &&
    owner.host.length > 0 &&
    typeof owner.acquiredAt === 'string' &&
    Number.isFinite(Date.parse(owner.acquiredAt))
  )
}

function readLockOwnerAfterInitialization(lockFile) {
  let lastError = null
  for (let attempt = 0; attempt <= LOCK_INITIALIZATION_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const owner = readJson(lockFile)
      if (!validLockOwner(owner)) throw new SyntaxError('Lock owner record is malformed')
      return { status: 'owned', owner }
    } catch (error) {
      lastError = error
      if (error.code === 'ENOENT') return { status: 'gone' }
      if (attempt < LOCK_INITIALIZATION_RETRY_DELAYS_MS.length) {
        waitForLockInitialization(LOCK_INITIALIZATION_RETRY_DELAYS_MS[attempt])
      }
    }
  }
  return { status: 'corrupt', error: lastError }
}

function withOwnedLockFile(lockFile, callback) {
  ensureDir(path.dirname(lockFile))
  const owner = { token: `${process.pid}-${Math.random().toString(16).slice(2)}`, pid: process.pid, host: os.hostname(), acquiredAt: nowIso() }
  let descriptor
  const acquire = () => {
    descriptor = openSync(lockFile, 'wx', 0o600)
    try {
      writeFileSync(descriptor, stableJson(owner), 'utf8')
      fsyncSync(descriptor)
    } catch (error) {
      closeSync(descriptor)
      descriptor = undefined
      // This process created the path exclusively and never published a valid
      // owner record, so removing this failed acquisition is ownership-safe.
      rmSync(lockFile, { force: true })
      throw error
    }
    closeSync(descriptor)
    descriptor = undefined
  }
  let acquisitionCollisions = 0
  while (true) {
    try {
      acquire()
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    const observed = readLockOwnerAfterInitialization(lockFile)
    if (observed.status === 'gone') {
      acquisitionCollisions += 1
      if (acquisitionCollisions <= 4) continue
      const wrapped = new Error(`Lock ownership changed repeatedly while acquiring ${lockFile}`)
      wrapped.code = 'STATE_LOCKED'
      throw wrapped
    }
    if (observed.status === 'corrupt') {
      const wrapped = new Error(`Lock is present but unreadable: ${lockFile}`)
      wrapped.code = 'STATE_LOCK_CORRUPT'
      throw wrapped
    }
    const existing = observed.owner
    // PID liveness is only evidence about the record that was read. It cannot
    // prove that the pathname still names that record at unlink time: a stale
    // owner may disappear and a new writer may acquire the same path between
    // read and rmSync. Never auto-delete or take over a published lock.
    const wrapped = new Error(`Another writer owns ${lockFile} (host ${existing.host}, pid ${existing.pid}); stale locks require explicit out-of-band recovery`)
    wrapped.code = 'STATE_LOCKED'
    throw wrapped
  }
  try {
    return callback()
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    try {
      const current = readJson(lockFile)
      if (current.token === owner.token) rmSync(lockFile, { force: true })
    } catch {
      // Never delete a lock whose ownership cannot be proven.
    }
  }
}

function enclosingGitMarker(candidate) {
  let cursor = canonicalPath(candidate)
  while (true) {
    if (existsSync(path.join(cursor, '.git')) || (existsSync(path.join(cursor, 'HEAD')) && existsSync(path.join(cursor, 'objects')) && existsSync(path.join(cursor, 'refs')))) return cursor
    const parent = path.dirname(cursor)
    if (parent === cursor) return null
    cursor = parent
  }
}

export function validateVaultLocation(vaultInput, observation) {
  const vault = canonicalPath(vaultInput)
  assert(!vault.startsWith('\\\\'), 'UNC vaults require an explicit future degraded mode', 'UNSAFE_VAULT_ROOT')
  assert(!isWithin(vault, observation.root), 'Vault must be outside the target worktree', 'VAULT_INSIDE_REPOSITORY')
  assert(!isWithin(vault, observation.gitCommonDir), 'Vault must be outside the Git common directory', 'VAULT_INSIDE_GIT_DIR')
  assert(!isWithin(observation.root, vault), 'Target repository must not be nested inside the vault', 'REPOSITORY_INSIDE_VAULT')
  const enclosingRepository = enclosingGitMarker(vault)
  assert(!enclosingRepository, `Vault must not be inside another Git repository (${enclosingRepository})`, 'VAULT_INSIDE_OTHER_REPOSITORY')
  return vault
}

export function vaultPaths(vaultInput, observation) {
  const vault = validateVaultLocation(vaultInput, observation)
  const repository = path.join(vault, 'repositories', observation.repoId)
  const workspace = path.join(repository, 'workspaces', observation.workspaceId)
  const context = path.join(workspace, 'contexts', observation.contextId)
  return {
    vault,
    protocolKey: path.join(vault, '.protocol-key'),
    vaultAcl: path.join(vault, '.vault-acl.json'),
    registry: path.join(vault, 'registry.json'),
    repository,
    repositoryMetadata: path.join(repository, 'repository.json'),
    workspace,
    context,
    state: path.join(context, 'state'),
    generations: path.join(context, 'state', 'generations'),
    currentPointer: path.join(context, 'state', 'current.json'),
    projectContext: path.join(context, 'PROJECT_CONTEXT.md'),
    architecture: path.join(context, 'ARCHITECTURE.md'),
    fileIndex: path.join(context, 'FILE_INDEX.md'),
    maps: path.join(context, 'maps'),
    mapPointer: path.join(context, 'maps', 'current.json'),
    issues: path.join(context, 'OPEN_ISSUES.md'),
    decisions: path.join(context, 'DECISIONS.md'),
    trees: path.join(context, 'trees'),
    runs: path.join(context, 'runs'),
    events: path.join(context, 'events'),
    evidence: path.join(context, 'evidence'),
    imports: path.join(context, 'imports'),
    locks: path.join(context, 'locks')
  }
}

export function ensureVault(paths, observation) {
  const initializedVault = existsSync(paths.registry) || existsSync(paths.repositoryMetadata) || existsSync(paths.currentPointer)
  const rootExisted = existsSync(paths.vault)
  const priorEntries = rootExisted ? readdirSync(paths.vault) : []
  ensureDir(paths.vault)
  enforceVaultAcl(paths, rootExisted, priorEntries)
  for (const directory of [paths.repository, paths.workspace, paths.context, paths.state, paths.generations, paths.trees, paths.maps, paths.runs, paths.events, paths.evidence, paths.imports, paths.locks]) {
    ensureDir(directory)
  }
  if (!existsSync(paths.protocolKey)) {
    assert(!initializedVault, 'An initialized vault is missing its protocol signing key; explicit recovery or a fresh vault is required', 'PROTOCOL_KEY_MISSING')
    try {
      atomicCreate(paths.protocolKey, `${randomSecret(32)}\n`)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  const protocolKey = readFileSync(paths.protocolKey, 'utf8').trim()
  assert(/^[a-f0-9]{64}$/.test(protocolKey), 'Vault protocol signing key is missing or invalid', 'PROTOCOL_KEY_INVALID')
  withOwnedLockFile(path.join(paths.vault, '.locks', 'registry.lock'), () => {
    const registry = existsSync(paths.registry) ? readJson(paths.registry) : { protocol: PROTOCOL_VERSION, repositories: {} }
    const prior = registry.repositories[observation.repoId] || { workspaces: {} }
    registry.repositories[observation.repoId] = {
      ...prior,
      canonicalRemote: observation.canonicalRemote,
      lastObservedAt: observation.observedAt,
      workspaces: {
        ...(prior.workspaces || {}),
        [observation.workspaceId]: { root: observation.root, lastObservedAt: observation.observedAt }
      }
    }
    writeJsonAtomic(paths.registry, registry)
  })
  writeJsonAtomic(paths.repositoryMetadata, {
    protocol: PROTOCOL_VERSION,
    repoId: observation.repoId,
    canonicalRemote: observation.canonicalRemote,
    lastKnownRoot: observation.root,
    gitCommonDirHash: sha256(observation.gitCommonDir),
    updatedAt: nowIso()
  })
}

export function initialState(observation, options = {}) {
  return {
    protocol: PROTOCOL_VERSION,
    schemaVersion: 1,
    generation: 0,
    parentGenerationHash: null,
    repo: {
      repoId: observation.repoId,
      workspaceId: observation.workspaceId,
      contextId: observation.contextId,
      root: observation.root,
      canonicalRemote: observation.canonicalRemote,
      branch: observation.branch,
      detached: observation.detached
    },
    observation: compactObservation(observation),
    trust: { status: options.task ? 'READY' : 'UNMANAGED', reasons: options.task ? [] : ['No active task has been recorded.'] },
    stage: 'registered',
    task: options.task ? {
      id: options.taskId || randomId('TASK'),
      title: options.task,
      objective: options.objective || options.task,
      reason: options.reason || null,
      requirement: options.requirement || null,
      status: 'active'
    } : null,
    taskHistory: [],
    activeRuns: [],
    lastRun: null,
    confirmedFacts: [],
    hypotheses: [],
    blockers: [],
    pitfalls: [],
    claims: [],
    architectureClaims: [],
    imports: [],
    authorityHistory: [],
    nextObjective: options.next || null,
    map: null,
    capture: {
      mode: options.captureMode || 'manual-cli',
      coverage: options.captureCoverage || 'observed-and-agent-reported',
      warning: 'Only mediated or explicitly reported operations are captured in real time.'
    },
    updatedAt: nowIso()
  }
}

export function compactObservation(observation) {
  return {
    branch: observation.branch,
    detached: observation.detached,
    head: observation.head,
    tree: observation.tree,
    upstream: observation.upstream,
    dirty: observation.dirty,
    dirtyFileCount: observation.statusLines.length,
    changedPaths: [...(observation.changedPaths || [])],
    statusFingerprint: observation.statusFingerprint,
    observedAt: observation.observedAt
  }
}

function sealedRecord(record, field) {
  const next = { ...record }
  delete next[field]
  return { ...next, [field]: sha256(stableJson(next)) }
}

function assertRecordHash(record, field, code) {
  const sealed = sealedRecord(record, field)
  assert(record[field] === sealed[field], `Record hash mismatch for ${field}`, code)
}

export function saveRunRecord(runFile, run, { exclusive = false } = {}) {
  const sealed = sealedRecord(run, 'recordHash')
  if (exclusive) writeJsonExclusive(runFile, sealed)
  else writeJsonAtomic(runFile, sealed)
  return sealed
}

export function loadState(paths) {
  recoverAtomicTarget(paths.currentPointer)
  if (!existsSync(paths.currentPointer)) return null
  const pointer = readJson(paths.currentPointer)
  assert(pointer.protocol === PROTOCOL_VERSION, 'Current pointer protocol is invalid', 'STATE_POINTER_INVALID')
  assert(/^generation-\d{8}(?:-[a-f0-9]{12})?\.json$/.test(String(pointer.file || '')), 'Current pointer contains an unsafe generation filename', 'STATE_POINTER_INVALID')
  const generationFile = path.join(paths.generations, pointer.file)
  assert(isWithin(generationFile, paths.generations), 'State generation path escapes the vault', 'STATE_POINTER_INVALID')
  assert(existsSync(generationFile), `Missing state generation ${pointer.file}`, 'STATE_GENERATION_MISSING')
  const raw = readFileSync(generationFile, 'utf8')
  assert(sha256(raw) === pointer.sha256, 'State generation hash mismatch', 'STATE_GENERATION_CORRUPT')
  const state = JSON.parse(raw)
  assert(state.protocol === PROTOCOL_VERSION, `Unsupported protocol ${state.protocol}`, 'PROTOCOL_VERSION_UNSUPPORTED')
  assert(Number.isInteger(state.generation) && state.generation === pointer.generation, 'State and pointer generation differ', 'STATE_GENERATION_CORRUPT')
  return { state, pointer, generationFile }
}

export function writeState(paths, previous, nextState) {
  const current = loadState(paths)
  if (previous) {
    assert(current && current.pointer.sha256 === previous.pointer.sha256 && current.pointer.generation === previous.pointer.generation, 'State changed since it was read; refusing last-write-wins', 'STATE_CAS_CONFLICT')
  } else {
    assert(!current, 'State was created concurrently', 'STATE_CAS_CONFLICT')
  }
  const priorState = current?.state || null
  const generation = (priorState?.generation || 0) + 1
  const state = {
    ...nextState,
    protocol: PROTOCOL_VERSION,
    schemaVersion: 1,
    generation,
    parentGenerationHash: current?.pointer?.sha256 || null,
    updatedAt: nowIso()
  }
  const raw = stableJson(state)
  const generationHash = sha256(raw)
  const file = `generation-${String(generation).padStart(8, '0')}-${generationHash.slice(0, 12)}.json`
  const generationPath = path.join(paths.generations, file)
  atomicCreate(generationPath, raw)
  const pointer = { protocol: PROTOCOL_VERSION, generation, file, sha256: generationHash, updatedAt: nowIso() }
  writeJsonAtomic(paths.currentPointer, pointer)
  atomicWrite(paths.projectContext, renderProjectContext(state, pointer))
  renderKnowledgeViews(paths, state)
  const architectureView = renderArchitectureView(paths, state)
  if (architectureView !== null) atomicWrite(paths.architecture, architectureView)
  return { state, pointer, generationFile: generationPath }
}

export function withStateLock(paths, callback) {
  return withOwnedLockFile(path.join(paths.locks, 'state.lock'), callback)
}

export function createRun(paths, stateBundle, observation, options = {}) {
  const runId = assertSafeId(options.runId, 'run ID')
  assert(/^[a-f0-9]{64}$/.test(String(options.sessionNonceHash || '')), 'Run session nonce hash is required', 'RUN_SESSION_REQUIRED')
  assert(
    options.vaultSelection?.currentUserSelectionDeclared === true,
    'Run creation requires a current-session user-confirmed Vault location',
    'VAULT_LOCATION_CONFIRMATION_REQUIRED'
  )
  assert(
    canonicalPath(options.vaultSelection.path) === canonicalPath(paths.vault),
    'The confirmed Vault path does not match the active Vault',
    'VAULT_LOCATION_CONFIRMATION_CONFLICT'
  )
  const vaultSelection = {
    path: paths.vault,
    currentUserSelectionDeclared: true,
    declarationScope: options.vaultSelection.declarationScope || 'current-session-explicit-path',
    operation: options.vaultSelection.operation || 'begin',
    declarationRecordedAt: options.vaultSelection.declarationRecordedAt || nowIso(),
    historicalOnly: true
  }
  const month = new Date().toISOString().slice(0, 7)
  const runDir = ensureDir(path.join(paths.runs, month))
  const runFile = path.join(runDir, `${runId}.json`)
  const runMarkdown = path.join(runDir, `${runId}.md`)
  const eventDir = ensureDir(path.join(paths.events, runId))
  assert(!existsSync(runFile), `Run ${runId} already exists`, 'RUN_ALREADY_EXISTS')
  const run = {
    protocol: PROTOCOL_VERSION,
    runId,
    parentRunId: options.parentRunId || null,
    recoveredFromRunId: options.recoveredFromRunId || null,
    status: 'initializing',
    startedAt: nowIso(),
    endedAt: null,
    host: os.hostname(),
    recorderPid: process.pid,
    agentProcessLivenessTracked: Boolean(options.agentProcessLivenessTracked || /^context-adapter\//.test(String(options.leaseSource || options.harness || ''))),
    lease: newRunLease({
      ttlSeconds: options.leaseTtlSeconds,
      source: options.leaseSource || options.harness || 'manual-cli',
      host: os.hostname(),
      recorderPid: process.pid
    }),
    sessionNonceHash: options.sessionNonceHash,
    agent: options.agent || 'unspecified-agent',
    harness: options.harness || 'manual-cli',
    captureCoverage: options.captureCoverage || 'observed-and-agent-reported',
    vaultSelection,
    taskId: stateBundle.state.task?.id || null,
    taskSnapshot: stateBundle.state.task ? JSON.parse(JSON.stringify(stateBundle.state.task)) : null,
    contextReferences: {
      machineState: stateBundle.generationFile,
      projectContext: paths.projectContext,
      architecture: paths.architecture,
      fileIndex: paths.fileIndex
    },
    userRequest: options.request || null,
    authorityRecord: options.authority ? {
      text: options.authority,
      source: options.authoritySource || 'current-user-request',
      recordedAt: nowIso(),
      historicalOnly: true
    } : null,
    startObservation: compactObservation(observation),
    endObservation: null,
    eventSequence: 0,
    summary: null,
    nextObjective: null
  }
  const initialRun = saveRunRecord(runFile, run, { exclusive: true })
  const event = {
    protocol: PROTOCOL_VERSION,
    runId,
    sequence: 1,
    eventId: `${runId}-E000001`,
    type: 'session-start',
    summary: 'Run record created before project work.',
    details: options.request || null,
    actor: options.agent || 'unspecified-agent',
    source: options.harness || 'manual-cli',
    observedAt: nowIso(),
    files: [],
    command: null,
    exitCode: null,
    next: null,
    scope: null,
    evidence: [],
    metadata: {
      vaultPath: vaultSelection.path,
      currentUserVaultSelectionDeclared: true,
      declarationScope: vaultSelection.declarationScope,
      declarationRecordedAt: vaultSelection.declarationRecordedAt
    },
    previousEventHash: null
  }
  const sealedEvent = sealedRecord(event, 'eventHash')
  writeJsonExclusive(path.join(eventDir, '000001.json'), sealedEvent)
  initialRun.eventSequence = 1
  initialRun.status = 'active'
  const activeRun = saveRunRecord(runFile, initialRun)
  atomicWrite(runMarkdown, renderRun(activeRun, readEvents(eventDir)))
  return { run: activeRun, runFile, runMarkdown, eventDir }
}

// Call only while holding the context state lock. Expired or malformed leases
// cannot be revived; recovery must create a new, explicitly related run.
export function renewRunLease(paths, runId, options = {}) {
  const found = findRun(paths, runId)
  assert(found, `Run ${runId} was not found`, 'RUN_NOT_FOUND')
  assertRecordHash(found.run, 'recordHash', 'RUN_RECORD_CORRUPT')
  const status = runLeaseStatus(found.run)
  assert(status.status === 'active', status.reason, `RUN_LEASE_${status.status.toUpperCase().replace(/-/g, '_')}`)
  found.run.lease = newRunLease({
    ttlSeconds: options.ttlSeconds || found.run.lease.ttlSeconds,
    source: options.source || found.run.lease.source,
    host: found.run.lease.holder?.host || found.run.host,
    recorderPid: found.run.lease.holder?.recorderPid || found.run.recorderPid
  })
  found.run = saveRunRecord(found.runFile, found.run)
  atomicWrite(found.runMarkdown, renderRun(found.run, readEvents(found.eventDir)))
  return { run: found.run, lease: runLeaseStatus(found.run) }
}

export function findRun(paths, runId) {
  assertSafeId(runId, 'run ID')
  if (!existsSync(paths.runs)) return null
  for (const month of readdirSync(paths.runs, { withFileTypes: true })) {
    if (!month.isDirectory()) continue
    const candidate = path.join(paths.runs, month.name, `${runId}.json`)
    if (existsSync(candidate)) {
      return {
        runFile: candidate,
        runMarkdown: candidate.replace(/\.json$/i, '.md'),
        eventDir: path.join(paths.events, runId),
        run: readJson(candidate)
      }
    }
  }
  return null
}

export function readEvents(eventDir) {
  if (!existsSync(eventDir)) return []
  return readdirSync(eventDir).filter((name) => /^\d{6}\.json$/.test(name)).sort().map((name) => readJson(path.join(eventDir, name)))
}

export function appendRunEvent(paths, runId, input) {
  const found = findRun(paths, runId)
  assert(found, `Run ${runId} was not found`, 'RUN_NOT_FOUND')
  assertRecordHash(found.run, 'recordHash', 'RUN_RECORD_CORRUPT')
  assert(['active', 'initializing'].includes(found.run.status), `Run ${runId} is not active`, 'RUN_NOT_ACTIVE')
  assert(EVENT_TYPES.has(input.type), `Unsupported event type ${input.type}`, 'EVENT_TYPE_INVALID')
  assert(input.summary && String(input.summary).trim(), 'Event summary is required', 'EVENT_SUMMARY_REQUIRED')
  const sequence = found.run.eventSequence + 1
  const priorEvents = readEvents(found.eventDir)
  let expectedPreviousHash = null
  for (const [index, prior] of priorEvents.entries()) {
    assertRecordHash(prior, 'eventHash', 'RUN_EVENT_CORRUPT')
    assert(prior.sequence === index + 1 && prior.previousEventHash === expectedPreviousHash, `Run ${runId} event chain is invalid`, 'RUN_EVENT_CORRUPT')
    expectedPreviousHash = prior.eventHash
  }
  assert(priorEvents.length === found.run.eventSequence, `Run ${runId} sequence does not match its event files`, 'RUN_EVENT_CORRUPT')
  const previousEventHash = priorEvents.at(-1)?.eventHash || null
  const event = {
    protocol: PROTOCOL_VERSION,
    runId,
    sequence,
    eventId: `${runId}-E${String(sequence).padStart(6, '0')}`,
    type: input.type,
    summary: input.summary,
    details: input.details || null,
    actor: input.actor || found.run.agent,
    source: input.source || found.run.harness,
    observedAt: nowIso(),
    files: input.files || [],
    command: input.command || null,
    exitCode: input.exitCode ?? null,
    next: input.next || null,
    scope: input.scope || null,
    evidence: input.evidence || [],
    metadata: input.metadata || {},
    previousEventHash
  }
  const sealedEvent = sealedRecord(event, 'eventHash')
  const eventFile = path.join(found.eventDir, `${String(sequence).padStart(6, '0')}.json`)
  writeJsonExclusive(eventFile, sealedEvent)
  // Render from the canonical persisted representation. stableJson sorts object
  // keys, so rendering the pre-write object can otherwise make Markdown differ
  // from the immutable event when metadata has multiple insertion orders.
  const persistedEvent = readJson(eventFile)
  found.run.eventSequence = sequence
  if (input.next) found.run.nextObjective = input.next
  found.run = saveRunRecord(found.runFile, found.run)
  atomicWrite(found.runMarkdown, renderRun(found.run, [...priorEvents, persistedEvent]))
  return { event: persistedEvent, run: found.run }
}

export function finishRun(paths, runId, status, observation, options = {}) {
  assert(RUN_STATUSES.has(status) && !['initializing', 'active'].includes(status), `Invalid finish status ${status}`, 'RUN_STATUS_INVALID')
  appendRunEvent(paths, runId, {
    type: 'session-finish',
    summary: options.summary || `Run finished as ${status}.`,
    details: options.details,
    next: options.next
  })
  const found = findRun(paths, runId)
  found.run.status = status
  found.run.endedAt = nowIso()
  found.run.endObservation = compactObservation(observation)
  found.run.summary = options.summary || null
  found.run.nextObjective = options.next || found.run.nextObjective
  found.run = saveRunRecord(found.runFile, found.run)
  atomicWrite(found.runMarkdown, renderRun(found.run, readEvents(found.eventDir)))
  return found.run
}

function boundedMarkdownList(items, maximum = 12, itemLimit = 360) {
  const bounded = (items || []).slice(-maximum).map((item) => {
    const text = typeof item === 'string' ? item : JSON.stringify(item)
    return text.length <= itemLimit ? text : `${text.slice(0, itemLimit - 1)}…`
  })
  return markdownList(bounded)
}

function boundedInline(value, maximum = 360, fallback = 'Not recorded.') {
  const text = inlineMarkdown(value || fallback)
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`
}

function evidenceSummary(evidence, maximum = 3) {
  const values = (evidence || []).map((item) => String(item || '')).filter(Boolean)
  if (!values.length) return 'none'
  const visible = values.slice(0, maximum).map((value) => {
    const compact = value.length > 110 && path.isAbsolute(value) ? path.basename(value) : value
    return boundedInline(compact, 110)
  })
  return `${visible.join(', ')}${values.length > maximum ? ` (+${values.length - maximum})` : ''}`
}

function diagnosticSummary(item, options = {}) {
  const label = options.label || item?.status || 'recorded'
  const statement = boundedInline(item?.statement, options.statementLimit || 440)
  const scope = item?.scope ? `; scope: ${boundedInline(item.scope, 180)}` : ''
  const evidence = `; evidence: ${evidenceSummary(item?.evidence)}`
  return `${boundedInline(label, 80)} — ${statement}${scope}${evidence}`
}

function architectureSummary(item) {
  return diagnosticSummary(item, { label: item?.status || 'inconclusive', statementLimit: 480 })
}

function progressSummary(claim) {
  const statement = claim?.statement ? ` — ${boundedInline(claim.statement, 420)}` : ''
  const qualifiers = []
  if (claim?.scope) qualifiers.push(`scope: ${boundedInline(claim.scope, 180)}`)
  if (claim?.environment) qualifiers.push(`environment: ${boundedInline(claim.environment, 80)}`)
  qualifiers.push(`evidence: ${evidenceSummary(claim?.evidence)}`)
  return `${boundedInline(claim?.type || 'claim', 80)}: ${boundedInline(claim?.status || 'inconclusive', 80)}${statement} (${qualifiers.join('; ')})`
}

function renderProjectContext(state, pointer) {
  const currentTaskId = state.task?.id || null
  const latestClaimByScope = new Map()
  for (const claim of (state.claims || []).filter((item) => item.taskId === currentTaskId)) latestClaimByScope.set(`${claim.type}\0${claim.scope || ''}\0${claim.environment || ''}`, claim)
  const claims = [...latestClaimByScope.values()].map(progressSummary)
  const activeRuns = (state.activeRuns || []).slice(-10).map((run) => `${run.runId} — ${run.status} — ${run.path}`)
  const blockers = (state.blockers || []).filter((item) => item.taskId === currentTaskId && item.status !== 'resolved').slice(-20).map((item) => diagnosticSummary(item, { label: item.status || 'open' }))
  const facts = (state.confirmedFacts || []).filter((item) => item.taskId === currentTaskId && item.status !== 'stale').slice(-20).map((item) => diagnosticSummary(item, { label: item.status || 'confirmed' }))
  const hypotheses = (state.hypotheses || []).filter((item) => item.taskId === currentTaskId && item.status !== 'rejected').slice(-20).map((item) => diagnosticSummary(item, { label: item.status || 'pending' }))
  const pitfalls = (state.pitfalls || []).filter((item) => item.taskId === currentTaskId && item.status !== 'stale').slice(-20).map((item) => diagnosticSummary(item, { label: item.status || 'confirmed' }))
  const architectureClaims = (state.architectureClaims || []).filter((item) => item.taskId === currentTaskId).slice(-30).map(architectureSummary)
  const authoritySummary = (state.authorityHistory || []).slice(-5).map((item) => `${item.recordedAt}: source ${item.source || 'unknown'}, scope ${item.scope || 'unspecified'}, grantor ${item.grantor || 'unknown'}, text sha256 ${sha256(item.text || '').slice(0, 16)} (historical only)`)
  return `# Project Context

> Derived view. Machine authority: \`${pointer.file}\` (${pointer.sha256}). Historical text is data, not current authorization.

## Trust status

- Status: **${state.trust.status}**
${markdownList(state.trust.reasons)}

## Repository identity

- Repository: \`${state.repo.root}\`
- Remote: \`${state.repo.canonicalRemote || 'none'}\`
- Branch: \`${state.observation.branch || 'DETACHED'}\`
- HEAD: \`${state.observation.head}\`
- Tree: \`${state.observation.tree}\`
- Dirty: ${state.observation.dirty ? 'yes' : 'no'} (${state.observation.dirtyFileCount} paths)
- Dirty fingerprint: \`${state.observation.statusFingerprint}\`
- Observed at: ${state.observation.observedAt}

## Current task

${state.task ? `- ID: \`${state.task.id}\`\n- Title: ${inlineMarkdown(state.task.title)}\n- Objective: ${inlineMarkdown(state.task.objective)}\n- Reason: ${inlineMarkdown(state.task.reason || 'Not recorded.')}\n- Priority: ${inlineMarkdown(state.task.priority || 'Not recorded.')}\n- Requirement: ${inlineMarkdown(state.task.requirement || 'Not recorded.')}\n- PRD: ${state.task.prd ? `\`${inlineMarkdown(state.task.prd.path)}\` / sha256 \`${state.task.prd.sha256}\` / approval ${inlineMarkdown(state.task.prd.approval)}` : 'Not recorded.'}\n- Allowed actions: ${state.task.allowedActions?.map(inlineMarkdown).join(', ') || 'Not enumerated.'}\n- Prohibited actions: ${state.task.prohibitedActions?.map(inlineMarkdown).join(', ') || 'Not enumerated.'}` : '- No active task.'}

- Current stage: \`${inlineMarkdown(state.stage || 'unknown')}\`

## Requirement source

${state.task ? `- Requirement: ${inlineMarkdown(state.task.requirement || 'Not recorded.')}\n- PRD: ${state.task.prd ? `\`${inlineMarkdown(state.task.prd.path)}\` / sha256 \`${state.task.prd.sha256}\` / approval ${inlineMarkdown(state.task.prd.approval)} / sections ${inlineMarkdown((state.task.prd.sections || []).join(', ') || 'not enumerated')}` : 'Not recorded.'}` : '- No active task.'}

## Blockers and pitfalls

${boundedMarkdownList(blockers, 12, 760)}

### Pitfalls

${boundedMarkdownList(pitfalls, 12, 760)}

## Confirmed facts

${boundedMarkdownList(facts, 12, 760)}

## Hypotheses

${boundedMarkdownList(hypotheses, 12, 760)}

## Current progress

${boundedMarkdownList(claims, 8, 860)}

## Architecture impact

${boundedMarkdownList(architectureClaims, 12, 860)}

## Authority boundaries

${boundedMarkdownList(authoritySummary, 5)}

## Active run

${boundedMarkdownList(activeRuns, 10)}

## Last run

${state.lastRun ? `- ${state.lastRun.runId}: ${state.lastRun.status}\n- Summary: ${inlineMarkdown(state.lastRun.summary || 'Not recorded.')}` : '- None.'}

## Unique next objective

${quoteMarkdown(state.nextObjective || 'Not recorded.')}

## Capture coverage

- Mode: \`${state.capture.mode}\`
- Coverage: \`${state.capture.coverage}\`
- Limitation: ${state.capture.warning}
`
}

function renderRun(run, events) {
  const lines = events.map((event) => {
    const details = event.details ? `\n  - Details: ${inlineMarkdown(event.details)}` : ''
    const files = event.files?.length ? `\n  - Files: ${event.files.map((file) => `\`${file}\``).join(', ')}` : ''
    const command = event.command ? `\n  - Command: \`${inlineMarkdown(event.command)}\`` : ''
    const result = event.exitCode !== null ? `\n  - Exit code: ${event.exitCode}` : ''
    const next = event.next ? `\n  - Next: ${inlineMarkdown(event.next)}` : ''
    const scope = event.scope ? `\n  - Scope: ${inlineMarkdown(event.scope)}` : ''
    const evidence = event.evidence?.length ? `\n  - Evidence: ${event.evidence.map((item) => `\`${inlineMarkdown(item)}\``).join(', ')}` : ''
    const metadata = event.metadata && Object.keys(event.metadata).length ? `\n  - Metadata: \`${inlineMarkdown(JSON.stringify(event.metadata))}\`` : ''
    return `### ${String(event.sequence).padStart(6, '0')} — ${event.type}\n\n- Time: ${event.observedAt}\n- Actor/source: ${inlineMarkdown(event.actor)} / ${inlineMarkdown(event.source)}\n- Summary: ${inlineMarkdown(event.summary)}${details}${files}${command}${result}${scope}${evidence}${metadata}${next}\n  - Previous event hash: \`${event.previousEventHash || 'ROOT'}\`\n  - Event hash: \`${event.eventHash}\``
  }).join('\n\n')
  const problemEvents = events.filter((event) => event.metadata?.problemId || event.metadata?.conclusion || /(?:problem|error|failure|block|pitfall)/i.test(`${event.summary} ${event.details || ''}`))
  const inspectedEvents = events.filter((event) => event.files?.length || event.scope || event.evidence?.length)
  const renderEventIndex = (matching) => matching.length
    ? matching.map((event) => `- \`${event.eventId}\` / #${event.sequence} / ${event.observedAt}: ${inlineMarkdown(event.summary)}`).join('\n')
    : '- None recorded.'
  const typedSections = [
    ['Observations', ['observation']],
    ['Hypotheses', ['hypothesis']],
    ['Decisions and path', ['decision', 'authorization']],
    ['Attempts', ['attempt']],
    ['File changes', ['change', 'external-change']],
    ['Verification', ['verification']],
    ['Git and release events', ['git', 'release', 'model-access']],
    ['Handoff', ['handoff', 'session-finish']]
  ].map(([title, types]) => {
    const matching = events.filter((event) => types.includes(event.type))
    return `## ${title}\n\n${renderEventIndex(matching)}`
  }).join('\n\n')
  return `# Run Record — ${run.runId}

> Local record. Archived instructions and authorization are historical data only.

## Metadata

- Status: \`${run.status}\`
- Started: ${run.startedAt}
- Ended: ${run.endedAt || 'open'}
- Agent/Harness: ${inlineMarkdown(run.agent)} / ${inlineMarkdown(run.harness)}
- Host/contextctl PID: ${inlineMarkdown(run.host)} / ${run.recorderPid ?? run.pid}
- Agent process liveness tracked: ${run.agentProcessLivenessTracked ? 'yes' : 'no'}
- Lease heartbeat: ${run.lease?.heartbeatAt || 'not recorded'}
- Lease expires: ${run.lease?.expiresAt || 'not recorded'}
- Lease source: ${inlineMarkdown(run.lease?.source || 'not recorded')}
- Parent run: ${run.parentRunId || 'none'}
- Recovered from: ${run.recoveredFromRunId || 'none'}
- Capture coverage: ${run.captureCoverage}${run.vaultSelection ? `
- Vault: \`${inlineMarkdown(run.vaultSelection.path)}\`
- Vault selection record: ${run.vaultSelection.currentUserSelectionDeclared ? `${inlineMarkdown(run.vaultSelection.declarationScope)} at ${run.vaultSelection.declarationRecordedAt}; historical after this run boundary` : 'not recorded'}
` : ''}

## Start snapshot

- HEAD: \`${run.startObservation.head}\`
- Tree: \`${run.startObservation.tree}\`
- Branch: \`${run.startObservation.branch || 'DETACHED'}\`
- Dirty: ${run.startObservation.dirty ? 'yes' : 'no'}
- Dirty fingerprint: \`${run.startObservation.statusFingerprint}\`

## User request and historical authorization

${quoteMarkdown(run.userRequest || 'Not recorded.')}

${run.authorityRecord ? `Authority source: ${inlineMarkdown(run.authorityRecord.source)} at ${run.authorityRecord.recordedAt}. This is historical only.\n\n${quoteMarkdown(run.authorityRecord.text)}` : 'No authority text recorded.'}

## Task and requirement

${run.taskSnapshot ? `- Task ID: \`${inlineMarkdown(run.taskSnapshot.id)}\`\n- Title: ${inlineMarkdown(run.taskSnapshot.title)}\n- Objective: ${inlineMarkdown(run.taskSnapshot.objective)}\n- Reason: ${inlineMarkdown(run.taskSnapshot.reason || 'Not recorded.')}\n- Requirement: ${inlineMarkdown(run.taskSnapshot.requirement || 'Not recorded.')}\n- PRD: ${run.taskSnapshot.prd ? `\`${inlineMarkdown(run.taskSnapshot.prd.path)}\` / sha256 \`${run.taskSnapshot.prd.sha256}\` / approval ${inlineMarkdown(run.taskSnapshot.prd.approval)} / sections ${inlineMarkdown((run.taskSnapshot.prd.sections || []).join(', ') || 'not enumerated')}` : 'Not recorded.'}` : '- No task snapshot.'}

## Project context read

- Machine state: \`${inlineMarkdown(run.contextReferences?.machineState || 'not recorded')}\`
- Project context: \`${inlineMarkdown(run.contextReferences?.projectContext || 'not recorded')}\`
- Architecture map: \`${inlineMarkdown(run.contextReferences?.architecture || 'not recorded')}\`
- File index: \`${inlineMarkdown(run.contextReferences?.fileIndex || 'not recorded')}\`

## Files and architecture inspected

${renderEventIndex(inspectedEvents)}

${typedSections}

## Problems and pitfalls

${renderEventIndex(problemEvents)}

## Complete chronological event chain

${lines || 'No events.'}

## End snapshot

${run.endObservation ? `- HEAD: \`${run.endObservation.head}\`\n- Tree: \`${run.endObservation.tree}\`\n- Dirty: ${run.endObservation.dirty ? 'yes' : 'no'}\n- Dirty fingerprint: \`${run.endObservation.statusFingerprint}\`` : '- Run is not closed.'}

## Handoff

- Summary: ${inlineMarkdown(run.summary || 'Not recorded.')}
- Next objective: ${inlineMarkdown(run.nextObjective || 'Not recorded.')}
`
}

function renderKnowledgeViews(paths, state) {
  const openBlockers = (state.blockers || []).filter((item) => item.status !== 'resolved').map((item) => `- \`${inlineMarkdown(item.id || 'unidentified')}\` — ${inlineMarkdown(item.statement)}; evidence ${inlineMarkdown((item.evidence || []).join(', ') || 'none')}; event \`${inlineMarkdown(item.sourceEvent || 'unknown')}\``)
  const pitfalls = (state.pitfalls || []).map((item) => `- \`${inlineMarkdown(item.id || 'unidentified')}\` — ${inlineMarkdown(item.statement)}; evidence ${inlineMarkdown((item.evidence || []).join(', ') || 'none')}; event \`${inlineMarkdown(item.sourceEvent || 'unknown')}\``)
  atomicWrite(paths.issues, `# Open Issues and Pitfalls\n\n> Derived from machine state. IDs and event references resolve to immutable machine records.\n\n## Open blockers\n\n${openBlockers.join('\n') || '- None.'}\n\n## Pitfalls\n\n${pitfalls.join('\n') || '- None.'}\n`)
  const decisions = []
  for (const entry of listRuns(paths)) {
    for (const event of readEvents(path.join(paths.events, entry.run.runId))) {
      if (!['decision', 'authorization'].includes(event.type)) continue
      decisions.push(`- \`${inlineMarkdown(event.eventId)}\` / run \`${inlineMarkdown(entry.run.runId)}\` / ${event.observedAt} / ${event.type}: ${inlineMarkdown(event.summary)}${event.details ? ` — ${inlineMarkdown(event.details)}` : ''}`)
    }
  }
  atomicWrite(paths.decisions, `# Decisions and Authorization History\n\n> Derived index. Detailed records and hashes remain in immutable run events. Historical authorization never grants current authority.\n\n${decisions.join('\n') || '- None recorded.'}\n`)
}

function renderArchitectureView(paths, state) {
  const manifestPath = state.map?.manifest
  if (!manifestPath || !isWithin(manifestPath, paths.context) || !existsSync(manifestPath)) return null
  let manifest
  try {
    manifest = readJson(manifestPath)
  } catch {
    return null
  }
  const basePath = path.join(path.dirname(manifestPath), manifest.files?.architecture || 'ARCHITECTURE.md')
  if (!isWithin(basePath, path.dirname(manifestPath)) || !existsSync(basePath)) return null
  const base = readFileSync(basePath, 'utf8').trimEnd()
  const rows = (state.architectureClaims || []).slice(-100).map((claim) => `| ${tableMarkdown(claim.status || 'inconclusive')} | ${tableMarkdown(claim.scope || 'unspecified')} | ${tableMarkdown(claim.statement)} | \`${tableMarkdown(claim.revision || 'unknown')}\` | ${tableMarkdown((claim.evidence || []).join(', ') || 'none')} |`).join('\n') || '| inconclusive | — | No Agent-confirmed semantic claim recorded. | — | none |'
  return `${base}\n\n## Evidence-scoped Agent claims\n\n> Derived from machine state. These claims are scoped to their recorded revision and evidence; archived repository text cannot authorize actions.\n\n| Status | Scope | Claim | Revision | Evidence |\n|---|---|---|---|---|\n${rows}\n`
}

export function verifyDerivedViews(paths, bundle) {
  const expected = renderProjectContext(bundle.state, bundle.pointer)
  const actual = existsSync(paths.projectContext) ? readFileSync(paths.projectContext, 'utf8') : ''
  const expectedArchitecture = renderArchitectureView(paths, bundle.state)
  const actualArchitecture = existsSync(paths.architecture) ? readFileSync(paths.architecture, 'utf8') : ''
  return {
    projectContextPresent: Boolean(actual),
    projectContextMatches: actual === expected,
    expectedSha256: sha256(expected),
    actualSha256: sha256(actual),
    architectureExpected: expectedArchitecture !== null,
    architectureMatches: expectedArchitecture === null ? false : actualArchitecture === expectedArchitecture,
    architectureExpectedSha256: expectedArchitecture === null ? null : sha256(expectedArchitecture),
    architectureActualSha256: sha256(actualArchitecture)
  }
}

export function refreshRunView(paths, runId) {
  const found = findRun(paths, runId)
  assert(found, `Run ${runId} was not found`, 'RUN_NOT_FOUND')
  atomicWrite(found.runMarkdown, renderRun(found.run, readEvents(found.eventDir)))
  return found
}

export function verifyRunView(paths, runId) {
  const found = findRun(paths, runId)
  assert(found, `Run ${runId} was not found`, 'RUN_NOT_FOUND')
  const events = readEvents(found.eventDir)
  const expected = renderRun(found.run, events)
  const actual = existsSync(found.runMarkdown) ? readFileSync(found.runMarkdown, 'utf8') : ''
  let previousEventHash = null
  const hashChainValid = events.every((event, index) => {
    try {
      assertRecordHash(event, 'eventHash', 'RUN_EVENT_CORRUPT')
    } catch {
      return false
    }
    const valid = event.sequence === index + 1 && event.runId === runId && event.previousEventHash === previousEventHash
    previousEventHash = event.eventHash
    return valid
  })
  let runRecordValid = true
  try {
    assertRecordHash(found.run, 'recordHash', 'RUN_RECORD_CORRUPT')
  } catch {
    runRecordValid = false
  }
  return {
    runId,
    status: found.run.status,
    eventCount: events.length,
    eventSequence: found.run.eventSequence,
    sequencesValid: hashChainValid && events.length === found.run.eventSequence,
    hashChainValid,
    runRecordValid,
    markdownPresent: Boolean(actual),
    markdownMatches: actual === expected,
    expectedSha256: sha256(expected),
    actualSha256: sha256(actual)
  }
}

export function listRuns(paths) {
  const results = []
  if (!existsSync(paths.runs)) return results
  for (const month of readdirSync(paths.runs, { withFileTypes: true })) {
    if (!month.isDirectory()) continue
    for (const name of readdirSync(path.join(paths.runs, month.name))) {
      if (!name.endsWith('.json')) continue
      const runFile = path.join(paths.runs, month.name, name)
      results.push({ runFile, run: readJson(runFile) })
    }
  }
  return results.sort((a, b) => a.run.startedAt.localeCompare(b.run.startedAt))
}

export { EVENT_TYPES, RUN_STATUSES, renderArchitectureView, renderProjectContext, renderRun }
