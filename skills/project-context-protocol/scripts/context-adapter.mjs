#!/usr/bin/env node

import { COMMANDS, validateRouteSignals } from './lib/commands.mjs'
import { assert, parseArgs, stableJson } from './lib/util.mjs'

const ADAPTER_VERSION = 'project-context/lifecycle-adapter/v2'

const HELP = `context-adapter — explicit Agent/Harness lifecycle adapter

Usage:
  context-adapter session-start --repo <path> --store <user-selected-absolute-path> --store-confirmed-by-user --record-layout <vault|markdown|hybrid> [--task <title>] [contextctl begin options]
  context-adapter heartbeat --repo <path> --store <path> --record-layout <layout> --run <id> --session <token> [--summary <text>]
  context-adapter checkpoint --repo <path> --store <path> --record-layout <layout> --run <id> --session <token> --event <type> --summary <text> [checkpoint options]
  context-adapter session-stop --repo <path> --store <path> --record-layout <layout> --run <id> --session <token> [--status partial|blocked|completed] [--summary <text>]

Lifecycle guarantees:
  Before session-start, the caller must ask the current user for the context-store path and record layout.
  There is no inferred selection; missing current-session confirmation stops before any store read or write.
  session-start restores state, registers only when --task is supplied for an unmanaged repository,
  begins a fresh authenticated run, routes one mode, and returns a bounded Recovery Card.
  heartbeat is an authenticated observation checkpoint and renews the run lease.
  session-stop writes a handoff checkpoint and closes partial by default; it never infers completion.
  The standalone adapter never launches child programs; an external Harness owns execution.

Capture boundary:
  Without --hook-mediated, output is explicitly marked degraded-no-installed-hook even when the
  adapter is invoked manually. Set --hook-mediated only from a separately trusted Harness integration
  that actually invokes all supported lifecycle callbacks.
`

function captureDeclaration(args, source = 'lifecycle-command') {
  const hookMediated = Boolean(args['hook-mediated'])
  return {
    adapter: ADAPTER_VERSION,
    source,
    hookIntegration: hookMediated ? 'declared-installed-and-mediated' : 'not-installed-or-not-declared',
    launcherMediated: false,
    coverage: hookMediated ? 'mediated-supported-lifecycle-events' : 'degraded-no-installed-hook',
    degraded: !hookMediated,
    warning: hookMediated
      ? 'Coverage is limited to callbacks the Harness actually invokes; the flag is a declaration, not proof.'
      : 'No installed lifecycle Hook was declared. Unwrapped tools, hidden child Agents, and bypassed sessions are not captured automatically.'
  }
}

function contextArgs(args, omit = []) {
  const result = { ...args }
  delete result._
  for (const key of ['help', 'h', 'hook-mediated', 'route-event', 'heartbeat-seconds', 'stop-status', ...omit]) delete result[key]
  return result
}

function requireRunSession(args) {
  assert(args.run && args.run !== true, '--run is required', 'ARGUMENT_REQUIRED')
  assert(args.session && args.session !== true, '--session is required', 'ARGUMENT_REQUIRED')
}

function requireCurrentSessionVault(args) {
  const selected = args.store !== undefined ? args.store : args.vault
  assert(
    selected !== undefined && selected !== true && String(selected).trim() !== '',
    '--store (or legacy --vault) is required. Ask the current user where this session may open or store project context.',
    'VAULT_LOCATION_REQUIRED'
  )
  assert(
    args['store-confirmed-by-user'] === true || args['vault-confirmed-by-user'] === true,
    'session-start requires --store-confirmed-by-user after the current user explicitly selects the exact context path',
    'VAULT_LOCATION_CONFIRMATION_REQUIRED'
  )
  if (args.store !== undefined) {
    assert(
      args['record-layout'] !== undefined && args['record-layout'] !== true && String(args['record-layout']).trim() !== '',
      'session-start requires --record-layout vault, markdown, or hybrid whenever --store is used',
      'RECORD_LAYOUT_REQUIRED'
    )
  }
}

export function sessionStart(args, source = 'lifecycle-command') {
  requireCurrentSessionVault(args)
  const routeEvent = args['route-event'] === undefined ? 'session-start' : String(args['route-event'] === true ? '' : args['route-event'])
  validateRouteSignals([routeEvent])
  const capture = captureDeclaration(args, source)
  const base = contextArgs(args)
  let restored = COMMANDS.resume({ ...base, json: true })
  if (restored.card.trust.status === 'UNMANAGED') {
    if (!args.task || args.task === true) {
      return {
        command: 'session-start',
        started: false,
        capture,
        recovery: restored.card,
        requiredAction: 'Register a single current task by supplying --task and any confirmed PRD binding.',
        exitCode: 3
      }
    }
    // `begin --task` is the single adoption path for both a brand-new store and
    // a persisted UNMANAGED registration. Calling register here would require
    // a run that cannot exist yet and made cold start impossible.
  }
  const begun = COMMANDS.begin({
    ...base,
    harness: capture.degraded ? 'context-adapter/manual-lifecycle' : 'context-adapter/lifecycle-hook',
    coverage: capture.coverage
  })
  const routed = COMMANDS.route({
    repo: base.repo,
    vault: base.vault,
    store: base.store,
    'record-layout': base['record-layout'],
    run: begun.runId,
    session: begun.session,
    event: routeEvent,
    authority: base.authority,
    'current-session-authority': base['current-session-authority']
  })
  const recovery = COMMANDS.resume({ ...base, json: true }).card
  return {
    command: 'session-start',
    started: true,
    capture,
    recovery,
    runId: begun.runId,
    session: begun.session,
    run: begun.run,
    route: routed,
    exitCode: routed.recordingReady ? 0 : routed.exitCode
  }
}

