import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  cli,
  cliAsync,
  createRepository,
  currentStateFiles,
  findFiles,
  git,
  parseJsonFile,
  run,
  snapshotRepository,
  withFixture
} from './run-tests.mjs'
import { normalizeRemote } from '../skills/project-context-protocol/scripts/lib/git.mjs'
import { withStateLock } from '../skills/project-context-protocol/scripts/lib/storage.mjs'

function register(repo, vault) {
  return cli('register', { args: { repo, vault, task: 'Lifecycle security fixture' } }).json
}

function begin(repo, vault, extra = {}) {
  return cli('begin', { args: { repo, vault, request: 'Exercise lifecycle controls', agent: 'node-test', ...extra } }).json
}

function configureLocalOrigin(root, repo, name = 'origin') {
  const remote = path.join(root, `${name}.git`)
  run('git', ['init', '--bare', remote])
  git(repo, 'remote', 'add', name, remote)
  git(repo, 'push', '-u', name, 'main')
  return remote
}

function failureCode(result) {
  return result.json?.error?.code || null
}

function protocolMutationSnapshot(vault) {
  const protectedSegments = [
    `${path.sep}state${path.sep}`,
    `${path.sep}events${path.sep}`,
    `${path.sep}runs${path.sep}`
  ]
  return findFiles(vault, (absolute) => protectedSegments.some((segment) => absolute.includes(segment)))
    .map((file) => [path.relative(vault, file).replace(/\\/g, '/'), readFileSync(file).toString('base64')])
}

function runEvents(vault, runId) {
  return findFiles(vault, (absolute, name) => /^\d{6}\.json$/.test(name) && absolute.includes(`${path.sep}events${path.sep}${runId}${path.sep}`))
    .map(parseJsonFile)
}

function authoritativeState(vault) {
  return parseJsonFile(currentStateGenerationFile(vault))
}

function currentStateGenerationFile(vault) {
  const pointerFile = currentStateFiles(vault).find((file) => file.includes(`${path.sep}state${path.sep}current.json`))
  assert.ok(pointerFile, 'state/current.json must exist')
  const pointer = parseJsonFile(pointerFile)
  return path.join(path.dirname(pointerFile), 'generations', pointer.file)
}

function releaseRoute(repo, vault, run, authority, event = 'push') {
  return cli('route', {
    args: {
      repo,
      vault,
      run: run.runId,
      session: run.session,
      event,
      authority,
      'current-session-authority': true
    },
    allowFailure: true
  }).json
}

function tamperCredential(token, mutate) {
  const [body, signature] = token.split('.')
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  const changed = mutate(structuredClone(payload))
  const tamperedBody = Buffer.from(JSON.stringify(changed), 'utf8').toString('base64url')
  return `${tamperedBody}.${signature}`
}

test('map never follows a repository junction/symlink to read external sensitive content', (context) => {
  withFixture(({ root, repo, vault }) => {
    const external = path.join(root, 'external-sensitive-source')
    const secret = 'DO-NOT-ARCHIVE-SECRET-2b766669732c4e8f'
    mkdirSync(external, { recursive: true })
    writeFileSync(path.join(external, 'secret.js'), `export const credential = ${JSON.stringify(secret)}\n`, 'utf8')
    const linked = path.join(repo, 'linked-sensitive-source')
    try {
      symlinkSync(external, linked, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
        context.skip(`symbolic links unavailable on this host: ${error.code}`)
        return
      }
      throw error
    }
    const before = snapshotRepository(repo)
    const result = register(repo, vault)
    assert.equal(result.command, 'register')

    const archivedFiles = findFiles(vault, () => true)
    for (const file of archivedFiles) {
      const bytes = readFileSync(file)
      assert.equal(bytes.includes(Buffer.from(secret)), false, `external secret leaked into ${file}`)
    }
    assert.deepEqual(snapshotRepository(repo), before)
  })
})

test('verify detects versioned map artifact and derived architecture Markdown tampering', async (context) => {
  await context.test('versioned artifact hash mismatch', () => {
    withFixture(({ repo, vault }) => {
      const registered = register(repo, vault)
      const mapManifest = parseJsonFile(registered.map.manifest)
      const architecture = path.join(path.dirname(registered.map.manifest), mapManifest.files.architecture)
      writeFileSync(architecture, `${readFileSync(architecture, 'utf8')}\nTAMPERED VERSIONED MAP\n`, 'utf8')

      const verification = cli('verify', { args: { repo, vault }, allowFailure: true })
      assert.equal(verification.status, 2)
      assert.equal(verification.json.valid, false)
      assert.ok(verification.json.errors.some((message) => /artifact hash mismatch: architecture/i.test(message)))
    })
  })

  await context.test('derived Markdown mismatch', () => {
    withFixture(({ repo, vault }) => {
      register(repo, vault)
      const resumed = cli('resume', { args: { repo, vault, json: true } }).json
      const architecture = resumed.card.references.architecture
      writeFileSync(architecture, `${readFileSync(architecture, 'utf8')}\nTAMPERED DERIVED VIEW\n`, 'utf8')

      const verification = cli('verify', { args: { repo, vault }, allowFailure: true })
      assert.equal(verification.status, 2)
      assert.equal(verification.json.valid, false)
      assert.ok(verification.json.errors.some((message) => /ARCHITECTURE\.md does not match/i.test(message)))
    })
  })
})

test('state map snapshot fields must each match the integrity-checked versioned manifest', () => {
  withFixture(({ repo, vault }) => {
    register(repo, vault)
    const generation = currentStateGenerationFile(vault)
    const pointerFile = path.join(path.dirname(path.dirname(generation)), 'current.json')
    const originalGeneration = readFileSync(generation, 'utf8')
    const originalPointer = readFileSync(pointerFile, 'utf8')
    const cases = [
      ['versionId', 'MAP-forged'],
      ['head', '0'.repeat(40)],
      ['tree', '1'.repeat(40)],
      ['statusFingerprint', '2'.repeat(64)],
      ['inventoryFingerprint', '3'.repeat(64)]
    ]

    for (const [field, forged] of cases) {
      const state = JSON.parse(originalGeneration)
      state.map[field] = forged
      const raw = `${JSON.stringify(state, null, 2)}\n`
      writeFileSync(generation, raw, 'utf8')
      const pointer = JSON.parse(originalPointer)
      pointer.sha256 = createHash('sha256').update(raw, 'utf8').digest('hex')
      writeFileSync(pointerFile, `${JSON.stringify(pointer, null, 2)}\n`, 'utf8')

      const blocked = cli('resume', { args: { repo, vault, json: true }, allowFailure: true })
      assert.equal(blocked.status, 3, field)
      assert.equal(blocked.json.card.trust.status, 'BLOCKED', field)
      assert.match(blocked.json.card.trust.reasons.join(' '), new RegExp(`state map ${field} differs`, 'i'), field)

      writeFileSync(generation, originalGeneration, 'utf8')
      writeFileSync(pointerFile, originalPointer, 'utf8')
    }
  })
})

test('high-risk routing fails closed without an external provider while low-risk credentials still detect staleness', () => {
  withFixture(({ repo, vault }) => {
    register(repo, vault)
    const run = begin(repo, vault)
    const authority = 'Current user authorizes this test-only local release operation.'

    const unauthorized = cli('route', {
      args: { repo, vault, run: run.runId, session: run.session, event: 'push' },
      allowFailure: true
    })
    assert.equal(unauthorized.status, 5)
    assert.equal(unauthorized.json.mode, 'release-with-provenance')
    assert.equal(unauthorized.json.executable, false)
    assert.equal(unauthorized.json.authority.status, 'standalone-high-risk-execution-disabled')

    const before = protocolMutationSnapshot(vault)
    const authorityOnly = releaseRoute(repo, vault, run, authority)
    assert.equal(authorityOnly.executable, false)
    assert.equal(authorityOnly.authority.status, 'standalone-high-risk-execution-disabled')
    assert.equal(authorityOnly.externalApproval.valid, false)
    assert.match(authorityOnly.externalApproval.reason, /STANDALONE_HIGH_RISK_EXECUTION_DISABLED/)
    assert.deepEqual(protocolMutationSnapshot(vault), before)

    const lowRisk = cli('route', {
      args: { repo, vault, run: run.runId, session: run.session, event: 'verify' }
    }).json
    assert.equal(lowRisk.executable, true)

    const validation = cli('route', {
      args: {
        repo,
        vault,
        run: run.runId,
        validate: lowRisk.credential,
        session: run.session,
        event: 'verify'
      }
    }).json
    assert.equal(validation.valid, true)

    cli('checkpoint', {
      args: { repo, vault, run: run.runId, session: run.session, event: 'observation', summary: 'Advance state generation' }
    })
    const stale = cli('route', {
      args: {
        repo,
        vault,
        run: run.runId,
        validate: lowRisk.credential,
        session: run.session,
        event: 'verify'
      },
      allowFailure: true
    })
    assert.equal(stale.status, 4)
    assert.equal(stale.json.valid, false)
    assert.ok(stale.json.mismatches.includes('stateGeneration') || stale.json.mismatches.includes('stateHash'))
  })
})

test('export and import remain fail-closed when no external approval provider is configured', () => {
  withFixture(({ root, repo, vault }) => {
    register(repo, vault)
    const run = begin(repo, vault)
    const authority = 'Current user authorizes a local plaintext export/import test.'
    const release = releaseRoute(repo, vault, run, authority, 'export')
    const destination = path.join(root, 'authorized-export')
    assert.equal(release.executable, false)
    assert.match(release.externalApproval.reason, /STANDALONE_HIGH_RISK_EXECUTION_DISABLED/)

    const before = protocolMutationSnapshot(vault)
    const deniedExport = cli('export', {
      args: {
        repo,
        vault,
        run: run.runId,
        session: run.session,
        event: 'export',
        destination,
        'acknowledge-sensitive-export': true,
        'route-token': release.credential,
        authority,
        'current-session-authority': true,
        json: true
      },
      allowFailure: true
    })
    assert.notEqual(deniedExport.status, 0)
    assert.equal(failureCode(deniedExport), 'ROUTE_CREDENTIAL_INVALID')
    assert.equal(existsSync(destination), false)
    const importRoute = releaseRoute(repo, vault, run, authority, 'import')
    assert.equal(importRoute.executable, false)
    assert.match(importRoute.externalApproval.reason, /STANDALONE_HIGH_RISK_EXECUTION_DISABLED/)
    assert.deepEqual(protocolMutationSnapshot(vault), before)
  })
})

test('lock readers tolerate an in-progress exclusive owner write but preserve a persistently corrupt lock', async () => {
  await withFixture(async ({ root }) => {
    const locks = path.join(root, 'lock-protocol-fixture')
    mkdirSync(locks, { recursive: true })
    const lockFile = path.join(locks, 'state.lock')
    const childScript = String.raw`
const fs = require('node:fs')
const lockFile = process.argv[1]
const token = 'delayed-owner-' + process.pid
const descriptor = fs.openSync(lockFile, 'wx', 0o600)
process.stdout.write('READY\n')
process.stdin.once('data', () => {
  setTimeout(() => {
    const owner = { token, pid: process.pid, host: 'delayed-owner-host', acquiredAt: new Date().toISOString() }
    fs.writeFileSync(descriptor, JSON.stringify(owner) + '\n', 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    setTimeout(() => {
      try {
        const current = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
        if (current.token === token) fs.rmSync(lockFile, { force: true })
      } catch {}
      process.exit(0)
    }, 50)
  }, 25)
})
`
    const child = spawn(process.execPath, ['-e', childScript, lockFile], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    let childStderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { childStderr += chunk })
    const childExit = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`delayed lock owner exited ${code}: ${childStderr}`)))
    })
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`delayed lock owner did not become ready: ${childStderr}`)), 5_000)
      child.stdout.once('data', () => {
        clearTimeout(timeout)
        resolve()
      })
      child.once('error', reject)
    })

    child.stdin.end('publish-owner\n')
    let contentionError = null
    try {
      withStateLock({ locks }, () => {})
    } catch (error) {
      contentionError = error
    }
    assert.equal(contentionError?.code, 'STATE_LOCKED')
    await childExit

    writeFileSync(lockFile, '{persistently malformed lock\n', 'utf8')
    const corruptBytes = readFileSync(lockFile)
    assert.throws(
      () => withStateLock({ locks }, () => {}),
      (error) => error?.code === 'STATE_LOCK_CORRUPT'
    )
    assert.deepEqual(readFileSync(lockFile), corruptBytes)

    rmSync(lockFile, { force: true })
    const staleOwner = `${JSON.stringify({
      token: 'stale-owner-must-not-be-replaced',
      pid: 2_147_483_647,
      host: os.hostname(),
      acquiredAt: new Date(0).toISOString()
    })}\n`
    writeFileSync(lockFile, staleOwner, 'utf8')
    assert.throws(
      () => withStateLock({ locks }, () => {}),
      (error) => error?.code === 'STATE_LOCKED' && /explicit out-of-band recovery/i.test(error.message)
    )
    assert.equal(readFileSync(lockFile, 'utf8'), staleOwner)
  })
})

