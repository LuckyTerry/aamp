import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildFeishuTaskDispatch,
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

const commentEvent: FeishuTaskEvent = {
  eventId: 'evt_comment',
  taskGuid: 'task_guid_123',
  eventTypes: ['task_comment_create'],
  timestamp: '1775793266153',
}

const reminderFireEvent: FeishuTaskEvent = {
  eventId: 'evt_reminder_fire',
  taskGuid: 'task_guid_123',
  eventTypes: ['task_reminder_fire'],
  timestamp: '1775793266154',
}

const task: FeishuTaskDetails = {
  guid: 'task_guid_123',
  taskId: 't123',
  summary: '整理上线方案',
  description: '请拆解需求确认、技术改造、测试验收、发布回滚。',
  url: 'https://applink.feishu.cn/client/todo/detail?guid=task_guid_123',
  status: 'todo',
  parentGuid: 'parent_guid',
  subtasks: [
    {
      guid: 'child_1',
      taskId: 't124',
      summary: '需求确认',
      status: 'todo',
    },
    {
      guid: 'child_2',
      taskId: 't125',
      summary: '测试验收',
      status: 'todo',
    },
  ],
  comments: [
    {
      id: 'comment_1',
      authorType: 'human',
      content: '请重点补充灰度发布和回滚检查项。',
      createdAt: '1775793266000',
    },
    {
      id: 'comment_2',
      authorType: 'agent',
      content: '已收到任务派发请求，正在转交智能体处理。',
      createdAt: '1775793266100',
    },
  ],
} as unknown as FeishuTaskDetails

function countOccurrences(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length
}

test('buildFeishuTaskDispatchContext records task routing without skill-runtime dependency', () => {
  const context = buildFeishuTaskDispatchContext(event, task, 'task_create')

  assert.deepEqual(context, {
    source: 'feishu-task',
    feishu_task_guid: 'task_guid_123',
    feishu_task_id: 't123',
    feishu_task_status: 'todo',
    feishu_task_event_id: 'evt_123',
    feishu_task_event_types: 'task_create',
    feishu_event_kind: 'task_create',
    feishu_task_has_children: 'true',
  })
  assert.equal(context.required_skill, undefined)
  assert.equal(context.skill_source, undefined)
  assert.equal(context.skill_intent_type, undefined)
})

test('buildFeishuTaskContext includes only task, child, comment, and event facts', () => {
  const context = buildFeishuTaskContext(event, task, 'task_create')

  assert.match(context, /^Feishu Task:/)
  assert.match(context, /task_guid_123/)
  assert.match(context, /child_1/)
  assert.match(context, /需求确认/)
  assert.match(context, /请重点补充灰度发布和回滚检查项/)
  assert.match(context, /Latest effective human comment:/)
  assert.match(context, /normalized_kind: task_create/)
  assert.match(context, /raw_event_types: task_create/)
  assert.doesNotMatch(context, /Intent Rules/i)
  assert.doesNotMatch(context, /Feishu Write Contract/i)
  assert.doesNotMatch(context, /Outcome Rules/i)
  assert.doesNotMatch(context, /Deliverable Rules/i)
  assert.doesNotMatch(context, /Final Result Contract/i)
  assert.doesNotMatch(context, /existing Feishu task delegation/i)
  assert.doesNotMatch(context, /not an ACP direct-answer shortcut/i)
  assert.doesNotMatch(context, /lark-cli/i)
  assert.doesNotMatch(context, /FEISHU_TASK_RESULT_JSON:/)
  assert.doesNotMatch(context, /AAMP_RESULT_JSON:/)
  assert.doesNotMatch(context, /status=answered/)
  assert.doesNotMatch(context, /deliverable_written/)
  assert.doesNotMatch(context, /required_skill/i)
  assert.doesNotMatch(context, /aily-feishu-task-agent/i)
  assert.doesNotMatch(context, /runtime next_action_specs/i)
})

