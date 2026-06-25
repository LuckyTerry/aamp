import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createFeishuHttpInstance, normalizeFeishuTaskEvent, OapiFeishuTaskClient } from './feishu.js'

test('normalizeFeishuTaskEvent accepts sdk-flattened v2 task events', () => {
  const event = normalizeFeishuTaskEvent({
    event_id: 'evt_v2',
    event_type: 'task.task.update_user_access_v2',
    create_time: '1775793266152',
    event_types: ['task_create', 'task_summary_update'],
    task_guid: 'task_guid_v2',
  }, 'task.task.update_user_access_v2')

  assert.equal(event?.eventId, 'evt_v2')
  assert.equal(event?.taskGuid, 'task_guid_v2')
  assert.deepEqual(event?.eventTypes, ['task_create', 'task_summary_update'])
  assert.equal(event?.timestamp, '1775793266152')
})

test('normalizeFeishuTaskEvent reads sdk-flattened task summary updates from event_types', () => {
  const event = normalizeFeishuTaskEvent({
    event_id: 'evt_summary',
    event_type: 'task.task.update_user_access_v2',
    event_types: ['task_summary_update'],
    task_guid: 'task_guid_summary',
  }, 'task.task.update_user_access_v2')

  assert.equal(event?.eventId, 'evt_summary')
  assert.equal(event?.taskGuid, 'task_guid_summary')
  assert.deepEqual(event?.eventTypes, ['task_summary_update'])
})

test('normalizeFeishuTaskEvent ignores raw v2 envelope events', () => {
  const event = normalizeFeishuTaskEvent({
    schema: '2.0',
    header: {
      event_id: 'evt_raw',
      event_type: 'task.task.update_user_access_v2',
      create_time: '1775793266152',
    },
    event: {
      event_types: ['task_comment_create'],
      task_guid: 'task_guid_raw',
    },
  }, 'task.task.update_user_access_v2')

  assert.equal(event, null)
})

test('normalizeFeishuTaskEvent requires an event_id', () => {
  const event = normalizeFeishuTaskEvent({
    event_type: 'task.task.update_user_access_v2',
    event_types: ['task_create'],
    task_guid: 'task_guid_without_event_id',
  }, 'task.task.update_user_access_v2')

  assert.equal(event, null)
})

test('normalizeFeishuTaskEvent requires event.task_guid', () => {
  const event = normalizeFeishuTaskEvent({
    event_id: 'evt_without_task_guid',
    event_type: 'task.task.update_user_access_v2',
    event_types: ['task_create'],
  }, 'task.task.update_user_access_v2')

  assert.equal(event, null)
})

test('createFeishuHttpInstance injects configured HTTP headers', async () => {
  const http = createFeishuHttpInstance({
    'x-tt-env': 'boe_task_event',
  })
  assert.ok(http)

  const result = await http.request({
    method: 'GET',
    url: 'https://example.invalid/test',
    headers: {
      locale: 'zh',
    },
    adapter: async (config: { headers?: unknown }) => ({
      data: {
        headers: config.headers,
      },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    }),
  } as never) as { headers: Record<string, string> & { get?: (key: string) => string | undefined } }

  assert.equal(result.headers['x-tt-env'] ?? result.headers.get?.('x-tt-env'), 'boe_task_event')
  assert.equal(result.headers.locale ?? result.headers.get?.('locale'), 'zh')
})

test('OapiFeishuTaskClient completes agent tasks by patching v2 agent_task_status', async () => {
  const calls: unknown[] = []
  const client = new OapiFeishuTaskClient({
    appId: 'cli_xxx',
    appSecret: 'secret',
    eventNames: ['task.task.update_user_access_v2'],
  }, {
    logger: { log: () => {}, error: () => {} },
  })
  ;(client as unknown as { client: unknown }).client = {
    task: {
      v2: {
        task: {
          patch: async (payload: unknown) => {
            calls.push(payload)
          },
        },
      },
    },
  }

  await client.completeTask('task_guid_done')

  assert.deepEqual(calls, [{
    path: { task_guid: 'task_guid_done' },
    params: { user_id_type: undefined },
    data: {
      task: {
        agent_task_status: 4,
        agent_task_progress: '执行完成',
      },
      update_fields: ['agent_task_status', 'agent_task_progress'],
    },
  }])
})

