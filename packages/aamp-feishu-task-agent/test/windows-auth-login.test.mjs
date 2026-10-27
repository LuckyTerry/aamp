import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runWindowsAuthLogin } from '../bootstrap/windows-auth-login.mjs'

function capture() {
  const opened = [], output = { stdout: '', stderr: '' }
  return { opened, output, options: {
    env: { ...process.env, AAMP_AUTO_OPEN_AUTH_URL: 'true', AAMP_TASK_TEST_NO_BROWSER: 'false' },
    openUrl: url => opened.push(url),
    stdout: { write: chunk => { output.stdout += chunk } },
    stderr: { write: chunk => { output.stderr += chunk } },
  } }
}
const node = { command: process.execPath, argsPrefix: ['--input-type=module', '-e'] }

test('opens a split authorization URL once while login is still waiting and preserves output', async () => {
  const c = capture()
  let finished = false
  c.options.openUrl = url => { assert.equal(finished, false); c.opened.push(url) }
  delete c.options.env.AAMP_AUTO_OPEN_AUTH_URL
  await runWindowsAuthLogin(node, [String.raw`
    process.stdout.write('请授权 https://accounts.feishu.cn/oauth/');
    setTimeout(() => process.stdout.write('verify?user_code=ABC\n'), 30);
    setTimeout(() => process.stderr.write('https://accounts.feishu.cn/second\n'), 60);
    setTimeout(() => process.stdout.write('授权完成\n'), 120);
  `], c.options)
  finished = true
  assert.deepEqual(c.opened, ['https://accounts.feishu.cn/oauth/verify?user_code=ABC'])
  assert.equal(c.output.stdout, '请授权 https://accounts.feishu.cn/oauth/verify?user_code=ABC\n授权完成\n')
  assert.equal(c.output.stderr, 'https://accounts.feishu.cn/second\n')
})

test('opens URLs emitted on stderr and preserves CLI arguments and environment', async () => {
  const c = capture()
  c.options.env.AUTH_TEST_VALUE = 'unchanged'
  await runWindowsAuthLogin(node, [`
    console.log(JSON.stringify({args:process.argv.slice(1),env:process.env.AUTH_TEST_VALUE}));
    console.error('https://accounts.feishu.cn/verify');
  `, '--', '--profile', 'profile with spaces', 'auth', 'login', '--scope', 'task:task'], c.options)
  assert.deepEqual(JSON.parse(c.output.stdout), { args: ['--profile','profile with spaces','auth','login','--scope','task:task'], env: 'unchanged' })
  assert.deepEqual(c.opened, ['https://accounts.feishu.cn/verify'])
})

test('browser opt-out keeps authorization output and success', async () => {
  for (const key of ['AAMP_AUTO_OPEN_AUTH_URL', 'AAMP_TASK_TEST_NO_BROWSER']) {
    const c = capture()
    c.options.env[key] = key === 'AAMP_AUTO_OPEN_AUTH_URL' ? 'false' : 'true'
    await runWindowsAuthLogin(node, ["console.log('https://accounts.feishu.cn/verify')"], c.options)
    assert.deepEqual(c.opened, [])
    assert.match(c.output.stdout, /https:/)
  }
})

test('browser failures do not change successful login; CLI failures retain exit code', async () => {
  for (const openUrl of [() => { throw new Error('no desktop') }, () => Promise.reject(new Error('no desktop'))]) {
    const c = capture()
    await runWindowsAuthLogin(node, ["console.log('https://accounts.feishu.cn/verify')"], { ...c.options, openUrl })
    assert.match(c.output.stderr, /请手动打开/)
  }
  const c = capture()
  await assert.rejects(runWindowsAuthLogin(node, ["console.error('authorization failed');process.exit(7)"], c.options), { code: 7 })
  assert.equal(c.output.stderr, 'authorization failed\n')
})