test('eight concurrent checkpoints never overwrite events and retries produce a complete valid chain', async () => {
  await withFixture(async ({ repo, vault }) => {
    register(repo, vault)
    const run = begin(repo, vault)
    const attempts = Array.from({ length: 8 }, (_unused, index) => ({
      index,
      summary: `concurrent-checkpoint-${index}`
    }))
    const firstWave = await Promise.all(attempts.map(({ summary }) => cliAsync('checkpoint', {
      args: { repo, vault, run: run.runId, session: run.session, event: 'observation', summary, json: true }
    })))

    const completed = new Set()
    for (const [index, response] of firstWave.entries()) {
      if (response.status === 0) completed.add(index)
      else assert.ok(['STATE_LOCKED', 'STATE_CAS_CONFLICT'].includes(failureCode(response)), response.stderr)
    }
    assert.ok(completed.size >= 1)

    for (const attempt of attempts) {
      if (completed.has(attempt.index)) continue
      let succeeded = false
      for (let retry = 0; retry < 4 && !succeeded; retry += 1) {
        const response = cli('checkpoint', {
          args: { repo, vault, run: run.runId, session: run.session, event: 'observation', summary: attempt.summary, json: true },
          allowFailure: true
        })
        if (response.status === 0) succeeded = true
        else assert.ok(['STATE_LOCKED', 'STATE_CAS_CONFLICT'].includes(failureCode(response)), response.stderr)
      }
      assert.equal(succeeded, true, `checkpoint ${attempt.index} did not succeed after bounded retries`)
    }

    const verification = cli('verify', { args: { repo, vault } }).json
    assert.equal(verification.valid, true)
    const runCheck = verification.runs.find((item) => item.runId === run.runId)
    assert.equal(runCheck.sequencesValid, true)
    assert.equal(runCheck.eventCount, 9)

    const eventFiles = findFiles(vault, (absolute, name) => /^\d{6}\.json$/.test(name) && absolute.includes(`${path.sep}events${path.sep}${run.runId}${path.sep}`))
    const summaries = eventFiles.map((file) => parseJsonFile(file).summary)
    for (const attempt of attempts) assert.equal(summaries.filter((summary) => summary === attempt.summary).length, 1)
  })
})

test('missing state pointer is recovered from the atomic backup when the contract backup exists', () => {
  withFixture(({ repo, vault }) => {
    register(repo, vault)
    const statePointer = currentStateFiles(vault).find((file) => file.includes(`${path.sep}state${path.sep}current.json`))
    assert.ok(statePointer)
    const original = readFileSync(statePointer)
    const recovery = path.join(path.dirname(statePointer), `.${path.basename(statePointer)}.recovery.bak`)
    renameSync(statePointer, recovery)
    assert.equal(existsSync(statePointer), false)

    const resumed = cli('resume', { args: { repo, vault, json: true } }).json
    assert.equal(resumed.card.trust.status, 'READY')
    assert.equal(existsSync(statePointer), true)
    assert.equal(existsSync(recovery), false)
    assert.deepEqual(readFileSync(statePointer), original)
  })
})

test('an active run cannot be routed without the begin-issued session token', () => {
  withFixture(({ repo, vault }) => {
    register(repo, vault)
    const run = begin(repo, vault)
    const rejected = cli('route', {
      args: { repo, vault, run: run.runId, event: 'diagnose', json: true },
      allowFailure: true
    })
    assert.notEqual(rejected.status, 0)
    assert.notEqual(rejected.json?.executable, true)
    assert.ok(['ARGUMENT_REQUIRED', 'RUN_SESSION_INVALID'].includes(failureCode(rejected)), rejected.stderr)
  })
})

test('STALE and BLOCKED contexts fail closed for routing and export', async (context) => {
  await context.test('STALE route and export are non-executable', () => {
    withFixture(({ root, repo, vault }) => {
      register(repo, vault)
      const staleFile = path.join(repo, 'src', 'index.js')
      writeFileSync(staleFile, `${readFileSync(staleFile, 'utf8')}\n// external change\n`, 'utf8')
      const staleRoute = cli('route', {
        args: { repo, vault, event: 'diagnose' },
        allowFailure: true
      })
      assert.notEqual(staleRoute.status, 0)
      assert.equal(staleRoute.json.trust.status, 'STALE')
      assert.equal(staleRoute.json.executable, false)

      writeFileSync(staleFile, readFileSync(staleFile, 'utf8').replace('\n// external change\n', ''), 'utf8')
      const run = begin(repo, vault)
      const authority = 'Current authority for a fail-closed export fixture.'
      const release = releaseRoute(repo, vault, run, authority, 'export')
      cli('finish', {
        args: {
          repo,
          vault,
          run: run.runId,
          session: run.session,
          status: 'partial',
          summary: 'Close the run before making the state stale'
        }
      })
      writeFileSync(staleFile, `${readFileSync(staleFile, 'utf8')}\n// stale after close\n`, 'utf8')
      const destination = path.join(root, 'stale-export-must-not-exist')
      const staleExport = cli('export', {
        args: {
          repo,
          vault,
          run: run.runId,
          session: run.session,
          event: 'export',
          destination,
          'acknowledge-sensitive-export': true,
          'route-token': release.credential,
          authority,
          'current-session-authority': true,
          json: true
        },
        allowFailure: true
      })
      assert.notEqual(staleExport.status, 0)
      assert.equal(existsSync(destination), false)
    })
  })

  await context.test('BLOCKED route and export are non-executable', () => {
    withFixture(({ root, repo, vault }) => {
      register(repo, vault)
      const run = begin(repo, vault)
      const authority = 'Current authority that must not override a blocked context.'
      const releaseBeforeBlock = releaseRoute(repo, vault, run, authority, 'export')
      cli('checkpoint', {
        args: {
          repo,
          vault,
          run: run.runId,
          session: run.session,
          event: 'observation',
          summary: 'Record a hard blocker',
          blocker: 'A required external fact is unavailable.'
        }
      })
      const blockedRoute = cli('route', {
        args: {
          repo,
          vault,
          run: run.runId,
          session: run.session,
          event: 'export',
          authority,
          'current-session-authority': true
        },
        allowFailure: true
      })
      assert.notEqual(blockedRoute.status, 0)
      assert.equal(blockedRoute.json.trust.status, 'BLOCKED')
      assert.equal(blockedRoute.json.executable, false)

      const destination = path.join(root, 'blocked-export-must-not-exist')
      const blockedExport = cli('export', {
        args: {
          repo,
          vault,
          run: run.runId,
          session: run.session,
          event: 'export',
          destination,
          'acknowledge-sensitive-export': true,
          'route-token': releaseBeforeBlock.credential,
          authority,
          'current-session-authority': true,
          json: true
        },
        allowFailure: true
      })
      assert.notEqual(blockedExport.status, 0)
      assert.equal(existsSync(destination), false)
    })
  })
})

test('a changed approved PRD hash makes routing non-executable until reconciliation', () => {
  withFixture(({ root, repo, vault }) => {
    const prd = path.join(root, 'approved-prd.md')
    writeFileSync(prd, '# Approved requirement\n\nOriginal semantics.\n', 'utf8')
    cli('register', {
      args: {
        repo,
        vault,
        task: 'Implement the approved PRD',
        'prd-path': prd,
        'prd-approval': 'user-approved'
      }
    })
    const run = begin(repo, vault)
    writeFileSync(prd, '# Approved requirement\n\nChanged semantics.\n', 'utf8')

    const routed = cli('route', {
      args: { repo, vault, run: run.runId, session: run.session, event: 'diagnose' },
      allowFailure: true
    })
    assert.notEqual(routed.status, 0)
    assert.equal(routed.json.executable, false)
    assert.ok(['STALE', 'CONFLICT', 'BLOCKED'].includes(routed.json.trust.status))
    assert.ok(routed.json.trust.reasons.some((reason) => /PRD hash changed/i.test(reason)))
  })
})

test('--model-access requires explicit current-session authority before evidence is copied', () => {
  withFixture(({ repo, vault, evidence }) => {
    register(repo, vault)
    const run = begin(repo, vault)
    const authority = 'Current authority for model disclosure, deliberately omitted from execution confirmation.'
    const modelRoute = releaseRoute(repo, vault, run, authority, 'model-access')
    const before = cli('resume', { args: { repo, vault, json: true } }).json.card.references.machineState
    const evidenceBefore = findFiles(vault, (_absolute, name) => name === 'evidence.json').length

    const rejected = cli('evidence', {
      args: {
        repo,
        vault,
        run: run.runId,
        session: run.session,
        file: evidence,
        'model-access': true,
        event: 'model-access',
        'route-token': modelRoute.credential,
        authority,
        json: true
      },
      allowFailure: true
    })
    assert.notEqual(rejected.status, 0)
    assert.match(failureCode(rejected) || rejected.stderr, /AUTHORITY/i)
    const after = cli('resume', { args: { repo, vault, json: true } }).json.card.references.machineState
    assert.equal(after, before)
    assert.equal(findFiles(vault, (_absolute, name) => name === 'evidence.json').length, evidenceBefore)
  })
})

test('supported claims fail closed when evidence or current authority is missing', async (context) => {
  const assertRejectedWithoutMutation = ({ repo, vault, run }, args) => {
    const beforeState = cli('resume', { args: { repo, vault, json: true } }).json.card.references.machineState
    const beforeEvents = findFiles(vault, (absolute, name) => /^\d{6}\.json$/.test(name) && absolute.includes(`${path.sep}events${path.sep}${run.runId}${path.sep}`)).length
    const rejected = cli('checkpoint', {
      args: {
        repo,
        vault,
        run: run.runId,
        session: run.session,
        event: 'verification',
        summary: 'Attempt a supported completion claim',
        'claim-type': 'verified',
        'claim-status': 'supported',
        scope: 'temporary fixture',
        json: true,
        ...args
      },
      allowFailure: true
    })
    assert.notEqual(rejected.status, 0)
    assert.equal(cli('resume', { args: { repo, vault, json: true } }).json.card.references.machineState, beforeState)
    assert.equal(findFiles(vault, (absolute, name) => /^\d{6}\.json$/.test(name) && absolute.includes(`${path.sep}events${path.sep}${run.runId}${path.sep}`)).length, beforeEvents)
    assert.equal(cli('verify', { args: { repo, vault } }).json.valid, true)
  }

  await context.test('evidence is mandatory even with current authority', () => {
    withFixture(({ repo, vault }) => {
      register(repo, vault)
      const run = begin(repo, vault)
      assertRejectedWithoutMutation({ repo, vault, run }, {
        authority: 'Current authority for a supported claim.',
        'current-session-authority': true
      })
    })
  })

  await context.test('current authority is mandatory even with evidence', () => {
    withFixture(({ repo, vault }) => {
      register(repo, vault)
      const run = begin(repo, vault)
      const authority = 'Current authority for a deployment claim, deliberately not confirmed at checkpoint.'
      const deployRoute = releaseRoute(repo, vault, run, authority, 'deploy')
      assertRejectedWithoutMutation({ repo, vault, run }, {
        'claim-type': 'deployed',
        evidence: 'source:src/index.js',
        'route-token': deployRoute.credential,
        authority
      })
    })
  })
})

test('register output never discloses raw historical authority text', () => {
  withFixture(({ repo, vault }) => {
    register(repo, vault)
    const rawAuthority = 'PRIVATE-AUTHORITY-HISTORY-1f8f1d32f15d4a72'
    const run = begin(repo, vault, { authority: rawAuthority })
    const refreshed = cli('register', {
      args: {
        repo,
        vault,
        run: run.runId,
        session: run.session,
        task: 'Lifecycle security fixture'
      }
    })
    assert.equal(refreshed.status, 0)
    assert.equal(refreshed.stdout.includes(rawAuthority), false)
    assert.equal(JSON.stringify(refreshed.json).includes(rawAuthority), false)
    assert.equal(refreshed.json.state?.authorityHistory?.some?.((entry) => entry.text === rawAuthority) ?? false, false)
  })
})

