import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
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
  return execFileSync(process.execPath, [bin, ...args], {
    env: { ...process.env, AAMP_LOG_DIR: logsRoot },
    encoding: 'utf8',
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
