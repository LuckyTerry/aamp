import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

test('controller writes Task-only runtime profiles', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-controller-task-profile-'))
  process.env.AAMP_TASK_STATE_HOME = path.join(root, 'state')
  process.env.AAMP_TASK_RUNTIME_HOME = root
  process.env.AAMP_RUN_LOG_DIR = path.join(root, 'logs')

  const controllerUrl = new URL('../bin/feishu-task-agent-controller.mjs', import.meta.url)
  controllerUrl.searchParams.set('test', String(Date.now()))
  const controller = await import(pathToFileURL(controllerUrl.pathname).href + controllerUrl.search)
  assert.equal(typeof controller.writeFeishuRuntimeProfile, 'function')

  const feishuConfigDir = path.join(root, 'bindings', 'binding-1', 'feishu')
  await controller.writeFeishuRuntimeProfile({
    agent_type: 'codex',
    feishu_config_dir: feishuConfigDir,
    bot: {
      app_id: 'cli_task',
      app_secret: 'secret',
      display_name: 'Task Bot',
      lark_cli_profile: 'profile-task',
    },
  })

  const profileFile = path.join(feishuConfigDir, 'task-runtime', 'task-profiles-v2.json')
  const profile = JSON.parse(readFileSync(profileFile, 'utf8')).profiles[0]
  assert.deepEqual(profile.domains, ['task'])
})