test('generic mapper recognizes Python and frontend structures without project-specific rules', () => {
  withFixture(({ root, vault }) => {
    const pythonRepo = path.join(root, 'python-project')
    const frontendRepo = path.join(root, 'frontend-project')
    createRepository(pythonRepo, {
      'pyproject.toml': '[project]\nname = "portable-python-fixture"\nversion = "0.1.0"\n',
      'requirements-dev.txt': 'pytest==8.0.0\n',
      'app/main.py': 'def main():\n    return "ok"\n'
    })
    createRepository(frontendRepo, {
      'frontend/src/components/Button.vue': '<template><button>OK</button></template>\n',
      'frontend/src/pages/Home.vue': '<template><main>Home</main></template>\n'
    })

    const python = register(pythonRepo, vault)
    const frontend = register(frontendRepo, vault)
    const pythonArchitecture = readFileSync(python.recovery.references.architecture, 'utf8')
    const frontendArchitecture = readFileSync(frontend.recovery.references.architecture, 'utf8')

    assert.match(pythonArchitecture, /pyproject\.toml/)
    assert.match(pythonArchitecture, /requirements-dev\.txt/)
    assert.match(frontendArchitecture, /frontend\/src\/components\/Button\.vue/)
    assert.match(frontendArchitecture, /user-interface layer candidate/)
  })
})

test('HMAC route credentials reject every protected binding when the body is tampered', async (context) => {
  await withFixture(async ({ repo, vault }) => {
    register(repo, vault)
    const run = begin(repo, vault)
    const routed = cli('route', {
      args: { repo, vault, run: run.runId, session: run.session, event: 'verify' }
    }).json
    const validationArgs = {
      repo,
      vault,
      run: run.runId,
      session: run.session,
      event: 'verify'
    }
    const valid = cli('route', { args: { ...validationArgs, validate: routed.credential } }).json
    assert.equal(valid.valid, true)

    const mutations = [
      ['body', (payload) => ({ ...payload, injected: 'untrusted' })],
      ['mode', (payload) => ({ ...payload, mode: 'continue-current-task' })],
      ['signals', (payload) => ({ ...payload, signals: ['deploy'] })],
      ['authority', (payload) => ({ ...payload, authorityFingerprint: '0'.repeat(64) })],
      ['run', (payload) => ({ ...payload, activeRunId: 'RUN-tampered' })],
      ['session', (payload) => ({ ...payload, sessionNonceHash: 'f'.repeat(64) })],
      ['generation', (payload) => ({ ...payload, stateGeneration: payload.stateGeneration + 1 })]
    ]
    for (const [label, mutate] of mutations) {
      await context.test(`${label} binding`, () => {
        const rejected = cli('route', {
          args: { ...validationArgs, validate: tamperCredential(routed.credential, mutate), json: true },
          allowFailure: true
        })
        assert.notEqual(rejected.status, 0, `${label} tampering must fail`)
        assert.equal(rejected.json?.valid === true || rejected.json?.executable === true, false)
        assert.equal(failureCode(rejected), 'ROUTE_CREDENTIAL_INVALID')
      })
    }

    const wrongAuthority = cli('route', {
      args: { ...validationArgs, authority: 'altered-low-risk-authority', validate: routed.credential },
      allowFailure: true
    })
    assert.notEqual(wrongAuthority.status, 0)
    assert.equal(wrongAuthority.json.valid, false)
    assert.ok(wrongAuthority.json.mismatches.includes('authorityFingerprint'))

    const wrongSession = cli('route', {
      args: { ...validationArgs, session: `${run.session}-altered`, validate: routed.credential, json: true },
      allowFailure: true
    })
    assert.notEqual(wrongSession.status, 0)
    assert.equal(failureCode(wrongSession), 'RUN_SESSION_INVALID')
  })
})

test('an initialized vault never recreates a deleted protocol signing key', async (context) => {
  await context.test('resume, verify, and checkpoint fail closed without state or event writes', () => {
    withFixture(({ repo, vault }) => {
      register(repo, vault)
      const run = begin(repo, vault)
      const key = path.join(vault, '.protocol-key')
      assert.ok(existsSync(key))
      const before = protocolMutationSnapshot(vault)
      rmSync(key)

      const attempts = [
        ['resume', { repo, vault, json: true }],
        ['verify', { repo, vault, json: true }],
        ['checkpoint', {
          repo,
          vault,
          run: run.runId,
          session: run.session,
          event: 'observation',
          summary: 'A missing protocol key must prevent this event',
          json: true
        }]
      ]
      for (const [command, args] of attempts) {
        const rejected = cli(command, { args, allowFailure: true })
        assert.notEqual(rejected.status, 0, `${command} must fail closed when the protocol key is missing`)
        if (rejected.json?.error) assert.equal(failureCode(rejected), 'PROTOCOL_KEY_MISSING')
        else if (command === 'resume') {
          assert.equal(rejected.json?.card?.trust?.status, 'BLOCKED')
          assert.match(rejected.json.card.trust.reasons.join(' '), /protocol signing key is missing/i)
        } else {
          assert.equal(rejected.json?.valid, false)
          assert.match((rejected.json?.errors || []).join(' '), /protocol signing key is missing/i)
        }
        assert.deepEqual(protocolMutationSnapshot(vault), before, `${command} must not write state, run, or event records`)
      }
      assert.equal(existsSync(key), false)
    })
  })

  await context.test('begin fails closed', () => {
    withFixture(({ repo, vault }) => {
      register(repo, vault)
      const key = path.join(vault, '.protocol-key')
      assert.ok(existsSync(key))
      const before = protocolMutationSnapshot(vault)
      rmSync(key)
      const rejected = cli('begin', {
        args: { repo, vault, request: 'Must not recreate a lost key', json: true },
        allowFailure: true
      })
      assert.notEqual(rejected.status, 0)
      assert.equal(failureCode(rejected), 'PROTOCOL_KEY_MISSING')
      assert.equal(existsSync(key), false)
      assert.deepEqual(protocolMutationSnapshot(vault), before)
    })
  })

  await context.test('route fails closed', () => {
    withFixture(({ repo, vault }) => {
      register(repo, vault)
      const run = begin(repo, vault)
      const key = path.join(vault, '.protocol-key')
      rmSync(key)
      const rejected = cli('route', {
        args: { repo, vault, run: run.runId, session: run.session, event: 'diagnose', json: true },
        allowFailure: true
      })
      assert.notEqual(rejected.status, 0)
      assert.equal(failureCode(rejected), 'PROTOCOL_KEY_MISSING')
      assert.equal(existsSync(key), false)
    })
  })
})

test('begin refuses to hide ownership when another run is already active', () => {
  withFixture(({ repo, vault }) => {
    register(repo, vault)
    const first = begin(repo, vault)
    const before = cli('resume', { args: { repo, vault, json: true } }).json
    const rejected = cli('begin', {
      args: { repo, vault, request: 'Ambiguous second run', json: true },
      allowFailure: true
    })
    assert.notEqual(rejected.status, 0)
    assert.equal(failureCode(rejected), 'ACTIVE_RUN_OWNERSHIP_REQUIRED')
    const after = cli('resume', { args: { repo, vault, json: true } }).json
    assert.equal(after.card.references.machineState, before.card.references.machineState)
    assert.deepEqual(after.card.activeRuns.map((item) => item.runId), [first.runId])
  })
})

test('map and verify --repair-views require an authenticated active run', () => {
  withFixture(({ repo, vault }) => {
    register(repo, vault)
    const run = begin(repo, vault)
    const beforeState = cli('resume', { args: { repo, vault, json: true } }).json.card.references.machineState
    const beforeMaps = findFiles(vault, (_absolute, name) => name === 'MAP_MANIFEST.json').length
    const attempts = [
      ['map without run', 'map', { repo, vault, json: true }],
      ['map without session', 'map', { repo, vault, run: run.runId, json: true }],
      ['repair without run', 'verify', { repo, vault, 'repair-views': true, json: true }],
      ['repair without session', 'verify', { repo, vault, run: run.runId, 'repair-views': true, json: true }]
    ]
    for (const [label, command, args] of attempts) {
      const rejected = cli(command, { args, allowFailure: true })
      assert.notEqual(rejected.status, 0, label)
      assert.ok(['ARGUMENT_REQUIRED', 'RUN_SESSION_INVALID'].includes(failureCode(rejected)), `${label}: ${rejected.stderr}`)
    }
    assert.equal(cli('resume', { args: { repo, vault, json: true } }).json.card.references.machineState, beforeState)
    assert.equal(findFiles(vault, (_absolute, name) => name === 'MAP_MANIFEST.json').length, beforeMaps)
  })
})

test('reconciled Git drift leaves only the map stale until an authenticated map refresh', () => {
  withFixture(({ repo, vault }) => {
    const registered = register(repo, vault)
    const runRecord = begin(repo, vault)
    const priorMap = registered.map

    writeFileSync(path.join(repo, 'src', 'index.js'), 'export function value() { return 2 }\n', 'utf8')
    git(repo, 'add', '--', 'src/index.js')
    git(repo, 'commit', '-m', 'advance fixture after map')
    const liveHead = git(repo, 'rev-parse', 'HEAD')

    const conflicted = cli('resume', { args: { repo, vault, json: true }, allowFailure: true })
    assert.equal(conflicted.status, 3)
    assert.equal(conflicted.json.card.trust.status, 'CONFLICT')
    assert.match(conflicted.json.card.trust.reasons.join(' '), /Live HEAD/i)

    cli('checkpoint', {
      args: {
        repo,
        vault,
        run: runRecord.runId,
        session: runRecord.session,
        event: 'external-change',
        summary: 'Reconcile an external commit before refreshing the map',
        'reconcile-live-change': true,
        'reconcile-reason': 'The external commit is now the intended live checkout.'
      }
    })

    const stale = cli('resume', { args: { repo, vault, json: true }, allowFailure: true })
    assert.equal(stale.status, 3)
    assert.equal(stale.json.card.trust.status, 'STALE')
    assert.equal(stale.json.card.trust.repairable, 'map-only')
    assert.match(stale.json.card.trust.reasons.join(' '), /repository map is stale/i)
    assert.equal(stale.json.card.map.versionId, priorMap.versionId)

    const ordinaryRoute = cli('route', {
      args: { repo, vault, run: runRecord.runId, session: runRecord.session, event: 'diagnose', json: true },
      allowFailure: true
    })
    assert.equal(ordinaryRoute.status, 3)
    assert.equal(ordinaryRoute.json.executable, false)
    assert.equal(ordinaryRoute.json.trust.status, 'STALE')

    const beforeRefresh = cli('verify', { args: { repo, vault, json: true }, allowFailure: true })
    assert.equal(beforeRefresh.status, 2)
    assert.equal(beforeRefresh.json.valid, false)
    assert.equal(beforeRefresh.json.trust.status, 'STALE')

    const refreshed = cli('map', {
      args: { repo, vault, run: runRecord.runId, session: runRecord.session, json: true }
    }).json
    assert.equal(refreshed.map.head, liveHead)
    assert.notEqual(refreshed.map.versionId, priorMap.versionId)

    const ready = cli('resume', { args: { repo, vault, json: true } }).json
    assert.equal(ready.card.trust.status, 'READY')
    assert.equal(ready.card.map.head, liveHead)
    assert.equal(cli('verify', { args: { repo, vault, json: true } }).json.valid, true)
  })
})

test('a stale map cannot be used to clear an independent blocked trust state', () => {
  withFixture(({ repo, vault }) => {
    register(repo, vault)
    const runRecord = begin(repo, vault)
    cli('checkpoint', {
      args: {
        repo,
        vault,
        run: runRecord.runId,
        session: runRecord.session,
        event: 'observation',
        summary: 'Record an independent blocker',
        blocker: 'A user decision is still required.'
      }
    })

    writeFileSync(path.join(repo, 'src', 'index.js'), 'export function value() { return 3 }\n', 'utf8')
    git(repo, 'add', '--', 'src/index.js')
    git(repo, 'commit', '-m', 'advance blocked fixture')
    cli('checkpoint', {
      args: {
        repo,
        vault,
        run: runRecord.runId,
        session: runRecord.session,
        event: 'external-change',
        summary: 'Reconcile the external commit without resolving the blocker',
        'reconcile-live-change': true,
        'reconcile-reason': 'The external commit is now the intended live checkout.'
      }
    })

    const blocked = cli('resume', { args: { repo, vault, json: true }, allowFailure: true })
    assert.equal(blocked.status, 3)
    assert.equal(blocked.json.card.trust.status, 'BLOCKED')
    assert.match(blocked.json.card.trust.reasons.join(' '), /user decision/i)

    const before = protocolMutationSnapshot(vault)
    const rejected = cli('map', {
      args: { repo, vault, run: runRecord.runId, session: runRecord.session, json: true },
      allowFailure: true
    })
    assert.notEqual(rejected.status, 0)
    assert.equal(failureCode(rejected), 'TRUST_NOT_READY')
    assert.deepEqual(protocolMutationSnapshot(vault), before)
    assert.equal(authoritativeState(vault).trust.status, 'BLOCKED')
  })
})

