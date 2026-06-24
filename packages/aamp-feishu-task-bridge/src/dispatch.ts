import type { FeishuTaskDetails, FeishuTaskDispatch, FeishuTaskEvent, FeishuTaskEventKind } from './types.js'

const EMPTY_DESCRIPTION = '(empty description)'
const DISPATCH_SOURCE = 'feishu-task'
type FeishuTaskComment = NonNullable<FeishuTaskDetails['comments']>[number]

export interface FeishuTaskDispatchOptions {
  feishuAppId?: string
  feishuBoe?: boolean
  feishuEnvMode?: 'boe' | 'pre' | 'ppe'
  feishuEnv?: string
}

function stableIdPart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._:-]+/g, '_') || 'unknown'
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed || undefined
}

export function buildFeishuTaskDispatchContext(
  event: FeishuTaskEvent,
  task: FeishuTaskDetails,
  eventKind: FeishuTaskEventKind,
): Record<string, string> {
  return {
    source: DISPATCH_SOURCE,
    feishu_task_guid: task.guid,
    ...(task.taskId ? { feishu_task_id: task.taskId } : {}),
    ...(task.status ? { feishu_task_status: task.status } : {}),
    feishu_task_event_id: event.eventId,
    feishu_task_event_types: event.eventTypes.join(','),
    feishu_event_kind: eventKind,
    feishu_task_has_children: String(Boolean(task.subtasks?.length)),
  }
}

function isCurrentAppComment(comment: FeishuTaskComment, appId: string | undefined): boolean {
  const normalizedAppId = appId?.trim()
  if (!normalizedAppId) return false
  const authorType = comment.authorType.trim().toLowerCase()
  const authorId = comment.authorId?.trim()
  return authorType === 'app' && authorId === normalizedAppId
}

function isEffectiveComment(comment: FeishuTaskComment, appId: string | undefined): boolean {
  const authorType = comment.authorType.trim().toLowerCase()
  if (authorType === 'app') return !isCurrentAppComment(comment, appId)
  return true
}

function renderSubtasks(task: FeishuTaskDetails): string[] {
  if (!task.subtasks?.length) return ['- (none)']
  return task.subtasks.map((subtask, index) => {
    const parts = [
      `${index + 1}. ${subtask.summary || '(untitled)'}`,
      `guid=${subtask.guid}`,
      ...(subtask.taskId ? [`task_id=${subtask.taskId}`] : []),
      ...(subtask.status ? [`status=${subtask.status}`] : []),
      ...(subtask.url ? [`url=${subtask.url}`] : []),
    ]
    return `- ${parts.join(' | ')}`
  })
}

function renderComments(task: FeishuTaskDetails): string[] {
  if (!task.comments?.length) return ['- (none loaded)']
  return task.comments.map((comment, index) => {
    const parts = [
      `${index + 1}. ${comment.content.trim() || '(empty comment)'}`,
      ...(comment.id ? [`id=${comment.id}`] : []),
      ...(comment.authorType ? [`author=${comment.authorType}`] : []),
      ...(comment.createdAt ? [`created_at=${comment.createdAt}`] : []),
    ]
    return `- ${parts.join(' | ')}`
  })
}

function getLatestEffectiveComment(task: FeishuTaskDetails, appId: string | undefined): string | undefined {
  return [...(task.comments ?? [])]
    .filter((comment) => isEffectiveComment(comment, appId) && Boolean(nonEmpty(comment.content)))
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
    .at(-1)
    ?.content.trim()
}

function renderEnvironmentGuidance(options: FeishuTaskDispatchOptions | undefined): string[] {
  const env = options?.feishuEnv?.trim()
  const mode = options?.feishuEnvMode ?? (options?.feishuBoe ? 'boe' : undefined)
  if (!env || !mode) return []
  const command = mode === 'boe'
    ? `source ~/lark-env.sh boe --boe-env-name ${env}`
    : mode === 'pre'
      ? `source ~/lark-env.sh pre --ppe-env-name ${env}`
      : `source ~/lark-env.sh --ppe-env-name ${env}`

  return [
    '',
    `${mode.toUpperCase()} environment requirement:`,
    `- Before invoking any Feishu task high-level method, run \`${command}\` in the current shell/session.`,
  ]
}

