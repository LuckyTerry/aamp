import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { applyFeishuRuntimeOverrides, getConfigPath, initializeBridgeConfig, loadBridgeConfig } from './config.js'
import type { BridgeConfig } from './types.js'

const legacyConfig: BridgeConfig = {
  version: 1,
  aampHost: 'https://meshmail.ai',
  targetAgentEmail: 'agent@meshmail.ai',
  slug: 'feishu-task-bridge',
  feishu: {
    appId: 'cli_xxx',
    appSecret: 'secret',
    userIdType: 'open_id',
    eventNames: ['task.task.updated_v1', 'task.task.update_tenant_v1'],
  },
  mailbox: {
    email: 'bridge@meshmail.ai',
    mailboxToken: Buffer.from('bridge@meshmail.ai:password').toString('base64'),
    smtpPassword: 'password',
    baseUrl: 'https://meshmail.ai',
  },
  behavior: {
    ackComment: true,
  },
}

test('loadBridgeConfig migrates the old default task events to update_user_access_v2', async () => {
  const configDir = await mkdir(path.join(os.tmpdir(), `aamp-feishu-task-bridge-${Date.now()}-`), { recursive: true })
  try {
    await writeFile(getConfigPath(configDir), `${JSON.stringify(legacyConfig, null, 2)}\n`, 'utf8')
    const config = await loadBridgeConfig(configDir)
    assert.deepEqual(config?.feishu.eventNames, ['task.task.update_user_access_v2'])
  } finally {
    await rm(configDir, { recursive: true, force: true })
  }
})

test('initializeBridgeConfig preserves explicitly provided event names', async () => {
  const configDir = await mkdir(path.join(os.tmpdir(), `aamp-feishu-task-bridge-${Date.now()}-explicit-`), { recursive: true })
  try {
    await writeFile(getConfigPath(configDir), `${JSON.stringify(legacyConfig, null, 2)}\n`, 'utf8')
    const config = await initializeBridgeConfig({
      configDir,
      eventNames: ['task.task.updated_v1'],
    })
    assert.deepEqual(config.feishu.eventNames, ['task.task.updated_v1'])
  } finally {
    await rm(configDir, { recursive: true, force: true })
  }
})

test('initializeBridgeConfig does not persist ByteDance BOE runtime routing', async () => {
  const configDir = await mkdir(path.join(os.tmpdir(), `aamp-feishu-task-bridge-${Date.now()}-boe-`), { recursive: true })
  try {
    await writeFile(getConfigPath(configDir), `${JSON.stringify(legacyConfig, null, 2)}\n`, 'utf8')
    const config = await initializeBridgeConfig({
      configDir,
      boe: true,
    })
    assert.equal(config.feishu.domain, undefined)
    assert.equal(config.feishu.headers, undefined)
  } finally {
    await rm(configDir, { recursive: true, force: true })
  }
})

test('initializeBridgeConfig does not persist explicit Feishu env routing', async () => {
  const configDir = await mkdir(path.join(os.tmpdir(), `aamp-feishu-task-bridge-${Date.now()}-env-`), { recursive: true })
  try {
    await writeFile(getConfigPath(configDir), `${JSON.stringify(legacyConfig, null, 2)}\n`, 'utf8')
    const config = await initializeBridgeConfig({
      configDir,
      boe: true,
      env: 'boe_gray_task_event',
      debug: true,
    })
    assert.equal(config.feishu.domain, undefined)
    assert.equal(config.feishu.headers, undefined)
    assert.equal(config.behavior.debug, false)
  } finally {
    await rm(configDir, { recursive: true, force: true })
  }
})

test('loadBridgeConfig drops legacy persisted debug mode', async () => {
  const configDir = await mkdir(path.join(os.tmpdir(), `aamp-feishu-task-bridge-${Date.now()}-debug-`), { recursive: true })
  try {
    await writeFile(getConfigPath(configDir), `${JSON.stringify({
      ...legacyConfig,
      behavior: {
        ...legacyConfig.behavior,
        debug: true,
      },
    }, null, 2)}\n`, 'utf8')
    const config = await loadBridgeConfig(configDir)
    assert.equal(config?.behavior.debug, false)
  } finally {
    await rm(configDir, { recursive: true, force: true })
  }
})

