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
      authorType: 'user',
      content: '请重点补充灰度发布和回滚检查项。',
      createdAt: '1775793266000',
    },
    {
      id: 'comment_2',
      authorType: 'app',
      authorId: 'cli_xxx',
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
  assert.match(context, /Latest effective comment:/)
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

test('buildFeishuTaskContext uses user or non-current app comments as effective comments', () => {
  const context = buildFeishuTaskContext(commentEvent, {
    ...task,
    comments: [
      {
        id: 'comment_human',
        authorType: 'user',
        content: '请继续推进人工补充。',
        createdAt: '1775793266000',
      },
      {
        id: 'comment_app',
        authorType: 'app',
        authorId: 'cli_xxx',
        content: '已收到任务派发请求，正在转交智能体处理。',
        createdAt: '1775793266100',
      },
      {
        id: 'comment_other_app',
        authorType: 'app',
        authorId: 'cli_other',
        content: '外部应用补充的有效评论。',
        createdAt: '1775793266200',
      },
    ],
  }, 'task_comment', { feishuAppId: 'cli_xxx' })

  assert.match(context, /Latest effective comment: 外部应用补充的有效评论。/)
  assert.doesNotMatch(context, /Latest effective comment: 已收到任务派发请求/)
})

test('buildFeishuTaskPromptRules includes complete handling and result rules', () => {
  const rules = buildFeishuTaskPromptRules()

  assert.match(rules, /Feishu Task Rules:/)
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
  assert.match(rules, /Final Result Contract, Feishu Write Contract, or bridge-owned current-task write rules/i)
  assert.match(rules, /existing Feishu task delegation/i)
  assert.match(rules, /not an ACP direct-answer shortcut/i)
  assert.match(rules, /raw_event_types are reference metadata only/i)
  assert.doesNotMatch(rules, /task_flow_intent/i)
  assert.doesNotMatch(rules, /complete_task/i)
  assert.doesNotMatch(rules, /comment_reply/i)
  assert.doesNotMatch(rules, /lark-cli task \+update/i)
  assert.doesNotMatch(rules, /lark-cli task \+comment/i)
  assert.doesNotMatch(rules, /lark-cli task \+upload-attachment/i)
  assert.match(rules, /FEISHU_TASK_RESULT_JSON:/)
  assert.match(rules, /AAMP_RESULT_JSON:/)
  assert.match(rules, /AAMP_RESULT_JSON JSON object must be parseable by JSON\.parse/i)
  assert.match(rules, /FEISHU_TASK_RESULT_JSON JSON object after the marker inside output must also be parseable by JSON\.parse/i)
  assert.match(rules, /Do not wrap AAMP_RESULT_JSON in Markdown fences/i)
  assert.match(rules, /trailing commas, single-quoted JSON, or extra keys/i)
  assert.match(rules, /JSON strings must escape line breaks as `\\n`/i)
  assert.match(rules, /JSON\.parse\(<outer-json>\)\.output starts with `FEISHU_TASK_RESULT_JSON:`/i)
  assert.match(rules, /schema=feishu_task_result\.v2/)
  assert.match(rules, /status=succeeded/)
  assert.match(rules, /status=need_help/)
  assert.match(rules, /status=failed/)
  assert.match(rules, /outputs/i)
  assert.match(rules, /reply_comment/)
  assert.match(rules, /link_delivery/)
  assert.match(rules, /file_delivery/)
  assert.match(rules, /text_delivery/)
  assert.match(rules, /Deliverable selection priority:/)
  assert.match(rules, /Prefer Feishu document link_delivery for human-readable deliverables in this Feishu ecosystem/i)
  assert.match(rules, /document deliverables such as reports, plans, specs, requirements, job descriptions/i)
  assert.match(rules, /create a Feishu document first and return a link_delivery output/i)
  assert.match(rules, /file_delivery only for native file\/image artifacts/i)
  assert.match(rules, /text_delivery only for short text/i)
  assert.match(rules, /lark-cli docs --help/i)
  assert.match(rules, /lark-cli skills read lark-doc/i)
  assert.match(rules, /lark-cli docs \+create --api-version v2/i)
  assert.match(rules, /Do not conclude that Feishu document creation is unavailable before trying these lark-cli commands/i)
  assert.match(rules, /Do not create or upload a local \.md file/i)
  assert.match(rules, /document creation is unavailable/i)
  assert.doesNotMatch(rules, /Use file_delivery, link_delivery, or text_delivery outputs for concrete deliverables/i)
  assert.doesNotMatch(rules, /link_delivery requires url and may include title/i)
  assert.doesNotMatch(rules, /file_delivery requires absolute path and may include title/i)
  assert.doesNotMatch(rules, /Report link/)
  assert.doesNotMatch(rules, /\\"title\\":\\"deliverable\.md\\"/)
  assert.doesNotMatch(rules, /\/absolute\/path\/to\/deliverable\.md/)
  assert.match(rules, /https:\/\/bytedance\.larkoffice\.com\/docx\/example/)
  assert.match(rules, /status=answered/)
  assert.doesNotMatch(rules, /status=success/)
  assert.doesNotMatch(rules, /deliverable_written/)
  assert.match(rules, /reply_written/)
  assert.match(rules, /actual LF newline characters \(U\+000A \/ 0x0A\)/i)
  assert.match(rules, /visible literal `\\n`, `\\n\\n`, or double-escaped `\\\\n` text/i)
  assert.match(rules, /FEISHU_TASK_RESULT_JSON user-visible fields/i)
  assert.match(rules, /bridge will comment the question field/i)
  assert.match(rules, /summary, question, error, reply_comment content, and text_delivery content/i)
  assert.match(rules, /do not treat it as a follow-up question/i)
  assert.match(rules, /Child tasks are context only/i)
  assert.match(rules, /Do not write current-task comments, status, steps, or deliverables directly/i)
  assert.match(rules, /The bridge marks parent and child tasks in progress from stream events/i)
  assert.match(rules, /The bridge writes reply_comment outputs as Feishu task comments/i)
  assert.match(rules, /The bridge writes link_delivery, file_delivery, and text_delivery outputs/i)
  assert.match(rules, /The bridge completes or blocks parent and child tasks after the final result/i)
  assert.match(rules, /latest effective comment/i)
  assert.equal(countOccurrences(rules, /Feishu Write Contract:/g), 1)
  assert.equal(countOccurrences(rules, /Newline Rules:/g), 1)
  assert.equal(countOccurrences(rules, /Context Compression Contract:/g), 1)
  assert.equal(countOccurrences(rules, /Final Result Contract:/g), 1)
  assert.doesNotMatch(rules, /latest effective human comment/i)
  assert.doesNotMatch(rules, /task_guid_123/)
  assert.doesNotMatch(rules, /请重点补充灰度发布和回滚检查项/)
  assert.doesNotMatch(rules, /not a direct user question/i)
  assert.doesNotMatch(rules, /Use HELP\b/)
  assert.doesNotMatch(rules, /Write delivery only/)
  assert.doesNotMatch(rules, /"delivery"/)
  assert.doesNotMatch(rules, /NO_REPLY:/)
  assert.doesNotMatch(rules, /task\.result/i)
  assert.match(rules, /Example reply_comment:/)
  assert.match(rules, /Example Feishu document delivery:/)
  assert.match(rules, /Example file_delivery artifact:/)
  assert.doesNotMatch(rules, /Example delivery:/)
  assert.match(rules, /\\"schema\\":\\"feishu_task_result\.v2\\"/)
  const finalResultContractIndex = rules.indexOf('Final Result Contract:')
  const parseRuleIndex = rules.indexOf('AAMP_RESULT_JSON JSON object must be parseable by JSON.parse', finalResultContractIndex)
  const finalStatusRuleIndex = rules.indexOf('Use schema=feishu_task_result.v2', finalResultContractIndex)
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

  assert.match(rules, /file_delivery/i)
  assert.match(rules, /absolute path/i)
  assert.match(rules, /50 MB/i)
  assert.match(rules, /link_delivery/i)
  assert.match(rules, /text_deliveries append/i)
  assert.match(rules, /text_delivery/i)
  assert.match(rules, /format=markdown or format=plain_text/i)
  assert.match(rules, /Do not put deliverable content in reply_comment/i)
  assert.doesNotMatch(rules, /upload-attachment/)
  assert.doesNotMatch(rules, /relative path/i)
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
  assert.match(commentContext, /Latest effective comment:/)
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
    feishuAppId: 'cli_xxx',
    feishuEnvMode: 'boe',
    feishuEnv: 'boe_task_event',
  })

  assert.equal(dispatch.bodyText, buildFeishuTaskContext(event, task, 'task_create', {
    feishuAppId: 'cli_xxx',
  }))
  assert.equal(dispatch.promptRules, buildFeishuTaskPromptRules({
    feishuEnvMode: 'boe',
    feishuEnv: 'boe_task_event',
  }))
  assert.doesNotMatch(dispatch.bodyText, /source ~\/lark-env\.sh boe --boe-env-name boe_task_event/)
  assert.match(dispatch.promptRules ?? '', /source ~\/lark-env\.sh boe --boe-env-name boe_task_event/)
  assert.equal(countOccurrences(dispatch.promptRules ?? '', /source ~\/lark-env\.sh boe --boe-env-name boe_task_event/g), 1)
})
