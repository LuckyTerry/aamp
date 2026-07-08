import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildFeishuTaskDispatchContext,
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
  parentGuid: 'parent_guid_123',
} as FeishuTaskDetails

test('buildFeishuTaskPromptRules explains nested multiline JSON escaping', () => {
  const rules = buildFeishuTaskPromptRules()

  assert.match(rules, /Because FEISHU_TASK_RESULT_JSON is embedded inside AAMP_RESULT_JSON\.output/i)
  assert.match(rules, /multiline user-visible fields must appear as `\\\\n` in the final visible AAMP_RESULT_JSON text/i)
  assert.match(rules, /after parsing the outer JSON, the inner FEISHU_TASK_RESULT_JSON must still contain `\\n` escape sequences/i)
  assert.match(rules, /Inside JSON strings, escape line breaks as `\\n`/)
  assert.doesNotMatch(rules, /Example multiline reply_comment:/)
})

test('buildFeishuTaskContext renders compact event, task, and source context', () => {
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

  assert.match(context, /^Critical final-response protocol:[\s\S]*\n\nExecution Ownership Contract:[\s\S]*\n\nFeishu Event:\n- normalized_kind: task_create\n- raw_event_types: task_create\n\nFeishu Task:/)
  assert.doesNotMatch(context, /event_id:/)
  assert.doesNotMatch(context, /task_guid:/)
  assert.doesNotMatch(context, /timestamp:/)
  assert.match(context, /Task source context:/)
  assert.match(context, /复选消息 1：请参考文档/)
  assert.match(context, /https:\/\/bytedance\.larkoffice\.com\/docx\/DOCX123/)
  assert.match(context, /https:\/\/bytedance\.larkoffice\.com\/sheets\/SHEET123/)
  assert.doesNotMatch(context, /resource_id=/)
  assert.doesNotMatch(context, /message_id=/)
  assert.doesNotMatch(context, /Detected source document links:/)
  assert.doesNotMatch(context, /^\- task_id:/m)
  assert.doesNotMatch(context, /^\- status:/m)
  assert.doesNotMatch(context, /^\- parent_guid:/m)
  assert.doesNotMatch(context, /^\- url:/m)
  assert.doesNotMatch(context, /Task attachments:/)
  assert.doesNotMatch(context, /Task delivery attachments:/)
  assert.doesNotMatch(context, /Child tasks:/)
  assert.doesNotMatch(context, /Child task attachments:/)
  assert.doesNotMatch(context, /Comments:/)
  assert.doesNotMatch(context, /\(none/)
})

test('buildFeishuTaskContext puts final-response protocol before task details', () => {
  const context = buildFeishuTaskContext(event, task, 'task_create')

  assert.match(context, /^Critical final-response protocol:\n/)
  assert.ok(context.indexOf('Critical final-response protocol:') < context.indexOf('Feishu Event:'))
  assert.match(context, /\n\nExecution Ownership Contract:\n/)
  assert.ok(context.indexOf('Critical final-response protocol:') < context.indexOf('Execution Ownership Contract:'))
  assert.ok(context.indexOf('Execution Ownership Contract:') < context.indexOf('Feishu Event:'))
  assert.ok(context.indexOf('Feishu Event:') < context.indexOf('Feishu Task:'))
  assert.match(context, /raw_event_types: task_create\n\nFeishu Task:/)
  assert.match(context, /Do not start background agents, dispatch this task to another agent, fork a thread, hand off, or use subagents/)
  assert.match(context, /You must do all work directly in this turn/)
  assert.match(context, /Do not end the turn while any delegated\/background work is still running/)
  assert.match(context, /Return AAMP_RESULT_JSON only after your direct work is complete/)
  assert.match(context, /MUST be a single AAMP_RESULT_JSON block/)
  assert.match(context, /Never end with plain natural language, Markdown, or a question outside AAMP_RESULT_JSON/)
  assert.match(context, /status=need_help inside FEISHU_TASK_RESULT_JSON/)
})

test('buildFeishuTaskPromptRules tells agents how to read source document links', () => {
  const rules = buildFeishuTaskPromptRules()

  assert.match(rules, /Context Compression Contract:/)
  assert.match(rules, /Source Document Rules:/)
  assert.match(rules, /Source document links in Task source context are task input, not deliverables/i)
  assert.match(rules, /Before relying on a source document link from Task source context, read it with lark-cli/i)
  assert.match(rules, /lark-cli docs --help/i)
  assert.match(rules, /lark-cli skills read lark-doc/i)
  assert.match(rules, /cannot be accessed after a concrete lark-cli attempt/i)
  assert.match(rules, /Treat the Description section as the complete Feishu task context, including Task source context when present/i)
  assert.match(rules, /source documents read via lark-cli from source document links in Task source context/i)
  assert.match(rules, /preserve Critical final-response protocol and Execution Ownership Contract verbatim/i)
})

test('buildFeishuTaskPromptRules requires Codem-safe prefix for any lark-cli command with task profile', () => {
  const rules = buildFeishuTaskPromptRules({
    feishuLarkCliProfile: 'aamp-feishu-task-cli_aac6764b90f89cd0',
  })

  assert.ok(rules.includes(
    "Whenever you run any lark-cli command for this task, you MUST use the prefix `unset -f git 2>/dev/null || true; env -u 'BASH_FUNC_git%%' lark-cli --profile aamp-feishu-task-cli_aac6764b90f89cd0` followed by the lark-cli subcommand and arguments.",
  ))
  assert.ok(rules.includes(
    "unset -f git 2>/dev/null || true; env -u 'BASH_FUNC_git%%' lark-cli --profile aamp-feishu-task-cli_aac6764b90f89cd0 auth status --json",
  ))
  assert.match(rules, /prevents Codem exported shell functions from affecting lark-cli credential resolution/)
})

test('buildFeishuTaskPromptRules forbids agents from writing current-task comments directly', () => {
  const rules = buildFeishuTaskPromptRules()

  assert.match(rules, /Never write comments, status, steps, or deliverables directly to the current Feishu task/)
  assert.match(rules, /including through lark-cli, MCP tools, OpenAPI, browser automation, or user-authenticated Feishu sessions/)
  assert.match(rules, /Do not use lark-cli task comment\/create\/reply\/update commands for the current task/)
  assert.match(rules, /For direct user-visible replies, return status=succeeded with exactly one outputs item kind=reply_comment/)
  assert.match(rules, /status=succeeded: schema, status, summary, outputs/)
  assert.match(rules, /For status=succeeded, outputs is mandatory/)
  assert.match(rules, /Do not put reply_comment, link_delivery, file_delivery, or text_delivery at the FEISHU_TASK_RESULT_JSON top level/)
  assert.doesNotMatch(rules, /status=answered/)
  assert.doesNotMatch(rules, /reply_written/)
  assert.doesNotMatch(rules, /Example answered bridge-comment/)
  assert.doesNotMatch(rules, /If you wrote the reply as a normal Feishu task comment yourself/)
})

test('buildFeishuTaskPromptRules defines final result fields by status', () => {
  const rules = buildFeishuTaskPromptRules()

  assert.match(rules, /The AAMP_RESULT_JSON JSON object must contain exactly one key: output/)
  assert.match(rules, /Use status exactly one of: "succeeded", "need_help", "failed"/)
  assert.match(rules, /Do not use "success", "answered", "done", or other aliases/)
  assert.match(rules, /Only use these FEISHU_TASK_RESULT_JSON top-level fields:/)
  assert.match(rules, /status=succeeded: schema, status, summary, outputs/)
  assert.match(rules, /status=need_help: schema, status, summary, question/)
  assert.match(rules, /status=failed: schema, status, summary, error/)
  assert.match(rules, /Only use these output object fields:/)
  assert.match(rules, /reply_comment: kind, content/)
  assert.match(rules, /link_delivery: kind, url, title/)
  assert.match(rules, /file_delivery: kind, path/)
  assert.match(rules, /text_delivery: kind, format, content, title/)
  assert.match(rules, /format must be "markdown" or "plain_text"/)
  assert.match(rules, /For human-readable document deliverables, use outputs kind=link_delivery with the Feishu document URL/)
  assert.match(rules, /Do not put deliverable content in summary/)
  assert.match(rules, /Do not write placeholder values such as "<optional title>" in final JSON/)
  assert.doesNotMatch(rules, /Allowed shape for status=/)
  assert.doesNotMatch(rules, /<1 to 10 output objects>/)
  assert.doesNotMatch(rules, /"title":"<optional title>"/)
  assert.doesNotMatch(rules, /Forbidden FEISHU_TASK_RESULT_JSON keys/)
})

test('buildFeishuTaskPromptRules keeps final result examples focused', () => {
  const rules = buildFeishuTaskPromptRules()

  assert.match(rules, /Example labels are explanatory only; your final answer must start directly with AAMP_RESULT_JSON/)
  assert.match(rules, /Example direct reply:/)
  assert.match(rules, /Example Feishu document delivery:/)
  assert.match(rules, /Example file_delivery:/)
  assert.match(rules, /Example text_delivery:/)
  assert.match(rules, /Example failed:/)
  assert.match(rules, /Example need_help:/)
  assert.doesNotMatch(rules, /Example multiline reply_comment:/)
  assert.doesNotMatch(rules, /Example file_delivery artifact:/)
  assert.match(rules, /\\"summary\\":\\"已回复用户问题。\\"/)
  assert.match(rules, /\\"summary\\":\\"已创建飞书文档交付。\\"/)
  assert.match(rules, /\\"kind\\":\\"file_delivery\\"/)
  assert.match(rules, /\\"path\\":\\"\/absolute\/path\/to\/result\.csv\\"/)
  assert.match(rules, /\\"kind\\":\\"text_delivery\\"/)
  assert.match(rules, /\\"format\\":\\"markdown\\"/)
  assert.match(rules, /\\"title\\":\\"交付摘要\\"/)
  assert.match(rules, /# 交付摘要\\\\n\\\\n这里是短文本交付内容。/)
  assert.match(rules, /\\"error\\":\\"具体失败原因\\"/)
  assert.match(rules, /\\"question\\":\\"需要用户回答的问题\\"/)
  assert.doesNotMatch(rules, /\\"error\\":\\"</)
  assert.doesNotMatch(rules, /\\"question\\":\\"</)
})

test('buildFeishuTaskDispatchContext keeps only non-duplicated task routing source', () => {
  const context = buildFeishuTaskDispatchContext(event, task, 'task_create')

  assert.deepEqual(context, { source: 'feishu-task' })
})
