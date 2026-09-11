import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  buildTaskProfileTaskFeishuConfig,
  buildTaskProfileFeishuConfig,
  dedupeTaskProfiles,
  normalizeTaskProfile,
  resolveTaskProfileSelection,
  resolveTaskProfileName,
} from './task-runtime-profile.js'
import { isRetryableAampNetworkError, isSmtpAuthError } from './task-runtime-errors.js'
import {
  buildFeishuPairingDispatchContextRules,
  normalizeTaskRuntimeAgent,
  normalizeTaskRuntimeBotForExecution,
  resolveTaskRuntimeBehavior,
  resolveTaskRuntimeFeishuDomain,
  sendPairRequestIfNeeded,
  ensureTaskRuntimeInstanceConfigs,
  saveTaskRuntimeBots,
} from './task-runtime.js'

test('resolveTaskProfileName uses the app id as the profile suffix', () => {
  assert.equal(resolveTaskProfileName(' cli_a123456 '), 'aamp-feishu-task-cli_a123456')
})

test('normalizeTaskProfile derives lark-cli profile config', () => {
  const profile = normalizeTaskProfile({
    app_id: ' cli_a123456 ',
    app_secret: ' runtime-secret ',
    display_name: ' 飞书 CLI ',
  })

  assert.deepEqual(profile, {
    app_id: 'cli_a123456',
    app_secret: 'runtime-secret',
    profile: 'aamp-feishu-task-cli_a123456',
    display_name: '飞书 CLI',
    auth_mode: 'lark-cli',
    capabilities: ['im', 'task'],
    domains: ['task'],
    updated_at: profile.updated_at,
  })
  assert.match(profile.updated_at, /^\d{4}-\d{2}-\d{2}T/)
})

test('buildTaskProfileFeishuConfig stores cli profile when runtime app secret is unavailable', () => {
  assert.deepEqual(buildTaskProfileFeishuConfig({
    app_id: 'cli_a123456',
    profile: 'aamp-feishu-task-cli_a123456',
    auth_mode: 'lark-cli',
    capabilities: ['im', 'task'],
    domains: ['task'],
    updated_at: '2026-07-03T00:00:00.000Z',
  }), {
    appId: 'cli_a123456',
    authMode: 'lark-cli',
    cliProfile: 'aamp-feishu-task-cli_a123456',
  })
})

test('buildTaskProfileFeishuConfig uses app-secret websocket when runtime app secret is available', () => {
  assert.deepEqual(buildTaskProfileFeishuConfig({
    app_id: 'cli_a123456',
    profile: 'aamp-feishu-task-cli_a123456',
    auth_mode: 'lark-cli',
    capabilities: ['im', 'task'],
    domains: ['task'],
    updated_at: '2026-07-03T00:00:00.000Z',
  }, {
    appSecret: 'runtime-secret',
  }), {
    appId: 'cli_a123456',
    authMode: 'app-secret',
    appSecret: 'runtime-secret',
    cliProfile: 'aamp-feishu-task-cli_a123456',
  })
})

test('buildTaskProfileTaskFeishuConfig passes runtime app secret to Feishu bridge config', () => {
  assert.deepEqual(buildTaskProfileTaskFeishuConfig({
    app_id: 'cli_a123456',
    profile: 'aamp-feishu-task-cli_a123456',
    auth_mode: 'lark-cli',
    capabilities: ['im', 'task'],
    domains: ['task'],
    updated_at: '2026-07-03T00:00:00.000Z',
  }, {
    appSecret: 'runtime-secret',
  }), {
    appId: 'cli_a123456',
    authMode: 'lark-cli',
    cliProfile: 'aamp-feishu-task-cli_a123456',
    appSecret: 'runtime-secret',
  })
})

test('dedupeTaskProfiles preserves existing display name when updating by app id', () => {
  const profiles = dedupeTaskProfiles([
    {
      app_id: 'cli_a123456',
      app_secret: 'cached-secret',
      profile: 'aamp-feishu-task-cli_a123456',
      display_name: '真实 Bot 名称',
      updated_at: '2026-07-03T00:00:00.000Z',
    },
    {
      app_id: 'cli_a123456',
      profile: 'aamp-feishu-task-cli_a123456',
      updated_at: '2026-07-03T00:01:00.000Z',
    },
  ])
  assert.deepEqual(profiles[0]?.display_name, '真实 Bot 名称')
  assert.deepEqual(profiles[0]?.app_secret, 'cached-secret')
})

