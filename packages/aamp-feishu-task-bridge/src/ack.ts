import type { BridgeTaskState, FeishuTaskEventKind } from './types.js'

export interface BuildAckCommentOptions {
  aampTaskId: string
  bridgeName: string
  eventKind?: FeishuTaskEventKind
  receivedAt?: Date
  debug?: boolean
}

function ackLeadText(eventKind: FeishuTaskEventKind | undefined): string {
  if (eventKind === 'task_comment') {
    return '已收到您的回复'
  }
  if (eventKind === 'task_reminder_fire') {
    return '任务提醒已到期'
  }
  return '已收到任务派发请求'
}

export function buildAckComment(options: BuildAckCommentOptions): string {
  const leadText = ackLeadText(options.eventKind)
  const visibleAckText = `${leadText}，正在转交智能体处理。`
  if (!options.debug) {
    return visibleAckText
  }

  const receivedAt = (options.receivedAt ?? new Date()).toISOString()
  return [
    visibleAckText,
    '',
    `AAMP Task ID: ${options.aampTaskId}`,
    `Bridge: ${options.bridgeName}`,
    `事件场景: ${options.eventKind ?? 'task_create'}`,
    `收到时间: ${receivedAt}`,
    '',
    '说明：这只表示本地 bridge 已收到 agent 的接收确认，不代表任务已正式开始执行，也不代表任务状态已经流转完成。',
  ].join('\n')
}

export function shouldCommentAck(state: BridgeTaskState, aampTaskId: string): boolean {
  return !(state.ackCommentedTaskIds ?? []).includes(aampTaskId)
}

export function markAckCommented(state: BridgeTaskState, aampTaskId: string): BridgeTaskState {
  const ackCommentedTaskIds = new Set(state.ackCommentedTaskIds ?? [])
  ackCommentedTaskIds.add(aampTaskId)
  return {
    ...state,
    status: 'acknowledged',
    ackCommentedTaskIds: [...ackCommentedTaskIds],
    updatedAt: new Date().toISOString(),
  }
}
