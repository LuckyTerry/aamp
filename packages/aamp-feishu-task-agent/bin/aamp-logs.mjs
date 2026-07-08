#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
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
  aamp-logs collect --task-id <task-id>
  aamp-logs collect --task-guid <task-guid>
  aamp-logs collect --latest
  aamp-logs collect --since <duration>
  aamp-logs list-runs
  aamp-logs tail --task-id <task-id>

Options:
  --log-dir <dir>          Override AAMP log root. Defaults to AAMP_LOG_DIR or ~/.aamp/logs.
  --include-content        Include full matching run logs instead of matching fragments only.
  -h, --help               Show this help.
`)
  process.exit(exitCode)
}

function parseArgs(argv) {
  const [command, ...rest] = argv
  if (!command || command === '-h' || command === '--help') usage(0)

  const options = { command }
  const booleanFlags = new Set(['--latest'])
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]
    if (arg === '-h' || arg === '--help') usage(0)
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

function ensureArchiveDir(logRoot) {
  const archiveDir = path.join(logRoot, 'archives')
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

function createArchive(logRoot, options, runDirs, taskIds, matchValues) {
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

  const archiveDir = ensureArchiveDir(logRoot)
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

  if (!options.task_id && !options.task_guid && !options.latest && !options.since) {
    throw new Error('collect requires --task-id, --task-guid, --latest, or --since')
  }

  const runDirs = selectRuns(logRoot, options, matchValues)
  const archivePath = createArchive(logRoot, options, runDirs, taskIds, matchValues)
  process.stdout.write(`Created local logs bundle:\n${archivePath}\n`)
}

function listRuns(options) {
  const logRoot = resolveLogRoot(options)
  const runs = listRunDirs(logRoot)
  process.stdout.write(`${runs.map((runDir) => path.basename(runDir)).join('\n')}${runs.length ? '\n' : ''}`)
}

function tail(options) {
  if (!options.task_id) throw new Error('tail requires --task-id <task-id>')
  const logRoot = resolveLogRoot(options)
  const lines = []
  for (const runDir of listRunDirs(logRoot)) {
    for (const file of textFiles(runDir)) {
      for (const line of readLines(file)) {
        if (line.includes(options.task_id)) {
          lines.push(`${path.basename(runDir)}/${path.basename(file)}: ${redactText(line)}`)
        }
      }
    }
  }
  process.stdout.write(`${lines.join('\n')}${lines.length ? '\n' : ''}`)
}

function main() {
  const options = parseArgs(process.argv.slice(2))
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
