import type { BridgeConfig as ImBridgeConfig } from './types.js'
import type { BridgeConfig as TaskBridgeConfig } from './task/types.js'

export const TASK_PROFILE_FILENAME = 'task-profiles-v2.json'

export const TASK_PROFILE_DOMAINS = [
  'base',
  'calendar',
  'contact',
  'docs',
  'im',
  'mail',
  'mindnotes',
  'minutes',
  'note',
  'sheets',
  'slides',
  'task',
  'vc',
  'wiki',
] as const

export interface TaskProfileConfig {
  app_id: string
  profile: string
  display_name?: string
  auth_mode: 'lark-cli'
  capabilities: Array<'im' | 'task'>
  domains: string[]
  updated_at: string
}

export interface TaskProfileInput {
  app_id: string
  profile?: string
  display_name?: string
  capabilities?: Array<'im' | 'task'>
  domains?: string[]
  updated_at?: string
}

export interface TaskProfileStore {
  version: 1
  profiles: TaskProfileConfig[]
}

export function resolveTaskProfileName(appId: string): string {
  return `aamp-feishu-task-${appId.trim()}`
}

export function normalizeTaskProfile(input: TaskProfileInput): TaskProfileConfig {
  const appId = input.app_id.trim()
  if (!appId) throw new Error('Feishu App ID is required.')
  return {
    app_id: appId,
    profile: input.profile?.trim() || resolveTaskProfileName(appId),
    ...(input.display_name?.trim() ? { display_name: input.display_name.trim() } : {}),
    auth_mode: 'lark-cli',
    capabilities: [...new Set([...(input.capabilities ?? []), 'im', 'task'])] as Array<'im' | 'task'>,
    domains: input.domains?.length ? [...new Set(input.domains.map((domain) => domain.trim()).filter(Boolean))] : [...TASK_PROFILE_DOMAINS],
    updated_at: input.updated_at || new Date().toISOString(),
  }
}

export function dedupeTaskProfiles(profiles: TaskProfileInput[]): TaskProfileConfig[] {
  const byAppId = new Map<string, TaskProfileConfig>()
  for (const profile of profiles) {
    const normalized = normalizeTaskProfile(profile)
    const existing = byAppId.get(normalized.app_id)
    byAppId.set(normalized.app_id, {
      ...(existing ?? {}),
      ...normalized,
      display_name: normalized.display_name ?? existing?.display_name,
    })
  }
  return [...byAppId.values()].sort((left, right) => left.app_id.localeCompare(right.app_id))
}

export function buildTaskProfileFeishuConfig(
  profile: TaskProfileConfig,
  options: { appSecret?: string } = {},
): ImBridgeConfig['feishu'] {
  const appSecret = options.appSecret?.trim()
  return {
    appId: profile.app_id,
    authMode: appSecret ? 'app-secret' : 'lark-cli',
    ...(appSecret ? { appSecret } : {}),
    cliProfile: profile.profile,
  }
}

export function buildTaskProfileTaskFeishuConfig(
  profile: TaskProfileConfig,
  options: { appSecret?: string } = {},
): Pick<TaskBridgeConfig['feishu'], 'appId' | 'appSecret' | 'authMode' | 'cliProfile'> {
  const appSecret = options.appSecret?.trim()
  return {
    appId: profile.app_id,
    authMode: 'lark-cli',
    cliProfile: profile.profile,
    ...(appSecret ? { appSecret } : {}),
  }
}
