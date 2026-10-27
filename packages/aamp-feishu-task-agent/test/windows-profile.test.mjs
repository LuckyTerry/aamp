import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { runWindowsHelper } from '../bootstrap/windows-helper.mjs'

function cliFixture(root) {
  const file = path.join(root, 'lark-cli.mjs')
  writeFileSync(
    file,
    `import {appendFileSync} from 'node:fs'
let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',c=>input+=c)
process.stdin.on('end',()=>{ appendFileSync(process.env.CALLS,JSON.stringify({args:process.argv.slice(2),input})+'\\n'); const a=process.argv.slice(2)
if(a[0]==='--version') console.log('lark-cli version 1.0.64')
else if(a.join(' ')==='profile list') console.log(JSON.stringify(process.env.PROFILES?.split(',')||[]))
else if(a.includes('status')) console.log(process.env.AUTH_STATUS||'{"identities":{"user":{"available":false}}}') })`,
  )
  return file
}

const binding = {
  agent_type: 'codex',
  bot: {
    app_id: 'cli_app',
    app_secret: 'profile-secret',
    display_name: 'Bot',
    tenant_brand: 'lark',
    lark_cli_profile: 'exact profile',
  },
}

test('probe is read-only and preserves exact profile', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-profile-'))
  const calls = path.join(root, 'calls')
  const cli = cliFixture(root)
  const result = await runWindowsHelper('__probe-profile', binding, {
    AAMP_LARK_CLI_BIN: cli,
    AAMP_FEISHU_AUTH_STATE_DIR: path.join(root, 'auth'),
    AAMP_LARK_CLI_CONFIG_DIR: path.join(root, 'config'),
    CALLS: calls,
    PROFILES: 'exact profile',
    FEISHU_USER_AUTH_MODE: 'disabled',
  })
  assert.deepEqual(result, {
    ready: true,
    lark_cli_bin: cli,
    lark_cli_config_dir: path.join(root, 'config'),
  })
  assert.doesNotMatch(readFileSync(calls, 'utf8'), /profile.*add|auth.*login/)
})

test('ensure creates exact Lark profile through stdin and disabled mode does not authorize user', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-profile-'))
  const calls = path.join(root, 'calls')
  const cli = cliFixture(root)
  const result = await runWindowsHelper('__ensure-profile', binding, {
    AAMP_LARK_CLI_BIN: cli,
    AAMP_FEISHU_AUTH_STATE_DIR: path.join(root, 'auth'),
    AAMP_LARK_CLI_CONFIG_DIR: path.join(root, 'config'),
    CALLS: calls,
    PROFILES: '',
    FEISHU_USER_AUTH_MODE: 'disabled',
  })
  assert.equal(result.lark_cli_bin, cli)
  const records = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse)
  const add = records.find(
    (r) => r.args[0] === 'profile' && r.args[1] === 'add',
  )
  assert.deepEqual(add.args, [
    'profile',
    'add',
    '--name',
    'exact profile',
    '--app-id',
    'cli_app',
    '--brand',
    'lark',
    '--app-secret-stdin',
  ])
  assert.equal(add.input, 'profile-secret\n')
  assert.equal(
    records.some((r) => r.args.includes('login')),
    false,
  )
})

test('remote profile actions fail before invoking CLI', async () => {
  for (const action of ['__probe-profile', '__ensure-profile'])
    await assert.rejects(
      runWindowsHelper(
        action,
        { ...binding, execution_location: 'remote' },
        { AAMP_LARK_CLI_BIN: 'never' },
      ),
      /remote bindings/,
    )
})

test('refreshable auth and excluded requested scopes preserve Bash capability schema without raw credentials', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-capability-'))
  const cli = cliFixture(root)
  const result = await runWindowsHelper('__probe-profile', binding, {
    AAMP_LARK_CLI_BIN: cli,
    AAMP_LARK_CLI_CONFIG_DIR: path.join(root, 'config'),
    AAMP_FEISHU_AUTH_STATE_DIR: path.join(root, 'auth'),
    CALLS: path.join(root, 'calls'),
    PROFILES: 'exact profile',
    FEISHU_USER_AUTH_MODE: 'required',
    FEISHU_USER_AUTH_CORE_SCOPES: 'task:read',
    FEISHU_USER_AUTH_OPTIONAL_SCOPES: 'task:write',
    FEISHU_USER_AUTH_REQUESTED_SCOPES: 'task:read task:write',
    FEISHU_USER_AUTH_EXCLUDES: 'task:write,unrequested',
    AUTH_STATUS: JSON.stringify({
      secret: 'never-persist',
      identities: {
        user: {
          available: true,
          tokenStatus: 'needs_refresh',
          scope: 'task:read',
          access_token: 'never-persist',
        },
      },
    }),
  })
  assert.equal(result.ready, true)
  const snapshot = JSON.parse(
    readFileSync(path.join(root, 'auth', 'exact_profile.json'), 'utf8'),
  )
  assert.deepEqual(
    Object.keys(snapshot).sort(),
    [
      'schemaVersion',
      'manifestVersion',
      'profile',
      'tokenStatus',
      'grantedScopes',
      'missingCoreScopes',
      'missingOptionalScopes',
      'capabilities',
      'checkedAt',
    ].sort(),
  )
  assert.equal(snapshot.tokenStatus, 'needs_refresh')
  assert.deepEqual(snapshot.missingOptionalScopes, ['task:write'])
  assert.equal(snapshot.capabilities.task_user, false)
  assert.doesNotMatch(JSON.stringify(snapshot), /never-persist/)
})