test('initializeBridgeConfig does not persist PRE runtime routing', async () => {
  const configDir = await mkdir(path.join(os.tmpdir(), `aamp-feishu-task-bridge-${Date.now()}-pre-`), { recursive: true })
  try {
    await writeFile(getConfigPath(configDir), `${JSON.stringify(legacyConfig, null, 2)}\n`, 'utf8')
    const config = await initializeBridgeConfig({
      configDir,
      pre: true,
      env: 'ppe_task_event',
    })
    assert.equal(config.feishu.domain, undefined)
    assert.equal(config.feishu.headers, undefined)
  } finally {
    await rm(configDir, { recursive: true, force: true })
  }
})

test('loadBridgeConfig drops legacy persisted Feishu runtime routing', async () => {
  const configDir = await mkdir(path.join(os.tmpdir(), `aamp-feishu-task-bridge-${Date.now()}-boe-domain-`), { recursive: true })
  try {
    await writeFile(getConfigPath(configDir), `${JSON.stringify({
      ...legacyConfig,
      feishu: {
        ...legacyConfig.feishu,
        domain: 'https://open.feishu-boe.cn',
        headers: {
          'x-tt-env': 'boe_task_event',
        },
      },
    }, null, 2)}\n`, 'utf8')
    const config = await loadBridgeConfig(configDir)
    assert.equal(config?.feishu.domain, undefined)
    assert.equal(config?.feishu.headers, undefined)
  } finally {
    await rm(configDir, { recursive: true, force: true })
  }
})

test('applyFeishuRuntimeOverrides drops config routing without explicit runtime flags', () => {
  const config = applyFeishuRuntimeOverrides({
    ...legacyConfig,
    feishu: {
      ...legacyConfig.feishu,
      domain: 'https://open.feishu-pre.cn',
      headers: {
        'x-use-ppe': '1',
        'x-tt-env': 'ppe_task_event',
      },
    },
  }, {})

  assert.equal(config.feishu.domain, undefined)
  assert.equal(config.feishu.headers, undefined)
})

test('applyFeishuRuntimeOverrides drops persisted debug without explicit runtime flag', () => {
  const config = applyFeishuRuntimeOverrides({
    ...legacyConfig,
    behavior: {
      ...legacyConfig.behavior,
      debug: true,
    },
  }, {})

  assert.equal(config.behavior.debug, false)
})

test('applyFeishuRuntimeOverrides supports start-time BOE overrides', () => {
  const config = applyFeishuRuntimeOverrides(legacyConfig, {
    boe: true,
  })

  assert.equal(config.feishu.domain, 'https://open.feishu-boe.cn')
  assert.equal(config.feishu.headers, undefined)
})

test('applyFeishuRuntimeOverrides supports start-time env and debug overrides', () => {
  const config = applyFeishuRuntimeOverrides(legacyConfig, {
    boe: true,
    env: 'boe_gray_task_event',
    debug: true,
  })

  assert.equal(config.feishu.domain, 'https://open.feishu-boe.cn')
  assert.deepEqual(config.feishu.headers, {
    'x-tt-env': 'boe_gray_task_event',
  })
  assert.equal(config.behavior.debug, true)
})

test('applyFeishuRuntimeOverrides supports PRE env headers', () => {
  const config = applyFeishuRuntimeOverrides(legacyConfig, {
    pre: true,
    env: 'ppe_task_event',
  })

  assert.equal(config.feishu.domain, 'https://open.feishu-pre.cn')
  assert.deepEqual(config.feishu.headers, {
    'x-use-ppe': '1',
    'x-tt-env': 'ppe_task_event',
  })
})

test('applyFeishuRuntimeOverrides supports PPE env headers on the current domain', () => {
  const config = applyFeishuRuntimeOverrides(legacyConfig, {
    env: 'ppe_task_event',
  })

  assert.equal(config.feishu.domain, undefined)
  assert.deepEqual(config.feishu.headers, {
    'x-use-ppe': '1',
    'x-tt-env': 'ppe_task_event',
  })
})
