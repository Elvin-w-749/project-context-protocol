#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(SCRIPT_DIR, '..')
const SKILLS_DIR = path.join(ROOT, 'skills')
const README_FILE = path.join(ROOT, 'README.md')
const PACKAGE_FILE = path.join(ROOT, 'package.json')

const EXPECTED_SKILLS = [
  'diagnose-and-decide',
  'project-context-protocol',
  'release-with-provenance',
  'verify-and-handoff'
]

const EXCLUDED_SOURCE_DIRECTORIES = new Set([
  '.git',
  '.work',
  'coverage',
  'dist',
  'fixtures',
  '__fixtures__',
  'node_modules',
  'test',
  'tests'
])

const FORBIDDEN_GENERIC_SOURCE_PATTERNS = [
  { label: 'unfinished TODO marker', pattern: /\bTODO\b/i },
  { label: 'unfinished FIXME marker', pattern: /\bFIXME\b/i },
  { label: 'unfinished TBD marker', pattern: /\bTBD\b/i },
  { label: 'unfinished TKTK marker', pattern: /\bTKTK\b/i },
  { label: 'placeholder marker', pattern: /\bPLACEHOLDER\b/i },
  { label: 'fill-me-in marker', pattern: /\b(?:FILL[ _-]?ME[ _-]?IN|TO[ _-]?BE[ _-]?FILLED)\b/i },
  { label: 'template instruction', pattern: /\b(?:YOUR|INSERT)\s+(?:TEXT|CONTENT|DESCRIPTION|NAME)\s+HERE\b/i },
  { label: 'forbidden standalone Skill name contract-testing', pattern: /\bcontract-testing\b/i },
  { label: 'forbidden standalone Skill name multi-agent-coordination', pattern: /\bmulti-agent-coordination\b/i },
  { label: 'project-specific ZSY term', pattern: /\bZSY(?:V?\d+)?\b/i },
  { label: 'project-specific zhishuyun term', pattern: /zhishuyun/i },
  { label: 'project-specific Chinese product name', pattern: /知纾云/ },
  { label: 'project-specific credit-report term', pattern: /征信|信用报告/i },
  { label: 'project-specific RapidOCR term', pattern: /RapidOCR/i },
  { label: 'project-specific Tencent Cloud term', pattern: /腾讯云|Tencent\s+Cloud/i },
  { label: 'project-specific model term DeepSeek', pattern: /DeepSeek/i },
  { label: 'project-specific model term Kimi/Moonshot', pattern: /\b(?:Kimi|Moonshot)\b/i },
  { label: 'project-specific production domain', pattern: /zhishuyun\.top/i },
  { label: 'project-specific production error code', pattern: /\b(?:CHUNK_FACT_CONFLICT|FACT_SCHEMA_INVALID|QUERY_EVIDENCE_INCOMPLETE|REPORT_CLOUD_PERSIST_FAILED)\b/i }
]

const errors = []
const checks = []

function relative(file) {
  return path.relative(ROOT, file).split(path.sep).join('/') || '.'
}

function recordCheck(message) {
  checks.push(message)
}

function fail(message) {
  errors.push(message)
}

function readUtf8(file) {
  try {
    return readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  } catch (error) {
    fail(`Cannot read ${relative(file)}: ${error.message}`)
    return null
  }
}

function parseJson(file, label) {
  const raw = readUtf8(file)
  if (raw === null) return null
  try {
    return JSON.parse(raw)
  } catch (error) {
    fail(`${label} is not valid JSON (${relative(file)}): ${error.message}`)
    return null
  }
}

function listDirectories(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    fail(`Cannot inspect ${relative(directory)}: ${error.message}`)
    return []
  }
}

function walkFiles(directory, options = {}) {
  const output = []
  if (!existsSync(directory)) return output
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (options.excludeDirectories?.has(entry.name)) continue
      output.push(...walkFiles(full, options))
    } else if (entry.isFile()) {
      output.push(full)
    }
  }
  return output
}

function parseFrontmatter(file, raw) {
  const normalized = raw.replace(/\r\n?/g, '\n')
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)
  if (!match) {
    fail(`${relative(file)} must start with a closed YAML frontmatter block.`)
    return null
  }
  const values = new Map()
  for (const [index, line] of match[1].split('\n').entries()) {
    if (!line.trim() || /^\s*#/.test(line)) continue
    const pair = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/)
    if (!pair) {
      fail(`${relative(file)} has unsupported frontmatter syntax on line ${index + 2}: ${line}`)
      continue
    }
    if (values.has(pair[1])) fail(`${relative(file)} repeats frontmatter key ${pair[1]}.`)
    values.set(pair[1], parseYamlScalar(pair[2]))
  }
  return values
}

