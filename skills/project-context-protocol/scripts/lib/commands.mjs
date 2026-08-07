import { copyFileSync, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverRepository, git, gitBlobFromIndex, gitIsolated, normalizeRemote } from './git.mjs'
import { generateProjectMap } from './map.mjs'
import {
  EVENT_TYPES,
  appendRunEvent,
  compactObservation,
  createRun,
  ensureVault,
  findRun,
  finishRun,
  initialState,
  inspectVaultAcl,
  listRuns,
  loadState,
  refreshRunView,
  renewRunLease,
  renderArchitectureView,
  renderProjectContext,
  saveRunRecord,
  runLeaseStatus,
  validateVaultLocation,
  vaultPaths,
  verifyDerivedViews,
  verifyRunView,
  withStateLock,
  writeState
} from './storage.mjs'
import {
  assert,
  atomicWrite,
  canonicalPath,
  ensureDir,
  hmacSha256,
  inlineMarkdown,
  isWithin,
  nowIso,
  parseInteger,
  randomId,
  readJson,
  secureHexEqual,
  sha256,
  sha256File,
  splitList,
  stableJson,
  unique,
  writeJsonAtomic
} from './util.mjs'

const CLAIM_TYPES = new Set(['analyzed', 'implemented', 'verified', 'reviewed', 'committed', 'pushed', 'deployed', 'accepted'])
const CLAIM_STATUSES = new Set(['supported', 'failed', 'inconclusive', 'stale'])
const FINISH_STATUSES = new Set(['completed', 'partial', 'blocked'])
const LIFECYCLE_EVENTS = new Set(['commit', 'push', 'deploy', 'rollback', 'acceptance', 'delete', 'export', 'import', 'model-access'])
const LIFECYCLE_OUTCOMES = new Set(['planned', 'started', 'succeeded', 'failed', 'partial', 'cancelled', 'blocked-unauthorized', 'unknown'])
const EVIDENCE_KINDS = new Set(['attachment', 'command-output', 'manifest', 'remote-ref', 'deployment-response', 'health-check', 'user-confirmation', 'api-response', 'log', 'test-report'])
const BUILTIN_RELEASE_OBSERVERS = Object.freeze({
  commit: 'live-git-commit-observer',
  push: 'live-git-remote-ref-observer'
})

function required(args, key, message = `--${key} is required`) {
  const value = args[key]
  assert(value !== undefined && value !== true && String(value).trim() !== '', message, 'ARGUMENT_REQUIRED')
  return String(value)
}

function validatedLeaseSeconds(args) {
  if (args['lease-seconds'] === undefined) return undefined
  const value = parseInteger(args['lease-seconds'])
  assert(Number.isInteger(value) && value >= 5 && value <= 86400, '--lease-seconds must be an integer between 5 and 86400', 'RUN_LEASE_TTL_INVALID')
  return value
}

function explicitVault(args) {
  const value = args.vault
  assert(
    value !== undefined && value !== true && String(value).trim() !== '',
    '--vault is required. Ask the user where this session may store or read the local Vault; never infer a drive or directory.',
    'VAULT_LOCATION_REQUIRED'
  )
  const selected = String(value).trim()
  assert(path.isAbsolute(selected), '--vault must be the absolute path explicitly selected by the current user', 'VAULT_LOCATION_ABSOLUTE_REQUIRED')
  return selected
}

function requireUserConfirmedVault(args, operation) {
  explicitVault(args)
  assert(
    args['vault-confirmed-by-user'] === true,
    `${operation} requires --vault-confirmed-by-user after the current user explicitly selects the Vault path for this session`,
    'VAULT_LOCATION_CONFIRMATION_REQUIRED'
  )
}

function vaultSelectionRecord(vault, operation) {
  return {
    path: path.resolve(vault),
    currentUserSelectionDeclared: true,
    declarationScope: 'current-session-explicit-path',
    operation,
    declarationRecordedAt: nowIso(),
    historicalOnly: true
  }
}

function inputs(args) {
  return {
    repo: path.resolve(args.repo && args.repo !== true ? String(args.repo) : process.cwd()),
    vault: path.resolve(explicitVault(args))
  }
}

function observe(args) {
  const selected = inputs(args)
  const observation = discoverRepository(selected.repo)
  const paths = vaultPaths(selected.vault, observation)
  return { ...selected, observation, paths }
}

function assertIdentity(bundle, observation) {
  assert(bundle.state.repo.repoId === observation.repoId, 'State repository identity does not match the live repository', 'STATE_REPOSITORY_CONFLICT')
  assert(bundle.state.repo.workspaceId === observation.workspaceId, 'State workspace identity does not match this worktree', 'STATE_WORKSPACE_CONFLICT')
  assert(bundle.state.repo.contextId === observation.contextId, 'State context identity does not match this branch or detached HEAD', 'STATE_CONTEXT_CONFLICT')
}

function taskRecord(args, prior = null) {
  const title = args.task && args.task !== true ? String(args.task) : prior?.title
  if (!title) return prior
  const sameTask = Boolean(prior && prior.title === title)
  const inherited = sameTask ? prior : null
  const explicitPrdPath = args['prd-path'] && args['prd-path'] !== true ? path.resolve(String(args['prd-path'])) : null
  const prdPath = explicitPrdPath || inherited?.prd?.path || null
  if (prdPath) assert(existsSync(prdPath) && statSync(prdPath).isFile(), `PRD file does not exist: ${prdPath}`, 'PRD_NOT_FOUND')
  let prd = null
  if (prdPath) {
    if (inherited?.prd && !explicitPrdPath) {
      prd = { ...inherited.prd, sections: [...(inherited.prd.sections || [])] }
    } else {
      const nextHash = sha256File(prdPath)
      const unchanged = inherited?.prd?.path === prdPath && inherited?.prd?.sha256 === nextHash
      prd = {
        path: prdPath,
        sha256: nextHash,
        approval: args['prd-approval'] && args['prd-approval'] !== true ? String(args['prd-approval']) : unchanged ? inherited.prd.approval : 'not-recorded',
        sections: args['prd-sections'] && args['prd-sections'] !== true ? splitList(args['prd-sections']) : unchanged ? inherited.prd.sections || [] : []
      }
    }
  }
  return {
    id: args['task-id'] && args['task-id'] !== true ? String(args['task-id']) : sameTask ? prior.id : randomId('TASK'),
    title,
    objective: args.objective && args.objective !== true ? String(args.objective) : inherited?.objective || title,
    reason: args.reason && args.reason !== true ? String(args.reason) : inherited?.reason || null,
    priority: args.priority && args.priority !== true ? String(args.priority) : inherited?.priority || null,
    requirement: args.requirement && args.requirement !== true ? String(args.requirement) : inherited?.requirement || null,
    prd,
    allowedActions: args.allowed && args.allowed !== true ? splitList(args.allowed) : inherited?.allowedActions || [],
    prohibitedActions: args.prohibited && args.prohibited !== true ? splitList(args.prohibited) : inherited?.prohibitedActions || [],
    status: 'active'
  }
}

function taskComparable(task) {
  if (!task) return null
  return {
    title: task.title,
    objective: task.objective,
    reason: task.reason,
    priority: task.priority,
    requirement: task.requirement,
    prd: task.prd,
    allowedActions: task.allowedActions || [],
    prohibitedActions: task.prohibitedActions || []
  }
}

function taskMaterialChanged(prior, next) {
  return Boolean(prior && next && prior.id === next.id && !bindingEqual(taskComparable(prior), taskComparable(next)))
}

function prdMaterialChanged(prior, next) {
  return Boolean(prior && next && prior.id === next.id && !bindingEqual(prior.prd || null, next.prd || null))
}

function archivedTask(task, status, reason) {
  return { ...task, status, endedAt: nowIso(), transitionReason: reason }
}

function safeStateSummary(bundle) {
  return safeProjection({
    generation: bundle.state.generation,
    trust: bundle.state.trust,
    stage: bundle.state.stage,
    repo: {
      repoId: bundle.state.repo.repoId,
      workspaceId: bundle.state.repo.workspaceId,
      contextId: bundle.state.repo.contextId,
      root: bundle.state.repo.root,
      branch: bundle.state.observation.branch,
      head: bundle.state.observation.head,
      dirty: bundle.state.observation.dirty,
      statusFingerprint: bundle.state.observation.statusFingerprint
    },
    task: boundedTask(bundle.state.task),
    vaultSelection: bundle.state.vaultSelection || null
  })
}

function mapReference(manifest, paths) {
  return {
    generatedAt: manifest.generatedAt,
    head: manifest.repo.head,
    tree: manifest.repo.tree,
    statusFingerprint: manifest.repo.statusFingerprint,
    inventoryFingerprint: manifest.inventoryFingerprint,
    trackedFiles: manifest.counts.tracked,
    untrackedFiles: manifest.counts.untracked,
    sourceFilesInspected: manifest.source.inspected,
    versionId: manifest.versionId,
    manifest: manifest.pointer?.manifest || path.join(paths.context, 'MAP_MANIFEST.json'),
    pointer: paths.mapPointer
  }
}

function routeToken(bundle, observation, runId = null) {
  return sha256([
    observation.repoId,
    observation.workspaceId,
    observation.contextId,
    observation.head,
    observation.statusFingerprint,
    bundle.state.task?.id || '',
    runId || '',
    bundle.pointer.sha256
  ].join('\0'))
}

function protocolKey(paths) {
  assert(existsSync(paths.protocolKey), 'Vault protocol signing key is missing', 'PROTOCOL_KEY_MISSING')
  const key = readFileSync(paths.protocolKey, 'utf8').trim()
  assert(/^[a-f0-9]{64}$/.test(key), 'Vault protocol signing key is invalid', 'PROTOCOL_KEY_INVALID')
  return key
}

function protocolKeyStatus(paths) {
  if (!existsSync(paths.protocolKey)) return { valid: false, reason: 'The initialized vault protocol signing key is missing.' }
  try {
    const key = readFileSync(paths.protocolKey, 'utf8').trim()
    if (!/^[a-f0-9]{64}$/.test(key)) return { valid: false, reason: 'The vault protocol signing key is invalid.' }
    return { valid: true, keyId: sha256(key).slice(0, 16) }
  } catch (error) {
    return { valid: false, reason: `The vault protocol signing key cannot be read (${error.code || 'ERROR'}).` }
  }
}

function externalApprovalStatus() {
  return {
    valid: false,
    reason: 'STANDALONE_HIGH_RISK_EXECUTION_DISABLED: version 1 records high-risk events but never executes them; no Agent-configurable approval provider is accepted.'
  }
}

function normalizedSignals(signals) {
  return unique(signals.map((item) => String(item).trim().toLowerCase()).filter(Boolean)).sort()
}

function encodeRouteCredential(payload, key) {
  const body = Buffer.from(stableJson(payload, 0).trim(), 'utf8').toString('base64url')
  return `${body}.${hmacSha256(key, body)}`
}

function decodeRouteCredential(token, key) {
  const [body, digest, extra] = String(token || '').split('.')
  assert(body && digest && !extra, 'Route credential format is invalid', 'ROUTE_CREDENTIAL_INVALID')
  assert(secureHexEqual(hmacSha256(key, body), digest), 'Route credential authentication failed', 'ROUTE_CREDENTIAL_INVALID')
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    const error = new Error('Route credential payload is invalid')
    error.code = 'ROUTE_CREDENTIAL_INVALID'
    throw error
  }
}

function selectMode(trust, state, signals, activeRunId) {
  const normalized = new Set(signals.map((item) => item.toLowerCase()))
  if (!['READY'].includes(trust.status)) return { mode: 'recover-context', reason: `Trust is ${trust.status}.` }
  if (!activeRunId) return { mode: 'confirm-intent', reason: 'This Agent session has no authenticated run; begin one before project work.' }
  if (['task-change', 'authorization-change', 'new-task', 'authority'].some((item) => normalized.has(item))) return { mode: 'confirm-intent', reason: 'The current task or authorization changed.' }
  if (['commit', 'push', 'deploy', 'rollback', 'acceptance', 'delete', 'export', 'import', 'model-access', 'secret-disclosure'].some((item) => normalized.has(item))) return { mode: 'release-with-provenance', reason: 'A high-risk, disclosure, or lifecycle event requires current authority and provenance.' }
  if (['error', 'failure', 'contradiction', 'test-failure', 'diagnose'].some((item) => normalized.has(item))) return { mode: 'diagnose-and-decide', reason: 'An error, contradiction, or failed check was reported.' }
  if (['impact', 'architecture', 'file-map', 'map'].some((item) => normalized.has(item))) return { mode: 'map-impact', reason: 'The requested decision requires a bounded architecture/file-index read.' }
  if (['complete', 'completion', 'verify', 'handoff'].some((item) => normalized.has(item))) return { mode: 'verify-and-handoff', reason: 'A completion or handoff claim needs scoped evidence.' }
  if (['session-end', 'compaction', 'stop'].some((item) => normalized.has(item))) return { mode: 'checkpoint-handoff', reason: 'The session boundary requires a durable checkpoint.' }
  return { mode: 'continue-current-task', reason: 'No higher-priority routing condition is active.' }
}

function credentialPayload(bundle, observation, mode, signals, authority, activeRunId, sessionNonceHash, authorityDeclaredCurrentSession = false, keyId = null, externalApproval = null) {
  const issuedAt = nowIso()
  return {
    protocol: 'project-context/route/v1',
    keyId,
    repoId: observation.repoId,
    workspaceId: observation.workspaceId,
    contextId: observation.contextId,
    branch: observation.branch,
    head: observation.head,
    tree: observation.tree,
    statusFingerprint: observation.statusFingerprint,
    taskId: bundle.state.task?.id || null,
    prdHash: bundle.state.task?.prd?.sha256 || null,
    stateGeneration: bundle.state.generation,
    stateHash: bundle.pointer.sha256,
    activeRunId: activeRunId || null,
    sessionNonceHash: sessionNonceHash || null,
    mode,
    signals: normalizedSignals(signals),
    authorityFingerprint: authority ? sha256(authority) : null,
    authorityDeclaredCurrentSession: Boolean(authorityDeclaredCurrentSession),
    externalApproval,
    issuedAt,
    expiresAt: new Date(new Date(issuedAt).getTime() + 30 * 60 * 1000).toISOString()
  }
}

function validateRunSession(paths, runId, args, { allowDisconnected = false } = {}) {
  protocolKey(paths)
  const session = required(args, 'session', '--session returned by begin is required for this run')
  const found = findRun(paths, runId)
  assert(found, `Run ${runId} was not found`, 'RUN_NOT_FOUND')
  assertRunIntegrity(paths, runId)
  assert(found.run.sessionNonceHash && sha256(session) === found.run.sessionNonceHash, 'Run session token is missing or invalid', 'RUN_SESSION_INVALID')
  const lease = runLeaseStatus(found.run)
  if (!allowDisconnected) assert(lease.status === 'active', lease.reason, `RUN_LEASE_${lease.status.toUpperCase().replace(/-/g, '_')}`)
  return found
}

function runIntegrityProblems(paths, runId) {
  try {
    const check = verifyRunView(paths, runId)
    const problems = []
    if (!check.runRecordValid) problems.push('run record hash is invalid')
    if (!check.hashChainValid) problems.push('event hash chain is invalid')
    if (!check.sequencesValid) problems.push('event sequence is invalid')
    return problems
  } catch (error) {
    return [`run integrity could not be verified: ${error.code || error.message}`]
  }
}

function assertRunIntegrity(paths, runId) {
  const problems = runIntegrityProblems(paths, runId)
  assert(problems.length === 0, `Run ${runId} is corrupt: ${problems.join('; ')}`, 'RUN_INTEGRITY_INVALID')
}

function assertActiveRunsIntegrity(paths, state) {
  for (const active of state.activeRuns || []) {
    assert(findRun(paths, active.runId), `Active run ${active.runId} is missing`, 'RUN_NOT_FOUND')
    assertRunIntegrity(paths, active.runId)
  }
}

function classifyTrust(bundle, observation, paths) {
  if (!bundle) return { status: 'UNMANAGED', reasons: ['No state generation exists for this worktree context.'] }
  const signingKey = protocolKeyStatus(paths)
  if (!signingKey.valid) return { status: 'BLOCKED', reasons: [signingKey.reason] }
  const reasons = []
  if (bundle.state.repo.repoId !== observation.repoId || bundle.state.repo.workspaceId !== observation.workspaceId || bundle.state.repo.contextId !== observation.contextId) {
    return { status: 'CONFLICT', reasons: ['Stored identity differs from the live repository/worktree/context.'] }
  }
  const leaseProblems = []
  const integrityProblems = []
  for (const active of bundle.state.activeRuns || []) {
    const found = findRun(paths, active.runId)
    if (!found) integrityProblems.push(`Active run ${active.runId} is missing and cannot prove lifecycle ownership.`)
    else {
      const runProblems = runIntegrityProblems(paths, active.runId)
      if (runProblems.length > 0) {
        integrityProblems.push(`Active run ${active.runId} is corrupt: ${runProblems.join('; ')}.`)
        continue
      }
      const lease = runLeaseStatus(found.run)
      if (lease.status !== 'active') leaseProblems.push(`Active run ${active.runId} is disconnected: ${lease.reason}`)
    }
  }
  if (integrityProblems.length > 0) return { status: 'BLOCKED', reasons: integrityProblems.slice(0, 6) }
  if (leaseProblems.length > 0) return { status: 'CONFLICT', reasons: leaseProblems.slice(0, 6) }
  if (!bundle.state.task) return { status: 'UNMANAGED', reasons: ['No current task is recorded.'] }
  if (bundle.state.task.prd) {
    const prd = bundle.state.task.prd
    if (!prd.path || !existsSync(prd.path) || !statSync(prd.path).isFile()) return { status: 'BLOCKED', reasons: ['The recorded PRD file is missing or is no longer a regular file.'] }
    const actualPrdHash = sha256File(prd.path)
    if (actualPrdHash !== prd.sha256) {
      const status = bundle.state.activeRuns.length > 0 ? 'CONFLICT' : 'STALE'
      return { status, reasons: [`The PRD hash changed from ${prd.sha256} to ${actualPrdHash}; explicit requirement reconciliation is required.`] }
    }
    if (!/^(?:approved|user-approved|accepted)$/i.test(String(prd.approval || ''))) return { status: 'BLOCKED', reasons: [`The recorded PRD approval state is ${prd.approval || 'missing'}.`] }
  }
  const mapProblems = mapIntegrityProblems(paths, bundle.state)
  if (mapProblems.length > 0) return { status: 'BLOCKED', reasons: mapProblems.slice(0, 6) }
  const changed = []
  if (bundle.state.observation.branch !== observation.branch) changed.push('branch')
  if (bundle.state.observation.head !== observation.head) changed.push('HEAD')
  if (bundle.state.observation.statusFingerprint !== observation.statusFingerprint) changed.push('working-tree fingerprint')
  if (changed.length > 0) {
    const status = bundle.state.activeRuns.length > 0 ? 'CONFLICT' : 'STALE'
    reasons.push(`Live ${changed.join(', ')} changed after the last checkpoint.`)
    if (status === 'CONFLICT') reasons.push('An open run exists, so attribution must be reconciled before business writes.')
    return { status, reasons }
  }
  const evidenceProblems = supportedClaimEvidenceProblems(paths, observation, bundle.state)
  if (evidenceProblems.length > 0) return { status: 'BLOCKED', reasons: evidenceProblems.slice(0, 6) }
  if (['BLOCKED', 'CONFLICT'].includes(bundle.state.trust?.status)) return bundle.state.trust
  const mapFreshness = mapFreshnessProblems(bundle.state, observation)
  if (mapFreshness.length > 0) {
    return {
      status: 'STALE',
      reasons: mapFreshness.slice(0, 6),
      repairable: 'map-only'
    }
  }
  return { status: 'READY', reasons: [] }
}

function liveObservationChanges(state, observation) {
  const changed = []
  if (state.observation.branch !== observation.branch) changed.push('branch')
  if (state.observation.head !== observation.head) changed.push('HEAD')
  if (state.observation.statusFingerprint !== observation.statusFingerprint) changed.push('working-tree fingerprint')
  return changed
}

