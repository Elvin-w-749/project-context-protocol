import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import path from 'node:path'
import { discoverRepository, listRepositoryFiles } from './git.mjs'
import { atomicCreate, atomicWrite, ensureDir, inlineMarkdown, isWithin, nowIso, quoteMarkdown, sha256, stableJson, tableMarkdown } from './util.mjs'

const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.py', '.go', '.rs', '.java', '.cs', '.rb', '.php'])
const SOURCE_LIMIT = 2000
const SOURCE_BYTES_LIMIT = 1024 * 1024
const SCAN_BUDGET_MS = 20_000

function inspectFile(root, relative, maxBytes = SOURCE_BYTES_LIMIT) {
  const absolute = path.resolve(root, relative)
  if (!isWithin(absolute, root)) return { skipped: 'path-outside-repository' }
  try {
    const linkStats = lstatSync(absolute)
    if (linkStats.isSymbolicLink()) return { skipped: 'symbolic-link' }
    if (!linkStats.isFile()) return { skipped: 'not-a-regular-file' }
    const real = realpathSync.native(absolute)
    if (!isWithin(real, root)) return { skipped: 'resolved-path-outside-repository' }
    if (linkStats.size > maxBytes) return { skipped: 'size-limit', size: linkStats.size }
    const raw = readFileSync(real, 'utf8')
    if (raw.includes('\u0000')) return { skipped: 'binary-content', size: linkStats.size }
    return { raw, size: linkStats.size, sha256: sha256(raw) }
  } catch (error) {
    return { skipped: `read-failure:${error.code || 'unknown'}` }
  }
}