export function heartbeat(args, source = 'lifecycle-command') {
  requireRunSession(args)
  const capture = captureDeclaration(args, source)
  const checkpoint = COMMANDS.checkpoint({
    repo: args.repo,
    vault: args.vault,
    store: args.store,
    'record-layout': args['record-layout'],
    run: args.run,
    session: args.session,
    'lease-seconds': args['lease-seconds'],
    event: 'observation',
    summary: args.summary && args.summary !== true ? String(args.summary) : 'Lifecycle heartbeat renewed the active run lease.',
    details: args.details && args.details !== true ? String(args.details) : 'No task completion, verification, deployment, or acceptance state is inferred.',
    source: 'context-adapter-heartbeat'
  })
  return { command: 'heartbeat', capture, checkpoint, leaseRenewed: true, exitCode: 0 }
}

export function lifecycleCheckpoint(args, source = 'lifecycle-command') {
  requireRunSession(args)
  assert(args.event && args.event !== true, '--event is required', 'ARGUMENT_REQUIRED')
  assert(args.summary && args.summary !== true, '--summary is required', 'ARGUMENT_REQUIRED')
  const capture = captureDeclaration(args, source)
  const checkpoint = COMMANDS.checkpoint({
    ...contextArgs(args),
    source: args.source && args.source !== true ? String(args.source) : 'context-adapter-checkpoint'
  })
  return { command: 'checkpoint', capture, checkpoint, leaseRenewed: true, exitCode: 0 }
}

export function sessionStop(args, source = 'lifecycle-command') {
  requireRunSession(args)
  const status = args.status && args.status !== true ? String(args.status) : args['stop-status'] && args['stop-status'] !== true ? String(args['stop-status']) : 'partial'
  assert(new Set(['completed', 'partial', 'blocked']).has(status), `Unsupported session-stop status ${status}`, 'RUN_STATUS_INVALID')
  const explicitSummary = args.summary && args.summary !== true ? String(args.summary) : null
  assert(status !== 'completed' || explicitSummary, 'A completed session-stop requires an explicit --summary; completion is never inferred', 'ADAPTER_COMPLETION_NOT_INFERRED')
  const capture = captureDeclaration(args, source)
  const summary = explicitSummary || 'Session stopped with partial status; task completion was not inferred.'
  const base = contextArgs(args, ['status', 'summary', 'details', 'next'])
  const handoff = COMMANDS.checkpoint({
    ...base,
    event: 'handoff',
    summary: `Lifecycle boundary before session stop: ${summary}`,
    details: args.details && args.details !== true ? String(args.details) : 'The adapter records only the observed session boundary and does not infer higher completion layers.',
    next: args.next && args.next !== true ? String(args.next) : null,
    source: 'context-adapter-session-stop'
  })
  const finished = COMMANDS.finish({
    repo: args.repo,
    vault: args.vault,
    store: args.store,
    'record-layout': args['record-layout'],
    run: args.run,
    session: args.session,
    status,
    summary,
    details: args.details,
    next: args.next
  })
  return { command: 'session-stop', capture, handoff, finished, inferredCompletion: false, exitCode: 0 }
}

function heartbeatInterval(args) {
  const raw = args['heartbeat-seconds'] && args['heartbeat-seconds'] !== true ? Number.parseInt(String(args['heartbeat-seconds']), 10) : 60
  assert(Number.isInteger(raw) && raw >= 1 && raw <= 3600, '--heartbeat-seconds must be between 1 and 3600', 'ADAPTER_HEARTBEAT_INTERVAL_INVALID')
  return raw * 1000
}

export async function launch() {
  const error = new Error('The standalone adapter never launches child programs. Use an external Harness and record only independently observed results.')
  error.code = 'STANDALONE_CHILD_EXECUTION_DISABLED'
  throw error
}

const [, , command, ...rawArgv] = process.argv
const separator = rawArgv.indexOf('--')
const optionArgv = separator === -1 ? rawArgv : rawArgv.slice(0, separator)
const childArgv = separator === -1 ? [] : rawArgv.slice(separator + 1)
const args = parseArgs(optionArgv)

if (!command || ['help', '--help', '-h'].includes(command) || args.help || args.h) {
  process.stdout.write(HELP)
  process.exit(0)
}

try {
  let result
  if (command === 'session-start') result = sessionStart(args)
  else if (command === 'heartbeat') result = heartbeat(args)
  else if (command === 'checkpoint') result = lifecycleCheckpoint(args)
  else if (command === 'session-stop') result = sessionStop(args)
  else if (command === 'launch') result = await launch(args, childArgv)
  else {
    const error = new Error(`Unknown context-adapter command: ${command}`)
    error.code = 'ADAPTER_COMMAND_UNKNOWN'
    throw error
  }
  if (command !== 'launch') process.stdout.write(stableJson(result))
  else process.stdout.write(stableJson({ phase: 'session-finish', ...result }))
  if (Number.isInteger(result.exitCode)) process.exitCode = result.exitCode
} catch (error) {
  process.stderr.write(stableJson({
    ok: false,
    command,
    error: { code: error.code || 'UNEXPECTED_ERROR', message: error.message }
  }))
  process.exitCode = 1
}
