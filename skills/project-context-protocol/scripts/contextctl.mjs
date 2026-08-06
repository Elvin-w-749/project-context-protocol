#!/usr/bin/env node

import { COMMAND_HELP, COMMANDS, HELP } from './lib/commands.mjs'
import { parseArgs, stableJson } from './lib/util.mjs'

const [, , command, ...argv] = process.argv
const args = parseArgs(argv)

if (!command || command === 'help' || command === '--help' || command === '-h') {
  process.stdout.write(HELP)
  process.exit(0)
}

if (args.help || args.h) {
  if (!COMMAND_HELP[command]) {
    process.stderr.write(`Unknown command: ${command}\n\n${HELP}`)
    process.exit(64)
  }
  process.stdout.write(COMMAND_HELP[command])
  process.exit(0)
}

const handler = COMMANDS[command]
if (!handler) {
  process.stderr.write(`Unknown command: ${command}\n\n${HELP}`)
  process.exit(64)
}

try {
  const result = handler(args)
  if (command === 'resume' && !args.json) process.stdout.write(result.text)
  else process.stdout.write(stableJson(result))
  if (Number.isInteger(result.exitCode)) process.exitCode = result.exitCode
} catch (error) {
  const failure = {
    ok: false,
    command,
    error: {
      code: error.code || 'UNEXPECTED_ERROR',
      message: error.message
    }
  }
  if (args.json) process.stderr.write(stableJson(failure))
  else process.stderr.write(`[${failure.error.code}] ${failure.error.message}\n`)
  process.exitCode = 1
}