function normalizedRepositoryPath(root, value) {
  const absolute = path.isAbsolute(String(value)) ? path.resolve(String(value)) : path.resolve(root, String(value))
  assert(isWithin(absolute, root), `Reported file escapes the repository: ${value}`, 'REPORTED_FILE_OUTSIDE_REPOSITORY')
  const relative = path.relative(root, absolute).replace(/\\/g, '/')
  assert(relative && relative !== '.', `Reported file is not a repository file: ${value}`, 'REPORTED_FILE_INVALID')
  return relative
}

function changedPathCoverage(state, observation, reportedFiles) {
  const expected = unique([...(state.observation.changedPaths || []), ...(observation.changedPaths || [])]).map((item) => item.replace(/\\/g, '/'))
  assert(expected.length > 0, 'The dirty fingerprint changed but exact changed paths are unavailable; use explicit reconciliation with a reason', 'LIVE_CHANGE_PATHS_UNAVAILABLE')
  const normalized = unique(reportedFiles.map((item) => normalizedRepositoryPath(observation.root, item)))
  const key = (item) => process.platform === 'win32' ? item.toLowerCase() : item
  const expectedKeys = new Set(expected.map(key))
  const reportedKeys = new Set(normalized.map(key))
  const missing = expected.filter((item) => !reportedKeys.has(key(item)))
  const invented = normalized.filter((item) => !expectedKeys.has(key(item)))
  assert(missing.length === 0 && invented.length === 0, `Reported --files do not match live/prior Git changed paths (missing: ${missing.join(', ') || 'none'}; unrelated: ${invented.join(', ') || 'none'})`, 'LIVE_CHANGE_FILE_SET_MISMATCH')
  return normalized
}

function splitGitNull(value) {
  return String(value || '').split('\0').filter(Boolean)
}

function knownVaultContentHashes(paths, bundle) {
  const hashes = new Set()
  const candidates = [
    paths.protocolKey,
    paths.registry,
    paths.repositoryMetadata,
    paths.currentPointer,
    paths.projectContext,
    paths.architecture,
    paths.fileIndex,
    paths.mapPointer,
    bundle?.generationFile,
    bundle?.state?.map?.manifest
  ].filter(Boolean)
  for (const file of candidates) {
    try {
      if (existsSync(file) && lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink()) hashes.add(sha256File(file))
    } catch {
      // Unreadable vault material is handled by trust/verify; preflight stays conservative.
    }
  }
  if (existsSync(paths.evidence)) {
    for (const runEntry of readdirSync(paths.evidence, { withFileTypes: true })) {
      if (!runEntry.isDirectory() || runEntry.isSymbolicLink()) continue
      const runRoot = path.join(paths.evidence, runEntry.name)
      for (const evidenceEntry of readdirSync(runRoot, { withFileTypes: true })) {
        if (!evidenceEntry.isDirectory() || evidenceEntry.isSymbolicLink()) continue
        const metadata = path.join(runRoot, evidenceEntry.name, 'evidence.json')
        try {
          if (!existsSync(metadata)) continue
          const record = readJson(metadata)
          if (record.sha256) hashes.add(record.sha256)
          hashes.add(sha256File(metadata))
        } catch {
          // A corrupt evidence record is blocked by trust/verify.
        }
      }
    }
  }
  return hashes
}

function gitSensitivePreflight(paths, observation, bundle) {
  const violations = []
  const staged = splitGitNull(git(observation.root, ['diff', '--cached', '--diff-filter=ACMRT', '--name-only', '-z'], { trim: false }))
  const suspiciousName = /(?:^|\/)(?:\.protocol-key|PROJECT_CONTEXT\.md|evidence\.json|EXPORT_MANIFEST\.json|generation-\d+[^/]*\.json|RUN-[^/]+\.(?:md|json))$/i
  const protocolMarkers = [
    'project-context/evidence/v1',
    'project-context/state',
    'project-context/export/v1',
    '# Recovery Card',
    'Local storage permission is separate from model disclosure permission.'
  ]
  const vaultHashes = knownVaultContentHashes(paths, bundle)
  for (const relativeRaw of staged) {
    const relative = relativeRaw.replace(/\\/g, '/')
    let blob
    try {
      blob = gitBlobFromIndex(observation.root, relativeRaw)
    } catch {
      violations.push({ path: relative, reason: 'staged blob could not be inspected' })
      continue
    }
    const blobHash = sha256(blob)
    const modeLine = git(observation.root, ['ls-files', '-s', '--', relativeRaw], { allowFailure: true })
    const mode = modeLine.split(/\s+/)[0]
    if (mode === '120000') {
      const linkTarget = blob.toString('utf8').trim()
      const resolved = path.resolve(path.dirname(path.join(observation.root, relativeRaw)), linkTarget)
      if (isWithin(resolved, paths.vault)) violations.push({ path: relative, reason: 'staged symlink resolves into the local context vault' })
    }
    if (suspiciousName.test(relative)) violations.push({ path: relative, reason: 'staged path resembles a local context archive artifact' })
    if (vaultHashes.has(blobHash)) violations.push({ path: relative, reason: 'staged blob exactly matches local vault or evidence content' })
    if (blob.length <= 16 * 1024 * 1024) {
      const text = blob.toString('utf8')
      if (protocolMarkers.some((marker) => text.includes(marker))) violations.push({ path: relative, reason: 'staged content contains a local context archive marker' })
      const signingKey = existsSync(paths.protocolKey) ? readFileSync(paths.protocolKey, 'utf8').trim() : ''
      if (signingKey && text.includes(signingKey)) violations.push({ path: relative, reason: 'staged content contains the vault signing key' })
    }
  }
  const tracked = splitGitNull(git(observation.root, ['ls-files', '-z'], { trim: false }))
  for (const relativeRaw of tracked) {
    const relative = relativeRaw.replace(/\\/g, '/')
    if (suspiciousName.test(relative) && !violations.some((item) => item.path === relative)) violations.push({ path: relative, reason: 'tracked path resembles a local context archive artifact' })
  }
  return unique(violations.map((item) => `${item.path}: ${item.reason}`))
}

function mapIntegrityProblems(paths, state) {
  if (!state.map?.manifest) return ['The current task has no versioned map manifest.']
  const problems = []
  try {
    const manifestPath = path.resolve(state.map.manifest)
    if (!isWithin(manifestPath, paths.context) || !existsSync(manifestPath) || !lstatSync(manifestPath).isFile() || lstatSync(manifestPath).isSymbolicLink()) return ['The versioned map manifest is missing or unsafe.']
    const manifest = readJson(manifestPath)
    const pointer = existsSync(paths.mapPointer) ? readJson(paths.mapPointer) : null
    if (!pointer || pointer.manifest !== manifestPath || pointer.versionId !== manifest.versionId || pointer.manifestSha256 !== sha256(stableJson(manifest))) problems.push('The map pointer does not authenticate the current manifest.')
    const stateBindings = [
      ['versionId', manifest.versionId],
      ['head', manifest.repo?.head],
      ['tree', manifest.repo?.tree],
      ['statusFingerprint', manifest.repo?.statusFingerprint],
      ['inventoryFingerprint', manifest.inventoryFingerprint]
    ]
    for (const [field, expected] of stateBindings) {
      if (state.map[field] !== expected) problems.push(`The state map ${field} differs from its manifest.`)
    }
    const base = path.dirname(manifestPath)
    for (const [key, relative] of Object.entries(manifest.files || {})) {
      const file = path.resolve(base, relative)
      if (!isWithin(file, base) || !existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) problems.push(`Map artifact ${key} is missing or unsafe.`)
      else if (manifest.artifactHashes?.[key] !== sha256File(file)) problems.push(`Map artifact ${key} hash mismatch.`)
    }
  } catch (error) {
    problems.push(`The versioned map cannot be validated: ${error.message}`)
  }
  return unique(problems)
}

function mapFreshnessProblems(state, observation) {
  if (!state.map) return ['The current task has no map snapshot.']
  const changed = []
  if (state.map.head !== observation.head) changed.push('HEAD')
  if (state.map.tree !== observation.tree) changed.push('tree')
  if (state.map.statusFingerprint !== observation.statusFingerprint) changed.push('working-tree fingerprint')
  return changed.length > 0
    ? [`The versioned repository map is stale for live ${changed.join(', ')}; refresh it with an authenticated map command.`]
    : []
}

function staleRevisionBoundClaims(claims, priorObservation, liveObservation, reason, sourceEvent = null, requirementChanged = false) {
  const revisionChanged = priorObservation?.head !== liveObservation.head || priorObservation?.tree !== liveObservation.tree || priorObservation?.statusFingerprint !== liveObservation.statusFingerprint
  // Every evidence-backed progress layer is revision-bound, including
  // `analyzed`.  A source analysis against an older dirty-content fingerprint
  // is historical evidence, not current project truth.  Re-check each claim's
  // own binding even when the state observation is already current so an
  // upgraded protocol can repair a legacy supported claim on the next
  // authenticated checkpoint.
  const affected = new Set(CLAIM_TYPES)
  if (!revisionChanged && !requirementChanged && !(claims || []).some((claim) => {
    if (claim.status !== 'supported' || !affected.has(claim.type)) return false
    return claim.revision !== liveObservation.head || claim.tree !== liveObservation.tree || claim.statusFingerprint !== liveObservation.statusFingerprint
  })) return claims || []
  return (claims || []).map((claim) => {
    if (claim.status !== 'supported' || !affected.has(claim.type)) return claim
    const stillSameRevision = claim.revision === liveObservation.head && claim.tree === liveObservation.tree && claim.statusFingerprint === liveObservation.statusFingerprint
    if (!requirementChanged && stillSameRevision) return claim
    return {
      ...claim,
      history: [...(claim.history || []), {
        status: claim.status,
        revision: claim.revision,
        tree: claim.tree,
        statusFingerprint: claim.statusFingerprint,
        evidence: claim.evidence || [],
        observedAt: claim.observedAt
      }],
      status: 'stale',
      staleReason: reason,
      staleAt: nowIso(),
      staleSourceEvent: sourceEvent
    }
  })
}

function staleArchitectureClaims(claims, priorObservation, liveObservation, reason, sourceEvent = null, requirementChanged = false) {
  const revisionChanged = priorObservation?.head !== liveObservation.head || priorObservation?.statusFingerprint !== liveObservation.statusFingerprint
  if (!revisionChanged && !requirementChanged) return claims || []
  return (claims || []).map((claim) => {
    if (claim.status !== 'supported') return claim
    const stillSameRevision = claim.revision === liveObservation.head && claim.fingerprint === liveObservation.statusFingerprint
    if (!requirementChanged && stillSameRevision) return claim
    return {
      ...claim,
      history: [...(claim.history || []), {
        status: claim.status,
        revision: claim.revision,
        fingerprint: claim.fingerprint,
        evidence: claim.evidence || [],
        observedAt: claim.observedAt
      }],
      status: 'stale',
      staleReason: reason,
      staleAt: nowIso(),
      staleSourceEvent: sourceEvent
    }
  })
}

function staleDiagnosticRecords(records, taskId, priorObservation, liveObservation, reason, sourceEvent = null, requirementChanged = false, hypothesisMode = false) {
  const revisionChanged = priorObservation?.head !== liveObservation.head || priorObservation?.statusFingerprint !== liveObservation.statusFingerprint
  if (!revisionChanged && !requirementChanged) return records || []
  return (records || []).map((record) => {
    if (record.taskId !== taskId || (record.status === 'stale') || (hypothesisMode && record.status !== 'confirmed')) return record
    const stillSameRevision = record.revision === liveObservation.head && record.fingerprint === liveObservation.statusFingerprint
    if (!requirementChanged && stillSameRevision) return record
    return {
      ...record,
      history: [...(record.history || []), {
        status: record.status || 'confirmed',
        revision: record.revision || null,
        fingerprint: record.fingerprint || null,
        evidence: record.evidence || [],
        observedAt: record.observedAt || record.updatedAt || null
      }],
      status: hypothesisMode ? 'unresolved' : 'stale',
      staleReason: reason,
      staleAt: nowIso(),
      staleSourceEvent: sourceEvent
    }
  })
}

function assertApprovedPrd(task) {
  if (!task?.prd) return
  assert(/^(?:approved|user-approved|accepted)$/i.test(String(task.prd.approval || '')), 'A recorded PRD must be explicitly approved before task adoption', 'PRD_NOT_APPROVED')
}

function bindingEqual(left, right) {
  return stableJson(left, 0) === stableJson(right, 0)
}

function credentialMismatches(expected, supplied) {
  return Object.keys(expected).filter((key) => !['issuedAt', 'expiresAt'].includes(key) && !bindingEqual(expected[key], supplied[key]))
}

function clip(value, limit = 240) {
  const text = String(value ?? '')
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

function boundedTask(task) {
  if (!task) return null
  return {
    ...task,
    title: safeSummary(task.title, 180),
    objective: safeSummary(task.objective, 320),
    reason: safeSummary(task.reason, 240),
    requirement: safeSummary(task.requirement, 320),
    allowedActions: (task.allowedActions || []).slice(0, 10).map((item) => safeSummary(item, 100)),
    prohibitedActions: (task.prohibitedActions || []).slice(0, 10).map((item) => safeSummary(item, 100))
  }
}

function redactSecrets(value, { highEntropy = true } = {}) {
  if (value === null || value === undefined) return value
  const protocolIds = []
  const protectProtocolIdentifier = (match) => {
    const marker = `PCPID${protocolIds.length}END`
    protocolIds.push(match)
    return marker
  }
  let redacted = String(value)
    .replace(/\bgeneration-\d{8}(?:-[a-f0-9]{12})?\.json\b/gi, protectProtocolIdentifier)
    .replace(/\b(?:RUN|EVID|CLAIM|ARCH|ISSUE|TASK|PIT|MAP|EXPORT|IMPORT|DECISION|ATTEMPT|CORR|CHANGE)-[A-Za-z0-9_-]+\b/g, protectProtocolIdentifier)
  redacted = redacted
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi, '[REDACTED_PRIVATE_KEY]')
    .replace(/\b(?:github_pat_|gh[pousr]_|AKIA|ASIA)[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_CREDENTIAL]')
    .replace(/\b(?:sk|ak|pk|rk)-[A-Za-z0-9_-]{8,}\b/gi, '[REDACTED_CREDENTIAL]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, 'Bearer [REDACTED_TOKEN]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|cookie)\s*[:=]\s*)["']?[^\s,;"']+/gi, '$1[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[REDACTED_PHONE]')
    .replace(/(?<!\d)\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9Xx](?!\d)/g, '[REDACTED_ID]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
  if (highEntropy) redacted = redacted.replace(/\b(?=[A-Za-z0-9_+/=-]{32,}\b)(?=[A-Za-z0-9_+/=-]*[A-Za-z])(?=[A-Za-z0-9_+/=-]*\d)[A-Za-z0-9_+/=-]+\b/g, '[REDACTED_HIGH_ENTROPY_TOKEN]')
  redacted = redacted.replace(/PCPID(\d+)END/g, (_, index) => protocolIds[Number(index)] || '[INVALID_PROTOCOL_ID]')
  return redacted
}

function safeSummary(value, length) {
  return clip(redactSecrets(value), length)
}

function safeProjection(value, depth = 0, field = '') {
  if (depth > 12) return '[TRUNCATED_NESTING]'
  const structuredField = /(?:^|_)(?:id|hash|sha256|head|tree|revision|fingerprint|generation|branch|path|file|root|protocol|status|mode|time|at|count|size|dirty|evidence|reference|binding|remote)$/i.test(field)
    || /(?:Id|Hash|Sha256|Fingerprint|Path|File|Root|At|Count|Revision|Event|Evidence|Reference|Binding)$/i.test(field)
    || /^(?:architecture|projectContext|fileIndex|manifest|pointer|runMarkdown|machineState|vault|context)$/i.test(field)
  if (typeof value === 'string') return redactSecrets(value, { highEntropy: !structuredField })
  if (Array.isArray(value)) return value.map((item) => safeProjection(item, depth + 1, field))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeProjection(item, depth + 1, key)]))
  return value
}

function boundedRecords(records, count = 8) {
  return (records || []).slice(-count).map((item) => typeof item === 'string' ? safeSummary(item, 220) : {
    ...item,
    statement: safeSummary(item.statement, 220),
    scope: safeSummary(item.scope, 160),
    limits: safeSummary(item.limits, 160),
    evidence: (item.evidence || []).slice(0, 6).map((entry) => safeSummary(entry, 160))
  })
}

function recoveryCard(bundle, observation, paths, currentSelection) {
  const trust = classifyTrust(bundle, observation, paths)
  const vaultSelection = {
    path: paths.vault,
    currentSessionDeclarationRecorded: currentSelection?.currentUserSelectionDeclared === true,
    declarationScope: currentSelection?.declarationScope || null,
    declarationRecordedAt: currentSelection?.declarationRecordedAt || null
  }
  if (!bundle) {
    return {
      trust,
      repository: { root: observation.root, branch: observation.branch, head: observation.head, dirty: observation.dirty },
      vaultSelection,
      lastRecordedVaultSelection: null,
      task: null,
      requirement: null,
      progress: [],
      blockers: [],
      next: { objective: 'Register the repository and record the current task.', allowed: [], prohibited: ['Business-file writes before run adoption.'] },
      references: { vault: paths.vault, context: paths.context }
    }
  }
  const activeRuns = bundle.state.activeRuns.slice(-3).map((entry) => {
    const found = findRun(paths, entry.runId)
    const integrityProblems = found ? runIntegrityProblems(paths, entry.runId) : ['run record is missing']
    return {
      runId: entry.runId,
      recordedStatus: entry.status,
      actualStatus: integrityProblems.length > 0 ? 'corrupt-or-missing' : found.run.status,
      startedAt: integrityProblems.length > 0 ? null : found.run.startedAt,
      runMarkdown: found?.runMarkdown || entry.path,
      integrity: { valid: integrityProblems.length === 0, problems: integrityProblems },
      lease: integrityProblems.length === 0 ? runLeaseStatus(found.run) : { status: 'invalid', reason: 'Run integrity is not trustworthy.' }
    }
  })
  return safeProjection({
    trust,
    vaultSelection,
    lastRecordedVaultSelection: bundle.state.vaultSelection || null,
    repository: {
      repoId: observation.repoId,
      workspaceId: observation.workspaceId,
      contextId: observation.contextId,
      root: observation.root,
      branch: observation.branch,
      head: observation.head,
      tree: observation.tree,
      dirty: observation.dirty,
      dirtyFileCount: observation.statusLines.length,
      statusFingerprint: observation.statusFingerprint
    },
    task: boundedTask(bundle.state.task),
    requirement: boundedTask(bundle.state.task)?.requirement || null,
    progress: boundedRecords(bundle.state.claims.filter((claim) => claim.taskId === bundle.state.task?.id), 6),
    blockers: boundedRecords(bundle.state.blockers.filter((item) => item.taskId === bundle.state.task?.id && item.status !== 'resolved'), 6),
    confirmedFacts: boundedRecords(bundle.state.confirmedFacts.filter((item) => item.taskId === bundle.state.task?.id && item.status !== 'stale'), 8),
    hypotheses: boundedRecords(bundle.state.hypotheses.filter((item) => item.taskId === bundle.state.task?.id && !['rejected'].includes(item.status)), 8),
    activeRuns,
    abandonedRuns: (bundle.state.abandonedRuns || []).slice(-3),
    lastRun: bundle.state.lastRun ? {
      runId: bundle.state.lastRun.runId || null,
      status: bundle.state.lastRun.status || null,
      endedAt: bundle.state.lastRun.endedAt || null,
      summary: safeSummary(bundle.state.lastRun.summary, 240),
      nextObjective: safeSummary(bundle.state.lastRun.nextObjective, 240),
      path: bundle.state.lastRun.path || null
    } : null,
    next: {
      objective: safeSummary(bundle.state.nextObjective, 320),
      allowed: (bundle.state.task?.allowedActions || []).slice(0, 10).map((item) => safeSummary(item, 100)),
      prohibited: (bundle.state.task?.prohibitedActions || []).slice(0, 10).map((item) => safeSummary(item, 100))
    },
    map: bundle.state.map,
    capture: bundle.state.capture,
    references: {
      machineState: bundle.generationFile,
      projectContext: paths.projectContext,
      architecture: paths.architecture,
      fileIndex: paths.fileIndex,
      vault: paths.vault
    },
    stateBindingHash: routeToken(bundle, observation, activeRuns[0]?.runId || null)
  })
}

