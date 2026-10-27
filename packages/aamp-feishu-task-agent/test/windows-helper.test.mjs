import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fork } from 'node:child_process'
import {
  runWindowsHelper,
  versionAtLeast,
} from '../bootstrap/windows-helper.mjs'

function fakeCommand() {
  return process.execPath
}

test('register binding preserves SDK request parity and exact Lark profile contract', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-register-'))
  const sdk = path.join(root, 'sdk.mjs')
  const calls = path.join(root, 'sdk-call.json')
  const cli = path.join(root, 'lark-cli.mjs')
  writeFileSync(
    sdk,
    `import {writeFileSync} from 'node:fs'; export const Domain={Feishu:'feishu',Lark:'lark'}; export async function registerApp(options){writeFileSync(${JSON.stringify(calls)},JSON.stringify({source:options.source,appPreset:options.appPreset,addons:options.addons}));options.onStatusChange({status:'domain_switched'});return {client_id:'cli_registered',client_secret:'registration-secret',user_info:{tenant_brand:'lark'}}};export class Client{constructor(){this.application={application:{get:async()=>({data:{app:{app_name:'Lark Bot'}}})}}}}`,
  )
  writeFileSync(
    cli,
    `let i='';process.stdin.on('data',c=>i+=c);process.stdin.on('end',()=>{const a=process.argv.slice(2);if(a[0]==='--version')console.log('lark-cli version 1.0.64');else if(a.join(' ')==='profile list')console.log('[]');else if(a.some(v=>v.includes('user_info')))console.log('{"data":{"tenant_key":"tenant-lark"}}')})`,
  )
  const result = await runWindowsHelper(
    '__register-binding',
    {},
    {
      AAMP_REGISTER_APP_SDK_MODULE: sdk,
      AAMP_LARK_CLI_BIN: cli,
      AAMP_FEISHU_AUTH_STATE_DIR: path.join(root, 'auth'),
      AAMP_LARK_CLI_CONFIG_DIR: path.join(root, 'config'),
      FEISHU_USER_AUTH_MODE: 'disabled',
      AAMP_TASK_TEST_NO_BROWSER: 'true',
      SDK_CALLS: calls,
    },
  )
  assert.deepEqual(result, {
    app_id: 'cli_registered',
    app_secret: 'registration-secret',
    display_name: 'Lark Bot',
    tenant_brand: 'lark',
    tenant_key: 'tenant-lark',
    lark_cli_profile: 'aamp-feishu-task-cli_registered-lark',
    auth_mode: 'lark-cli',
  })
  const request = JSON.parse(readFileSync(calls, 'utf8'))
  assert.equal(request.source, 'aamp-feishu-task-agent')
  assert.equal(request.appPreset.desc, 'AAMP Feishu bridge bot')
  assert.equal(
    request.addons.scopes.tenant.includes('im:message:send_as_bot'),
    true,
  )
  assert.deepEqual(request.addons.events.items.tenant, [
    'task.task.update_user_access_v2',
  ])

  await runWindowsHelper('__register-binding', {}, {
    AAMP_REGISTER_APP_SDK_MODULE: sdk, AAMP_LARK_CLI_BIN: cli,
    AAMP_FEISHU_AUTH_STATE_DIR: path.join(root,'override-auth'), AAMP_LARK_CLI_CONFIG_DIR: path.join(root,'override-config'),
    FEISHU_USER_AUTH_MODE:'disabled', AAMP_TASK_TEST_NO_BROWSER:'true',
    FEISHU_APP_SCOPES_TENANT:'tenant.custom', FEISHU_APP_SCOPES_USER:'user.custom',
    FEISHU_APP_EVENTS_TENANT:'tenant.event', FEISHU_APP_EVENTS_USER:'user.event',
  })
  const override = JSON.parse(readFileSync(calls,'utf8'))
  assert.deepEqual(override.addons.scopes,{tenant:['tenant.custom'],user:['user.custom']})
  assert.deepEqual(override.addons.events.items,{tenant:['tenant.event'],user:['user.event']})
  const old = await runWindowsHelper('__probe-profile', {agent_type:'codex',bot:{app_id:'cli_registered',lark_cli_profile:'aamp-test'}}, {
    AAMP_LARK_CLI_BIN:cli,AAMP_LARK_CLI_CONFIG_DIR:path.join(root,'version-config'),LARK_CLI_MIN_VERSION:'9.0.0',
  })
  assert.equal(old.ready,false)

})

