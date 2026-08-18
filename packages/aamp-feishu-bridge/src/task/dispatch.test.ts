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
  assert.match(rules, /Example multiline answered bridge-comment:/)
  assert.match(rules, /第一行\\\\n\\\\n第二行\\\\n- item/)
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
    feishuLarkCliBin: '/Users/bytedance/.local/bin/lark-cli',
  })

  assert.ok(rules.includes(
    "Whenever you run any lark-cli command for this task, you MUST use the prefix `unset -f git 2>/dev/null || true; env -u 'BASH_FUNC_git%%' '/Users/bytedance/.local/bin/lark-cli' --profile aamp-feishu-task-cli_aac6764b90f89cd0` followed by the lark-cli subcommand and arguments.",
  ))
  assert.ok(rules.includes(
    "unset -f git 2>/dev/null || true; env -u 'BASH_FUNC_git%%' '/Users/bytedance/.local/bin/lark-cli' --profile aamp-feishu-task-cli_aac6764b90f89cd0 auth status --json",
  ))
  assert.match(rules, /prevents Codem exported shell functions from affecting lark-cli credential resolution/)
})

test('buildFeishuTaskPromptRules renders the selected lark-cli absolute path when provided', () => {
  const rules = buildFeishuTaskPromptRules({
    feishuLarkCliProfile: 'aamp-feishu-task-cli_aac6764b90f89cd0',
    feishuLarkCliBin: '/Applications/Test Tools/lark-cli',
  })

  assert.doesNotMatch(rules, /AAMP_LARK_CLI_BIN/)
  assert.ok(rules.includes(
    "unset -f git 2>/dev/null || true; env -u 'BASH_FUNC_git%%' '/Applications/Test Tools/lark-cli' --profile aamp-feishu-task-cli_aac6764b90f89cd0 auth status --json",
  ))
})
test('buildFeishuTaskDispatchContext keeps only non-duplicated task routing source', () => {
  const context = buildFeishuTaskDispatchContext(event, task, 'task_create')

  assert.deepEqual(context, { source: 'feishu-task' })
})

test('buildFeishuTaskDispatchContext includes the verified Feishu app owner open id', () => {
  const context = buildFeishuTaskDispatchContext(event, task, 'task_create', {
    feishuAppOwnerId: ' ou_owner ',
  })

  assert.deepEqual(context, {
    source: 'feishu-task',
    sender_open_id: 'ou_owner',
  })
})

test('buildFeishuTaskDispatchContext excludes local profile details from dispatch context', () => {
  const context = buildFeishuTaskDispatchContext(event, task, 'task_create', {
    feishuLarkCliProfile: 'aamp-feishu-task-cli_aac6764b90f89cd0',
    feishuLarkCliBin: '/Users/bytedance/.local/bin/lark-cli',
  })

  assert.deepEqual(context, { source: 'feishu-task' })
})

test('buildFeishuTaskDispatch mirrors session key into dispatch context', () => {
  const dispatch = buildFeishuTaskDispatch(event, task, 'task_create')

  assert.equal(dispatch.sessionKey, 'feishu-task:task_guid_123')
  assert.equal(dispatch.dispatchContext.source, 'feishu-task')
  assert.equal(dispatch.dispatchContext.aamp_session_key, dispatch.sessionKey)
})

test('buildFeishuTaskDispatch uses invariant rules for local and remote execution without rewriting task text', () => {
  const taskWithLocalWords = {
    ...task,
    description: 'The user mentioned lark-cli and /Users/example',
  } as FeishuTaskDetails
  const local = buildFeishuTaskDispatch(event, taskWithLocalWords, 'task_create', {
    agentExecutionLocation: 'local',
    feishuLarkCliProfile: 'aamp-feishu-task-cli_test',
  })
  const remote = buildFeishuTaskDispatch(event, taskWithLocalWords, 'task_create', {
    agentExecutionLocation: 'remote',
    feishuLarkCliProfile: 'aamp-feishu-task-cli_test',
  })

  for (const rules of [local.promptRules ?? '', remote.promptRules ?? '']) {
    assert.match(rules, /FEISHU_TASK_RESULT_JSON/)
    assert.match(rules, /AAMP_RESULT_JSON/)
    assert.match(rules, /only the Feishu Bridge writes the current Task/i)
    assert.match(rules, /all work for this turn has settled/i)
  }
  assert.match(remote.bodyText, /The user mentioned lark-cli and \/Users\/example/)
  assert.doesNotMatch(remote.bodyText, /subagents/i)
  assert.match(remote.promptRules ?? '', /remote sandbox/i)
  assert.match(remote.promptRules ?? '', /own remote-native Feishu\/Lark capabilities/i)
  assert.doesNotMatch(remote.promptRules ?? '', /lark-cli/i)
  assert.doesNotMatch(remote.promptRules ?? '', /--profile/i)
  assert.doesNotMatch(remote.promptRules ?? '', /source ~\/lark-env\.sh/i)
  assert.doesNotMatch(remote.promptRules ?? '', /current working directory/i)
  assert.doesNotMatch(remote.promptRules ?? '', /file_delivery artifact/i)
  assert.doesNotMatch(remote.promptRules ?? '', /do not delegate work to subagents/i)
  assert.doesNotMatch(remote.promptRules ?? '', /copy.*verbatim/i)
  assert.match(remote.promptRules ?? '', /internal remote tool orchestration is allowed/i)
})

test('buildFeishuTaskPromptRules renders the complete remote-safe result schema', () => {
  const rules = buildFeishuTaskPromptRules({ agentExecutionLocation: 'remote' })

  assert.match(rules, /status=answered[\s\S]*nonempty summary[\s\S]*reply_written=false/i)
  assert.match(rules, /status=succeeded[\s\S]*nonempty summary[\s\S]*outputs/i)
  assert.match(rules, /reply_comment[\s\S]*nonempty content/i)
  assert.match(rules, /text_delivery[\s\S]*format=markdown or plain_text[\s\S]*nonempty content/i)
  assert.match(rules, /link_delivery[\s\S]*HTTP\(S\)[\s\S]*no username or password/i)
  assert.match(rules, /status=need_help[\s\S]*nonempty summary[\s\S]*nonempty question/i)
  assert.match(rules, /status=failed[\s\S]*nonempty summary[\s\S]*nonempty error/i)
  assert.match(rules, /nested[\s\S]*JSON[\s\S]*\\\\n/i)
  assert.match(rules, /Example remote answered:[^\n]*AAMP_RESULT_JSON:[^\n]*\\"status\\":\\"answered\\"/i)
  assert.match(rules, /Example remote succeeded:[^\n]*\\"kind\\":\\"text_delivery\\"[^\n]*\\"kind\\":\\"link_delivery\\"/i)
  assert.match(rules, /Example remote need_help:[^\n]*\\"status\\":\\"need_help\\"/i)
  assert.match(rules, /Example remote failed:[^\n]*\\"status\\":\\"failed\\"/i)
  assert.match(rules, /Only the Feishu Bridge writes the current Task/i)
  assert.match(rules, /all work for this turn has settled/i)
})
