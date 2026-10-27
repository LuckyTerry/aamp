import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { test } from 'node:test'
import { resolveNativeCommand } from '../bin/windows-platform.mjs'
import { runWindowsHelper, mergeHelperEnvironment } from '../bootstrap/windows-helper.mjs'
import { withWindowsOperationLock } from '../bin/windows-operation-lock.mjs'
const fixture = new URL('./fixtures/npm-cmd-shim.cmd', import.meta.url)
async function root(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aamp-final-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return fs.realpath(dir)
}

test('actual installed npm cmd-shim dp0 variable resolves JavaScript bin', async (t) => {
  const dir = await root(t)
  await fs.mkdir(path.join(dir, 'bin'))
  await fs.writeFile(path.join(dir, 'bin', 'cli.js'), '')
  await fs.copyFile(fixture, path.join(dir, 'cli.cmd'))
  assert.deepEqual(
    await resolveNativeCommand('cli', {
      platform: 'win32',
      env: { PATH: dir, PATHEXT: '.cmd' },
    }),
    {
      command: process.execPath,
      argsPrefix: [path.join(dir, 'bin', 'cli.js')],
    },
  )
})

test('Codex npm package resolves declared Windows vendor executable for CODEX_PATH', async (t) => {
  const dir = await root(t),
    pkg = path.join(dir, 'node_modules', '@openai', 'codex'),
    native = path.join(dir, 'node_modules', '@openai', 'codex-win32-x64')
  await fs.mkdir(path.join(pkg, 'bin'), { recursive: true })
  await fs.writeFile(path.join(pkg, 'bin', 'codex.js'), '')
  await fs.writeFile(
    path.join(pkg, 'package.json'),
    JSON.stringify({
      name: '@openai/codex',
      bin: { codex: 'bin/codex.js' },
      optionalDependencies: {
        '@openai/codex-win32-x64': 'npm:@openai/codex@0.153.4-win32-x64',
      },
    }),
  )
  const exe = path.join(
    native,
    'vendor',
    'x86_64-pc-windows-msvc',
    'bin',
    'codex.exe',
  )
  await fs.mkdir(path.dirname(exe), { recursive: true })
  await fs.writeFile(
    path.join(native, 'package.json'),
    JSON.stringify({ name: '@openai/codex', version: '0.153.4-win32-x64' }),
  )
  await fs.writeFile(exe, '')
  await fs.chmod(exe, 0o755)
  const shim = (await fs.readFile(fixture, 'utf8')).replace(
    'bin\\cli.js',
    'node_modules\\@openai\\codex\\bin\\codex.js',
  )
  await fs.writeFile(path.join(dir, 'codex.cmd'), shim)
  const env = {
    PATH: dir,
    PATHEXT: '.cmd',
    AAMP_WINDOWS_TEST_PLATFORM: 'win32',
    AAMP_WINDOWS_TEST_ARCH: 'x64',
    AAMP_NPX_CLI_BIN: process.execPath,
    AAMP_TASK_SKIP_LOGIN_CHECK: 'true', CODEX_AUTO_UPDATE: 'false',
    AAMP_TASK_RUNTIME_HOME: path.join(dir, 'runtime'),
  }
  await runWindowsHelper('__prepare-agent', { agent_type: 'codex' }, env, {ensureCodexAdapter:async()=>path.join(dir,'adapter.mjs')})
  assert.equal(
    JSON.parse(
      await fs.readFile(
        path.join(dir, 'runtime', 'windows-codex-agent.json'),
        'utf8',
      ),
    ).env.CODEX_PATH,
    exe,
  )
})