function parseYamlScalar(value) {
  const trimmed = value.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return trimmed.slice(1, -1)
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'")
  }
  return trimmed
}

function yamlField(raw, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matches = [...raw.matchAll(new RegExp(`^\\s*${escaped}:\\s*(.*?)\\s*$`, 'gm'))]
  if (matches.length !== 1) return { count: matches.length, value: null }
  return { count: 1, value: parseYamlScalar(matches[0][1]) }
}

function validateSkillSet() {
  if (!existsSync(SKILLS_DIR)) {
    fail('skills/ directory is missing.')
    return
  }
  const actual = listDirectories(SKILLS_DIR)
  if (JSON.stringify(actual) !== JSON.stringify(EXPECTED_SKILLS)) {
    fail(`skills/ must contain exactly ${EXPECTED_SKILLS.join(', ')}; found ${actual.length ? actual.join(', ') : '(none)'}.`)
    return
  }
  recordCheck('exact four-Skill inventory')
}

function validateSkillMetadata(skillName) {
  const skillDir = path.join(SKILLS_DIR, skillName)
  const skillFile = path.join(skillDir, 'SKILL.md')
  const agentFile = path.join(skillDir, 'agents', 'openai.yaml')

  if (!existsSync(skillFile)) {
    fail(`${relative(skillFile)} is missing.`)
  } else {
    const raw = readUtf8(skillFile)
    if (raw !== null) {
      const frontmatter = parseFrontmatter(skillFile, raw)
      if (frontmatter) {
        if (frontmatter.get('name') !== skillName) {
          fail(`${relative(skillFile)} frontmatter name must be ${skillName}; found ${JSON.stringify(frontmatter.get('name'))}.`)
        }
        const description = frontmatter.get('description')
        if (typeof description !== 'string' || description.trim().length < 20) {
          fail(`${relative(skillFile)} must have a substantive non-empty description.`)
        }
        const keys = [...frontmatter.keys()]
        for (const required of ['name', 'description']) {
          if (!keys.includes(required)) fail(`${relative(skillFile)} is missing frontmatter key ${required}.`)
        }
      }
    }
  }

  if (!existsSync(agentFile)) {
    fail(`${relative(agentFile)} is missing.`)
  } else {
    const raw = readUtf8(agentFile)
    if (raw !== null) {
      const prompt = yamlField(raw, 'default_prompt')
      if (prompt.count !== 1) {
        fail(`${relative(agentFile)} must define default_prompt exactly once.`)
      } else if (!String(prompt.value).includes(`$${skillName}`)) {
        fail(`${relative(agentFile)} default_prompt must contain $${skillName}.`)
      }

      const implicit = yamlField(raw, 'allow_implicit_invocation')
      const expected = skillName === 'project-context-protocol' ? 'true' : 'false'
      if (implicit.count !== 1) {
        fail(`${relative(agentFile)} must define allow_implicit_invocation exactly once.`)
      } else if (String(implicit.value).toLowerCase() !== expected) {
        fail(`${relative(agentFile)} allow_implicit_invocation must be ${expected}.`)
      }
    }
  }
}

function normalizeMarkdownDestination(raw) {
  let value = raw.trim()
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1).trim()
  const optionalTitle = value.match(/^(\S+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))$/)
  if (optionalTitle) value = optionalTitle[1]
  return value
}

function isExternalMarkdownDestination(destination) {
  return !destination || destination.startsWith('#') || destination.startsWith('//') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(destination)
}

function resolveMarkdownDestination(markdownFile, destination) {
  const withoutFragment = destination.split('#', 1)[0].split('?', 1)[0]
  if (!withoutFragment) return null
  let decoded
  try {
    decoded = decodeURIComponent(withoutFragment)
  } catch {
    fail(`${relative(markdownFile)} contains a malformed encoded link target: ${destination}`)
    return null
  }
  return path.resolve(path.dirname(markdownFile), decoded.replace(/\//g, path.sep))
}

function markdownDestinations(raw) {
  const destinations = []
  const inline = /!?\[[^\]\n]*\]\(([^)\n]+)\)/g
  const reference = /^\s*\[[^\]\n]+\]:\s*(\S+(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?)\s*$/gm
  for (const match of raw.matchAll(inline)) destinations.push(normalizeMarkdownDestination(match[1]))
  for (const match of raw.matchAll(reference)) destinations.push(normalizeMarkdownDestination(match[1]))
  return destinations
}

