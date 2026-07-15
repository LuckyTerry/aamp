import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OapiFeishuTaskClient } from './feishu.js'

test('OapiFeishuTaskClient maps source message content from v2 task origin refer resources', async () => {
  const client = new OapiFeishuTaskClient({
    appId: 'cli_xxx',
    appSecret: 'secret',
    userIdType: 'open_id',
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
                guid: 'task_guid_origin',
                task_id: 't_origin',
                summary: '整理群聊需求',
                origin: {
                  refer_resources: [
                    {
                      resource_id: 'refer_resource_1',
                      type: 'message',
                      source_message: {
                        message_id: 'om_message_1',
                        content: '请基于这份文档推进：https://bytedance.larkoffice.com/docx/ABC123',
                      },
                    },
                    {
                      resource_id: 'refer_resource_2',
                      type: 'message',
                      source_message: {
                        message_id: 'om_message_2',
                        content: '第二条消息补充上线窗口。',
                      },
                      unavailable_reason: '',
                    },
                  ],
                },
              },
            },
          }),
        },
      },
    },
  }

  const task = await client.getTaskBase('task_guid_origin')

  assert.deepEqual((task as unknown as { origin?: unknown }).origin, {
    referResources: [
      {
        resourceId: 'refer_resource_1',
        type: 'message',
        sourceMessage: {
          messageId: 'om_message_1',
          content: '请基于这份文档推进：https://bytedance.larkoffice.com/docx/ABC123',
        },
      },
      {
        resourceId: 'refer_resource_2',
        type: 'message',
        sourceMessage: {
          messageId: 'om_message_2',
          content: '第二条消息补充上线窗口。',
        },
      },
    ],
  })
})

test('OapiFeishuTaskClient appends task steps with quote through raw REST endpoint', async () => {
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
    domain: 'https://open.feishu.cn',
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

  await client.appendTaskStep('task_guid_step', {
    content: '已完成工具调用：读取文件',
    quote: '输出：{"title":"Read file"}',
  })

  assert.equal(rawRequests.length, 1)
  assert.equal(rawRequests[0]?.method, 'POST')
  assert.equal(rawRequests[0]?.url, 'https://open.feishu.cn/open-apis/task/v2/agent_task_step_info/append_task_steps')
  assert.equal(rawRequests[0]?.data?.task_guid, 'task_guid_step')
  assert.equal(rawRequests[0]?.data?.task_steps?.[0]?.content, '已完成工具调用：读取文件')
  assert.equal(rawRequests[0]?.data?.task_steps?.[0]?.quote, '输出：{"title":"Read file"}')
  assert.equal(typeof rawRequests[0]?.data?.task_steps?.[0]?.timestamp, 'number')
})
