#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SENSITIVE_KEY_PATTERN = [
  'secret',
  'token',
  'password',
  'authorization',
  'cookie',
  'credential',
  'appSecret',
  'smtpPassword',
  'mailboxToken',
  'access_token',
  'device_code',
  'user_code',
  'app_secret',
].join('|')

const TEXT_LOG_EXTENSIONS = new Set(['.json', '.jsonl', '.log', '.txt'])
const FEISHU_TASK_ID_PREFIX = 'feishu-task-'

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr
  stream.write(`Usage:
  aamp-logs --version
  aamp-logs collect --task-id <task-id>
  aamp-logs collect --task-guid <task-guid>
  aamp-logs collect --run-dir <run-dir>
  aamp-logs collect --latest
  aamp-logs collect --since <duration>
  aamp-logs list-runs
  aamp-logs tail --task-id <task-id>
  aamp-logs tail --task-guid <task-guid>
  aamp-logs tail -f [--task-id <task-id>|--task-guid <task-guid>|<task-id>]

Options:
  --log-dir <dir>          Override AAMP log root. Defaults to AAMP_LOG_DIR or ~/.aamp/logs.
  --include-content        Include full matching run logs instead of matching fragments only.
  -f, --follow             Follow new log lines in real time. Without a selector, follows the latest run.
  -h, --help               Show this help.

Collect creates the local .tar.gz bundle on your Desktop.
`)
  process.exit(exitCode)
}

function packageVersion() {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
    throw new Error('Task-agent package version is unavailable')
  }
  return packageJson.version
}

function parseArgs(argv) {
  const [command, ...rest] = argv
  if (!command || command === '-h' || command === '--help') usage(0)

  const options = { command }
  const booleanFlags = new Set(['--latest', '--follow'])
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]
    if (arg === '-h' || arg === '--help') usage(0)
    if (arg === '-f') {
      options.follow = true
      continue
    }
    if (arg === '--include-content' || booleanFlags.has(arg)) {
      options[arg.slice(2).replace(/-/g, '_')] = true
      continue
    }
    if (arg.startsWith('--')) {
      const value = rest[i + 1]
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`)
      }
      options[arg.slice(2).replace(/-/g, '_')] = value
      i += 1
      continue
    }
    if (command === 'tail' && !options.task_id && !options.task_guid) {
      options.task_id = arg
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }
  return options
}

function homeLogsDir() {
  return path.join(os.homedir(), '.aamp', 'logs')
}

function resolveLogRoot(options) {
  return path.resolve(options.log_dir || process.env.AAMP_LOG_DIR || homeLogsDir())
}

function listRunDirs(logRoot) {
  const runsDir = path.join(logRoot, 'runs')
  if (!existsSync(runsDir)) return []
  return readdirSync(runsDir)
    .map((name) => path.join(runsDir, name))
    .filter((entry) => statSync(entry).isDirectory())
    .sort((left, right) => path.basename(left).localeCompare(path.basename(right)))
}

function latestRun(logRoot) {
  const runs = listRunDirs(logRoot)
  return runs.at(-1)
}

function resolveRunDir(logRoot, value) {
  const runDir = path.isAbsolute(value)
    ? path.resolve(value)
    : path.join(logRoot, 'runs', value)
  if (!existsSync(runDir) || !statSync(runDir).isDirectory()) {
    throw new Error(`Run directory not found: ${value}`)
  }
  return runDir
}

function parseDurationMs(value) {
  const match = /^(\d+)(ms|s|m|h|d)?$/.exec(String(value).trim())
  if (!match) throw new Error(`Invalid duration: ${value}`)
  const amount = Number(match[1])
  const unit = match[2] || 'ms'
  const multipliers = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  }
  return amount * multipliers[unit]
}

function runTimestamp(runDir) {
  const name = path.basename(runDir)
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(name)
  if (match) {
    const [, year, month, day, hour, minute, second] = match
    return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}`).getTime()
  }
  return statSync(runDir).mtimeMs
}

