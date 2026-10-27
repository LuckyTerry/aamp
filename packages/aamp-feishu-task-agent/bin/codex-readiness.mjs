#!/usr/bin/env node
import {spawn, spawnSync} from 'node:child_process'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {pathToFileURL} from 'node:url'

const MAX_OUTPUT_BYTES = 64 * 1024
const PROBE_TIMEOUT_MS = 45_000

// Never echo raw provider output: it may contain headers, credentials or URLs.
function failure(code, message) {
  return Object.assign(new Error(message), {code})
}

function terminate(child, signal) {
  if (!child.pid) return
  try {
    if (process.platform === 'win32') {
      // Kill only this probe's tree, including an npm shim's native CLI child.
      const systemRoot = process.env.SystemRoot || 'C:\\Windows'
      spawnSync(path.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true, timeout: 1000,
      })
      child.kill('SIGKILL')
    } else {
      process.kill(-child.pid, signal)
    }
  } catch (error) {
    if (error.code !== 'ESRCH') child.kill(signal)
  }
}

export function runCodexCommand(command, args, {env = process.env, cwd, timeoutMs = 10_000, signal} = {}) {
  const descriptor = typeof command === 'string' ? {command} : command
  return new Promise(resolve => {
    let stdout = '', stderr = '', size = 0, timedOut = false, outputLimited = false, cancelled = false, settled = false
    let timer, killTimer
    const child = spawn(descriptor.command, [...(descriptor.argsPrefix || []), ...args], {
      env, cwd, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    })
    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      signal?.removeEventListener('abort', cancel)
      child.stdout.destroy()
      child.stderr.destroy()
      resolve({...result, stdout, stderr, timedOut, outputLimited, cancelled})
    }
    const stop = () => {
      terminate(child, 'SIGTERM')
      killTimer ??= setTimeout(() => {
        terminate(child, 'SIGKILL')
        finish({code: child.exitCode, signal: child.signalCode})
      }, 500)
    }
    const cancel = () => {cancelled = true; stop()}
    const append = (stream, chunk) => {
      if (outputLimited) return
      size += chunk.length
      if (size > MAX_OUTPUT_BYTES) {
        outputLimited = true
        clearTimeout(timer)
        stop()
      } else if (stream === 'stdout') stdout += chunk.toString('utf8')
      else stderr += chunk.toString('utf8')
    }
    child.stdout.on('data', chunk => append('stdout', chunk))
    child.stderr.on('data', chunk => append('stderr', chunk))
    timer = setTimeout(() => {timedOut = true; stop()}, timeoutMs)
    child.once('error', spawnError => finish({spawnError}))
    child.once('close', (code, signal) => {
      if (timedOut || outputLimited || cancelled) terminate(child, 'SIGKILL')
      finish({code, signal})
    })
    signal?.addEventListener('abort', cancel, {once: true})
    if (signal?.aborted) cancel()
  })
}

function checkExecution(result) {
  if (result.cancelled) throw failure('ABORT_ERR', 'Codex 模型调用验证已取消。')
  if (result.timedOut) throw failure('ETIMEDOUT', 'Codex 模型调用验证超时；请检查当前 provider 的网络、代理及服务可用性后重试。')
  if (result.spawnError) throw failure(result.spawnError.code, '无法运行 Codex CLI；请检查已选择的 CLI 路径和执行权限。')
  if (result.outputLimited) throw failure('CODEX_OUTPUT_LIMIT', 'Codex 模型调用输出异常，已停止验证；请直接运行该 CLI 检查配置。')
  if (result.code === 0) return
  const output = `${result.stderr}\n${result.stdout}`
  if (/config\.toml|error loading config|TOML parse|unknown model provider|model provider .+ not found/i.test(output)) {
    throw failure('CODEX_CONFIG', 'Codex 配置检查失败；请检查当前 config.toml、模型和 provider 配置后重试。')
  }
  if (/\b(?:401|403)\b|unauthorized|invalid[_ -]api[_ -]key|authentication|not logged in|missing.*(?:api key|bearer)|\bcodex login\b/i.test(output)) {
    throw failure('CODEX_AUTH', 'Codex 当前 provider 的认证未通过；使用 API 或自定义 provider 时请检查其密钥配置，使用官方账号时请在终端运行该 Codex CLI 的 login 命令。不会自动切换认证方式。')
  }
  if (/timed? ?out|timeout|ECONN|ENOTFOUND|EAI_AGAIN|network|connection|proxy|certificate|TLS|DNS/i.test(output)) {
    throw failure('CODEX_NETWORK', 'Codex 模型连接失败；请检查当前 provider 的网络、代理、证书和服务地址后重试。')
  }
  throw failure('CODEX_EXEC_FAILED', 'Codex 模型调用未成功；请在终端使用同一 CLI 和 provider 配置执行 codex exec 检查，不能仅据此判定需要登录。')
}

export async function probeCodex(command, {env = process.env, timeoutMs = PROBE_TIMEOUT_MS, signal} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'aamp-codex-probe-'))
  try {
    const output = path.join(directory, 'answer.txt')
    const result = await runCodexCommand(command, [
      'exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral',
      '--color', 'never', '--output-last-message', output,
      'Reply exactly OK. Do not use tools, read files, or perform any other action.',
    ], {env, cwd: directory, timeoutMs, signal})
    checkExecution(result)
    // A help banner or a successful wrapper exit is not a model response.
    const answer = await readFile(output, 'utf8').catch(() => '')
    if (!answer.trim()) throw failure('CODEX_NO_RESPONSE', 'Codex 未返回有效的模型回复；请检查当前 CLI 和 provider 配置后重试。')
  } finally {
    await rm(directory, {recursive: true, force: true})
  }
}

async function main() {
  const [action, command] = process.argv.slice(2)
  if (!command || !['status', 'probe'].includes(action)) {process.exitCode = 64; return}
  const controller = new AbortController()
  const interrupt = () => controller.abort('SIGINT')
  const terminate = () => controller.abort('SIGTERM')
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', terminate)
  try {
    if (action === 'status') {
      const result = await runCodexCommand(command, ['login', 'status'], {signal: controller.signal})
      process.exitCode = result.timedOut ? 124 : result.spawnError?.code === 'ENOENT' ? 127
        : result.outputLimited ? 70 : result.signal === 'SIGKILL' ? 137 : (result.code ?? 1)
    } else await probeCodex(command, {signal: controller.signal})
  } catch (error) {
    if (!controller.signal.aborted) throw error
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
    if (controller.signal.aborted) process.exitCode = controller.signal.reason === 'SIGINT' ? 130 : 143
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message)
    process.exitCode = error.code === 'ETIMEDOUT' ? 124 : error.code === 'ENOENT' ? 127 : 1
  })
}
