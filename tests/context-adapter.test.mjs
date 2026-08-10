import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { cli, findFiles, parseJsonFile, withFixture } from './run-tests.mjs'

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ADAPTER = path.join(PROJECT_ROOT, 'skills', 'project-context-protocol', 'scripts', 'context-adapter.mjs')
const configuredChildTimeout = Number.parseInt(process.env.CONTEXT_PROTOCOL_TEST_CHILD_TIMEOUT_MS || '120000', 10)
const CHILD_TIMEOUT_MS = Number.isInteger(configuredChildTimeout) && configuredChildTimeout > 0 ? configuredChildTimeout : 120000

function embeddedJson(value) {
  const text = String(value || '').trim()
  for (let index = text.indexOf('{'); index !== -1; index = text.indexOf('{', index + 1)) {
    try {
      return JSON.parse(text.slice(index))
    } catch {
      // Git can emit a bounded upstream diagnostic before structured adapter output.
    }
  }
  return null
}

function adapter(command, args = {}, options = {}) {
  const selected = { ...args }
  if (
    command === 'session-start'
    && options.confirmVault !== false
    && !Object.hasOwn(selected, 'vault-confirmed-by-user')
  ) selected['vault-confirmed-by-user'] = true
  const argv = [ADAPTER, command]
  for (const [key, value] of Object.entries(selected)) {
    if (value === undefined || value === null || value === false) continue
    argv.push(`--${key}`)
    if (value !== true) argv.push(String(value))
  }
  if (options.child) argv.push('--', ...options.child)
  const result = spawnSync(process.execPath, argv, {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout ?? CHILD_TIMEOUT_MS,
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
  })
  if (result.error) throw result.error
  const json = embeddedJson(result.stdout) || embeddedJson(result.stderr)
  if (!options.allowFailure && result.status !== 0) throw new Error(`context-adapter ${command} failed (${result.status}): ${result.stderr || result.stdout}`)
  return { ...result, json, argv: argv.slice(1) }
}

function vaultSnapshot(vault) {
  return findFiles(vault, () => true).map((file) => [path.relative(vault, file), readFileSync(file).toString('base64')])
}

function runRecord(vault, runId) {
  const files = findFiles(vault, (absolute, name) => name === `${runId}.json` && absolute.includes(`${path.sep}runs${path.sep}`))
  assert.equal(files.length, 1)
  return { file: files[0], value: parseJsonFile(files[0]) }
}

test('session-start stops before any Vault access without current-user path confirmation', () => {
  withFixture(({ repo, vault }) => {
    const result = adapter('session-start', {
      repo,
      vault,
      task: 'Must not start before location confirmation'
    }, { allowFailure: true, confirmVault: false })
    assert.notEqual(result.status, 0)
    assert.equal(result.json.error.code, 'VAULT_LOCATION_CONFIRMATION_REQUIRED')
    assert.equal(result.argv.includes('--vault-confirmed-by-user'), false)
    assert.equal(existsSync(vault), false)

    cli('register', { args: { repo, vault, task: 'Historical confirmation must not authorize a new session' } })
    const before = vaultSnapshot(vault)
    const historicalOnly = adapter('session-start', {
      repo,
      vault
    }, { allowFailure: true, confirmVault: false })
    assert.notEqual(historicalOnly.status, 0)
    assert.equal(historicalOnly.json.error.code, 'VAULT_LOCATION_CONFIRMATION_REQUIRED')
    assert.equal(Object.hasOwn(historicalOnly.json, 'recovery'), false)
    assert.deepEqual(vaultSnapshot(vault), before)
  })
})

test('session-start fails safely when no unique task can be adopted', () => {
  withFixture(({ repo, vault }) => {
    const result = adapter('session-start', { repo, vault }, { allowFailure: true })
    assert.equal(result.status, 3)
    assert.equal(result.json.started, false)
    assert.equal(result.json.recovery.trust.status, 'UNMANAGED')
    assert.equal(result.json.recovery.vaultSelection.currentSessionDeclarationRecorded, true)
    assert.equal(result.json.capture.degraded, true)
    assert.match(result.json.capture.warning, /No installed lifecycle Hook/i)
  })
})

test('session-start rejects an unknown route event before creating a run or touching the selected store', () => {
  withFixture(({ repo, vault }) => {
    const result = adapter('session-start', {
      repo,
      vault,
      task: 'Reject route typos before begin',
      'route-event': 'deply'
    }, { allowFailure: true })
    assert.notEqual(result.status, 0)
    assert.equal(result.json.error.code, 'ROUTE_SIGNAL_UNKNOWN')
    assert.equal(existsSync(vault), false)
  })
})

test('session-start rejects an explicitly blank route event before touching the selected store', () => {
  withFixture(({ repo, vault }) => {
    const result = adapter('session-start', {
      repo,
      vault,
      task: 'Reject an explicitly blank route signal',
      'route-event': ''
    }, { allowFailure: true })
    assert.notEqual(result.status, 0)
    assert.equal(result.json.error.code, 'ROUTE_SIGNAL_EMPTY')
    assert.equal(existsSync(vault), false)
  })
})