function textFiles(runDir) {
  return readdirSync(runDir)
    .map((name) => path.join(runDir, name))
    .filter((file) => {
      const stat = statSync(file)
      return stat.isFile() && TEXT_LOG_EXTENSIONS.has(path.extname(file))
    })
    .sort((left, right) => path.basename(left).localeCompare(path.basename(right)))
}

function readLines(file) {
  return readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.length > 0)
}

function lineHasAny(line, values) {
  return values.some((value) => value && line.includes(value))
}

function redactText(input) {
  const key = SENSITIVE_KEY_PATTERN
  return String(input)
    .replace(new RegExp(`("(?:[^"]*(?:${key})[^"]*)"\\s*:\\s*)"[^"]*"`, 'gi'), '$1"<redacted>"')
    .replace(new RegExp(`\\b((?:${key})\\s*=)\\S+`, 'gi'), '$1<redacted>')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, '$1 <redacted>')
    .replace(new RegExp(`([?&](?:${key})=)[^&\\s]+`, 'gi'), '$1<redacted>')
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

function extractTaskIdsFromLine(line, parsed) {
  const taskIds = new Set()
  for (const key of ['task_id', 'taskId', 'aampTaskId', 'aamp_task']) {
    if (typeof parsed?.[key] === 'string' && parsed[key]) {
      taskIds.add(parsed[key])
    }
  }

  const patterns = [
    /"(?:task_id|taskId|aampTaskId|aamp_task)"\s*:\s*"([^"]+)"/g,
    /\b(?:task_id|taskId|aampTaskId|aamp_task)=([A-Za-z0-9._:-]+)/g,
    /\bTask ID:\s*([A-Za-z0-9._:-]+)/g,
    /\b(feishu-task-[A-Za-z0-9._:-]+)/g,
  ]
  for (const pattern of patterns) {
    for (const match of line.matchAll(pattern)) {
      if (match[1]) taskIds.add(match[1])
    }
  }
  return [...taskIds]
}

function taskIdPrefixForGuid(taskGuid) {
  return `${FEISHU_TASK_ID_PREFIX}${taskGuid}-`
}

function collectTaskIdsForGuid(runDirs, taskGuid) {
  const taskIds = new Set()
  const taskIdPrefix = taskIdPrefixForGuid(taskGuid)
  for (const runDir of runDirs) {
    for (const file of textFiles(runDir)) {
      for (const line of readLines(file)) {
        const parsed = parseJsonLine(line)
        const lineMatchesGuid = parsed?.task_guid === taskGuid
          || parsed?.taskGuid === taskGuid
          || line.includes(taskIdPrefix)
          || line.includes(taskGuid)
        if (lineMatchesGuid) {
          for (const taskId of extractTaskIdsFromLine(line, parsed)) {
            if (taskId.startsWith(taskIdPrefix)) taskIds.add(taskId)
          }
        }
      }
    }
  }
  return [...taskIds]
}

function runContainsAny(runDir, values) {
  return textFiles(runDir).some((file) => readLines(file).some((line) => lineHasAny(line, values)))
}

function selectRuns(logRoot, options, matchValues) {
  const runs = listRunDirs(logRoot)
  if (options.run_dir) {
    return [resolveRunDir(logRoot, options.run_dir)]
  }
  if (options.latest) {
    const run = latestRun(logRoot)
    return run ? [run] : []
  }
  if (options.since) {
    const cutoff = Date.now() - parseDurationMs(options.since)
    return runs.filter((runDir) => runTimestamp(runDir) >= cutoff)
  }
  if (matchValues.length > 0) {
    return runs.filter((runDir) => runContainsAny(runDir, matchValues))
  }
  return []
}

function ensureArchiveDir() {
  const archiveDir = path.join(os.homedir(), 'Desktop')
  mkdirSync(archiveDir, { recursive: true })
  return archiveDir
}

function archiveStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function writeReadme(file, options, runDirs, taskIds) {
  const taskIdPrefix = options.task_guid ? taskIdPrefixForGuid(options.task_guid) : undefined
  writeFileSync(file, [
    'AAMP local logs bundle',
    '',
    `Created at: ${new Date().toISOString()}`,
    `Command: ${options.command}`,
    taskIds.length ? `Task IDs: ${taskIds.join(', ')}` : undefined,
    taskIdPrefix ? `Task ID prefix: ${taskIdPrefix}` : undefined,
    options.task_guid ? `Task GUID: ${options.task_guid}` : undefined,
    options.latest ? 'Selection: latest run' : undefined,
    options.since ? `Selection: since ${options.since}` : undefined,
    options.run_dir ? `Selection: run dir ${options.run_dir}` : undefined,
    `Runs: ${runDirs.map((runDir) => path.basename(runDir)).join(', ') || '(none)'}`,
    '',
    'Sensitive values are redacted before packaging. This bundle is local-only and was not uploaded by aamp-logs.',
    '',
  ].filter(Boolean).join('\n'))
}

function writeBundleManifest(file, options, runDirs, taskIds, matchValues) {
  const manifest = {
    schema: 'aamp.local_logs.bundle.v1',
    created_at: new Date().toISOString(),
    command: options.command,
    selection: {
      ...(options.task_id ? { task_id: options.task_id } : {}),
      ...(options.task_guid ? {
        task_guid: options.task_guid,
        task_id_prefix: taskIdPrefixForGuid(options.task_guid),
      } : {}),
      ...(options.latest ? { latest: true } : {}),
      ...(options.since ? { since: options.since } : {}),
      ...(options.run_dir ? { run_dir: options.run_dir } : {}),
    },
    task_ids: taskIds,
    match_values: matchValues,
    runs: runDirs.map((runDir) => path.basename(runDir)),
    redaction: {
      enabled: true,
      include_content: Boolean(options.include_content),
    },
    local_only: true,
  }
  writeFileSync(file, `${redactText(JSON.stringify(manifest, null, 2))}\n`)
}

function copyFilteredRun(runDir, targetDir, matchValues, includeWholeRun) {
  mkdirSync(targetDir, { recursive: true })
  for (const file of textFiles(runDir)) {
    const relativeName = path.basename(file)
    const target = path.join(targetDir, relativeName)
    if (relativeName === 'manifest.json') {
      writeFileSync(target, redactText(readFileSync(file, 'utf8')))
      continue
    }

    if (includeWholeRun) {
      writeFileSync(target, redactText(readFileSync(file, 'utf8')))
      continue
    }

    const matching = readLines(file).filter((line) => lineHasAny(line, matchValues))
    if (matching.length > 0) {
      writeFileSync(target, `${matching.map(redactText).join('\n')}\n`)
    }
  }
}

function createArchive(options, runDirs, taskIds, matchValues) {
  if (runDirs.length === 0) {
    throw new Error('No matching log runs found')
  }
  const stageRoot = mkdtempSync(path.join(os.tmpdir(), 'aamp-logs-bundle-'))
  const bundleName = `aamp-logs-${archiveStamp()}`
  const bundleDir = path.join(stageRoot, bundleName)
  mkdirSync(path.join(bundleDir, 'runs'), { recursive: true })

  const includeWholeRun = Boolean(options.include_content) || (taskIds.length === 0 && !options.task_guid)

  for (const runDir of runDirs) {
    copyFilteredRun(runDir, path.join(bundleDir, 'runs', path.basename(runDir)), matchValues, includeWholeRun)
  }
  writeReadme(path.join(bundleDir, 'README.txt'), options, runDirs, taskIds)
  writeBundleManifest(path.join(bundleDir, 'manifest.json'), options, runDirs, taskIds, matchValues)

  const archiveDir = ensureArchiveDir()
  const archivePath = path.join(archiveDir, `${bundleName}.tar.gz`)
  execFileSync('tar', ['-czf', archivePath, '-C', stageRoot, bundleName])
  rmSync(stageRoot, { recursive: true, force: true })
  return archivePath
}

function collect(options) {
  const logRoot = resolveLogRoot(options)
  let taskIds = []
  if (options.task_id) taskIds = [options.task_id]
  let matchValues = [...taskIds]
  if (options.task_guid) {
    taskIds = collectTaskIdsForGuid(listRunDirs(logRoot), options.task_guid)
    matchValues = [
      taskIdPrefixForGuid(options.task_guid),
      options.task_guid,
      ...taskIds,
    ]
  }

  if (!options.task_id && !options.task_guid && !options.run_dir && !options.latest && !options.since) {
    throw new Error('collect requires --task-id, --task-guid, --run-dir, --latest, or --since')
  }

  const runDirs = selectRuns(logRoot, options, matchValues)
  const archivePath = createArchive(options, runDirs, taskIds, matchValues)
  process.stdout.write(`Created local logs bundle:\n${archivePath}\n`)
}