test('discovers installed native Agents in stable order without a Codex allowlist', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-discover-'))
  const result = await runWindowsHelper(
    '__discover-agents',
    {},
    {
      // runWindowsHelper merges the host environment; override every discovery
      // input, including differently-cased Windows PATH and Agent variables.
      ...Object.fromEntries(Object.keys(process.env)
        .filter(key => /^(path|.*(?:aamp_.*_cli_bin|aamp_aime_acp_bin|trae_cli_bin|traecode_cli_bin))$/i.test(key))
        .map(key => [key, ''])),
      PATH: '', AAMP_TASK_USER_TENANT_KEY: '',
      ProgramFiles: root, ProgramW6432: root, 'ProgramFiles(x86)': root, LOCALAPPDATA: root,
      AAMP_COCO_CLI_BIN: '', AAMP_TRAEX_CLI_BIN: '', TRAE_CLI_BIN: '',
      AAMP_TRAECODE_CLI_BIN: '', TRAECODE_CLI_BIN: '',
      AAMP_WORKBUDDY_CLI_BIN: '', AAMP_WORKBUDDY_AI_CLI_BIN: '', AAMP_AIME_ACP_BIN: '',
      AAMP_CODEX_CLI_BIN: fakeCommand(root, 'codex'),
      AAMP_CURSOR_CLI_BIN: fakeCommand(root, 'cursor-agent'),
      AAMP_TRAE_CLI_BIN: path.join(root, 'missing'),
    },
  )
  assert.deepEqual(result, { agents: ['codex', 'cursor'] })
})

test('prepare codex returns a wrapper command without secrets', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-prepare-'))
  const codex = fakeCommand(root, 'codex')
  const result = await runWindowsHelper(
    '__prepare-agent',
    { agent_type: 'codex' },
    {
      AAMP_CODEX_CLI_BIN: codex,
      AAMP_TASK_SKIP_LOGIN_CHECK: 'true', CODEX_AUTO_UPDATE: 'false',
      AAMP_LARK_CLI_CONFIG_DIR: path.join(root, 'lark'),
      AAMP_TASK_RUNTIME_HOME: path.join(root, 'runtime'),
    },
    {ensureCodexAdapter:async()=>path.join(root,'adapter.mjs')},
  )
  assert.equal(result.agent_type, 'codex')
  assert.match(result.acp_command, /windows-agent-wrapper\.mjs/)
  assert.equal(result.lark_cli_config_dir, path.join(root, 'lark'))
  assert.doesNotMatch(result.acp_command, /secret/i)
})

test('IPC sends exactly one result and unknown actions return a sanitized error', async () => {
  const helper = new URL('../bootstrap/windows-helper.mjs', import.meta.url)
  const messages = []
  const child = fork(helper, [], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, PATH: '' },
  })
  child.on('message', (m) => messages.push(m))
  child.send({
    kind: 'request',
    action: '__unknown',
    payload: { app_secret: 'secret-sentinel' },
  })
  await new Promise((resolve) => child.once('exit', resolve))
  assert.equal(messages.length, 1)
  assert.deepEqual(Object.keys(messages[0]).sort(), ['kind', 'message'])
  assert.equal(messages[0].kind, 'error')
  assert.doesNotMatch(JSON.stringify(messages), /secret-sentinel/)
})

test('minimum version compares numeric components in order', () => {
  assert.equal(versionAtLeast('0.9.99', '1.0.64'), false)
  assert.equal(versionAtLeast('1.0.63', '1.0.64'), false)
  assert.equal(versionAtLeast('1.0.64', '1.0.64'), true)
  assert.equal(versionAtLeast('1.1.0', '1.0.64'), true)
  assert.equal(versionAtLeast('unknown', '1.0.64'), false)
})

