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
