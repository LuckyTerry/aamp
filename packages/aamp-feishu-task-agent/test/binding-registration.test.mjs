import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  checkAgentRegistered,
  fetchTenantAccessToken,
  filterRegisteredBindings,
  parseAgentRegisteredResponse,
  removeUnboundBindings,
  runStart,
} from '../bin/feishu-task-agent-controller.mjs'

function binding(appId, tenantBrand = 'feishu') {
  return {
    binding_id: `binding-${appId}`,
    agent_type: 'codex',
    bot: {
      app_id: appId,
      app_secret: `secret-${appId}`,
      display_name: `Bot ${appId}`,
      tenant_brand: tenantBrand,
    },
    updated_at: `updated-${appId}`,
  }
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  }
}

test('fetchTenantAccessToken uses the application credentials for the matching tenant domain', async () => {
  const requests = []
  const token = await fetchTenantAccessToken(binding('cli_test_app', 'lark'), {
    fetch: async (url, options) => {
      requests.push({ url, options })
      return jsonResponse({ code: 0, tenant_access_token: 'tenant-token' })
    },
  })

  assert.equal(token, 'tenant-token')
  assert.equal(requests[0].url, 'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal')
  assert.equal(requests[0].options.method, 'POST')
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    app_id: 'cli_test_app',
    app_secret: 'secret-cli_test_app',
  })
  assert.equal(Object.hasOwn(requests[0].options.headers, 'x-use-ppe'), false)
  assert.equal(Object.hasOwn(requests[0].options.headers, 'x-tt-env'), false)
})

test('checkAgentRegistered calls the production task OpenAPI path with tenant authentication', async () => {
  const requests = []
  const registered = await checkAgentRegistered(binding('cli_test_app'), {
    fetchTenantAccessToken: async () => 'tenant-token',
    fetch: async (url, options) => {
      requests.push({ url, options })
      return jsonResponse({ code: 0, data: { is_bound: true } })
    },
  })

  assert.equal(registered, true)
  assert.equal(
    requests[0].url,
    'https://open.feishu.cn/open-apis/task/v2/agent/check_agent_registered_oapi_v_2',
  )
  assert.equal(requests[0].options.method, 'POST')
  assert.equal(requests[0].options.headers.Authorization, 'Bearer tenant-token')
  assert.equal(Object.hasOwn(requests[0].options.headers, 'x-use-ppe'), false)
  assert.equal(Object.hasOwn(requests[0].options.headers, 'x-tt-env'), false)
  assert.equal(requests[0].options.body, '{}')
})

test('parseAgentRegisteredResponse accepts the generated IsBound response shape', () => {
  assert.equal(parseAgentRegisteredResponse({ IsBound: false }), false)
  assert.equal(parseAgentRegisteredResponse({ data: { IsBound: true } }), true)
  assert.throws(
    () => parseAgentRegisteredResponse({ code: 0, data: {} }),
    /响应缺少 IsBound/,
  )
})

test('filterRegisteredBindings preserves order and removes unbound applications', async () => {
  const bindings = [binding('app-a'), binding('app-b'), binding('app-c')]
  const checked = []
  const result = await filterRegisteredBindings(bindings, {
    checkAgentRegistered: async (item) => {
      checked.push(item.bot.app_id)
      return item.bot.app_id !== 'app-b'
    },
  })

  assert.deepEqual(checked, ['app-a', 'app-b', 'app-c'])
  assert.deepEqual(result.availableBindings.map((item) => item.bot.app_id), ['app-a', 'app-c'])
  assert.deepEqual(result.unboundBindings.map((item) => item.bot.app_id), ['app-b'])
  assert.deepEqual(result.failures, [])
})

test('filterRegisteredBindings limits status checks to three concurrent requests', async () => {
  const bindings = Array.from({ length: 8 }, (_value, index) => binding(`app-${index}`))
  let active = 0
  let maxActive = 0
  const result = await filterRegisteredBindings(bindings, {
    checkAgentRegistered: async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return true
    },
  })

  assert.equal(maxActive, 3)
  assert.equal(result.availableBindings.length, bindings.length)
})

test('start deletes and hides bindings that are explicitly unbound', async () => {
  const bindings = [binding('app-a'), binding('app-b')]
  const calls = []
  await runStart({
    background: false,
    loadBindings: async () => bindings,
    filterRegisteredBindings: async (items) => ({
      availableBindings: items.filter((item) => item.bot.app_id === 'app-a'),
      unboundBindings: items.filter((item) => item.bot.app_id === 'app-b'),
      failures: [],
    }),
    removeUnboundBindings: async (items) => {
      calls.push(`remove:${items.map((item) => item.bot.app_id).join(',')}`)
      return items.length
    },
    acquireLease: async () => calls.push('lease'),
    chooseBindings: async (_prompt, available) => {
      calls.push(`choose:${available.map((item) => item.bot.app_id).join(',')}`)
      return available
    },
    startBindings: async (selected) => calls.push(`start:${selected.map((item) => item.bot.app_id).join(',')}`),
    log: (message) => calls.push(message),
  })

  assert.deepEqual(calls, [
    'remove:app-b',
    'lease',
    'choose:app-a',
    'start:app-a',
  ])
})

test('binding status failures keep the binding available by default', async () => {
  const item = binding('app-a')
  const result = await filterRegisteredBindings([item], {
    checkAgentRegistered: async () => { throw new Error('HTTP 503') },
  })

  assert.deepEqual(result.availableBindings, [item])
  assert.deepEqual(result.unboundBindings, [])
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].binding, item)
  assert.match(result.failures[0].reason.message, /HTTP 503/)
})

test('removeUnboundBindings only deletes the exact stale local revisions', async () => {
  const stale = binding('app-a')
  const changed = { ...binding('app-b'), updated_at: 'newer-revision' }
  const current = [stale, changed, binding('app-c')]
  let written
  const removed = await removeUnboundBindings([stale, binding('app-b')], {
    loadBindings: async () => current,
    writeBindings: async (bindings) => { written = bindings },
  })

  assert.equal(removed, 1)
  assert.deepEqual(written.map((item) => item.bot.app_id), ['app-b', 'app-c'])
})