function topLevelStats(files) {
  const stats = new Map()
  for (const file of files) {
    const first = file.replace(/\\/g, '/').split('/')[0]
    const current = stats.get(first) || { name: first, files: 0, extensions: new Map() }
    current.files += 1
    const extension = path.extname(file).toLowerCase() || '(none)'
    current.extensions.set(extension, (current.extensions.get(extension) || 0) + 1)
    stats.set(first, current)
  }
  return [...stats.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function parseManifest(root, relative) {
  const inspected = inspectFile(root, relative, 2 * 1024 * 1024)
  if (!inspected.raw) return { path: relative, error: inspected.skipped || 'unreadable' }
  try {
    const parsed = JSON.parse(inspected.raw)
    return {
      path: relative,
      sha256: inspected.sha256,
      name: parsed.name || null,
      description: parsed.description || null,
      scripts: parsed.scripts || {},
      dependencies: Object.keys(parsed.dependencies || {}).sort(),
      devDependencies: Object.keys(parsed.devDependencies || {}).sort(),
      engines: parsed.engines || null
    }
  } catch {
    return { path: relative, sha256: inspected.sha256, error: 'invalid-json' }
  }
}

function buildConfigFacts(root, files) {
  const pattern = /(^|\/)(pyproject\.toml|requirements[^/]*\.txt|poetry\.lock|pdm\.lock|go\.mod|cargo\.toml|pom\.xml|build\.gradle(?:\.kts)?|composer\.json|gemfile|makefile|dockerfile|compose[^/]*\.ya?ml)$/i
  return files.filter((file) => pattern.test(file)).slice(0, 100).map((file) => {
    const inspected = inspectFile(root, file, 1024 * 1024)
    if (!inspected.raw) return { path: file, skipped: inspected.skipped }
    const signals = inspected.raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#')).slice(0, 20)
    return { path: file, sha256: inspected.sha256, signals }
  })
}

function readmeFacts(root, files) {
  return files.filter((file) => /(^|\/)readme(?:\.[^/]+)?\.md$/i.test(file) || /^README\.md$/i.test(file)).slice(0, 20).map((file) => {
    const inspected = inspectFile(root, file, 512 * 1024)
    if (!inspected.raw) return { path: file, skipped: inspected.skipped }
    const raw = inspected.raw
    const headings = raw.split(/\r?\n/).filter((line) => /^#{1,3}\s+/.test(line)).slice(0, 30)
    const firstParagraph = raw.split(/\r?\n\s*\r?\n/).map((item) => item.replace(/^#+\s+/gm, '').trim()).find((item) => item && !item.startsWith('```')) || ''
    return { path: file, sha256: inspected.sha256, headings, firstParagraph: firstParagraph.slice(0, 600) }
  })
}

function roleSignals(files) {
  const rules = [
    [/(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|go\.mod|cargo\.toml)$/i, 'dependency/build manifest'],
    [/(^|\/)(src\/)?(main|server|app|index)\.(?:js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|cs)$/i, 'entry-point candidate'],
    [/(^|\/)(api|routes?|controllers?|handlers?)(\/|$)/i, 'request/API layer candidate'],
    [/(^|\/)(services?|usecases?|domain)(\/|$)/i, 'service/domain layer candidate'],
    [/(^|\/)(models?|entities|schemas?)(\/|$)/i, 'model/schema layer candidate'],
    [/(^|\/)(frontend|client|web)(\/|$)/i, 'frontend/client subtree candidate'],
    [/(^|\/)(backend|server)(\/|$)/i, 'backend/server subtree candidate'],
    [/(^|\/)(components?|pages?|views?)(\/|$)/i, 'user-interface layer candidate'],
    [/(^|\/)(tests?|__tests__|spec)(\/|$)/i, 'test source'],
    [/(^|\/)(docs?|documentation)(\/|$)/i, 'documentation'],
    [/(^|\/)(scripts?|tools?)(\/|$)/i, 'automation/tooling candidate'],
    [/(^|\/)(ops|infra|deploy|deployment|k8s|terraform)(\/|$)/i, 'operations/deployment candidate'],
    [/(^|\/)\.github\/workflows\//i, 'continuous-integration workflow'],
    [/(^|\/)(dockerfile|compose[^/]*\.ya?ml)$/i, 'container/deployment configuration'],
    [/(^|\/)(migrations?|database|db)(\/|$)/i, 'database/migration candidate'],
    [/(^|\/)(public|static|assets)(\/|$)/i, 'static asset subtree']
  ]
  const result = []
  for (const file of files) {
    const normalized = file.replace(/\\/g, '/')
    for (const [pattern, role] of rules) {
      if (pattern.test(normalized)) result.push({ path: file, role, confidence: 'inferred-from-path' })
      if (result.length >= 400) return result
    }
  }
  return result
}

function sourceSignals(root, files) {
  const routes = []
  const imports = []
  const declarations = []
  const skippedReasons = {}
  let inspected = 0
  let skipped = 0
  let limitReason = null
  const started = Date.now()
  outer: for (const file of files) {
    if (!SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase())) continue
    if (inspected >= SOURCE_LIMIT) {
      limitReason = `source-file-limit:${SOURCE_LIMIT}`
      break
    }
    if (Date.now() - started > SCAN_BUDGET_MS) {
      limitReason = `time-budget-ms:${SCAN_BUDGET_MS}`
      break
    }
    const result = inspectFile(root, file)
    if (!result.raw) {
      skipped += 1
      skippedReasons[result.skipped] = (skippedReasons[result.skipped] || 0) + 1
      continue
    }
    inspected += 1
    const raw = result.raw
    const routePattern = /\b(?:app|router)\.(get|post|put|patch|delete|use)\s*\(\s*['"`]([^'"`]+)['"`]/g
    for (const match of raw.matchAll(routePattern)) {
      if (routes.length >= 500) break
      routes.push({ file, method: match[1].toUpperCase(), path: match[2], confidence: 'regex-candidate-not-ast-verified' })
    }
    const importPattern = /(?:from\s+|require\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g
    for (const match of raw.matchAll(importPattern)) {
      if (imports.length >= 1000) break
      imports.push({ from: file, to: match[1], confidence: 'literal-source-match' })
    }
    const declarationPattern = /(?:export\s+)?(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/g
    for (const match of raw.matchAll(declarationPattern)) {
      if (declarations.length >= 1000) break
      declarations.push({ file, symbol: match[1], confidence: 'regex-candidate-not-ast-verified' })
    }
    if (Date.now() - started > SCAN_BUDGET_MS) {
      limitReason = `time-budget-ms:${SCAN_BUDGET_MS}`
      break outer
    }
  }
  return { inspected, skipped, skippedReasons, limitReason, elapsedMs: Date.now() - started, routes, imports, declarations }
}

function renderArchitecture(observation, inventory) {
  const manifests = inventory.manifests.map((manifest) => {
    if (manifest.error) return `| \`${tableMarkdown(manifest.path)}\` | invalid/unreadable | — | — |`
    const scripts = Object.entries(manifest.scripts).map(([name, command]) => `${tableMarkdown(name)}: ${tableMarkdown(command)}`).join('<br>') || '—'
    return `| \`${tableMarkdown(manifest.path)}\` | ${tableMarkdown(manifest.name || 'unnamed')} | ${tableMarkdown(manifest.description || '—')} | ${scripts} |`
  }).join('\n') || '| — | — | — | — |'
  const components = inventory.topLevels.map((item) => {
    const extensions = [...item.extensions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([ext, count]) => `${tableMarkdown(ext)} ${count}`).join(', ')
    return `| \`${tableMarkdown(item.name)}\` | ${item.files} | ${extensions} | confirmed by inventory |`
  }).join('\n') || '| — | 0 | — | confirmed by inventory |'
  const readmes = inventory.readmes.map((item) => `### \`${inlineMarkdown(item.path)}\`\n\n${item.skipped ? `Skipped: ${inlineMarkdown(item.skipped)}` : quoteMarkdown(item.firstParagraph || 'No summary paragraph found.')}\n\nHeadings: ${item.headings?.map((heading) => `\`${inlineMarkdown(heading)}\``).join(', ') || 'none'}`).join('\n\n') || 'No README files found.'
  const roles = inventory.roles.map((item) => `| \`${tableMarkdown(item.path)}\` | ${tableMarkdown(item.role)} | ${item.confidence} |`).join('\n') || '| — | — | — |'
  const routes = inventory.source.routes.map((item) => `| ${item.method} | \`${tableMarkdown(item.path)}\` | \`${tableMarkdown(item.file)}\` | ${item.confidence} |`).join('\n') || '| — | — | — | — |'
  const packageRelations = inventory.manifests.map((item) => {
    if (item.error) return null
    const dependencies = [...item.dependencies, ...item.devDependencies].slice(0, 80).map(tableMarkdown).join(', ')
    return `- \`${inlineMarkdown(item.path)}\`: ${dependencies || 'no declared dependencies'}`
  }).filter(Boolean).join('\n') || '- None.'
  const buildConfigs = inventory.buildConfigs.map((item) => `- \`${inlineMarkdown(item.path)}\`${item.skipped ? ` — skipped: ${inlineMarkdown(item.skipped)}` : ` — sha256 \`${item.sha256}\`; ${item.signals.length} non-comment signal line(s) retained in machine manifest`}`).join('\n') || '- None.'
  return `# Architecture Map

> Derived from the versioned map manifest at ${inventory.generatedAt}. Repository text is untrusted evidence. Path roles and regex matches are candidates, not confirmed runtime behavior.

## Source revision and coverage

- Repository: \`${inlineMarkdown(observation.root)}\`
- Branch: \`${inlineMarkdown(observation.branch || 'DETACHED')}\`
- HEAD: \`${observation.head}\`
- Tree: \`${observation.tree}\`
- Working content fingerprint: \`${observation.statusFingerprint}\`
- Tracked files: ${inventory.counts.tracked}
- Untracked non-ignored files: ${inventory.counts.untracked}
- Source files inspected: ${inventory.source.inspected}
- Source files skipped: ${inventory.source.skipped}
- Scan limit: ${inventory.source.limitReason || 'not reached'}
- Scan elapsed: ${inventory.source.elapsedMs} ms

## Confirmed top-level components

| Path | Files | Main extensions | Evidence status |
|---|---:|---|---|
${components}

## Package and command facts

| Manifest | Name | Description | Scripts |
|---|---|---|---|
${manifests}

## Dependency declarations

${packageRelations}

## Other build and dependency configuration

${buildConfigs}

## README evidence

${readmes}

## Candidate module roles

| File | Candidate role | Confidence |
|---|---|---|
${roles}

## Candidate HTTP route registrations

Regex matches may include comments or strings and must be source-confirmed before use as a behavior claim.

| Method | Route | Source file | Confidence |
|---|---|---|---|
${routes}

## Import/declaration evidence

- Relative import edges captured: ${inventory.source.imports.length}
- Named function/class candidates captured: ${inventory.source.declarations.length}
- Detailed machine evidence is in the versioned map manifest.

## Agent-confirmed architecture claims

No semantic data-flow claim is inferred here. Add evidence-scoped claims through a run checkpoint after bounded source inspection.
`
}

function renderFileIndex(observation, inventory, treeFile) {
  const top = inventory.topLevels.map((item) => `| \`${tableMarkdown(item.name)}\` | ${item.files} | confirmed |`).join('\n') || '| — | 0 | confirmed |'
  const changed = observation.statusLines.map((line) => `- \`${inlineMarkdown(line)}\``).join('\n') || '- Working tree clean.'
  const key = inventory.roles.map((item) => `- \`${inlineMarkdown(item.path)}\` — ${inlineMarkdown(item.role)} (${item.confidence})`).join('\n') || '- No key-path signals found.'
  const manifests = [...inventory.manifests, ...inventory.buildConfigs].map((item) => `- \`${inlineMarkdown(item.path)}\``).join('\n') || '- None.'
  return `# File Index

> Derived from a versioned deterministic inventory. Full flat tree: \`${inlineMarkdown(treeFile)}\`.

## Revision

- HEAD: \`${observation.head}\`
- Tree: \`${observation.tree}\`
- Working content fingerprint: \`${observation.statusFingerprint}\`
- Inventory fingerprint: \`${inventory.inventoryFingerprint}\`

## Top-level structure

| Path | Files | Status |
|---|---:|---|
${top}

## Manifests and command sources

${manifests}

## Key path signals

${key}

## Current working-tree records

${changed}

## Coverage boundary

Tracked files and non-ignored untracked files are inventoried. Symbolic links are listed but never followed. Ignored dependency/build directories are omitted. Candidate roles remain unconfirmed until bounded source inspection records evidence.
`
}

export function generateProjectMap(paths, observation) {
  if (existsSync(paths.mapPointer)) {
    let pointer
    let manifest
    try {
      pointer = JSON.parse(readFileSync(paths.mapPointer, 'utf8'))
      if (!pointer.manifest || !isWithin(pointer.manifest, paths.context) || !existsSync(pointer.manifest)) throw new Error('Unsafe or missing prior map manifest')
      const rawManifest = readFileSync(pointer.manifest, 'utf8')
      if (pointer.manifestSha256 !== sha256(rawManifest)) throw new Error('Prior map manifest hash mismatch')
      manifest = JSON.parse(rawManifest)
      if (manifest.versionId !== pointer.versionId) throw new Error('Prior map version identity mismatch')
      const base = path.dirname(pointer.manifest)
      for (const [key, relative] of Object.entries(manifest.files || {})) {
        const artifact = path.join(base, relative)
        if (!relative || !isWithin(artifact, base) || !existsSync(artifact)) throw new Error(`Unsafe or missing prior map artifact: ${key}`)
        const stats = lstatSync(artifact)
        if (!stats.isFile() || stats.isSymbolicLink() || !isWithin(realpathSync.native(artifact), base)) throw new Error(`Prior map artifact is not a local regular file: ${key}`)
        if (manifest.artifactHashes?.[key] !== sha256(readFileSync(artifact))) throw new Error(`Prior map artifact hash mismatch: ${key}`)
      }
    } catch (error) {
      const wrapped = new Error(`Existing versioned map is corrupt and cannot be replaced implicitly: ${error.message}`)
      wrapped.code = 'MAP_PRIOR_CORRUPT'
      throw wrapped
    }
    const sameSnapshot = manifest.repo?.repoId === observation.repoId &&
      manifest.repo?.workspaceId === observation.workspaceId &&
      manifest.repo?.contextId === observation.contextId &&
      manifest.repo?.head === observation.head &&
      manifest.repo?.statusFingerprint === observation.statusFingerprint
    if (sameSnapshot) {
      const base = path.dirname(pointer.manifest)
      const architecturePath = path.join(base, manifest.files.architecture)
      const fileIndexPath = path.join(base, manifest.files.fileIndex)
      atomicWrite(paths.architecture, readFileSync(architecturePath, 'utf8'))
      atomicWrite(paths.fileIndex, readFileSync(fileIndexPath, 'utf8'))
      return { ...manifest, pointer, reused: true }
    }
  }
  const files = listRepositoryFiles(observation.root)
  const manifestPaths = files.all.filter((file) => /(^|\/)package\.json$/i.test(file)).slice(0, 100)
  const inventory = {
    generatedAt: nowIso(),
    counts: { tracked: files.tracked.length, untracked: files.untracked.length, total: files.all.length },
    inventoryFingerprint: sha256(`${observation.tree}\0${observation.statusFingerprint}\0${files.all.join('\n')}`),
    topLevels: topLevelStats(files.all),
    manifests: manifestPaths.map((file) => parseManifest(observation.root, file)),
    buildConfigs: buildConfigFacts(observation.root, files.all),
    readmes: readmeFacts(observation.root, files.all),
    roles: roleSignals(files.all),
    source: sourceSignals(observation.root, files.all)
  }
  const after = discoverRepository(observation.root)
  if (after.head !== observation.head || after.statusFingerprint !== observation.statusFingerprint) {
    const error = new Error('Repository changed while the map was being generated; no map generation was committed')
    error.code = 'MAP_SOURCE_CHANGED'
    throw error
  }
  inventory.finishedAt = nowIso()
  const versionId = `MAP-${inventory.generatedAt.replace(/[-:TZ.]/g, '').slice(0, 17)}-${inventory.inventoryFingerprint.slice(0, 16)}`
  const versionDir = path.join(paths.maps, versionId)
  if (existsSync(versionDir)) {
    const error = new Error(`Map version collision: ${versionId}`)
    error.code = 'MAP_VERSION_COLLISION'
    throw error
  }
  ensureDir(versionDir)
  const treeName = 'TREE.txt'
  const architecture = renderArchitecture(observation, inventory)
  const fileIndex = renderFileIndex(observation, inventory, path.join('maps', versionId, treeName).replace(/\\/g, '/'))
  const tree = `${files.all.join('\n')}\n`
  const manifest = {
    protocol: 'project-context/map/v1',
    versionId,
    repo: {
      repoId: observation.repoId,
      workspaceId: observation.workspaceId,
      contextId: observation.contextId,
      root: observation.root,
      branch: observation.branch,
      head: observation.head,
      tree: observation.tree,
      statusFingerprint: observation.statusFingerprint
    },
    ...inventory,
    files: { tree: treeName, architecture: 'ARCHITECTURE.md', fileIndex: 'FILE_INDEX.md' },
    artifactHashes: { tree: sha256(tree), architecture: sha256(architecture), fileIndex: sha256(fileIndex) }
  }
  const pointer = {
    protocol: 'project-context/map-pointer/v1',
    versionId,
    directory: versionDir,
    manifest: path.join(versionDir, 'MAP_MANIFEST.json'),
    manifestSha256: sha256(stableJson(manifest)),
    inventoryFingerprint: inventory.inventoryFingerprint,
    committedAt: nowIso()
  }
  let committed = false
  try {
    atomicCreate(path.join(versionDir, treeName), tree)
    atomicCreate(path.join(versionDir, 'ARCHITECTURE.md'), architecture)
    atomicCreate(path.join(versionDir, 'FILE_INDEX.md'), fileIndex)
    atomicCreate(path.join(versionDir, 'MAP_MANIFEST.json'), stableJson(manifest))
    atomicWrite(paths.mapPointer, stableJson(pointer))
    committed = true
    atomicWrite(paths.architecture, architecture)
    atomicWrite(paths.fileIndex, fileIndex)
  } catch (error) {
    if (!committed) rmSync(versionDir, { recursive: true, force: true })
    throw error
  }
  return { ...manifest, pointer }
}
