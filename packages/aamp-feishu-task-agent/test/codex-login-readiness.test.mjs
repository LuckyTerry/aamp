import assert from 'node:assert/strict'
import {execFile, spawn, spawnSync} from 'node:child_process'
import {once} from 'node:events'
import {chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {test} from 'node:test'
import {promisify} from 'node:util'
import {setTimeout as delay} from 'node:timers/promises'
import {ensureWindowsAgentLogin} from '../bootstrap/windows-agents.mjs'

const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const readiness = new URL('../bin/codex-readiness.mjs', import.meta.url)
const bootstrap = readFileSync(path.join(packageRoot, 'bootstrap/aamp-feishu-task-agent-bootstrap.sh'), 'utf8')

function functionsBetween(start, end) {
  return bootstrap.slice(bootstrap.indexOf(`${start}()`), bootstrap.indexOf(`\n${end}()`, bootstrap.indexOf(`${start}()`)))
}

function fixture(t, mode) {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-codex-login-'))
  t.after(() => rmSync(root, {recursive: true, force: true}))
  const cli = path.join(root, 'desktop codex')
  const calls = path.join(root, 'calls.jsonl')
  const config = path.join(root, 'config.toml')
  writeFileSync(config, 'model_provider = "custom"\n')
  writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify({args, pid: process.pid, cwd: process.cwd(), home: process.env.CODEX_HOME, key: process.env.CUSTOM_API_KEY}) + '\\n');
if (args.join(' ') === 'login status') process.exit(process.env.TEST_MODE === 'logged-in' ? 0 : process.env.TEST_MODE === 'cancelled-status' ? 130 : 1);
if (args[0] === 'login') { console.error('unexpected interactive login'); process.exit(90); }
if (args[0] !== 'exec') process.exit(91);
if (process.env.TEST_MODE === 'network') { console.error('request timed out'); process.exit(1); }
if (process.env.TEST_MODE === 'auth') { console.error('401 Unauthorized: invalid_api_key secret-do-not-print'); process.exit(1); }
if (process.env.TEST_MODE === 'config') { console.error('Error loading config.toml: TOML parse error secret-do-not-print'); process.exit(1); }
if (process.env.TEST_MODE === 'output-limit') { process.stdout.write('x'.repeat(128 * 1024)); setInterval(() => {}, 1000); }
if (process.env.TEST_MODE === 'empty') { console.log('Usage: codex exec'); process.exit(0); }
if (process.env.TEST_MODE === 'hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
else if (process.env.TEST_MODE !== 'output-limit') { const index = args.indexOf('--output-last-message'); if (index < 0) process.exit(92); fs.writeFileSync(args[index + 1], 'OK\\n'); }
`)
  chmodSync(cli, 0o755)
  return {
    root, cli, config, command: {command: process.execPath, argsPrefix: [cli]},
    env: {...process.env, TEST_CALLS: calls, TEST_MODE: mode, CODEX_HOME: root, CUSTOM_API_KEY: 'secret-do-not-print'},
    calls: () => readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)),
  }
}

function runBootstrap(fixture, nonInteractive = false) {
  return spawnSync('bash', ['-c', `
set -euo pipefail
AGENT=codex
is_macos() { return 0; }
clear_codex_quarantine() { :; }
agent_log() { printf '%s\\n' "$*"; }
agent_detail() { :; }
agent_fail() { printf '%s\\n' "$*" >&2; exit 64; }
CODEX_TEST_BIN="$1"
resolve_codex_cli_for_acp() { printf '%s\\n' "$CODEX_TEST_BIN"; }
PACKAGE_TEST_ROOT="$2"
task_agent_global_package_dir() { printf '%s\\n' "$PACKAGE_TEST_ROOT"; }
${functionsBetween('run_codex_login_status', 'run_trae_login_status_for_bin')}
${functionsBetween('ensure_interactive_agent_recovery_allowed', 'run_acp_bridge')}
ensure_agent_login
`, 'bash', fixture.cli, packageRoot], {
    env: {...fixture.env, AAMP_TASK_NON_INTERACTIVE: String(nonInteractive)},
    encoding: 'utf8', timeout: 10_000,
  })
}

test('Codex bootstrap accepts a working provider without forcing account login', {skip: process.platform === 'win32'}, async t => {
  for (const nonInteractive of [false, true]) {
    await t.test(nonInteractive ? 'background preparation' : 'interactive preparation', t => {
      const f = fixture(t, 'custom')
      const result = runBootstrap(f, nonInteractive)
      assert.equal(result.status, 0, result.stderr)
      const calls = f.calls()
      assert.deepEqual(calls.map(call => call.args.slice(0, 2)), [['login', 'status'], ['exec', '--skip-git-repo-check']])
      assert.equal(calls[1].home, f.root)
      assert.equal(calls[1].key, 'secret-do-not-print')
      assert.equal(readFileSync(f.config, 'utf8'), 'model_provider = "custom"\n')
    })
  }
  await t.test('logged-in fast path makes no model call', t => {
    const f = fixture(t, 'logged-in')
    assert.equal(runBootstrap(f).status, 0)
    assert.deepEqual(f.calls().map(call => call.args), [['login', 'status']])
  })
  await t.test('cancelled status check never starts a model request', t => {
    const f = fixture(t, 'cancelled-status')
    const result = runBootstrap(f)
    assert.equal(result.status, 64)
    assert.match(result.stderr, /已取消/)
    assert.deepEqual(f.calls().map(call => call.args), [['login', 'status']])
  })
  for (const [mode, message] of [['network', /模型连接失败/], ['auth', /认证未通过/], ['config', /配置检查失败/]]) {
    await t.test(`${mode} failure remains actionable without login`, t => {
      const f = fixture(t, mode)
      const result = runBootstrap(f)
      assert.equal(result.status, 64)
      assert.match(result.stderr, message)
      assert.doesNotMatch(result.stderr, /secret-do-not-print/)
      assert.deepEqual(f.calls().map(call => call.args.slice(0, 2)), [['login', 'status'], ['exec', '--skip-git-repo-check']])
    })
  }
})

test('Codex readiness validates a real final answer without changing provider settings', async t => {
  const {probeCodex} = await import(readiness.href)
  const f = fixture(t, 'custom')
  await probeCodex(f.command, {env: f.env})
  const [call] = f.calls()
  assert.equal(call.args[call.args.indexOf('--sandbox') + 1], 'read-only')
  assert.ok(call.args.includes('--ephemeral'))
  assert.ok(call.args.includes('--skip-git-repo-check'))
  assert.equal(call.home, f.root)
  assert.equal(call.key, 'secret-do-not-print')
  assert.notEqual(call.cwd, process.cwd())
  assert.equal(readFileSync(f.config, 'utf8'), 'model_provider = "custom"\n')
  assert.throws(() => readFileSync(call.args[call.args.indexOf('--output-last-message') + 1]), {code: 'ENOENT'})
})

test('Codex readiness failures do not masquerade as ready or leak provider output', async t => {
  const {probeCodex} = await import(readiness.href)
  for (const [mode, code] of [['network', 'CODEX_NETWORK'], ['auth', 'CODEX_AUTH'], ['config', 'CODEX_CONFIG'], ['empty', 'CODEX_NO_RESPONSE'], ['hang', 'ETIMEDOUT'], ['output-limit', 'CODEX_OUTPUT_LIMIT']]) {
    await t.test(mode, async t => {
      const f = fixture(t, mode)
      await assert.rejects(probeCodex(f.command, {env: f.env, timeoutMs: mode === 'hang' ? 500 : 3000}), error => {
        assert.equal(error.code, code)
        assert.doesNotMatch(error.message, /secret-do-not-print/)
        return true
      })
      assert.deepEqual(f.calls().map(call => call.args[0]), ['exec'])
      assert.equal(readFileSync(f.config, 'utf8'), 'model_provider = "custom"\n')
    })
  }
  await assert.rejects(probeCodex(path.join(tmpdir(), 'missing-aamp-codex-executable')), {code: 'ENOENT'})
})

test('cancelling the readiness helper stops its detached model probe', {skip: process.platform === 'win32', timeout: 10_000}, async t => {
  const f = fixture(t, 'hang')
  const helper = spawn(process.execPath, [fileURLToPath(readiness), 'probe', f.cli], {env: f.env, stdio: 'ignore'})
  const exited = once(helper, 'exit')
  let call
  try {
    for (let attempt = 0; attempt < 100 && !call; attempt++) {
      try { [call] = f.calls() } catch {}
      if (!call) await delay(20)
    }
    assert.ok(call, 'the simulated model probe must start')
    helper.kill('SIGTERM')
    await exited
    let alive = true
    for (let attempt = 0; attempt < 50 && alive; attempt++) {
      try { process.kill(call.pid, 0); await delay(20) } catch { alive = false }
    }
    assert.equal(alive, false, 'cancelling AAMP must not leave a model request running')
  } finally {
    helper.kill('SIGKILL')
    if (call) { try { process.kill(-call.pid, 'SIGKILL') } catch {} }
  }
})

test('Windows Codex preparation accepts custom providers and never opens interactive login', async t => {
  const run = (command, args, options) => promisify(execFile)(command.command, [...command.argsPrefix, ...args], {env: options.env, timeout: options.timeout})
  for (const nonInteractive of [false, true]) {
    await t.test(nonInteractive ? 'background' : 'interactive', async t => {
      const f = fixture(t, 'custom')
      await ensureWindowsAgentLogin('codex', f.command, {...f.env, AAMP_TASK_NON_INTERACTIVE: String(nonInteractive)}, run)
      assert.deepEqual(f.calls().map(call => call.args[0]), ['login', 'exec'])
    })
  }
  await t.test('already authenticated skips probe', async t => {
    const f = fixture(t, 'logged-in')
    await ensureWindowsAgentLogin('codex', f.command, f.env, run)
    assert.deepEqual(f.calls().map(call => call.args), [['login', 'status']])
  })
  await t.test('cancelled login check does not start a model request', async t => {
    const f = fixture(t, 'cancelled-status')
    await assert.rejects(ensureWindowsAgentLogin('codex', f.command, f.env, run), /已取消/)
    assert.deepEqual(f.calls().map(call => call.args), [['login', 'status']])
  })
  await t.test('API rejection does not launch official login', async t => {
    const f = fixture(t, 'auth')
    await assert.rejects(ensureWindowsAgentLogin('codex', f.command, f.env, run), {code: 'CODEX_AUTH'})
    assert.deepEqual(f.calls().map(call => call.args[0]), ['login', 'exec'])
  })
})