test('isolated lark CLI is rediscovered without persistent PATH edits and returns absolute JS entry', async (t) => {
  const dir = await root(t),
    prefix = path.join(dir, 'npm-global')
  await fs.mkdir(path.join(prefix, 'bin'), { recursive: true })
  const entry = path.join(prefix, 'bin', 'cli.js')
  await fs.writeFile(
    entry,
    "console.log(process.argv.includes('--version')?'1.0.64':'[\"profile\"]')",
  )
  await fs.copyFile(fixture, path.join(prefix, 'lark-cli.cmd'))
  const result = await runWindowsHelper(
    '__probe-profile',
    {
      agent_type: 'codex',
      bot: { app_id: 'cli', lark_cli_profile: 'profile' },
    },
    {
      PATH: '',
      PATHEXT: '.cmd',
      AAMP_WINDOWS_TEST_PLATFORM: 'win32',
      AAMP_TASK_RUNTIME_HOME: dir,
      AAMP_LARK_CLI_CONFIG_DIR: path.join(dir, 'config'),
      AAMP_FEISHU_AUTH_STATE_DIR: path.join(dir, 'auth'),
      FEISHU_USER_AUTH_MODE: 'disabled',
    },
  )
  assert.equal(result.ready, true)
  assert.equal(result.lark_cli_bin, entry)
})

test('operation locks serialize independent instances and recover only a verified stale owner', async (t) => {
  const dir = await root(t),
    lock = path.join(dir, 'lock'),
    calls = []
  const mine = {
    pid: process.pid,
    startedAt: 'now',
    ownerSid: 'sid',
    executablePath: 'node',
  }
  const readIdentity = async (pid) => (pid === process.pid ? mine : undefined)
  await fs.mkdir(lock)
  await fs.writeFile(
    path.join(lock, 'owner.json'),
    JSON.stringify({
      version: 1,
      token: 'old',
      identity: { ...mine, pid: 999999 },
    }),
  )
  await Promise.all([
    withWindowsOperationLock(
      lock,
      async () => {
        calls.push('first')
        await new Promise((r) => setTimeout(r, 100))
        calls.push('end')
      },
      { readIdentity },
    ),
    withWindowsOperationLock(lock, async () => calls.push('second'), {
      readIdentity,
    }),
  ])
  assert.ok(
    JSON.stringify(calls) === JSON.stringify(['first', 'end', 'second']) ||
      JSON.stringify(calls) === JSON.stringify(['second', 'first', 'end']),
  )
  await fs.mkdir(lock)
  await fs.writeFile(path.join(lock, 'unknown'), 'keep')
  await assert.rejects(
    withWindowsOperationLock(
      lock,
      () => assert.fail('unknown lock must block'),
      { readIdentity, attempts: 0 },
    ),
    /unknown owners/,
  )
  assert.equal(await fs.readFile(path.join(lock, 'unknown'), 'utf8'), 'keep')
})

test('profile ACL failure blocks CLI credential writes', async (t) => {
  const dir = await root(t)
  await assert.rejects(
    runWindowsHelper(
      '__ensure-profile',
      {
        agent_type: 'codex',
        bot: {
          app_id: 'cli',
          app_secret: 'secret',
          lark_cli_profile: 'profile',
        },
      },
      {
        AAMP_LARK_CLI_BIN: 'never',
        AAMP_LARK_CLI_CONFIG_DIR: path.join(dir, 'config'),
      },
      {
        ensurePrivateDirectory: async () => {
          throw new Error('ACL denied')
        },
      },
    ),
    /ACL denied/,
  )
})

test('background profile preparation cannot install a missing CLI', async (t) => {
  const dir = await root(t)
  await assert.rejects(
    runWindowsHelper(
      '__ensure-profile',
      {
        agent_type: 'codex',
        bot: {
          app_id: 'cli',
          app_secret: 'secret',
          lark_cli_profile: 'profile',
        },
      },
      {
        PATH: '',
        AAMP_TASK_NON_INTERACTIVE: 'true',
        AAMP_TASK_RUNTIME_HOME: dir,
        AAMP_LARK_CLI_CONFIG_DIR: path.join(dir, 'config'),
        AAMP_WINDOWS_TEST_PLATFORM: 'win32',
      },
    ),
    /后台服务无法安装/,
  )
})