test('session-start adopts a persisted UNMANAGED registration through begin and keeps capture declarations consistent', () => {
  withFixture(({ repo, vault }) => {
    const unmanaged = cli('register', { args: { repo, vault } }).json
    assert.equal(unmanaged.recovery.trust.status, 'UNMANAGED')

    const started = adapter('session-start', {
      repo,
      vault,
      task: 'Adopt the first managed task without a circular run requirement',
      'hook-mediated': true
    }).json
    assert.equal(started.started, true)
    assert.equal(started.route.executable, true)
    assert.equal(started.capture.coverage, 'mediated-supported-lifecycle-events')
    assert.equal(started.recovery.capture.coverage, started.capture.coverage)
    assert.match(started.recovery.capture.mode, /context-adapter\/lifecycle-hook/)
  })
})

test('adapter-created runs preserve the current-session record layout selection', () => {
  withFixture(({ repo, vault }) => {
    const started = adapter('session-start', {
      repo,
      store: vault,
      'store-confirmed-by-user': true,
      'record-layout': 'hybrid',
      task: 'Bind the selected record layout into the run'
    }).json
    assert.equal(started.started, true)
    assert.equal(started.recovery.recordLayout, 'hybrid')
    assert.equal(started.recovery.vaultSelection.recordLayout, 'hybrid')
    assert.equal(runRecord(vault, started.runId).value.vaultSelection.recordLayout, 'hybrid')
  })
})

test('the new store interface carries its explicit layout through the full adapter lifecycle', () => {
  withFixture(({ repo, vault }) => {
    const common = { repo, store: vault, 'record-layout': 'hybrid' }
    const started = adapter('session-start', {
      ...common,
      'store-confirmed-by-user': true,
      task: 'Exercise the explicit-layout adapter lifecycle'
    }).json
    assert.equal(started.recovery.recordLayout, 'hybrid')
    const authenticated = { ...common, run: started.runId, session: started.session }
    assert.equal(adapter('heartbeat', { ...authenticated, summary: 'Renewed explicit-layout lifecycle.' }).json.leaseRenewed, true)
    assert.equal(adapter('checkpoint', { ...authenticated, event: 'observation', summary: 'Recorded explicit-layout lifecycle checkpoint.' }).json.checkpoint.command, 'checkpoint')
    const stopped = adapter('session-stop', { ...authenticated, summary: 'Closed explicit-layout lifecycle as partial.' }).json
    assert.equal(stopped.finished.status, 'partial')
    assert.equal(runRecord(vault, started.runId).value.vaultSelection.recordLayout, 'hybrid')
  })
})

test('session-start can return a high-risk recording route without executing the host action', () => {
  withFixture(({ repo, vault }) => {
    const started = adapter('session-start', {
      repo,
      store: vault,
      'store-confirmed-by-user': true,
      'record-layout': 'hybrid',
      task: 'Record a host-governed push boundary',
      'route-event': 'push',
      authority: 'The current user authorizes the host to decide whether to push.',
      'current-session-authority': true
    })
    assert.equal(started.status, 0)
    assert.equal(started.json.started, true)
    assert.equal(started.json.route.mode, 'release-with-provenance')
    assert.equal(started.json.route.recordingReady, true)
    assert.equal(started.json.route.executable, false)
    assert.equal(started.json.route.protocolExecutesAction, false)
  })
})

test('an existing non-empty Windows vault without an ACL marker fails closed', (context) => {
  if (process.platform !== 'win32') {
    context.skip('Windows ACL migration gate is Windows-specific; non-Windows behavior is asserted by the marker test.')
    return
  }
  withFixture(({ repo, vault }) => {
    mkdirSync(vault, { recursive: true })
    const sentinel = path.join(vault, 'legacy-record.txt')
    writeFileSync(sentinel, 'legacy local record\n', 'utf8')
    const rejected = cli('register', {
      args: { repo, vault, task: 'Do not silently migrate old ACLs', json: true },
      allowFailure: true
    })
    assert.notEqual(rejected.status, 0)
    assert.equal(rejected.json.error.code, 'VAULT_ACL_MIGRATION_REQUIRED')
    assert.equal(readFileSync(sentinel, 'utf8'), 'legacy local record\n')
    assert.equal(existsSync(path.join(vault, '.vault-acl.json')), false)
  })
})