test('OapiFeishuTaskClient marks agent tasks blocked with progress text', async () => {
  const calls: unknown[] = []
  const client = new OapiFeishuTaskClient({
    appId: 'cli_xxx',
    appSecret: 'secret',
    eventNames: ['task.task.update_user_access_v2'],
  }, {
    logger: { log: () => {}, error: () => {} },
  })
  ;(client as unknown as { client: unknown }).client = {
    task: {
      v2: {
        task: {
          patch: async (payload: unknown) => {
            calls.push(payload)
          },
        },
      },
    },
  }

  await client.markTaskWaitingForHuman('task_guid_blocked')

  assert.deepEqual(calls, [{
    path: { task_guid: 'task_guid_blocked' },
    params: { user_id_type: undefined },
    data: {
      task: {
        agent_task_status: 3,
        agent_task_progress: '待确认',
      },
      update_fields: ['agent_task_status', 'agent_task_progress'],
    },
  }])
})

test('OapiFeishuTaskClient marks agent tasks in progress with progress text', async () => {
  const calls: unknown[] = []
  const client = new OapiFeishuTaskClient({
    appId: 'cli_xxx',
    appSecret: 'secret',
    eventNames: ['task.task.update_user_access_v2'],
  }, {
    logger: { log: () => {}, error: () => {} },
  })
  ;(client as unknown as { client: unknown }).client = {
    task: {
      v2: {
        task: {
          patch: async (payload: unknown) => {
            calls.push(payload)
          },
        },
      },
    },
  }

  await client.markTaskInProgress('task_guid_running')

  assert.deepEqual(calls, [{
    path: { task_guid: 'task_guid_running' },
    params: { user_id_type: undefined },
    data: {
      task: {
        agent_task_status: 2,
        agent_task_progress: '正在执行',
      },
      update_fields: ['agent_task_status', 'agent_task_progress'],
    },
  }])
})

test('OapiFeishuTaskClient appends text deliveries through v2 task patch', async () => {
  const calls: unknown[] = []
  const client = new OapiFeishuTaskClient({
    appId: 'cli_xxx',
    appSecret: 'secret',
    eventNames: ['task.task.update_user_access_v2'],
  }, {
    logger: { log: () => {}, error: () => {} },
  })
  ;(client as unknown as { client: unknown }).client = {
    task: {
      v2: {
        task: {
          patch: async (payload: unknown) => {
            calls.push(payload)
          },
        },
      },
    },
  }

  await client.appendTextDeliveries('task_guid_delivery', ['https://example.com/report', '  ', 'https://example.com/dashboard'])

  assert.deepEqual(calls, [{
    path: { task_guid: 'task_guid_delivery' },
    params: { user_id_type: undefined },
    data: {
      task: {
        text_deliveries: ['https://example.com/report', 'https://example.com/dashboard'],
      },
      update_fields: ['text_deliveries'],
    },
  }])
})

test('OapiFeishuTaskClient retries retryable v2 task patch failures', async () => {
  let calls = 0
  const client = new OapiFeishuTaskClient({
    appId: 'cli_xxx',
    appSecret: 'secret',
    eventNames: ['task.task.update_user_access_v2'],
  }, {
    logger: { log: () => {}, error: () => {} },
    retryBaseDelayMs: 0,
  })
  ;(client as unknown as { client: unknown }).client = {
    task: {
      v2: {
        task: {
          patch: async () => {
            calls += 1
            if (calls === 1) {
              throw Object.assign(new Error('temporary feishu error'), { response: { status: 500 } })
            }
          },
        },
      },
    },
  }

  await client.appendTextDeliveries('task_guid_delivery_retry', ['https://example.com/report'])

  assert.equal(calls, 2)
})