function textCard(card) {
  const task = card.task
  const claims = card.progress?.length
    ? card.progress.map((claim) => `- ${inlineMarkdown(claim.type)}: ${inlineMarkdown(claim.status)} — ${inlineMarkdown(claim.statement || claim.scope || 'unspecified')}`).join('\n')
    : '- No scoped completion claims.'
  const blockers = card.blockers?.length
    ? card.blockers.map((item) => `- ${inlineMarkdown(item.statement || item)}`).join('\n')
    : '- None recorded.'
  const active = card.activeRuns?.length
    ? card.activeRuns.map((run) => `- ${run.runId}: ${run.actualStatus} (${run.runMarkdown})`).join('\n')
    : '- None.'
  const full = `# Recovery Card

Trust: ${card.trust.status}${card.trust.reasons.length ? ` — ${card.trust.reasons.join(' ')}` : ''}
Vault: ${card.vaultSelection?.path || card.references?.vault || 'not recorded'} (${card.vaultSelection?.currentSessionDeclarationRecorded ? `current-session user-selection declaration recorded at ${card.vaultSelection.declarationRecordedAt || 'unknown time'}` : 'current-session declaration not recorded'})

1. Repository / branch / HEAD
   - ${card.repository.root}
   - ${card.repository.branch || 'DETACHED'} @ ${card.repository.head}
   - Dirty: ${card.repository.dirty ? 'yes' : 'no'} (${card.repository.dirtyFileCount || 0} paths)

2. Current unique task
    - ${task ? `${inlineMarkdown(task.id)}: ${inlineMarkdown(task.title)}` : 'Not recorded.'}

  3. Why / confirmed requirement
   - ${inlineMarkdown(task?.reason || 'Not recorded.')}
   - Requirement: ${inlineMarkdown(card.requirement || 'Not recorded.')}
   - PRD path: ${inlineMarkdown(task?.prd?.path || 'Not recorded.')}
   - PRD SHA-256: ${task?.prd?.sha256 || 'Not recorded.'}
   - PRD approval: ${inlineMarkdown(task?.prd?.approval || 'Not recorded.')}
   - PRD sections: ${inlineMarkdown(task?.prd?.sections?.join(', ') || 'Not recorded.')}

4. Proven progress
${claims}

5. Next boundary
   - Objective: ${inlineMarkdown(card.next?.objective || 'Not recorded.')}
   - Allowed: ${inlineMarkdown(card.next?.allowed?.join(', ') || 'not enumerated')}
   - Prohibited: ${inlineMarkdown(card.next?.prohibited?.join(', ') || 'not enumerated')}

Blockers
${blockers}

Open runs
${active}

References
- Vault: ${card.references.vault || card.vaultSelection?.path || 'not recorded'}
- Machine state: ${card.references.machineState || 'not created'}
- Project context: ${card.references.projectContext || 'not created'}
- Architecture: ${card.references.architecture || 'not created'}
- File index: ${card.references.fileIndex || 'not created'}
- State binding hash: ${card.stateBindingHash || 'not available'}
`
  const cjk = (full.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length
  const nonCjk = full.length - cjk
  const estimatedTokens = cjk + Math.ceil(nonCjk / 3)
  if (estimatedTokens <= 1150) return full
  return `# Recovery Card (bounded)
Trust: ${card.trust.status} — ${safeSummary(card.trust.reasons.join(' '), 180)}
Vault: ${card.vaultSelection?.path || card.references?.vault || 'not recorded'} | current-session declaration ${card.vaultSelection?.currentSessionDeclarationRecorded ? 'recorded' : 'not recorded'}
1. Repo: ${card.repository.root} | ${card.repository.branch || 'DETACHED'} @ ${card.repository.head} | dirty ${card.repository.dirty ? 'yes' : 'no'}
2. Task: ${task ? `${task.id}: ${safeSummary(task.title, 120)}` : 'not recorded'}
3. Requirement: ${safeSummary(card.requirement || task?.reason || 'Not recorded.', 180)} | PRD ${task?.prd?.sha256 || 'not recorded'} (${task?.prd?.approval || 'not recorded'})
4. Progress: ${(card.progress || []).slice(-3).map((claim) => `${claim.type}:${claim.status}[${safeSummary(claim.scope || claim.statement || '', 90)}]`).join('; ') || 'none'}
5. Next: ${safeSummary(card.next?.objective || 'Not recorded.', 160)} | prohibited ${safeSummary(card.next?.prohibited?.join(', ') || 'not enumerated', 140)}
Blockers: ${(card.blockers || []).slice(-3).map((item) => safeSummary(item.statement || item, 100)).join('; ') || 'none'}
Refs: state ${card.references.machineState || 'none'} | context ${card.references.projectContext || 'none'} | binding ${card.stateBindingHash || 'none'}
`
}

function appendStateRecord(list, record, equalityKey = 'statement') {
  if (!record[equalityKey]) return list
  if (list.some((item) => typeof item === 'object' && item[equalityKey] === record[equalityKey] && item.status === record.status)) return list
  return [...list, record]
}

function resolveEvidenceReference(paths, observation, runId, reference) {
  const text = String(reference || '').trim()
  if (!text) return null
  const candidates = [text, path.resolve(observation.root, text)]
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue
      const stat = lstatSync(candidate)
      if (stat.isFile() && !stat.isSymbolicLink() && (isWithin(candidate, paths.context) || isWithin(candidate, observation.root))) return { kind: 'file', path: candidate }
    } catch {
      // An unreadable path cannot support a claim.
    }
  }
  const evidenceMetadata = path.join(paths.evidence, runId, text, 'evidence.json')
  if (isWithin(evidenceMetadata, path.join(paths.evidence, runId)) && existsSync(evidenceMetadata)) {
    const record = readJson(evidenceMetadata)
    if (validateEvidenceRecord(paths, runId, evidenceMetadata, record).length === 0) return { kind: 'evidence', path: evidenceMetadata, record }
    return null
  }
  const found = findRun(paths, runId)
  if (!found || !existsSync(found.eventDir)) return null
  const runIntegrity = verifyRunView(paths, runId)
  if (!runIntegrity.runRecordValid || !runIntegrity.hashChainValid || !runIntegrity.sequencesValid) return null
  for (const name of readdirSync(found.eventDir).filter((entry) => entry.endsWith('.json'))) {
    try {
      const record = readJson(path.join(found.eventDir, name))
      if (record.eventId === text) return { kind: 'event', path: path.join(found.eventDir, name), record }
    } catch {
      // A corrupt event is not usable as evidence; verify reports the corruption separately.
    }
  }
  return null
}

function evidenceBinding(reference, resolved) {
  if (resolved.kind === 'file') return { reference, kind: 'file', path: path.resolve(resolved.path), sha256: sha256File(resolved.path) }
  if (resolved.kind === 'evidence') return { reference, kind: 'evidence', evidenceId: resolved.record.evidenceId, sha256: resolved.record.sha256, recordHash: sha256(stableJson(resolved.record)) }
  return { reference, kind: 'event', eventId: resolved.record.eventId, eventHash: resolved.record.eventHash }
}

function sealedEvidenceProblems(paths, observation, runId, evidence, bindings, label, visited = new Set(), depth = 0) {
  const references = evidence || []
  const problems = []
  if (!Array.isArray(bindings) || bindings.length !== references.length) return [`${label} lacks sealed evidence bindings.`]
  if (depth > 16) return [`${label} exceeds the nested evidence depth limit.`]
  for (const reference of references) {
    const resolved = resolveEvidenceReference(paths, observation, runId, reference)
    if (!resolved) {
      problems.push(`${label} has missing or corrupt evidence ${reference}.`)
      continue
    }
    const expected = evidenceBinding(reference, resolved)
    const binding = bindings.find((item) => item.reference === reference)
    if (!binding || stableJson(binding, 0) !== stableJson(expected, 0)) {
      problems.push(`${label} evidence binding changed for ${reference}.`)
      continue
    }
    if (resolved.kind !== 'event') continue
    const eventKey = `${resolved.record.runId}:${resolved.record.eventId}`
    if (visited.has(eventKey)) {
      problems.push(`${label} contains a cyclic event evidence reference at ${reference}.`)
      continue
    }
    const nextVisited = new Set(visited)
    nextVisited.add(eventKey)
    const nested = resolved.record.evidence || []
    if (nested.length > 0) {
      problems.push(...sealedEvidenceProblems(
        paths,
        observation,
        resolved.record.runId,
        nested,
        resolved.record.metadata?.eventEvidenceBindings,
        `${label} nested event ${resolved.record.eventId}`,
        nextVisited,
        depth + 1
      ))
    }
    if (resolved.record.metadata?.evidenceId) {
      const evidenceId = String(resolved.record.metadata.evidenceId)
      const metadataPath = path.join(paths.evidence, resolved.record.runId, evidenceId, 'evidence.json')
      if (!existsSync(metadataPath)) {
        problems.push(`${label} evidence-capture event ${resolved.record.eventId} is missing ${evidenceId}.`)
      } else {
        try {
          const record = readJson(metadataPath)
          const recordProblems = validateEvidenceRecord(paths, resolved.record.runId, metadataPath, record)
          if (recordProblems.length > 0 || resolved.record.metadata.evidenceRecordHash !== sha256(stableJson(record)) || resolved.record.metadata.storedSha256 !== record.sha256) {
            problems.push(`${label} evidence-capture event ${resolved.record.eventId} has a corrupt typed evidence binding.`)
          }
        } catch {
          problems.push(`${label} evidence-capture event ${resolved.record.eventId} cannot be validated.`)
        }
      }
    }
  }
  return problems
}

function recordRunId(record) {
  return record.sourceRunId || record.runId || String(record.sourceEvent || '').split('-E')[0] || ''
}

function supportedClaimEvidenceProblems(paths, observation, state) {
  const problems = []
  const records = [
    ...(state.claims || []).filter((item) => item.taskId === state.task?.id && item.status === 'supported').map((item) => ({ item, label: `Supported ${item.type} claim ${item.id}` })),
    ...(state.architectureClaims || []).filter((item) => item.taskId === state.task?.id && item.status === 'supported').map((item) => ({ item, label: `Supported architecture claim ${item.id}` })),
    ...(state.confirmedFacts || []).filter((item) => item.taskId === state.task?.id && item.status !== 'stale').map((item) => ({ item, label: `Confirmed fact ${item.id}` })),
    ...(state.hypotheses || []).filter((item) => item.taskId === state.task?.id && item.status === 'confirmed').map((item) => ({ item, label: `Confirmed hypothesis ${item.id}` })),
    ...(state.pitfalls || []).filter((item) => item.taskId === state.task?.id && item.status !== 'stale' && (item.evidence || []).length > 0).map((item) => ({ item, label: `Pitfall ${item.id}` }))
  ]
  for (const { item, label } of records) {
    problems.push(...sealedEvidenceProblems(paths, observation, recordRunId(item), item.evidence, item.evidenceBindings, label))
  }
  return unique(problems)
}

function buildEvidenceBindings(paths, observation, runId, evidence) {
  return evidence.map((reference) => {
    const resolved = resolveEvidenceReference(paths, observation, runId, reference)
    assert(resolved, `Evidence reference cannot be sealed: ${reference}`, 'CLAIM_EVIDENCE_UNRESOLVED')
    return evidenceBinding(reference, resolved)
  })
}

function validateEvidenceRecord(paths, runId, metadataPath, record) {
  const errors = []
  const evidenceId = path.basename(path.dirname(metadataPath))
  const evidenceRoot = path.join(paths.evidence, runId, evidenceId)
  if (record?.protocol !== 'project-context/evidence/v1') errors.push('unsupported evidence protocol')
  if (record?.runId !== runId || record?.evidenceId !== evidenceId) errors.push('evidence identity mismatch')
  if (!EVIDENCE_KINDS.has(record?.kind || 'attachment')) errors.push('invalid evidence kind')
  const storedPath = record?.storedPath ? path.resolve(String(record.storedPath)) : null
  if (!storedPath || !isWithin(storedPath, evidenceRoot) || !existsSync(storedPath)) {
    errors.push('stored evidence path is missing or outside its evidence directory')
  } else {
    try {
      const stat = lstatSync(storedPath)
      const realRoot = realpathSync(evidenceRoot)
      const realStored = realpathSync(storedPath)
      if (!stat.isFile() || stat.isSymbolicLink() || !isWithin(realStored, realRoot)) errors.push('stored evidence is not a safe regular file')
      else {
        if (stat.size !== record.size) errors.push('stored evidence size mismatch')
        if (sha256File(storedPath) !== record.sha256) errors.push('stored evidence hash mismatch')
      }
    } catch {
      errors.push('stored evidence cannot be inspected')
    }
  }
  const found = findRun(paths, runId)
  let attested = false
  if (found && existsSync(found.eventDir)) {
    const runIntegrity = verifyRunView(paths, runId)
    if (!runIntegrity.runRecordValid || !runIntegrity.hashChainValid || !runIntegrity.sequencesValid) errors.push('evidence attestation run is corrupt')
    for (const name of readdirSync(found.eventDir).filter((entry) => /^\d{6}\.json$/.test(entry))) {
      try {
        const event = readJson(path.join(found.eventDir, name))
        if (event.metadata?.evidenceId === evidenceId && event.metadata?.evidenceRecordHash === sha256(stableJson(record)) && event.metadata?.storedSha256 === record.sha256) {
          attested = true
          break
        }
      } catch {
        // Run verification reports corrupt events; they cannot attest evidence here.
      }
    }
  }
  if (!attested) errors.push('evidence metadata is not bound to an immutable run event')
  return errors
}

function assertResolvableEvidence(paths, observation, runId, evidence, label) {
  assert(evidence.length > 0, `${label} requires --evidence`, 'CLAIM_EVIDENCE_REQUIRED')
  const unresolved = evidence.filter((item) => !resolveEvidenceReference(paths, observation, runId, item))
  assert(unresolved.length === 0, `${label} contains unresolved evidence references: ${unresolved.join(', ')}`, 'CLAIM_EVIDENCE_UNRESOLVED')
}

function capturedEvidenceRecords(paths, observation, runId, evidence) {
  return evidence
    .map((item) => resolveEvidenceReference(paths, observation, runId, item))
    .filter((item) => item?.kind === 'evidence' && item.record?.protocol === 'project-context/evidence/v1')
    .map((item) => item.record)
}

