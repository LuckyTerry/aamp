import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  TASK_AGENT_TYPES,
  resolveTaskAgentMetadata,
} from '../bin/agent-metadata.mjs'

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))
const metadataBin = join(packageDir, 'bin', 'agent-metadata.mjs')

test('known agents have one execution policy and Aime is the only remote agent', () => {
  assert.deepEqual(TASK_AGENT_TYPES, [
    'codex', 'cursor', 'coco', 'traex', 'traecli', 'workbuddy', 'workbuddy_ai', 'aime',
  ])
  for (const type of TASK_AGENT_TYPES.filter((value) => value !== 'aime')) {
    assert.deepEqual(resolveTaskAgentMetadata(type), { executionLocation: 'local' })
  }
  assert.deepEqual(resolveTaskAgentMetadata('aime'), {
    executionLocation: 'remote',
    attachmentPolicy: 'reject',
    taskDispatchConcurrency: 1,
  })
  assert.throws(() => resolveTaskAgentMetadata('unknown-agent'), /Unknown Task Agent type/)
})

test('metadata JSON query is import-safe and deterministic', () => {
  const run = spawnSync(process.execPath, [metadataBin, '--json', 'aime'], { encoding: 'utf8' })
  assert.equal(run.status, 0)
  assert.equal(run.stderr, '')
  assert.deepEqual(JSON.parse(run.stdout), {
    schemaVersion: 1,
    agentType: 'aime',
    executionLocation: 'remote',
    attachmentPolicy: 'reject',
    taskDispatchConcurrency: 1,
  })
})
