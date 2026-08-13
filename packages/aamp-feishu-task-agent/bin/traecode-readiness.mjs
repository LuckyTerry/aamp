#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const MAX_OUTPUT_BYTES = 1024 * 1024
const EXIT = Object.freeze({ unsupported: 3, model: 10, blocked: 11, invalid: 65, execution: 70, timeout: 124, missing: 127 })

function cleanText(value, homeDir = '') {
  if (typeof value !== 'string') return undefined
  let text = value.replace(/\s+/g, ' ').trim()
  if (homeDir) text = text.split(homeDir).join('~')
  if (!text) return undefined
  return text.slice(0, 400)
}

export function supportsTraeCodeAcpHelp(output) {
  const text = String(output || '')
  return /\bacp\s+serve\b/i.test(text) && /Start the ACP server/i.test(text)
}

export function parseTraeCodeDoctor(raw, homeDir = '') {
  let document
  try {
    document = JSON.parse(String(raw || ''))
  } catch {
    throw new Error('TraeCode doctor did not return valid JSON')
  }
  if (!document || typeof document !== 'object' || !Array.isArray(document.checks)) {
    throw new Error('TraeCode doctor JSON is missing a checks array')
  }

  const checks = document.checks.map((value, index) => {
    if (!value || typeof value !== 'object') {
      throw new Error(`TraeCode doctor check ${index} is invalid`)
    }
    const name = cleanText(value.name, homeDir)
    const severity = cleanText(value.severity, homeDir)?.toLowerCase()
    const message = cleanText(value.message, homeDir)
    const fix = cleanText(value.fix, homeDir)
    if (!name || !['info', 'warning', 'error'].includes(severity) || !message) {
      throw new Error(`TraeCode doctor check ${index} is invalid`)
    }
    return { name, severity, message, ...(fix ? { fix } : {}) }
  })
  const warnings = checks.filter((check) => check.severity === 'warning')
  const errors = checks.filter((check) => check.severity === 'error')
  return {
    status: errors.length === 0
      ? 'ready'
      : errors.some((check) => check.name.toLowerCase() === 'model')
        ? 'model_required'
        : 'blocked',
    warnings,
    errors,
  }
}

function formatChecks(checks) {
  return checks.map((check) => {
    const suffix = check.fix ? `；建议：${check.fix}` : ''
    return `${check.name}: ${check.message}${suffix}`
  }).join('\n')
}

function runBounded(command, args, timeoutSeconds) {
  const timeoutMs = Math.max(1, Number.isFinite(timeoutSeconds) ? timeoutSeconds : 10) * 1000
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let total = 0
    let timedOut = false
    let outputLimited = false
    let settled = false
    let timer
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let killTimer
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      resolve(result)
    }
    const signal = (name) => {
      try {
        child.kill(name)
      } catch (error) {
        if (error?.code === 'ESRCH') return
        throw error
      }
    }
    const terminate = () => {
      signal('SIGTERM')
      if (!killTimer) killTimer = setTimeout(() => {
        signal('SIGKILL')
        child.stdout.destroy()
        child.stderr.destroy()
        finish({ code: child.exitCode, signal: child.signalCode, stdout, stderr, timedOut, outputLimited })
      }, 500)
      killTimer.unref()
    }
    const append = (target, chunk) => {
      const text = chunk.toString('utf8')
      total += Buffer.byteLength(text)
      if (total > MAX_OUTPUT_BYTES) {
        if (!outputLimited) {
          outputLimited = true
          clearTimeout(timer)
          terminate()
        }
        return target
      }
      return target + text
    }
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk) })
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk) })
    timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)
    child.once('error', (error) => {
      finish({ spawnError: error, stdout, stderr, timedOut, outputLimited })
    })
    child.once('close', (code, signal) => {
      finish({ code, signal, stdout, stderr, timedOut, outputLimited })
    })
  })
}

async function main() {
  const [action, command, timeoutRaw] = process.argv.slice(2)
  if (!['probe-acp', 'doctor'].includes(action) || !command) process.exit(64)
  const result = await runBounded(command, action === 'probe-acp'
    ? ['acp', 'serve', '--help']
    : ['doctor', '--json'], Number(timeoutRaw || '10'))
  if (result.timedOut) process.exit(EXIT.timeout)
  if (result.outputLimited) process.exit(EXIT.execution)
  if (result.spawnError) process.exit(result.spawnError.code === 'ENOENT' ? EXIT.missing : EXIT.execution)

  if (action === 'probe-acp') {
    process.exit(result.code === 0 && supportsTraeCodeAcpHelp(`${result.stdout}\n${result.stderr}`)
      ? 0
      : EXIT.unsupported)
  }

  if (![0, 1, 2].includes(result.code)) {
    process.stderr.write('TraeCode doctor failed with an unsupported exit code')
    process.exit(EXIT.execution)
  }
  let parsed
  try {
    parsed = parseTraeCodeDoctor(result.stdout, process.env.HOME || '')
  } catch (error) {
    process.stderr.write(error.message)
    process.exit(EXIT.invalid)
  }
  if (parsed.status === 'ready') {
    if (parsed.warnings.length) process.stdout.write(formatChecks(parsed.warnings))
    process.exit(0)
  }
  process.stdout.write(formatChecks(parsed.errors))
  process.exit(parsed.status === 'model_required' ? EXIT.model : EXIT.blocked)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(cleanText(error?.message || error, process.env.HOME) || 'TraeCode readiness check failed')
    process.exit(EXIT.execution)
  })
}