function commitChangedFileManifest(observation, afterHash) {
  const raw = git(observation.root, ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-z', afterHash], { trim: false })
  const fields = raw.split('\0').filter(Boolean)
  const entries = []
  for (let index = 0; index < fields.length;) {
    const status = fields[index++]
    const pathCount = /^[RC]/.test(status) ? 2 : 1
    const paths = fields.slice(index, index + pathCount)
    assert(paths.length === pathCount, 'Observed commit changed-file manifest is malformed', 'COMMIT_FILE_MANIFEST_INVALID')
    index += pathCount
    entries.push({ status, paths })
  }
  const previewLimit = 100
  return {
    count: entries.length,
    sha256: sha256(raw),
    preview: entries.slice(0, previewLimit),
    previewTruncated: entries.length > previewLimit
  }
}

function observeLiveCommit(observation, priorObservation, args) {
  const beforeHash = required(args, 'before-hash', 'An observed successful commit requires its parent --before-hash')
  const afterHash = required(args, 'after-hash', 'An observed successful commit requires --after-hash')
  assert(beforeHash === priorObservation.head, 'Observed commit --before-hash must equal the previously recorded HEAD', 'COMMIT_PRIOR_HEAD_CONFLICT')
  assert(afterHash === observation.head, 'Observed commit --after-hash must equal live HEAD', 'COMMIT_HEAD_EVIDENCE_CONFLICT')
  const objectType = git(observation.root, ['cat-file', '-t', afterHash])
  assert(objectType === 'commit', `Observed HEAD ${afterHash} is not a commit object`, 'COMMIT_OBJECT_INVALID')
  const lineage = git(observation.root, ['rev-list', '--parents', '-n', '1', afterHash]).split(/\s+/).filter(Boolean)
  assert(lineage[0] === afterHash && lineage[1] === beforeHash, 'Observed commit first parent is not the previously recorded HEAD', 'COMMIT_PARENT_CONFLICT')
  const tree = git(observation.root, ['rev-parse', `${afterHash}^{tree}`])
  assert(tree === observation.tree, 'Observed commit tree does not equal the live HEAD tree', 'COMMIT_TREE_CONFLICT')
  const expectedScope = observation.branch ? `refs/heads/${observation.branch}` : `detached:${afterHash}`
  assert(String(args.scope || '') === expectedScope, `Observed commit scope must equal ${expectedScope}`, 'COMMIT_SCOPE_CONFLICT')
  const changedFiles = commitChangedFileManifest(observation, afterHash)
  return {
    observerVerified: true,
    observerType: BUILTIN_RELEASE_OBSERVERS.commit,
    observation: { objectType, beforeHash, afterHash, parents: lineage.slice(1), tree, scope: expectedScope, changedFiles }
  }
}

function observeLivePush(observation, args) {
  assert(args['allow-remote-observation'], 'Observed push verification requires explicit --allow-remote-observation because git ls-remote makes a read-only network connection', 'REMOTE_OBSERVATION_NOT_ALLOWED')
  const remote = required(args, 'remote', 'An observed successful push requires a configured --remote name')
  const ref = required(args, 'ref', 'An observed successful push requires an exact full --ref')
  assert(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(remote) && !remote.includes('..') && !remote.includes('//'), '--remote must be a configured remote name', 'PUSH_REMOTE_INVALID')
  const configured = git(observation.root, ['remote']).split(/\r?\n/).filter(Boolean)
  assert(configured.includes(remote), `Configured remote not found: ${remote}`, 'PUSH_REMOTE_NOT_FOUND')
  const pushTargets = git(observation.root, ['remote', 'get-url', '--push', '--all', remote]).split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
  assert(pushTargets.length === 1 && !pushTargets[0].startsWith('-'), `Remote ${remote} must have exactly one safe configured push URL`, 'PUSH_REMOTE_TARGET_AMBIGUOUS')
  const rawTarget = pushTargets[0]
  assert(rawTarget.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(rawTarget) && !/^ext::/i.test(rawTarget), `Remote ${remote} uses an unsafe observation target`, 'PUSH_REMOTE_PROTOCOL_UNSAFE')
  assert(!rawTarget.startsWith('\\\\') && !rawTarget.startsWith('//'), `Remote ${remote} must not use a UNC or network-share path`, 'PUSH_REMOTE_PROTOCOL_UNSAFE')
  let parsedTarget = null
  if (/^(?:https?|ssh|git|file):\/\//i.test(rawTarget)) {
    try {
      parsedTarget = new URL(rawTarget)
    } catch {
      assert(false, `Remote ${remote} URL is malformed`, 'PUSH_REMOTE_PROTOCOL_UNSAFE')
    }
    assert(!parsedTarget.username && !parsedTarget.password && !parsedTarget.search && !parsedTarget.hash, `Remote ${remote} observation URL must not embed user credentials, query parameters, or fragments`, 'PUSH_REMOTE_CREDENTIALS_FORBIDDEN')
  }
  assert(!/^[^/:@]+@[^:]+:/.test(rawTarget), `Remote ${remote} scp-style URL must not embed a username`, 'PUSH_REMOTE_CREDENTIALS_FORBIDDEN')
  let transport
  if (/^https:\/\//i.test(rawTarget)) transport = 'https'
  else if (/^git:\/\//i.test(rawTarget)) transport = 'git'
  else if (/^file:\/\//i.test(rawTarget) || path.isAbsolute(rawTarget) || /^[.]{1,2}[\\/]/.test(rawTarget)) transport = 'file'
  else if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(rawTarget) && existsSync(path.resolve(observation.root, rawTarget))) transport = 'file'
  else assert(false, `Remote ${remote} protocol is not explicitly allowed for read-only observation`, 'PUSH_REMOTE_PROTOCOL_UNSAFE')
  let observationTarget = rawTarget
  if (transport === 'file') {
    if (parsedTarget) assert(parsedTarget.protocol === 'file:' && !parsedTarget.hostname, `Remote ${remote} file URL must identify only a local path`, 'PUSH_REMOTE_PROTOCOL_UNSAFE')
    const localTarget = parsedTarget ? fileURLToPath(parsedTarget) : path.resolve(observation.root, rawTarget)
    assert(existsSync(localTarget), `Remote ${remote} local observation target does not exist`, 'PUSH_REMOTE_TARGET_INVALID')
    observationTarget = realpathSync.native(localTarget)
    assert(!observationTarget.startsWith('\\\\') && !observationTarget.startsWith('//'), `Remote ${remote} resolved to a UNC or network-share path`, 'PUSH_REMOTE_PROTOCOL_UNSAFE')
  }
  const normalizedTarget = normalizeRemote(observationTarget)
  assert(normalizedTarget, `Remote ${remote} push URL cannot be normalized safely`, 'PUSH_REMOTE_TARGET_INVALID')
  const targetFingerprint = sha256(normalizedTarget)
  assert(ref.startsWith('refs/'), '--ref must be a full ref beginning with refs/', 'PUSH_REF_INVALID')
  git(observation.root, ['check-ref-format', ref])
  const afterHash = required(args, 'after-hash', 'An observed successful push requires --after-hash')
  assert(afterHash === observation.head, 'Observed push --after-hash must equal live HEAD', 'PUSH_HEAD_EVIDENCE_CONFLICT')
  const transportPolicy = [
    '-c', 'protocol.allow=never',
    '-c', `protocol.${transport}.allow=always`,
    '-c', 'protocol.ext.allow=never',
    '-c', 'credential.helper=',
    '-c', 'core.askPass=',
    '-c', 'core.gitProxy=',
    '-c', 'http.extraHeader=',
    '-c', 'http.cookieFile=',
    '-c', 'http.saveCookies=false'
  ]
  const rows = gitIsolated([...transportPolicy, 'ls-remote', '--refs', observationTarget, ref]).split(/\r?\n/).filter(Boolean).map((line) => {
    const separator = line.indexOf('\t')
    return separator < 0 ? { oid: '', ref: '' } : { oid: line.slice(0, separator).toLowerCase(), ref: line.slice(separator + 1) }
  }).filter((row) => row.ref === ref)
  assert(rows.length === 1 && /^[0-9a-f]{40,64}$/.test(rows[0].oid), `Remote ${remote} did not return one exact ${ref}`, 'PUSH_REMOTE_REF_INVALID')
  assert(rows[0].oid === afterHash.toLowerCase(), `Remote ${remote} ${ref} does not match live HEAD`, 'PUSH_REMOTE_REF_CONFLICT')
  const expectedScope = `git-push:${remote}:${ref}:${targetFingerprint}`
  const expectedEnvironment = `git-remote:${remote}:${targetFingerprint}`
  assert(String(args.scope || '') === expectedScope, `Observed push scope must equal ${expectedScope}`, 'PUSH_SCOPE_CONFLICT')
  assert(String(args.environment || '') === expectedEnvironment, `Observed push environment must equal ${expectedEnvironment}`, 'PUSH_ENVIRONMENT_CONFLICT')
  return {
    observerVerified: true,
    observerType: BUILTIN_RELEASE_OBSERVERS.push,
    observation: { remote, ref, remoteTransport: transport, remoteTargetFingerprint: targetFingerprint, remoteOid: rows[0].oid, afterHash, scope: expectedScope, environment: expectedEnvironment }
  }
}

function assertLifecycleEventEvidence(paths, observation, priorObservation, runId, evidence, eventType, outcome, attribution, args) {
  if (outcome !== 'succeeded') return { validated: false, records: [], observerVerified: false, observerType: null, observation: null }
  assert(['observed', 'unattributed'].includes(attribution), 'Standalone mode cannot record a performed successful high-risk event', 'STANDALONE_HIGH_RISK_EXECUTION_DISABLED')
  assert(['commit', 'push'].includes(eventType), `Standalone mode has no built-in observer for a successful ${eventType} event`, 'RELEASE_OBSERVER_UNAVAILABLE')
  required(args, 'scope', `A successful ${eventType} event requires an exact --scope`)
  if (evidence.length > 0) assertResolvableEvidence(paths, observation, runId, evidence, `A successful ${eventType} event`)
  const records = capturedEvidenceRecords(paths, observation, runId, evidence)
  const environment = args.environment && args.environment !== true ? String(args.environment) : null
  if (eventType === 'push') assert(environment && environment !== 'local-unspecified', 'A successful observed push requires an explicit --environment', 'LIFECYCLE_ENVIRONMENT_REQUIRED')
  const observer = eventType === 'commit' ? observeLiveCommit(observation, priorObservation, args) : observeLivePush(observation, args)
  return { validated: true, records, ...observer }
}

function assertTypedReleaseEvidence(paths, observation, runId, evidence, claimType, signal) {
  const requiredEventType = ['committed', 'pushed'].includes(claimType) ? 'git' : 'release'
  const matching = evidence.map((item) => resolveEvidenceReference(paths, observation, runId, item)).filter((item) => item?.kind === 'event').find((item) => {
    const metadata = item.record.metadata || {}
    const provenanceValid = ['observed', 'unattributed'].includes(metadata.attribution) && metadata.evidenceValidated === true && metadata.observerVerified === true
    return item.record.type === requiredEventType && metadata.eventType === signal && metadata.outcome === 'succeeded' && provenanceValid
  })
  assert(matching, `A supported ${claimType} claim requires a prior successful ${requiredEventType}/${signal} event ID as evidence`, 'RELEASE_EVENT_EVIDENCE_REQUIRED')
  return matching.record
}

function activeRunEntry(paths, run) {
  const found = findRun(paths, run.runId)
  return {
    runId: run.runId,
    status: run.status,
    taskId: run.taskId,
    startedAt: run.startedAt,
    path: found?.runMarkdown || null
  }
}

export function registerCommand(args) {
  requireUserConfirmedVault(args, 'register')
  const current = observe(args)
  const vaultSelection = vaultSelectionRecord(current.paths.vault, 'register')
  const vaultInitialized = existsSync(current.paths.registry) || existsSync(current.paths.repositoryMetadata) || existsSync(current.paths.currentPointer)
  if (!vaultInitialized) {
    const preliminaryTask = taskRecord(args, null)
    if (preliminaryTask) assertApprovedPrd(preliminaryTask)
    ensureVault(current.paths, current.observation)
  }
  return withStateLock(current.paths, () => {
    let bundle = loadState(current.paths)
    if (bundle) {
      assertIdentity(bundle, current.observation)
      const runId = required(args, 'run', 'Refreshing an existing registration requires --run from the current session')
      assert(bundle.state.activeRuns.some((item) => item.runId === runId), `Run ${runId} is not active in this context`, 'RUN_NOT_ACTIVE_IN_CONTEXT')
      validateRunSession(current.paths, runId, args)
      ensureVault(current.paths, current.observation)
    }
    const task = taskRecord(args, bundle?.state.task || null)
    if (task) assertApprovedPrd(task)
    let state = bundle?.state || initialState(current.observation, {})
    const liveChanges = bundle ? liveObservationChanges(state, current.observation) : []
    assert(liveChanges.length === 0, `Registration cannot absorb live ${liveChanges.join(', ')} changes; begin a run and checkpoint or explicitly reconcile them there`, 'LIVE_CHANGE_RECONCILIATION_REQUIRED')
    const taskChanged = Boolean(state.task && task && (state.task.id !== task.id || state.task.title !== task.title))
    if (taskChanged) assert(args['transition-reason'] && args['transition-reason'] !== true, 'Changing the active task requires --transition-reason', 'TASK_TRANSITION_REASON_REQUIRED')
    const taskUpdated = taskMaterialChanged(state.task, task)
    if (taskUpdated) assert(args['task-update-reason'] && args['task-update-reason'] !== true, 'Changing material fields of the current task requires --task-update-reason', 'TASK_UPDATE_REASON_REQUIRED')
    assert(!(taskChanged || taskUpdated), 'An existing task can only be changed through begin with explicit current-session user authority', 'TASK_TRANSITION_REQUIRES_BEGIN')
    assert(!prdMaterialChanged(state.task, task), 'PRD revisions must be reconciled through begin with a new session, explicit current-user authority, and --reconcile-prd', 'PRD_RECONCILE_REQUIRES_BEGIN')
    const taskHistory = [...(state.taskHistory || [])]
    if (taskChanged) taskHistory.push(archivedTask(state.task, 'superseded', String(args['transition-reason'])))
    else if (taskUpdated) taskHistory.push(archivedTask(state.task, 'revised', String(args['task-update-reason'])))
    const preserveBlocked = ['BLOCKED', 'CONFLICT'].includes(state.trust?.status)
    state = {
      ...state,
      repo: {
        ...state.repo,
        root: current.observation.root,
        canonicalRemote: current.observation.canonicalRemote,
        branch: current.observation.branch,
        detached: current.observation.detached
      },
      observation: compactObservation(current.observation),
      vaultSelection,
      task,
      stage: 'registered',
      taskHistory,
      trust: task ? preserveBlocked ? state.trust : { status: 'READY', reasons: [] } : { status: 'UNMANAGED', reasons: ['No active task has been recorded.'] },
      nextObjective: args.next && args.next !== true ? String(args.next) : state.nextObjective
    }
    const manifest = generateProjectMap(current.paths, current.observation)
    state.map = mapReference(manifest, current.paths)
    bundle = writeState(current.paths, bundle, state)
    return { command: 'register', state: safeStateSummary(bundle), pointer: bundle.pointer, map: state.map, recovery: recoveryCard(bundle, current.observation, current.paths, vaultSelection) }
  })
}

export function beginCommand(args) {
  requireUserConfirmedVault(args, 'begin')
  const current = observe(args)
  const vaultSelection = vaultSelectionRecord(current.paths.vault, 'begin')
  const leaseSeconds = validatedLeaseSeconds(args)
  const vaultInitialized = existsSync(current.paths.registry) || existsSync(current.paths.repositoryMetadata) || existsSync(current.paths.currentPointer)
  if (!vaultInitialized) {
    const preliminaryTask = taskRecord(args, null)
    assert(preliminaryTask, '--task is required when no current task exists', 'TASK_REQUIRED')
    assertApprovedPrd(preliminaryTask)
    assert(!(args.recover && args.recover !== true), '--recover cannot reference a run in a vault that does not exist', 'RECOVERY_RUN_NOT_FOUND')
    assert(!(args.parent && args.parent !== true), '--parent cannot reference a run in a vault that does not exist', 'PARENT_RUN_NOT_FOUND')
    if (args['resolve-trust']) {
      required(args, 'reconcile-reason', '--reconcile-reason is required with --resolve-trust')
      required(args, 'authority', '--authority from the current user is required with --resolve-trust')
      assert(args['current-session-authority'], '--current-session-authority is required with --resolve-trust', 'CURRENT_AUTHORITY_REQUIRED')
    }
    ensureVault(current.paths, current.observation)
  }
  return withStateLock(current.paths, () => {
    let bundle = loadState(current.paths)
    if (!bundle) {
      const unmanaged = initialState(current.observation, {})
      bundle = writeState(current.paths, null, unmanaged)
    }
    assertIdentity(bundle, current.observation)
    assertActiveRunsIntegrity(current.paths, bundle.state)
    const recordedPrd = bundle.state.task?.prd || null
    const recordedPrdDrift = Boolean(recordedPrd && (!existsSync(recordedPrd.path) || !statSync(recordedPrd.path).isFile() || sha256File(recordedPrd.path) !== recordedPrd.sha256))
    const task = taskRecord(args, bundle.state.task)
    assert(task, '--task is required when no current task exists', 'TASK_REQUIRED')
    assertApprovedPrd(task)
    const taskChanged = Boolean(bundle.state.task && (bundle.state.task.id !== task.id || bundle.state.task.title !== task.title))
    if (taskChanged) assert(args['transition-reason'] && args['transition-reason'] !== true, 'Changing the active task requires --transition-reason', 'TASK_TRANSITION_REASON_REQUIRED')
    const taskUpdated = taskMaterialChanged(bundle.state.task, task)
    if (taskUpdated) assert(args['task-update-reason'] && args['task-update-reason'] !== true, 'Changing material fields of the current task requires --task-update-reason', 'TASK_UPDATE_REASON_REQUIRED')
    if (taskChanged || taskUpdated) {
      required(args, 'authority', 'Changing an existing task requires --authority from the current user')
      assert(args['current-session-authority'], 'Changing an existing task requires --current-session-authority', 'CURRENT_AUTHORITY_REQUIRED')
    }
    const prdUpdated = prdMaterialChanged(bundle.state.task, task)
    if (recordedPrdDrift || prdUpdated) {
      assert(args['reconcile-prd'], 'A changed PRD requires --reconcile-prd', 'PRD_RECONCILIATION_REQUIRED')
      required(args, 'prd-path', '--prd-path is required to recompute a reconciled PRD hash')
      required(args, 'prd-approval', '--prd-approval must be restated for the reconciled PRD')
      required(args, 'task-update-reason', '--task-update-reason is required for PRD reconciliation')
      required(args, 'reconcile-reason', '--reconcile-reason is required for PRD reconciliation')
      required(args, 'authority', '--authority from the current user is required for PRD reconciliation')
      assert(args['current-session-authority'], '--current-session-authority is required for PRD reconciliation', 'CURRENT_AUTHORITY_REQUIRED')
      assertApprovedPrd(task)
    }
    const liveChanges = liveObservationChanges(bundle.state, current.observation)
    if (liveChanges.length > 0) {
      assert(args['reconcile-live-change'], `Live ${liveChanges.join(', ')} changed since the last checkpoint; --reconcile-live-change is required`, 'LIVE_CHANGE_RECONCILIATION_REQUIRED')
      required(args, 'reconcile-reason', '--reconcile-reason is required when adopting live changes')
    }
    if (args['resolve-trust']) {
      required(args, 'reconcile-reason', '--reconcile-reason is required with --resolve-trust')
      required(args, 'authority', '--authority from the current user is required with --resolve-trust')
      assert(args['current-session-authority'], '--current-session-authority is required with --resolve-trust', 'CURRENT_AUTHORITY_REQUIRED')
    }
    const recoveredFromRunId = args.recover && args.recover !== true ? String(args.recover) : null
    const parentRunId = args.parent && args.parent !== true ? String(args.parent) : null
    let recoveredRunWasAbandoned = false
    const existingActiveRuns = bundle.state.activeRuns.filter((item) => item.status === 'active')
    if (existingActiveRuns.length > 0) {
      const explicitlyOwned = Boolean(recoveredFromRunId || parentRunId || args.parallel)
      assert(explicitlyOwned, 'An active run already exists; use --recover, --parent, or --parallel with an explicit reason', 'ACTIVE_RUN_OWNERSHIP_REQUIRED')
      if (args.parallel) required(args, 'parallel-reason', '--parallel-reason is required for an explicitly parallel run')
    }
    if (recoveredFromRunId) {
      const recovered = findRun(current.paths, recoveredFromRunId)
      assert(recovered, `Recovery source run ${recoveredFromRunId} was not found`, 'RECOVERY_RUN_NOT_FOUND')
      assertRunIntegrity(current.paths, recoveredFromRunId)
      assert(['active', 'interrupted', 'partial', 'blocked'].includes(recovered.run.status), `Run ${recoveredFromRunId} is not recoverable from status ${recovered.run.status}`, 'RECOVERY_RUN_STATUS_INVALID')
      if (recovered.run.status === 'active') {
        required(args, 'recovery-reason', '--recovery-reason is required before superseding an active run')
        required(args, 'authority', '--authority from the current user is required before superseding an active run')
        assert(args['current-session-authority'], '--current-session-authority is required before superseding an active run', 'CURRENT_AUTHORITY_REQUIRED')
        if (args['recovered-session'] && args['recovered-session'] !== true) {
          assert(sha256(String(args['recovered-session'])) === recovered.run.sessionNonceHash, 'The recovered run session token is invalid', 'RECOVERED_RUN_SESSION_INVALID')
        }
        recoveredRunWasAbandoned = true
      }
    }
    if (parentRunId) {
      const parent = findRun(current.paths, parentRunId)
      assert(parent, `Parent run ${parentRunId} was not found`, 'PARENT_RUN_NOT_FOUND')
      assertRunIntegrity(current.paths, parentRunId)
      assert(['active', 'partial', 'blocked', 'interrupted'].includes(parent.run.status), `Run ${parentRunId} cannot parent a new run from status ${parent.run.status}`, 'PARENT_RUN_STATUS_INVALID')
      assert(parent.run.taskId === task.id, 'Parent run belongs to another task', 'PARENT_RUN_TASK_CONFLICT')
    }
    if (vaultInitialized) ensureVault(current.paths, current.observation)
    const runId = randomId('RUN')
    const session = randomId('SESSION')
    const provisional = { ...bundle, state: { ...bundle.state, task } }
    let created
    try {
      let taskAuthorizationEventId = null
      let externalChangeEventId = null
      created = createRun(current.paths, provisional, current.observation, {
        runId,
        sessionNonceHash: sha256(session),
        recoveredFromRunId,
        parentRunId,
        agent: args.agent && args.agent !== true ? String(args.agent) : 'unspecified-agent',
        harness: args.harness && args.harness !== true ? String(args.harness) : 'manual-cli',
        leaseTtlSeconds: leaseSeconds,
        leaseSource: args.harness && args.harness !== true ? String(args.harness) : 'manual-cli',
        captureCoverage: args.coverage && args.coverage !== true ? String(args.coverage) : 'observed-and-agent-reported',
        vaultSelection,
        request: args.request && args.request !== true ? String(args.request) : task.objective,
        authority: args.authority && args.authority !== true ? String(args.authority) : null,
        authoritySource: args['authority-source'] && args['authority-source'] !== true ? String(args['authority-source']) : 'current-user-request'
      })
      if (taskChanged || taskUpdated) {
        const taskAuthorization = appendRunEvent(current.paths, runId, {
          type: 'authorization',
          summary: taskChanged ? 'Changed the unique active task under explicit current-session user authority.' : 'Updated material fields of the active task under explicit current-session user authority.',
          details: taskChanged ? String(args['transition-reason']) : String(args['task-update-reason']),
          scope: task.id,
          actor: args.agent && args.agent !== true ? String(args.agent) : 'unspecified-agent',
          source: 'current-user-task-transition',
          metadata: {
            previousTaskId: bundle.state.task?.id || null,
            nextTaskId: task.id,
            currentSessionAuthority: true,
            authorityFingerprint: sha256(String(args.authority))
          }
        })
        taskAuthorizationEventId = taskAuthorization.event.eventId
      }
      if (liveChanges.length > 0) {
        const externalChange = appendRunEvent(current.paths, runId, {
          type: 'external-change',
          summary: 'Explicitly adopted repository changes observed before this Agent run.',
          details: String(args['reconcile-reason']),
          scope: liveChanges.join(', '),
          files: current.observation.statusLines,
          actor: args.agent && args.agent !== true ? String(args.agent) : 'unspecified-agent',
          source: 'live-repository-reconciliation',
          metadata: {
            reconciled: true,
            changedBindings: liveChanges,
            attribution: args.attribution && args.attribution !== true ? String(args.attribution) : 'unattributed-before-run',
            prior: {
              branch: bundle.state.observation.branch,
              head: bundle.state.observation.head,
              statusFingerprint: bundle.state.observation.statusFingerprint
            },
            live: {
              branch: current.observation.branch,
              head: current.observation.head,
              statusFingerprint: current.observation.statusFingerprint
            }
          }
        })
        externalChangeEventId = externalChange.event.eventId
      }
      if (recoveredFromRunId) {
        appendRunEvent(current.paths, runId, {
          type: 'authorization',
          summary: 'Started a recovery run from an earlier run under explicit current-session authority.',
          details: args['recovery-reason'] && args['recovery-reason'] !== true
            ? String(args['recovery-reason'])
            : `Recovered ${recoveredFromRunId} from its recorded non-active status.`,
          scope: recoveredFromRunId,
          actor: args.agent && args.agent !== true ? String(args.agent) : 'unspecified-agent',
          source: args['current-session-authority'] ? 'current-user-run-recovery' : 'recorded-run-recovery',
          metadata: {
            recoveredFromRunId,
            priorRunRecordRewritten: false,
            priorRunDisposition: args['recovered-session'] && args['recovered-session'] !== true ? 'superseded-with-old-session-proven-but-not-rewritten' : 'superseded-without-old-session-write',
            currentSessionAuthority: Boolean(args['current-session-authority']),
            authorityFingerprint: args.authority && args.authority !== true ? sha256(String(args.authority)) : null
          }
        })
      }
      if (recordedPrdDrift || prdUpdated) {
        appendRunEvent(current.paths, runId, {
          type: 'authorization',
          summary: 'Reconciled a PRD revision under current-session user authority.',
          details: String(args.authority),
          scope: task.prd?.path || 'no-prd',
          actor: args.agent && args.agent !== true ? String(args.agent) : 'unspecified-agent',
          source: 'current-user-prd-approval',
          metadata: {
            priorPrdHash: recordedPrd?.sha256 || null,
            currentPrdHash: task.prd?.sha256 || null,
            approval: task.prd?.approval || null,
            sections: task.prd?.sections || [],
            reason: String(args['reconcile-reason'])
          }
        })
      }
      if (args['resolve-trust'] && liveChanges.length === 0 && !(recordedPrdDrift || prdUpdated)) {
        appendRunEvent(current.paths, runId, {
          type: 'decision',
          summary: 'Explicitly resolved a previously persisted trust conflict for this run.',
          details: String(args['reconcile-reason']),
          actor: args.agent && args.agent !== true ? String(args.agent) : 'unspecified-agent',
          source: 'authenticated-run-trust-reconciliation',
          metadata: { priorTrust: bundle.state.trust, resultingTrust: 'READY' }
        })
      }
      const taskHistory = [...(bundle.state.taskHistory || [])]
      if (taskChanged) taskHistory.push(archivedTask(bundle.state.task, 'superseded', String(args['transition-reason'])))
      else if (taskUpdated) taskHistory.push(archivedTask(bundle.state.task, 'revised', String(args['task-update-reason'])))
      const unresolvedBlockers = (bundle.state.blockers || []).some((item) => item.taskId === task.id && item.status !== 'resolved')
      const preservePriorTrust = !args['resolve-trust'] && ['BLOCKED', 'CONFLICT'].includes(bundle.state.trust?.status)
      const staleClaims = staleRevisionBoundClaims(
        bundle.state.claims,
        bundle.state.observation,
        current.observation,
        taskUpdated ? 'The active task or approved requirement changed; prior evidence must be re-evaluated for the revised requirement.' : 'The repository revision or working-tree fingerprint changed; prior evidence is not current for this checkout.',
        taskAuthorizationEventId || externalChangeEventId,
        taskUpdated
      )
      const state = {
        ...bundle.state,
        task,
        stage: 'active-run',
        taskHistory,
        claims: staleClaims,
        architectureClaims: staleArchitectureClaims(
          bundle.state.architectureClaims,
          bundle.state.observation,
          current.observation,
          taskUpdated ? 'The active task or approved requirement changed; prior architecture evidence must be re-evaluated.' : 'The repository revision or working-tree fingerprint changed; prior architecture evidence is stale.',
          taskAuthorizationEventId || externalChangeEventId,
          taskUpdated
        ),
        confirmedFacts: staleDiagnosticRecords(
          bundle.state.confirmedFacts, bundle.state.task?.id, bundle.state.observation, current.observation,
          taskUpdated ? 'The active task or approved requirement changed; prior facts require re-confirmation.' : 'The repository revision or working-tree fingerprint changed; prior facts are stale.',
          taskAuthorizationEventId || externalChangeEventId, taskUpdated
        ),
        hypotheses: staleDiagnosticRecords(
          bundle.state.hypotheses, bundle.state.task?.id, bundle.state.observation, current.observation,
          taskUpdated ? 'The active task or approved requirement changed; prior confirmed hypotheses require re-evaluation.' : 'The repository revision or working-tree fingerprint changed; prior confirmed hypotheses are unresolved.',
          taskAuthorizationEventId || externalChangeEventId, taskUpdated, true
        ),
        pitfalls: staleDiagnosticRecords(
          bundle.state.pitfalls, bundle.state.task?.id, bundle.state.observation, current.observation,
          taskUpdated ? 'The active task or approved requirement changed; prior pitfalls are historical.' : 'The repository revision or working-tree fingerprint changed; prior pitfall evidence is stale.',
          taskAuthorizationEventId || externalChangeEventId, taskUpdated
        ),
        abandonedRuns: recoveredRunWasAbandoned ? [...(bundle.state.abandonedRuns || []), {
          runId: recoveredFromRunId,
          status: 'superseded-without-old-session-write',
          supersededByRunId: runId,
          observedAt: nowIso(),
          reason: String(args['recovery-reason']),
          immutablePriorRun: true
        }] : bundle.state.abandonedRuns || [],
        repo: { ...bundle.state.repo, branch: current.observation.branch, detached: current.observation.detached },
        observation: created.run.startObservation,
        vaultSelection: created.run.vaultSelection,
        trust: unresolvedBlockers ? { status: 'BLOCKED', reasons: ['One or more recorded blockers remain open.'] } : preservePriorTrust ? bundle.state.trust : { status: 'READY', reasons: [] },
        activeRuns: [...bundle.state.activeRuns.filter((item) => item.runId !== runId && item.runId !== recoveredFromRunId), activeRunEntry(current.paths, created.run)],
        authorityHistory: created.run.authorityRecord ? [...bundle.state.authorityHistory, {
          runId,
          text: created.run.authorityRecord.text,
          source: created.run.authorityRecord.source,
          recordedAt: created.run.authorityRecord.recordedAt,
          historicalOnly: true
        }] : bundle.state.authorityHistory,
        nextObjective: args.next && args.next !== true ? String(args.next) : bundle.state.nextObjective || task.objective
      }
      bundle = writeState(current.paths, bundle, state)
    } catch (error) {
      if (created) {
        const found = findRun(current.paths, runId)
        if (found) {
          found.run.status = 'failed-to-adopt'
          found.run.endedAt = nowIso()
          found.run.summary = `State adoption failed: ${error.message}`
          found.run = saveRunRecord(found.runFile, found.run)
          refreshRunView(current.paths, runId)
        }
      }
      throw error
    }
    return {
      command: 'begin',
      runId,
      session,
      run: findRun(current.paths, runId)?.runMarkdown,
      stateBindingHash: routeToken(bundle, current.observation, runId),
      routeRequired: true,
      stateGeneration: bundle.state.generation,
      historicalAuthorizationOnly: true,
      vaultSelection: bundle.state.vaultSelection
    }
  })
}

export function resumeCommand(args) {
  requireUserConfirmedVault(args, 'resume')
  const current = observe(args)
  const vaultSelection = vaultSelectionRecord(current.paths.vault, 'resume')
  validateVaultLocation(current.vault, current.observation)
  const bundle = loadState(current.paths)
  const card = recoveryCard(bundle, current.observation, current.paths, vaultSelection)
  return { command: 'resume', card, text: textCard(card), exitCode: ['READY', 'UNMANAGED'].includes(card.trust.status) ? 0 : 3 }
}

export function routeCommand(args) {
  const current = observe(args)
  const bundle = loadState(current.paths)
  assert(bundle, 'Repository is not registered', 'STATE_UNMANAGED')
  assertIdentity(bundle, current.observation)
  const authority = args.authority && args.authority !== true ? String(args.authority) : null
  const signals = splitList(required(args, 'event', '--event is required so routing can be recomputed deterministically'))
  const key = protocolKey(current.paths)
  const keyId = sha256(key).slice(0, 16)
  const sensitivePreflight = signals.some((signal) => ['commit', 'push'].includes(String(signal).toLowerCase()))
    ? gitSensitivePreflight(current.paths, current.observation, bundle)
    : []
  if (args.validate && args.validate !== true) {
    const supplied = decodeRouteCredential(String(args.validate), key)
    const currentAuthority = Boolean(args['current-session-authority'])
    let run = null
    if (supplied.activeRunId) run = validateRunSession(current.paths, supplied.activeRunId, args, { allowDisconnected: true }).run
    const trust = classifyTrust(bundle, current.observation, current.paths)
    const selected = selectMode(trust, bundle.state, signals, supplied.activeRunId)
    const highRisk = selected.mode === 'release-with-provenance'
    const approval = highRisk ? externalApprovalStatus(current.paths, bundle, current.observation, run, signals, authority, args) : { valid: true }
    const approvalBinding = approval.valid && highRisk ? {
      approvalId: approval.approvalId,
      providerFingerprint: approval.providerFingerprint,
      providerKeyId: approval.providerKeyId,
      capabilityHash: approval.capabilityHash,
      operationScope: approval.operationScope,
      environment: approval.environment,
      expiresAt: approval.expiresAt
    } : null
    const expected = credentialPayload(bundle, current.observation, selected.mode, signals, authority, supplied.activeRunId, run?.sessionNonceHash || null, currentAuthority, keyId, approvalBinding)
    const mismatches = credentialMismatches(expected, supplied)
    if (!supplied.issuedAt || !Number.isFinite(Date.parse(supplied.issuedAt)) || Date.parse(supplied.issuedAt) > Date.now() + 60_000) mismatches.push('issuedAt')
    if (!supplied.expiresAt || !Number.isFinite(Date.parse(supplied.expiresAt)) || Date.parse(supplied.expiresAt) < Date.now()) mismatches.push('expiresAt')
    const activeExists = supplied.activeRunId ? bundle.state.activeRuns.some((item) => item.runId === supplied.activeRunId) : true
    if (!activeExists) mismatches.push('activeRunId')
    if (trust.status !== 'READY') mismatches.push('trustStatus')
    if (sensitivePreflight.length > 0) mismatches.push('sensitiveGitPreflight')
    if (supplied.mode === 'release-with-provenance' && (!authority || !currentAuthority)) mismatches.push('currentAuthority')
    if (highRisk && !approval.valid) mismatches.push('externalApproval')
    const authorized = !highRisk
    const valid = mismatches.length === 0 && authorized && trust.status === 'READY' && sensitivePreflight.length === 0
    return {
      command: 'route',
      action: 'validate',
      valid,
      executable: !highRisk && valid && Boolean(supplied.activeRunId),
      mode: selected.mode,
      trust,
      mismatches: unique(mismatches),
      sensitiveGitPreflight: { passed: sensitivePreflight.length === 0, violations: sensitivePreflight },
      externalApproval: highRisk ? { valid: approval.valid, reason: approval.valid ? null : approval.reason, providerKeyId: approval.providerKeyId || null } : { required: false },
      warning: 'Standalone v1 never makes a high-risk route executable; the route HMAC is only a staleness binding and Agent-reported authority is historical data.',
      exitCode: valid && supplied.activeRunId ? 0 : valid ? 6 : 4
    }
  }
  const trust = classifyTrust(bundle, current.observation, current.paths)
  const activeRunId = args.run && args.run !== true ? String(args.run) : null
  let run = null
  if (activeRunId) {
    assert(bundle.state.activeRuns.some((item) => item.runId === activeRunId), `Run ${activeRunId} is not active in this context`, 'RUN_NOT_ACTIVE_IN_CONTEXT')
    run = validateRunSession(current.paths, activeRunId, args, { allowDisconnected: true }).run
  }
  const selected = selectMode(trust, bundle.state, signals, activeRunId)
  const currentAuthority = Boolean(args['current-session-authority'])
  const highRisk = selected.mode === 'release-with-provenance'
  const approval = highRisk ? externalApprovalStatus(current.paths, bundle, current.observation, run, signals, authority, args) : { valid: true }
  const approvalBinding = approval.valid && highRisk ? {
    approvalId: approval.approvalId,
    providerFingerprint: approval.providerFingerprint,
    providerKeyId: approval.providerKeyId,
    capabilityHash: approval.capabilityHash,
    operationScope: approval.operationScope,
    environment: approval.environment,
    expiresAt: approval.expiresAt
  } : null
  const payload = credentialPayload(bundle, current.observation, selected.mode, signals, authority, activeRunId, run?.sessionNonceHash || null, currentAuthority, keyId, approvalBinding)
  const authorized = !highRisk
  const executable = !highRisk && authorized && trust.status === 'READY' && Boolean(activeRunId) && sensitivePreflight.length === 0
  return {
    command: 'route',
    mode: selected.mode,
    reason: selected.reason,
    signals,
    trust,
    runId: activeRunId,
    credential: encodeRouteCredential(payload, key),
    credentialBindings: payload,
    sensitiveGitPreflight: { passed: sensitivePreflight.length === 0, violations: sensitivePreflight },
    executable,
    authority: highRisk ? {
      status: authorized ? 'trusted-host-approval-verified' : 'standalone-high-risk-execution-disabled',
      historicalRecordsGrantAuthority: false
    } : { status: 'not-required-for-route', historicalRecordsGrantAuthority: false },
    externalApproval: highRisk ? { valid: approval.valid, reason: approval.valid ? null : approval.reason, providerKeyId: approval.providerKeyId || null } : { required: false },
    warning: 'Standalone v1 never makes a high-risk route executable; the route HMAC is only a staleness binding and Agent-reported authority is historical data.',
    exitCode: executable ? 0 : highRisk && !authorized ? 5 : trust.status !== 'READY' ? 3 : 6
  }
}

export function checkpointCommand(args) {
  const runId = required(args, 'run')
  const type = required(args, 'event')
  const summary = required(args, 'summary')
  assert(EVENT_TYPES.has(type) && !['session-start', 'session-finish'].includes(type), `Unsupported checkpoint event ${type}`, 'EVENT_TYPE_INVALID')
  const current = observe(args)
  return withStateLock(current.paths, () => {
    const bundle = loadState(current.paths)
    assert(bundle, 'Repository is not registered', 'STATE_UNMANAGED')
    assertIdentity(bundle, current.observation)
    assert(bundle.state.activeRuns.some((item) => item.runId === runId), `Run ${runId} is not active in this context`, 'RUN_NOT_ACTIVE_IN_CONTEXT')
    validateRunSession(current.paths, runId, args)
    if (args['route-token'] && args['route-token'] !== true) {
      const routeEvent = args['route-event'] && args['route-event'] !== true
        ? String(args['route-event'])
        : args['event-type'] && args['event-type'] !== true
          ? String(args['event-type'])
          : required(args, 'route-event', '--route-event is required when a route token is supplied')
      const validation = routeCommand({ ...args, event: routeEvent, validate: String(args['route-token']) })
      assert(validation.valid && validation.executable, 'Route token is stale, non-executable, or bound to another route/context', 'ROUTE_TOKEN_STALE')
    }
    const evidence = splitList(args.evidence)
    let eventEvidenceBindings = null
    if (evidence.length > 0) {
      try {
        eventEvidenceBindings = buildEvidenceBindings(current.paths, current.observation, runId, evidence)
      } catch {
        // Observations may record an unresolved locator, but such an event can
        // never support a trusted fact/claim until all references are sealed.
      }
    } else {
      eventEvidenceBindings = []
    }
    let files = splitList(args.files)
    const liveChanges = liveObservationChanges(bundle.state, current.observation)
    const bindingChanges = liveChanges.filter((item) => item === 'branch' || item === 'HEAD')
    const dirtyChanged = liveChanges.includes('working-tree fingerprint')
    if (bindingChanges.length > 0) {
      assert(args['reconcile-live-change'] && ['external-change', 'git'].includes(type), `Changing ${bindingChanges.join(', ')} requires an external-change/git checkpoint with --reconcile-live-change`, 'LIVE_CHANGE_RECONCILIATION_REQUIRED')
      required(args, 'reconcile-reason', '--reconcile-reason is required for branch or HEAD reconciliation')
      files = unique([...(bundle.state.observation.changedPaths || []), ...(current.observation.changedPaths || [])]).map((item) => item.replace(/\\/g, '/'))
    }
    if (dirtyChanged && !args['reconcile-live-change']) {
      assert(['change', 'attempt', 'external-change', 'git'].includes(type) && files.length > 0, 'A changed working tree must be attributed by a change/attempt/external-change/git event with --files, or explicitly reconciled', 'LIVE_CHANGE_ATTRIBUTION_REQUIRED')
      files = changedPathCoverage(bundle.state, current.observation, files)
    }
    if (dirtyChanged && args['reconcile-live-change']) {
      required(args, 'reconcile-reason', '--reconcile-reason is required with --reconcile-live-change')
      files = unique([...(bundle.state.observation.changedPaths || []), ...(current.observation.changedPaths || [])]).map((item) => item.replace(/\\/g, '/'))
    }

    const lifecycleEventType = args['event-type'] && args['event-type'] !== true ? String(args['event-type']) : null
    const lifecycleOutcome = args.outcome && args.outcome !== true ? String(args.outcome) : null
    const lifecycleAttribution = args.attribution && args.attribution !== true ? String(args.attribution) : 'unattributed'
    let lifecycleEvidenceValidation = { validated: false, records: [], observerVerified: false, observerType: null, observation: null }
    if (lifecycleEventType) {
      assert(LIFECYCLE_EVENTS.has(lifecycleEventType), `Invalid lifecycle event type ${lifecycleEventType}`, 'LIFECYCLE_EVENT_TYPE_INVALID')
      assert(lifecycleOutcome && LIFECYCLE_OUTCOMES.has(lifecycleOutcome), 'A lifecycle event requires a valid --outcome', 'LIFECYCLE_OUTCOME_REQUIRED')
      const requiredCheckpointType = ['commit', 'push'].includes(lifecycleEventType) ? 'git' : 'release'
      assert(type === requiredCheckpointType, `${lifecycleEventType} must be recorded as checkpoint event ${requiredCheckpointType}`, 'LIFECYCLE_EVENT_CHANNEL_INVALID')
      assert(['observed', 'unattributed'].includes(lifecycleAttribution), 'Standalone mode records high-risk lifecycle facts only as observed or unattributed; it never performs them', 'STANDALONE_HIGH_RISK_EXECUTION_DISABLED')
      if (lifecycleOutcome !== 'succeeded') assertResolvableEvidence(current.paths, current.observation, runId, evidence, `An ${lifecycleAttribution} lifecycle event`)
      lifecycleEvidenceValidation = assertLifecycleEventEvidence(current.paths, current.observation, bundle.state.observation, runId, evidence, lifecycleEventType, lifecycleOutcome, lifecycleAttribution, args)
    } else {
      assert(!lifecycleOutcome, '--outcome requires --event-type', 'LIFECYCLE_EVENT_TYPE_REQUIRED')
    }

    const architectureStatus = args['architecture-claim'] && args['architecture-claim'] !== true
      ? args['claim-status'] && args['claim-status'] !== true ? String(args['claim-status']) : 'inconclusive'
      : null
    let architectureEvidenceBindings = []
    if (architectureStatus) {
      assert(CLAIM_STATUSES.has(architectureStatus), `Invalid architecture claim status ${architectureStatus}`, 'CLAIM_STATUS_INVALID')
      if (architectureStatus === 'supported') {
        required(args, 'scope', 'A supported architecture claim requires --scope')
        assertResolvableEvidence(current.paths, current.observation, runId, evidence, 'A supported architecture claim')
        architectureEvidenceBindings = buildEvidenceBindings(current.paths, current.observation, runId, evidence)
      }
    }
    const hasHypothesisUpdate = Boolean((args.hypothesis && args.hypothesis !== true) || (args['hypothesis-id'] && args['hypothesis-id'] !== true))
    const hypothesisStatus = hasHypothesisUpdate && args['hypothesis-status'] && args['hypothesis-status'] !== true ? String(args['hypothesis-status']) : 'pending'
    if (hasHypothesisUpdate) {
      assert(['pending', 'confirmed', 'rejected', 'unresolved'].includes(hypothesisStatus), `Invalid hypothesis status ${hypothesisStatus}`, 'HYPOTHESIS_STATUS_INVALID')
      if (args['hypothesis-id'] && args['hypothesis-id'] !== true) assert(bundle.state.hypotheses.some((item) => item.taskId === bundle.state.task?.id && item.id === String(args['hypothesis-id'])), `Hypothesis ${args['hypothesis-id']} was not found in the current task`, 'HYPOTHESIS_NOT_FOUND')
      if (hypothesisStatus === 'confirmed') {
        assertResolvableEvidence(current.paths, current.observation, runId, evidence, 'A confirmed hypothesis')
        eventEvidenceBindings = buildEvidenceBindings(current.paths, current.observation, runId, evidence)
      }
    }
    if (args.fact && args.fact !== true) {
      assertResolvableEvidence(current.paths, current.observation, runId, evidence, 'A confirmed fact')
      eventEvidenceBindings = buildEvidenceBindings(current.paths, current.observation, runId, evidence)
    }
    if (args.pitfall && args.pitfall !== true) {
      assertResolvableEvidence(current.paths, current.observation, runId, evidence, 'A recorded pitfall')
      eventEvidenceBindings = buildEvidenceBindings(current.paths, current.observation, runId, evidence)
    }
    const resolveBlockerTarget = args['resolve-blocker'] && args['resolve-blocker'] !== true ? String(args['resolve-blocker']) : null
    if (resolveBlockerTarget) assert(bundle.state.blockers.some((item) => item.taskId === bundle.state.task?.id && (item.id === resolveBlockerTarget || item.statement === resolveBlockerTarget)), `Blocker ${resolveBlockerTarget} was not found in the current task`, 'BLOCKER_NOT_FOUND')
    if (args['resolve-trust']) {
      assert(!(args.blocker && args.blocker !== true), 'A checkpoint cannot add a blocker and resolve trust in the same event', 'TRUST_RESOLUTION_CONFLICT')
      required(args, 'reconcile-reason', '--reconcile-reason is required with --resolve-trust')
      required(args, 'authority', '--authority from the current user is required with --resolve-trust')
      assert(args['current-session-authority'], '--current-session-authority is required with --resolve-trust', 'CURRENT_AUTHORITY_REQUIRED')
      const remaining = bundle.state.blockers.filter((item) => item.taskId === bundle.state.task?.id && item.status === 'open' && item.id !== resolveBlockerTarget && item.statement !== resolveBlockerTarget)
      assert(remaining.length === 0, 'Open blockers prevent trust resolution', 'TRUST_RESOLUTION_BLOCKED')
      assertApprovedPrd(bundle.state.task)
      const prd = bundle.state.task?.prd
      assert(!prd || (existsSync(prd.path) && sha256File(prd.path) === prd.sha256), 'The recorded PRD must match its approved hash before trust can be resolved', 'PRD_HASH_CONFLICT')
    }
    let claimType = null
    let claimStatus = null
    let claimEvidenceBindings = []
    if (args['claim-type'] && args['claim-type'] !== true) {
      claimType = String(args['claim-type'])
      claimStatus = args['claim-status'] && args['claim-status'] !== true ? String(args['claim-status']) : 'inconclusive'
      assert(CLAIM_TYPES.has(claimType), `Invalid claim type ${claimType}`, 'CLAIM_TYPE_INVALID')
      assert(CLAIM_STATUSES.has(claimStatus), `Invalid claim status ${claimStatus}`, 'CLAIM_STATUS_INVALID')
      if (claimStatus === 'supported') {
        required(args, 'scope', 'A supported claim requires --scope')
        assertResolvableEvidence(current.paths, current.observation, runId, evidence, 'A supported claim')
        claimEvidenceBindings = buildEvidenceBindings(current.paths, current.observation, runId, evidence)
      }
      if (claimStatus === 'supported' && ['committed', 'pushed', 'deployed', 'accepted'].includes(claimType)) {
        assert(['committed', 'pushed'].includes(claimType), `Standalone mode cannot support a ${claimType} claim without a built-in live observer`, 'SUPPORTED_RELEASE_OBSERVER_UNAVAILABLE')
        const releaseSignal = { committed: 'commit', pushed: 'push' }[claimType]
        const releaseEvent = assertTypedReleaseEvidence(current.paths, current.observation, runId, evidence, claimType, releaseSignal)
        const releaseMetadata = releaseEvent.metadata || {}
        assert(String(releaseMetadata.scope || '') === String(args.scope || ''), `A supported ${claimType} claim scope must exactly match its typed event`, 'RELEASE_CLAIM_SCOPE_CONFLICT')
        assert(releaseMetadata.codeRevision === current.observation.head, `A supported ${claimType} claim must match the current code revision`, 'RELEASE_CLAIM_REVISION_CONFLICT')
        if (claimType === 'pushed') {
          const claimEnvironment = required(args, 'environment', `A supported ${claimType} claim requires --environment`)
          assert(releaseMetadata.environment === claimEnvironment, `A supported ${claimType} claim environment must exactly match its typed event`, 'RELEASE_CLAIM_ENVIRONMENT_CONFLICT')
        }
      }
    }
    const renewedLease = renewRunLease(current.paths, runId, {
      ttlSeconds: parseInteger(args['lease-seconds']) || undefined,
      source: args.source && args.source !== true ? String(args.source) : 'contextctl-checkpoint'
    })
    const eventResult = appendRunEvent(current.paths, runId, {
      type,
      summary,
      details: args.details && args.details !== true ? String(args.details) : null,
      actor: args.actor && args.actor !== true ? String(args.actor) : null,
      source: args.source && args.source !== true ? String(args.source) : null,
      files,
      command: args.command && args.command !== true ? String(args.command) : null,
      exitCode: parseInteger(args['exit-code']),
      next: args.next && args.next !== true ? String(args.next) : null,
      scope: args.scope && args.scope !== true ? String(args.scope) : null,
      evidence,
      metadata: Object.fromEntries(Object.entries({
        problemId: args['problem-id'],
        conclusion: args.conclusion,
        correctionOf: args['correction-of'],
        supersedes: args.supersedes,
        decisionId: args['decision-id'],
        attemptId: args['attempt-id'],
        changeOperation: args['change-operation'],
        beforeHash: args['before-hash'],
        afterHash: args['after-hash'],
        diffReference: args['diff-ref'],
        authorizationScope: args['authorization-scope'],
        authorizationGrantor: args.grantor,
        authorizationExpiresAt: args['expires-at'],
        authorizationOneShot: args['one-shot'] ? true : undefined,
        authorizationRevokedAt: args['revoked-at'],
        eventType: lifecycleEventType || undefined,
        observerType: lifecycleEvidenceValidation.observerType || undefined,
        observerVerified: lifecycleEventType ? lifecycleEvidenceValidation.observerVerified : undefined,
        observerObservation: lifecycleEvidenceValidation.observation || undefined,
        outcome: lifecycleOutcome || undefined,
        attribution: lifecycleEventType ? lifecycleAttribution : undefined,
        evidenceValidated: lifecycleEventType ? lifecycleEvidenceValidation.validated : undefined,
        evidenceKinds: lifecycleEvidenceValidation.records.length ? unique(lifecycleEvidenceValidation.records.map((item) => item.kind || 'attachment')) : undefined,
        eventEvidenceBindings: eventEvidenceBindings || undefined,
        scope: lifecycleEventType && args.scope && args.scope !== true ? String(args.scope) : undefined,
        environment: lifecycleEventType && args.environment && args.environment !== true ? String(args.environment) : undefined,
        codeRevision: lifecycleEventType ? current.observation.head : undefined,
        leaseExpiresAt: renewedLease.lease.expiresAt,
        reconciledBindings: liveChanges.length ? liveChanges : undefined,
        reconcileReason: liveChanges.length && args['reconcile-reason'] !== true ? args['reconcile-reason'] : undefined,
        reconciliationAttribution: liveChanges.length ? (args.attribution && args.attribution !== true ? args.attribution : 'current-run-reported') : undefined,
        priorObservation: liveChanges.length ? {
          branch: bundle.state.observation.branch,
          head: bundle.state.observation.head,
          statusFingerprint: bundle.state.observation.statusFingerprint
        } : undefined,
        liveObservation: liveChanges.length ? {
          branch: current.observation.branch,
          head: current.observation.head,
          statusFingerprint: current.observation.statusFingerprint
        } : undefined,
        trustResolutionReason: args['resolve-trust'] && args['reconcile-reason'] !== true ? args['reconcile-reason'] : undefined,
        trustResolutionAuthorityFingerprint: args['resolve-trust'] ? sha256(String(args.authority)) : undefined
      }).filter(([, value]) => value !== undefined))
    })
    let state = { ...bundle.state, stage: type, observation: compactObservation(current.observation) }
    state.claims = staleRevisionBoundClaims(
      state.claims,
      bundle.state.observation,
      current.observation,
      'The repository revision or working-tree fingerprint changed; prior evidence is not current for this checkout.',
      eventResult.event.eventId
    )
    state.architectureClaims = staleArchitectureClaims(
      state.architectureClaims,
      bundle.state.observation,
      current.observation,
      'The repository revision or working-tree fingerprint changed; prior architecture evidence is stale.',
      eventResult.event.eventId
    )
    state.confirmedFacts = staleDiagnosticRecords(
      state.confirmedFacts, state.task?.id, bundle.state.observation, current.observation,
      'The repository revision or working-tree fingerprint changed; prior facts are stale.', eventResult.event.eventId
    )
    state.hypotheses = staleDiagnosticRecords(
      state.hypotheses, state.task?.id, bundle.state.observation, current.observation,
      'The repository revision or working-tree fingerprint changed; prior confirmed hypotheses are unresolved.', eventResult.event.eventId, false, true
    )
    state.pitfalls = staleDiagnosticRecords(
      state.pitfalls, state.task?.id, bundle.state.observation, current.observation,
      'The repository revision or working-tree fingerprint changed; prior pitfall evidence is stale.', eventResult.event.eventId
    )
    const trustBefore = classifyTrust(bundle, current.observation, current.paths)
    state.trust = ['BLOCKED', 'CONFLICT'].includes(bundle.state.trust?.status)
      ? bundle.state.trust
      : ['STALE', 'BLOCKED', 'CONFLICT'].includes(trustBefore.status) && liveChanges.length === 0
        ? trustBefore
        : { status: 'READY', reasons: [] }
    if (args.fact && args.fact !== true) {
      state.confirmedFacts = appendStateRecord(state.confirmedFacts, {
        id: randomId('F'), taskId: state.task?.id || null, statement: String(args.fact), status: 'confirmed', scope: args.scope || null, evidence,
        evidenceBindings: eventEvidenceBindings || [], revision: current.observation.head, fingerprint: current.observation.statusFingerprint,
        observedAt: nowIso(), sourceEvent: eventResult.event.eventId
      })
    }
    if (hasHypothesisUpdate) {
      const status = hypothesisStatus
      const hypothesisId = args['hypothesis-id'] && args['hypothesis-id'] !== true ? String(args['hypothesis-id']) : null
      if (hypothesisId) {
        const prior = state.hypotheses.find((item) => item.id === hypothesisId)
        state.hypotheses = state.hypotheses.map((item) => item.id === hypothesisId ? {
          ...item,
          statement: args.hypothesis && args.hypothesis !== true ? String(args.hypothesis) : item.statement,
          status,
          evidence: evidence.length ? evidence : item.evidence,
          evidenceBindings: evidence.length ? (eventEvidenceBindings || []) : item.evidenceBindings,
          revision: evidence.length ? current.observation.head : item.revision,
          fingerprint: evidence.length ? current.observation.statusFingerprint : item.fingerprint,
          updatedAt: nowIso(),
          sourceEvent: eventResult.event.eventId,
          history: [...(item.history || []), { statement: item.statement, status: item.status, evidence: item.evidence || [], observedAt: item.updatedAt || item.observedAt, sourceEvent: item.sourceEvent }]
        } : item)
      } else {
        state.hypotheses = [...state.hypotheses, {
          id: randomId('H'), taskId: state.task?.id || null, statement: String(args.hypothesis), status, evidence,
          evidenceBindings: eventEvidenceBindings || [], revision: current.observation.head, fingerprint: current.observation.statusFingerprint,
          observedAt: nowIso(), sourceEvent: eventResult.event.eventId, history: []
        }]
      }
    }
    if (args.blocker && args.blocker !== true) {
      state.blockers = appendStateRecord(state.blockers, {
        id: randomId('ISSUE'), taskId: state.task?.id || null, statement: String(args.blocker), status: 'open', evidence, observedAt: nowIso(), sourceEvent: eventResult.event.eventId
      })
      state.trust = { status: 'BLOCKED', reasons: [String(args.blocker)] }
    }
    if (args['resolve-blocker'] && args['resolve-blocker'] !== true) {
      const target = String(args['resolve-blocker'])
      state.blockers = state.blockers.map((item) => item.taskId === state.task?.id && (item.id === target || item.statement === target) ? { ...item, status: 'resolved', resolvedAt: nowIso(), sourceEvent: eventResult.event.eventId } : item)
      if (!state.blockers.some((item) => item.taskId === state.task?.id && item.status === 'open')) state.trust = { status: 'BLOCKED', reasons: ['All current-task blockers are resolved, but --resolve-trust with a reconciliation reason is still required.'] }
    }
    if (args.pitfall && args.pitfall !== true) {
      state.pitfalls = appendStateRecord(state.pitfalls, {
        id: randomId('PIT'), taskId: state.task?.id || null, statement: String(args.pitfall), status: 'confirmed', evidence,
        evidenceBindings: eventEvidenceBindings || [], revision: current.observation.head, fingerprint: current.observation.statusFingerprint,
        observedAt: nowIso(), sourceEvent: eventResult.event.eventId
      })
    }
    if (args['architecture-claim'] && args['architecture-claim'] !== true) {
      state.architectureClaims = [...state.architectureClaims, {
        id: randomId('ARCH'), taskId: state.task?.id || null, statement: String(args['architecture-claim']), status: architectureStatus, scope: args.scope || null, evidence,
        evidenceBindings: architectureEvidenceBindings, revision: current.observation.head, fingerprint: current.observation.statusFingerprint, confidence: args.confidence || (architectureStatus === 'supported' ? 'agent-confirmed-with-cited-evidence' : 'unverified'), actor: args.actor || eventResult.event.actor, source: args.source || eventResult.event.source, supersedes: args.supersedes || null, observedAt: nowIso(), sourceEvent: eventResult.event.eventId
      }]
    }
    if (claimType) {
      state.claims = [...state.claims, {
        id: randomId('CLAIM'), taskId: state.task?.id || null, sourceRunId: runId, issueId: args['problem-id'] || null, type: claimType, status: claimStatus,
        statement: args['claim-statement'] && args['claim-statement'] !== true ? String(args['claim-statement']) : summary,
        scope: args.scope && args.scope !== true ? String(args.scope) : null,
        revision: current.observation.head,
        tree: current.observation.tree,
        statusFingerprint: current.observation.statusFingerprint,
        environment: args.environment && args.environment !== true ? String(args.environment) : 'local-unspecified',
        evidence,
        evidenceBindings: claimEvidenceBindings,
        actor: args.actor || eventResult.event.actor,
        source: args.source || eventResult.event.source,
        confidence: args.confidence && args.confidence !== true ? String(args.confidence) : null,
        supersedesClaimId: args.supersedes && args.supersedes !== true ? String(args.supersedes) : null,
        staleReason: claimStatus === 'stale' && args.details && args.details !== true ? String(args.details) : null,
        limits: args.limits && args.limits !== true ? String(args.limits) : null,
        observedAt: nowIso(),
        sourceEvent: eventResult.event.eventId
      }]
    }
    if (type === 'authorization') {
      state.authorityHistory = [...state.authorityHistory, {
        runId,
        text: args.details && args.details !== true ? String(args.details) : summary,
        source: args.source && args.source !== true ? String(args.source) : 'current-session-checkpoint',
        scope: args['authorization-scope'] && args['authorization-scope'] !== true ? String(args['authorization-scope']) : null,
        grantor: args.grantor && args.grantor !== true ? String(args.grantor) : 'user-unspecified',
        expiresAt: args['expires-at'] && args['expires-at'] !== true ? String(args['expires-at']) : 'end-of-current-conversation',
        oneShot: Boolean(args['one-shot']),
        revokedAt: args['revoked-at'] && args['revoked-at'] !== true ? String(args['revoked-at']) : null,
        recordedAt: nowIso(),
        historicalOnly: true
      }]
    }
    if (args['resolve-trust']) {
      state.trust = { status: 'READY', reasons: [] }
    }
    if (args.next && args.next !== true) state.nextObjective = String(args.next)
    const nextBundle = writeState(current.paths, bundle, state)
    return { command: 'checkpoint', event: eventResult.event, stateGeneration: nextBundle.state.generation, stateBindingHash: routeToken(nextBundle, current.observation, runId), routeRefreshRequired: true }
  })
}

export function mapCommand(args) {
  const current = observe(args)
  const runId = required(args, 'run', 'Refreshing a map requires --run from the current session')
  return withStateLock(current.paths, () => {
    const bundle = loadState(current.paths)
    assert(bundle, 'Repository is not registered', 'STATE_UNMANAGED')
    assertIdentity(bundle, current.observation)
    assert(bundle.state.activeRuns.some((item) => item.runId === runId), `Run ${runId} is not active in this context`, 'RUN_NOT_ACTIVE_IN_CONTEXT')
    validateRunSession(current.paths, runId, args)
    const trust = classifyTrust(bundle, current.observation, current.paths)
    const repairableMapOnly = trust.status === 'STALE' && trust.repairable === 'map-only'
    assert(trust.status === 'READY' || repairableMapOnly, `Repository map cannot refresh while trust is ${trust.status}: ${trust.reasons.join(' ')}`, 'TRUST_NOT_READY')
    const manifest = generateProjectMap(current.paths, current.observation)
    const state = {
      ...bundle.state,
      stage: 'map',
      observation: compactObservation(current.observation),
      map: mapReference(manifest, current.paths),
      trust: { status: 'READY', reasons: [] }
    }
    appendRunEvent(current.paths, runId, {
      type: 'observation', summary: 'Refreshed deterministic repository map.',
      details: `Inventory ${manifest.inventoryFingerprint}; ${manifest.counts.total} files.`,
      evidence: [manifest.pointer.manifest],
      metadata: { eventEvidenceBindings: buildEvidenceBindings(current.paths, current.observation, runId, [manifest.pointer.manifest]) }
    })
    const nextBundle = writeState(current.paths, bundle, state)
    return { command: 'map', map: state.map, stateGeneration: nextBundle.state.generation }
  })
}

function refreshEvidenceManifest(runEvidenceDir) {
  const records = []
  if (existsSync(runEvidenceDir)) {
    for (const entry of readdirSync(runEvidenceDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const metadata = path.join(runEvidenceDir, entry.name, 'evidence.json')
      if (existsSync(metadata)) records.push(readJson(metadata))
    }
  }
  const rows = records.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt)).map((item) => `| ${item.evidenceId} | ${item.kind || 'attachment'} | ${String(item.label).replace(/\|/g, '\\|').replace(/\s+/g, ' ')} | ${item.size} | \`${item.sha256}\` | ${item.storageMode} | ${item.modelAccess} |`).join('\n') || '| — | — | — | — | — | — | — |'
  atomicWrite(path.join(runEvidenceDir, 'MANIFEST.md'), `# Evidence Manifest\n\n> Derived from evidence.json records. Local storage permission is separate from model disclosure permission.\n\n| ID | Kind | Label | Bytes | SHA-256 | Storage | Model access |\n|---|---|---|---:|---|---|---|\n${rows}\n`)
}

export function evidenceCommand(args) {
  const current = observe(args)
  const runId = required(args, 'run')
  const sourceFile = path.resolve(required(args, 'file'))
  const evidenceKind = args.kind && args.kind !== true ? String(args.kind) : 'attachment'
  assert(EVIDENCE_KINDS.has(evidenceKind), `Unsupported evidence kind ${evidenceKind}`, 'EVIDENCE_KIND_INVALID')
  assert(existsSync(sourceFile) && lstatSync(sourceFile).isFile() && !lstatSync(sourceFile).isSymbolicLink(), `Evidence must be an existing regular non-symlink file: ${sourceFile}`, 'EVIDENCE_FILE_NOT_FOUND')
  return withStateLock(current.paths, () => {
    const bundle = loadState(current.paths)
    assert(bundle, 'Repository is not registered', 'STATE_UNMANAGED')
    assertIdentity(bundle, current.observation)
    assert(bundle.state.activeRuns.some((item) => item.runId === runId), `Run ${runId} is not active in this context`, 'RUN_NOT_ACTIVE_IN_CONTEXT')
    validateRunSession(current.paths, runId, args)
    const liveChanges = liveObservationChanges(bundle.state, current.observation)
    assert(liveChanges.length === 0, `Evidence capture cannot absorb live ${liveChanges.join(', ')} changes; checkpoint their attribution first`, 'LIVE_CHANGE_RECONCILIATION_REQUIRED')
    const modelAccess = Boolean(args['model-access'])
    if (modelAccess) validateReleaseCredential(args, 'model-access')
    const evidenceId = randomId('EVID')
    const evidenceDir = ensureDir(path.join(current.paths.evidence, runId, evidenceId))
    const destination = path.join(evidenceDir, path.basename(sourceFile))
    copyFileSync(sourceFile, destination)
    const metadata = {
      protocol: 'project-context/evidence/v1',
      evidenceId,
      runId,
      kind: evidenceKind,
      label: args.label && args.label !== true ? String(args.label) : path.basename(sourceFile),
      sourcePath: sourceFile,
      storedPath: destination,
      size: statSync(destination).size,
      sha256: sha256File(destination),
      capturedAt: nowIso(),
      storageMode: 'plaintext-local',
      producer: 'manual-contextctl-capture',
      producerBinding: null,
      modelAccess: modelAccess ? 'explicitly-authorized-current-session' : 'not-declared',
      modelAccessAuthorization: modelAccess ? {
        authorityFingerprint: sha256(String(args.authority)),
        currentSessionDeclared: true,
        routeSignal: 'model-access'
      } : null,
      warning: 'Local storage permission does not imply permission to transmit this evidence to a remote model.'
    }
    const metadataPath = path.join(evidenceDir, 'evidence.json')
    writeJsonAtomic(metadataPath, metadata)
    refreshEvidenceManifest(path.join(current.paths.evidence, runId))
    const evidenceRecordHash = sha256(stableJson(metadata))
    appendRunEvent(current.paths, runId, {
      type: modelAccess ? 'model-access' : 'observation',
      summary: modelAccess ? `Sensitive evidence selected for model access: ${metadata.label}` : `Stored local evidence: ${metadata.label}`,
      details: `${metadata.size} bytes; sha256 ${metadata.sha256}; storage ${metadata.storageMode}.`,
      evidence: [destination, metadataPath],
      metadata: {
        evidenceId,
        evidenceRecordHash,
        storedSha256: metadata.sha256,
        producer: metadata.producer,
        eventEvidenceBindings: [
          { reference: destination, kind: 'file', path: path.resolve(destination), sha256: sha256File(destination) },
          { reference: metadataPath, kind: 'file', path: path.resolve(metadataPath), sha256: sha256File(metadataPath) }
        ],
        ...(modelAccess ? { authorityFingerprint: sha256(String(args.authority)), currentSessionAuthority: true, routeSignal: 'model-access' } : {})
      }
    })
    const nextBundle = writeState(current.paths, bundle, { ...bundle.state, observation: compactObservation(current.observation) })
    return { command: 'evidence', evidence: metadata, stateGeneration: nextBundle.state.generation }
  })
}

function walkRegularFiles(root, cursor = root, collected = []) {
  for (const entry of readdirSync(cursor, { withFileTypes: true })) {
    const absolute = path.join(cursor, entry.name)
    if (entry.isSymbolicLink()) {
      const error = new Error(`Transfer source contains a symbolic link: ${absolute}`)
      error.code = 'TRANSFER_SYMLINK_REJECTED'
      throw error
    }
    if (entry.isDirectory()) walkRegularFiles(root, absolute, collected)
    else if (entry.isFile()) collected.push(path.relative(root, absolute).replace(/\\/g, '/'))
  }
  return collected
}

function copyRegularTree(source, destination, options = {}) {
  ensureDir(destination)
  const files = walkRegularFiles(source).filter((relative) => !options.exclude?.(relative))
  for (const relative of files) {
    const target = path.join(destination, relative)
    ensureDir(path.dirname(target))
    copyFileSync(path.join(source, relative), target)
  }
  return files
}

function transferManifest(root, files) {
  return files.sort().map((relative) => {
    const file = path.join(root, relative)
    return { path: relative, size: statSync(file).size, sha256: sha256File(file) }
  })
}

function validateTransferManifest(root, entries) {
  const errors = []
  for (const entry of entries || []) {
    if (!entry.path || path.isAbsolute(entry.path) || entry.path.split(/[\\/]/).includes('..')) {
      errors.push(`Unsafe transfer path: ${entry.path}`)
      continue
    }
    const file = path.join(root, entry.path)
    if (!isWithin(file, root) || !existsSync(file) || !lstatSync(file).isFile()) {
      errors.push(`Missing transfer file: ${entry.path}`)
      continue
    }
    if (statSync(file).size !== entry.size || sha256File(file) !== entry.sha256) errors.push(`Transfer hash mismatch: ${entry.path}`)
  }
  return errors
}

function validateReleaseCredential(args, eventType) {
  const token = required(args, 'route-token', '--route-token from a current release route is required')
  assert(args.authority && args.authority !== true && args['current-session-authority'], 'Current-session authority text and --current-session-authority are required', 'CURRENT_AUTHORITY_REQUIRED')
  const result = routeCommand({ ...args, event: eventType, validate: token })
  assert(result.valid && result.executable && result.mode === 'release-with-provenance', 'Release route credential is invalid, non-executable, or has the wrong mode', 'ROUTE_CREDENTIAL_INVALID')
  return result
}

function verifyEvidenceArchive(paths) {
  const errors = []
  const checked = []
  if (!existsSync(paths.evidence)) return { errors, checked }
  for (const runEntry of readdirSync(paths.evidence, { withFileTypes: true })) {
    if (!runEntry.isDirectory() || runEntry.isSymbolicLink()) continue
    const runId = runEntry.name
    const runRoot = path.join(paths.evidence, runId)
    for (const evidenceEntry of readdirSync(runRoot, { withFileTypes: true })) {
      if (!evidenceEntry.isDirectory() || evidenceEntry.isSymbolicLink()) continue
      const metadataPath = path.join(runRoot, evidenceEntry.name, 'evidence.json')
      if (!existsSync(metadataPath)) {
        errors.push(`Evidence ${runId}/${evidenceEntry.name} is missing evidence.json.`)
        continue
      }
      try {
        const record = readJson(metadataPath)
        const recordErrors = validateEvidenceRecord(paths, runId, metadataPath, record)
        checked.push({ runId, evidenceId: evidenceEntry.name, sha256: record.sha256 || null, valid: recordErrors.length === 0 })
        for (const message of recordErrors) errors.push(`Evidence ${runId}/${evidenceEntry.name}: ${message}.`)
      } catch (error) {
        errors.push(`Evidence ${runId}/${evidenceEntry.name} metadata is unreadable: ${error.message}`)
      }
    }
  }
  return { errors, checked }
}

export function exportCommand(args) {
  const current = observe(args)
  const runId = required(args, 'run')
  const destination = canonicalPath(required(args, 'destination'))
  assert(args['acknowledge-sensitive-export'], '--acknowledge-sensitive-export is required', 'EXPORT_ACKNOWLEDGEMENT_REQUIRED')
  validateVaultLocation(destination, current.observation)
  assert(!isWithin(destination, current.paths.vault), 'Export destination must be outside the active vault', 'EXPORT_DESTINATION_UNSAFE')
  assert(!existsSync(destination), 'Export destination already exists', 'EXPORT_DESTINATION_EXISTS')
  return withStateLock(current.paths, () => {
    const bundle = loadState(current.paths)
    assert(bundle, 'Repository is not registered', 'STATE_UNMANAGED')
    assertIdentity(bundle, current.observation)
    assert(bundle.state.activeRuns.some((item) => item.runId === runId), `Run ${runId} is not active`, 'RUN_NOT_ACTIVE_IN_CONTEXT')
    validateRunSession(current.paths, runId, args)
    validateReleaseCredential(args, 'export')
    appendRunEvent(current.paths, runId, {
      type: 'release', summary: 'Started an explicitly authorized local context export.',
      details: String(args.authority), scope: destination,
      metadata: { eventType: 'export', outcome: 'started', currentSessionAuthority: true }
    })
    const temporary = `${destination}.partial-${process.pid}-${Date.now()}`
    try {
      const contextDestination = path.join(temporary, 'context')
      const copied = copyRegularTree(current.paths.context, contextDestination, {
        exclude: (relative) => relative.startsWith('locks/') || /(^|\/)\.[^/]+\.(?:tmp|recovery\.bak)$/.test(relative)
      })
      const files = transferManifest(contextDestination, copied)
      const manifest = {
        protocol: 'project-context/export/v1',
        exportId: randomId('EXPORT'),
        exportedAt: nowIso(),
        source: {
          repoId: current.observation.repoId,
          workspaceId: current.observation.workspaceId,
          contextId: current.observation.contextId,
          branch: current.observation.branch,
          head: current.observation.head,
          stateGeneration: bundle.state.generation,
          stateHash: bundle.pointer.sha256
        },
        authorization: { text: String(args.authority), currentSessionDeclared: true, runId },
        storage: 'plaintext-local-transfer',
        warning: 'This export may contain all locally archived sensitive content. It is not encrypted and is not uploaded automatically.',
        files
      }
      atomicWrite(path.join(temporary, 'EXPORT_MANIFEST.json'), stableJson(manifest))
      renameSync(temporary, destination)
      appendRunEvent(current.paths, runId, {
        type: 'release', summary: 'Completed an explicitly authorized local context export.',
        details: `Export ${manifest.exportId} contains ${files.length} files.`, scope: destination,
        evidence: [path.join(destination, 'EXPORT_MANIFEST.json')],
        metadata: { eventType: 'export', outcome: 'succeeded', exportId: manifest.exportId, fileCount: files.length }
      })
      const nextBundle = writeState(current.paths, bundle, { ...bundle.state, observation: compactObservation(current.observation) })
      return { command: 'export', destination, exportId: manifest.exportId, fileCount: files.length, stateGeneration: nextBundle.state.generation, uploaded: false, encrypted: false }
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true })
      if (existsSync(destination)) rmSync(destination, { recursive: true, force: true })
      appendRunEvent(current.paths, runId, {
        type: 'release', summary: 'Local context export failed and partial output was removed.',
        details: error.message, scope: destination,
        metadata: { eventType: 'export', outcome: 'failed', errorCode: error.code || 'ERROR' }
      })
      writeState(current.paths, bundle, bundle.state)
      throw error
    }
  })
}

