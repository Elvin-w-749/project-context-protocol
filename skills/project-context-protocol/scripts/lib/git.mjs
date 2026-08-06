import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readlinkSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { canonicalPath, sha256, sha256File } from './util.mjs'

function sanitizedGitEnvironment() {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
  for (const key of [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE'
  ]) delete env[key]
  for (const key of [
    'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_PROXY_COMMAND',
    'GIT_CONFIG_COUNT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM'
  ]) delete env[key]
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete env[key]
  }
  return env
}

function git(repo, args, { allowFailure = false, trim = true, encoding = 'utf8' } = {}) {
  try {
    const output = execFileSync('git', [
      '-c', 'core.fsmonitor=false',
      '-c', 'core.untrackedCache=false',
      '-C', repo,
      ...args
    ], {
      encoding,
      env: sanitizedGitEnvironment(),
      windowsHide: true,
      maxBuffer: 128 * 1024 * 1024
    })
    return trim && typeof output === 'string' ? output.trim() : output
  } catch (error) {
    if (allowFailure) return ''
    const message = error.stderr?.toString().trim() || error.message
    const wrapped = new Error(`git ${args.join(' ')} failed: ${message}`)
    wrapped.code = 'GIT_COMMAND_FAILED'
    wrapped.gitArgs = args
    throw wrapped
  }
}

export function gitIsolated(args, { trim = true, encoding = 'utf8' } = {}) {
  const isolatedHome = mkdtempSync(path.join(os.tmpdir(), 'contextctl-git-observe-'))
  const env = sanitizedGitEnvironment()
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : os.devNull,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    XDG_CONFIG_HOME: isolatedHome,
    CURL_HOME: isolatedHome
  })
  for (const key of [
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    'NETRC', 'GIT_SSL_CERT', 'GIT_SSL_KEY', 'GIT_SSH_VARIANT'
  ]) delete env[key]
  try {
    const output = execFileSync('git', args, {
      cwd: isolatedHome,
      encoding,
      env,
      windowsHide: true,
      maxBuffer: 128 * 1024 * 1024
    })
    return trim && typeof output === 'string' ? output.trim() : output
  } catch (error) {
    const message = error.stderr?.toString().trim() || error.message
    const wrapped = new Error(`isolated git ${args.join(' ')} failed: ${message}`)
    wrapped.code = 'GIT_COMMAND_FAILED'
    wrapped.gitArgs = args
    throw wrapped
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true })
  }
}

function splitNull(output) {
  return output.split('\0').filter(Boolean)
}

export function normalizeRemote(remote) {
  if (!remote) return null
  const input = remote.trim()
  if (path.isAbsolute(input) || /^[.]{1,2}[\\/]/.test(input)) {
    return `local-remote:${canonicalPath(input)}`
  }
  const scp = input.includes('://') ? null : input.match(/^(?:[^@/]+@)?([^:]+):(.+)$/)
  const expanded = scp && !/^[A-Za-z]:[\\/]/.test(input) ? `ssh://${scp[1]}/${scp[2]}` : input
  try {
    const parsed = new URL(expanded)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    parsed.pathname = parsed.pathname.replace(/\.git$/i, '').replace(/\/$/, '')
    return parsed.toString().replace(/\/$/, '')
  } catch {
    const local = expanded.replace(/\.git$/i, '').replace(/[\\/]$/, '')
    return `local-remote:${canonicalPath(local)}`
  }
}

function workingPathFingerprint(root, relativePaths) {
  const entries = []
  for (const relative of [...new Set(relativePaths)].sort((a, b) => a.localeCompare(b))) {
    const absolute = path.join(root, relative)
    try {
      const stats = lstatSync(absolute)
      if (stats.isSymbolicLink()) {
        entries.push(`${relative}\0symlink\0${readlinkSync(absolute)}`)
      } else if (stats.isFile()) {
        entries.push(`${relative}\0file\0${stats.size}\0${sha256File(absolute)}`)
      } else {
        entries.push(`${relative}\0other\0${stats.mode}\0${stats.size}`)
      }
    } catch (error) {
      if (!existsSync(absolute)) entries.push(`${relative}\0missing`)
      else throw error
    }
  }
  return sha256(entries.join('\n'))
}

export function discoverRepository(inputPath) {
  const requested = canonicalPath(inputPath)
  const root = canonicalPath(git(requested, ['rev-parse', '--show-toplevel']))
  const gitCommonDir = canonicalPath(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
  const gitDir = canonicalPath(git(root, ['rev-parse', '--path-format=absolute', '--git-dir']))
  const head = git(root, ['rev-parse', 'HEAD'])
  const tree = git(root, ['rev-parse', 'HEAD^{tree}'])
  const branch = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true }) || null
  const upstream = git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { allowFailure: true }) || null
  const remoteRaw = git(root, ['remote', 'get-url', 'origin'], { allowFailure: true }) || null
  const canonicalRemote = normalizeRemote(remoteRaw)
  const status = git(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all'], { trim: false })
  const statusLines = splitNull(status)
  const indexManifest = git(root, ['ls-files', '-s', '-z'], { trim: false })
  const modified = splitNull(git(root, ['diff', '--name-only', '-z'], { trim: false }))
  const staged = splitNull(git(root, ['diff', '--cached', '--name-only', '-z'], { trim: false }))
  const untracked = splitNull(git(root, ['ls-files', '--others', '--exclude-standard', '-z'], { trim: false }))
  const changedPaths = [...new Set([...modified, ...staged, ...untracked])].sort((a, b) => a.localeCompare(b))
  const contentFingerprint = workingPathFingerprint(root, changedPaths)
  const statusFingerprint = sha256(`${status}\0${indexManifest}\0${contentFingerprint}`)
  const repoBasis = canonicalRemote || `local:${gitCommonDir}`
  const repoId = `repo-${sha256(repoBasis).slice(0, 20)}`
  const workspaceId = `workspace-${sha256(`${gitCommonDir}\0${root}`).slice(0, 20)}`
  const contextBasis = branch ? `branch:${branch}` : 'detached-worktree'
  const contextId = `context-${sha256(contextBasis).slice(0, 20)}`

  return {
    root,
    requestedPath: requested,
    gitCommonDir,
    gitDir,
    repoId,
    workspaceId,
    contextId,
    canonicalRemote,
    remoteObserved: canonicalRemote,
    branch,
    detached: !branch,
    head,
    tree,
    upstream,
    statusLines,
    changedPaths,
    dirty: statusLines.length > 0,
    statusFingerprint,
    contentFingerprint,
    observedAt: new Date().toISOString()
  }
}

export function listRepositoryFiles(repo) {
  const tracked = splitNull(git(repo, ['ls-files', '-z'], { trim: false }))
  const others = splitNull(git(repo, ['ls-files', '--others', '--exclude-standard', '-z'], { trim: false }))
  return {
    tracked,
    untracked: others,
    all: [...new Set([...tracked, ...others])].sort((a, b) => a.localeCompare(b))
  }
}

export function gitDiffNameStatus(repo, base = null) {
  const args = base ? ['diff', '--name-status', `${base}..HEAD`] : ['status', '--short']
  const output = git(repo, args)
  return output ? output.split(/\r?\n/).filter(Boolean) : []
}

export function gitShow(repo, ref, file) {
  return git(repo, ['show', `${ref}:${file}`])
}

export function gitBlobFromIndex(repo, file) {
  return git(repo, ['show', `:${file}`], { trim: false, encoding: null })
}

export function isGitRepository(directory) {
  return git(directory, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true }) === 'true'
}

export { git }