test('OapiFeishuTaskClient does not retry non-retryable v2 task patch failures', async () => {
  let calls = 0
  const client = new OapiFeishuTaskClient({
    appId: 'cli_xxx',
    appSecret: 'secret',
    eventNames: ['task.task.update_user_access_v2'],
  }, {
    logger: { log: () => {}, error: () => {} },
    retryBaseDelayMs: 0,
  })
  ;(client as unknown as { client: unknown }).client = {
    task: {
      v2: {
        task: {
          patch: async () => {
            calls += 1
            throw Object.assign(new Error('bad request'), { response: { status: 400 } })
          },
        },
      },
    },
  }

  await assert.rejects(
    () => client.appendTextDeliveries('task_guid_delivery_bad_request', ['https://example.com/report']),
    /bad request/,
  )
  assert.equal(calls, 1)
})

test('OapiFeishuTaskClient uploads task delivery attachments through v2 attachment upload', async () => {
  const calls: unknown[] = []
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'aamp-feishu-delivery-'))
  const filePath = path.join(tempDir, 'report.md')
  const client = new OapiFeishuTaskClient({
    appId: 'cli_xxx',
    appSecret: 'secret',
    eventNames: ['task.task.update_user_access_v2'],
  }, {
    logger: { log: () => {}, error: () => {} },
  })
  ;(client as unknown as { client: unknown }).client = {
    task: {
      v2: {
        attachment: {
          upload: async (payload: unknown) => {
            calls.push(payload)
          },
        },
      },
    },
  }

  try {
    await writeFile(filePath, '# Report\n')
    await client.uploadTaskDelivery('task_guid_delivery', filePath)

    assert.equal(calls.length, 1)
    assert.deepEqual((calls[0] as { data: Record<string, unknown>; params: unknown }).params, { user_id_type: undefined })
    assert.equal((calls[0] as { data: Record<string, unknown> }).data.resource_type, 'task_delivery')
    assert.equal((calls[0] as { data: Record<string, unknown> }).data.resource_id, 'task_guid_delivery')
    assert.equal(typeof (calls[0] as { data: Record<string, unknown> }).data.file, 'object')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('OapiFeishuTaskClient normalizes escaped newlines before creating v2 comments', async () => {
  const calls: unknown[] = []
  const client = new OapiFeishuTaskClient({
    appId: 'cli_xxx',
    appSecret: 'secret',
    eventNames: ['task.task.update_user_access_v2'],
  }, {
    logger: { log: () => {}, error: () => {} },
  })
  ;(client as unknown as { client: unknown }).client = {
    task: {
      v2: {
        comment: {
          create: async (payload: unknown) => {
            calls.push(payload)
          },
        },
      },
    },
  }

  await client.commentTask('task_guid_comment', '成都天气。\\n\\n数据来源：国家气象中心\\nhttps://example.com')

  assert.deepEqual(calls, [{
    params: { user_id_type: undefined },
    data: {
      content: '成都天气。\n\n数据来源：国家气象中心\nhttps://example.com',
      resource_type: 'task',
      resource_id: 'task_guid_comment',
    },
  }])
})

test('OapiFeishuTaskClient does not fall back to v1 comment creation', async () => {
  let v1Called = false
  const client = new OapiFeishuTaskClient({
    appId: 'cli_xxx',
    appSecret: 'secret',
    eventNames: ['task.task.update_user_access_v2'],
  }, {
    logger: { log: () => {}, error: () => {} },
  })
  ;(client as unknown as { client: unknown }).client = {
    task: {
      taskComment: {
        create: async () => {
          v1Called = true
        },
      },
      v2: {
        comment: {
          create: async () => {
            throw new Error('v2 comment failed')
          },
        },
      },
    },
  }

  await assert.rejects(() => client.commentTask('task_guid_comment', 'comment'), /v2 comment failed/)
  assert.equal(v1Called, false)
})

test('OapiFeishuTaskClient appends task steps through raw REST endpoint', async () => {
  let sdkAppendCalled = false
  const rawRequests: Array<{
    method?: string
    url?: string
    params?: unknown
    data?: {
      task_guid?: string
      task_steps?: Array<{ quote?: string; content?: string; timestamp?: number }>
    }
    headers?: unknown
  }> = []
  const client = new OapiFeishuTaskClient({
    appId: 'cli_xxx',
    appSecret: 'secret',
    eventNames: ['task.task.update_user_access_v2'],
  }, {
    logger: { log: () => {}, error: () => {} },
  })
  ;(client as unknown as { client: unknown }).client = {
    domain: 'https://open.feishu-boe.cn',
    formatPayload: async (payload: {
      params?: unknown
      data?: {
        task_guid?: string
        task_steps?: Array<{ quote?: string; content?: string; timestamp?: number }>
      }
    }) => ({
      params: payload.params,
      data: payload.data,
      headers: { Authorization: 'Bearer token' },
    }),
    httpInstance: {
      request: async (options: {
        method?: string
        url?: string
        params?: unknown
        data?: {
          task_guid?: string
          task_steps?: Array<{ quote?: string; content?: string; timestamp?: number }>
        }
        headers?: unknown
      }) => {
        rawRequests.push(options)
        return { data: {}, status: 200 }
      },
    },
    task: {
      v2: {
        taskStep: {
          append: async () => {
            sdkAppendCalled = true
          },
        },
      },
    },
  }

  const before = Math.floor(Date.now() / 1000)
  await client.appendTaskStep('task_guid_step', '正在分析需求')
  const after = Math.floor(Date.now() / 1000)

  assert.equal(sdkAppendCalled, false)
  assert.equal(rawRequests.length, 1)
  assert.equal(rawRequests[0]?.method, 'POST')
  assert.equal(rawRequests[0]?.url, 'https://open.feishu-boe.cn/open-apis/task/v2/agent_task_step_info/append_task_steps')
  assert.deepEqual(rawRequests[0]?.params, { user_id_type: undefined })
  assert.deepEqual(rawRequests[0]?.headers, { Authorization: 'Bearer token' })
  assert.equal(rawRequests[0]?.data?.task_guid, 'task_guid_step')
  assert.equal(rawRequests[0]?.data?.task_steps?.[0]?.quote, '')
  assert.equal(rawRequests[0]?.data?.task_steps?.[0]?.content, '正在分析需求')
  assert.ok((rawRequests[0]?.data?.task_steps?.[0]?.timestamp ?? 0) >= before)
  assert.ok((rawRequests[0]?.data?.task_steps?.[0]?.timestamp ?? 0) <= after)
})

test('OapiFeishuTaskClient appends batched task steps through one raw REST request', async () => {
  const rawRequests: Array<{
    method?: string
    url?: string
    params?: unknown
    data?: {
      task_guid?: string
      task_steps?: Array<{ quote?: string; content?: string; timestamp?: number }>
    }
    headers?: unknown
  }> = []
  const client = new OapiFeishuTaskClient({
    appId: 'cli_xxx',
    appSecret: 'secret',
    eventNames: ['task.task.update_user_access_v2'],
  }, {
    logger: { log: () => {}, error: () => {} },
  })
  ;(client as unknown as { client: unknown }).client = {
    domain: 'https://open.feishu-boe.cn',
    formatPayload: async (payload: {
      params?: unknown
      data?: {
        task_guid?: string
        task_steps?: Array<{ quote?: string; content?: string; timestamp?: number }>
      }
    }) => ({
      params: payload.params,
      data: payload.data,
      headers: { Authorization: 'Bearer token' },
    }),
    httpInstance: {
      request: async (options: {
        method?: string
        url?: string
        params?: unknown
        data?: {
          task_guid?: string
          task_steps?: Array<{ quote?: string; content?: string; timestamp?: number }>
        }
        headers?: unknown
      }) => {
        rawRequests.push(options)
        return { data: {}, status: 200 }
      },
    },
  }

  const before = Math.floor(Date.now() / 1000)
  await client.appendTaskSteps('task_guid_step', ['正在分析需求', '正在更新飞书任务'])
  const after = Math.floor(Date.now() / 1000)

  assert.equal(rawRequests.length, 1)
  assert.equal(rawRequests[0]?.method, 'POST')
  assert.equal(rawRequests[0]?.url, 'https://open.feishu-boe.cn/open-apis/task/v2/agent_task_step_info/append_task_steps')
  assert.equal(rawRequests[0]?.data?.task_guid, 'task_guid_step')
  assert.deepEqual(rawRequests[0]?.data?.task_steps?.map((step) => ({
    quote: step.quote,
    content: step.content,
  })), [
    { quote: '', content: '正在分析需求' },
    { quote: '', content: '正在更新飞书任务' },
  ])
  assert.ok(rawRequests[0]?.data?.task_steps?.every((step) => (step.timestamp ?? 0) >= before && (step.timestamp ?? 0) <= after))
})

test('OapiFeishuTaskClient registers the app as a Feishu task agent through raw REST endpoint', async () => {
  const rawRequests: Array<{
    method?: string
    url?: string
    params?: unknown
    data?: unknown
    headers?: unknown
  }> = []
  const client = new OapiFeishuTaskClient({
    appId: 'cli_xxx',
    appSecret: 'secret',
    eventNames: ['task.task.update_user_access_v2'],
  }, {
    logger: { log: () => {}, error: () => {} },
  })
  ;(client as unknown as { client: unknown }).client = {
    domain: 'https://open.feishu-boe.cn',
    formatPayload: async (payload: { params?: unknown; data?: unknown }) => ({
      params: payload.params,
      data: payload.data,
      headers: { Authorization: 'Bearer token' },
    }),
    httpInstance: {
      request: async (options: {
        method?: string
        url?: string
        params?: unknown
        data?: unknown
        headers?: unknown
      }) => {
        rawRequests.push(options)
        return { data: { agent: { app_id: 'cli_xxx', app_name: 'Feishu CLI - BOE' } }, status: 200 }
      },
    },
  }

  await client.registerAgent()

  assert.equal(rawRequests.length, 1)
  assert.equal(rawRequests[0]?.method, 'POST')
  assert.equal(rawRequests[0]?.url, 'https://open.feishu-boe.cn/open-apis/task/v2/agent/register_agent')
  assert.deepEqual(rawRequests[0]?.params, {})
  assert.deepEqual(rawRequests[0]?.data, {})
  assert.deepEqual(rawRequests[0]?.headers, { Authorization: 'Bearer token' })
})

test('OapiFeishuTaskClient subscribes task events through raw REST endpoint', async () => {
  const rawRequests: Array<{
    method?: string
    url?: string
    params?: unknown
    data?: unknown
    headers?: unknown
  }> = []
  const client = new OapiFeishuTaskClient({
    appId: 'cli_xxx',
    appSecret: 'secret',
    domain: 'https://open.feishu-boe.cn',
    headers: { 'x-tt-env': 'boe_task_event' },
    userIdType: 'open_id',
    eventNames: ['task.task.update_user_access_v2'],
  }, {
    logger: { log: () => {}, error: () => {} },
  })
  ;(client as unknown as { client: unknown }).client = {
    domain: 'https://open.feishu-boe.cn',
    formatPayload: async (payload: { params?: unknown; data?: unknown }) => ({
      params: payload.params,
      data: payload.data,
      headers: { Authorization: 'Bearer token' },
    }),
    httpInstance: {
      request: async (options: {
        method?: string
        url?: string
        params?: unknown
        data?: unknown
        headers?: unknown
      }) => {
        rawRequests.push(options)
        return { data: {}, status: 200 }
      },
    },
  }

  await client.subscribeTaskEvents()

  assert.equal(rawRequests.length, 1)
  assert.equal(rawRequests[0]?.method, 'POST')
  assert.equal(rawRequests[0]?.url, 'https://open.feishu-boe.cn/open-apis/task/v2/task_v2/task_subscription')
  assert.deepEqual(rawRequests[0]?.params, { user_id_type: 'open_id' })
  assert.deepEqual(rawRequests[0]?.data, {})
  assert.deepEqual(rawRequests[0]?.headers, { Authorization: 'Bearer token' })
})

test('OapiFeishuTaskClient loads v2 task comments into task details', async () => {
  const client = new OapiFeishuTaskClient({
    appId: 'cli_xxx',
    appSecret: 'secret',
    eventNames: ['task.task.update_user_access_v2'],
  }, {
    logger: { log: () => {}, error: () => {} },
  })
  ;(client as unknown as { client: unknown }).client = {
    task: {
      v2: {
        task: {
          get: async () => ({
            data: {
              task: {
                guid: 'task_guid_comment_context',
                task_id: 't_context',
                summary: '整理上线方案',
                status: 'todo',
                agent_task_status: 3,
                url: 'https://example.feishu.cn/task/top-level',
                origin: {
                  href: {
                    url: 'https://example.feishu.cn/task/legacy-origin',
                  },
                },
                members: [
                  {
                    id: 'ou_human',
                    type: 'user',
                    role: 'assignee',
                    name: '张明德（明德）',
                  },
                ],
                repeat_rule: 'FREQ=DAILY',
                rrule: 'FREQ=LEGACY',
                reminders: [{ timestamp: 1775793266 }],
              },
            },
          }),
        },
        taskSubtask: {
          list: async () => ({ data: { items: [] } }),
        },
        comment: {
          list: async () => ({
            data: {
              items: [
                {
                  id: 'comment_1',
                  content: '请补充灰度发布。',
                  creator: {
                    id: 'ou_human',
                    type: 'user',
                    role: 'creator',
                    name: '张明德（明德）',
                  },
                  created_at: '1775793266000',
                  updated_at: '1775793266001',
                },
                {
                  id: 'comment_2',
                  content: '已收到任务派发请求，正在转交智能体处理。',
                  creator: {
                    id: 'cli_xxx',
                    type: 'app',
                    role: 'creator',
                    name: 'Task Agent',
                  },
                  created_at: '1775793266100',
                },
                {
                  id: 'comment_3',
                  content: '已完成上线方案整理。\n\n交付物：交付物已上传为父任务 task_delivery 附件。',
                  creator: {
                    id: 'cli_xxx',
                    type: 'app',
                    role: 'creator',
                    name: 'Task Agent',
                  },
                  created_at: '1775793266200',
                },
              ],
            },
          }),
        },
      },
    },
  }

  const task = await client.getTask('task_guid_comment_context')

  assert.equal(task.rrule, 'FREQ=DAILY')
  assert.equal(task.url, 'https://example.feishu.cn/task/top-level')
  assert.equal(task.agentTaskStatus, 3)
  assert.deepEqual(task.reminders, [{ timestamp: 1775793266 }])
  assert.deepEqual(task.comments, [
    {
      id: 'comment_1',
      authorType: 'user',
      authorId: 'ou_human',
      content: '请补充灰度发布。',
      createdAt: '1775793266000',
      updatedAt: '1775793266001',
    },
    {
      id: 'comment_2',
      authorType: 'app',
      authorId: 'cli_xxx',
      content: '已收到任务派发请求，正在转交智能体处理。',
      createdAt: '1775793266100',
    },
    {
      id: 'comment_3',
      authorType: 'app',
      authorId: 'cli_xxx',
      content: '已完成上线方案整理。\n\n交付物：交付物已上传为父任务 task_delivery 附件。',
      createdAt: '1775793266200',
    },
  ])
})

test('OapiFeishuTaskClient can load only the base v2 task without subtasks or comments', async () => {
  let subtaskListCalled = false
  let commentListCalled = false
  const client = new OapiFeishuTaskClient({
    appId: 'cli_xxx',
    appSecret: 'secret',
    eventNames: ['task.task.update_user_access_v2'],
  }, {
    logger: { log: () => {}, error: () => {} },
  })
  ;(client as unknown as { client: unknown }).client = {
    task: {
      v2: {
        task: {
          get: async () => ({
            data: {
              task: {
                guid: 'task_guid_base_only',
                task_id: 't_base_only',
                summary: '只加载任务本体',
                status: 'done',
              },
            },
          }),
        },
        taskSubtask: {
          list: async () => {
            subtaskListCalled = true
            return { data: { items: [] } }
          },
        },
        comment: {
          list: async () => {
            commentListCalled = true
            return { data: { items: [] } }
          },
        },
      },
    },
  }

  const task = await client.getTaskBase('task_guid_base_only')

  assert.equal(task.guid, 'task_guid_base_only')
  assert.equal(task.status, 'done')
  assert.equal(task.subtasks, undefined)
  assert.equal(task.comments, undefined)
  assert.equal(subtaskListCalled, false)
  assert.equal(commentListCalled, false)
})

test('OapiFeishuTaskClient point-loads a v2 task comment by id', async () => {
  const client = new OapiFeishuTaskClient({
    appId: 'cli_xxx',
    appSecret: 'secret',
    eventNames: ['task.task.update_user_access_v2'],
  }, {
    logger: { log: () => {}, error: () => {} },
  })
  ;(client as unknown as { client: unknown }).client = {
    task: {
      v2: {
        comment: {
          get: async (payload: { path: { comment_id: string } }) => ({
            data: {
              comment: {
                id: payload.path.comment_id,
                content: '请继续执行这个任务',
                creator: { id: 'ou_human', type: 'user' },
                created_at: '1775793266100',
              },
            },
          }),
        },
      },
    },
  }

  const comment = await client.getComment('comment_get')

  assert.deepEqual(comment, {
    id: 'comment_get',
    authorType: 'user',
    authorId: 'ou_human',
    content: '请继续执行这个任务',
    createdAt: '1775793266100',
  })
})

test('OapiFeishuTaskClient only maps exact v2 task status values', async () => {
  const client = new OapiFeishuTaskClient({
    appId: 'cli_xxx',
    appSecret: 'secret',
    eventNames: ['task.task.update_user_access_v2'],
  }, {
    logger: { log: () => {}, error: () => {} },
  })
  ;(client as unknown as { client: unknown }).client = {
    task: {
      v2: {
        task: {
          get: async () => ({
            data: {
              task: {
                guid: 'task_guid_done',
                task_id: 't_done',
                summary: '已完成事项',
                status: 'done',
              },
            },
          }),
        },
        taskSubtask: {
          list: async () => ({
            data: {
              items: [
                {
                  guid: 'task_guid_child_unknown_status',
                  summary: '子任务',
                  status: 'completed',
                },
              ],
            },
          }),
        },
        comment: {
          list: async () => ({ data: { items: [] } }),
        },
      },
    },
  }

  const task = await client.getTask('task_guid_done')

  assert.equal(task.status, 'done')
  assert.equal(task.subtasks?.[0]?.status, undefined)
})

test('OapiFeishuTaskClient maps v2 subtasks with task detail fields', async () => {
  const client = new OapiFeishuTaskClient({
    appId: 'cli_xxx',
    appSecret: 'secret',
    eventNames: ['task.task.update_user_access_v2'],
  }, {
    logger: { log: () => {}, error: () => {} },
  })
  ;(client as unknown as { client: unknown }).client = {
    task: {
      v2: {
        task: {
          get: async () => ({
            data: {
              task: {
                guid: 'task_guid_parent',
                summary: '整理上线方案',
              },
            },
          }),
        },
        taskSubtask: {
          list: async () => ({
            data: {
              items: [
                {
                  guid: 'task_guid_child',
                  task_id: 't_child',
                  summary: '执行灰度发布',
                  status: 'todo',
                  url: 'https://example.feishu.cn/task/child',
                  origin: {
                    href: {
                      url: 'https://example.feishu.cn/task/child-origin',
                    },
                  },
                  agent_task_status: 3,
                  parent_task_guid: 'task_guid_parent',
                  repeat_rule: 'FREQ=WEEKLY',
                  rrule: 'FREQ=LEGACY',
                  reminders: [{ relative_fire_minute: 30 }],
                },
              ],
            },
          }),
        },
        comment: {
          list: async () => ({ data: { items: [] } }),
        },
      },
    },
  }

  const task = await client.getTask('task_guid_parent')

  assert.deepEqual(task.subtasks, [
    {
      guid: 'task_guid_child',
      taskId: 't_child',
      summary: '执行灰度发布',
      status: 'todo',
      url: 'https://example.feishu.cn/task/child',
      agentTaskStatus: 3,
      parentGuid: 'task_guid_parent',
      rrule: 'FREQ=WEEKLY',
      reminders: [{ relative_fire_minute: 30 }],
    },
  ])
})

test('OapiFeishuTaskClient follows v2 subtask and comment pagination', async () => {
  const subtaskPageTokens: Array<string | undefined> = []
  const commentPageTokens: Array<string | undefined> = []
  const client = new OapiFeishuTaskClient({
    appId: 'cli_xxx',
    appSecret: 'secret',
    eventNames: ['task.task.update_user_access_v2'],
  }, {
    logger: { log: () => {}, error: () => {} },
  })
  ;(client as unknown as { client: unknown }).client = {
    task: {
      v2: {
        task: {
          get: async () => ({
            data: {
              task: {
                guid: 'task_guid_parent',
                summary: '整理上线方案',
              },
            },
          }),
        },
        taskSubtask: {
          list: async (payload: { params?: { page_token?: string } }) => {
            subtaskPageTokens.push(payload.params?.page_token)
            return payload.params?.page_token === 'subtask_next'
              ? {
                  data: {
                    items: [{ guid: 'task_guid_child_2', summary: '测试验收' }],
                    has_more: false,
                  },
                }
              : {
                  data: {
                    items: [{ guid: 'task_guid_child_1', summary: '需求确认' }],
                    has_more: true,
                    page_token: 'subtask_next',
                  },
                }
          },
        },
        comment: {
          list: async (payload: { params?: { page_token?: string } }) => {
            commentPageTokens.push(payload.params?.page_token)
            return payload.params?.page_token === 'comment_next'
              ? {
                  data: {
                    items: [
                      {
                        id: 'comment_2',
                        content: '第二页评论',
                        creator: { id: 'ou_human', type: 'user' },
                        created_at: '1775793266200',
                      },
                    ],
                    has_more: false,
                  },
                }
              : {
                  data: {
                    items: [
                      {
                        id: 'comment_1',
                        content: '第一页评论',
                        creator: { id: 'ou_human', type: 'user' },
                        created_at: '1775793266100',
                      },
                    ],
                    has_more: true,
                    page_token: 'comment_next',
                  },
                }
          },
        },
      },
    },
  }

  const task = await client.getTask('task_guid_parent')

  assert.deepEqual(subtaskPageTokens, [undefined, 'subtask_next'])
  assert.deepEqual(commentPageTokens, [undefined, 'comment_next'])
  assert.deepEqual(task.subtasks?.map((subtask) => subtask.guid), ['task_guid_child_1', 'task_guid_child_2'])
  assert.deepEqual(task.comments?.map((comment) => comment.id), ['comment_1', 'comment_2'])
})

test('OapiFeishuTaskClient does not fall back to v1 task reads', async () => {
  let v1Called = false
  const client = new OapiFeishuTaskClient({
    appId: 'cli_xxx',
    appSecret: 'secret',
    eventNames: ['task.task.update_user_access_v2'],
  }, {
    logger: { log: () => {}, error: () => {} },
  })
  ;(client as unknown as { client: unknown }).client = {
    task: {
      task: {
        get: async () => {
          v1Called = true
          return { data: { task: { id: 'legacy_task', summary: 'legacy' } } }
        },
      },
      v2: {
        task: {
          get: async () => {
            throw new Error('v2 task failed')
          },
        },
        taskSubtask: {
          list: async () => ({ data: { items: [] } }),
        },
        comment: {
          list: async () => ({ data: { items: [] } }),
        },
      },
    },
  }

  await assert.rejects(() => client.getTask('task_guid_read'), /v2 task failed/)
  assert.equal(v1Called, false)
})
