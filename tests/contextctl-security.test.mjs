import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
  cli,
  createRepository,
  currentStateFiles,
  findFiles,
  git,
  parseJsonFile,
  snapshotRepository,
  withFixture
} from './run-tests.mjs'

function register(repo, vault) {
  return cli('register', { args: { repo, vault, task: 'Security boundary fixture' } }).json
}

function begin(repo, vault, extra = {}) {
  return cli('begin', { args: { repo, vault, request: 'Run security boundary tests', ...extra } }).json
}

function failureCode(response) {
  return response.json?.error?.code || null
}

test('vault paths inside the target or any other Git repository are rejected', () => {
  withFixture(({ root, repo }) => {
    const before = snapshotRepository(repo)

    const insideTarget = cli('register', {
      args: { repo, vault: path.join(repo, '.project-context'), task: 'Must fail', json: true },
      allowFailure: true
    })
    assert.notEqual(insideTarget.status, 0)
    assert.equal(failureCode(insideTarget), 'VAULT_INSIDE_REPOSITORY')

    const otherRepo = path.join(root, 'unrelated-repository')
    createRepository(otherRepo, { 'README.md': '# Other repository\n' })
    const insideOther = cli('register', {
      args: { repo, vault: path.join(otherRepo, 'nested-vault'), task: 'Must fail', json: true },
      allowFailure: true
    })
    assert.notEqual(insideOther.status, 0)
    assert.equal(failureCode(insideOther), 'VAULT_INSIDE_OTHER_REPOSITORY')

    assert.deepEqual(snapshotRepository(repo), before)
  })
})

test('unsafe run identifiers and pointer traversal are rejected without escaping the vault', () => {
  withFixture(({ root, repo, vault }) => {
    register(repo, vault)
    const run = begin(repo, vault)
    const before = snapshotRepository(repo)

    const maliciousRun = cli('finish', {
      args: {
        repo,
        vault,
        run: '../../outside',
        session: run.session,
        status: 'completed',
        summary: 'must fail',
        json: true
      },
      allowFailure: true
    })
    assert.notEqual(maliciousRun.status, 0)
    assert.equal(failureCode(maliciousRun), 'RUN_NOT_ACTIVE_IN_CONTEXT')

    const pointers = currentStateFiles(vault)
    assert.equal(pointers.length, 2, 'one state pointer and one map pointer are expected')
    const statePointer = pointers.find((file) => file.includes(`${path.sep}state${path.sep}current.json`))
    assert.ok(statePointer)
    const pointer = parseJsonFile(statePointer)
    pointer.file = `..${path.sep}..${path.sep}outside.json`
    writeFileSync(statePointer, `${JSON.stringify(pointer, null, 2)}\n`, 'utf8')

    const traversal = cli('verify', {
      args: { repo, vault, json: true },
      allowFailure: true
    })
    assert.notEqual(traversal.status, 0)
    assert.equal(failureCode(traversal), 'STATE_POINTER_INVALID')
    assert.equal(existsSync(path.join(root, 'outside.json')), false)
    assert.deepEqual(snapshotRepository(repo), before)
  })
})

test('dirty fingerprint changes when bytes change at the same path and size', () => {
  withFixture(({ repo, vault }) => {
    register(repo, vault)
    const target = path.join(repo, 'src', 'index.js')
    const original = readFileSync(target, 'utf8')
    const first = original.replace('return 1', 'return 2')
    const second = original.replace('return 1', 'return 3')
    assert.equal(Buffer.byteLength(first), Buffer.byteLength(second))

    writeFileSync(target, first, 'utf8')
    const firstCard = cli('resume', { args: { repo, vault, json: true }, allowFailure: true }).json.card
    writeFileSync(target, second, 'utf8')
    const secondCard = cli('resume', { args: { repo, vault, json: true }, allowFailure: true }).json.card

    assert.equal(firstCard.repository.dirty, true)
    assert.equal(secondCard.repository.dirty, true)
    assert.notEqual(firstCard.repository.statusFingerprint, secondCard.repository.statusFingerprint)
    assert.equal(firstCard.trust.status, 'STALE')
    assert.equal(secondCard.trust.status, 'STALE')
  })
})

