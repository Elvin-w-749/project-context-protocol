import { createHash } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url))
export const PROJECT_ROOT = path.dirname(TESTS_DIR)
const configuredChildTimeout = Number.parseInt(process.env.CONTEXT_PROTOCOL_TEST_CHILD_TIMEOUT_MS || '120000', 10)
const CHILD_TIMEOUT_MS = Number.isInteger(configuredChildTimeout) && configuredChildTimeout > 0 ? configuredChildTimeout : 120000
export const CLI = path.join(
  PROJECT_ROOT,
  'skills',
  'project-context-protocol',
  'scripts',
  'contextctl.mjs'
)

function processEnvironment() {
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0'
  }
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_NAMESPACE'
  ]) delete env[key]
  return env
}

function parseEmbeddedJson(candidate) {
  const trimmed = candidate.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    for (let index = trimmed.indexOf('{'); index !== -1; index = trimmed.indexOf('{', index + 1)) {
      try {
        return JSON.parse(trimmed.slice(index))
      } catch {
        // Git may emit a bounded diagnostic before contextctl writes JSON to stderr.
      }
    }
    return null
  }
}

function cliArguments(command, values, options = {}) {
  const selected = { ...(values || {}) }
  if (
    ['resume', 'register', 'begin', 'verify', 'doctor'].includes(command)
    && options.confirmVault !== false
    && !Object.hasOwn(selected, 'vault-confirmed-by-user')
  ) selected['vault-confirmed-by-user'] = true
  const args = [CLI, command]
  for (const [key, raw] of Object.entries(selected)) {
    if (raw === undefined || raw === null || raw === false) continue
    args.push(`--${key}`)
    if (raw !== true) args.push(String(raw))
  }
  return args
}

export function run(program, args, options = {}) {
  return execFileSync(program, args, {
    cwd: options.cwd,
    encoding: options.encoding ?? 'utf8',
    env: processEnvironment(),
    windowsHide: true,
    timeout: options.timeout ?? CHILD_TIMEOUT_MS,
    maxBuffer: 128 * 1024 * 1024,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe']
  })
}

export function git(repo, ...args) {
  return run('git', ['-C', repo, ...args]).trim()
}

export function createRepository(directory, files = {}) {
  run('git', ['init', directory])
  git(directory, 'config', 'user.name', 'Context Protocol Tests')
  git(directory, 'config', 'user.email', 'context-protocol-tests@example.invalid')
  git(directory, 'checkout', '-b', 'main')
  const defaults = {
    'README.md': '# Temporary fixture\n',
    'package.json': '{\n  "name": "contextctl-fixture",\n  "private": true,\n  "scripts": { "test": "node --test" }\n}\n',
    'src/index.js': 'export function value() { return 1 }\n'
  }
  for (const [relative, content] of Object.entries({ ...defaults, ...files })) {
    const target = path.join(directory, relative)
    const parent = path.dirname(target)
    if (!existsSync(parent)) run(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(parent)},{recursive:true})`])
    writeFileSync(target, content, 'utf8')
  }
  git(directory, 'add', '--all')
  git(directory, 'commit', '-m', 'fixture')
  return realpathSync.native(directory)
}

export function cli(command, options = {}) {
  const args = cliArguments(command, options.args, options)
  const result = spawnSync(process.execPath, args, {
    cwd: options.cwd || PROJECT_ROOT,
    encoding: 'utf8',
    env: processEnvironment(),
    windowsHide: true,
    timeout: options.timeout ?? CHILD_TIMEOUT_MS,
    maxBuffer: 128 * 1024 * 1024
  })
  if (result.error) throw result.error
  const stdout = result.stdout || ''
  const stderr = result.stderr || ''
  let json = null
  for (const candidate of [stdout, stderr]) {
    json = parseEmbeddedJson(candidate)
    if (json) break
  }
  const response = { status: result.status, signal: result.signal, stdout, stderr, json, command, argv: args.slice(1) }
  if (!options.allowFailure && result.status !== 0) {
    const error = new Error(`contextctl ${command} failed (${result.status}): ${stderr || stdout}`)
    error.response = response
    throw error
  }
  return response
}

export function cliAsync(command, options = {}) {
  const args = cliArguments(command, options.args, options)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd || PROJECT_ROOT,
      env: processEnvironment(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    let settled = false
    const timeoutMs = options.timeout ?? CHILD_TIMEOUT_MS
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(Object.assign(new Error(`contextctl ${command} exceeded the ${timeoutMs}ms test child timeout`), { code: 'TEST_CHILD_TIMEOUT' }))
    }, timeoutMs)
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (status, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const json = parseEmbeddedJson(stdout) || parseEmbeddedJson(stderr)
      resolve({ status, signal, stdout, stderr, json, command, argv: args.slice(1) })
    })
  })
}

export function withFixture(callback, name = 'contextctl-') {
  const root = mkdtempSync(path.join(os.tmpdir(), name))
  const fixture = {
    root,
    repo: path.join(root, 'target-repository'),
    vault: path.join(root, 'local-vault'),
    evidence: path.join(root, 'evidence.txt')
  }
  const cleanup = () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  let result
  try {
    createRepository(fixture.repo)
    writeFileSync(fixture.evidence, 'local-only evidence\n', 'utf8')
    result = callback(fixture)
  } catch (error) {
    cleanup()
    throw error
  }
  if (result && typeof result.then === 'function') return Promise.resolve(result).finally(cleanup)
  cleanup()
  return result
}

function splitNull(value) {
  return value.split('\0').filter(Boolean)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function workspaceEntry(repo, relative) {
  const absolute = path.join(repo, relative)
  const stat = lstatSync(absolute)
  if (stat.isSymbolicLink()) return `${relative}\0symlink\0${readlinkSync(absolute)}`
  if (stat.isFile()) return `${relative}\0file\0${stat.mode}\0${stat.size}\0${sha256(readFileSync(absolute))}`
  return `${relative}\0other\0${stat.mode}\0${stat.size}`
}

export function snapshotRepository(repo) {
  const head = git(repo, 'rev-parse', 'HEAD')
  const status = run('git', [
    '-c', 'core.fsmonitor=false',
    '-c', 'core.untrackedCache=false',
    '-C', repo,
    'status', '--porcelain=v2', '-z', '--untracked-files=all'
  ], { encoding: 'utf8' })
  const files = splitNull(run('git', [
    '-C', repo,
    'ls-files', '--cached', '--others', '--exclude-standard', '-z'
  ], { encoding: 'utf8' })).sort((a, b) => a.localeCompare(b))
  const content = files.map((relative) => workspaceEntry(repo, relative))
  return {
    head,
    status,
    files,
    contentFingerprint: sha256(content.join('\n'))
  }
}

export function findFiles(root, predicate) {
  const matches = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile() && predicate(absolute, entry.name)) matches.push(absolute)
    }
  }
  if (existsSync(root)) visit(root)
  return matches.sort((a, b) => a.localeCompare(b))
}

export function currentStateFiles(vault) {
  return findFiles(vault, (_absolute, name) => name === 'current.json')
}

export function parseJsonFile(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}