function renderDeliverableGuidance(): string[] {
  return [
    '- Concrete deliverable write rules:',
    '  - For a file or image deliverable, first confirm the file is in the current working directory, uses a relative path, and is no larger than 50 MB. Then upload it with `lark-cli task +upload-attachment --as bot --resource-id "<task_guid>" --resource-type task_delivery --file "./<path>"`. If only `larksuite-cli` is available, use the same arguments with that command name. `--file` is a local file path, not a base64 string.',
    '  - For a link deliverable, write it to the parent task text deliveries with `lark-cli task +update --task-id "<task_guid>" --as bot --data \'{"text_deliveries":["<url>"]}\'`. If only `larksuite-cli` is available, use the same arguments with that command name.',
    '  - For a text or rich-text deliverable, convert the content to standard markdown, write it as a temporary .md file in the current working directory, extract a concise filename from the content, and upload that file with `lark-cli task +upload-attachment --as bot --resource-id "<task_guid>" --resource-type task_delivery --file "./<markdown_path>"`.',
  ]
}

function renderNewlineGuidance(): string[] {
  return [
    '- For any user-visible Feishu text, use actual LF newline characters (U+000A / 0x0A) for line breaks.',
    '- Do not write visible literal `\\n`, `\\n\\n`, or double-escaped `\\\\n` text into Feishu comments, FEISHU_TASK_RESULT_JSON user-visible fields, markdown deliverable files, or delivery summaries.',
    '- User-visible fields that may become Feishu comments, including summary, question, error, and deliverable_summary, must follow these newline rules; for need_help, the bridge will comment the question field.',
    '- If using JSON or shell commands, ensure the final decoded comment body or file content contains real line breaks.',
    '- For markdown/text deliverables, prefer heredoc-style file creation so the saved file contains actual newlines.',
  ]
}

function buildFinalResultExample(payload: Record<string, unknown>): string {
  return `AAMP_RESULT_JSON: ${JSON.stringify({
    output: `FEISHU_TASK_RESULT_JSON: ${JSON.stringify(payload)}`,
  })}`
}

