import type { FeishuTaskEventKind } from './types.js'

const TASK_CREATE_EVENT = 'task_create'
const TASK_REMINDER_FIRE_EVENT = 'task_reminder_fire'
const TASK_COMMENT_EVENTS = new Set([
  'task_comment_create',
  'task_comment_reply',
  'task_comment_update',
])

export function classifyFeishuTaskEvent(eventTypes: readonly string[]): FeishuTaskEventKind | null {
  const normalized = eventTypes.map((eventType) => eventType.trim()).filter(Boolean)
  if (normalized.some((eventType) => TASK_COMMENT_EVENTS.has(eventType))) {
    return 'task_comment'
  }
  if (normalized.includes(TASK_CREATE_EVENT)) {
    return 'task_create'
  }
  if (normalized.includes(TASK_REMINDER_FIRE_EVENT)) {
    return 'task_reminder_fire'
  }
  return null
}