test('buildFeishuTaskPromptRules includes complete handling and result rules', () => {
  const rules = buildFeishuTaskPromptRules()

  assert.match(rules, /Feishu Task Rules:/)
  assert.match(rules, /Intent Rules:/)
  assert.match(rules, /Feishu Write Contract:/)
  assert.match(rules, /Newline Rules:/)
  assert.match(rules, /Outcome Rules:/)
  assert.match(rules, /Deliverable Rules:/)
  assert.match(rules, /Final Result Contract:/)
  assert.match(rules, /Context Compression Contract:/)
  assert.match(rules, /^Context Compression Contract:/)
  assert.match(rules, /before continuing\.\n\nFeishu Task Rules:\n- Treat the Description section/)
  assert.doesNotMatch(rules, /Context Retention Contract:/)
  assert.doesNotMatch(rules, /Feishu Task Rules:\n\nContext Compression Contract:/)
  assert.doesNotMatch(rules, /Feishu Task Rules:\nContext Compression Contract:/)
  assert.match(rules, /control-plane instructions, not task content/i)
  assert.match(rules, /context compression, handoff, memory refresh, or thread summary/)
  assert.doesNotMatch(rules, /Context Compression, handoff, memory refresh, or thread summary/)
  assert.match(rules, /copy this entire Feishu Task Rules block verbatim/i)
  assert.match(rules, /follow Feishu task rules/i)
  assert.match(rules, /Final Result Contract, Feishu Write Contract, or Current-task flow writes must use app identity/i)
  assert.match(rules, /existing Feishu task delegation/i)
  assert.match(rules, /not an ACP direct-answer shortcut/i)
  assert.match(rules, /raw_event_types are reference metadata only/i)
  assert.match(rules, /task_flow_intent/i)
  assert.match(rules, /complete_task/i)
  assert.match(rules, /comment_reply/i)
  assert.match(rules, /lark-cli/i)
  assert.match(rules, /larksuite-cli/i)
  assert.match(rules, /FEISHU_TASK_RESULT_JSON:/)
  assert.match(rules, /AAMP_RESULT_JSON:/)
  assert.match(rules, /AAMP_RESULT_JSON JSON object must be parseable by JSON\.parse/i)
  assert.match(rules, /FEISHU_TASK_RESULT_JSON JSON object after the marker inside output must also be parseable by JSON\.parse/i)
  assert.match(rules, /Do not wrap AAMP_RESULT_JSON in Markdown fences/i)
  assert.match(rules, /trailing commas, single-quoted JSON, or extra keys/i)
  assert.match(rules, /JSON strings must escape line breaks as `\\n`/i)
  assert.match(rules, /JSON\.parse\(<outer-json>\)\.output starts with `FEISHU_TASK_RESULT_JSON:`/i)
  assert.match(rules, /status=answered/)
  assert.match(rules, /status=success/)
  assert.match(rules, /status=need_help/)
  assert.match(rules, /Normal successful outcomes have exactly two shapes/i)
  assert.match(rules, /direct comment reply \(status=answered\) or concrete deliverable \(status=success\)/i)
  assert.match(rules, /deliverable_written/)
  assert.match(rules, /reply_written/)
  assert.match(rules, /actual LF newline characters \(U\+000A \/ 0x0A\)/i)
  assert.match(rules, /visible literal `\\n`, `\\n\\n`, or double-escaped `\\\\n` text/i)
  assert.match(rules, /Feishu comments, FEISHU_TASK_RESULT_JSON user-visible fields, markdown deliverable files, or delivery summaries/i)
  assert.match(rules, /prefer heredoc-style file creation/i)
  assert.match(rules, /bridge will comment the question field/i)
  assert.match(rules, /summary, question, error, and deliverable_summary/i)
  assert.match(rules, /do not treat it as a follow-up question/i)
  assert.match(rules, /Child tasks are context only/i)
  assert.match(rules, /Use those CLI tools to update existing Feishu tasks by guid/i)
  assert.match(rules, /Include the parent task guid and child task guids explicitly in commands/i)
  assert.match(rules, /mark the parent task as in progress before material work/i)
  assert.match(rules, /mark each child task as in progress for context tracking only/i)
  assert.match(rules, /agent_task_progress/i)
  assert.match(rules, /正在执行/)
  assert.match(rules, /Current-task flow writes must use app identity/i)
  assert.ok(rules.includes('lark-cli task +update --task-id "<task_id>" --as bot --data \'{"agent_task_status":2,"agent_task_progress":"正在执行"}\''))
  assert.ok(rules.includes('lark-cli task +comment --task-id "<task_id>" --as bot --content "$reply"'))
  assert.match(rules, /task_flow_intent=comment_reply, do not mark any task in progress/i)
  assert.match(rules, /only mark child tasks in progress for execution tracking/i)
  assert.equal(countOccurrences(rules, /Feishu Write Contract:/g), 1)
  assert.equal(countOccurrences(rules, /Newline Rules:/g), 1)
  assert.equal(countOccurrences(rules, /Context Compression Contract:/g), 1)
  assert.equal(countOccurrences(rules, /Final Result Contract:/g), 1)
  assert.doesNotMatch(rules, /task_guid_123/)
  assert.doesNotMatch(rules, /请重点补充灰度发布和回滚检查项/)
  assert.doesNotMatch(rules, /not a direct user question/i)
  assert.doesNotMatch(rules, /Use HELP\b/)
  assert.doesNotMatch(rules, /Write delivery only/)
  assert.doesNotMatch(rules, /"delivery"/)
  assert.doesNotMatch(rules, /NO_REPLY:/)
  assert.doesNotMatch(rules, /task\.result/i)
  assert.match(rules, /Example answered task_comment:/)
  assert.match(rules, /\\"task_flow_intent\\":\\"comment_reply\\"/)
  const finalResultContractIndex = rules.indexOf('Final Result Contract:')
  const parseRuleIndex = rules.indexOf('AAMP_RESULT_JSON JSON object must be parseable by JSON.parse', finalResultContractIndex)
  const finalStatusRuleIndex = rules.indexOf('Use status=answered', finalResultContractIndex)
  assert.ok(parseRuleIndex > finalResultContractIndex)
  assert.ok(parseRuleIndex < finalStatusRuleIndex)
  const feishuRulesIndex = rules.indexOf('Feishu Task Rules:')
  const retentionContractIndex = rules.indexOf('Context Compression Contract:')
  const intentRulesIndex = rules.indexOf('Intent Rules:')
  assert.ok(retentionContractIndex < feishuRulesIndex)
  assert.ok(feishuRulesIndex < intentRulesIndex)
  assert.ok(retentionContractIndex < intentRulesIndex)
})