test('model-access remains fail-closed even when authority flags and a route HMAC are supplied', () => {
  withFixture(({ repo, vault, evidence }) => {
    register(repo, vault)
    const run = begin(repo, vault)
    const authority = 'Current user authorizes this exact local evidence file for model access.'
    const routed = releaseRoute(repo, vault, run, authority, 'model-access')
    assert.equal(routed.executable, false)
    const before = protocolMutationSnapshot(vault)
    const evidenceBefore = findFiles(vault, (_absolute, name) => name === 'evidence.json').length
    const rejected = cli('evidence', {
      args: {
        repo,
        vault,
        run: run.runId,
        session: run.session,
        event: 'model-access',
        file: evidence,
        'model-access': true,
        'route-token': routed.credential,
        authority,
        'current-session-authority': true,
        json: true
      },
      allowFailure: true
    })
    assert.notEqual(rejected.status, 0)
    assert.equal(failureCode(rejected), 'ROUTE_CREDENTIAL_INVALID')
    assert.equal(findFiles(vault, (_absolute, name) => name === 'evidence.json').length, evidenceBefore)
    assert.deepEqual(protocolMutationSnapshot(vault), before)
  })
})

test('PRD drift requires an explicit begin reconciliation and preserves the prior revision', () => {
  withFixture(({ root, repo, vault }) => {
    configureLocalOrigin(root, repo)
    const prd = path.join(root, 'versioned-prd.md')
    writeFileSync(prd, '# Requirement\n\nVersion one.\n', 'utf8')
    const registered = cli('register', {
      args: {
        repo,
        vault,
        task: 'Implement the governed requirement',
        'prd-path': prd,
        'prd-approval': 'user-approved',
        'prd-sections': 'Requirement'
      }
    }).json
    const oldHash = registered.state.task.prd.sha256
    const first = begin(repo, vault)
    cli('finish', {
      args: { repo, vault, run: first.runId, session: first.session, status: 'partial', summary: 'PRD revision requested' }
    })
    writeFileSync(prd, '# Requirement\n\nVersion two with changed semantics.\n', 'utf8')

    const ordinaryBegin = cli('begin', {
      args: { repo, vault, request: 'Silently absorb the PRD change', json: true },
      allowFailure: true
    })
    assert.notEqual(ordinaryBegin.status, 0)
    assert.equal(failureCode(ordinaryBegin), 'PRD_RECONCILIATION_REQUIRED')

    const missingAuthority = cli('begin', {
      args: {
        repo,
        vault,
        request: 'Incomplete PRD reconciliation',
        'reconcile-prd': true,
        'prd-path': prd,
        'prd-approval': 'user-approved',
        'task-update-reason': 'The confirmed requirement was revised.',
        'reconcile-reason': 'Adopt version two after explicit review.',
        json: true
      },
      allowFailure: true
    })
    assert.notEqual(missingAuthority.status, 0)
    assert.match(failureCode(missingAuthority) || missingAuthority.stderr, /AUTHORITY|ARGUMENT_REQUIRED/i)

    const authority = 'Current user approves PRD version two and its changed semantics.'
    const reconciled = begin(repo, vault, {
      'reconcile-prd': true,
      'prd-path': prd,
      'prd-approval': 'user-approved',
      'prd-sections': 'Requirement',
      'task-update-reason': 'The confirmed requirement was revised.',
      'reconcile-reason': 'Adopt version two after explicit review.',
      authority,
      'current-session-authority': true
    })
    assert.ok(reconciled.runId)
    const resumed = cli('resume', { args: { repo, vault, json: true } }).json
    assert.equal(resumed.card.trust.status, 'READY')
    const state = authoritativeState(vault)
    assert.notEqual(state.task.prd.sha256, oldHash)
    assert.ok(state.taskHistory.some((task) => task.status === 'revised' && task.prd?.sha256 === oldHash))
    const authorization = findFiles(vault, (absolute, name) => /^\d{6}\.json$/.test(name) && absolute.includes(`${path.sep}events${path.sep}${reconciled.runId}${path.sep}`))
      .map(parseJsonFile).find((event) => event.type === 'authorization' && event.metadata?.priorPrdHash === oldHash)
    assert.ok(authorization)
    assert.equal(authorization.metadata.priorPrdHash, oldHash)
    assert.equal(authorization.metadata.currentPrdHash, state.task.prd.sha256)
    assert.equal(authorization.metadata.approval, 'user-approved')
  })
})

test('supported claims reject invented evidence and accept resolvable map/evidence paths', () => {
  withFixture(({ repo, vault, evidence }) => {
    register(repo, vault)
    const run = begin(repo, vault)
    const beforeEvents = findFiles(vault, (absolute, name) => /^\d{6}\.json$/.test(name) && absolute.includes(`${path.sep}events${path.sep}${run.runId}${path.sep}`)).length
    const forged = cli('checkpoint', {
      args: {
        repo,
        vault,
        run: run.runId,
        session: run.session,
        event: 'verification',
        summary: 'Invented evidence must not support a claim',
        'claim-type': 'verified',
        'claim-status': 'supported',
        scope: 'temporary fixture',
        evidence: 'not-a-real-file-or-event',
        json: true
      },
      allowFailure: true
    })
    assert.notEqual(forged.status, 0)
    assert.equal(failureCode(forged), 'CLAIM_EVIDENCE_UNRESOLVED')
    assert.equal(findFiles(vault, (absolute, name) => /^\d{6}\.json$/.test(name) && absolute.includes(`${path.sep}events${path.sep}${run.runId}${path.sep}`)).length, beforeEvents)

    const mapped = cli('map', { args: { repo, vault, run: run.runId, session: run.session } }).json
    const mapClaim = cli('checkpoint', {
      args: {
        repo,
        vault,
        run: run.runId,
        session: run.session,
        event: 'verification',
        summary: 'Map manifest supports this bounded verification',
        'claim-type': 'verified',
        'claim-status': 'supported',
        scope: 'temporary fixture map',
        evidence: mapped.map.manifest
      }
    }).json
    assert.equal(mapClaim.command, 'checkpoint')

    const attached = cli('evidence', {
      args: { repo, vault, run: run.runId, session: run.session, file: evidence, label: 'resolvable evidence' }
    }).json
    const evidenceClaim = cli('checkpoint', {
      args: {
        repo,
        vault,
        run: run.runId,
        session: run.session,
        event: 'verification',
        summary: 'Archived evidence supports this bounded review',
        'claim-type': 'reviewed',
        'claim-status': 'supported',
        scope: 'temporary fixture evidence',
        evidence: attached.evidence.storedPath
      }
    }).json
    assert.equal(evidenceClaim.command, 'checkpoint')
    const resumed = cli('resume', { args: { repo, vault, json: true } }).json
    assert.equal(resumed.card.progress.filter((claim) => claim.status === 'supported').length, 2)
    assert.equal(cli('verify', { args: { repo, vault } }).json.valid, true)
  })
})

test('dirty working-tree attribution rejects forged --files without writing protocol state', () => {
  withFixture(({ repo, vault }) => {
    register(repo, vault)
    const run = begin(repo, vault)
    writeFileSync(path.join(repo, 'src', 'index.js'), 'export function value() { return 2 }\n', 'utf8')
    const before = protocolMutationSnapshot(vault)

    const rejected = cli('checkpoint', {
      args: {
        repo,
        vault,
        run: run.runId,
        session: run.session,
        event: 'change',
        summary: 'Attempt to attribute the dirty tree to an unrelated file',
        files: 'README.md',
        json: true
      },
      allowFailure: true
    })
    assert.notEqual(rejected.status, 0)
    assert.equal(failureCode(rejected), 'LIVE_CHANGE_FILE_SET_MISMATCH')
    assert.deepEqual(protocolMutationSnapshot(vault), before)
  })
})

test('existing task and PRD changes require current-session authority through begin', async (context) => {
  await context.test('first PRD adoption', () => {
    withFixture(({ root, repo, vault }) => {
      register(repo, vault)
      const prd = path.join(root, 'first-prd.md')
      writeFileSync(prd, '# Confirmed requirement\n\nFirst approved PRD.\n', 'utf8')
      const common = {
        task: 'Lifecycle security fixture',
        'prd-path': prd,
        'prd-approval': 'user-approved',
        'prd-sections': 'Confirmed requirement',
        'reconcile-prd': true,
        'task-update-reason': 'Attach the first approved PRD to the existing task.',
        'reconcile-reason': 'The current user confirmed this PRD is authoritative.',
        authority: 'Historical authority text alone must not authorize PRD adoption.'
      }
      const before = protocolMutationSnapshot(vault)
      const rejected = cli('begin', { args: { repo, vault, ...common, json: true }, allowFailure: true })
      assert.notEqual(rejected.status, 0)
      assert.equal(failureCode(rejected), 'CURRENT_AUTHORITY_REQUIRED')
      assert.deepEqual(protocolMutationSnapshot(vault), before)

      const adopted = begin(repo, vault, { ...common, 'current-session-authority': true })
      assert.ok(adopted.runId)
      const state = authoritativeState(vault)
      assert.equal(state.task.prd.path, prd)
      assert.equal(state.task.prd.approval, 'user-approved')
    })
  })

  await context.test('task switch', () => {
    withFixture(({ repo, vault }) => {
      register(repo, vault)
      const common = {
        task: 'Replacement governed task',
        'transition-reason': 'The current user selected a different unique task.',
        authority: 'Historical authority text alone must not authorize a task switch.'
      }
      const before = protocolMutationSnapshot(vault)
      const rejected = cli('begin', { args: { repo, vault, ...common, json: true }, allowFailure: true })
      assert.notEqual(rejected.status, 0)
      assert.equal(failureCode(rejected), 'CURRENT_AUTHORITY_REQUIRED')
      assert.deepEqual(protocolMutationSnapshot(vault), before)

      const switched = begin(repo, vault, { ...common, 'current-session-authority': true })
      assert.ok(switched.runId)
      assert.equal(cli('resume', { args: { repo, vault, json: true } }).json.card.task.title, common.task)
    })
  })

  await context.test('material task update', () => {
    withFixture(({ repo, vault }) => {
      register(repo, vault)
      const common = {
        task: 'Lifecycle security fixture',
        objective: 'A materially revised bounded objective',
        'task-update-reason': 'The current user revised the objective.',
        authority: 'Historical authority text alone must not authorize a task update.'
      }
      const before = protocolMutationSnapshot(vault)
      const rejected = cli('begin', { args: { repo, vault, ...common, json: true }, allowFailure: true })
      assert.notEqual(rejected.status, 0)
      assert.equal(failureCode(rejected), 'CURRENT_AUTHORITY_REQUIRED')
      assert.deepEqual(protocolMutationSnapshot(vault), before)

      const updated = begin(repo, vault, { ...common, 'current-session-authority': true })
      assert.ok(updated.runId)
      assert.equal(cli('resume', { args: { repo, vault, json: true } }).json.card.task.objective, common.objective)
    })
  })
})

test('recovering an active run requires current authority and never rewrites the prior run record', () => {
  withFixture(({ root, repo, vault }) => {
    configureLocalOrigin(root, repo)
    register(repo, vault)
    const oldRun = begin(repo, vault)
    const common = {
      recover: oldRun.runId,
      'recovery-reason': 'Take over the abandoned active run explicitly.',
      authority: 'Historical authority text alone must not authorize active-run recovery.'
    }
    const before = protocolMutationSnapshot(vault)
    const rejected = cli('begin', { args: { repo, vault, ...common, json: true }, allowFailure: true })
    assert.notEqual(rejected.status, 0)
    assert.equal(failureCode(rejected), 'CURRENT_AUTHORITY_REQUIRED')
    assert.deepEqual(protocolMutationSnapshot(vault), before)
    const oldRecordBeforeRecovery = findFiles(vault, (_absolute, name) => name === `${oldRun.runId}.json`).map(parseJsonFile)
    assert.equal(oldRecordBeforeRecovery.length, 1)
    assert.equal(oldRecordBeforeRecovery[0].status, 'active')

    const recovered = begin(repo, vault, { ...common, 'current-session-authority': true })
    assert.ok(recovered.runId)
    assert.notEqual(recovered.runId, oldRun.runId)
    const oldRecord = findFiles(vault, (_absolute, name) => name === `${oldRun.runId}.json`).map(parseJsonFile)
    assert.equal(oldRecord.length, 1)
    assert.equal(oldRecord[0].status, 'active')
    const card = cli('resume', { args: { repo, vault, json: true } }).json.card
    assert.deepEqual(card.activeRuns.map((entry) => entry.runId), [recovered.runId])
    const state = authoritativeState(vault)
    const abandoned = state.abandonedRuns.find((entry) => entry.runId === oldRun.runId)
    assert.equal(abandoned.status, 'superseded-without-old-session-write')
    assert.equal(abandoned.supersededByRunId, recovered.runId)
    assert.equal(abandoned.immutablePriorRun, true)
    const authorization = runEvents(vault, recovered.runId).find((event) => event.type === 'authorization' && event.metadata?.recoveredFromRunId === oldRun.runId)
    assert.ok(authorization)
    assert.equal(authorization.metadata.currentSessionAuthority, true)
    assert.equal(authorization.metadata.priorRunRecordRewritten, false)
  })
})

