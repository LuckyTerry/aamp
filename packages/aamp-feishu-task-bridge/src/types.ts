export interface BridgeMailboxIdentity {
  email: string
  mailboxToken: string
  smtpPassword: string
  baseUrl: string
}

export interface BridgeConfig {
  version: 1
  aampHost: string
  targetAgentEmail: string
  slug: string
  feishu: {
    appId: string
    appSecret: string
    domain?: string
    headers?: Record<string, string>
    userIdType?: 'open_id' | 'user_id' | 'union_id'
    eventNames: string[]
  }
  mailbox: BridgeMailboxIdentity
  behavior: {
    ackComment: boolean
    debug?: boolean
  }
}

export type BridgeTaskStatus = 'dispatching' | 'dispatched' | 'acknowledged' | 'help_needed' | 'completed' | 'failed'

export type FeishuTaskEventKind = 'task_create' | 'task_comment' | 'task_reminder_fire'

export interface BridgeTaskState {
  taskGuid: string
  aampTaskId: string
  aampMessageId?: string
  feishuEventId?: string
  feishuEventKind?: FeishuTaskEventKind
  feishuTaskId?: string
  childTaskGuids?: string[]
  streamId?: string
  lastStreamEventId?: string
  streamStepCount?: number
  streamStepTexts?: string[]
  status: BridgeTaskStatus
  ackCommentedTaskIds?: string[]
  helpCommentedTaskIds?: string[]
  resultHandledTaskIds?: string[]
  resultCommentedTaskIds?: string[]
  feishuCompletedTaskIds?: string[]
  feishuBlockedTaskIds?: string[]
  lastError?: string
  createdAt: string
  updatedAt: string
}

export interface FeishuAgentRegistrationState {
  appId: string
  domain: string
  env?: string
  registeredAt: string
}

export interface FeishuTaskSubscriptionState {
  appId: string
  domain: string
  env?: string
  userIdType: NonNullable<BridgeConfig['feishu']['userIdType']>
  subscribedAt: string
}

export interface BridgeState {
  version: 1
  lastStartedAt?: string
  lastStoppedAt?: string
  lastError?: string
  lastFeishuEventAt?: string
  lastFeishuEventId?: string
  lastFeishuEventTaskGuid?: string
  lastIgnoredFeishuEventAt?: string
  lastIgnoredFeishuEventId?: string
  lastIgnoredFeishuEventTaskGuid?: string
  lastIgnoredFeishuEventTypes?: string[]
  lastIgnoredFeishuEventReason?: string
  lastAampDispatchAt?: string
  lastAampDispatchTaskId?: string
  lastAampAckAt?: string
  lastAampAckTaskId?: string
  lastAampHelpAt?: string
  lastAampHelpTaskId?: string
  lastAampResultAt?: string
  lastAampResultTaskId?: string
  connectivity: {
    feishu: 'disconnected' | 'connecting' | 'connected'
    aamp: 'disconnected' | 'connecting' | 'connected'
  }
  agentRegistration?: FeishuAgentRegistrationState
  taskSubscription?: FeishuTaskSubscriptionState
  tasks: Record<string, BridgeTaskState>
  dedupEventIds: Record<string, string>
}

export interface FeishuTaskEvent {
  eventId: string
  taskGuid: string
  eventTypes: string[]
  timestamp?: string
  raw?: unknown
}

export type FeishuTaskStatus = 'todo' | 'done'

export interface FeishuTaskSubtask {
  guid: string
  taskId?: string
  summary: string
  description?: string
  status?: FeishuTaskStatus
  url?: string
  agentTaskStatus?: number
  parentGuid?: string
  rrule?: string
  reminders?: unknown[]
}

export interface FeishuTaskComment {
  id?: string
  authorType: 'app' | 'user'
  authorId?: string
  content: string
  createdAt?: string
  updatedAt?: string
}

export interface FeishuTaskDetails {
  guid: string
  taskId?: string
  summary: string
  description?: string
  url?: string
  status?: FeishuTaskStatus
  agentTaskStatus?: number
  parentGuid?: string
  rrule?: string
  reminders?: unknown[]
  subtasks?: FeishuTaskSubtask[]
  comments?: FeishuTaskComment[]
}

export interface FeishuTaskDispatch {
  taskId: string
  sessionKey: string
  title: string
  bodyText: string
  dispatchContext: Record<string, string>
  promptRules?: string
}

export interface FeishuTaskClient {
  registerAgent(): Promise<void>
  subscribeTaskEvents(): Promise<void>
  start(onEvent: (event: FeishuTaskEvent) => Promise<void>): Promise<void>
  stop(): Promise<void>
  getTask(taskGuid: string): Promise<FeishuTaskDetails>
  commentTask(taskGuid: string, content: string): Promise<void>
  appendTaskStep(taskGuid: string, content: string): Promise<void>
  appendTaskSteps(taskGuid: string, contents: string[]): Promise<void>
  completeTask(taskGuid: string): Promise<void>
  markTaskWaitingForHuman(taskGuid: string): Promise<void>
}