test('buildFeishuTaskPromptRules requires concrete deliverables to be written as task deliveries', () => {
  const rules = buildFeishuTaskPromptRules()

  assert.match(rules, /file or image deliverable/i)
  assert.match(rules, /current working directory/i)
  assert.match(rules, /relative path/i)
  assert.match(rules, /50 MB/i)
  assert.match(rules, /lark-cli task \+upload-attachment --as bot --resource-id "<task_guid>" --resource-type task_delivery --file "\.\/<path>"/)
  assert.match(rules, /`?--file`? is a local file path, not a base64 string/i)
  assert.match(rules, /link deliverable/i)
  assert.match(rules, /lark-cli task \+update --task-id "<task_guid>" --as bot --data '\{"text_deliveries":\["<url>"\]\}'/)
  assert.match(rules, /text or rich-text deliverable/i)
  assert.match(rules, /standard markdown/i)
  assert.match(rules, /temporary \.md file/i)
  assert.match(rules, /extract a concise filename/i)
  assert.match(rules, /Do not put deliverable content in a normal Feishu task comment, including parent task comments/i)
})

test('buildFeishuTaskPromptRules adds BOE shell setup guidance for BOE dispatches', () => {
  const normalRules = buildFeishuTaskPromptRules()
  const boeRules = buildFeishuTaskPromptRules({
    feishuEnvMode: 'boe',
    feishuEnv: 'boe_task_event',
  })

  assert.doesNotMatch(normalRules, /source ~\/lark-env\.sh boe --boe-env-name boe_task_event/)
  assert.match(boeRules, /Before invoking any Feishu task high-level method/i)
  assert.match(boeRules, /source ~\/lark-env\.sh boe --boe-env-name boe_task_event/)
})

test('buildFeishuTaskPromptRules adds PRE and PPE shell setup guidance', () => {
  const preRules = buildFeishuTaskPromptRules({
    feishuEnvMode: 'pre',
    feishuEnv: 'ppe_task_event',
  })
  const ppeRules = buildFeishuTaskPromptRules({
    feishuEnvMode: 'ppe',
    feishuEnv: 'ppe_task_event',
  })

  assert.match(preRules, /source ~\/lark-env\.sh pre --ppe-env-name ppe_task_event/)
  assert.match(ppeRules, /source ~\/lark-env\.sh --ppe-env-name ppe_task_event/)
})