function validateMarkdownLinks() {
  const markdownFiles = walkFiles(ROOT, { excludeDirectories: EXCLUDED_SOURCE_DIRECTORIES })
    .filter((file) => file.toLowerCase().endsWith('.md'))
  let relativeLinkCount = 0
  for (const file of markdownFiles) {
    const raw = readUtf8(file)
    if (raw === null) continue
    for (const destination of markdownDestinations(raw)) {
      if (isExternalMarkdownDestination(destination)) continue
      relativeLinkCount += 1
      const resolved = resolveMarkdownDestination(file, destination)
      if (resolved && !existsSync(resolved)) {
        fail(`${relative(file)} links to missing relative target ${destination}.`)
      }
    }
  }
  recordCheck(`${markdownFiles.length} Markdown files / ${relativeLinkCount} relative links`)
}

function sourceFilesForGenericityCheck() {
  return walkFiles(ROOT, { excludeDirectories: EXCLUDED_SOURCE_DIRECTORIES }).filter((file) => {
    if (path.resolve(file) === path.resolve(import.meta.filename || fileURLToPath(import.meta.url))) return false
    const extension = path.extname(file).toLowerCase()
    return ['.md', '.mjs', '.js', '.json', '.yaml', '.yml', '.txt'].includes(extension)
  })
}

function validateGenericSource() {
  const sourceFiles = sourceFilesForGenericityCheck()
  for (const file of sourceFiles) {
    const raw = readUtf8(file)
    if (raw === null) continue
    for (const { label, pattern } of FORBIDDEN_GENERIC_SOURCE_PATTERNS) {
      if (pattern.test(raw)) fail(`${relative(file)} contains ${label}.`)
    }
  }
  recordCheck(`${sourceFiles.length} generic Skill source files checked for placeholders and project leakage`)
}

function requireDocumentContract(file, checksForFile) {
  const raw = readUtf8(file)
  if (raw === null) return
  for (const [label, pattern] of checksForFile) {
    if (!pattern.test(raw)) fail(`${relative(file)} is missing the ${label} contract.`)
  }
}