test('resolveTaskProfileSelection preserves saved app secret in non-interactive app id path', () => {
  const selected = resolveTaskProfileSelection([
    {
      app_id: 'cli_a123456',
      app_secret: 'cached-secret',
      profile: 'aamp-feishu-task-cli_a123456',
      display_name: '缓存 Bot',
      updated_at: '2026-07-03T00:00:00.000Z',
    },
  ], {
    app_id: 'cli_a123456',
    profile: 'aamp-feishu-task-cli_a123456',
    updated_at: '2026-07-03T00:01:00.000Z',
  })

  assert.equal(selected.app_secret, 'cached-secret')
  assert.equal(selected.display_name, '缓存 Bot')
})

test('resolveTaskRuntimeBehavior does not inherit debug from previous runs', () => {
  assert.deepEqual(resolveTaskRuntimeBehavior({}, {
    ackComment: false,
    debug: true,
  }), {
    ackComment: false,
    debug: false,
  })
})

test('resolveTaskRuntimeBehavior enables debug only for the current --debug run', () => {
  assert.deepEqual(resolveTaskRuntimeBehavior({ debug: true }, {
    ackComment: false,
    debug: false,
  }), {
    ackComment: false,
    debug: true,
  })
})

test('resolveTaskRuntimeFeishuDomain clears persisted pre domain for online runs', () => {
  assert.equal(resolveTaskRuntimeFeishuDomain({}), undefined)
  assert.equal(resolveTaskRuntimeFeishuDomain({ pre: true }), 'https://open.feishu-pre.cn')
  assert.equal(resolveTaskRuntimeFeishuDomain({ boe: true }), 'https://open.feishu-boe.cn')
  assert.equal(resolveTaskRuntimeFeishuDomain({ domain: ' https://custom.example.com ' }), 'https://custom.example.com')
})

test('normalizeTaskRuntimeAgent migrates missing execution locations to local', () => {
  assert.deepEqual(normalizeTaskRuntimeAgent({
    type: 'aime',
    display_name: 'Aime',
    target_agent_email: 'aime@meshmail.test',
    updated_at: '2026-08-14T00:00:00.000Z',
  }), {
    type: 'aime',
    display_name: 'Aime',
    target_agent_email: 'aime@meshmail.test',
    execution_location: 'local',
    updated_at: '2026-08-14T00:00:00.000Z',
  })
})

test('normalizeTaskRuntimeAgent retains trusted remote execution locations', () => {
  assert.equal(normalizeTaskRuntimeAgent({
    type: 'aime',
    display_name: 'Aime',
    target_agent_email: 'aime@meshmail.test',
    execution_location: 'remote',
    updated_at: '2026-08-14T00:00:00.000Z',
  }).execution_location, 'remote')
})

test('normalizeTaskRuntimeBotForExecution rejects interactive remote lark-cli selections without an App Secret', () => {
  const localBot = normalizeTaskProfile({
    app_id: 'cli_interactive',
    profile: 'saved-lark-cli-profile',
    auth_mode: 'lark-cli',
  })

  assert.throws(
    () => normalizeTaskRuntimeBotForExecution(localBot, 'remote'),
    /Feishu App Secret is required for remote Task execution/,
  )
})

test('normalizeTaskRuntimeBotForExecution converts saved lark-cli selection with an App Secret to remote-only config', () => {
  const localBot = normalizeTaskProfile({
    app_id: 'cli_interactive',
    app_secret: 'saved-secret',
    profile: 'saved-lark-cli-profile',
    auth_mode: 'lark-cli',
  })
  const remoteBot = normalizeTaskRuntimeBotForExecution(localBot, 'remote')

  assert.equal(remoteBot.auth_mode, 'app-secret')
  assert.equal(remoteBot.profile, undefined)
  assert.deepEqual(buildTaskProfileFeishuConfig(remoteBot), {
    appId: 'cli_interactive',
    appSecret: 'saved-secret',
    authMode: 'app-secret',
  })
  assert.deepEqual(buildTaskProfileTaskFeishuConfig(remoteBot), {
    appId: 'cli_interactive',
    appSecret: 'saved-secret',
    authMode: 'app-secret',
  })
})

