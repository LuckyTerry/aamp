import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildFeishuTaskContext,
  buildFeishuTaskPromptRules,
} from './dispatch.js'
import type { FeishuTaskDetails, FeishuTaskEvent } from './types.js'

const event: FeishuTaskEvent = {
  eventId: 'evt_123',
  taskGuid: 'task_guid_123',
  eventTypes: ['task_create'],
  timestamp: '1775793266152',
}

const task: FeishuTaskDetails = {
  guid: 'task_guid_123',
  taskId: 't123',
  summary: '整理上线方案',
  description: '请拆解需求确认、技术改造、测试验收、发布回滚。',
  url: 'https://applink.feishu.cn/client/todo/detail?guid=task_guid_123',
  status: 'todo',
} as FeishuTaskDetails

test('buildFeishuTaskPromptRules explains nested multiline JSON escaping', () => {
  const rules = buildFeishuTaskPromptRules()

  assert.match(rules, /Because FEISHU_TASK_RESULT_JSON is embedded inside AAMP_RESULT_JSON\.output/i)
  assert.match(rules, /multiline user-visible fields must appear as `\\\\n` in the final visible AAMP_RESULT_JSON text/i)
  assert.match(rules, /after parsing the outer JSON, the inner FEISHU_TASK_RESULT_JSON must still contain `\\n` escape sequences/i)
  assert.match(rules, /Example multiline answered bridge-comment:/)
  assert.match(rules, /第一行\\\\n\\\\n第二行\\\\n- item/)
})

test('buildFeishuTaskContext includes source message context and only Feishu document links', () => {
  const context = buildFeishuTaskContext(event, {
    ...task,
    origin: {
      referResources: [
        {
          resourceId: 'refer_resource_1',
          type: 'message',
          sourceMessage: {
            messageId: 'om_message_1',
            content: [
              '复选消息 1：请参考文档 https://bytedance.larkoffice.com/docx/DOCX123。',
              '复选消息 2：旧版文档 https://example.feishu.cn/docs/DOCS456,',
              '复选消息 3：知识库 https://bytedance.larkoffice.com/wiki/WIKI789)',
              '不要把表格当文档 https://bytedance.larkoffice.com/sheets/SHEET123',
            ].join('\n'),
          },
        },
      ],
    },
  } as unknown as FeishuTaskDetails, 'task_create')

  assert.match(context, /Task source context:/)
  assert.match(context, /resource_id=refer_resource_1/)
  assert.match(context, /message_id=om_message_1/)
  assert.match(context, /复选消息 1：请参考文档/)
  assert.match(context, /Detected source document links:/)
  assert.match(context, /https:\/\/bytedance\.larkoffice\.com\/docx\/DOCX123/)
  assert.match(context, /https:\/\/example\.feishu\.cn\/docs\/DOCS456/)
  assert.match(context, /https:\/\/bytedance\.larkoffice\.com\/wiki\/WIKI789/)
  const detectedLinksSection = context.slice(context.indexOf('Detected source document links:'), context.indexOf('Task attachments:'))
  assert.doesNotMatch(detectedLinksSection, /https:\/\/bytedance\.larkoffice\.com\/sheets\/SHEET123/)
})

test('buildFeishuTaskPromptRules tells agents how to read source document links', () => {
  const rules = buildFeishuTaskPromptRules()

  assert.match(rules, /Source Document Rules:/)
  assert.match(rules, /Source document links detected in Task source context are task input, not deliverables/i)
  assert.match(rules, /Before relying on a detected source document link, read it with lark-cli/i)
  assert.match(rules, /lark-cli docs --help/i)
  assert.match(rules, /lark-cli skills read lark-doc/i)
  assert.match(rules, /cannot be accessed after a concrete lark-cli attempt/i)
  assert.match(rules, /Treat the Description section as the complete Feishu task context, including Task source context when present/i)
  assert.match(rules, /source documents read via lark-cli from detected source document links/i)
})
