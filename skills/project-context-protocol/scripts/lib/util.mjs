import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const PROTOCOL_VERSION = 'project-context/v1'

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function hmacSha256(secret, value) {
  return createHmac('sha256', secret).update(value).digest('hex')
}

export function secureHexEqual(left, right) {
  const first = Buffer.from(String(left || ''), 'hex')
  const second = Buffer.from(String(right || ''), 'hex')
  return first.length > 0 && first.length === second.length && timingSafeEqual(first, second)
}

export function randomSecret(bytes = 32) {
  return randomBytes(bytes).toString('hex')
}

export function sha256File(file) {
  const hash = createHash('sha256')
  const descriptor = openSync(file, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let bytesRead
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
  } finally {
    closeSync(descriptor)
  }
  return hash.digest('hex')
}

export function nowIso() {
  return new Date().toISOString()
}

export function randomId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  return `${prefix}-${stamp}-${randomBytes(4).toString('hex')}`
}

export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
  }
  return value
}

export function stableJson(value, space = 2) {
  return `${JSON.stringify(stableValue(value), null, space)}\n`
}

export function parseArgs(argv) {
  const parsed = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) {
      parsed._.push(item)
      continue
    }
    const equals = item.indexOf('=')
    if (equals !== -1) {
      parsed[item.slice(2, equals)] = item.slice(equals + 1)
      continue
    }
    const key = item.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      parsed[key] = next
      index += 1
    } else {
      parsed[key] = true
    }
  }
  return parsed
}

export function splitList(value) {
  if (!value) return []
  return String(value).split(',').map((item) => item.trim()).filter(Boolean)
}

export function ensureDir(directory) {
  mkdirSync(directory, { recursive: true })
  return directory
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function atomicWrite(file, content) {
  ensureDir(path.dirname(file))
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  const recovery = path.join(path.dirname(file), `.${path.basename(file)}.recovery.bak`)
  const descriptor = openSync(temp, 'wx', 0o600)
  try {
    writeFileSync(descriptor, content, 'utf8')
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  try {
    renameSync(temp, file)
  } catch (error) {
    if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code) || !existsSync(file)) {
      rmSync(temp, { force: true })
      throw error
    }
    rmSync(recovery, { force: true })
    renameSync(file, recovery)
    try {
      renameSync(temp, file)
      rmSync(recovery, { force: true })
    } catch (replaceError) {
      if (!existsSync(file) && existsSync(recovery)) renameSync(recovery, file)
      rmSync(temp, { force: true })
      throw replaceError
    }
  }
  syncDirectory(path.dirname(file))
}

export function atomicCreate(file, content) {
  ensureDir(path.dirname(file))
  const descriptor = openSync(file, 'wx', 0o600)
  try {
    writeFileSync(descriptor, content, 'utf8')
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  syncDirectory(path.dirname(file))
}

function syncDirectory(directory) {
  if (process.platform === 'win32') return
  let descriptor
  try {
    descriptor = openSync(directory, 'r')
    fsyncSync(descriptor)
  } catch {
    // Some file systems do not permit directory fsync; file fsync still applies.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

export function recoverAtomicTarget(file) {
  if (existsSync(file)) return false
  const recovery = path.join(path.dirname(file), `.${path.basename(file)}.recovery.bak`)
  if (!existsSync(recovery)) return false
  renameSync(recovery, file)
  syncDirectory(path.dirname(file))
  return true
}

export function writeJsonAtomic(file, value) {
  atomicWrite(file, stableJson(value))
}

export function writeJsonExclusive(file, value) {
  atomicCreate(file, stableJson(value))
}

export function canonicalPath(input) {
  const resolved = path.resolve(input)
  if (existsSync(resolved)) return realpathSync.native(resolved)
  let cursor = resolved
  const suffix = []
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    suffix.unshift(path.basename(cursor))
    cursor = parent
  }
  const base = existsSync(cursor) ? realpathSync.native(cursor) : cursor
  return path.join(base, ...suffix)
}

export function isWithin(child, parent) {
  const relative = path.relative(canonicalPath(parent), canonicalPath(child))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export function isLexicallyWithin(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

export function assert(condition, message, code = 'ASSERTION_FAILED') {
  if (condition) return
  const error = new Error(message)
  error.code = code
  throw error
}

export function safeStat(file) {
  try {
    return statSync(file)
  } catch {
    return null
  }
}

export function safeMarkdown(value) {
  return String(value ?? '').replace(/\r/g, '').replace(/\u0000/g, '').trim()
}

export function inlineMarkdown(value) {
  return safeMarkdown(value).replace(/\s*\n\s*/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/`/g, '\\`')
}

export function redactSensitiveText(value, { highEntropy = true } = {}) {
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
  return redacted.replace(/PCPID(\d+)END/g, (_, index) => protocolIds[Number(index)] || '[INVALID_PROTOCOL_ID]')
}

export function quoteMarkdown(value, empty = '> Not recorded.') {
  const normalized = safeMarkdown(value)
  if (!normalized) return empty
  return normalized.split('\n').map((line) => `> ${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}`).join('\n')
}

export function tableMarkdown(value) {
  return inlineMarkdown(value).replace(/\|/g, '\\|')
}

export function assertSafeId(value, label = 'identifier') {
  const text = String(value || '')
  assert(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(text), `Unsafe ${label}: ${text}`, 'IDENTIFIER_UNSAFE')
  return text
}

export function markdownList(items, empty = '- None recorded.') {
  if (!items || items.length === 0) return empty
  return items.map((item) => `- ${safeMarkdown(typeof item === 'string' ? item : JSON.stringify(item))}`).join('\n')
}

export function parseInteger(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number.parseInt(String(value), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function unique(items) {
  return [...new Set(items)]
}