test('missing lark CLI installs once into fixed prefix and both ensure and later probe report persistent entry', async t => {
  const dir = await root(t)
  const npm = path.join(dir, 'npm.mjs')
  const shim = await fs.readFile(fixture, 'utf8')
  await fs.writeFile(npm, `import fs from 'node:fs/promises';import path from 'node:path';
const root=process.env.AAMP_TASK_RUNTIME_HOME,prefix=path.join(root,'npm-global');
await fs.appendFile(path.join(root,'installs'),'install\\n');
await fs.mkdir(path.join(prefix,'bin'),{recursive:true});
await fs.writeFile(path.join(prefix,'bin','cli.js'),${JSON.stringify("console.log(process.argv.includes('--version')?'1.0.64':'[\"profile\"]')")});
await fs.writeFile(path.join(prefix,'lark-cli.cmd'),${JSON.stringify(shim)});`)
  const binding = {agent_type:'codex',bot:{app_id:'cli',app_secret:'secret',lark_cli_profile:'profile'}}
  const env = {PATH:'',PATHEXT:'.cmd',AAMP_WINDOWS_TEST_PLATFORM:'win32',AAMP_TASK_RUNTIME_HOME:dir,AAMP_NPM_CLI_JS:npm,AAMP_LARK_CLI_CONFIG_DIR:path.join(dir,'config'),AAMP_FEISHU_AUTH_STATE_DIR:path.join(dir,'auth'),FEISHU_USER_AUTH_MODE:'disabled'}
  const first = await runWindowsHelper('__ensure-profile',binding,env)
  const second = await runWindowsHelper('__probe-profile',binding,env)
  assert.equal(second.ready,true)
  assert.equal(first.lark_cli_bin,path.join(dir,'npm-global','bin','cli.js'))
  assert.equal(second.lark_cli_bin,first.lark_cli_bin)
  assert.equal(await fs.readFile(path.join(dir,'installs'),'utf8'),'install\n')
})

test('operation lock serializes independent Node processes', async t => {
  const {execFile} = await import('node:child_process')
  const {promisify} = await import('node:util')
  const execute = promisify(execFile)
  const dir = await root(t)
  const script = `import fs from 'node:fs/promises';import {withWindowsOperationLock} from ${JSON.stringify(new URL('../bin/windows-operation-lock.mjs',import.meta.url).href)};
const dir=process.argv[1],label=process.argv[2];
await withWindowsOperationLock(dir+'/lock',async()=>{await fs.appendFile(dir+'/events',label+' begin\\n');await new Promise(r=>setTimeout(r,80));await fs.appendFile(dir+'/events',label+' end\\n')},{readIdentity:async pid=>({pid,startedAt:'stable',executablePath:'node',ownerSid:'test-sid'})});`
  await Promise.all(['a','b'].map(label=>execute(process.execPath,['--input-type=module','-e',script,dir,label])))
  const events = (await fs.readFile(path.join(dir,'events'),'utf8')).trim().split('\n')
  assert.equal(events.length,4)
  assert.equal(events[0][0],events[1][0])
  assert.equal(events[2][0],events[3][0])
  assert.notEqual(events[0][0],events[2][0])
})


test('Windows helper overrides inherited Path casing before resolving the selected native CLI', async t => {
  const dir = await root(t)
  const executable = path.join(dir, 'selected.exe')
  await fs.writeFile(executable, '')
  for (const [inheritedKey, overrideKey] of [['Path', 'PATH'], ['PATH', 'Path']]) {
    const env = mergeHelperEnvironment({[overrideKey]: dir, PATHEXT: '.exe', AAMP_WINDOWS_TEST_PLATFORM: 'win32'}, {[inheritedKey]: 'missing-parent-path', SystemRoot: 'preserved'})
    assert.deepEqual(Object.keys(env).filter(key => key.toLowerCase() === 'path'), [overrideKey])
    assert.equal(env.SystemRoot, 'preserved')
    assert.deepEqual(await resolveNativeCommand('selected', {platform: 'win32', env}), {command: executable, argsPrefix: []})
  }
})
