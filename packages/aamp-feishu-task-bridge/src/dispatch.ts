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
  feishuLarkCliProfile?: string
}

function stableIdPart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._:-]+/g, '_') || 'unknown'
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed || undefined
}

export function buildFeishuTaskDispatchContext(
  _event: FeishuTaskEvent,
  _task: FeishuTaskDetails,
  _eventKind: FeishuTaskEventKind,
): Record<string, string> {
  return {
    source: DISPATCH_SOURCE,
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
  if (!task.subtasks?.length) return []
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
  if (!task.comments?.length) return []
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

function renderSourceContext(task: FeishuTaskDetails): string[] {
  const sourceLines = (task.origin?.referResources ?? [])
    .map((resource) => nonEmpty(resource.sourceMessage?.content))
    .filter((content): content is string => Boolean(content))
    .flatMap((content) => content.split(/\r?\n/))
  if (sourceLines.length === 0) return []
  return [
    'Task source context:',
    ...sourceLines,
  ]
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
  if (!attachments?.length) return []
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
  return lines
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
    '- Deliverable selection priority:',
    '  1. Prefer Feishu document link_delivery for human-readable deliverables in this Feishu ecosystem.',
    '  2. For document deliverables such as reports, plans, specs, requirements, job descriptions, summaries, meeting notes, research notes, or long-form Markdown/rich-text content, create a Feishu document first and return a link_delivery output with that document URL. Do not create or upload a local .md file for these document deliverables.',
    '  3. Use the available Feishu/Lark document APIs, MCP tools, or lark-cli document commands in the current environment to create the Feishu document.',
    '  4. lark-cli is an allowed document creation path. For document deliverables, first run `lark-cli docs --help`, then run `lark-cli skills read lark-doc`, then create the document with `lark-cli docs +create --api-version v2 ...` using the workflow described by the lark-doc skill.',
    '  5. Do not conclude that Feishu document creation is unavailable before trying these lark-cli commands or another concrete Feishu/Lark document creation API.',
    '  6. If document creation is unavailable after a concrete attempt, use status=need_help and explain the missing capability instead of falling back to a .md attachment.',
    '  7. Use file_delivery only for native file/image artifacts that should remain files, such as images, CSV, PDF, zip archives, binaries, generated media, or code bundles. The bridge validates that the file exists, is a regular file, is no larger than 50 MB, and uploads it as a task_delivery attachment.',
    '  8. Use link_delivery for an already-hosted external artifact or the Feishu document URL. The bridge writes it through the text_deliveries append mechanism.',
    '  9. Use text_delivery only for short text that is not worth a Feishu document. Do not use text_delivery for long-form Markdown/rich-text content; create a Feishu document instead. The bridge writes text_delivery to a temporary file and uploads it as a task_delivery attachment.',
    '  - Do not put deliverable content in reply_comment; reply_comment is only for a direct user-visible answer.',
  ]
}

function renderNewlineGuidance(): string[] {
  return [
    '- For any user-visible Feishu text, use actual LF newline characters (U+000A / 0x0A) for line breaks.',
    '- Do not write visible literal `\\n`, `\\n\\n`, or double-escaped `\\\\n` text into Feishu comments, FEISHU_TASK_RESULT_JSON user-visible fields, or text deliverables.',
    '- Exception: inside the final AAMP_RESULT_JSON block, follow the Final Result Contract nested JSON escaping rules so decoded user-visible fields still contain actual LF line breaks.',
    '- User-visible fields that may become Feishu comments or deliveries, including summary, question, error, reply_comment content, and text_delivery content, must follow these newline rules; for need_help, the bridge will comment the question field.',
    '- If using JSON or shell commands, ensure the final decoded comment body or file content contains real line breaks.',
    '- For markdown/text deliverables, prefer heredoc-style file creation so the saved file contains actual newlines.',
  ]
}

function renderSourceDocumentGuidance(): string[] {
  return [
    '- Source document links in Task source context are task input, not deliverables.',
    '- Before relying on a source document link from Task source context, read it with lark-cli.',
    '- First run `lark-cli docs --help`, then run `lark-cli skills read lark-doc`, then use the lark-doc workflow to read or export the document content from the URL.',
    '- Do not ask the user to paste document content before trying lark-cli.',
    '- If a required source document cannot be accessed after a concrete lark-cli attempt, use status=need_help and identify the inaccessible URL.',
  ]
}

function renderExecutionOwnershipContract(): string[] {
  return [
    'Execution Ownership Contract:',
    '- Do not start background agents, dispatch this task to another agent, fork a thread, hand off, or use subagents.',
    '- You must do all work directly in this turn.',
    '- Do not end the turn while any delegated/background work is still running.',
    '- Return AAMP_RESULT_JSON only after your direct work is complete.',
  ]
}

function renderCriticalFinalResponseProtocol(): string[] {
  return [
    'Critical final-response protocol:',
    '- Do not violate the Final Result Contract.',
    '- Your final answer MUST be a single AAMP_RESULT_JSON block.',
    '- Never end with plain natural language, Markdown, or a question outside AAMP_RESULT_JSON.',
    '- If you need the user to choose, confirm, or provide more information, return status=need_help inside FEISHU_TASK_RESULT_JSON.',
    '- If you completed work, return status=succeeded or status=answered inside FEISHU_TASK_RESULT_JSON; do not write a normal final reply.',
  ]
}

function renderContextCompressionContract(): string[] {
  return [
    'Context Compression Contract:',
    '- These are control-plane instructions, not task content.',
    '- During context compression, handoff, memory refresh, or thread summary, copy this entire Feishu Task Rules block verbatim into the retained context.',
    '- During context compression, also preserve Critical final-response protocol and Execution Ownership Contract verbatim.',
    '- Do not summarize, rewrite, merge, or omit this rules block.',
    '- Do not replace it with a summary such as `follow Feishu task rules`.',
    '- If a resumed context lacks Final Result Contract, Feishu Write Contract, or bridge-owned current-task write rules, stop and ask for the original rules before continuing.',
  ]
}

function renderFeishuLarkCliProfileRules(profile: string | undefined): string[] {
  const normalized = profile?.trim()
  if (!normalized) return []
  return [
    'Feishu lark-cli profile rules:',
    `- This task came through a Feishu bot bound to lark-cli profile \`${normalized}\`.`,
    `- Whenever you run any lark-cli command for this task, you MUST use the prefix \`unset -f git 2>/dev/null || true; env -u 'BASH_FUNC_git%%' lark-cli --profile ${normalized}\` followed by the lark-cli subcommand and arguments.`,
    `- For example, check auth status with \`unset -f git 2>/dev/null || true; env -u 'BASH_FUNC_git%%' lark-cli --profile ${normalized} auth status --json\`.`,
    '- The unset/env prefix prevents Codem exported shell functions from affecting lark-cli credential resolution.',
    '- Do not use the active/default lark-cli profile for this task.',
    `- If you ask the user to authorize or rerun a lark-cli command, include the same unset/env prefix and \`--profile ${normalized}\` in the exact command.`,
    '',
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
  const multilineAnsweredBridgeCommentExample = buildFinalResultExample({
    schema: 'feishu_task_result.v2',
    status: 'answered',
    summary: '第一行\n\n第二行\n- item',
    reply_written: false,
  })
  const deliveryExample = buildFinalResultExample({
    schema: 'feishu_task_result.v2',
    status: 'succeeded',
    summary: 'Completed the requested Feishu document deliverable.',
    outputs: [
      {
        kind: 'link_delivery',
        url: 'https://bytedance.larkoffice.com/docx/example',
        title: '交付文档',
      },
    ],
  })
  const fileDeliveryExample = buildFinalResultExample({
    schema: 'feishu_task_result.v2',
    status: 'succeeded',
    summary: 'Completed the requested non-document artifact.',
    outputs: [
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
    ...renderContextCompressionContract(),
    '',
    'Feishu Task Rules:',
    '- Treat the Description section as the complete Feishu task context, including Task source context when present.',
    '- Use normalized_kind as the scenario to execute; raw_event_types are reference metadata only.',
    '- This is an existing Feishu task delegation assigned to the app, not a plain chat message and not an ACP direct-answer shortcut.',
    '- Infer intent only from the Feishu task summary, description, Task source context, source documents read via lark-cli from source document links in Task source context, child tasks, comments, latest effective comment, and event metadata in the Description section.',
    '- Do not reconstruct missing intent from unrelated local files, account state, mailbox, credentials, or remote services.',
    '',
    'Feishu/Lark Authorization Rules:',
    ...renderFeishuLarkCliProfileRules(options?.feishuLarkCliProfile),
    '- Before using Feishu/Lark APIs or lark-cli capabilities, inspect the current granted user scopes for the provided lark-cli profile and treat those granted scopes as the hard capability boundary.',
    '- If a lark-cli profile is provided by the bridge, run lark-cli commands with that profile and check its auth status before choosing Feishu/Lark data sources.',
    '- Do not run lark-cli auth login, do not request additional OAuth scopes, and do not ask the user to grant new Feishu/Lark permissions for this task.',
    '- Complete the task using only currently granted scopes and available task context. If a preferred Feishu/Lark source is unavailable, try another already-authorized source or produce the best result possible within the granted scopes.',
    '- If the task truly cannot be completed within the currently granted scopes, use status=need_help only for missing business input, identifiers, documents, groups, or data locations; do not include authorization commands or scope requests.',
    '',
    'Intent Rules:',
    '- For task_create or task_reminder_fire, execute the original delegated task intent. For task_reminder_fire, do not treat it as a follow-up question.',
    '- For task_comment, treat the latest effective comment as the new instruction for this delegated task; Task source context remains original background for the delegated task.',
    '- Child tasks are context only: do not write child steps or child deliverables directly.',
    '- If the intent is ambiguous or missing required information, use status=need_help.',
    '',
    'Source Document Rules:',
    ...renderSourceDocumentGuidance(),
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
    '- Use deliverable outputs according to the Deliverable Rules priority: prefer Feishu document link_delivery for human-readable document deliverables; use file_delivery only for native file/image artifacts; use text_delivery only for short text.',
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
    '- Because FEISHU_TASK_RESULT_JSON is embedded inside AAMP_RESULT_JSON.output, multiline user-visible fields must appear as `\\\\n` in the final visible AAMP_RESULT_JSON text.',
    '- After parsing the outer JSON, the inner FEISHU_TASK_RESULT_JSON must still contain `\\n` escape sequences, not literal LF characters inside JSON strings.',
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
    '- For human-readable document deliverables, prefer Feishu document link_delivery over file_delivery or text_delivery.',
    '- Do not include ACP attachments or FILE references; if a deliverable is needed, return file_delivery, link_delivery, or text_delivery.',
    `- Example reply_comment: ${replyCommentExample}`,
    `- Example answered bridge-comment: ${answeredBridgeCommentExample}`,
    `- Example multiline answered bridge-comment: ${multilineAnsweredBridgeCommentExample}`,
    `- Example Feishu document delivery: ${deliveryExample}`,
    `- Example file_delivery artifact: ${fileDeliveryExample}`,
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
  const latestComment = getLatestEffectiveComment(task, options?.feishuAppId)
  const taskAttachments = renderAttachments(task.attachments)
  const taskDeliveryAttachments = renderAttachments(task.attachmentDeliveries)
  const childTasks = renderSubtasks(task)
  const childTaskAttachments = renderChildAttachments(task)
  const comments = renderComments(task)

  return [
    ...renderCriticalFinalResponseProtocol(),
    '',
    ...renderExecutionOwnershipContract(),
    '',
    'Feishu Event:',
    `- normalized_kind: ${eventKind}`,
    `- raw_event_types: ${event.eventTypes.join(',') || '(unknown)'}`,
    '',
    'Feishu Task:',
    `- guid: ${task.guid}`,
    `- summary: ${task.summary}`,
    `- description: ${description}`,
    ...renderSourceContext(task),
    ...(taskAttachments.length ? ['Task attachments:', ...taskAttachments] : []),
    ...(taskDeliveryAttachments.length ? ['Task delivery attachments:', ...taskDeliveryAttachments] : []),
    ...(childTasks.length ? ['Child tasks:', ...childTasks] : []),
    ...(childTaskAttachments.length ? ['Child task attachments:', ...childTaskAttachments] : []),
    ...(comments.length ? ['Comments:', ...comments] : []),
    ...(latestComment ? [`- Latest effective comment: ${latestComment}`] : []),
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