test('buildFeishuTaskContext records comment and reminder event facts without adding rules', () => {
  const commentContext = buildFeishuTaskContext(commentEvent, task, 'task_comment')
  const reminderContext = buildFeishuTaskContext(reminderFireEvent, task, 'task_reminder_fire')

  assert.match(commentContext, /normalized_kind: task_comment/)
  assert.match(commentContext, /Latest effective human comment:/)
  assert.match(commentContext, /请重点补充灰度发布和回滚检查项/)
  assert.match(reminderContext, /normalized_kind: task_reminder_fire/)
  assert.match(reminderContext, /raw_event_types: task_reminder_fire/)
  assert.doesNotMatch(commentContext, /do not preset/i)
  assert.doesNotMatch(commentContext, /do not mark/i)
  assert.doesNotMatch(reminderContext, /scheduled fire time/i)
  assert.doesNotMatch(reminderContext, /do not classify task_flow_intent/i)
})

test('buildFeishuTaskPromptRules override ACP generic task rules', () => {
  const rules = buildFeishuTaskPromptRules()

  assert.match(rules, /Feishu Task Rules:/)
  assert.match(rules, /Intent Rules:/)
  assert.match(rules, /Final Result Contract:/)
  assert.match(rules, /existing Feishu task delegation/)
  assert.match(rules, /not a plain chat message/)
  assert.match(rules, /raw_event_types are reference metadata only/)
  assert.match(rules, /Outcome Rules/)
  assert.match(rules, /FEISHU_TASK_RESULT_JSON:/)
  assert.match(rules, /Do not include structuredResult/)
  assert.doesNotMatch(rules, /For simple chat messages/)
  assert.doesNotMatch(rules, /Structured result handoff/)
  assert.doesNotMatch(rules, /FILE:\/absolute\/path\/to\/file/)
  assert.doesNotMatch(rules, /Attachment entries should include/)
})

test('buildFeishuTaskDispatchContext maps comment events without skill intent fields', () => {
  const context = buildFeishuTaskDispatchContext(commentEvent, task, 'task_comment')

  assert.equal(context.feishu_event_kind, 'task_comment')
  assert.equal(context.feishu_task_event_types, 'task_comment_create')
  assert.equal(context.skill_intent_type, undefined)
  assert.doesNotMatch(JSON.stringify(context), /aily/i)
})

test('buildFeishuTaskDispatchContext maps reminder fire events', () => {
  const context = buildFeishuTaskDispatchContext(reminderFireEvent, task, 'task_reminder_fire')

  assert.equal(context.feishu_event_kind, 'task_reminder_fire')
  assert.equal(context.feishu_task_event_types, 'task_reminder_fire')
  assert.equal(context.feishu_task_guid, 'task_guid_123')
})

test('buildFeishuTaskDispatch returns stable title, session key, context, and prompt', () => {
  const dispatch = buildFeishuTaskDispatch(event, task, 'task_create')

  assert.equal(dispatch.taskId, 'feishu-task-task_guid_123-evt_123')
  assert.equal(dispatch.sessionKey, 'feishu-task:task_guid_123')
  assert.equal(dispatch.title, 'Feishu Task: 整理上线方案')
  assert.equal(dispatch.bodyText, buildFeishuTaskContext(event, task, 'task_create'))
  assert.equal(dispatch.dispatchContext.feishu_task_guid, 'task_guid_123')
  assert.equal(dispatch.dispatchContext.required_skill, undefined)
  assert.equal(dispatch.dispatchContext.skill_intent_type, undefined)
  assert.equal(dispatch.dispatchContext.skill_trigger_type, undefined)
  assert.equal(dispatch.promptRules, buildFeishuTaskPromptRules())
  assert.doesNotMatch(dispatch.bodyText, /aily/i)
})

test('buildFeishuTaskDispatch keeps BOE setup in prompt rules only', () => {
  const dispatch = buildFeishuTaskDispatch(event, task, 'task_create', {
    feishuEnvMode: 'boe',
    feishuEnv: 'boe_task_event',
  })

  assert.equal(dispatch.bodyText, buildFeishuTaskContext(event, task, 'task_create'))
  assert.equal(dispatch.promptRules, buildFeishuTaskPromptRules({
    feishuEnvMode: 'boe',
    feishuEnv: 'boe_task_event',
  }))
  assert.doesNotMatch(dispatch.bodyText, /source ~\/lark-env\.sh boe --boe-env-name boe_task_event/)
  assert.match(dispatch.promptRules ?? '', /source ~\/lark-env\.sh boe --boe-env-name boe_task_event/)
  assert.equal(countOccurrences(dispatch.promptRules ?? '', /source ~\/lark-env\.sh boe --boe-env-name boe_task_event/g), 1)
})