test('a corrupt active run blocks recovery and routing without starting a Git operation', () => {
  withFixture(({ root, repo, vault }) => {
    register(repo, vault)
    const runRecord = begin(repo, vault)
    const authority = 'Current user authorizes the fixture operation only if run integrity is valid.'
    writeFileSync(path.join(repo, 'src', 'integrity-guard.js'), 'export const guarded = true\n', 'utf8')
    git(repo, 'add', '--', 'src/integrity-guard.js')
    cli('checkpoint', {
      args: {
        repo,
        vault,
        run: runRecord.runId,
        session: runRecord.session,
        event: 'change',
        summary: 'Attribute the commit that must never start after run corruption',
        files: 'src/integrity-guard.js'
      }
    })
    const beforeHead = git(repo, 'rev-parse', 'HEAD')
    const marker = path.join(root, 'operation-started.txt')
    const hook = path.join(repo, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, `#!/bin/sh\nprintf started > ${JSON.stringify(marker.replace(/\\/g, '/'))}\n`, 'utf8')
    chmodSync(hook, 0o755)
    const runFiles = findFiles(vault, (absolute, name) => name === `${runRecord.runId}.json` && absolute.includes(`${path.sep}runs${path.sep}`))
    assert.equal(runFiles.length, 1)
    const tampered = parseJsonFile(runFiles[0])
    tampered.summary = 'forged without updating recordHash'
    writeFileSync(runFiles[0], `${JSON.stringify(tampered, null, 2)}\n`, 'utf8')
    const afterTamper = protocolMutationSnapshot(vault)

    const resumed = cli('resume', { args: { repo, vault, json: true }, allowFailure: true })
    assert.notEqual(resumed.status, 0)
    assert.equal(resumed.json?.card?.trust?.status, 'BLOCKED')
    assert.match((resumed.json.card.trust.reasons || []).join(' '), /run.*(corrupt|integrity|hash)/i)
    assert.deepEqual(protocolMutationSnapshot(vault), afterTamper)

    const routed = cli('route', {
      args: {
        repo,
        vault,
        run: runRecord.runId,
        session: runRecord.session,
        event: 'commit',
        authority,
        'current-session-authority': true,
        json: true
      },
      allowFailure: true
    })
    assert.notEqual(routed.status, 0)
    assert.notEqual(routed.json?.executable, true)
    assert.deepEqual(protocolMutationSnapshot(vault), afterTamper)
    assert.equal(existsSync(marker), false)
    assert.equal(git(repo, 'rev-parse', 'HEAD'), beforeHead)
    assert.deepEqual(protocolMutationSnapshot(vault), afterTamper)

    const recovery = cli('begin', {
      args: {
        repo,
        vault,
        recover: runRecord.runId,
        'recovery-reason': 'Attempt to recover a corrupt active run',
        authority,
        'current-session-authority': true,
        json: true
      },
      allowFailure: true
    })
    assert.notEqual(recovery.status, 0)
    assert.equal(failureCode(recovery), 'RUN_INTEGRITY_INVALID')
    assert.deepEqual(protocolMutationSnapshot(vault), afterTamper)

    const child = cli('begin', {
      args: {
        repo,
        vault,
        parent: runRecord.runId,
        request: 'Attempt to branch from a corrupt run',
        json: true
      },
      allowFailure: true
    })
    assert.notEqual(child.status, 0)
    assert.equal(failureCode(child), 'RUN_INTEGRITY_INVALID')
    assert.deepEqual(protocolMutationSnapshot(vault), afterTamper)
  })
})

test('default register and resume output redact task secrets in text and JSON', () => {
  withFixture(({ repo, vault }) => {
    const secret = 'sk-local-secret-DO-NOT-DISCLOSE'
    const highEntropy = 'Aa9Bb8Cc7Dd6Ee5Ff4Gg3Hh2Ii1Jj0Kk'
    const registered = cli('register', {
      args: {
        repo,
        vault,
        task: `Investigate ${secret}`,
        objective: `Keep ${secret} and ${highEntropy} confined to the local authoritative vault`,
        reason: `A fixture embeds ${secret} and ${highEntropy} in task text`,
        requirement: `Never disclose ${secret} in bounded output`
      }
    })
    assert.equal(registered.status, 0)
    assert.equal(registered.stdout.includes(secret), false)
    assert.equal(JSON.stringify(registered.json).includes(secret), false)
    assert.equal(registered.stdout.includes(highEntropy), false)
    assert.equal(JSON.stringify(registered.json).includes(highEntropy), false)
    assert.match(registered.stdout, /REDACTED_CREDENTIAL/)
    assert.match(registered.stdout, /REDACTED_HIGH_ENTROPY_TOKEN/)

    const textResume = cli('resume', { args: { repo, vault } })
    assert.equal(textResume.status, 0)
    assert.equal(textResume.stdout.includes(secret), false)
    assert.equal(textResume.stdout.includes(highEntropy), false)
    assert.match(textResume.stdout, /REDACTED_CREDENTIAL/)
    assert.match(textResume.stdout, /REDACTED_HIGH_ENTROPY_TOKEN/)

    const jsonResume = cli('resume', { args: { repo, vault, json: true } })
    assert.equal(jsonResume.status, 0)
    assert.equal(jsonResume.stdout.includes(secret), false)
    assert.equal(JSON.stringify(jsonResume.json).includes(secret), false)
  })
})

test('weak or non-performed lifecycle evidence cannot support a deployed claim', async (context) => {
  await context.test('ordinary repository files and self-made events are not deployment provenance', () => {
    withFixture(({ root, repo, vault }) => {
      configureLocalOrigin(root, repo)
      register(repo, vault)
      const run = begin(repo, vault)
      const selfMade = cli('checkpoint', {
        args: {
          repo,
          vault,
          run: run.runId,
          session: run.session,
          event: 'observation',
          summary: 'A self-made observation is not deployment attestation'
        }
      }).json
      const authority = 'Current user permits evaluating this exact deployment claim.'
      const route = releaseRoute(repo, vault, run, authority, 'deploy')
      for (const weakEvidence of [path.join(repo, 'README.md'), selfMade.event.eventId]) {
        const before = protocolMutationSnapshot(vault)
        const rejected = cli('checkpoint', {
          args: {
            repo,
            vault,
            run: run.runId,
            session: run.session,
            event: 'verification',
            summary: 'Weak evidence must not support deployment',
            'claim-type': 'deployed',
            'claim-status': 'supported',
            scope: 'fixture deployment',
            environment: 'fixture',
            evidence: weakEvidence,
            'route-token': route.credential,
            'route-event': 'deploy',
            authority,
            'current-session-authority': true,
            json: true
          },
          allowFailure: true
        })
        assert.notEqual(rejected.status, 0)
        assert.equal(failureCode(rejected), 'ROUTE_TOKEN_STALE')
        assert.deepEqual(protocolMutationSnapshot(vault), before)
      }
    })
  })

  for (const attribution of ['observed', 'unattributed']) {
    await context.test(`${attribution} successful deployment cannot be recorded without a built-in observer`, () => {
      withFixture(({ root, repo, vault }) => {
        configureLocalOrigin(root, repo)
        const registered = register(repo, vault)
        const run = begin(repo, vault)
        const deploymentFile = path.join(root, `${attribution}-deployment.json`)
        const healthFile = path.join(root, `${attribution}-health.json`)
        writeFileSync(deploymentFile, '{"status":"deployed"}\n', 'utf8')
        writeFileSync(healthFile, '{"status":"healthy"}\n', 'utf8')
        const deployment = cli('evidence', {
          args: { repo, vault, run: run.runId, session: run.session, file: deploymentFile, kind: 'deployment-response' }
        }).json
        const health = cli('evidence', {
          args: { repo, vault, run: run.runId, session: run.session, file: healthFile, kind: 'health-check' }
        }).json
        const scope = 'fixture deployment'
        const environment = 'fixture'
        const beforeLifecycle = protocolMutationSnapshot(vault)
        const lifecycle = cli('checkpoint', {
          args: {
            repo,
            vault,
            run: run.runId,
            session: run.session,
            event: 'release',
            summary: `Record an ${attribution} deployment`,
            'event-type': 'deploy',
            outcome: 'succeeded',
            attribution,
            scope,
            environment,
            'before-hash': 'fixture-before',
            'after-hash': registered.state.repo.head,
            evidence: `${deployment.evidence.evidenceId},${health.evidence.evidenceId}`,
            json: true
          },
          allowFailure: true
        })
        assert.notEqual(lifecycle.status, 0)
        assert.equal(
          failureCode(lifecycle),
          'RELEASE_OBSERVER_UNAVAILABLE',
          lifecycle.stderr || lifecycle.stdout
        )
        assert.deepEqual(protocolMutationSnapshot(vault), beforeLifecycle)

        const beforeClaim = protocolMutationSnapshot(vault)
        const rejectedClaim = cli('checkpoint', {
          args: {
            repo,
            vault,
            run: run.runId,
            session: run.session,
            event: 'verification',
            summary: 'Manual deployment evidence cannot support a deployed claim',
            'claim-type': 'deployed',
            'claim-status': 'supported',
            scope,
            environment,
            evidence: `${deployment.evidence.evidenceId},${health.evidence.evidenceId}`,
            json: true
          },
          allowFailure: true
        })
        assert.notEqual(rejectedClaim.status, 0)
        assert.equal(failureCode(rejectedClaim), 'SUPPORTED_RELEASE_OBSERVER_UNAVAILABLE')
        assert.deepEqual(protocolMutationSnapshot(vault), beforeClaim)
        assert.equal(authoritativeState(vault).claims.some((claim) => claim.type === 'deployed' && claim.status === 'supported'), false)
      })
    })
  }
})

test('manual kind labels and an arbitrary command cannot forge a successful performed deployment', () => {
  withFixture(({ root, repo, vault }) => {
    const registered = register(repo, vault)
    const run = begin(repo, vault)
    const deploymentFile = path.join(root, 'self-labelled-deployment.json')
    const healthFile = path.join(root, 'self-labelled-health.json')
    writeFileSync(deploymentFile, '{"claimed":"deployed"}\n', 'utf8')
    writeFileSync(healthFile, '{"claimed":"healthy"}\n', 'utf8')
    const deployment = cli('evidence', {
      args: { repo, vault, run: run.runId, session: run.session, file: deploymentFile, kind: 'deployment-response' }
    }).json
    const health = cli('evidence', {
      args: { repo, vault, run: run.runId, session: run.session, file: healthFile, kind: 'health-check' }
    }).json
    assert.equal(deployment.evidence.producer, 'manual-contextctl-capture')
    assert.equal(health.evidence.producer, 'manual-contextctl-capture')

    const authority = 'Current user authorizes evaluating this anti-forgery fixture.'
    const route = releaseRoute(repo, vault, run, authority, 'deploy')
    const before = protocolMutationSnapshot(vault)
    const forged = cli('checkpoint', {
      args: {
        repo,
        vault,
        run: run.runId,
        session: run.session,
        event: 'release',
        summary: 'A hand-written command and labels must not become deployment proof',
        'event-type': 'deploy',
        outcome: 'succeeded',
        attribution: 'performed',
        scope: 'fixture deployment',
        environment: 'fixture',
        'before-hash': 'fixture-before',
        'after-hash': registered.state.repo.head,
        evidence: `${deployment.evidence.evidenceId},${health.evidence.evidenceId}`,
        command: 'echo pretend-deployed',
        'exit-code': 0,
        'executor-attestation': 'forged-attestation',
        'route-token': route.credential,
        'route-event': 'deploy',
        authority,
        'current-session-authority': true,
        json: true
      },
      allowFailure: true
    })
    assert.notEqual(forged.status, 0)
    assert.equal(failureCode(forged), 'ROUTE_TOKEN_STALE')
    assert.deepEqual(protocolMutationSnapshot(vault), before)

    const unsupported = cli('checkpoint', {
      args: {
        repo,
        vault,
        run: run.runId,
        session: run.session,
        event: 'verification',
        summary: 'Manual evidence cannot support a deployed claim',
        'claim-type': 'deployed',
        'claim-status': 'supported',
        scope: 'fixture deployment',
        environment: 'fixture',
        evidence: deployment.evidence.evidenceId,
        'route-token': route.credential,
        'route-event': 'deploy',
        authority,
        'current-session-authority': true,
        json: true
      },
      allowFailure: true
    })
    assert.notEqual(unsupported.status, 0)
    assert.equal(failureCode(unsupported), 'ROUTE_TOKEN_STALE')
    assert.deepEqual(protocolMutationSnapshot(vault), before)
    assert.equal(authoritativeState(vault).claims.some((claim) => claim.type === 'deployed' && claim.status === 'supported'), false)
  })
})