function listRuns(options) {
  const logRoot = resolveLogRoot(options)
  const runs = listRunDirs(logRoot)
  process.stdout.write(`${runs.map((runDir) => path.basename(runDir)).join('\n')}${runs.length ? '\n' : ''}`)
}

function tailMatchValues(logRoot, options) {
  if (options.task_id && options.task_guid) {
    throw new Error('tail accepts only one of --task-id or --task-guid')
  }
  if (options.task_id) return [options.task_id]
  if (options.task_guid) {
    return [
      taskIdPrefixForGuid(options.task_guid),
      options.task_guid,
      ...collectTaskIdsForGuid(listRunDirs(logRoot), options.task_guid),
    ]
  }
  return []
}

function formatTailLine(runDir, file, line) {
  return `${path.basename(runDir)}/${path.basename(file)}: ${redactText(line)}`
}

function writeMatchingTailLines(runDirs, matchValues) {
  const lines = []
  for (const runDir of runDirs) {
    for (const file of textFiles(runDir)) {
      for (const line of readLines(file)) {
        if (matchValues.length === 0 || lineHasAny(line, matchValues)) {
          lines.push(formatTailLine(runDir, file, line))
        }
      }
    }
  }
  process.stdout.write(`${lines.join('\n')}${lines.length ? '\n' : ''}`)
}

function selectFollowRunDirs(logRoot, matchValues) {
  if (matchValues.length > 0) {
    const matching = selectRuns(logRoot, {}, matchValues)
    if (matching.length > 0) return matching
  }
  const run = latestRun(logRoot)
  return run ? [run] : []
}

function followTailFiles(runDirs, matchValues) {
  const files = runDirs.flatMap((runDir) => textFiles(runDir).map((file) => ({ runDir, file })))
  if (files.length === 0) throw new Error('No log files found to follow')

  const children = []
  let liveChildren = files.length
  const stop = (code = 0) => {
    for (const child of children) {
      if (!child.killed) child.kill()
    }
    process.exit(code)
  }
  process.on('SIGINT', () => stop(0))
  process.on('SIGTERM', () => stop(0))

  for (const { runDir, file } of files) {
    const child = spawn('tail', ['-n', '0', '-f', file], { stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)

    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.length === 0) continue
        if (matchValues.length > 0 && !lineHasAny(line, matchValues)) continue
        process.stdout.write(`${formatTailLine(runDir, file, line)}\n`)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk)
    })
    child.on('exit', () => {
      liveChildren -= 1
      if (liveChildren === 0) process.exit(0)
    })
  }
}

function tail(options) {
  const logRoot = resolveLogRoot(options)
  const matchValues = tailMatchValues(logRoot, options)
  if (options.follow) {
    const runDirs = selectFollowRunDirs(logRoot, matchValues)
    if (runDirs.length === 0) throw new Error('No log runs found to follow')
    if (matchValues.length > 0) writeMatchingTailLines(runDirs, matchValues)
    followTailFiles(runDirs, matchValues)
    return
  }
  if (matchValues.length === 0) throw new Error('tail requires --task-id, --task-guid, or -f')
  writeMatchingTailLines(listRunDirs(logRoot), matchValues)
}

function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    process.stdout.write(`${packageVersion()}\n`)
    return
  }
  const options = parseArgs(args)
  if (options.command === 'collect') {
    collect(options)
    return
  }
  if (options.command === 'list-runs') {
    listRuns(options)
    return
  }
  if (options.command === 'tail') {
    tail(options)
    return
  }
  throw new Error(`Unknown command: ${options.command}`)
}

try {
  main()
} catch (error) {
  process.stderr.write(`aamp-logs: ${(error instanceof Error ? error.message : String(error))}\n`)
  process.exit(1)
}
