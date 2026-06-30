import type { FeishuTaskDetails, FeishuTaskDispatch, FeishuTaskEvent, FeishuTaskEventKind } from './types.js'

const EMPTY_DESCRIPTION = '(empty description)'
const DISPATCH_SOURCE = 'feishu-task'
type FeishuTaskComment = NonNullable<FeishuTaskDetails['comments']>[number]
type FeishuTaskAttachment = NonNullable<FeishuTaskDetails['attachments']>[number]

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

function renderAttachment(attachment: FeishuTaskAttachment, index: number, source?: string): string {
  const parts = [
    `${index + 1}. ${attachment.name?.trim() || '(unnamed attachment)'}`,
    `guid=${attachment.guid}`,
    `kind=${attachment.kind}`,
    ...(source ? [`source=${source}`] : []),
    ...(attachment.size !== undefined ? [`size=${attachment.size}`] : []),
    ...(attachment.resourceType && attachment.resourceId ? [`resource=${attachment.resourceType}:${attachment.resourceId}`] : []),
    ...(attachment.uploadedAt ? [`uploaded_at=${attachment.uploadedAt}`] : []),
  ]
  return `- ${parts.join(' | ')}`
}

function renderAttachments(attachments: FeishuTaskAttachment[] | undefined): string[] {
  if (!attachments?.length) return ['- (none)']
  return attachments.map((attachment, index) => renderAttachment(attachment, index))
}

function renderChildAttachments(task: FeishuTaskDetails): string[] {
  const lines: string[] = []
  for (const subtask of task.subtasks ?? []) {
    for (const attachment of subtask.attachments ?? []) {
      lines.push(renderAttachment(attachment, lines.length, `child:${subtask.guid}`))
    }
    for (const attachment of subtask.attachmentDeliveries ?? []) {
      lines.push(renderAttachment(attachment, lines.length, `child:${subtask.guid}`))
    }
  }
  return lines.length ? lines : ['- (none)']
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
    '- Concrete deliverable output rules:',
    '  - For document deliverables such as reports, plans, specs, requirements, job descriptions, summaries, or long-form Markdown/rich-text content, create a Feishu document first and return a link_delivery output with that document URL. Do not create or upload a local .md file for these document deliverables.',
    '  - Use the available Feishu/Lark document APIs, MCP tools, or lark-cli document commands in the current environment to create the Feishu document. If document creation is unavailable after a concrete attempt, use status=need_help and explain the missing capability instead of falling back to a .md attachment.',
    '  - For a file or image deliverable, return a file_delivery output with an absolute path. The bridge validates that the file exists, is a regular file, is no larger than 50 MB, and uploads it as a task_delivery attachment.',
    '  - For an externally hosted deliverable or Feishu document, return a link_delivery output with the URL. The bridge writes it through the text_deliveries append mechanism.',
    '  - For short text deliverables that are not worth a Feishu document, return a text_delivery output with format=markdown or format=plain_text. The bridge writes it to a temporary file and uploads it as a task_delivery attachment.',
    '  - Do not put deliverable content in reply_comment; reply_comment is only for a direct user-visible answer.',
  ]
}

