#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

function fail(message) { console.error(`[aamp-agent-wrapper] ${message}`); process.exitCode = 2 }
let config
try {
  const raw = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : process.env.AAMP_WINDOWS_AGENT_CONFIG
  config = JSON.parse(raw || '')
} catch { fail('invalid private agent configuration'); config = null }
if (config) {
  if (typeof config.command !== 'string' || !config.command || /[\r\n]/.test(config.command)
      || (!/[\\/]/.test(config.command) && /\s/.test(config.command))
      || !Array.isArray(config.args) || !config.args.every(value => typeof value === 'string')
      || (config.env !== undefined && (config.env === null || Array.isArray(config.env) || typeof config.env !== 'object'))) {
    fail('agent configuration must contain a command, argv array and optional environment object')
  } else {
    const child = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, stdio: 'inherit', shell: false })
    child.once('error', error => { console.error(`[aamp-agent-wrapper] unable to start agent: ${error.code || error.message}`); process.exitCode = 1 })
    child.once('close', code => { process.exitCode = code ?? 1 })
  }
}