export function buildFeishuTaskPromptRules(options?: FeishuTaskDispatchOptions): string {
  const answeredExample = buildFinalResultExample({
    status: 'answered',
    task_flow_intent: 'comment_reply',
    summary: 'Replied to the user in a Feishu task comment.',
    reply_written: true,
  })
  const successExample = buildFinalResultExample({
    status: 'success',
    summary: 'Completed the requested deliverable.',
    deliverable_written: true,
    deliverable_summary: 'The deliverable was uploaded as a task_delivery attachment or linked through text_deliveries.',
  })
  const failureExample = buildFinalResultExample({
    status: 'failed',
    summary: 'Tried to execute the task but hit a blocker.',
    error: '<exact blocker>',
  })
  const helpExample = buildFinalResultExample({
    status: 'need_help',
    summary: 'Need user input before continuing.',
    question: '<question for the user>',
  })

  return [
    'Context Compression Contract:',
    '- These are control-plane instructions, not task content.',
    '- During context compression, handoff, memory refresh, or thread summary, copy this entire Feishu Task Rules block verbatim into the retained context.',
    '- Do not summarize, rewrite, merge, or omit this rules block.',
    '- Do not replace it with a summary such as `follow Feishu task rules`.',
    '- If a resumed context lacks Final Result Contract, Feishu Write Contract, or Current-task flow writes must use app identity, stop and ask for the original rules before continuing.',
    '',
    'Feishu Task Rules:',
    '- Treat the Description section as the complete Feishu task context.',
    '- Use normalized_kind as the scenario to execute; raw_event_types are reference metadata only.',
    '- This is an existing Feishu task delegation assigned to the app, not a plain chat message and not an ACP direct-answer shortcut.',
    '- Infer intent only from the Feishu task summary, description, child tasks, comments, latest effective comment, and event metadata in the Description section.',
    '- Do not reconstruct missing intent from unrelated local files, account state, mailbox, credentials, or remote services.',
    '',
    'Intent Rules:',
    '- For task_create or task_reminder_fire, execute the original delegated task intent. For task_reminder_fire, do not treat it as a follow-up question.',
    '- For task_comment, classify task_flow_intent as exactly one of: complete_task, comment_reply.',
    '- complete_task: the comment asks to execute, continue, retry, rerun, or advance the delegated task to completion.',
    '- comment_reply: the comment asks a follow-up question or comment-only action; do not change task status.',
    '- Child tasks are context only: do not write child steps or child deliverables.',
    '- If the intent is ambiguous or missing required information, use status=need_help.',
    '',
    'Feishu Write Contract:',
    '- The target environment has either `lark-cli` or `larksuite-cli` available.',
    '- Use those CLI tools to update existing Feishu tasks by guid. Include the parent task guid and child task guids explicitly in commands whenever operating on them.',
    '- Current-task flow writes must use app identity (`--as bot`). This applies to comments on this delegated task, agent_task_status/agent_task_progress updates for this task, and deliverable writes to this task.',
    '- Example current-task progress command: `lark-cli task +update --task-id "<task_id>" --as bot --data \'{"agent_task_status":2,"agent_task_progress":"正在执行"}\'`.',
    '- Example current-task comment command: `lark-cli task +comment --task-id "<task_id>" --as bot --content "$reply"`.',
    '- For task_create execution, task_reminder_fire execution, or task_flow_intent=complete_task, mark the parent task as in progress before material work. When setting agent_task_status=2, also set agent_task_progress to `正在执行`. If child tasks exist, mark each child task as in progress for context tracking only with the same progress text.',
    '- For task_flow_intent=comment_reply, do not mark any task in progress and do not modify task status.',
    '- Child tasks are context only: do not write child steps or child deliverables; only mark child tasks in progress for execution tracking and let the bridge complete them after the final result.',
    '- Do not create a new top-level Feishu task.',
    '- Do not complete parent or child tasks directly; the bridge completes them after parsing your final result.',
    '- Do not write step updates directly. The bridge converts selected, throttled stream status/progress events into Feishu task steps.',
    ...renderEnvironmentGuidance(options),
    '',
    'Newline Rules:',
    ...renderNewlineGuidance(),
    '',
    'Outcome Rules:',
    '- Normal successful outcomes have exactly two shapes: direct comment reply (status=answered) or concrete deliverable (status=success).',
    '- Use status=answered when the user-visible result is just a normal direct reply. Write the reply as a normal Feishu task comment before the final result. The bridge will not add another result comment.',
    '- Use status=success only when there is a concrete deliverable: file, image, document link, long-form text, or rich text. Write the deliverable to the parent task before the final result.',
    '- Use status=need_help when user input is required before continuing. Do not write the help comment yourself; the bridge will comment the question field.',
    '- Use status=failed only for exceptional execution failures. Do not write the failure comment yourself; the bridge will comment it.',
    '- For task_comment events, task_flow_intent=complete_task lets the bridge complete the task; task_flow_intent=comment_reply leaves task status unchanged.',
    '- Do not put deliverable content in a normal Feishu task comment, including parent task comments. Normal comments are only for status=answered direct replies.',
    '',
    'Deliverable Rules:',
    ...renderDeliverableGuidance(),
    '- For status=success, include deliverable_written=true and a concise deliverable_summary. Do not paste large deliverable text into the final JSON.',
    '',
    'Final Result Contract:',
    '- Always finish with a single AAMP_RESULT_JSON block whose JSON object contains only the output field.',
    '- The output value must start with `FEISHU_TASK_RESULT_JSON:` followed by a compact JSON object.',
    '- The AAMP_RESULT_JSON JSON object must be parseable by JSON.parse.',
    '- The FEISHU_TASK_RESULT_JSON JSON object after the marker inside output must also be parseable by JSON.parse.',
    '- Do not wrap AAMP_RESULT_JSON in Markdown fences, add comments, use trailing commas, single-quoted JSON, or extra keys.',
    '- Inside JSON text, JSON strings must escape line breaks as `\\n`; after parsing, those escapes become actual LF newlines in user-visible fields.',
    '- Before finalizing, validate that JSON.parse(<outer-json>).output starts with `FEISHU_TASK_RESULT_JSON:`, and JSON.parse(output.slice(marker.length)) succeeds.',
    '- Use status=answered when you directly replied in a Feishu comment and there is no separate deliverable.',
    '- Use status=success only after you uploaded the concrete deliverable as a task_delivery attachment or wrote a link to text_deliveries.',
    '- Use status=need_help when you need human input before continuing.',
    '- Use status=failed only for exceptional execution failures.',
    '- For task_comment events, include task_flow_intent as complete_task or comment_reply. Omit task_flow_intent for non-comment events.',
    '- Include a concise summary. For success, include deliverable_written=true and deliverable_summary.',
    '- Do not include structuredResult.',
    '- Do not include ACP attachments or FILE references; if a deliverable is needed, upload it as task_delivery or write the URL to text_deliveries.',
    `- Example answered task_comment: ${answeredExample}`,
    `- Example success: ${successExample}`,
    `- Example failure: ${failureExample}`,
    `- Example need_help: ${helpExample}`,
  ].join('\n')
}