test('standalone high-risk routes fail closed without starting commit, push, deploy, rollback, delete, or acceptance', () => {
  withFixture(({ root, repo, vault }) => {
    const remote = path.join(root, 'origin.git')
    run('git', ['init', '--bare', remote])
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'push', '-u', 'origin', 'main')
    register(repo, vault)
    const runRecord = begin(repo, vault)
    writeFileSync(path.join(repo, 'src', 'must-not-commit.js'), 'export const guarded = true\n', 'utf8')
    git(repo, 'add', '--', 'src/must-not-commit.js')
    cli('checkpoint', {
      args: {
        repo,
        vault,
        run: runRecord.runId,
        session: runRecord.session,
        event: 'change',
        summary: 'Attribute the staged file without authorizing any lifecycle operation',
        files: 'src/must-not-commit.js'
      }
    })
    cli('map', { args: { repo, vault, run: runRecord.runId, session: runRecord.session } })
    const marker = path.join(root, 'operation-started.txt')
    const hook = path.join(repo, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, `#!/bin/sh\nprintf started > ${JSON.stringify(marker.replace(/\\/g, '/'))}\n`, 'utf8')
    chmodSync(hook, 0o755)
    const before = protocolMutationSnapshot(vault)
    const beforeHead = git(repo, 'rev-parse', 'HEAD')
    const beforeRemote = run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/main']).trim()
    const authority = 'Authority flags alone cannot authorize standalone high-risk execution.'

    for (const eventType of ['commit', 'push', 'deploy', 'rollback', 'delete', 'acceptance']) {
      const routed = cli('route', {
        args: {
          repo,
          vault,
          run: runRecord.runId,
          session: runRecord.session,
          event: eventType,
          authority,
          'current-session-authority': true,
          'approval-capability': 'forged.payload',
          'operation-scope': `fixture ${eventType}`,
          environment: 'fixture',
          json: true
        },
        allowFailure: true
      })
      assert.notEqual(routed.status, 0)
      assert.equal(routed.json?.executable, false)
      assert.equal(routed.json?.externalApproval?.valid, false)
      assert.match(routed.json?.externalApproval?.reason || '', /STANDALONE_HIGH_RISK_EXECUTION_DISABLED/)
    }
    assert.equal(existsSync(marker), false)
    assert.equal(git(repo, 'rev-parse', 'HEAD'), beforeHead)
    assert.equal(run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/main']).trim(), beforeRemote)
    assert.deepEqual(protocolMutationSnapshot(vault), before)
    assert.equal(authoritativeState(vault).claims.some((claim) => claim.type === 'deployed' && claim.status === 'supported'), false)
  })
})

test('agent-supplied approval public keys and forged capabilities cannot enable a high-risk route', () => {
  withFixture(({ root, repo, vault }) => {
    const fakePublicKey = path.join(root, 'agent-supplied-approval.pem')
    writeFileSync(fakePublicKey, '-----BEGIN PUBLIC KEY-----\nZm9yZ2Vk\n-----END PUBLIC KEY-----\n', 'utf8')
    const registered = cli('register', {
      args: {
        repo,
        vault,
        task: 'Lifecycle security fixture',
        'approval-public-key': fakePublicKey
      }
    })
    assert.equal(Object.prototype.hasOwnProperty.call(authoritativeState(vault), 'approvalProvider'), false)
    assert.equal(findFiles(vault, (_absolute, name) => name === 'approval-public-key.pem' || name === 'approval-provider.json').length, 0)

    const run = begin(repo, vault)
    const before = protocolMutationSnapshot(vault)
    const routed = cli('route', {
      args: {
        repo,
        vault,
        run: run.runId,
        session: run.session,
        event: 'push',
        authority: 'Agent-supplied approval material must not establish authority.',
        'current-session-authority': true,
        'approval-public-key': fakePublicKey,
        'approval-capability': 'eyJmb3JnZWQiOnRydWV9.Zm9yZ2Vk',
        'operation-scope': 'refs/heads/main',
        environment: 'fixture',
        json: true
      },
      allowFailure: true
    })
    assert.notEqual(routed.status, 0)
    assert.equal(routed.json?.executable, false)
    assert.match(routed.json?.externalApproval?.reason || '', /STANDALONE_HIGH_RISK_EXECUTION_DISABLED/)
    assert.deepEqual(protocolMutationSnapshot(vault), before)
  })
})

test('tampered evidence fails verification and cannot create a supported claim', async (context) => {
  const cases = [
    {
      name: 'stored evidence bytes',
      tamper(captured) {
        const original = readFileSync(captured.evidence.storedPath, 'utf8')
        writeFileSync(captured.evidence.storedPath, original.replace('local', 'LOCAL'), 'utf8')
      },
      expected: /stored evidence hash mismatch/i
    },
    {
      name: 'evidence metadata kind',
      tamper(captured) {
        const metadataPath = path.join(path.dirname(captured.evidence.storedPath), 'evidence.json')
        const metadata = parseJsonFile(metadataPath)
        metadata.kind = 'forged-unknown-kind'
        writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
      },
      expected: /invalid evidence kind/i
    },
    {
      name: 'evidence metadata hash',
      tamper(captured) {
        const metadataPath = path.join(path.dirname(captured.evidence.storedPath), 'evidence.json')
        const metadata = parseJsonFile(metadataPath)
        metadata.sha256 = '0'.repeat(64)
        writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
      },
      expected: /stored evidence hash mismatch/i
    }
  ]

  for (const fixtureCase of cases) {
    await context.test(fixtureCase.name, () => {
      withFixture(({ repo, vault, evidence }) => {
        register(repo, vault)
        const run = begin(repo, vault)
        const captured = cli('evidence', {
          args: {
            repo,
            vault,
            run: run.runId,
            session: run.session,
            file: evidence,
            kind: 'test-report',
            label: 'integrity fixture'
          }
        }).json
        assert.equal(cli('verify', { args: { repo, vault } }).json.valid, true)

        fixtureCase.tamper(captured)
        const verification = cli('verify', { args: { repo, vault, json: true }, allowFailure: true })
        assert.notEqual(verification.status, 0)
        assert.equal(verification.json.valid, false)
        assert.match(verification.json.errors.join(' '), fixtureCase.expected)

        const before = protocolMutationSnapshot(vault)
        const rejected = cli('checkpoint', {
          args: {
            repo,
            vault,
            run: run.runId,
            session: run.session,
            event: 'verification',
            summary: 'Corrupt captured evidence must not support this claim',
            'claim-type': 'verified',
            'claim-status': 'supported',
            scope: 'evidence integrity fixture',
            evidence: captured.evidence.evidenceId,
            json: true
          },
          allowFailure: true
        })
        assert.notEqual(rejected.status, 0)
        assert.equal(failureCode(rejected), 'CLAIM_EVIDENCE_UNRESOLVED', rejected.stderr || rejected.stdout)
        assert.deepEqual(protocolMutationSnapshot(vault), before)
        const state = authoritativeState(vault)
        assert.equal(state.claims.some((claim) => claim.status === 'supported'), false)
      })
    })
  }
})

test('facts and confirmed hypotheses require resolvable evidence before any write', async (context) => {
  for (const fixtureCase of [
    { name: 'fact', args: { fact: 'A claimed fact without evidence' } },
    { name: 'confirmed hypothesis', args: { hypothesis: 'A hypothesis claimed as confirmed without evidence', 'hypothesis-status': 'confirmed' } }
  ]) {
    await context.test(fixtureCase.name, () => {
      withFixture(({ repo, vault }) => {
        register(repo, vault)
        const runRecord = begin(repo, vault)
        const before = protocolMutationSnapshot(vault)
        const rejected = cli('checkpoint', {
          args: {
            repo,
            vault,
            run: runRecord.runId,
            session: runRecord.session,
            event: 'observation',
            summary: `Reject an unsupported ${fixtureCase.name}`,
            ...fixtureCase.args,
            json: true
          },
          allowFailure: true
        })
        assert.notEqual(rejected.status, 0)
        assert.equal(failureCode(rejected), 'CLAIM_EVIDENCE_REQUIRED')
        assert.deepEqual(protocolMutationSnapshot(vault), before)
        const state = authoritativeState(vault)
        assert.deepEqual(state.confirmedFacts, [])
        assert.deepEqual(state.hypotheses, [])
      })
    })
  }
})

test('resume blocks when trusted architecture or nested event evidence is tampered', async (context) => {
  await context.test('supported architecture claim EVID bytes', () => {
    withFixture(({ repo, vault, evidence }) => {
      register(repo, vault)
      const runRecord = begin(repo, vault)
      const captured = cli('evidence', {
        args: { repo, vault, run: runRecord.runId, session: runRecord.session, file: evidence, kind: 'test-report' }
      }).json
      cli('checkpoint', {
        args: {
          repo,
          vault,
          run: runRecord.runId,
          session: runRecord.session,
          event: 'verification',
          summary: 'Seal a supported architecture claim',
          'architecture-claim': 'The fixture has one bounded source module.',
          'claim-status': 'supported',
          scope: 'fixture architecture',
          evidence: captured.evidence.evidenceId
        }
      })
      writeFileSync(captured.evidence.storedPath, 'tampered architecture evidence\n', 'utf8')
      const resumed = cli('resume', { args: { repo, vault, json: true }, allowFailure: true })
      assert.notEqual(resumed.status, 0)
      assert.equal(resumed.json.card.trust.status, 'BLOCKED')
      assert.match(resumed.json.card.trust.reasons.join(' '), /architecture claim.*(missing|corrupt|binding)/i)
    })
  })

  await context.test('supported claim through evidence-capture event', () => {
    withFixture(({ repo, vault, evidence }) => {
      register(repo, vault)
      const runRecord = begin(repo, vault)
      const captured = cli('evidence', {
        args: { repo, vault, run: runRecord.runId, session: runRecord.session, file: evidence, kind: 'test-report' }
      }).json
      const captureEvent = runEvents(vault, runRecord.runId).find((event) => event.metadata?.evidenceId === captured.evidence.evidenceId)
      assert.ok(captureEvent)
      cli('checkpoint', {
        args: {
          repo,
          vault,
          run: runRecord.runId,
          session: runRecord.session,
          event: 'verification',
          summary: 'Seal a supported claim through the immutable capture event',
          'claim-type': 'verified',
          'claim-status': 'supported',
          scope: 'nested evidence fixture',
          evidence: captureEvent.eventId
        }
      })
      writeFileSync(captured.evidence.storedPath, 'tampered nested evidence\n', 'utf8')
      const resumed = cli('resume', { args: { repo, vault, json: true }, allowFailure: true })
      assert.notEqual(resumed.status, 0)
      assert.equal(resumed.json.card.trust.status, 'BLOCKED')
      assert.match(resumed.json.card.trust.reasons.join(' '), /supported verified claim.*(missing|corrupt|binding)/i)
    })
  })
})

