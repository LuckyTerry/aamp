import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { realpathSync, writeSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const splitList = value => Array.isArray(value) ? value : String(value || '').split(',').map(item => item.trim()).filter(Boolean)

export async function registerFeishuApp({ sdk, appName = '飞书 CLI', tenantScopes = [], userScopes = [], tenantEvents = [], userEvents = [], openUrl, log = console.log, userLog = log, sdkVersion }) {
  let detectedTenantBrand = 'feishu'
  const addons = { scopes: { tenant: splitList(tenantScopes), user: splitList(userScopes) }, events: { items: { tenant: splitList(tenantEvents), user: splitList(userEvents) } } }
  if (sdkVersion) log(`[aamp-one-click] registerApp sdk=${sdkVersion}`)
  log(`[aamp-one-click] registerApp appPreset.name=${appName}`)
  log(`[aamp-one-click] registerApp addons.counts tenantScopes=${addons.scopes.tenant.length} userScopes=${addons.scopes.user.length} tenantEvents=${addons.events.items.tenant.length} userEvents=${addons.events.items.user.length}`)
  log(`[aamp-one-click] registerApp addons.json=${JSON.stringify(addons)}`)
  const result = await sdk.registerApp({
    source: 'aamp-feishu-task-agent', appPreset: { name: appName, desc: 'AAMP Feishu bridge bot' }, addons,
    onQRCodeReady(info) {
      const url = new URL(info.url)
      log(`[aamp-one-click] registerApp url.has_addons=${url.searchParams.has('addons') ? 'yes' : 'no'}`)
      log(`[aamp-one-click] registerApp url.has_name=${url.searchParams.has('name') ? 'yes' : 'no'}`)
      userLog(`请打开授权链接完成飞书 Bot 授权（${info.expireIn} 秒内有效）：${info.url}`)
      if (openUrl) {
        const failed = () => userLog(`未能自动打开浏览器，请手动打开上述授权链接（${info.expireIn} 秒内有效）。`)
        try { Promise.resolve(openUrl(info.url, info.expireIn)).catch(failed) } catch { failed() }
      }
    },
    onStatusChange(info) {
      if (info.status === 'domain_switched') detectedTenantBrand = 'lark'
      if (info.status !== 'polling') log(`[aamp-one-click] registerApp status: ${info.status}`)
    },
  })
  const reported = result?.user_info?.tenant_brand
  const tenantBrand = reported === undefined || reported === null || reported === '' ? detectedTenantBrand : reported
  const tenantBrandIsSupported = ['feishu', 'lark'].includes(tenantBrand)
  let registeredName = ''
  try {
    if (!tenantBrandIsSupported) throw new Error(`unsupported tenant brand: ${tenantBrand}`)
    const client = new sdk.Client({ appId: result.client_id, appSecret: result.client_secret, domain: tenantBrand === 'lark' ? sdk.Domain.Lark : sdk.Domain.Feishu })
    const response = await client.application.application.get({ path: { app_id: result.client_id }, params: { lang: 'zh_cn', user_id_type: 'open_id' } })
    const app = response?.data?.app
    registeredName = app?.app_name || app?.i18n?.find?.(item => item?.i18n_key === 'zh_cn')?.name || ''
  } catch (error) { log(`failed to fetch registered app name; using preset name: ${error instanceof Error ? error.message : String(error)}`) }
  log(`[aamp-one-click] Feishu app registration completed: ${result.client_id}`)
  log(`[aamp-one-click] Feishu app name: ${registeredName || appName}`)
  return { app_id: result.client_id, app_secret: result.client_secret, app_name: registeredName || appName, tenant_brand: tenantBrand }
}

export function defaultOpenUrl(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'powershell.exe' : undefined
  if (!command) return Promise.resolve()
  const args = process.platform === 'darwin' ? [url] : ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:AAMP_AUTH_URL']
  return new Promise((resolve, reject) => execFile(command, args, {env: {...process.env, AAMP_AUTH_URL: url}}, error => error ? reject(error) : resolve()))
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(process.argv[1]))) {
  const sdk = await import('@larksuiteoapi/node-sdk')
  const sdkVersion = createRequire(import.meta.url)('@larksuiteoapi/node-sdk/package.json').version
  const result = await registerFeishuApp({
    sdk, sdkVersion,
    userLog: message => writeSync(5, `${message}\n`),
    appName: process.env.FEISHU_APP_PRESET_NAME,
    tenantScopes: process.env.FEISHU_APP_SCOPES_TENANT,
    userScopes: process.env.FEISHU_APP_SCOPES_USER,
    tenantEvents: process.env.FEISHU_APP_EVENTS_TENANT,
    userEvents: process.env.FEISHU_APP_EVENTS_USER,
    openUrl: defaultOpenUrl,
  })
  await writeFile(process.env.AAMP_REGISTER_APP_RESULT_FILE, JSON.stringify(result))
}