test('adapter lifecycle creates, heartbeats, and partially closes one leased run', async () => {
  await withFixture(async ({ repo, vault }) => {
    const started = adapter('session-start', {
      repo,
      vault,
      task: 'Exercise the lifecycle adapter',
      request: 'Record one adapter-managed session',
      'lease-seconds': 30
    }).json
    assert.equal(started.started, true)
    assert.equal(started.route.executable, true)
    assert.equal(started.capture.coverage, 'degraded-no-installed-hook')
    const aclMarker = parseJsonFile(path.join(vault, '.vault-acl.json'))
    if (process.platform === 'win32') {
      assert.equal(aclMarker.status, 'hardened-and-verified')
      assert.equal(aclMarker.enforced, true)
      assert.match(aclMarker.fingerprint, /^[a-f0-9]{64}$/)
    } else {
      assert.equal(aclMarker.status, 'degraded-non-windows-not-enforced')
      assert.equal(aclMarker.enforced, false)
    }
    assert.equal(Object.hasOwn(aclMarker, 'rules'), false)
    assert.equal(Object.hasOwn(aclMarker, 'currentSid'), false)
    const before = runRecord(vault, started.runId).value
    assert.equal(before.lease.protocol, 'project-context/run-lease/v1')
    assert.equal(before.lease.ttlSeconds, 30)

    await new Promise((resolve) => setTimeout(resolve, 25))
    const beat = adapter('heartbeat', {
      repo,
      vault,
      run: started.runId,
      session: started.session
    }).json
    assert.equal(beat.leaseRenewed, true)
    const after = runRecord(vault, started.runId).value
    assert.ok(Date.parse(after.lease.heartbeatAt) > Date.parse(before.lease.heartbeatAt))
    assert.ok(Date.parse(after.lease.expiresAt) > Date.parse(before.lease.expiresAt))

    const stopped = adapter('session-stop', {
      repo,
      vault,
      run: started.runId,
      session: started.session
    }).json
    assert.equal(stopped.finished.status, 'partial')
    assert.equal(stopped.inferredCompletion, false)
    const finalRun = runRecord(vault, started.runId).value
    assert.equal(finalRun.status, 'partial')
    assert.match(readFileSync(runRecord(vault, started.runId).file, 'utf8'), /"lease"/)
  })
})

test('session-stop never infers completed status', () => {
  withFixture(({ repo, vault }) => {
    const started = adapter('session-start', { repo, vault, task: 'Do not infer completion' }).json
    const rejected = adapter('session-stop', {
      repo,
      vault,
      run: started.runId,
      session: started.session,
      status: 'completed'
    }, { allowFailure: true })
    assert.notEqual(rejected.status, 0)
    assert.equal(rejected.json.error.code, 'ADAPTER_COMPLETION_NOT_INFERRED')
    assert.equal(runRecord(vault, started.runId).value.status, 'active')
  })
})

test('an invalid session-stop status leaves the immutable event chain and run record unchanged', () => {
  withFixture(({ repo, vault }) => {
    const started = adapter('session-start', { repo, vault, task: 'Reject invalid lifecycle status without side effects' }).json
    const before = vaultSnapshot(vault)
    const rejected = adapter('session-stop', {
      repo,
      vault,
      run: started.runId,
      session: started.session,
      status: 'done',
      summary: 'This invalid status must not append a handoff.'
    }, { allowFailure: true })
    assert.notEqual(rejected.status, 0)
    assert.equal(rejected.json.error.code, 'RUN_STATUS_INVALID')
    assert.deepEqual(vaultSnapshot(vault), before)
    assert.equal(runRecord(vault, started.runId).value.status, 'active')
  })
})

test('an expired active-run lease is disconnected and cannot be revived or promoted', async () => {
  await withFixture(async ({ repo, vault }) => {
    const started = adapter('session-start', {
      repo,
      vault,
      task: 'Exercise disconnected-run recovery',
      'lease-seconds': 5
    }).json
    await new Promise((resolve) => setTimeout(resolve, 5_150))

    const resumed = cli('resume', { args: { repo, vault, json: true }, allowFailure: true })
    assert.equal(resumed.status, 3)
    assert.equal(resumed.json.card.trust.status, 'CONFLICT')
    assert.match(resumed.json.card.trust.reasons.join(' '), /lease expired|disconnected/i)

    const rejectedHeartbeat = adapter('heartbeat', {
      repo,
      vault,
      run: started.runId,
      session: started.session
    }, { allowFailure: true })
    assert.notEqual(rejectedHeartbeat.status, 0)
    assert.equal(rejectedHeartbeat.json.error.code, 'RUN_LEASE_EXPIRED')
    assert.equal(runRecord(vault, started.runId).value.status, 'active')
  })
})

test('standalone adapter launch rejects before starting its child or creating a vault', () => {
  withFixture(({ root, repo, vault }) => {
    const marker = path.join(root, 'child-started.txt')
    const child = [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'started')`]
    const result = adapter('launch', {
      repo,
      vault,
      task: 'The standalone adapter must never launch this child',
      'heartbeat-seconds': 1
    }, { child, allowFailure: true })
    assert.notEqual(result.status, 0)
    assert.equal(result.json.error.code, 'STANDALONE_CHILD_EXECUTION_DISABLED')
    assert.equal(existsSync(marker), false)
    assert.equal(existsSync(vault), false)
  })
})

test('adapter help omits launch from supported usage', () => {
  withFixture(() => {
    const result = adapter('help')
    assert.equal(result.status, 0)
    assert.doesNotMatch(result.stdout, /^\s*context-adapter launch\b/m)
    assert.match(result.stdout, /never launches child programs/i)
  })
})