test('commit and push routes fail Git preflight for staged local-vault material', async (context) => {
  const assertBlocked = (repo, vault, run, expectedPath) => {
    const authority = 'Current user authorizes evaluating the fixture Git route.'
    for (const event of ['commit', 'push']) {
      const routed = cli('route', {
        args: {
          repo,
          vault,
          run: run.runId,
          session: run.session,
          event,
          authority,
          'current-session-authority': true,
          json: true
        },
        allowFailure: true
      })
      assert.notEqual(routed.status, 0)
      assert.equal(routed.json.sensitiveGitPreflight.passed, false)
      assert.equal(routed.json.executable, false)
      assert.ok(routed.json.sensitiveGitPreflight.violations.some((entry) => entry.includes(expectedPath)), `${event} must identify ${expectedPath}`)
    }
  }

  await context.test('exact vault generation copy', () => {
    withFixture(({ repo, vault }) => {
      register(repo, vault)
      const run = begin(repo, vault)
      const relative = 'src/context-snapshot.bin'
      copyFileSync(currentStateGenerationFile(vault), path.join(repo, relative))
      git(repo, 'add', '--', relative)
      assertBlocked(repo, vault, run, relative)
    })
  })

  await context.test('exact captured evidence copy', () => {
    withFixture(({ repo, vault, evidence }) => {
      register(repo, vault)
      const run = begin(repo, vault)
      const captured = cli('evidence', {
        args: { repo, vault, run: run.runId, session: run.session, file: evidence, kind: 'test-report' }
      }).json
      const relative = 'src/copied-fixture-output.bin'
      copyFileSync(captured.evidence.storedPath, path.join(repo, relative))
      git(repo, 'add', '--', relative)
      assertBlocked(repo, vault, run, relative)
    })
  })

  await context.test('symlink into the vault', () => {
    withFixture(({ root, repo, vault }) => {
      register(repo, vault)
      const run = begin(repo, vault)
      const relative = 'src/local-vault-link'
      const linkBlobSource = path.join(root, 'symlink-target.txt')
      writeFileSync(linkBlobSource, path.join(vault, '.protocol-key'), 'utf8')
      const blob = git(repo, 'hash-object', '-w', linkBlobSource)
      git(repo, 'update-index', '--add', '--cacheinfo', `120000,${blob},${relative}`)
      assertBlocked(repo, vault, run, relative)
      const routed = cli('route', {
        args: {
          repo,
          vault,
          run: run.runId,
          session: run.session,
          event: 'commit',
          authority: 'Current user authorizes evaluating the fixture Git route.',
          'current-session-authority': true,
          json: true
        },
        allowFailure: true
      }).json
      assert.ok(routed.sensitiveGitPreflight.violations.some((entry) => /symlink resolves into/i.test(entry)))
    })
  })

  await context.test('reserved protocol filenames', () => {
    withFixture(({ repo, vault }) => {
      register(repo, vault)
      const run = begin(repo, vault)
      const protocolKey = '.protocol-key'
      const projectContext = 'docs/PROJECT_CONTEXT.md'
      mkdirSync(path.join(repo, 'docs'), { recursive: true })
      writeFileSync(path.join(repo, protocolKey), 'not-even-a-real-key\n', 'utf8')
      writeFileSync(path.join(repo, projectContext), '# Accidental context archive\n', 'utf8')
      git(repo, 'add', '--', protocolKey, projectContext)
      assertBlocked(repo, vault, run, protocolKey)
      assertBlocked(repo, vault, run, projectContext)
    })
  })
})

test('ordinary staged source passes sensitive Git preflight but standalone Git routes remain non-executable', () => {
  withFixture(({ repo, vault }) => {
    register(repo, vault)
    const run = begin(repo, vault)
    const relative = 'src/index.js'
    writeFileSync(path.join(repo, relative), 'export function value() { return 7 }\n', 'utf8')
    git(repo, 'add', '--', relative)
    cli('checkpoint', {
      args: {
        repo,
        vault,
        run: run.runId,
        session: run.session,
        event: 'change',
        summary: 'Attribute the ordinary staged source change',
        files: relative
      }
    })
    cli('map', { args: { repo, vault, run: run.runId, session: run.session } })
    const authority = 'Current user authorizes evaluating ordinary source Git routes.'
    for (const event of ['commit', 'push']) {
      const routed = cli('route', {
        args: {
          repo,
          vault,
          run: run.runId,
          session: run.session,
          event,
          authority,
          'current-session-authority': true,
          json: true
        },
        allowFailure: true
      }).json
      assert.equal(routed.sensitiveGitPreflight.passed, true)
      assert.deepEqual(routed.sensitiveGitPreflight.violations, [])
      assert.equal(routed.executable, false)
      assert.match(routed.externalApproval.reason, /STANDALONE_HIGH_RISK_EXECUTION_DISABLED/)
    }
  })
})

test('external commit and push are observer-verified facts and support bounded observed claims', () => {
  withFixture(({ root, repo, vault }) => {
    const remote = path.join(root, 'origin.git')
    run('git', ['init', '--bare', remote])
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'push', '-u', 'origin', 'main')
    const ref = 'refs/heads/main'
    const remoteName = 'origin'
    const normalizedPushUrl = normalizeRemote(git(repo, 'remote', 'get-url', '--push', remoteName))
    const pushUrlHash = createHash('sha256').update(normalizedPushUrl, 'utf8').digest('hex')
    const pushScope = `git-push:${remoteName}:${ref}:${pushUrlHash}`
    const pushEnvironment = `git-remote:${remoteName}:${pushUrlHash}`
    register(repo, vault)
    const runRecord = begin(repo, vault)

    const beforeHead = git(repo, 'rev-parse', 'HEAD')
    writeFileSync(path.join(repo, 'src', 'observed.js'), 'export const observed = true\n', 'utf8')
    git(repo, 'add', '--', 'src/observed.js')
    git(repo, 'commit', '-m', 'external fixture commit')
    const afterHead = git(repo, 'rev-parse', 'HEAD')
    const observedCommit = cli('checkpoint', {
      args: {
        repo,
        vault,
        run: runRecord.runId,
        session: runRecord.session,
        event: 'git',
        summary: 'Record a commit that occurred outside the standalone protocol',
        'event-type': 'commit',
        outcome: 'succeeded',
        attribution: 'observed',
        scope: 'refs/heads/main',
        'before-hash': beforeHead,
        'after-hash': afterHead,
        'reconcile-live-change': true,
        'reconcile-reason': 'The external Git commit is now the live checkout.'
      }
    }).json
    assert.equal(observedCommit.event.metadata.attribution, 'observed')
    assert.equal(observedCommit.event.metadata.evidenceValidated, true)
    assert.equal(observedCommit.event.metadata.observerVerified, true)
    assert.equal(observedCommit.event.metadata.observerType, 'live-git-commit-observer')
    assert.equal(observedCommit.event.metadata.observerObservation.beforeHash, beforeHead)
    assert.equal(observedCommit.event.metadata.observerObservation.afterHash, afterHead)
    assert.equal(observedCommit.event.metadata.observerObservation.changedFiles.count, 1)
    assert.match(observedCommit.event.metadata.observerObservation.changedFiles.sha256, /^[a-f0-9]{64}$/)
    assert.deepEqual(observedCommit.event.metadata.observerObservation.changedFiles.preview, [{ status: 'A', paths: ['src/observed.js'] }])
    assert.equal(observedCommit.event.metadata.observerObservation.changedFiles.previewTruncated, false)
    assert.notEqual(observedCommit.event.metadata.currentSessionAuthority, true)

    git(repo, 'push', 'origin', 'main')
    const observedPush = cli('checkpoint', {
      args: {
        repo,
        vault,
        run: runRecord.runId,
        session: runRecord.session,
        event: 'git',
        summary: 'Record a push that occurred outside the standalone protocol',
        'event-type': 'push',
        outcome: 'succeeded',
        attribution: 'observed',
        scope: pushScope,
        environment: pushEnvironment,
        'after-hash': afterHead,
        remote: remoteName,
        ref,
        'allow-remote-observation': true
      }
    }).json
    assert.equal(observedPush.event.metadata.attribution, 'observed')
    assert.equal(observedPush.event.metadata.evidenceValidated, true)
    assert.equal(observedPush.event.metadata.observerVerified, true)
    assert.equal(observedPush.event.metadata.observerType, 'live-git-remote-ref-observer')
    assert.equal(observedPush.event.metadata.observerObservation.remoteTargetFingerprint, pushUrlHash)
    assert.equal(observedPush.event.metadata.observerObservation.remoteOid, afterHead)
    assert.notEqual(observedPush.event.metadata.currentSessionAuthority, true)

    const refreshedMap = cli('map', {
      args: { repo, vault, run: runRecord.runId, session: runRecord.session, json: true }
    }).json
    assert.equal(refreshedMap.map.head, afterHead)

    const committedClaim = cli('checkpoint', {
      args: {
        repo,
        vault,
        run: runRecord.runId,
        session: runRecord.session,
        event: 'verification',
        summary: 'Live commit observation supports a bounded committed claim',
        'claim-type': 'committed',
        'claim-status': 'supported',
        scope: 'refs/heads/main',
        evidence: observedCommit.event.eventId
      }
    }).json
    const pushedClaim = cli('checkpoint', {
      args: {
        repo,
        vault,
        run: runRecord.runId,
        session: runRecord.session,
        event: 'verification',
        summary: 'Live remote-ref observation supports a bounded pushed claim',
        'claim-type': 'pushed',
        'claim-status': 'supported',
        scope: pushScope,
        environment: pushEnvironment,
        evidence: observedPush.event.eventId
      }
    }).json
    assert.equal(committedClaim.command, 'checkpoint')
    assert.equal(pushedClaim.command, 'checkpoint')
    const claims = authoritativeState(vault).claims
    assert.equal(claims.some((entry) => entry.type === 'committed' && entry.status === 'supported'), true)
    assert.equal(claims.some((entry) => entry.type === 'pushed' && entry.status === 'supported'), true)
    assert.equal(cli('verify', { args: { repo, vault } }).json.valid, true)
  })
})

test('commit observer rejects wrong prior state, multi-commit jumps, second-parent merges, and wrong scope', async (context) => {
  const rejectedCommit = ({ repo, vault, runRecord, beforeHash, afterHash, scope }) => cli('checkpoint', {
    args: {
      repo,
      vault,
      run: runRecord.runId,
      session: runRecord.session,
      event: 'git',
      summary: 'Reject a commit observation that is not the exact next live commit',
      'event-type': 'commit',
      outcome: 'succeeded',
      attribution: 'observed',
      scope,
      'before-hash': beforeHash,
      'after-hash': afterHash,
      'reconcile-live-change': true,
      'reconcile-reason': 'Exercise the fail-closed commit observer.',
      json: true
    },
    allowFailure: true
  })

  await context.test('wrong prior state HEAD', () => {
    withFixture(({ repo, vault }) => {
      register(repo, vault)
      const runRecord = begin(repo, vault)
      writeFileSync(path.join(repo, 'src', 'next.js'), 'export const next = true\n', 'utf8')
      git(repo, 'add', '--', 'src/next.js')
      git(repo, 'commit', '-m', 'one external commit')
      const afterHash = git(repo, 'rev-parse', 'HEAD')
      const before = protocolMutationSnapshot(vault)
      const rejected = rejectedCommit({ repo, vault, runRecord, beforeHash: afterHash, afterHash, scope: 'refs/heads/main' })
      assert.equal(failureCode(rejected), 'COMMIT_PRIOR_HEAD_CONFLICT')
      assert.deepEqual(protocolMutationSnapshot(vault), before)
    })
  })

  await context.test('multi-commit jump', () => {
    withFixture(({ repo, vault }) => {
      register(repo, vault)
      const runRecord = begin(repo, vault)
      const beforeHash = git(repo, 'rev-parse', 'HEAD')
      for (const name of ['first', 'second']) {
        writeFileSync(path.join(repo, 'src', `${name}.js`), `export const ${name} = true\n`, 'utf8')
        git(repo, 'add', '--', `src/${name}.js`)
        git(repo, 'commit', '-m', `${name} external commit`)
      }
      const afterHash = git(repo, 'rev-parse', 'HEAD')
      const before = protocolMutationSnapshot(vault)
      const rejected = rejectedCommit({ repo, vault, runRecord, beforeHash, afterHash, scope: 'refs/heads/main' })
      assert.equal(failureCode(rejected), 'COMMIT_PARENT_CONFLICT')
      assert.deepEqual(protocolMutationSnapshot(vault), before)
    })
  })

  await context.test('prior HEAD is only the second merge parent', () => {
    withFixture(({ repo, vault }) => {
      const beforeHash = git(repo, 'rev-parse', 'HEAD')
      register(repo, vault)
      const runRecord = begin(repo, vault)

      git(repo, 'checkout', '-b', 'first-parent-fixture')
      writeFileSync(path.join(repo, 'src', 'first-parent.js'), 'export const firstParent = true\n', 'utf8')
      git(repo, 'add', '--', 'src/first-parent.js')
      git(repo, 'commit', '-m', 'first parent fixture commit')
      const firstParent = git(repo, 'rev-parse', 'HEAD')
      const mergeTree = git(repo, 'rev-parse', `${firstParent}^{tree}`)
      git(repo, 'checkout', 'main')
      const afterHash = git(repo, 'commit-tree', mergeTree, '-p', firstParent, '-p', beforeHash, '-m', 'external merge with prior as second parent')
      git(repo, 'update-ref', 'refs/heads/main', afterHash, beforeHash)
      git(repo, 'reset', '--hard', afterHash)
      const parents = git(repo, 'rev-list', '--parents', '-n', '1', afterHash).split(/\s+/)
      assert.equal(parents[2], beforeHash)
      const before = protocolMutationSnapshot(vault)
      const rejected = rejectedCommit({ repo, vault, runRecord, beforeHash, afterHash, scope: 'refs/heads/main' })
      assert.equal(failureCode(rejected), 'COMMIT_PARENT_CONFLICT')
      assert.deepEqual(protocolMutationSnapshot(vault), before)
    })
  })

  await context.test('wrong branch scope', () => {
    withFixture(({ repo, vault }) => {
      register(repo, vault)
      const runRecord = begin(repo, vault)
      const beforeHash = git(repo, 'rev-parse', 'HEAD')
      writeFileSync(path.join(repo, 'src', 'scope.js'), 'export const scope = true\n', 'utf8')
      git(repo, 'add', '--', 'src/scope.js')
      git(repo, 'commit', '-m', 'scope fixture commit')
      const afterHash = git(repo, 'rev-parse', 'HEAD')
      const before = protocolMutationSnapshot(vault)
      const rejected = rejectedCommit({ repo, vault, runRecord, beforeHash, afterHash, scope: 'refs/heads/not-main' })
      assert.equal(failureCode(rejected), 'COMMIT_SCOPE_CONFLICT')
      assert.deepEqual(protocolMutationSnapshot(vault), before)
    })
  })
})

