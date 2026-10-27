import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { resolveNativeCommand } from '../bin/windows-platform.mjs'

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..')
const PACKAGED_RUNTIME_FILES = [
  'bin/aamp-logs.mjs',
  'bin/agent-metadata.mjs',
  'bin/feishu-task-agent-controller.mjs',
  'bin/feishu-task-agent.mjs',
  'bin/runtime-concurrency.mjs',
  'bin/runtime-network.mjs',
  'bin/runtime-package-executable.mjs',
  'bin/traecode-readiness.mjs',
  'bin/windows-agent-wrapper.mjs',
  'bin/windows-log-tail.mjs',
  'bin/windows-platform.mjs',
  'bin/windows-process-journal.mjs',
  'bin/windows-service-worker.mjs',
  'bin/windows-service-launcher.vbs',
  'bin/windows-service.mjs',
  'bootstrap/aamp-feishu-task-agent-bootstrap.sh',
  'bootstrap/register-feishu-app.mjs',
  'bootstrap/task-agent-defaults.json',
  'bootstrap/windows-entry.mjs',
  'bootstrap/windows-auth-login.mjs',
  'bootstrap/windows-helper.mjs',
  'scripts/sync-bootstrap-defaults.mjs',
]

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`command timed out: ${command}`))
    }, 30_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timeout)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`command exited ${code}: ${command}\n${stderr || stdout}`))
    })
  })
}

async function runResolved(name, args, environment = process.env, options = {}) {
  const descriptor = await resolveNativeCommand(name, {
    platform: process.platform,
    env: environment,
  })
  return run(descriptor.command, [...descriptor.argsPrefix, ...args], {
    ...options,
    env: environment,
    windowsVerbatimArguments: descriptor.windowsVerbatimArguments,
  })
}

test('packed Task Agent installs offline and its installed bin prints help', { timeout: 60_000 }, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aamp-task-agent-pack-'))
  const packDirectory = path.join(root, 'pack')
  const prefix = path.join(root, 'prefix')
  await fsp.mkdir(packDirectory)
  try {
    const packed = await runResolved('npm', [
      'pack', '--json', '--ignore-scripts', '--pack-destination', packDirectory,
    ], { ...process.env, npm_config_offline: 'true' }, { cwd: PACKAGE_ROOT })
    const packResult = JSON.parse(packed.stdout)
    assert.equal(packResult.length, 1)
    const artifactFiles = new Set(packResult[0].files.map(({ path: file }) => file))
    for (const file of PACKAGED_RUNTIME_FILES) {
      assert.ok(artifactFiles.has(file), `packed artifact is missing ${file}`)
    }

    const tarball = path.join(packDirectory, packResult[0].filename)
    await runResolved('npm', [
      'install', '--prefix', prefix, '--ignore-scripts', '--offline', '--no-audit', '--no-fund', tarball,
    ], { ...process.env, npm_config_offline: 'true' })

    const installedPackage = path.join(prefix, 'node_modules', '@larktask', 'aamp-feishu-task-agent')
    for (const file of PACKAGED_RUNTIME_FILES) {
      assert.equal((await fsp.stat(path.join(installedPackage, file))).isFile(), true, `installed package is missing ${file}`)
    }

    let help
    if (process.platform === 'win32') {
      const binDirectory = path.join(prefix, 'node_modules', '.bin')
      const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') || 'Path'
      help = await runResolved('feishu-task-agent', ['help'], {
        ...process.env,
        [pathKey]: `${binDirectory};${process.env[pathKey] || ''}`,
      })
    } else {
      help = await run(process.execPath, [path.join(installedPackage, 'bin', 'feishu-task-agent.mjs'), 'help'], {
        env: process.env,
      })
    }
    assert.match(help.stdout, /feishu-task-agent|飞书任务/i)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})