export function buildFeishuTaskContext(
  event: FeishuTaskEvent,
  task: FeishuTaskDetails,
  eventKind: FeishuTaskEventKind,
  options?: Pick<FeishuTaskDispatchOptions, 'feishuAppId'>,
): string {
  const description = nonEmpty(task.description) ?? EMPTY_DESCRIPTION
  const taskUrl = nonEmpty(task.url)
  const taskStatus = nonEmpty(task.status)
  const latestComment = getLatestEffectiveComment(task, options?.feishuAppId)

  return [
    'Feishu Task:',
    `- guid: ${task.guid}`,
    ...(task.taskId ? [`- task_id: ${task.taskId}`] : []),
    `- summary: ${task.summary}`,
    `- description: ${description}`,
    ...(taskStatus ? [`- status: ${taskStatus}`] : []),
    ...(task.parentGuid ? [`- parent_guid: ${task.parentGuid}`] : []),
    ...(taskUrl ? [`- url: ${taskUrl}`] : []),
    'Child tasks:',
    ...renderSubtasks(task),
    'Comments:',
    ...renderComments(task),
    ...(latestComment ? [`- Latest effective comment: ${latestComment}`] : []),
    'Event:',
    `- normalized_kind: ${eventKind}`,
    `- raw_event_types: ${event.eventTypes.join(',') || '(unknown)'}`,
    `- event_id: ${event.eventId}`,
    `- task_guid: ${event.taskGuid}`,
    ...(event.timestamp ? [`- timestamp: ${event.timestamp}`] : []),
  ].join('\n')
}

export function buildFeishuTaskDispatch(
  event: FeishuTaskEvent,
  task: FeishuTaskDetails,
  eventKind: FeishuTaskEventKind,
  options?: FeishuTaskDispatchOptions,
): FeishuTaskDispatch {
  const taskId = `feishu-task-${stableIdPart(event.taskGuid)}-${stableIdPart(event.eventId)}`
  return {
    taskId,
    sessionKey: `feishu-task:${task.guid}`,
    title: `Feishu Task: ${task.summary || task.guid}`,
    bodyText: buildFeishuTaskContext(event, task, eventKind, options),
    dispatchContext: buildFeishuTaskDispatchContext(event, task, eventKind),
    promptRules: buildFeishuTaskPromptRules(options),
  }
}