function renderNewlineGuidance(): string[] {
  return [
    '- For any user-visible Feishu text, use actual LF newline characters (U+000A / 0x0A) for line breaks.',
    '- Do not write visible literal `\\n`, `\\n\\n`, or double-escaped `\\\\n` text into Feishu comments, FEISHU_TASK_RESULT_JSON user-visible fields, or text deliverables.',
    '- User-visible fields that may become Feishu comments or deliveries, including summary, question, error, reply_comment content, and text_delivery content, must follow these newline rules; for need_help, the bridge will comment the question field.',
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
  const replyCommentExample = buildFinalResultExample({
    schema: 'feishu_task_result.v2',
    status: 'succeeded',
    summary: 'Answered the latest Feishu task comment.',
    outputs: [
      {
        kind: 'reply_comment',
        content: '这里是给用户的直接回复。',
      },
    ],
  })
  const answeredBridgeCommentExample = buildFinalResultExample({
    schema: 'feishu_task_result.v2',
    status: 'answered',
    summary: 'The direct reply text that the bridge should write as a Feishu task comment.',
    reply_written: false,
  })
  const deliveryExample = buildFinalResultExample({
    schema: 'feishu_task_result.v2',
    status: 'succeeded',
    summary: 'Completed the requested deliverable.',
    outputs: [
      {
        kind: 'link_delivery',
        url: 'https://bytedance.larkoffice.com/docx/example',
        title: '交付文档',
      },
      {
        kind: 'file_delivery',
        path: '/absolute/path/to/non-document-artifact.png',
      },
    ],
  })
  const failureExample = buildFinalResultExample({
    schema: 'feishu_task_result.v2',
    status: 'failed',
    summary: 'Tried to execute the task but hit a blocker.',
    error: '<exact blocker>',
  })
  const helpExample = buildFinalResultExample({
    schema: 'feishu_task_result.v2',
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
    '- If a resumed context lacks Final Result Contract, Feishu Write Contract, or bridge-owned current-task write rules, stop and ask for the original rules before continuing.',
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
    '- For task_comment, treat the latest effective comment as the new instruction for this delegated task; continue execution or answer the comment according to its content.',
    '- Child tasks are context only: do not write child steps or child deliverables directly.',
    '- If the intent is ambiguous or missing required information, use status=need_help.',
    '',
    'Feishu Write Contract:',
    '- Do not write current-task comments, status, steps, or deliverables directly.',
    '- The bridge marks parent and child tasks in progress from stream events.',
    '- The bridge writes reply_comment outputs as Feishu task comments.',
    '- The bridge writes link_delivery, file_delivery, and text_delivery outputs to the parent task.',
    '- The bridge completes or blocks parent and child tasks after the final result.',
    '- Child tasks are context only: do not write child steps or child deliverables directly.',
    '- Do not create a new top-level Feishu task.',
    ...renderEnvironmentGuidance(options),
    '',
    'Newline Rules:',
    ...renderNewlineGuidance(),
    '',
    'Outcome Rules:',
    '- Normal successful outcomes use status=succeeded with one or more outputs.',
    '- Use status=answered when the user-visible result is just a normal direct reply. If you wrote the reply as a normal Feishu task comment yourself, set reply_written=true and the bridge will not add another result comment. If you cannot write the Feishu comment, set reply_written=false and put the exact reply text in summary; the bridge will comment summary.',
    '- Use reply_comment output only for backward compatibility when returning status=succeeded.',
    '- Use file_delivery, link_delivery, or text_delivery outputs for concrete deliverables: file, image, document link, long-form text, or rich text.',
    '- Use status=need_help when user input is required before continuing. Do not write the help comment yourself; the bridge will comment the question field.',
    '- Use status=failed only for exceptional execution failures. Do not write the failure comment yourself; the bridge will comment it.',
    '- Do not put deliverable content in reply_comment, including parent task comments. reply_comment is only for direct replies.',
    '',
    'Deliverable Rules:',
    ...renderDeliverableGuidance(),
    '- For status=succeeded with deliverables, include one output item per delivery. Do not paste large deliverable text into summary.',
    '',
    'Final Result Contract:',
    '- Always finish with a single AAMP_RESULT_JSON block whose JSON object contains only the output field.',
    '- The output value must start with `FEISHU_TASK_RESULT_JSON:` followed by a compact JSON object.',
    '- The AAMP_RESULT_JSON JSON object must be parseable by JSON.parse.',
    '- The FEISHU_TASK_RESULT_JSON JSON object after the marker inside output must also be parseable by JSON.parse.',
    '- Do not wrap AAMP_RESULT_JSON in Markdown fences, add comments, use trailing commas, single-quoted JSON, or extra keys.',
    '- Inside JSON text, JSON strings must escape line breaks as `\\n`; after parsing, those escapes become actual LF newlines in user-visible fields.',
    '- Before finalizing, validate that JSON.parse(<outer-json>).output starts with `FEISHU_TASK_RESULT_JSON:`, and JSON.parse(output.slice(marker.length)) succeeds.',
    '- Use schema=feishu_task_result.v2.',
    '- Use status=answered when there is no separate deliverable. Include reply_written=true if you already wrote a Feishu comment, or reply_written=false if the bridge should comment summary.',
    '- Use status=succeeded when the task result is ready for the bridge to write.',
    '- Use status=need_help when you need human input before continuing.',
    '- Use status=failed only for exceptional execution failures.',
    '- Include a concise summary.',
    '- For status=succeeded, include outputs as an array with 1 to 10 items.',
    '- outputs kind=reply_comment requires content.',
    '- outputs kind=link_delivery requires url.',
    '- outputs kind=file_delivery requires absolute path.',
    '- outputs kind=text_delivery requires format=markdown or format=plain_text plus content, and may include title.',
    '- For status=need_help, include question.',
    '- For status=failed, include error.',
    '- Do not include structuredResult.',
    '- Do not include ACP attachments or FILE references; if a deliverable is needed, return file_delivery, link_delivery, or text_delivery.',
    `- Example reply_comment: ${replyCommentExample}`,
    `- Example answered bridge-comment: ${answeredBridgeCommentExample}`,
    `- Example delivery: ${deliveryExample}`,
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
    'Task attachments:',
    ...renderAttachments(task.attachments),
    'Task delivery attachments:',
    ...renderAttachments(task.attachmentDeliveries),
    'Child tasks:',
    ...renderSubtasks(task),
    'Child task attachments:',
    ...renderChildAttachments(task),
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