test('push observer requires opt-in and rejects wrong target identity, scope, environment, and remote OID', async (context) => {
  const setup = ({ root, repo, vault }, { pushAfterCommit }) => {
    const remote = path.join(root, 'origin.git')
    run('git', ['init', '--bare', remote])
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'push', '-u', 'origin', 'main')
    register(repo, vault)
    const runRecord = begin(repo, vault)
    const beforeHash = git(repo, 'rev-parse', 'HEAD')
    writeFileSync(path.join(repo, 'src', 'remote.js'), 'export const remoteObserved = true\n', 'utf8')
    git(repo, 'add', '--', 'src/remote.js')
    git(repo, 'commit', '-m', 'external commit before observed push')
    const afterHash = git(repo, 'rev-parse', 'HEAD')
    cli('checkpoint', {
      args: {
        repo,
        vault,
        run: runRecord.runId,
        session: runRecord.session,
        event: 'git',
        summary: 'Reconcile the exact external commit before observing its push',
        'event-type': 'commit',
        outcome: 'succeeded',
        attribution: 'observed',
        scope: 'refs/heads/main',
        'before-hash': beforeHash,
        'after-hash': afterHash,
        'reconcile-live-change': true,
        'reconcile-reason': 'The exact next external commit is now live.'
      }
    })
    if (pushAfterCommit) git(repo, 'push', 'origin', 'main')
    const normalized = normalizeRemote(git(repo, 'remote', 'get-url', '--push', 'origin'))
    const hash = createHash('sha256').update(normalized, 'utf8').digest('hex')
    return {
      remote,
      runRecord,
      afterHash,
      ref: 'refs/heads/main',
      scope: `git-push:origin:refs/heads/main:${hash}`,
      environment: `git-remote:origin:${hash}`
    }
  }

  const observe = ({ repo, vault, prepared, overrides = {} }) => cli('checkpoint', {
    args: {
      repo,
      vault,
      run: prepared.runRecord.runId,
      session: prepared.runRecord.session,
      event: 'git',
      summary: 'Exercise fail-closed remote observation',
      'event-type': 'push',
      outcome: 'succeeded',
      attribution: 'observed',
      scope: prepared.scope,
      environment: prepared.environment,
      'after-hash': prepared.afterHash,
      remote: 'origin',
      ref: prepared.ref,
      'allow-remote-observation': true,
      json: true,
      ...overrides
    },
    allowFailure: true
  })

  await context.test('missing explicit remote-observation opt-in', () => {
    withFixture((fixture) => {
      const prepared = setup(fixture, { pushAfterCommit: true })
      const before = protocolMutationSnapshot(fixture.vault)
      const rejected = observe({ repo: fixture.repo, vault: fixture.vault, prepared, overrides: { 'allow-remote-observation': false } })
      assert.equal(failureCode(rejected), 'REMOTE_OBSERVATION_NOT_ALLOWED')
      assert.deepEqual(protocolMutationSnapshot(fixture.vault), before)
    })
  })

  await context.test('wrong scope and environment', () => {
    withFixture((fixture) => {
      const prepared = setup(fixture, { pushAfterCommit: true })
      const before = protocolMutationSnapshot(fixture.vault)
      const wrongScope = observe({ repo: fixture.repo, vault: fixture.vault, prepared, overrides: { scope: 'refs/heads/main' } })
      assert.equal(failureCode(wrongScope), 'PUSH_SCOPE_CONFLICT')
      assert.deepEqual(protocolMutationSnapshot(fixture.vault), before)
      const wrongEnvironment = observe({ repo: fixture.repo, vault: fixture.vault, prepared, overrides: { environment: 'local-bare-origin' } })
      assert.equal(failureCode(wrongEnvironment), 'PUSH_ENVIRONMENT_CONFLICT')
      assert.deepEqual(protocolMutationSnapshot(fixture.vault), before)
    })
  })

  await context.test('remote ref does not equal live HEAD', () => {
    withFixture((fixture) => {
      const prepared = setup(fixture, { pushAfterCommit: false })
      const before = protocolMutationSnapshot(fixture.vault)
      const rejected = observe({ repo: fixture.repo, vault: fixture.vault, prepared })
      assert.equal(failureCode(rejected), 'PUSH_REMOTE_REF_CONFLICT')
      assert.deepEqual(protocolMutationSnapshot(fixture.vault), before)
    })
  })

  await context.test('unsafe and credential-bearing remote URLs are rejected before transport', () => {
    withFixture(({ root, repo, vault }) => {
      const remote = path.join(root, 'origin.git')
      run('git', ['init', '--bare', remote])
      git(repo, 'remote', 'add', 'origin', remote)
      register(repo, vault)
      const runRecord = begin(repo, vault)
      const afterHash = git(repo, 'rev-parse', 'HEAD')
      const cases = [
        ['ext::sh -c echo-unsafe', 'PUSH_REMOTE_PROTOCOL_UNSAFE'],
        ['custom://example.invalid/repo.git', 'PUSH_REMOTE_PROTOCOL_UNSAFE'],
        ['http://example.invalid/repo.git', 'PUSH_REMOTE_PROTOCOL_UNSAFE'],
        ['ssh://example.invalid/repo.git', 'PUSH_REMOTE_PROTOCOL_UNSAFE'],
        ['example.invalid:repo.git', 'PUSH_REMOTE_PROTOCOL_UNSAFE'],
        ['\\\\example.invalid\\share\\repo.git', 'PUSH_REMOTE_PROTOCOL_UNSAFE'],
        ['//example.invalid/share/repo.git', 'PUSH_REMOTE_PROTOCOL_UNSAFE'],
        ['file://example.invalid/share/repo.git', 'PUSH_REMOTE_PROTOCOL_UNSAFE'],
        ['https://user:password@example.invalid/repo.git', 'PUSH_REMOTE_CREDENTIALS_FORBIDDEN'],
        ['https://example.invalid/repo.git?token=secret', 'PUSH_REMOTE_CREDENTIALS_FORBIDDEN']
      ]
      for (const [target, code] of cases) {
        git(repo, 'config', '--replace-all', 'remote.origin.pushurl', target)
        const before = protocolMutationSnapshot(vault)
        const rejected = cli('checkpoint', {
          args: {
            repo,
            vault,
            run: runRecord.runId,
            session: runRecord.session,
            event: 'git',
            summary: 'Reject an unsafe remote observation target',
            'event-type': 'push',
            outcome: 'succeeded',
            attribution: 'observed',
            scope: 'forged-scope',
            environment: 'forged-environment',
            'after-hash': afterHash,
            remote: 'origin',
            ref: 'refs/heads/main',
            'allow-remote-observation': true,
            json: true
          },
          allowFailure: true
        })
        assert.equal(failureCode(rejected), code, target)
        assert.deepEqual(protocolMutationSnapshot(vault), before)
      }
    })
  })
})

test('revision reconciliation stales revision-bound supported claims and Recovery Card scopes progress to the current task', () => {
  withFixture(({ root, repo, vault }) => {
    configureLocalOrigin(root, repo)
    register(repo, vault)
    const run = begin(repo, vault)

    const files = { verification: path.join(root, 'verification.txt') }
    writeFileSync(files.verification, 'fixture verification passed\n', 'utf8')
    const capture = (file, kind) => cli('evidence', {
      args: { repo, vault, run: run.runId, session: run.session, file, kind }
    }).json.evidence.evidenceId
    const verificationEvidence = capture(files.verification, 'test-report')

    const createSupportedSet = (label) => {
      const analyzed = cli('checkpoint', {
        args: {
          repo,
          vault,
          run: run.runId,
          session: run.session,
          event: 'verification',
          summary: `${label} analyzed claim`,
          'claim-type': 'analyzed',
          'claim-status': 'supported',
          scope: `${label} source analysis`,
          evidence: verificationEvidence
        }
      }).json.event.eventId
      const verified = cli('checkpoint', {
        args: {
          repo,
          vault,
          run: run.runId,
          session: run.session,
          event: 'verification',
          summary: `${label} verified claim`,
          'claim-type': 'verified',
          'claim-status': 'supported',
          scope: `${label} verification`,
          evidence: verificationEvidence
        }
      }).json.event.eventId
      return { analyzed, verified }
    }

    const worktreeClaims = createSupportedSet('worktree-bound')
    writeFileSync(path.join(repo, 'src', 'index.js'), 'export function value() { return 11 }\n', 'utf8')
    cli('checkpoint', {
      args: {
        repo,
        vault,
        run: run.runId,
        session: run.session,
        event: 'change',
        summary: 'Reconcile the changed working tree',
        files: 'src/index.js'
      }
    })
    let state = authoritativeState(vault)
    assert.equal(state.claims.find((claim) => claim.sourceEvent === worktreeClaims.analyzed)?.status, 'stale')
    assert.equal(state.claims.find((claim) => claim.sourceEvent === worktreeClaims.verified)?.status, 'stale')
    cli('map', { args: { repo, vault, run: run.runId, session: run.session } })

    const headClaims = createSupportedSet('head-bound')
    git(repo, 'add', '--', 'src/index.js')
    git(repo, 'commit', '-m', 'advance fixture HEAD')
    cli('checkpoint', {
      args: {
        repo,
        vault,
        run: run.runId,
        session: run.session,
        event: 'git',
        summary: 'Reconcile the externally advanced HEAD',
        'reconcile-live-change': true,
        'reconcile-reason': 'The ordinary source commit is now the current checkout.'
      }
    })
    state = authoritativeState(vault)
    assert.equal(state.claims.find((claim) => claim.sourceEvent === headClaims.analyzed)?.status, 'stale')
    assert.equal(state.claims.find((claim) => claim.sourceEvent === headClaims.verified)?.status, 'stale')
    cli('map', { args: { repo, vault, run: run.runId, session: run.session } })

    const priorTaskId = state.task.id
    cli('finish', {
      args: {
        repo,
        vault,
        run: run.runId,
        session: run.session,
        status: 'partial',
        summary: 'Switch to a new unique task for Recovery Card scoping'
      }
    })
    const nextRun = begin(repo, vault, {
      task: 'A new current task with no claims',
      'transition-reason': 'The current user selected the next unique task.',
      authority: 'Current user authorizes switching to the next fixture task.',
      'current-session-authority': true
    })
    assert.ok(nextRun.runId)
    const card = cli('resume', { args: { repo, vault, json: true } }).json.card
    assert.equal(card.task.title, 'A new current task with no claims')
    assert.deepEqual(card.progress, [])
    state = authoritativeState(vault)
    assert.ok(state.claims.length >= 2)
    assert.ok(state.claims.every((claim) => claim.taskId === priorTaskId))
    assert.notEqual(state.task.id, priorTaskId)
  })
})