export function importCommand(args) {
  const current = observe(args)
  const runId = required(args, 'run')
  const source = canonicalPath(required(args, 'source'))
  assert(args['acknowledge-untrusted-import'], '--acknowledge-untrusted-import is required', 'IMPORT_ACKNOWLEDGEMENT_REQUIRED')
  assert(existsSync(source) && statSync(source).isDirectory(), 'Import source is not a directory', 'IMPORT_SOURCE_INVALID')
  const manifestFile = path.join(source, 'EXPORT_MANIFEST.json')
  assert(existsSync(manifestFile), 'EXPORT_MANIFEST.json is missing', 'IMPORT_MANIFEST_MISSING')
  return withStateLock(current.paths, () => {
    const bundle = loadState(current.paths)
    assert(bundle, 'Repository is not registered', 'STATE_UNMANAGED')
    assertIdentity(bundle, current.observation)
    assert(bundle.state.activeRuns.some((item) => item.runId === runId), `Run ${runId} is not active`, 'RUN_NOT_ACTIVE_IN_CONTEXT')
    validateRunSession(current.paths, runId, args)
    validateReleaseCredential(args, 'import')
    const manifest = readJson(manifestFile)
    assert(manifest.protocol === 'project-context/export/v1', 'Unsupported export manifest', 'IMPORT_MANIFEST_INVALID')
    assert(manifest.source?.repoId === current.observation.repoId, 'Import belongs to another logical repository', 'IMPORT_REPOSITORY_CONFLICT')
    const contextSource = path.join(source, 'context')
    const manifestErrors = validateTransferManifest(contextSource, manifest.files)
    const actualTransferFiles = walkRegularFiles(source).filter((item) => item !== 'EXPORT_MANIFEST.json').map((item) => item.replace(/^context\//, '')).sort()
    const declaredTransferFiles = (manifest.files || []).map((item) => item.path).sort()
    if (stableJson(actualTransferFiles) !== stableJson(declaredTransferFiles)) manifestErrors.push('Transfer contains undeclared or missing files.')
    assert(manifestErrors.length === 0, manifestErrors.join('; '), 'IMPORT_INTEGRITY_FAILED')
    const importId = randomId('IMPORT')
    const destination = path.join(current.paths.imports, importId)
    assert(!existsSync(destination), 'Import destination collision', 'IMPORT_DESTINATION_EXISTS')
    try {
      copyRegularTree(source, destination)
      const importRecord = {
        importId,
        importedAt: nowIso(),
        sourceExportId: manifest.exportId,
        sourceRepoId: manifest.source.repoId,
        sourceWorkspaceId: manifest.source.workspaceId,
        sourceContextId: manifest.source.contextId,
        sourceStateHash: manifest.source.stateHash,
        path: destination,
        status: 'quarantined-untrusted-history',
        adoptedAsCurrentState: false,
        warning: 'Imported records are untrusted historical data and cannot authorize or overwrite current state.'
      }
      appendRunEvent(current.paths, runId, {
        type: 'release', summary: 'Imported a verified local archive into untrusted quarantine.',
        details: `Import ${importId} preserved export ${manifest.exportId} without adopting it as current state.`,
        scope: destination, evidence: [path.join(destination, 'EXPORT_MANIFEST.json')],
        metadata: { eventType: 'import', outcome: 'succeeded', importId, adopted: false }
      })
      const nextBundle = writeState(current.paths, bundle, { ...bundle.state, imports: [...(bundle.state.imports || []), importRecord] })
      return { command: 'import', import: importRecord, stateGeneration: nextBundle.state.generation }
    } catch (error) {
      rmSync(destination, { recursive: true, force: true })
      appendRunEvent(current.paths, runId, {
        type: 'release', summary: 'Local context import failed and partial output was removed.',
        details: error.message, scope: destination,
        metadata: { eventType: 'import', outcome: 'failed', errorCode: error.code || 'ERROR' }
      })
      writeState(current.paths, bundle, bundle.state)
      throw error
    }
  })
}

export function finishCommand(args) {
  const current = observe(args)
  const runId = required(args, 'run')
  const status = required(args, 'status')
  assert(FINISH_STATUSES.has(status), `Invalid finish status ${status}`, 'RUN_STATUS_INVALID')
  const summary = required(args, 'summary')
  return withStateLock(current.paths, () => {
    const bundle = loadState(current.paths)
    assert(bundle, 'Repository is not registered', 'STATE_UNMANAGED')
    assertIdentity(bundle, current.observation)
    assert(bundle.state.activeRuns.some((item) => item.runId === runId), `Run ${runId} is not active in this context`, 'RUN_NOT_ACTIVE_IN_CONTEXT')
    validateRunSession(current.paths, runId, args)
    const liveChanges = liveObservationChanges(bundle.state, current.observation)
    assert(liveChanges.length === 0, `Finish cannot absorb live ${liveChanges.join(', ')} changes; checkpoint them first`, 'LIVE_CHANGE_RECONCILIATION_REQUIRED')
    const trust = classifyTrust(bundle, current.observation, current.paths)
    if (status === 'completed') assert(trust.status === 'READY', `A completed run requires READY trust, not ${trust.status}`, 'TRUST_NOT_READY')
    const run = finishRun(current.paths, runId, status, current.observation, {
      summary,
      details: args.details && args.details !== true ? String(args.details) : null,
      next: args.next && args.next !== true ? String(args.next) : null
    })
    const state = {
      ...bundle.state,
      stage: `run-${status}`,
      observation: run.endObservation,
      activeRuns: bundle.state.activeRuns.filter((item) => item.runId !== runId),
      lastRun: { runId, status, summary, endedAt: run.endedAt, path: findRun(current.paths, runId)?.runMarkdown || null },
      nextObjective: args.next && args.next !== true ? String(args.next) : bundle.state.nextObjective,
      trust: status === 'blocked' ? { status: 'BLOCKED', reasons: [summary] } : trust
    }
    const nextBundle = writeState(current.paths, bundle, state)
    return { command: 'finish', runId, status, run: findRun(current.paths, runId)?.runMarkdown, stateGeneration: nextBundle.state.generation }
  })
}

function verifyGenerationChain(paths, pointer) {
  const files = readdirSync(paths.generations).filter((name) => /^generation-\d{8}(?:-[a-f0-9]{12})?\.json$/.test(name)).sort()
  const errors = []
  const warnings = []
  const byHash = new Map()
  for (const name of files) {
    const file = path.join(paths.generations, name)
    const raw = readFileSync(file, 'utf8')
    let state
    try {
      state = JSON.parse(raw)
    } catch {
      errors.push(`Invalid JSON generation: ${name}`)
      continue
    }
    const hash = sha256(raw)
    if (name.includes('-') && /-[a-f0-9]{12}\.json$/.test(name) && !name.endsWith(`-${hash.slice(0, 12)}.json`)) errors.push(`Filename hash mismatch in ${name}`)
    byHash.set(hash, { name, state })
  }
  if (files.length === 0) errors.push('No state generations exist.')
  const reachable = new Set()
  let cursorHash = pointer.sha256
  let expectedGeneration = pointer.generation
  while (cursorHash) {
    if (reachable.has(cursorHash)) {
      errors.push('Generation chain contains a cycle.')
      break
    }
    reachable.add(cursorHash)
    const entry = byHash.get(cursorHash)
    if (!entry) {
      errors.push(`Generation hash ${cursorHash} referenced by the active chain is missing.`)
      break
    }
    if (entry.state.generation !== expectedGeneration) errors.push(`Generation number mismatch in ${entry.name}`)
    cursorHash = entry.state.parentGenerationHash
    expectedGeneration -= 1
  }
  if (expectedGeneration !== 0 && errors.length === 0) errors.push('Generation chain did not terminate at generation 1.')
  const orphans = [...byHash.keys()].filter((hash) => !reachable.has(hash))
  if (orphans.length) warnings.push(`${orphans.length} orphan generation file(s) are preserved for diagnosis.`)
  return { files: files.length, reachable: reachable.size, orphans: orphans.length, errors, warnings }
}

function verifyAllRunRecords(paths) {
  const checks = []
  const errors = []
  if (!existsSync(paths.runs)) return { checks, errors }
  for (const month of readdirSync(paths.runs, { withFileTypes: true })) {
    if (!month.isDirectory()) continue
    const monthPath = path.join(paths.runs, month.name)
    for (const name of readdirSync(monthPath).filter((entry) => entry.endsWith('.json')).sort()) {
      const runId = name.replace(/\.json$/i, '')
      try {
        checks.push(verifyRunView(paths, runId))
      } catch (error) {
        checks.push({
          runId,
          status: 'corrupt',
          eventCount: null,
          eventSequence: null,
          sequencesValid: false,
          hashChainValid: false,
          runRecordValid: false,
          markdownPresent: existsSync(path.join(monthPath, `${runId}.md`)),
          markdownMatches: false,
          diagnostic: { code: error.code || 'RUN_RECORD_UNREADABLE', message: error.message }
        })
        errors.push(`Run ${runId} cannot be parsed or verified: ${error.code || 'RUN_RECORD_UNREADABLE'} ${error.message}`)
      }
    }
  }
  return { checks, errors }
}

export function verifyCommand(args) {
  requireUserConfirmedVault(args, 'verify')
  const current = observe(args)
  if (args['repair-views']) {
    return withStateLock(current.paths, () => {
      const lockedBundle = loadState(current.paths)
      assert(lockedBundle, 'Repository is not registered', 'STATE_UNMANAGED')
      assertIdentity(lockedBundle, current.observation)
      const runId = required(args, 'run', '--repair-views requires --run from the current session')
      assert(lockedBundle.state.activeRuns.some((item) => item.runId === runId), `Run ${runId} is not active in this context`, 'RUN_NOT_ACTIVE_IN_CONTEXT')
      validateRunSession(current.paths, runId, args)
      atomicWrite(current.paths.projectContext, renderProjectContext(lockedBundle.state, lockedBundle.pointer))
      const architecture = renderArchitectureView(current.paths, lockedBundle.state)
      if (architecture !== null) atomicWrite(current.paths.architecture, architecture)
      if (lockedBundle.state.map?.manifest && isWithin(lockedBundle.state.map.manifest, current.paths.context) && existsSync(lockedBundle.state.map.manifest)) {
        const manifest = readJson(lockedBundle.state.map.manifest)
        const versionedFileIndex = path.join(path.dirname(lockedBundle.state.map.manifest), manifest.files?.fileIndex || 'FILE_INDEX.md')
        if (isWithin(versionedFileIndex, path.dirname(lockedBundle.state.map.manifest)) && existsSync(versionedFileIndex)) atomicWrite(current.paths.fileIndex, readFileSync(versionedFileIndex, 'utf8'))
      }
      for (const entry of listRuns(current.paths)) refreshRunView(current.paths, entry.run.runId)
      appendRunEvent(current.paths, runId, {
        type: 'verification',
        summary: 'Regenerated derived vault views from machine authority.',
        details: 'PROJECT_CONTEXT, ARCHITECTURE, FILE_INDEX, and run Markdown were regenerated where their machine sources exist.',
        source: 'contextctl-verify-repair'
      })
      writeState(current.paths, lockedBundle, { ...lockedBundle.state, stage: 'verification-view-repair' })
      const verified = verifyCommand({ ...args, 'repair-views': false })
      return { ...verified, repairedViews: true }
    })
  }
  const bundle = loadState(current.paths)
  assert(bundle, 'Repository is not registered', 'STATE_UNMANAGED')
  assertIdentity(bundle, current.observation)
  const errors = []
  const warnings = []
  const derived = verifyDerivedViews(current.paths, bundle)
  if (!derived.projectContextPresent) errors.push('PROJECT_CONTEXT.md is missing.')
  if (!derived.projectContextMatches) errors.push('PROJECT_CONTEXT.md does not match machine state.')
  if (!derived.architectureExpected) errors.push('The versioned architecture source is missing or unsafe.')
  else if (!derived.architectureMatches) errors.push('ARCHITECTURE.md does not match its map generation and machine claims.')
  const chain = verifyGenerationChain(current.paths, bundle.pointer)
  errors.push(...chain.errors)
  warnings.push(...chain.warnings)
  const runVerification = verifyAllRunRecords(current.paths)
  const runChecks = runVerification.checks
  errors.push(...runVerification.errors)
  for (const run of runChecks) {
    if (!run.runRecordValid) errors.push(`Run ${run.runId} record hash is invalid.`)
    if (!run.sequencesValid) errors.push(`Run ${run.runId} has an invalid event sequence.`)
    if (!run.markdownPresent || !run.markdownMatches) errors.push(`Run ${run.runId} Markdown does not match machine events.`)
  }
  const evidenceCheck = verifyEvidenceArchive(current.paths)
  errors.push(...evidenceCheck.errors)
  const acl = inspectVaultAcl(current.paths.vault)
  if (process.platform === 'win32' && !acl.enforced) errors.push(`Vault ACL is not enforced: ${acl.warning || acl.status}`)
  else if (process.platform !== 'win32' && !acl.enforced) warnings.push(`Vault ACL enforcement is degraded on this platform: ${acl.warning || acl.status}`)
  for (const active of bundle.state.activeRuns) {
    const found = findRun(current.paths, active.runId)
    if (!found) errors.push(`Active run ${active.runId} is missing.`)
    else if (!['active', 'initializing'].includes(found.run.status)) errors.push(`Active run ${active.runId} is actually ${found.run.status}.`)
  }
  const mapFile = bundle.state.map?.manifest || null
  let map = null
  if (!mapFile || !existsSync(mapFile)) {
    warnings.push('The referenced versioned map manifest is missing.')
  } else {
    try {
      map = readJson(mapFile)
      const mapPointer = existsSync(current.paths.mapPointer) ? readJson(current.paths.mapPointer) : null
      if (!mapPointer || mapPointer.versionId !== map.versionId || mapPointer.manifestSha256 !== sha256(stableJson(map))) errors.push('Map pointer does not match the versioned manifest.')
      for (const [key, fileName] of Object.entries(map.files || {})) {
        const artifact = path.join(path.dirname(mapFile), fileName)
        if (!isWithin(artifact, path.dirname(mapFile)) || !existsSync(artifact)) errors.push(`Versioned map artifact is missing or unsafe: ${key}`)
        else if (map.artifactHashes?.[key] !== sha256File(artifact)) errors.push(`Versioned map artifact hash mismatch: ${key}`)
      }
      const versionedFileIndex = path.join(path.dirname(mapFile), map.files?.fileIndex || 'FILE_INDEX.md')
      if (existsSync(versionedFileIndex)) {
        const currentFileIndex = existsSync(current.paths.fileIndex) ? readFileSync(current.paths.fileIndex, 'utf8') : ''
        if (currentFileIndex !== readFileSync(versionedFileIndex, 'utf8')) errors.push('FILE_INDEX.md does not match the versioned map artifact.')
      }
      if (bundle.state.map?.inventoryFingerprint !== map.inventoryFingerprint) errors.push('State map reference does not match MAP_MANIFEST.json.')
      if (map.repo.head !== current.observation.head || map.repo.statusFingerprint !== current.observation.statusFingerprint) errors.push('Repository map is stale for the live worktree and must be refreshed.')
    } catch {
      errors.push('MAP_MANIFEST.json is invalid JSON.')
    }
  }
  const trust = classifyTrust(bundle, current.observation, current.paths)
  const integrityValid = errors.length === 0
  if (trust.status !== 'READY') errors.push(`Trust is ${trust.status}: ${trust.reasons.join(' ')}`)
  const report = {
    command: 'verify',
    valid: integrityValid && trust.status === 'READY',
    integrityValid,
    trust,
    machineAuthority: { generation: bundle.state.generation, file: bundle.generationFile, sha256: bundle.pointer.sha256 },
    derived,
    generationChain: chain,
    runs: runChecks,
    evidence: evidenceCheck.checked,
    vaultAcl: acl,
    map: map ? { inventoryFingerprint: map.inventoryFingerprint, head: map.repo.head, statusFingerprint: map.repo.statusFingerprint } : null,
    errors: unique(errors),
    warnings: unique(warnings),
    captureLimitation: bundle.state.capture.warning,
    exitCode: integrityValid && trust.status === 'READY' ? 0 : 2
  }
  return report
}

export function doctorCommand(args) {
  requireUserConfirmedVault(args, 'doctor')
  const current = observe(args)
  let verification = null
  try {
    verification = verifyCommand(args)
  } catch (error) {
    verification = { valid: false, error: { code: error.code || 'ERROR', message: error.message } }
  }
  const permissions = inspectVaultAcl(current.paths.vault)
  return {
    command: 'doctor',
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    repository: { root: current.observation.root, branch: current.observation.branch, head: current.observation.head },
    vault: current.paths.vault,
    capabilities: {
      supported: ['Read-only Git observation', 'Vault generations', 'Run/event records', 'Derived Markdown', 'Deterministic file/source inventory', 'Local evidence attachments'],
      observable: ['Commands mediated by contextctl', 'Repository changes visible at the next checkpoint', 'Explicitly reported child-Agent and external operations'],
      degraded: ['Unwrapped tools and Git clients', 'Operations performed on another device without imported records', 'Hidden child-Agent lifecycle', 'Absolute authorship or truth from hashes alone']
    },
    privacy: {
      networkPolicy: 'no-vault-upload; optional explicit credential-free read-only git ls-remote for one allowlisted HTTPS/Git ref; local-file remotes stay local',
      remoteObservationRequiresOptIn: true,
      vaultMode: 'plaintext-local',
      warning: 'An Agent or remote model may transmit any vault content it is asked to read.',
      permissions
    },
    verification
  }
}

export const COMMANDS = {
  register: registerCommand,
  begin: beginCommand,
  resume: resumeCommand,
  route: routeCommand,
  checkpoint: checkpointCommand,
  map: mapCommand,
  evidence: evidenceCommand,
  export: exportCommand,
  import: importCommand,
  verify: verifyCommand,
  finish: finishCommand,
  doctor: doctorCommand
}

const helpText = (command, purpose, requiredOptions, optionalOptions, exits) => `contextctl ${command} — ${purpose}\n\nUsage:\n  contextctl ${command} --repo <path> --vault <path>${requiredOptions.length ? ` ${requiredOptions.map((item) => item.split('  ')[0]).join(' ')}` : ''} [options]\n\nRequired for this operation:\n${requiredOptions.length ? requiredOptions.map((item) => `  ${item}`).join('\n') : '  None beyond --repo and --vault.'}\n\nImportant options:\n${optionalOptions.map((item) => `  ${item}`).join('\n')}\n\nExit behavior:\n${exits.map((item) => `  ${item}`).join('\n')}\n\nUnknown or omitted safety-critical options are never inferred.\n`

export const COMMAND_HELP = {
  register: helpText('register', 'create first state, or refresh an existing state under its active session', [
    '--vault-confirmed-by-user  Required declaration that the current user selected this exact --vault path for this session.',
    '--task <title>  Required for a managed first registration.',
    '--prd-path <file> --prd-approval <approved|user-approved|accepted>  Required when recording a PRD.'
  ], [
    '--objective/--reason/--requirement/--prd-sections/--allowed/--prohibited  Task contract fields.',
    '--run <id> --session <token>  Mandatory when a state already exists.',
    '--transition-reason or --task-update-reason  Mandatory for the corresponding task revision.',
    'PRD revision reconciliation is deliberately refused here; use begin.'
  ], ['0 success.', '1 validation, identity, session, trust, or filesystem failure.']),
  begin: helpText('begin', 'create a new authenticated Agent run and return its bearer session token once', [
    '--vault-confirmed-by-user  Required declaration that the current user selected this exact --vault path for this session.'
  ], [
    '--task and task contract fields  Required if no task is registered.',
    '--recover <run> --recovery-reason <text> --authority <text> --current-session-authority  Supersede an active run without rewriting it.',
    '--recovered-session <token>  Optional proof of the old run token; never authorizes rewriting the old immutable run.',
    '--parent <run>|--parallel --parallel-reason <text>  Explicit ownership when another run is active; corrupt parent/recovery records are refused.',
    '--transition-reason|--task-update-reason plus --authority <text> --current-session-authority  Required to change an existing task.',
    '--reconcile-live-change --reconcile-reason <text>  Explicitly adopt observed Git drift.',
    '--reconcile-prd --prd-path <file> --prd-approval <approved> --task-update-reason <text> --authority <text> --current-session-authority  Explicit PRD revision.',
    '--lease-seconds <5..86400>  Run ownership lease; use adapter heartbeat to renew.',
    '--agent/--harness/--request/--next  Run metadata.'
  ], ['0 success; securely retain returned session token.', '1 any missing ownership, reconciliation, PRD, identity, or storage requirement.']),
  resume: helpText('resume', 'print a bounded Recovery Card without mutating state', [
    '--vault-confirmed-by-user  Required declaration that the current user selected this exact --vault path for this session.'
  ], ['--json  Emit the complete bounded card as JSON.'], ['0 READY or initially UNMANAGED.', '3 STALE, CONFLICT, or BLOCKED.']),
  route: helpText('route', 'select or validate one deterministic route bound to live state', [
    '--event <comma-separated-signals>  Required; validation recomputes the mode from these signals.'
  ], [
    '--run <id> --session <token>  Required for an executable ordinary route.',
    '--authority <reported-current-user-text> --current-session-authority  Recorded as history only; cannot enable a high-risk route.',
    '--validate <credential>  Authenticate and revalidate a prior HMAC credential.'
  ], ['0 executable ordinary route/credential.', '3 trust is not READY.', '4 credential invalid/stale.', '5 standalone high-risk execution is disabled.', '6 no authenticated run.']),
  checkpoint: helpText('checkpoint', 'append one typed immutable event and update scoped state', [
    '--run <id> --session <token> --event <type> --summary <text>'
  ], [
    '--files <csv>  Required to attribute working-tree changes unless explicitly reconciled.',
    '--reconcile-live-change --reconcile-reason <text>  Required for branch/HEAD or unattributed drift.',
    '--evidence <csv> --scope <text>  Required and resolvable for supported claims.',
    '--claim-type <layer> --claim-status <status> --route-token <token> --route-event <signal>  Claim/release gate.',
    '--event-type <commit|push|deploy|rollback|acceptance|delete|export|import|model-access> --outcome <planned|started|succeeded|failed|partial|cancelled|blocked-unauthorized|unknown>  Typed lifecycle metadata.',
    'Observed successful commit/push events require exact --scope, before/after identity where applicable, and an internal live Git observer; optional attachments are supplementary only.',
    'A push observation additionally requires --allow-remote-observation, an exact --remote and full --ref, and the derived git-push/git-remote scope and environment shown on mismatch; its live OID must match --after-hash.',
    'Standalone v1 rejects performed successes and observed succeeded deploy/rollback/acceptance/delete events; record failed, partial, blocked, or unknown instead.',
    '--hypothesis/--hypothesis-id/--hypothesis-status  Create or revise a stable hypothesis.',
    '--blocker/--resolve-blocker/--resolve-trust  Trust transitions are explicit.'
  ], ['0 event and state generation committed.', '1 invalid session, attribution, evidence, route, claim, or trust transition.']),
  map: helpText('map', 'refresh the deterministic versioned repository map', [
    '--run <id> --session <token>'
  ], ['Trust and live bindings must be READY/exact, except that an authenticated refresh may repair a sole stale-map snapshot after Git drift was already reconciled.'], ['0 map and state generation committed.', '1 non-map staleness, conflict, corruption, invalid session, or mapping failure.']),
  evidence: helpText('evidence', 'copy one regular local file into the plaintext local vault', [
    '--run <id> --session <token> --file <path>'
  ], [
    '--label <text>  Human label.',
    '--kind <attachment|command-output|manifest|remote-ref|deployment-response|health-check|user-confirmation|api-response|log|test-report>  Typed evidence kind (default attachment).',
    '--model-access  Disabled in standalone v1; local storage permission does not authorize model disclosure.'
  ], ['0 evidence hash and manifest recorded.', '1 unsafe file, drift, session, authority, or route failure.']),
  export: helpText('export', 'reserved plaintext local transfer (disabled in standalone v1; never uploads)', [
    '--run <id> --session <token> --destination <new-directory> --route-token <token> --authority <text> --current-session-authority --acknowledge-sensitive-export'
  ], ['High-risk routes are non-executable in standalone v1.'], ['1 standalone authorization boundary, route, destination, integrity, or filesystem failure; no export is created.']),
  import: helpText('import', 'reserved local archive import (disabled in standalone v1)', [
    '--run <id> --session <token> --source <export-directory> --route-token <token> --authority <text> --current-session-authority --acknowledge-untrusted-import'
  ], ['High-risk routes are non-executable in standalone v1.'], ['1 standalone authorization boundary, route, identity, manifest, or integrity failure; no import is adopted.']),
  verify: helpText('verify', 'validate generations, events, maps, derived views, live trust, and readiness', [
    '--vault-confirmed-by-user  Required declaration that the current user selected this exact --vault path for this session.'
  ], [
    '--repair-views --run <id> --session <token>  Rebuild derived vault views; repair is a write and requires a current session.'
  ], ['0 integrity valid and trust READY.', '2 integrity failure or trust not READY.', '1 identity/state/argument failure.']),
  finish: helpText('finish', 'close the authenticated run with a bounded handoff', [
    '--run <id> --session <token> --status <completed|partial|blocked> --summary <text>'
  ], ['--details <text> --next <text>  Handoff context. Live repository drift must be checkpointed first.'], ['0 run closed and state updated.', '1 session, drift, trust, or state failure.']),
  doctor: helpText('doctor', 'report protocol integrity, capture limitations, and local privacy posture', [
    '--vault-confirmed-by-user  Required declaration that the current user selected this exact --vault path for this session.'
  ], ['The suite never uploads vault data; only an explicitly opted-in push observer may run read-only git ls-remote.'], ['0 report produced.', '1 repository/vault discovery failure.'])
}

export const HELP = `contextctl — local project context and run protocol

Usage:
  contextctl <command> --repo <path> --vault <path> [options]

Commands:
  register    Create or refresh context state and deterministic project map.
  begin       Create a run before adopting the current task.
  resume      Print a bounded Recovery Card; does not mutate state.
  route       Return one deterministic mode and a state-bound credential.
  checkpoint  Append a typed event and update scoped state.
  map         Refresh the deterministic architecture/file inventory.
  evidence    Copy a local evidence file into the vault and record its hash.
  export      Reserved local transfer contract; disabled in standalone v1.
  import      Reserved local import contract; disabled in standalone v1.
  verify      Validate machine generations, run events, maps, and derived views.
  finish      Close a run as completed, partial, or blocked.
  doctor      Report integrity, privacy, and capture capability/degradation.

Common options:
  --repo <path>       Target Git worktree (default: current directory).
  --vault <path>      Required explicit user-selected local vault outside every Git repository; there is no default.
  --vault-confirmed-by-user  Required by resume/register/begin/verify/doctor after the current user selects the exact path; records a declaration, not cryptographic identity proof.
  --json              Emit JSON where a command also has a text view.

Examples:
  contextctl register --repo H:\\Project --vault <user-selected-absolute-path> --vault-confirmed-by-user --task "Fix upload" --requirement "Confirmed PRD section"
  contextctl resume --repo H:\\Project --vault <user-selected-absolute-path> --vault-confirmed-by-user
  contextctl begin --repo H:\\Project --vault <user-selected-absolute-path> --vault-confirmed-by-user --request "Current user request" --agent codex
  contextctl route --repo H:\\Project --vault <user-selected-absolute-path> --run RUN-... --session SESSION-... --event diagnose
  contextctl checkpoint --repo H:\\Project --vault <user-selected-absolute-path> --run RUN-... --session SESSION-... --event observation --summary "Observed failure" --fact "HTTP 413 only occurs at the proxy" --evidence EVID-...
  contextctl verify --repo H:\\Project --vault <user-selected-absolute-path> --vault-confirmed-by-user
  contextctl finish --repo H:\\Project --vault <user-selected-absolute-path> --run RUN-... --session SESSION-... --status partial --summary "Implementation complete; deployment not attempted" --next "Run mobile acceptance test"

Trust rules:
  Machine JSON is authoritative; Markdown is derived. Archived authorization is historical only.
  The CLI never uploads vault data. An explicitly opted-in push observer may query one exact Git remote ref.
  Content read by a remote Agent may leave the machine.
`