test('explicit Codex ACP override reaches the wrapper config', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-override-'))
  await runWindowsHelper(
    '__prepare-agent',
    { agent_type: 'codex' },
    {
      AAMP_CODEX_CLI_BIN: process.execPath,
      AAMP_TASK_SKIP_LOGIN_CHECK: 'true', CODEX_AUTO_UPDATE: 'false',
      AAMP_TASK_RUNTIME_HOME: root,
      AAMP_TASK_CODEX_ACP_PKG: 'custom-codex-acp@2.0.0',
    },
    {ensureCodexAdapter:async({spec})=>{assert.equal(spec,'custom-codex-acp@2.0.0');return path.join(root,'adapter.mjs')}},
  )
  assert.equal(
    JSON.parse(
      readFileSync(path.join(root, 'windows-codex-agent.json'), 'utf8'),
    ).args.at(-1),
    path.join(root,'adapter.mjs'),
  )
})


test('registration prints original authorization URL and expiry when browser opening fails',async()=>{
  const {registerFeishuApp}=await import('../bootstrap/register-feishu-app.mjs')
  const logs=[]
  const sdk={registerApp:async options=>{options.onQRCodeReady({url:'https://example.test/authorize?code=test',expireIn:180});return {client_id:'cli',client_secret:'secret'}},Domain:{Feishu:'feishu'},Client:class{constructor(){this.application={application:{get:async()=>({data:{app:{app_name:'Bot'}}})}}}}}
  const result=await registerFeishuApp({sdk,openUrl:()=>{throw new Error('browser blocked')},log:message=>logs.push(message)})
  assert.equal(result.app_id,'cli')
  assert.ok(logs.includes('请打开授权链接完成飞书 Bot 授权（180 秒内有效）：https://example.test/authorize?code=test'))
  assert.ok(logs.some(message=>message.includes('未能自动打开浏览器')))
})

test('profile readiness accepts named CLI entries and legacy strings while retaining scope checks', async (t) => {
  const { rmSync } = await import('node:fs')
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-profile-list-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const cli = path.join(root, 'lark-cli.mjs')
  const calls = path.join(root, 'calls.jsonl')
  writeFileSync(cli, `
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(process.env.PROFILE_FIXTURE_CALLS, JSON.stringify(args) + '\\n')
if (args[0] === '--version') console.log('lark-cli version 1.0.64')
else if (args.join(' ') === 'profile list') console.log(process.env.PROFILE_FIXTURE_LIST)
else if (args.includes('status')) console.log(process.env.PROFILE_FIXTURE_STATUS)
else { console.error('unexpected mutating command'); process.exitCode = 1 }
`)
  const profile = 'aamp-feishu-task-cli_test'
  const current = { name: profile, appId: 'cli_test', brand: 'feishu', active: true, effective: true, effectiveSource: 'config', user: 'user', tokenStatus: 'valid' }
  const valid = { identities: { user: { available: true, tokenStatus: 'valid', scope: 'required.scope' } } }
  for (const [name, list, status, ready] of [
    ['named current entry', [current], valid, true],
    ['legacy string entry', [profile], valid, true],
    ['missing named profile', [{ ...current, name: 'other' }], valid, false],
    ['malformed entries', [null, 3, {}, { name: 3 }], valid, false],
    ['non-array response', { profiles: [current] }, valid, false],
    ['missing scope', [current], { identities: { user: { ...valid.identities.user, scope: 'other.scope' } } }, false],
    ['unavailable identity', [current], { identities: { user: { ...valid.identities.user, available: false } } }, false],
    ['expired token', [current], { identities: { user: { ...valid.identities.user, tokenStatus: 'expired' } } }, false],
  ]) {
    await t.test(name, async () => {
      const result = await runWindowsHelper('__probe-profile', {
        agent_type: 'codex', bot: { app_id: 'cli_test', lark_cli_profile: profile },
      }, {
        AAMP_LARK_CLI_BIN: cli,
        AAMP_LARK_CLI_CONFIG_DIR: path.join(root, 'config'),
        AAMP_FEISHU_AUTH_STATE_DIR: path.join(root, 'auth'),
        FEISHU_USER_AUTH_MODE: 'required',
        FEISHU_USER_AUTH_REQUIRED_SCOPES: 'required.scope',
        FEISHU_USER_AUTH_OPTIONAL_SCOPES: '',
        FEISHU_USER_AUTH_EXCLUDES: '',
        PROFILE_FIXTURE_CALLS: calls,
        PROFILE_FIXTURE_LIST: JSON.stringify(list),
        PROFILE_FIXTURE_STATUS: JSON.stringify(status),
      })
      assert.equal(result.ready, ready)
    })
  }
  const invoked = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(invoked.some(args => args.includes('add') || args.includes('login')), false)
})
