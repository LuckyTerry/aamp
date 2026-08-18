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
  app_secret?: string
  profile?: string
  display_name?: string
  auth_mode: 'app-secret' | 'lark-cli'
  capabilities: Array<'im' | 'task'>
  domains: string[]
  updated_at: string
}

export interface TaskProfileInput {
  app_id: string
  app_secret?: string
  profile?: string
  display_name?: string
  auth_mode?: 'app-secret' | 'lark-cli'
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
  const authMode = input.auth_mode ?? 'lark-cli'
  const appSecret = input.app_secret?.trim()
  if (authMode === 'app-secret' && !appSecret) {
    throw new Error(`Feishu App Secret is required for app-secret profile ${appId}.`)
  }
  const profile = authMode === 'lark-cli'
    ? input.profile?.trim() || resolveTaskProfileName(appId)
    : undefined
  return {
    app_id: appId,
    ...(appSecret ? { app_secret: appSecret } : {}),
    ...(profile ? { profile } : {}),
    ...(input.display_name?.trim() ? { display_name: input.display_name.trim() } : {}),
    auth_mode: authMode,
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
    const merged: TaskProfileConfig = {
      ...(existing ?? {}),
      ...normalized,
      app_secret: normalized.app_secret ?? existing?.app_secret,
      display_name: normalized.display_name ?? existing?.display_name,
    }
    if (merged.auth_mode === 'app-secret') delete merged.profile
    byAppId.set(normalized.app_id, merged)
  }
  return [...byAppId.values()].sort((left, right) => left.app_id.localeCompare(right.app_id))
}

export function resolveTaskProfileSelection(
  profiles: TaskProfileInput[],
  input: TaskProfileInput,
): TaskProfileConfig {
  const appId = input.app_id.trim()
  const existing = profiles.find((profile) => profile.app_id.trim() === appId)
  return normalizeTaskProfile({
    ...existing,
    ...input,
    profile: input.profile?.trim() || existing?.profile,
    display_name: input.display_name?.trim() || existing?.display_name,
  })
}

export function buildTaskProfileFeishuConfig(
  profile: TaskProfileConfig,
  options: { appSecret?: string } = {},
): ImBridgeConfig['feishu'] {
  if (profile.auth_mode === 'app-secret') {
    return { appId: profile.app_id, appSecret: profile.app_secret, authMode: 'app-secret' }
  }
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
  if (profile.auth_mode === 'app-secret') {
    return { appId: profile.app_id, appSecret: profile.app_secret, authMode: 'app-secret' }
  }
  const appSecret = options.appSecret?.trim()
  return {
    appId: profile.app_id,
    authMode: 'lark-cli',
    cliProfile: profile.profile,
    ...(appSecret ? { appSecret } : {}),
  }
}
