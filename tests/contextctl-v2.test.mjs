import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { cli, createRepository, currentStateFiles, git, run, withFixture } from './run-tests.mjs'
import { assertRelinkSourceStable } from '../skills/project-context-protocol/scripts/lib/commands.mjs'

function localDate(timeZone = 'Asia/Shanghai') {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const values = Object.fromEntries(parts.filter((item) => item.type !== 'literal').map((item) => [item.type, item.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function statePointers(vault) {
  return currentStateFiles(vault).filter((file) => file.includes(`${path.sep}state${path.sep}current.json`))
}

function linkDirectoryOrSkip(context, target, link) {
  try {
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'UNKNOWN'].includes(error.code)) {
      context.skip(`Directory link creation is unavailable: ${error.code}`)
      return false
    }
    throw error
  }
}

test('route rejects unknown signals and accepts the adapter session-start signal', () => withFixture((fixture) => {
  cli('register', { args: { repo: fixture.repo, vault: fixture.vault, task: 'Preserve deterministic routing' } })
  const begun = cli('begin', { args: { repo: fixture.repo, vault: fixture.vault } }).json

  const typo = cli('route', {
    allowFailure: true,
    args: { repo: fixture.repo, vault: fixture.vault, run: begun.runId, session: begun.session, event: 'deply', json: true }
  })
  assert.equal(typo.status, 1)
  assert.equal(typo.json.error.code, 'ROUTE_SIGNAL_UNKNOWN')

  const empty = cli('route', {
    allowFailure: true,
    args: { repo: fixture.repo, vault: fixture.vault, run: begun.runId, session: begun.session, event: ', ,', json: true }
  })
  assert.equal(empty.status, 1)
  assert.equal(empty.json.error.code, 'ROUTE_SIGNAL_EMPTY')

  const routed = cli('route', {
    args: { repo: fixture.repo, vault: fixture.vault, run: begun.runId, session: begun.session, event: 'session-start' }
  }).json
  assert.equal(routed.mode, 'continue-current-task')
  assert.equal(routed.executable, true)
}))

test('new store interface requires an explicit layout before any state or run is written while legacy vault remains compatible', () => withFixture((fixture) => {
  const rejected = cli('register', {
    allowFailure: true,
    args: {
      repo: fixture.repo,
      store: fixture.vault,
      'store-confirmed-by-user': true,
      json: true,
      task: 'Do not infer the new record layout'
    }
  })
  assert.equal(rejected.status, 1)
  assert.equal(rejected.json.error.code, 'RECORD_LAYOUT_REQUIRED')
  assert.equal(existsSync(fixture.vault), false)

  const registered = cli('register', {
    args: { repo: fixture.repo, vault: fixture.vault, task: 'Keep the legacy vault interface compatible' }
  }).json
  assert.equal(registered.state.vaultSelection.recordLayout, 'vault')
  assert.equal(statePointers(fixture.vault).length, 1)
}))

test('Recovery Card byte accounting stays exact under oversized project and task inputs', () => withFixture((fixture) => {
  const oversized = '超长项目上下文字段'.repeat(300)
  writeFileSync(path.join(fixture.repo, 'package.json'), `${JSON.stringify({ name: 'oversized-profile-fixture', private: true, scripts: { enormous: `node -e "${'x'.repeat(40_000)}"` } }, null, 2)}\n`, 'utf8')
  git(fixture.repo, 'add', 'package.json')
  git(fixture.repo, 'commit', '-m', 'add oversized declared script')
  const common = {
    repo: fixture.repo,
    store: fixture.vault,
    'store-confirmed-by-user': true,
    'record-layout': 'markdown'
  }
  cli('register', {
    args: {
      ...common,
      task: oversized,
      objective: oversized,
      reason: oversized,
      requirement: oversized,
      next: oversized,
      'project-summary': oversized,
      'project-purpose': oversized,
      'project-audience': oversized
    }
  })
  const profile = cli('profile', { args: common }).json
  assert.ok(profile.profileBudget.actualBytes <= profile.profileBudget.maximumBytes)

  const resumed = cli('resume', { args: { ...common, json: true } }).json
  assert.equal(resumed.card.stateHash, profile.stateHash)
  const actualSerializedBytes = Buffer.byteLength(`${JSON.stringify(resumed.card)}\n`, 'utf8')
  assert.equal(resumed.card.budget.actualBytes, actualSerializedBytes)
  assert.ok(resumed.card.budget.actualBytes <= resumed.card.budget.maximumBytes)
  assert.ok(resumed.card.budget.estimatedTokens <= resumed.card.budget.maximumEstimatedTokens)
  assert.ok(resumed.card.task.title.length < oversized.length)
}))

test('markdown layout writes bounded records and freezes saved daily snapshots while live pagination remains explicit', () => withFixture((fixture) => {
  const common = {
    repo: fixture.repo,
    store: fixture.vault,
    'store-confirmed-by-user': true,
    'record-layout': 'markdown'
  }
  const registered = cli('register', {
    args: {
      ...common,
      task: 'Exercise portable project context',
      'project-purpose': 'Prove that a new Agent can recover bounded project facts.'
    }
  }).json
  assert.equal(registered.state.vaultSelection.recordLayout, 'markdown')

  const profile = cli('profile', { args: common }).json
  assert.equal(profile.recordLayout, 'markdown')
  assert.match(profile.projectId, /^project-/)
  assert.equal(existsSync(profile.profileMarkdown), true)
  assert.match(readFileSync(profile.profileMarkdown, 'utf8'), /Prove that a new Agent/)

  const begun = cli('begin', { args: common }).json
  cli('checkpoint', {
    args: {
      repo: fixture.repo,
      store: fixture.vault,
      'record-layout': 'markdown',
      run: begun.runId,
      session: begun.session,
      event: 'observation',
      summary: 'Recorded one deterministic v2 test event.'
    }
  })
  cli('checkpoint', {
    args: {
      ...common,
      run: begun.runId,
      session: begun.session,
      event: 'observation',
      summary: 'Recorded a second event before freezing the daily snapshot.'
    }
  })
  const dailySecret = 'sk-dailyCredential123456789'
  cli('checkpoint', {
    args: {
      ...common,
      run: begun.runId,
      session: begun.session,
      event: 'observation',
      summary: `token=${dailySecret} | injected |\n# fake heading`
    }
  })

  const resumed = cli('resume', { args: { ...common, json: true } }).json
  assert.equal(Object.hasOwn(resumed, 'text'), false)
  assert.equal(resumed.card.budget.truncated, false)
  assert.ok(resumed.card.budget.actualBytes <= resumed.card.budget.maximumBytes)
  assert.ok(resumed.card.budget.estimatedTokens <= resumed.card.budget.maximumEstimatedTokens)

  const date = localDate()
  const dailyArgs = { ...common, date, timezone: 'Asia/Shanghai', 'page-size': 1 }
  const first = cli('daily', { args: dailyArgs }).json
  assert.equal(first.saved, false)
  const saved = cli('daily', { args: { ...dailyArgs, save: true, run: begun.runId, session: begun.session } }).json
  assert.equal(saved.saved, true)
  assert.equal(saved.frozen, true)
  assert.equal(existsSync(saved.path), true)
  assert.equal(path.basename(saved.path), `${date}.md`)

  const pageTwo = cli('daily', {
    args: { ...dailyArgs, page: 2, save: true, run: begun.runId, session: begun.session }
  }).json
  assert.equal(pageTwo.saved, true)
  assert.equal(existsSync(pageTwo.path), true)
  assert.equal(path.basename(pageTwo.path), `${date}.page-2.md`)
  assert.notEqual(pageTwo.path, saved.path)
  assert.notDeepEqual(pageTwo.summary.events, saved.summary.events)
  const pageThree = path.join(path.dirname(saved.path), `${date}.page-3.md`)
  assert.equal(existsSync(pageThree), true)
  const sealedDailyFiles = readdirSync(path.dirname(saved.path))
    .filter((name) => name === `${date}.md` || new RegExp(`^${date}\\.page-\\d+\\.md$`).test(name))
    .map((name) => path.join(path.dirname(saved.path), name))
  const sealedDailyText = sealedDailyFiles.map((file) => readFileSync(file, 'utf8')).join('\n')
  assert.doesNotMatch(sealedDailyText, new RegExp(dailySecret))
  assert.match(sealedDailyText, /\[REDACTED(?:_CREDENTIAL)?\]/)
  assert.doesNotMatch(sealedDailyText, /\n# fake heading/)

  const laterMarker = 'This event happened only after the daily snapshot was frozen.'
  cli('checkpoint', {
    args: {
      ...common,
      run: begun.runId,
      session: begun.session,
      event: 'observation',
      summary: laterMarker
    }
  })

  const conflictingPageSize = cli('daily', {
    allowFailure: true,
    args: { ...common, date, timezone: 'Asia/Shanghai', 'page-size': 2, json: true }
  })
  assert.equal(conflictingPageSize.status, 1)
  assert.equal(conflictingPageSize.json.error.code, 'DAILY_PAGE_SIZE_CONFLICT')

  const frozen = cli('daily', { args: dailyArgs }).json
  assert.equal(frozen.frozen, true)
  assert.equal(frozen.source, 'saved-snapshot')
  assert.equal(frozen.snapshot, saved.snapshot)
  assert.doesNotMatch(frozen.markdown, new RegExp(laterMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  const live = cli('daily', { args: { ...common, date, timezone: 'Asia/Shanghai', page: 3, 'page-size': 2, live: true } }).json
  assert.equal(live.frozen, false)
  assert.equal(live.source, 'live-derived-preview')
  assert.equal(live.snapshot, null)
  assert.equal(live.savedSnapshotAvailable, true)
  assert.match(live.markdown, new RegExp(laterMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.notEqual(live.summary.snapshotHash, frozen.summary.snapshotHash)

  assert.equal(existsSync(path.join(path.dirname(profile.profileMarkdown), 'daily', `${date}.md`)), true)
  assert.equal(existsSync(path.join(path.dirname(profile.profileMarkdown), 'daily', `${date}.page-2.md`)), true)

  const validBeforeTamper = cli('verify', { args: common }).json
  assert.equal(validBeforeTamper.valid, true)
  writeFileSync(saved.path, `${readFileSync(saved.path, 'utf8')}\nTAMPERED DAILY VIEW\n`, 'utf8')
  const extraStrictPage = path.join(path.dirname(saved.path), `${date}.page-999.md`)
  const mirrorDaily = path.join(path.dirname(profile.profileMarkdown), 'daily')
  const extraMirrorPage = path.join(mirrorDaily, `${date}.page-999.md`)
  const orphanDaily = path.join(path.dirname(saved.path), '2099-01-01.md')
  const orphanMirror = path.join(mirrorDaily, '2099-01-01.md')
  writeFileSync(extraStrictPage, '# Forged extra daily page\n', 'utf8')
  writeFileSync(extraMirrorPage, '# Forged extra daily mirror\n', 'utf8')
  writeFileSync(orphanDaily, '# Orphan daily view without a snapshot\n', 'utf8')
  writeFileSync(orphanMirror, '# Orphan daily mirror without a snapshot\n', 'utf8')
  const tampered = cli('verify', { args: { ...common, json: true }, allowFailure: true })
  assert.equal(tampered.status, 2)
  assert.match(tampered.json.errors.join('\n'), /Daily view .* does not match its sealed snapshot/)
  assert.match(tampered.json.errors.join('\n'), /page-999\.md is not declared by its sealed snapshot/)
  assert.match(tampered.json.errors.join('\n'), /2099-01-01\.md has no valid sealed JSON snapshot/)
  const repaired = cli('verify', {
    args: { ...common, 'repair-views': true, run: begun.runId, session: begun.session }
  }).json
  assert.equal(repaired.valid, true)
  assert.equal(repaired.repairedViews, true)
  assert.doesNotMatch(readFileSync(saved.path, 'utf8'), /TAMPERED DAILY VIEW/)
  assert.equal(existsSync(extraStrictPage), false)
  assert.equal(existsSync(extraMirrorPage), false)
  assert.equal(existsSync(orphanDaily), false)
  assert.equal(existsSync(orphanMirror), false)
}))

test('hybrid portable mirror redacts credentials and verification detects mirror tampering', () => withFixture((fixture) => {
  const secret = 'sk-portableCredential123456789'
  const common = {
    repo: fixture.repo,
    store: fixture.vault,
    'store-confirmed-by-user': true,
    'record-layout': 'hybrid'
  }
  cli('register', {
    args: {
      ...common,
      task: `Keep ${secret} out of every portable mirror`,
      'project-purpose': `Exercise portable redaction for ${secret}`
    }
  })
  const profile = cli('profile', { args: common }).json
  const currentContext = path.join(path.dirname(profile.profileMarkdown), 'CURRENT_CONTEXT.md')
  const portableText = `${readFileSync(profile.profileMarkdown, 'utf8')}\n${readFileSync(currentContext, 'utf8')}`
  assert.doesNotMatch(portableText, new RegExp(secret))
  assert.match(portableText, /\[REDACTED_CREDENTIAL\]/)

  const valid = cli('verify', { args: common }).json
  assert.equal(valid.valid, true)

  writeFileSync(currentContext, `${readFileSync(currentContext, 'utf8')}\nTAMPERED PORTABLE MIRROR\n`, 'utf8')
  const tampered = cli('verify', { args: common, allowFailure: true })
  assert.equal(tampered.status, 2)
  assert.equal(tampered.json.valid, false)
  assert.match(tampered.json.errors.join('\n'), /Record-layout mirror CURRENT_CONTEXT\.md is missing or does not match machine state/)
}))

test('record-layout writes reject an external junction before advancing machine state', (context) => withFixture((fixture) => {
  const common = {
    repo: fixture.repo,
    store: fixture.vault,
    'store-confirmed-by-user': true,
    'record-layout': 'hybrid'
  }
  cli('register', { args: { ...common, task: 'Reject portable mirror path escapes' } })
  const begun = cli('begin', { args: common }).json
  const profile = cli('profile', { args: common }).json
  const portableRoot = path.dirname(profile.profileMarkdown)
  const externalPortable = path.join(fixture.root, 'external-portable-target')
  renameSync(portableRoot, externalPortable)
  try {
    symlinkSync(externalPortable, portableRoot, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'UNKNOWN'].includes(error.code)) {
      context.skip(`Directory link creation is unavailable: ${error.code}`)
      return
    }
    throw error
  }
  const externalContext = path.join(externalPortable, 'CURRENT_CONTEXT.md')
  const externalBefore = readFileSync(externalContext, 'utf8')
  const pointerFile = statePointers(fixture.vault)[0]
  const pointerBefore = readFileSync(pointerFile, 'utf8')
  const rejected = cli('checkpoint', {
    allowFailure: true,
    args: {
      ...common,
      run: begun.runId,
      session: begun.session,
      event: 'observation',
      summary: 'This must not cross the portable mirror junction.',
      json: true
    }
  })
  assert.equal(rejected.status, 1)
  assert.equal(rejected.json.error.code, 'VAULT_PATH_UNSAFE', JSON.stringify(rejected.json))
  assert.equal(readFileSync(pointerFile, 'utf8'), pointerBefore)
  assert.equal(readFileSync(externalContext, 'utf8'), externalBefore)
}))

test('machine generations reject an external junction before any state write or verification', (context) => withFixture((fixture) => {
  cli('register', { args: { repo: fixture.repo, vault: fixture.vault, task: 'Keep machine generations inside the selected store' } })
  const begun = cli('begin', { args: { repo: fixture.repo, vault: fixture.vault } }).json
  const pointerFile = statePointers(fixture.vault)[0]
  const generations = path.join(path.dirname(pointerFile), 'generations')
  const externalGenerations = path.join(fixture.root, 'external-machine-generations')
  renameSync(generations, externalGenerations)
  try {
    symlinkSync(externalGenerations, generations, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'UNKNOWN'].includes(error.code)) {
      context.skip(`Directory link creation is unavailable: ${error.code}`)
      return
    }
    throw error
  }
  const externalBefore = readdirSync(externalGenerations).sort()
  const rejected = cli('checkpoint', {
    allowFailure: true,
    args: {
      repo: fixture.repo,
      vault: fixture.vault,
      run: begun.runId,
      session: begun.session,
      event: 'observation',
      summary: 'This must not write through the generations junction.',
      json: true
    }
  })
  assert.equal(rejected.status, 1)
  assert.equal(rejected.json.error.code, 'VAULT_PATH_UNSAFE')
  assert.deepEqual(readdirSync(externalGenerations).sort(), externalBefore)
  const verification = cli('verify', { args: { repo: fixture.repo, vault: fixture.vault, json: true }, allowFailure: true })
  assert.notEqual(verification.status, 0)
  assert.equal(verification.json.error.code, 'VAULT_PATH_UNSAFE')
}))

test('state locks reject an external junction before creating a lock file', (context) => withFixture((fixture) => {
  cli('register', { args: { repo: fixture.repo, vault: fixture.vault, task: 'Keep state locks inside the selected store' } })
  const begun = cli('begin', { args: { repo: fixture.repo, vault: fixture.vault } }).json
  const pointerFile = statePointers(fixture.vault)[0]
  const contextRoot = path.dirname(path.dirname(pointerFile))
  const lockDirectory = path.join(contextRoot, 'locks')
  const externalLocks = path.join(fixture.root, 'external-state-locks')
  renameSync(lockDirectory, externalLocks)
  if (!linkDirectoryOrSkip(context, externalLocks, lockDirectory)) return
  const externalBefore = readdirSync(externalLocks).sort()

  const rejected = cli('checkpoint', {
    allowFailure: true,
    args: {
      repo: fixture.repo,
      vault: fixture.vault,
      run: begun.runId,
      session: begun.session,
      event: 'observation',
      summary: 'This must not create an external state lock.',
      json: true
    }
  })
  assert.equal(rejected.status, 1)
  assert.equal(rejected.json.error.code, 'VAULT_PATH_UNSAFE')
  assert.deepEqual(readdirSync(externalLocks).sort(), externalBefore)
  assert.equal(existsSync(path.join(externalLocks, 'state.lock')), false)
}))

test('run event directories reject an external junction before appending or verifying', (context) => withFixture((fixture) => {
  cli('register', { args: { repo: fixture.repo, vault: fixture.vault, task: 'Keep immutable events inside the selected store' } })
  const begun = cli('begin', { args: { repo: fixture.repo, vault: fixture.vault } }).json
  const pointerFile = statePointers(fixture.vault)[0]
  const contextRoot = path.dirname(path.dirname(pointerFile))
  const eventDirectory = path.join(contextRoot, 'events', begun.runId)
  const externalEvents = path.join(fixture.root, 'external-run-events')
  renameSync(eventDirectory, externalEvents)
  if (!linkDirectoryOrSkip(context, externalEvents, eventDirectory)) return
  const externalBefore = readdirSync(externalEvents).sort()

  const rejected = cli('checkpoint', {
    allowFailure: true,
    args: {
      repo: fixture.repo,
      vault: fixture.vault,
      run: begun.runId,
      session: begun.session,
      event: 'observation',
      summary: 'This must not append through an event junction.',
      json: true
    }
  })
  assert.equal(rejected.status, 1)
  assert.equal(rejected.json.error.code, 'VAULT_PATH_UNSAFE')
  assert.deepEqual(readdirSync(externalEvents).sort(), externalBefore)
  const verification = cli('verify', { args: { repo: fixture.repo, vault: fixture.vault, json: true }, allowFailure: true })
  assert.notEqual(verification.status, 0)
  assert.equal(verification.json.error.code, 'VAULT_PATH_UNSAFE')
}))

test('evidence run directories reject an external junction before copying attachments', (context) => withFixture((fixture) => {
  cli('register', { args: { repo: fixture.repo, vault: fixture.vault, task: 'Keep evidence inside the selected store' } })
  const begun = cli('begin', { args: { repo: fixture.repo, vault: fixture.vault } }).json
  const pointerFile = statePointers(fixture.vault)[0]
  const contextRoot = path.dirname(path.dirname(pointerFile))
  const evidenceRun = path.join(contextRoot, 'evidence', begun.runId)
  const externalEvidence = path.join(fixture.root, 'external-evidence')
  mkdirSync(externalEvidence, { recursive: true })
  if (!linkDirectoryOrSkip(context, externalEvidence, evidenceRun)) return
  const source = path.join(fixture.root, 'evidence-source.txt')
  writeFileSync(source, 'local evidence that must remain in the selected store\n', 'utf8')

  const rejectedRoute = cli('route', {
    allowFailure: true,
    args: {
      repo: fixture.repo,
      vault: fixture.vault,
      run: begun.runId,
      session: begun.session,
      event: 'commit',
      authority: 'The current test user authorizes only recording readiness checks.',
      'current-session-authority': true,
      json: true
    }
  })
  assert.equal(rejectedRoute.status, 1)
  assert.equal(rejectedRoute.json.error.code, 'VAULT_PATH_UNSAFE')

  const rejected = cli('evidence', {
    allowFailure: true,
    args: {
      repo: fixture.repo,
      vault: fixture.vault,
      run: begun.runId,
      session: begun.session,
      file: source,
      json: true
    }
  })
  assert.equal(rejected.status, 1)
  assert.equal(rejected.json.error.code, 'VAULT_PATH_UNSAFE')
  assert.deepEqual(readdirSync(externalEvidence), [])
}))

test('reserved evidence basenames are archived as independent payload files without overwrite', () => withFixture((fixture) => {
  cli('register', { args: { repo: fixture.repo, vault: fixture.vault, task: 'Preserve evidence payloads independently from metadata' } })
  const begun = cli('begin', { args: { repo: fixture.repo, vault: fixture.vault } }).json
  const sourceDirectory = path.join(fixture.root, 'reserved-evidence-sources')
  mkdirSync(sourceDirectory, { recursive: true })
  const sources = [
    { name: 'evidence.json', content: '{"customerPayload":true}\n' },
    { name: 'MANIFEST.md', content: '# Customer evidence payload\n' }
  ]

  for (const source of sources) {
    const sourcePath = path.join(sourceDirectory, source.name)
    writeFileSync(sourcePath, source.content, 'utf8')
    const captured = cli('evidence', {
      args: { repo: fixture.repo, vault: fixture.vault, run: begun.runId, session: begun.session, file: sourcePath }
    }).json.evidence
    assert.match(path.basename(captured.storedPath), /^payload(?:\.[a-z0-9]{1,12})?$/)
    assert.notEqual(path.basename(captured.storedPath).toLowerCase(), source.name.toLowerCase())
    assert.equal(readFileSync(captured.storedPath, 'utf8'), source.content)
    const metadataPath = path.join(path.dirname(captured.storedPath), 'evidence.json')
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
    assert.equal(metadata.originalFileName, source.name)
    assert.equal(metadata.storedPath, captured.storedPath)
    assert.equal(existsSync(path.join(path.dirname(path.dirname(captured.storedPath)), 'MANIFEST.md')), true)
  }

  const verification = cli('verify', { args: { repo: fixture.repo, vault: fixture.vault } }).json
  assert.equal(verification.valid, true)
}))

test('map version directories reject an external junction before reuse or verification', (context) => withFixture((fixture) => {
  const registered = cli('register', { args: { repo: fixture.repo, vault: fixture.vault, task: 'Keep map generations inside the selected store' } }).json
  const begun = cli('begin', { args: { repo: fixture.repo, vault: fixture.vault } }).json
  const versionDirectory = path.dirname(registered.recovery.map.manifest)
  const externalMap = path.join(fixture.root, 'external-map-version')
  renameSync(versionDirectory, externalMap)
  if (!linkDirectoryOrSkip(context, externalMap, versionDirectory)) return
  const externalBefore = readdirSync(externalMap).sort()
  const pointerFile = statePointers(fixture.vault)[0]
  const pointerBefore = readFileSync(pointerFile, 'utf8')

  const rejectedProfile = cli('profile', {
    allowFailure: true,
    args: { repo: fixture.repo, vault: fixture.vault, 'vault-confirmed-by-user': true, run: begun.runId, session: begun.session, save: true, json: true }
  })
  assert.equal(rejectedProfile.status, 1)
  assert.equal(rejectedProfile.json.error.code, 'VAULT_PATH_UNSAFE', JSON.stringify(rejectedProfile.json))
  assert.equal(readFileSync(pointerFile, 'utf8'), pointerBefore)
  assert.deepEqual(readdirSync(externalMap).sort(), externalBefore)

  const rejected = cli('map', {
    allowFailure: true,
    args: { repo: fixture.repo, vault: fixture.vault, run: begun.runId, session: begun.session, json: true }
  })
  assert.equal(rejected.status, 1)
  assert.equal(rejected.json.error.code, 'VAULT_PATH_UNSAFE', JSON.stringify(rejected.json))
  assert.deepEqual(readdirSync(externalMap).sort(), externalBefore)
  const verification = cli('verify', { args: { repo: fixture.repo, vault: fixture.vault, json: true }, allowFailure: true })
  assert.notEqual(verification.status, 0)
  assert.equal(verification.json.error.code, 'VAULT_PATH_UNSAFE')
}))

test('relink creates a new workspace generation and never adopts source active runs', () => withFixture((fixture) => {
  const sourceCommon = {
    repo: fixture.repo,
    store: fixture.vault,
    'store-confirmed-by-user': true,
    'record-layout': 'hybrid'
  }
  cli('register', { args: { ...sourceCommon, task: 'Continue on another device' } })
  const sourceRun = cli('begin', { args: sourceCommon }).json
  const profile = cli('profile', { args: sourceCommon }).json
  const sourcePointer = statePointers(fixture.vault)[0]
  writeFileSync(path.join(path.dirname(sourcePointer), 'generations', 'generation-99999999-deadbeefdead.json'), '{ malformed orphan', 'utf8')
  const unrelatedRepo = path.join(fixture.root, 'unrelated-repository')
  createRepository(unrelatedRepo)
  cli('register', {
    args: {
      repo: unrelatedRepo,
      store: fixture.vault,
      'store-confirmed-by-user': true,
      'record-layout': 'hybrid',
      task: 'Unrelated corrupted context must not block target relinking'
    }
  })
  const unrelatedPointer = statePointers(fixture.vault).find((file) => file !== sourcePointer)
  assert.ok(unrelatedPointer)
  const unrelatedCurrent = JSON.parse(readFileSync(unrelatedPointer, 'utf8'))
  writeFileSync(path.join(path.dirname(unrelatedPointer), 'generations', unrelatedCurrent.file), '{ malformed unrelated active generation', 'utf8')

  const clone = path.join(fixture.root, 'new-device-clone')
  run('git', ['clone', fixture.repo, clone])
  git(clone, 'config', 'user.name', 'Context Protocol Tests')
  git(clone, 'config', 'user.email', 'context-protocol-tests@example.invalid')

  const relinked = cli('relink', {
    args: {
      repo: clone,
      store: fixture.vault,
      'store-confirmed-by-user': true,
      'record-layout': 'hybrid',
      'project-id': profile.projectId,
      reason: 'Test a new-device cold start.',
      authority: 'The current test user authorizes relinking this fixture.',
      'current-session-authority': true
    }
  }).json
  assert.equal(relinked.projectId, profile.projectId)
  assert.equal(relinked.copiedActiveRuns, false)
  assert.notEqual(relinked.recovery.activeRuns?.some((item) => item.runId === sourceRun.runId), true)
  assert.ok(['READY', 'STALE'].includes(relinked.trust.status))
  assert.notEqual(relinked.sourceStateHash, null)
}))

test('relink rejects a junction in the selected source chain before creating target state', (context) => withFixture((fixture) => {
  const common = {
    repo: fixture.repo,
    store: fixture.vault,
    'store-confirmed-by-user': true,
    'record-layout': 'hybrid'
  }
  cli('register', { args: { ...common, task: 'Reject linked relink sources' } })
  const profile = cli('profile', { args: common }).json
  const sourcePointer = statePointers(fixture.vault)[0]
  const generations = path.join(path.dirname(sourcePointer), 'generations')
  const externalGenerations = path.join(fixture.root, 'external-generations')
  renameSync(generations, externalGenerations)
  try {
    symlinkSync(externalGenerations, generations, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'UNKNOWN'].includes(error.code)) {
      context.skip(`Directory link creation is unavailable: ${error.code}`)
      return
    }
    throw error
  }

  const clone = path.join(fixture.root, 'junction-relink-target')
  run('git', ['clone', fixture.repo, clone])
  git(clone, 'config', 'user.name', 'Context Protocol Tests')
  git(clone, 'config', 'user.email', 'context-protocol-tests@example.invalid')
  const pointersBefore = statePointers(fixture.vault).length
  const rejected = cli('relink', {
    allowFailure: true,
    args: {
      repo: clone,
      store: fixture.vault,
      'store-confirmed-by-user': true,
      'record-layout': 'hybrid',
      'project-id': profile.projectId,
      reason: 'Prove transferred source links fail closed.',
      authority: 'The current test user authorizes only a safe relink.',
      'current-session-authority': true,
      json: true
    }
  })
  assert.equal(rejected.status, 1)
  assert.equal(rejected.json.error.code, 'RELINK_SOURCE_CORRUPT')
  assert.equal(statePointers(fixture.vault).length, pointersBefore)
}))

test('relink refuses ambiguous project sources until an exact state hash is selected', () => withFixture((fixture) => {
  const common = {
    repo: fixture.repo,
    store: fixture.vault,
    'store-confirmed-by-user': true,
    'record-layout': 'hybrid'
  }
  cli('register', { args: { ...common, task: 'Select an exact transferred state' } })
  cli('begin', { args: common })
  const mainProfile = cli('profile', { args: common }).json
  const mainPointerFile = statePointers(fixture.vault).find((file) => JSON.parse(readFileSync(file, 'utf8')).sha256 === mainProfile.stateHash)
  assert.ok(mainPointerFile)

  git(fixture.repo, 'checkout', '-b', 'alternate-context')
  cli('register', { args: { ...common, task: 'Select an exact transferred state' } })
  const alternateProfile = cli('profile', { args: common }).json
  assert.equal(alternateProfile.projectId, mainProfile.projectId)
  assert.notEqual(alternateProfile.stateHash, mainProfile.stateHash)

  const clone = path.join(fixture.root, 'ambiguous-relink-target')
  run('git', ['clone', fixture.repo, clone])
  git(clone, 'config', 'user.name', 'Context Protocol Tests')
  git(clone, 'config', 'user.email', 'context-protocol-tests@example.invalid')
  const relinkArgs = {
    repo: clone,
    store: fixture.vault,
    'store-confirmed-by-user': true,
    'record-layout': 'hybrid',
    'project-id': mainProfile.projectId,
    reason: 'Select one of multiple transferred contexts deterministically.',
    authority: 'The current test user authorizes this fixture relink.',
    'current-session-authority': true
  }

  const ambiguous = cli('relink', { args: { ...relinkArgs, json: true }, allowFailure: true })
  assert.equal(ambiguous.status, 1)
  assert.equal(ambiguous.json.error.code, 'RELINK_SOURCE_AMBIGUOUS')

  const mainPointer = JSON.parse(readFileSync(mainPointerFile, 'utf8'))
  const mainCurrent = JSON.parse(readFileSync(path.join(path.dirname(mainPointerFile), 'generations', mainPointer.file), 'utf8'))
  const mainGenerations = path.join(path.dirname(mainPointerFile), 'generations')
  const mainParentFile = readdirSync(mainGenerations)
    .filter((name) => /^generation-\d{8}(?:-[a-f0-9]{12})?\.json$/.test(name))
    .map((name) => path.join(mainGenerations, name))
    .find((file) => sha256(readFileSync(file)) === mainCurrent.parentGenerationHash)
  assert.ok(mainParentFile)
  writeFileSync(mainParentFile, '{ corrupted unselected parent generation', 'utf8')

  const relinked = cli('relink', {
    args: { ...relinkArgs, 'source-state-hash': alternateProfile.stateHash }
  }).json
  assert.equal(relinked.sourceStateHash, alternateProfile.stateHash)
  assert.equal(relinked.candidateCount, 2)
  assert.equal(relinked.copiedActiveRuns, false)
}))

test('relink selection fails closed when its source identity or state changes after preview', () => {
  const projectId = 'project-stable-selection'
  const selectedHash = 'a'.repeat(64)
  const preview = { projectId, pointer: { sha256: selectedHash } }
  const changed = { projectId, pointer: { sha256: 'b'.repeat(64) } }
  const wrongProject = { projectId: 'project-replaced-source', pointer: { sha256: selectedHash } }

  assert.throws(
    () => assertRelinkSourceStable(preview, changed, projectId, selectedHash),
    (error) => error?.code === 'RELINK_SOURCE_CHANGED'
  )
  assert.throws(
    () => assertRelinkSourceStable(preview, wrongProject, projectId, selectedHash),
    (error) => error?.code === 'RELINK_SOURCE_CHANGED'
  )
})

test('map manifests bind generator and parser settings and are reusable only under that contract', () => withFixture((fixture) => {
  const registered = cli('register', { args: { repo: fixture.repo, vault: fixture.vault, task: 'Version the map generator' } }).json
  const manifest = JSON.parse(readFileSync(registered.recovery.map.manifest, 'utf8'))
  assert.equal(manifest.generator.version, 'project-context-map/2')
  assert.match(manifest.generator.settingsFingerprint, /^[a-f0-9]{64}$/)
  assert.match(manifest.sourceFingerprint, /^[a-f0-9]{64}$/)
  assert.equal(Object.hasOwn(manifest.source, 'elapsedMs'), false)
  assert.ok(Number.isInteger(manifest.source.inspectedBytes))

  const begun = cli('begin', { args: { repo: fixture.repo, vault: fixture.vault } }).json
  const refreshed = cli('map', { args: { repo: fixture.repo, vault: fixture.vault, run: begun.runId, session: begun.session } }).json
  assert.equal(refreshed.map.versionId, registered.recovery.map.versionId)
}))

test('identical checkouts produce byte-identical deterministic map manifests and artifacts across independent stores', () => withFixture((fixture) => {
  const firstVault = path.join(fixture.root, 'first-map-store')
  const secondVault = path.join(fixture.root, 'second-map-store')
  const first = cli('register', { args: { repo: fixture.repo, vault: firstVault, task: 'Compare deterministic map projections' } }).json
  const second = cli('register', { args: { repo: fixture.repo, vault: secondVault, task: 'Compare deterministic map projections' } }).json
  const firstRaw = readFileSync(first.recovery.map.manifest)
  const secondRaw = readFileSync(second.recovery.map.manifest)
  assert.equal(sha256(firstRaw), sha256(secondRaw))

  const firstManifest = JSON.parse(firstRaw)
  const secondManifest = JSON.parse(secondRaw)
  assert.deepEqual(secondManifest.artifactHashes, firstManifest.artifactHashes)
  assert.equal(secondManifest.sourceFingerprint, firstManifest.sourceFingerprint)
  for (const [key, relative] of Object.entries(firstManifest.files)) {
    const firstArtifact = readFileSync(path.join(path.dirname(first.recovery.map.manifest), relative))
    const secondArtifact = readFileSync(path.join(path.dirname(second.recovery.map.manifest), secondManifest.files[key]))
    assert.equal(sha256(firstArtifact), firstManifest.artifactHashes[key])
    assert.equal(sha256(secondArtifact), firstManifest.artifactHashes[key])
  }
}))

test('complete deterministic orphan maps are adopted while tampered orphans fail before state creation', () => withFixture((fixture) => {
  const sourceVault = path.join(fixture.root, 'orphan-source-store')
  const source = cli('register', { args: { repo: fixture.repo, vault: sourceVault, task: 'Create an orphan map fixture' } }).json
  const sourceVersion = path.dirname(source.recovery.map.manifest)
  const relativeVersion = path.relative(realpathSync.native(sourceVault), sourceVersion)
  const manifest = JSON.parse(readFileSync(source.recovery.map.manifest, 'utf8'))
  const bootstrapRepo = path.join(fixture.root, 'acl-bootstrap-repository')
  createRepository(bootstrapRepo)

  const completeVault = path.join(fixture.root, 'complete-orphan-store')
  cli('register', { args: { repo: bootstrapRepo, vault: completeVault, task: 'Initialize the selected context store ACL' } })
  const completeVersion = path.join(completeVault, relativeVersion)
  mkdirSync(path.dirname(completeVersion), { recursive: true })
  cpSync(sourceVersion, completeVersion, { recursive: true })
  const adopted = cli('register', { args: { repo: fixture.repo, vault: completeVault, task: 'Adopt the complete orphan map' } }).json
  assert.equal(adopted.recovery.map.versionId, manifest.versionId)
  assert.equal(sha256(readFileSync(adopted.recovery.map.manifest)), sha256(readFileSync(source.recovery.map.manifest)))
  assert.equal(existsSync(path.join(path.dirname(completeVersion), 'current.json')), true)

  const tamperedVault = path.join(fixture.root, 'tampered-orphan-store')
  cli('register', { args: { repo: bootstrapRepo, vault: tamperedVault, task: 'Initialize another selected context store ACL' } })
  const stateCountBeforeRejection = statePointers(tamperedVault).length
  const tamperedVersion = path.join(tamperedVault, relativeVersion)
  mkdirSync(path.dirname(tamperedVersion), { recursive: true })
  cpSync(sourceVersion, tamperedVersion, { recursive: true })
  writeFileSync(path.join(tamperedVersion, manifest.files.tree), 'tampered orphan tree\n', 'utf8')
  const rejected = cli('register', {
    allowFailure: true,
    args: { repo: fixture.repo, vault: tamperedVault, task: 'Reject a tampered orphan map', json: true }
  })
  assert.equal(rejected.status, 1)
  assert.equal(rejected.json.error.code, 'MAP_ORPHAN_CORRUPT')
  assert.equal(statePointers(tamperedVault).length, stateCountBeforeRejection)
  assert.equal(existsSync(path.join(path.dirname(tamperedVersion), 'current.json')), false)
}))

test('schema-v1 state verifies with a migration warning and the next authenticated write persists schema v2', () => withFixture((fixture) => {
  cli('register', { args: { repo: fixture.repo, vault: fixture.vault, task: 'Migrate a compatible legacy state' } })
  const statePointerFile = statePointers(fixture.vault)[0]
  const pointer = JSON.parse(readFileSync(statePointerFile, 'utf8'))
  const generationFile = path.join(path.dirname(statePointerFile), 'generations', pointer.file)
  const legacyState = JSON.parse(readFileSync(generationFile, 'utf8'))
  const priorFile = pointer.file
  const priorHash = pointer.sha256
  delete legacyState.schemaVersion
  const legacyRaw = `${JSON.stringify(legacyState, null, 2)}\n`
  pointer.sha256 = sha256(legacyRaw)
  pointer.file = `generation-${String(pointer.generation).padStart(8, '0')}-${pointer.sha256.slice(0, 12)}.json`
  const legacyGenerationFile = path.join(path.dirname(generationFile), pointer.file)
  writeFileSync(legacyGenerationFile, legacyRaw, 'utf8')
  rmSync(generationFile)
  writeFileSync(statePointerFile, `${JSON.stringify(pointer, null, 2)}\n`, 'utf8')
  const contextDirectory = path.dirname(path.dirname(statePointerFile))
  const projectContextFile = path.join(contextDirectory, 'PROJECT_CONTEXT.md')
  const compatibleContext = readFileSync(projectContextFile, 'utf8')
    .replaceAll(priorFile, pointer.file)
    .replaceAll(priorHash, pointer.sha256)
  writeFileSync(projectContextFile, compatibleContext, 'utf8')
  rmSync(path.join(contextDirectory, 'PROJECT_PROFILE.md'))

  const compatible = cli('verify', { args: { repo: fixture.repo, vault: fixture.vault, json: true } }).json
  assert.equal(compatible.valid, true)
  assert.match(compatible.warnings.join('\n'), /Schema-v1 state was loaded compatibly/)

  cli('begin', { args: { repo: fixture.repo, vault: fixture.vault } })
  const migratedPointer = JSON.parse(readFileSync(statePointerFile, 'utf8'))
  const migratedState = JSON.parse(readFileSync(path.join(path.dirname(statePointerFile), 'generations', migratedPointer.file), 'utf8'))
  assert.equal(migratedState.schemaVersion, 2)
  assert.equal(migratedState.migratedFromSchemaVersion, 1)
  assert.equal(existsSync(path.join(contextDirectory, 'PROJECT_PROFILE.md')), true)
  rmSync(path.join(contextDirectory, 'PROJECT_PROFILE.md'))
  const missingAfterMigration = cli('verify', { allowFailure: true, args: { repo: fixture.repo, vault: fixture.vault, json: true } })
  assert.equal(missingAfterMigration.status, 2)
  assert.match(missingAfterMigration.json.errors.join('\n'), /PROJECT_PROFILE\.md is missing/)
}))