test('branch worktrees and detached worktrees receive isolated workspace/context state', () => {
  withFixture(({ root, repo, vault }) => {
    const branchWorktree = path.join(root, 'feature-worktree')
    const detachedWorktree = path.join(root, 'detached-worktree')
    git(repo, 'worktree', 'add', '-b', 'feature/context-test', branchWorktree, 'HEAD')
    git(repo, 'worktree', 'add', '--detach', detachedWorktree, 'HEAD')

    const primary = register(repo, vault).state.repo
    const feature = register(branchWorktree, vault).state.repo
    const detached = register(detachedWorktree, vault).state.repo

    assert.equal(primary.repoId, feature.repoId)
    assert.equal(primary.repoId, detached.repoId)
    assert.notEqual(primary.workspaceId, feature.workspaceId)
    assert.notEqual(primary.workspaceId, detached.workspaceId)
    assert.notEqual(feature.workspaceId, detached.workspaceId)
    assert.notEqual(primary.contextId, feature.contextId)
    assert.notEqual(feature.contextId, detached.contextId)
    assert.equal(detached.branch, null)

    writeFileSync(path.join(repo, 'src', 'second.js'), 'export const second = true\n', 'utf8')
    git(repo, 'add', 'src/second.js')
    git(repo, 'commit', '-m', 'second fixture commit')
    const movedHead = git(repo, 'rev-parse', 'HEAD')
    git(detachedWorktree, 'checkout', '--detach', movedHead)
    const moved = cli('resume', { args: { repo: detachedWorktree, vault, json: true }, allowFailure: true }).json.card
    assert.equal(moved.trust.status, 'STALE')
    assert.equal(moved.repository.contextId, detached.contextId)

    const statePointers = currentStateFiles(vault).filter((file) => file.includes(`${path.sep}state${path.sep}current.json`))
    assert.equal(statePointers.length, 3)
    assert.equal(new Set(statePointers.map((file) => path.dirname(path.dirname(file)))).size, 3)
  })
})

test('verify detects tampered event records', () => {
  withFixture(({ repo, vault }) => {
    register(repo, vault)
    const run = begin(repo, vault)
    cli('checkpoint', {
      args: { repo, vault, run: run.runId, session: run.session, event: 'observation', summary: 'Original event' }
    })
    const event = findFiles(vault, (absolute, name) => name === '000002.json' && absolute.includes(`${path.sep}${run.runId}${path.sep}`))[0]
    assert.ok(event)
    const record = parseJsonFile(event)
    record.summary = 'Tampered without resealing'
    writeFileSync(event, `${JSON.stringify(record, null, 2)}\n`, 'utf8')

    const verification = cli('verify', { args: { repo, vault }, allowFailure: true })
    assert.equal(verification.status, 2)
    assert.equal(verification.json.valid, false)
    assert.ok(verification.json.errors.some((message) => /invalid event sequence/i.test(message)))
  })
})

test('verify detects tampered authoritative state generations', () => {
  withFixture(({ repo, vault }) => {
    register(repo, vault)
    const resumed = cli('resume', { args: { repo, vault, json: true } }).json
    const generation = resumed.card.references.machineState
    const state = parseJsonFile(generation)
    state.task.title = 'Tampered without updating the pointer hash'
    writeFileSync(generation, `${JSON.stringify(state, null, 2)}\n`, 'utf8')

    const verification = cli('verify', {
      args: { repo, vault, json: true },
      allowFailure: true
    })
    assert.notEqual(verification.status, 0)
    assert.equal(failureCode(verification), 'STATE_GENERATION_CORRUPT')
  })
})