test('ensureTaskRuntimeInstanceConfigs persists remote Task configs without lark-cli and with mode 0600', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aamp-feishu-runtime-'))
  const agentEmail = 'aime@meshmail.test'
  const appId = 'cli_remote'
  const instanceId = `aime-${createHash('sha256').update(agentEmail).digest('hex').slice(0, 8)}-cli-remote`
  const imDir = join(root, 'task-runtime', 'instances', instanceId, 'im')
  const mailbox = {
    email: 'bridge@meshmail.test',
    mailboxToken: 'mailbox-token',
    smtpPassword: 'smtp-password',
    baseUrl: 'https://meshmail.test',
  }
  try {
    await mkdir(imDir, { recursive: true })
    await writeFile(join(imDir, 'config.json'), JSON.stringify({
      version: 1,
      aampHost: 'https://meshmail.test',
      targetAgentEmail: agentEmail,
      slug: instanceId,
      feishu: { appId, appSecret: 'remote-secret' },
      mailbox,
      behavior: { streamThrottleMs: 700, streamThrottleChars: 40 },
    }))

    const selection = {
      agent: {
        type: 'aime',
        display_name: 'Aime',
        target_agent_email: agentEmail,
        execution_location: 'remote' as const,
        updated_at: '2026-08-14T00:00:00.000Z',
      },
      bot: normalizeTaskProfile({
        app_id: appId,
        app_secret: 'remote-secret',
        auth_mode: 'app-secret',
      }),
    }
    const first = await ensureTaskRuntimeInstanceConfigs(selection, { configDir: root })
    const second = await ensureTaskRuntimeInstanceConfigs(selection, { configDir: root })
    const savedTaskConfig = JSON.parse(await readFile(join(second.taskDir, 'config.json'), 'utf8'))
    const savedImConfig = JSON.parse(await readFile(join(second.imDir, 'config.json'), 'utf8'))

    assert.equal((await stat(join(first.taskDir, 'config.json'))).mode & 0o777, 0o600)
    assert.equal((await stat(join(first.imDir, 'config.json'))).mode & 0o777, 0o600)
    assert.deepEqual(savedTaskConfig.agent, { type: 'aime', executionLocation: 'remote' })
    assert.equal(savedTaskConfig.feishu.authMode, 'app-secret')
    assert.equal(savedTaskConfig.feishu.cliProfile, undefined)
    assert.equal(savedTaskConfig.feishu.cliBin, undefined)
    assert.equal(savedImConfig.feishu.authMode, 'app-secret')
    assert.equal(savedImConfig.feishu.cliProfile, undefined)
    assert.equal(savedImConfig.feishu.cliBin, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('saveTaskRuntimeBots persists app-secret profiles with mode 0600 after replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aamp-feishu-runtime-profiles-'))
  const target = join(root, 'task-runtime', 'task-profiles-v2.json')
  try {
    await saveTaskRuntimeBots([normalizeTaskProfile({
      app_id: 'cli_remote',
      app_secret: 'first-secret',
      auth_mode: 'app-secret',
    })], root)
    await saveTaskRuntimeBots([normalizeTaskProfile({
      app_id: 'cli_remote',
      app_secret: 'second-secret',
      auth_mode: 'app-secret',
    })], root)

    assert.equal((await stat(target)).mode & 0o777, 0o600)
    const saved = JSON.parse(await readFile(target, 'utf8'))
    assert.equal(saved.profiles[0].app_secret, 'second-secret')
    assert.equal(saved.profiles[0].auth_mode, 'app-secret')
    assert.equal(saved.profiles[0].profile, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('isRetryableAampNetworkError detects transient AAMP connect timeout errors', () => {
  const error = new Error('fetch failed', {
    cause: Object.assign(new Error('Connect Timeout Error'), {
      code: 'UND_ERR_CONNECT_TIMEOUT',
    }),
  })

  assert.equal(isRetryableAampNetworkError(error), true)
  assert.equal(isRetryableAampNetworkError(new Error('400 bad request')), false)
})

test('isSmtpAuthError detects stale mailbox SMTP credentials', () => {
  assert.equal(isSmtpAuthError(new Error('Invalid login: 535 5.7.8 Authentication credentials invalid.')), true)
  assert.equal(isSmtpAuthError(new Error('fetch failed')), false)
})

test('buildFeishuPairingDispatchContextRules forces the Feishu app owner open id', () => {
  assert.deepEqual(buildFeishuPairingDispatchContextRules({
    source: ['untrusted-source'],
    tenant_key: ['tenant-a'],
    sender_open_id: ['untrusted-user'],
  }, ' ou_owner '), {
    source: ['untrusted-source'],
    tenant_key: ['tenant-a'],
    sender_open_id: ['ou_owner'],
  })
})

test('sendPairRequestIfNeeded resolves the owner before sending and includes the owner rule', async () => {
  const sent: Array<Record<string, unknown>> = []
  await sendPairRequestIfNeeded({
    email: 'bridge@meshmail.test',
    mailboxToken: 'mailbox-token',
    smtpPassword: 'smtp-password',
    baseUrl: 'https://meshmail.test',
  }, 'aamp://connect?mailbox=agent%40meshmail.test&pair_code=pair-code', {
    appId: 'cli_owner',
    appSecret: 'secret',
    userIdType: 'open_id',
    eventNames: ['task.task.update_user_access_v2'],
  }, {}, {
    getAppOwner: async () => ({ ownerId: 'ou_owner' }),
    sendPairRequest: async (request) => {
      sent.push(request as unknown as Record<string, unknown>)
    },
  })

  assert.deepEqual(sent, [{
    to: 'agent@meshmail.test',
    pairCode: 'pair-code',
    dispatchContextRules: {
      source: ['feishu', 'feishu-task'],
      sender_open_id: ['ou_owner'],
    },
  }])
})

test('sendPairRequestIfNeeded fails closed when the Feishu app owner cannot be resolved', async () => {
  let sendCount = 0
  await assert.rejects(
    () => sendPairRequestIfNeeded({
      email: 'bridge@meshmail.test',
      mailboxToken: 'mailbox-token',
      smtpPassword: 'smtp-password',
      baseUrl: 'https://meshmail.test',
    }, 'aamp://connect?mailbox=agent%40meshmail.test&pair_code=pair-code', {
      appId: 'cli_owner',
      appSecret: 'secret',
      userIdType: 'open_id',
      eventNames: ['task.task.update_user_access_v2'],
    }, {}, {
      getAppOwner: async () => {
        throw new Error('owner lookup failed')
      },
      sendPairRequest: async () => {
        sendCount += 1
      },
    }),
    /owner lookup failed/,
  )
  assert.equal(sendCount, 0)
})

test('sendPairRequestIfNeeded defers the raw SMTP diagnostic while a stale mailbox is being refreshed', async () => {
  const output: string[] = []
  const originalWarn = console.warn
  const originalError = console.error
  console.warn = (...values: unknown[]) => output.push(values.join(' '))
  console.error = (...values: unknown[]) => output.push(values.join(' '))
  try {
    await assert.rejects(
      () => sendPairRequestIfNeeded({
        email: 'stale@meshmail.test',
        mailboxToken: 'stale-token',
        smtpPassword: 'stale-password',
        baseUrl: 'https://meshmail.test',
      }, 'aamp://connect?mailbox=agent%40meshmail.test&pair_code=pair-code', {
        appId: 'cli_owner',
        appSecret: 'secret',
        userIdType: 'open_id',
        eventNames: ['task.task.update_user_access_v2'],
      }, {
        retrySmtpAuth: false,
        deferSmtpAuthDiagnostic: true,
      }, {
        getAppOwner: async () => ({ ownerId: 'ou_owner' }),
        sendPairRequest: async () => {
          throw new Error('Invalid login: 535 5.7.8 Authentication credentials invalid.')
        },
      }),
      /535/,
    )
  } finally {
    console.warn = originalWarn
    console.error = originalError
  }
  assert.match(output.join('\n'), /requires credential refresh before pairing/)
  assert.doesNotMatch(output.join('\n'), /535|authentication credentials invalid/i)
})

test('sendPairRequestIfNeeded waits for a fresh mailbox SMTP credential without exposing a recoverable 535', async () => {
  const output: string[] = []
  const originalWarn = console.warn
  const originalError = console.error
  console.warn = (...values: unknown[]) => output.push(values.join(' '))
  console.error = (...values: unknown[]) => output.push(values.join(' '))
  let attempts = 0
  try {
    await sendPairRequestIfNeeded({
      email: 'fresh@meshmail.test',
      mailboxToken: 'fresh-token',
      smtpPassword: 'fresh-password',
      baseUrl: 'https://meshmail.test',
    }, 'aamp://connect?mailbox=agent%40meshmail.test&pair_code=pair-code', {
      appId: 'cli_owner',
      appSecret: 'secret',
      userIdType: 'open_id',
      eventNames: ['task.task.update_user_access_v2'],
    }, {}, {
      getAppOwner: async () => ({ ownerId: 'ou_owner' }),
      sendPairRequest: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('Invalid login: 535 5.7.8 Authentication credentials invalid.')
      },
    })
  } finally {
    console.warn = originalWarn
    console.error = originalError
  }
  assert.equal(attempts, 2)
  assert.match(output.join('\n'), /waiting for mailbox SMTP readiness/)
  assert.doesNotMatch(output.join('\n'), /535|authentication credentials invalid/i)
})

test('ensureTaskRuntimeInstanceConfigs refreshes a stale mailbox and persists the replacement before pairing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aamp-feishu-runtime-refresh-'))
  const agentEmail = 'aime@meshmail.test'
  const appId = 'cli_remote'
  const instanceId = `aime-${createHash('sha256').update(agentEmail).digest('hex').slice(0, 8)}-cli-remote`
  const imDir = join(root, 'task-runtime', 'instances', instanceId, 'im')
  const staleMailbox = {
    email: 'stale@meshmail.test',
    mailboxToken: 'stale-token',
    smtpPassword: 'stale-password',
    baseUrl: 'https://meshmail.test',
  }
  const freshMailbox = {
    email: 'fresh@meshmail.test',
    mailboxToken: 'fresh-token',
    smtpPassword: 'fresh-password',
    baseUrl: 'https://meshmail.test',
  }
  try {
    await mkdir(imDir, { recursive: true })
    await writeFile(join(imDir, 'config.json'), JSON.stringify({
      version: 1,
      aampHost: 'https://meshmail.test',
      targetAgentEmail: agentEmail,
      slug: instanceId,
      feishu: { appId, appSecret: 'remote-secret' },
      mailbox: staleMailbox,
      behavior: { streamThrottleMs: 700, streamThrottleChars: 40 },
    }))
    const selection = {
      agent: {
        type: 'aime',
        display_name: 'Aime',
        target_agent_email: agentEmail,
        execution_location: 'remote' as const,
        updated_at: '2026-08-14T00:00:00.000Z',
      },
      bot: normalizeTaskProfile({
        app_id: appId,
        app_secret: 'remote-secret',
        auth_mode: 'app-secret',
      }),
      pairingUrl: 'aamp://connect?mailbox=agent%40meshmail.test&pair_code=pair-code',
    }
    const pairedMailboxEmails: string[] = []
    let registrations = 0
    const configured = await ensureTaskRuntimeInstanceConfigs(selection, { configDir: root }, {
      registerMailbox: async () => {
        registrations += 1
        return freshMailbox
      },
      sendPairRequestIfNeeded: async (mailbox) => {
        pairedMailboxEmails.push(mailbox.email)
        if (mailbox.email === staleMailbox.email) {
          throw new Error('Invalid login: 535 5.7.8 Authentication credentials invalid.')
        }
      },
    })
    const savedTaskConfig = JSON.parse(await readFile(join(configured.taskDir, 'config.json'), 'utf8'))
    const savedImConfig = JSON.parse(await readFile(join(configured.imDir, 'config.json'), 'utf8'))

    assert.equal(registrations, 1)
    assert.deepEqual(pairedMailboxEmails, [staleMailbox.email, freshMailbox.email])
    assert.deepEqual(savedTaskConfig.mailbox, freshMailbox)
    assert.deepEqual(savedImConfig.mailbox, freshMailbox)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
