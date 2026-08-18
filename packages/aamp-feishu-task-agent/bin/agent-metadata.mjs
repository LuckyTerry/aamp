import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const TASK_AGENT_METADATA = Object.freeze({
  codex: Object.freeze({ executionLocation: 'local' }),
  cursor: Object.freeze({ executionLocation: 'local' }),
  coco: Object.freeze({ executionLocation: 'local' }),
  traex: Object.freeze({ executionLocation: 'local' }),
  traecli: Object.freeze({ executionLocation: 'local' }),
  workbuddy: Object.freeze({ executionLocation: 'local' }),
  workbuddy_ai: Object.freeze({ executionLocation: 'local' }),
  aime: Object.freeze({
    executionLocation: 'remote',
    attachmentPolicy: 'reject',
    taskDispatchConcurrency: 1,
  }),
})

export const TASK_AGENT_TYPES = Object.freeze(Object.keys(TASK_AGENT_METADATA))

export function resolveTaskAgentMetadata(agentType) {
  const normalized = String(agentType ?? '').trim()
  const metadata = TASK_AGENT_METADATA[normalized]
  if (!metadata) throw new Error(`Unknown Task Agent type: ${normalized || '(empty)'}`)
  return { ...metadata }
}

function isMainModule() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMainModule()) {
  if (process.argv[2] !== '--json' || !process.argv[3] || process.argv[4]) {
    console.error('Usage: node agent-metadata.mjs --json <agent-type>')
    process.exitCode = 2
  } else {
    try {
      const agentType = process.argv[3].trim()
      process.stdout.write(`${JSON.stringify({
        schemaVersion: 1,
        agentType,
        ...resolveTaskAgentMetadata(agentType),
      })}\n`)
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  }
}