function validateDocumentationContracts() {
  for (const skillName of EXPECTED_SKILLS) {
    const file = path.join(SKILLS_DIR, skillName, 'SKILL.md')
    requireDocumentContract(file, [
      ['v1 CLI-help heading', /^## CLI help contract \(v1\)$/m],
      ['global contextctl help', /`contextctl --help`[^\n]*(?:inventory|command)/i],
      ['per-command option help', /`contextctl <command> --help`[^\n]*(?:required|safety|exit)/i],
      ['fail-closed unknown-option behavior', /(?:stop|fail closed)[^\n]*(?:invent|guess)[^\n]*(?:flag|option)/i]
    ])
  }

  requireDocumentContract(README_FILE, [
    ['non-Git v1 support boundary', /Version 1 requires[^\n]*Git worktree/i],
    ['non-Git BLOCKED state', /non-Git[^\n]*`BLOCKED`/i],
    ['degraded and unmanaged manual fallback', /degraded\/unmanaged/i]
  ])

  const coreSkill = path.join(SKILLS_DIR, 'project-context-protocol', 'SKILL.md')
  requireDocumentContract(coreSkill, [
    ['non-Git v1 support boundary', /Version 1 supports Git worktrees only/i],
    ['non-Git BLOCKED state', /non-Git[^\n]*`BLOCKED`/i],
    ['degraded and unmanaged manual fallback', /degraded\/unmanaged/i]
  ])

  const stateContract = path.join(SKILLS_DIR, 'project-context-protocol', 'references', 'state-contract.md')
  requireDocumentContract(stateContract, [
    ['non-Git v1 state boundary', /Version 1 requires a Git worktree/i],
    ['non-Git BLOCKED state', /non-Git[^\n]*`BLOCKED`/i],
    ['degraded and unmanaged manual fallback', /degraded\/unmanaged/i]
  ])

  const eventContract = path.join(SKILLS_DIR, 'release-with-provenance', 'references', 'event-contract.md')
  const eventRaw = readUtf8(eventContract)
  if (eventRaw !== null) {
    const importRow = eventRaw.match(/^\|\s*`import`\s*\|([^\n]+)$/m)
    if (!importRow) {
      fail(`${relative(eventContract)} must include an import row in Required evidence by type.`)
    } else {
      const row = importRow[1]
      for (const [label, pattern] of [
        ['source manifest evidence', /manifest/i],
        ['quarantine destination evidence', /quarantine/i],
        ['explicit non-adoption evidence', /adoptedAsCurrentState:\s*false/i]
      ]) {
        if (!pattern.test(row)) fail(`${relative(eventContract)} import evidence row is missing ${label}.`)
      }
    }
  }

  recordCheck('v1 CLI-help, non-Git, and import-evidence documentation contracts')
}

function normalizePackageBins(packageJson) {
  if (typeof packageJson.bin === 'string') return { [packageJson.name]: packageJson.bin }
  if (packageJson.bin && typeof packageJson.bin === 'object' && !Array.isArray(packageJson.bin)) return packageJson.bin
  return {}
}

function executableClaimedCommands(readme, binNames) {
  const commands = new Map()
  const executableNames = [...binNames, 'contextctl', 'contextctl.mjs']
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
  const pattern = new RegExp(`(?:^|[\\s/\\\\])(${executableNames})\\s+([a-z][a-z0-9-]*)`, 'gim')
  for (const match of readme.matchAll(pattern)) {
    const executable = match[1].toLowerCase()
    if (!commands.has(executable)) commands.set(executable, new Set())
    commands.get(executable).add(match[2])
  }
  return commands
}

async function validatePackageAndCli() {
  const packageJson = parseJson(PACKAGE_FILE, 'package.json')
  const readme = readUtf8(README_FILE)
  if (!packageJson || readme === null) return

  const bins = normalizePackageBins(packageJson)
  if (!Object.keys(bins).length) fail('package.json must declare at least one bin executable.')
  if (!Object.hasOwn(bins, 'contextctl')) fail('package.json must expose a contextctl bin executable.')
  const expectedBins = ['context-adapter', 'contextctl']
  const actualBins = Object.keys(bins).sort()
  if (JSON.stringify(actualBins) !== JSON.stringify(expectedBins)) {
    fail(`Standalone v1 must expose exactly ${expectedBins.join(', ')}; found ${actualBins.join(', ') || 'none'}.`)
  }
  const forbiddenExecutor = path.join(SKILLS_DIR, 'project-context-protocol', 'scripts', 'context-release-executor.mjs')
  if (existsSync(forbiddenExecutor)) fail('Standalone v1 must not ship context-release-executor.mjs.')

  let primaryCli = null
  for (const [name, target] of Object.entries(bins)) {
    if (typeof target !== 'string' || !target.trim()) {
      fail(`package.json bin ${name} must point to a non-empty path.`)
      continue
    }
    const resolved = path.resolve(ROOT, target)
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      fail(`package.json bin ${name} points to missing file ${target}.`)
      continue
    }
    if (name === 'contextctl') primaryCli = resolved
  }

  const npmClaims = [...readme.matchAll(/\bnpm\s+run\s+([A-Za-z0-9:_-]+)/g)].map((match) => match[1])
  for (const scriptName of npmClaims) {
    if (!packageJson.scripts || typeof packageJson.scripts[scriptName] !== 'string') {
      fail(`README.md claims npm run ${scriptName}, but package.json does not define that script.`)
    }
  }

  const commandsFile = path.join(SKILLS_DIR, 'project-context-protocol', 'scripts', 'lib', 'commands.mjs')
  const commandsSource = readUtf8(commandsFile) || ''
  if (!/function\s+externalApprovalStatus\s*\([^)]*\)\s*\{[\s\S]{0,300}?valid:\s*false/.test(commandsSource)) {
    fail('Standalone v1 commands must keep externalApprovalStatus fail-closed.')
  }
  if (!/Standalone v1 never makes a high-risk route executable/.test(commandsSource)) {
    fail('Standalone v1 commands must state the non-executable high-risk route contract.')
  }
  const adapterFile = path.join(SKILLS_DIR, 'project-context-protocol', 'scripts', 'context-adapter.mjs')
  const adapterSource = readUtf8(adapterFile) || ''
  if (/from\s+['"]node:child_process['"]|\bspawn(?:Sync)?\s*\(/.test(adapterSource)) {
    fail('Standalone v1 context-adapter must not spawn arbitrary child programs.')
  }
  if (!/STANDALONE_CHILD_EXECUTION_DISABLED/.test(adapterSource)) {
    fail('Standalone v1 context-adapter must fail closed when launch is requested.')
  }
  let commandNames = []
  try {
    const module = await import(`${pathToFileURL(commandsFile).href}?validate=${Date.now()}`)
    if (!module.COMMANDS || typeof module.COMMANDS !== 'object' || Array.isArray(module.COMMANDS)) {
      fail(`${relative(commandsFile)} must export a COMMANDS object.`)
    } else {
      commandNames = Object.keys(module.COMMANDS).sort()
      if (!commandNames.length) fail('COMMANDS must contain at least one command.')
      for (const name of commandNames) {
        if (typeof module.COMMANDS[name] !== 'function') fail(`COMMANDS.${name} is not callable.`)
      }
    }
  } catch (error) {
    fail(`Cannot load the contextctl command registry: ${error.message}`)
  }

  const claimedByExecutable = executableClaimedCommands(readme, Object.keys(bins))
  const claimedCommands = new Set([
    ...(claimedByExecutable.get('contextctl') || []),
    ...(claimedByExecutable.get('contextctl.mjs') || [])
  ])
  for (const command of claimedCommands) {
    if (!commandNames.includes(command)) {
      fail(`README.md claims contextctl command ${command}, but it is absent from COMMANDS.`)
    }
  }

  for (const [binName, target] of Object.entries(bins)) {
    if (binName === 'contextctl' || typeof target !== 'string') continue
    const claimed = claimedByExecutable.get(binName.toLowerCase()) || new Set()
    const executable = path.resolve(ROOT, target)
    const help = spawnSync(process.execPath, [executable, '--help'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true
    })
    if (help.error || help.status !== 0) {
      fail(`${binName} --help is not executable.`)
      continue
    }
    const output = help.stdout || ''
    if (binName === 'context-adapter' && /\bcontext-adapter\s+launch\b/i.test(output)) {
      fail('context-adapter help must not expose an arbitrary child-process launcher in standalone v1.')
    }
    for (const command of claimed) {
      if (!new RegExp(`\\b${binName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ${command}\\b`, 'i').test(output)) {
        fail(`README.md claims ${binName} command ${command}, but ${binName} --help omits it.`)
      }
    }
  }

  if (primaryCli) {
    const help = spawnSync(process.execPath, [primaryCli, '--help'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true
    })
    if (help.error) {
      fail(`contextctl --help could not run: ${help.error.message}`)
    } else if (help.status !== 0) {
      fail(`contextctl --help exited ${help.status}: ${(help.stderr || help.stdout || '').trim()}`)
    } else {
      const output = help.stdout || ''
      if (!/\bUsage:\s*\n?\s*contextctl\b/i.test(output)) fail('contextctl --help does not contain a Usage section.')
      for (const command of commandNames) {
        if (!new RegExp(`^\\s{2}${command}\\s+`, 'm').test(output)) {
          fail(`contextctl --help omits registered command ${command}.`)
        }
        const commandHelp = spawnSync(process.execPath, [primaryCli, command, '--help'], {
          cwd: ROOT,
          encoding: 'utf8',
          timeout: 10_000,
          windowsHide: true
        })
        const commandOutput = commandHelp.stdout || ''
        if (commandHelp.error || commandHelp.status !== 0) fail(`contextctl ${command} --help is not executable.`)
        else if (!new RegExp(`Usage:\\s*\\n?\\s*contextctl ${command}\\b`, 'i').test(commandOutput) || !/Exit behavior:/i.test(commandOutput)) fail(`contextctl ${command} --help lacks its command-specific usage or exit contract.`)
      }
    }
  }

  const claimCount = [...claimedByExecutable.values()].reduce((total, set) => total + set.size, 0)
  recordCheck(`${Object.keys(bins).length} package bin(s), ${claimCount} README CLI claim(s), ${npmClaims.length} npm script claim(s), and executable help`)
}

async function main() {
  validateSkillSet()
  for (const skillName of EXPECTED_SKILLS) validateSkillMetadata(skillName)
  validateMarkdownLinks()
  validateGenericSource()
  validateDocumentationContracts()
  await validatePackageAndCli()

  if (errors.length) {
    process.stderr.write(`Skill validation failed with ${errors.length} error(s):\n`)
    errors.forEach((error, index) => process.stderr.write(`  ${index + 1}. ${error}\n`))
    if (checks.length) process.stderr.write(`Completed checks: ${checks.join('; ')}.\n`)
    process.exitCode = 1
    return
  }

  process.stdout.write(`Skill validation passed.\n`)
  process.stdout.write(`  Skills: ${EXPECTED_SKILLS.join(', ')}\n`)
  for (const check of checks) process.stdout.write(`  [PASS] ${check}\n`)
}

main().catch((error) => {
  process.stderr.write(`Skill validation crashed: ${error.stack || error.message}\n`)
  process.exitCode = 1
})
