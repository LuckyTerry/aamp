import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const bin = path.resolve(__dirname, '../bin/aamp-logs.mjs')
const packageVersion = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')).version

function writeJsonl(file, entries) {
  writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`)
}

function makeRun(logsRoot, name, { taskId, taskGuid, unrelatedTaskId = 'other-task', secret = 'super-secret' }) {
  const runDir = path.join(logsRoot, 'runs', name)
  mkdirSync(runDir, { recursive: true })
  writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({
    run_dir: name,
    agent: 'codex',
    app_id_prefix: 'cli_aacd30',
  }, null, 2))
  writeFileSync(path.join(runDir, 'one-click.log'), [
    '[aamp-one-click] starting Feishu bridge',
    `[aamp-one-click] Task ID: ${taskId}`,
  ].join('\n') + '\n')
  writeJsonl(path.join(runDir, 'feishu-bridge.jsonl'), [
    { level: 20, component: 'feishu-bridge', taskId, stage: 'aamp.load', message: '[debug] loaded base summary="hello"' },
    { level: 'info', component: 'feishu-bridge', task_id: taskId, task_guid: taskGuid, event_id: 'evt1', msg: 'dispatch sent', appSecret: secret },
    { level: 'error', component: 'feishu-bridge', task_id: taskId, task_guid: taskGuid, event_id: 'evt1', msg: 'write failed', access_token: 'token-value' },
    { level: 'info', component: 'feishu-bridge', task_id: unrelatedTaskId, task_guid: 'other-guid', event_id: 'evt2', msg: 'unrelated' },
  ])
  writeJsonl(path.join(runDir, 'acp-bridge.jsonl'), [
    { level: 'info', component: 'acp-bridge', task_id: taskId, msg: 'task.dispatch received' },
    { level: 'info', component: 'acp-bridge', task_id: unrelatedTaskId, msg: 'unrelated acp line' },
  ])
  writeJsonl(path.join(runDir, 'errors.jsonl'), [
    { level: 'error', task_id: taskId, msg: 'write failed', smtpPassword: 'smtp-secret' },
  ])
  return runDir
}

function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-logs-test-'))
  const logsRoot = path.join(root, 'logs')
  makeRun(logsRoot, '20260708T153012-12345', {
    taskId: 'feishu-task-guid1-evt1',
    taskGuid: 'guid1',
  })
  makeRun(logsRoot, '20260708T163012-67890', {
    taskId: 'feishu-task-guid2-evt2',
    taskGuid: 'guid2',
    secret: 'new-secret',
  })
  return { root, logsRoot }
}

function runCli(args, logsRoot) {
  const homeDir = path.dirname(logsRoot)
  return execFileSync(process.execPath, [bin, ...args], {
    env: { ...process.env, AAMP_LOG_DIR: logsRoot, HOME: homeDir },
    encoding: 'utf8',
  })
}

test('prints the owning task-agent package version', () => {
  const output = execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8' })

  assert.equal(output, `${packageVersion}\n`)
})

function spawnCli(args, logsRoot) {
  const homeDir = path.dirname(logsRoot)
  return spawn(process.execPath, [bin, ...args], {
    env: { ...process.env, AAMP_LOG_DIR: logsRoot, HOME: homeDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function waitForOutput(child, pattern, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${pattern}. stdout=${stdout} stderr=${stderr}`))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (pattern.test(stdout)) {
        clearTimeout(timer)
        resolve(stdout)
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Process exited before matching ${pattern}. code=${code} stdout=${stdout} stderr=${stderr}`))
    })
  })
}

function extractArchive(archivePath) {
  const outDir = mkdtempSync(path.join(tmpdir(), 'aamp-logs-extract-'))
  execFileSync('tar', ['-xzf', archivePath, '-C', outDir])
  return outDir
}

function readAllFiles(dir) {
  const chunks = []
  const visit = (current) => {
    for (const name of readdirSync(current)) {
      const file = path.join(current, name)
      const stat = statSync(file)
      if (stat.isDirectory()) {
        visit(file)
      } else {
        chunks.push(readFileSync(file, 'utf8'))
      }
    }
  }
  visit(dir)
  return chunks.join('\n')
}

test('collect --task-id creates a redacted archive with matching log lines', () => {
  const { logsRoot } = makeFixture()

  const output = runCli(['collect', '--task-id', 'feishu-task-guid1-evt1'], logsRoot)
  const archivePath = output.trim().split('\n').at(-1)

  assert.ok(archivePath.endsWith('.tar.gz'), output)
  assert.equal(path.dirname(archivePath), path.join(path.dirname(logsRoot), 'Desktop'))
  assert.ok(existsSync(archivePath), archivePath)

  const extracted = extractArchive(archivePath)
  const text = readAllFiles(extracted)

  assert.match(text, /"schema": "aamp.local_logs.bundle.v1"/)
  assert.match(text, /feishu-task-guid1-evt1/)
  assert.match(text, /aamp\.load/)
  assert.match(text, /loaded base summary/)
  assert.match(text, /task\.dispatch received/)
  assert.doesNotMatch(text, /other-task/)
  assert.doesNotMatch(text, /super-secret/)
  assert.doesNotMatch(text, /token-value/)
  assert.doesNotMatch(text, /smtp-secret/)
  assert.match(text, /<redacted>/)
})

test('collect --task-guid resolves related Task IDs from Feishu logs', () => {
  const { logsRoot } = makeFixture()

  const output = runCli(['collect', '--task-guid', 'guid2'], logsRoot)
  const archivePath = output.trim().split('\n').at(-1)
  const text = readAllFiles(extractArchive(archivePath))

  assert.match(text, /feishu-task-guid2-evt2/)
  assert.doesNotMatch(text, /feishu-task-guid1-evt1/)
})

test('collect --task-guid resolves Task IDs from Pino message logs', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-logs-test-'))
  const logsRoot = path.join(root, 'logs')
  const runDir = path.join(logsRoot, 'runs', '20260708T173012-99999')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({ run_dir: path.basename(runDir) }))
  writeJsonl(path.join(runDir, 'feishu-bridge.jsonl'), [
    {
      level: 30,
      bridge: 'feishu-bridge',
      stream: 'stdout',
      message: '[info] [task guid-pino event evt-pino] dispatch sent aamp_task=feishu-task-guid-pino-evt-pino',
    },
  ])
  writeJsonl(path.join(runDir, 'cli-bridge.jsonl'), [
    {
      level: 30,
      bridge: 'cli-bridge',
      message: '[task feishu-task-guid-pino-evt-pino] task.dispatch received',
    },
  ])

  const output = runCli(['collect', '--task-guid', 'guid-pino'], logsRoot)
  const archivePath = output.trim().split('\n').at(-1)
  const text = readAllFiles(extractArchive(archivePath))

  assert.match(text, /feishu-task-guid-pino-evt-pino/)
  assert.match(text, /task\.dispatch received/)
})

test('collect --task-id --include-content includes full matching runs', () => {
  const { logsRoot } = makeFixture()

  const output = runCli(['collect', '--task-id', 'feishu-task-guid1-evt1', '--include-content'], logsRoot)
  const archivePath = output.trim().split('\n').at(-1)
  const text = readAllFiles(extractArchive(archivePath))

  assert.match(text, /feishu-task-guid1-evt1/)
  assert.match(text, /other-task/)
  assert.match(text, /"include_content": true/)
})

test('collect --run-dir packages the specified run directory', () => {
  const { logsRoot } = makeFixture()
  const runDir = path.join(logsRoot, 'runs', '20260708T153012-12345')

  const output = runCli(['collect', '--run-dir', runDir], logsRoot)
  const archivePath = output.trim().split('\n').at(-1)
  const text = readAllFiles(extractArchive(archivePath))

  assert.match(text, /20260708T153012-12345/)
  assert.match(text, /feishu-task-guid1-evt1/)
  assert.match(text, /other-task/)
  assert.match(text, /"run_dir":/)
  assert.doesNotMatch(text, /20260708T163012-67890/)
  assert.doesNotMatch(text, /feishu-task-guid2-evt2/)
})

test('collect --latest packages the newest run when no Task ID exists yet', () => {
  const { logsRoot } = makeFixture()

  const output = runCli(['collect', '--latest'], logsRoot)
  const archivePath = output.trim().split('\n').at(-1)
  const text = readAllFiles(extractArchive(archivePath))

  assert.match(text, /20260708T163012-67890/)
  assert.doesNotMatch(text, /20260708T153012-12345/)
})

test('collect --since includes runs inside the requested duration window', () => {
  const { logsRoot } = makeFixture()

  const output = runCli(['collect', '--since', '9999d'], logsRoot)
  const archivePath = output.trim().split('\n').at(-1)
  const text = readAllFiles(extractArchive(archivePath))

  assert.match(text, /20260708T153012-12345/)
  assert.match(text, /20260708T163012-67890/)
})

test('list-runs prints known run directories', () => {
  const { logsRoot } = makeFixture()

  const output = runCli(['list-runs'], logsRoot)

  assert.match(output, /20260708T153012-12345/)
  assert.match(output, /20260708T163012-67890/)
})

test('tail --task-id prints matching lines without unrelated task lines', () => {
  const { logsRoot } = makeFixture()

  const output = runCli(['tail', '--task-id', 'feishu-task-guid1-evt1'], logsRoot)

  assert.match(output, /feishu-task-guid1-evt1/)
  assert.match(output, /task\.dispatch received/)
  assert.doesNotMatch(output, /other-task/)
})

test('tail accepts positional task id shorthand', () => {
  const { logsRoot } = makeFixture()

  const output = runCli(['tail', 'feishu-task-guid1-evt1'], logsRoot)

  assert.match(output, /feishu-task-guid1-evt1/)
  assert.match(output, /task\.dispatch received/)
  assert.doesNotMatch(output, /other-task/)
})

test('tail --task-guid prints related task lines', () => {
  const { logsRoot } = makeFixture()

  const output = runCli(['tail', '--task-guid', 'guid2'], logsRoot)

  assert.match(output, /feishu-task-guid2-evt2/)
  assert.match(output, /task\.dispatch received/)
  assert.doesNotMatch(output, /feishu-task-guid1-evt1/)
})

test('tail -f --task-guid follows matching live lines', async () => {
  const { logsRoot } = makeFixture()
  const file = path.join(logsRoot, 'runs', '20260708T163012-67890', 'feishu-bridge.jsonl')
  const child = spawnCli(['tail', '-f', '--task-guid', 'guid2'], logsRoot)

  try {
    setTimeout(() => {
      appendFileSync(file, `${JSON.stringify({
        level: 'info',
        task_id: 'feishu-task-guid2-evt2',
        task_guid: 'guid2',
        msg: 'live task update',
        access_token: 'live-token',
      })}\n`)
    }, 150)

    const output = await waitForOutput(child, /live task update/)
    assert.match(output, /20260708T163012-67890\/feishu-bridge\.jsonl/)
    assert.doesNotMatch(output, /live-token/)
    assert.match(output, /<redacted>/)
  } finally {
    child.kill('SIGTERM')
  }
})

test('tail -f without selector follows latest run live lines', async () => {
  const { logsRoot } = makeFixture()
  const file = path.join(logsRoot, 'runs', '20260708T163012-67890', 'one-click.log')
  const child = spawnCli(['tail', '-f'], logsRoot)

  try {
    setTimeout(() => {
      appendFileSync(file, 'latest run live line\n')
    }, 150)

    const output = await waitForOutput(child, /latest run live line/)
    assert.match(output, /20260708T163012-67890\/one-click\.log/)
    assert.doesNotMatch(output, /20260708T153012-12345/)
  } finally {
    child.kill('SIGTERM')
  }
})
