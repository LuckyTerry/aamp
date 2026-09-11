import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const bootstrap = path.resolve(__dirname, '../bootstrap/aamp-feishu-task-agent-bootstrap.sh')
const packageJson = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'))
const bootstrapBaseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => (
  !/^(?:npm_|INIT_CWD$)/i.test(key)
)))

test('task agent package includes the packaged bin directory', () => {
  assert.equal(
    packageJson.files.includes('bin'),
    true,
    'the packaged bin directory must include traecode-readiness.mjs',
  )
})

test('global Task Agent installation requires the TraeCode readiness helper', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const completeness = source.slice(
    source.indexOf('task_agent_global_install_is_complete()'),
    source.indexOf('\ntask_agent_global_install_is_current()', source.indexOf('task_agent_global_install_is_complete()')),
  )
  assert.match(completeness, /bin\/traecode-readiness\.mjs/)
})

test('task agent source keeps canonical package metadata and records the last successful release pins', () => {
  const canonicalPackage = '@larktask/aamp-feishu-task-agent'
  const releasedTaskAgent = '@larktask/aamp-feishu-task-agent'
  const releasedAcpBridge = '@luckyterry/aamp-acp-bridge@0.1.29-dev.0'
  const source = readFileSync(bootstrap, 'utf8')
  const controller = readFileSync(path.resolve(__dirname, '../bin/feishu-task-agent-controller.mjs'), 'utf8')
  const readme = readFileSync(path.resolve(__dirname, '../README.md'), 'utf8')
  const packageLock = JSON.parse(readFileSync(path.resolve(__dirname, '../package-lock.json'), 'utf8'))

  assert.equal(packageJson.name, canonicalPackage)
  assert.equal(packageLock.name, canonicalPackage)
  assert.equal(packageLock.packages[''].name, canonicalPackage)
  assert.match(source, new RegExp(`ACP_BRIDGE_PKG=\"\\$\\{ACP_BRIDGE_PKG:-${releasedAcpBridge.replace('/', '\\/')}\\}\"`))
  assert.match(controller, new RegExp(`'${releasedAcpBridge.replace('/', '\\/')}'`))
  assert.match(source, new RegExp(`AAMP_TASK_AGENT_NAME=\"\\$\\{AAMP_TASK_AGENT_NAME:-${releasedTaskAgent.replace('/', '\\/')}\\}\"`))
  assert.match(controller, new RegExp(`npx -y --package ${releasedTaskAgent.replace('/', '\\/')}@dev feishu-task-agent install`))
  assert.match(readme, new RegExp(`npx -y --package ${releasedTaskAgent.replace('/', '\\/')}@dev`))
})

test('bootstrap embedded version matches the published package version', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const match = source.match(/^AAMP_TASK_AGENT_VERSION="([^"]+)"$/m)

  assert.ok(match, 'bootstrap must declare AAMP_TASK_AGENT_VERSION')
  assert.equal(match[1], packageJson.version)
})

test('bootstrap script has valid bash syntax', () => {
  execFileSync('bash', ['-n', bootstrap])
})

test('bootstrap --help remains side-effect light and prints usage', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-bootstrap-help-'))

  const output = execFileSync('bash', [bootstrap, '--help'], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  })

  assert.match(output, /Usage:/)
  assert.match(output, /feishu-task-agent/)
})

test('bootstrap exposes background lifecycle commands and foreground opt-in', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-bootstrap-service-help-'))
  const output = execFileSync('bash', [bootstrap, '--help'], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  })

  for (const command of ['status', 'stop', 'restart', 'logs']) {
    assert.match(output, new RegExp(`feishu-task-agent ${command}`))
  }
  assert.match(output, /start --foreground/)
  assert.match(output, /macOS.*后台/)
})

test('bootstrap parses foreground and private service actions without changing their intent', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-bootstrap-service-args-'))
  const bootstrapLib = path.join(root, 'bootstrap-functions.sh')
  writeFileSync(bootstrapLib, readFileSync(bootstrap, 'utf8').replace(/\nmain "\$@"\n$/, '\n'))

  const parse = (...args) => spawnSync('bash', ['-c', `
set -euo pipefail
source "$BOOTSTRAP_LIB"
agent_fail() { printf '%s\\n' "$*" >&2; exit 64; }
parse_args "$@"
printf '%s|%s' "$AAMP_TASK_ACTION" "$AAMP_TASK_FOREGROUND"
`, 'bash', ...args], {
    encoding: 'utf8',
    env: {
      ...bootstrapBaseEnv,
      HOME: root,
      BOOTSTRAP_LIB: bootstrapLib,
      AAMP_TASK_AUTO_UPDATE: 'false',
    },
  })

  const foreground = parse('start', '--foreground')
  assert.equal(foreground.status, 0, foreground.stderr)
  assert.equal(foreground.stdout, 'start|true')

  const service = parse('__service-run')
  assert.equal(service.status, 0, service.stderr)
  assert.equal(service.stdout, '__service-run|false')
})

test('bootstrap accepts add --no-start as an explicit save-only mode', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-bootstrap-add-no-start-'))
  const bootstrapLib = path.join(root, 'bootstrap-functions.sh')
  writeFileSync(bootstrapLib, readFileSync(bootstrap, 'utf8').replace(/\nmain "\$@"\n$/, '\n'))

  const result = spawnSync('bash', ['-c', `
set -euo pipefail
source "$BOOTSTRAP_LIB"
agent_fail() { printf '%s\\n' "$*" >&2; exit 64; }
parse_args "$@"
printf '%s|%s' "$AAMP_TASK_ACTION" "$AAMP_TASK_NO_START"
`, 'bash', 'add', '--no-start'], {
    encoding: 'utf8',
    env: {
      ...bootstrapBaseEnv,
      HOME: root,
      BOOTSTRAP_LIB: bootstrapLib,
      AAMP_TASK_AUTO_UPDATE: 'false',
    },
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'add|true')

  const help = execFileSync('bash', [bootstrap, '--help'], {
    env: { ...process.env, HOME: root },
    encoding: 'utf8',
  })
  assert.match(help, /add --no-start/)
})

test('an inherited no-start mode does not reject internal add helpers', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-bootstrap-inherited-no-start-'))
  const bootstrapLib = path.join(root, 'bootstrap-functions.sh')
  writeFileSync(bootstrapLib, readFileSync(bootstrap, 'utf8').replace(/\nmain "\$@"\n$/, '\n'))

  const result = spawnSync('bash', ['-c', `
set -euo pipefail
source "$BOOTSTRAP_LIB"
agent_fail() { printf '%s\\n' "$*" >&2; exit 64; }
parse_args "$@"
printf '%s|%s' "$AAMP_TASK_ACTION" "$AAMP_TASK_NO_START"
`, 'bash', '__register-binding'], {
    encoding: 'utf8',
    env: {
      ...bootstrapBaseEnv,
      HOME: root,
      BOOTSTRAP_LIB: bootstrapLib,
      AAMP_TASK_AUTO_UPDATE: 'false',
      AAMP_TASK_NO_START: 'true',
    },
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '__register-binding|true')
})

test('bootstrap accepts the legacy normal token passed by an older auto-updater', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-bootstrap-legacy-update-'))
  const result = spawnSync('bash', [bootstrap, 'normal', '--help'], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /Usage:/)
})

function runNodeToolchainCheck({ node = false, npm = false, npx = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-node-toolchain-'))
  const binDir = path.join(root, 'bin')
  const bootstrapLib = path.join(root, 'bootstrap-functions.sh')
  const brewCalls = path.join(root, 'brew-calls.log')
  mkdirSync(binDir)
  writeFileSync(bootstrapLib, readFileSync(bootstrap, 'utf8').replace(/\nmain "\$@"\n$/, '\n'))
  writeFileSync(path.join(binDir, 'cat'), '#!/bin/bash\nexec /bin/cat "$@"\n')
  writeFileSync(path.join(binDir, 'brew'), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$BREW_CALLS"\nexit 0\n')
  for (const name of ['cat', 'brew']) chmodSync(path.join(binDir, name), 0o755)
  for (const [name, present] of Object.entries({ node, npm, npx })) {
    if (!present) continue
    writeFileSync(path.join(binDir, name), `#!/bin/bash\nprintf '${name} test\\n'\n`)
    chmodSync(path.join(binDir, name), 0o755)
  }

  const result = spawnSync('bash', ['-c', `
set -euo pipefail
source "$BOOTSTRAP_LIB"
PATH="$FAKE_BIN"
agent_log() { printf 'LOG:%s\\n' "$*"; }
agent_fail() { printf 'ERROR:%s\\n' "$*" >&2; exit 64; }
configure_npm_registry() { printf 'configured\\n'; }
ensure_node_toolchain
`], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...bootstrapBaseEnv,
      HOME: root,
      BOOTSTRAP_LIB: bootstrapLib,
      FAKE_BIN: binDir,
      BREW_CALLS: brewCalls,
      AAMP_TASK_AUTO_UPDATE: 'false',
    },
  })

  return {
    ...result,
    brewCalls: existsSync(brewCalls) ? readFileSync(brewCalls, 'utf8') : '',
  }
}

test('missing Node.js exits with official LTS installation guidance without invoking a package manager', () => {
  const result = runNodeToolchainCheck()

  assert.equal(result.status, 64)
  assert.match(result.stderr, /未检测到 Node\.js 环境/)
  assert.match(result.stderr, /https:\/\/nodejs\.org\/en\/download/)
  assert.match(result.stderr, /node -v && npm -v/)
  assert.match(result.stderr, /重新打开终端/)
  assert.match(result.stderr, /ERROR:未检测到 Node\.js，请先安装 Node\.js LTS/)
  assert.doesNotMatch(result.stderr, /Homebrew|Volta|fnm|nvm/)
  assert.equal(result.brewCalls, '')
})

test('incomplete Node.js exits with the same official guidance instead of repairing through a package manager', () => {
  const result = runNodeToolchainCheck({ node: true })

  assert.equal(result.status, 64)
  assert.match(result.stderr, /Node\.js 环境不完整/)
  assert.match(result.stderr, /https:\/\/nodejs\.org\/en\/download/)
  assert.match(result.stderr, /node -v && npm -v/)
  assert.match(result.stderr, /ERROR:Node\.js 环境不完整，请重新安装 Node\.js LTS/)
  assert.doesNotMatch(result.stderr, /Homebrew|Volta|fnm|nvm/)
  assert.equal(result.brewCalls, '')
})

test('Node.js with npm continues when the legacy npx command is absent', () => {
  const result = runNodeToolchainCheck({ node: true, npm: true })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /configured/)
  assert.equal(result.brewCalls, '')
})

test('internal profile probe reports hit or miss without profile mutation, auth login, or prompting', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-profile-probe-'))
  const fakeCli = path.join(root, 'lark-cli')
  const callsFile = path.join(root, 'calls.log')
  const metadataFile = path.join(root, 'npm-global', 'lib/node_modules/@larktask/aamp-feishu-task-agent/bin/agent-metadata.mjs')
  mkdirSync(path.dirname(metadataFile), { recursive: true })
  writeFileSync(metadataFile, readFileSync(path.resolve(__dirname, '../bin/agent-metadata.mjs')))
  writeFileSync(fakeCli, `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CALLS_FILE"
case "$*" in
  "--version") printf 'lark-cli version 1.0.64\n' ;;
  "profile list") printf '["profile-ready"]\n' ;;
  "--profile profile-ready auth status --json") printf '{"identities":{"user":{"available":true,"tokenStatus":"valid","scope":"scope:ready"}}}\n' ;;
  *" profile add "*|*" auth login "*) printf 'unexpected mutation\n' >&2; exit 97 ;;
esac
`)
  chmodSync(fakeCli, 0o755)

  const runProbe = (profile) => {
    const resultFile = path.join(root, `${profile}.json`)
    const binding = JSON.stringify({
      agent_type: 'codex',
      aamp_host: 'https://meshmail.ai',
      bot: { app_id: `cli_${profile}`, lark_cli_profile: profile },
    })
    const shell = [
      'set -euo pipefail',
      'exec 3>"$RESULT_FILE"',
      'exec 4<&0',
      'exec bash "$BOOTSTRAP" __probe-profile --agent codex --aamp-host https://meshmail.ai',
    ].join('\n')
    const result = spawnSync('bash', ['-c', shell], {
      input: `${binding}\n`,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...bootstrapBaseEnv,
        HOME: root,
        BOOTSTRAP: bootstrap,
        RESULT_FILE: resultFile,
        CALLS_FILE: callsFile,
        AAMP_TASK_DEFAULT_ACTION: 'help',
        AAMP_TASK_AUTO_UPDATE: 'false',
        AAMP_LARK_CLI_BIN: fakeCli,
        AAMP_LARK_CLI_CONFIG_DIR: path.join(root, 'lark-config'),
        NPM_CONFIG_CACHE: path.join(root, 'npm-cache'),
        NPM_GLOBAL_PREFIX: path.join(root, 'npm-global'),
        FEISHU_USER_AUTH_REQUIRED_SCOPES: 'scope:ready',
        FEISHU_USER_AUTH_EXCLUDES: '',
      },
    })
    assert.equal(result.status, 0, result.stderr)
    return {
      payload: JSON.parse(readFileSync(resultFile, 'utf8')),
      stdout: result.stdout,
      stderr: result.stderr,
    }
  }

  const hit = runProbe('profile-ready')
  const miss = runProbe('profile-missing')

  assert.deepEqual(hit.payload, {
    ready: true,
    lark_cli_bin: fakeCli,
    lark_cli_config_dir: path.join(root, 'lark-config'),
  })
  assert.deepEqual(miss.payload, { ready: false })
  const calls = readFileSync(callsFile, 'utf8')
  assert.doesNotMatch(calls, /profile add|auth login/)
  assert.doesNotMatch(
    `${calls}\n${hit.stdout}\n${hit.stderr}\n${miss.stdout}\n${miss.stderr}`,
    /open|prompt|是否|\[y\/n\]/i,
  )
})

test('internal profile probe does not install lark-cli when no existing candidate is available', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-profile-probe-no-cli-'))
  const binDir = path.join(root, 'bin')
  const callsFile = path.join(root, 'calls.log')
  const resultFile = path.join(root, 'result.json')
  const metadataFile = path.join(root, 'npm-global', 'lib/node_modules/@larktask/aamp-feishu-task-agent/bin/agent-metadata.mjs')
  mkdirSync(binDir)
  mkdirSync(path.dirname(metadataFile), { recursive: true })
  writeFileSync(metadataFile, readFileSync(path.resolve(__dirname, '../bin/agent-metadata.mjs')))
  writeFileSync(path.join(binDir, 'node'), `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} "$@"\n`)
  writeFileSync(path.join(binDir, 'npm'), '#!/usr/bin/env bash\nprintf "npm:%s\\n" "$*" >> "$CALLS_FILE"\nexit 97\n')
  writeFileSync(path.join(binDir, 'npx'), '#!/usr/bin/env bash\nprintf "npx:%s\\n" "$*" >> "$CALLS_FILE"\nexit 97\n')
  for (const executable of ['node', 'npm', 'npx']) chmodSync(path.join(binDir, executable), 0o755)
  const binding = JSON.stringify({
    agent_type: 'codex',
    aamp_host: 'https://meshmail.ai',
    bot: { app_id: 'cli_probe_no_cli', lark_cli_profile: 'profile-missing' },
  })
  const shell = [
    'set -euo pipefail',
    'exec 3>"$RESULT_FILE"',
    'exec 4<&0',
    'exec bash "$BOOTSTRAP" __probe-profile --agent codex --aamp-host https://meshmail.ai',
  ].join('\n')
  const result = spawnSync('bash', ['-c', shell], {
    input: `${binding}\n`,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...bootstrapBaseEnv,
      HOME: root,
      PATH: `${binDir}:/usr/bin:/bin`,
      BOOTSTRAP: bootstrap,
      RESULT_FILE: resultFile,
      CALLS_FILE: callsFile,
      AAMP_TASK_AUTO_UPDATE: 'false',
      AAMP_LARK_CLI_BIN: '',
      AAMP_LARK_CLI_CONFIG_DIR: path.join(root, 'lark-config'),
      NPM_CONFIG_CACHE: path.join(root, 'npm-cache'),
      NPM_GLOBAL_PREFIX: path.join(root, 'npm-global'),
    },
  })

  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(readFileSync(resultFile, 'utf8')), { ready: false })
  assert.equal(existsSync(callsFile), false, 'probe must never invoke npm or npx')
  assert.equal(existsSync(path.join(root, 'lark-config')), false, 'miss probe must not create config')
  assert.equal(existsSync(path.join(root, 'npm-cache')), false, 'probe must not create npm cache')
  assert.equal(existsSync(path.join(root, 'npm-global', 'bin')), false, 'probe must not install into the npm prefix')
})

test('internal Bot registration authenticates lark-cli and returns the user tenant before agent selection', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-register-before-agent-'))
  const bootstrapLib = path.join(root, 'bootstrap-functions.sh')
  const callsFile = path.join(root, 'calls.log')
  writeFileSync(bootstrapLib, readFileSync(bootstrap, 'utf8').replace(/\nmain "\$@"\n$/, '\n'))

  const shell = [
    'set -euo pipefail',
    'source "$BOOTSTRAP_LIB"',
    'AGENT=""',
    'AAMP_TASK_INTERNAL_RESULT_FD=3',
    'record() { printf "%s\\n" "$1" >> "$CALLS_FILE"; }',
    'agent_fail() { printf "%s\\n" "$*" >&2; exit 64; }',
    'agent_log() { :; }',
    'agent_detail() { :; }',
    'register_feishu_app() { record bot-registration; APP_ID=cli_remote; APP_SECRET=remote-secret-sentinel; BOT_NAME="Remote AIME"; APP_TENANT_BRAND="feishu"; LARK_CLI_PROFILE="profile-remote"; }',
    'lark_cli_user_tenant_key() { record tenant-lookup; printf "%s" "736588c9260f175d"; }',
    'exec 3>&1',
    'run_internal_register_binding',
  ].join('\n')
  const result = spawnSync('bash', ['-c', shell], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...bootstrapBaseEnv,
      HOME: root,
      BOOTSTRAP: bootstrap,
      BOOTSTRAP_LIB: bootstrapLib,
      CALLS_FILE: callsFile,
      NPM_GLOBAL_PREFIX: path.join(root, 'npm-global'),
      AAMP_TASK_AGENT_NAME: '@larktask/aamp-feishu-task-agent',
      AAMP_TASK_AUTO_UPDATE: 'false',
    },
  })

  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {
    app_id: 'cli_remote',
    app_secret: 'remote-secret-sentinel',
    display_name: 'Remote AIME',
    tenant_brand: 'feishu',
    tenant_key: '736588c9260f175d',
    lark_cli_profile: 'profile-remote',
    auth_mode: 'lark-cli',
  })
  assert.deepEqual(readFileSync(callsFile, 'utf8').trim().split('\n'), [
    'bot-registration',
    'tenant-lookup',
  ])
  assert.doesNotMatch(result.stderr, /remote-secret-sentinel/)
})

test('first-time CLI login stays visible and cannot contaminate the registered tenant key', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-visible-cli-login-'))
  const bootstrapLib = path.join(root, 'bootstrap-functions.sh')
  const resultFile = path.join(root, 'result.json')
  const lookupCountFile = path.join(root, 'lookup-count')
  writeFileSync(bootstrapLib, readFileSync(bootstrap, 'utf8').replace(/\nmain "\$@"\n$/, '\n'))
  writeFileSync(lookupCountFile, '0')

  const result = spawnSync('bash', ['-c', `
set -euo pipefail
source "$BOOTSTRAP_LIB"
AGENT=""
AAMP_TASK_INTERNAL_RESULT_FD=3
agent_fail() { printf '%s\\n' "$*" >&2; exit 64; }
agent_detail() { :; }
register_feishu_app() {
  APP_ID=cli_first_login
  APP_SECRET=first-login-secret
  BOT_NAME="First Login Bot"
  APP_TENANT_BRAND=feishu
  LARK_CLI_PROFILE=profile-first-login
}
lark_cli_user_tenant_key() {
  count="$(cat "$LOOKUP_COUNT_FILE")"
  count=$((count + 1))
  printf '%s' "$count" > "$LOOKUP_COUNT_FILE"
  [ "$count" -gt 1 ] || return 1
  printf '%s' '736588c9260f175d'
}
run_lark_cli_auth_login() { printf '%s\\n' '[auth] browser authorization is visible'; }
exec 3>"$RESULT_FILE"
run_internal_register_binding
`, 'bash'], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...bootstrapBaseEnv,
      HOME: root,
      BOOTSTRAP_LIB: bootstrapLib,
      RESULT_FILE: resultFile,
      LOOKUP_COUNT_FILE: lookupCountFile,
      AAMP_TASK_AUTO_UPDATE: 'false',
    },
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /正在登录飞书 CLI/)
  assert.match(result.stdout, /browser authorization is visible/)
  assert.equal(JSON.parse(readFileSync(resultFile, 'utf8')).tenant_key, '736588c9260f175d')
})

test('unknown CLI tenant hides AIME without blocking other agent selection', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-unknown-cli-tenant-'))
  const bootstrapLib = path.join(root, 'bootstrap-functions.sh')
  const resultFile = path.join(root, 'result.json')
  writeFileSync(bootstrapLib, readFileSync(bootstrap, 'utf8').replace(/\nmain "\$@"\n$/, '\n'))

  const result = spawnSync('bash', ['-c', `
set -euo pipefail
source "$BOOTSTRAP_LIB"
AGENT=""
AAMP_TASK_INTERNAL_RESULT_FD=3
agent_fail() { printf '%s\\n' "$*" >&2; exit 64; }
agent_detail() { :; }
register_feishu_app() {
  APP_ID=cli_unknown_tenant
  APP_SECRET=unknown-tenant-secret
  BOT_NAME="Unknown Tenant Bot"
  APP_TENANT_BRAND=feishu
  LARK_CLI_PROFILE=profile-unknown-tenant
}
lark_cli_user_tenant_key() { return 1; }
run_lark_cli_auth_login() { printf '%s\\n' '[auth] login completed'; }
exec 3>"$RESULT_FILE"
run_internal_register_binding
`, 'bash'], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...bootstrapBaseEnv,
      HOME: root,
      BOOTSTRAP_LIB: bootstrapLib,
      RESULT_FILE: resultFile,
      AAMP_TASK_AUTO_UPDATE: 'false',
    },
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /无法识别当前租户.*隐藏 AIME/)
  assert.equal(JSON.parse(readFileSync(resultFile, 'utf8')).tenant_key, '')
})

test('lark-cli tenant lookup returns only tenant_key from the authenticated profile', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-lark-tenant-key-'))
  const binDir = path.join(root, 'bin')
  const callsFile = path.join(root, 'calls.log')
  mkdirSync(binDir)
  writeFileSync(path.join(binDir, 'lark-cli'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$CALLS_FILE"
printf '%s\\n' '{"code":0,"msg":"success","data":{"name":"Private User","open_id":"ou_private","tenant_key":"736588c9260f175d"}}'
`)
  chmodSync(path.join(binDir, 'lark-cli'), 0o755)
  const source = readFileSync(bootstrap, 'utf8')
  const start = source.indexOf('lark_cli_user_auth_satisfied()')
  const end = source.indexOf('\nforget_current_bot_after_feishu_start_failure()', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)

  const result = spawnSync('bash', ['-c', `
set -euo pipefail
LARK_CLI_CMD="$1/bin/lark-cli"
CALLS_FILE="$2"
export CALLS_FILE
${source.slice(start, end)}
lark_cli_user_tenant_key profile-current
`, 'bash', root, callsFile], { encoding: 'utf8', timeout: 10_000 })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '736588c9260f175d')
  const invocation = readFileSync(callsFile, 'utf8')
  assert.match(invocation, /--profile profile-current api GET \/open-apis\/authen\/v1\/user_info --as user/)
  assert.doesNotMatch(result.stdout, /Private User|ou_private/)
})

test('app registration preserves the SDK tenant brand and uses its OpenAPI domain', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-register-tenant-brand-'))
  const bootstrapLib = path.join(root, 'bootstrap-functions.sh')
  const fakeSdkDir = path.join(root, 'fake-sdk')
  const clientOptionsFile = path.join(root, 'client-options.json')
  const registerOptionsFile = path.join(root, 'register-options.json')
  mkdirSync(fakeSdkDir, { recursive: true })
  writeFileSync(bootstrapLib, readFileSync(bootstrap, 'utf8').replace(/\nmain "\$@"\n$/, '\n'))
  writeFileSync(path.join(fakeSdkDir, 'package.json'), JSON.stringify({
    name: '@larksuiteoapi/node-sdk',
    version: 'test-sdk',
    type: 'module',
    main: './index.js',
  }))
  writeFileSync(path.join(fakeSdkDir, 'index.js'), `
import { writeFileSync } from 'node:fs'
export const Domain = { Feishu: 'feishu-domain', Lark: 'lark-domain' }
export async function registerApp(options) {
  if (process.env.REGISTER_OPTIONS_FILE) {
    writeFileSync(process.env.REGISTER_OPTIONS_FILE, JSON.stringify(options))
  }
  if (process.env.FAKE_REGISTER_MODE === 'domain-switch'
    || process.env.FAKE_REGISTER_MODE === 'explicit-feishu-after-switch') {
    options.onStatusChange?.({ status: 'domain_switched' })
  }
  const tenantBrand = process.env.FAKE_REGISTER_MODE === 'domain-switch'
    ? undefined
    : process.env.FAKE_REGISTER_MODE === 'explicit-feishu-after-switch'
      ? 'feishu'
      : process.env.FAKE_REGISTER_MODE === 'invalid-brand'
        ? 'unknown'
        : 'lark'
  return {
    client_id: 'cli_lark_registration',
    client_secret: 'registration-secret-sentinel',
    user_info: { open_id: 'ou_test', ...(tenantBrand ? { tenant_brand: tenantBrand } : {}) },
  }
}
export class Client {
  constructor(options) {
    writeFileSync(process.env.CLIENT_OPTIONS_FILE, JSON.stringify(options))
    this.application = {
      application: {
        get: async () => ({ data: { app: { app_name: 'Lark Registration' } } }),
      },
    }
  }
}
`)

  for (const mode of ['user-info', 'domain-switch']) {
    const result = spawnSync('bash', ['-c', `
set -euo pipefail
source "$BOOTSTRAP_LIB"
AAMP_TASK_INTERNAL="true"
AGENT=""
AGENT_EXECUTION_LOCATION="remote"
initialize_feishu_scope_manifest() { :; }
npm_install_register_helper() {
  mkdir -p "$1/node_modules/@larksuiteoapi/node-sdk"
  cp -R "$FAKE_SDK_DIR/." "$1/node_modules/@larksuiteoapi/node-sdk/"
}
agent_detail() { :; }
agent_log() { :; }
agent_fail() { printf '%s\\n' "$*" >&2; exit 1; }
register_feishu_app
printf '%s\\n' "$APP_ID|$BOT_NAME|$APP_TENANT_BRAND"
`, 'bash'], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...bootstrapBaseEnv,
        HOME: root,
        BOOTSTRAP_LIB: bootstrapLib,
        FAKE_SDK_DIR: fakeSdkDir,
        CLIENT_OPTIONS_FILE: clientOptionsFile,
        REGISTER_OPTIONS_FILE: registerOptionsFile,
        FAKE_REGISTER_MODE: mode,
        AAMP_TASK_AUTO_UPDATE: 'false',
      },
    })

    assert.equal(result.status, 0, `${mode}: ${result.stderr}`)
    assert.equal(result.stdout.trim(), 'cli_lark_registration|Lark Registration|lark', mode)
    assert.deepEqual(JSON.parse(readFileSync(clientOptionsFile, 'utf8')), {
      appId: 'cli_lark_registration',
      appSecret: 'registration-secret-sentinel',
      domain: 'lark-domain',
    }, mode)
    assert.equal(JSON.parse(readFileSync(registerOptionsFile, 'utf8')).appPreset.name, 'AAMP 飞书 CLI', mode)
  }

  const explicitFeishu = spawnSync('bash', ['-c', `
set -euo pipefail
source "$BOOTSTRAP_LIB"
AAMP_TASK_INTERNAL="true"
AGENT="codex"
AGENT_EXECUTION_LOCATION="remote"
initialize_feishu_scope_manifest() { :; }
npm_install_register_helper() {
  mkdir -p "$1/node_modules/@larksuiteoapi/node-sdk"
  cp -R "$FAKE_SDK_DIR/." "$1/node_modules/@larksuiteoapi/node-sdk/"
}
agent_detail() { :; }
agent_log() { :; }
agent_fail() { printf '%s\\n' "$*" >&2; exit 1; }
register_feishu_app
printf '%s\\n' "$APP_ID|$BOT_NAME|$APP_TENANT_BRAND"
`, 'bash'], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...bootstrapBaseEnv,
      HOME: root,
      BOOTSTRAP_LIB: bootstrapLib,
      FAKE_SDK_DIR: fakeSdkDir,
      CLIENT_OPTIONS_FILE: clientOptionsFile,
      FAKE_REGISTER_MODE: 'explicit-feishu-after-switch',
      AAMP_TASK_AUTO_UPDATE: 'false',
    },
  })
  assert.equal(explicitFeishu.status, 0, explicitFeishu.stderr)
  assert.equal(explicitFeishu.stdout.trim(), 'cli_lark_registration|Lark Registration|feishu')
  assert.equal(JSON.parse(readFileSync(clientOptionsFile, 'utf8')).domain, 'feishu-domain')

  const invalidBrand = spawnSync('bash', ['-c', `
set -euo pipefail
source "$BOOTSTRAP_LIB"
AAMP_TASK_INTERNAL="true"
AGENT="codex"
AGENT_EXECUTION_LOCATION="remote"
initialize_feishu_scope_manifest() { :; }
npm_install_register_helper() {
  mkdir -p "$1/node_modules/@larksuiteoapi/node-sdk"
  cp -R "$FAKE_SDK_DIR/." "$1/node_modules/@larksuiteoapi/node-sdk/"
}
agent_detail() { :; }
agent_log() { :; }
agent_fail() { printf '%s\\n' "$*" >&2; exit 1; }
register_feishu_app
`, 'bash'], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...bootstrapBaseEnv,
      HOME: root,
      BOOTSTRAP_LIB: bootstrapLib,
      FAKE_SDK_DIR: fakeSdkDir,
      CLIENT_OPTIONS_FILE: clientOptionsFile,
      FAKE_REGISTER_MODE: 'invalid-brand',
      AAMP_TASK_AUTO_UPDATE: 'false',
    },
  })
  assert.notEqual(invalidBrand.status, 0)
  assert.match(invalidBrand.stderr, /unsupported tenant brand: unknown/)
})

test('remote AIME profile actions reject before touching a retained legacy profile sentinel', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-aime-legacy-profile-'))
  const prefix = path.join(root, 'npm-global')
  const metadataFile = path.join(prefix, 'lib/node_modules/@larktask/aamp-feishu-task-agent/bin/agent-metadata.mjs')
  const configDir = path.join(root, 'legacy-lark-config')
  const profileFile = path.join(configDir, 'profiles', 'aime-legacy-profile.json')
  const larkCliLog = path.join(root, 'lark-cli.log')
  const fakeLarkCli = path.join(root, 'bin', 'lark-cli')
  const sentinel = Buffer.from('{"legacy":"aime-profile-sentinel"}\n')
  mkdirSync(path.dirname(metadataFile), { recursive: true })
  mkdirSync(path.dirname(profileFile), { recursive: true })
  mkdirSync(path.dirname(fakeLarkCli), { recursive: true })
  writeFileSync(metadataFile, readFileSync(path.resolve(__dirname, '../bin/agent-metadata.mjs')))
  writeFileSync(profileFile, sentinel, { mode: 0o640 })
  chmodSync(profileFile, 0o640)
  writeFileSync(fakeLarkCli, '#!/usr/bin/env bash\nprintf "called:%s\\n" "$*" >> "$LARK_CLI_LOG"\n')
  chmodSync(fakeLarkCli, 0o755)
  const originalMode = statSync(profileFile).mode & 0o777
  const binding = JSON.stringify({
    agent_type: 'aime',
    aamp_host: 'https://meshmail.ai',
    bot: {
      app_id: 'cli_aime_legacy',
      app_secret: 'legacy-secret-not-used',
      lark_cli_profile: 'aime-legacy-profile',
    },
  })

  for (const action of ['__probe-profile', '__ensure-profile']) {
    const resultFile = path.join(root, `${action}.json`)
    const shell = [
      'set -euo pipefail',
      'exec 3>"$RESULT_FILE"',
      'exec 4<&0',
      'exec bash "$BOOTSTRAP" "$ACTION" --agent aime --aamp-host https://meshmail.ai',
    ].join('\n')
    const result = spawnSync('bash', ['-c', shell], {
      input: `${binding}\n`,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...bootstrapBaseEnv,
        HOME: root,
        PATH: `${path.dirname(fakeLarkCli)}:${process.env.PATH}`,
        BOOTSTRAP: bootstrap,
        ACTION: action,
        RESULT_FILE: resultFile,
        NPM_GLOBAL_PREFIX: prefix,
        AAMP_TASK_AGENT_NAME: '@larktask/aamp-feishu-task-agent',
        AAMP_LARK_CLI_BIN: fakeLarkCli,
        AAMP_LARK_CLI_CONFIG_DIR: configDir,
        LARK_CLI_LOG: larkCliLog,
        AAMP_TASK_AUTO_UPDATE: 'false',
      },
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /remote bindings do not use lark-cli profiles/)
    assert.deepEqual(readFileSync(profileFile), sentinel)
    assert.equal(statSync(profileFile).mode & 0o777, originalMode)
  }
  assert.equal(existsSync(larkCliLog), false, 'remote profile actions must not probe or ensure lark-cli')
})

test('bootstrap does not detect Grok agent as Cursor', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const start = source.indexOf('is_cursor_agent_cli()')
  const end = source.indexOf('\nresolve_cursor_cli_for_acp()')
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)

  const helpers = source.slice(start, end)
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-bootstrap-grok-agent-'))
  const binDir = path.join(home, 'bin')
  mkdirSync(binDir)
  writeFileSync(path.join(binDir, 'agent'), `#!/usr/bin/env bash
printf 'grok 0.2.101 (5bc4b5dfadcf) [stable]\\n'
`)
  chmodSync(path.join(binDir, 'agent'), 0o755)

  const result = spawnSync('bash', ['-c', `
set -euo pipefail
PATH="$1/bin:/usr/bin:/bin"
CURSOR_LOCAL_BIN="$1/missing-cursor-bin"
${helpers}
find_cursor_agent_cli
`, 'bash', home], { encoding: 'utf8' })

  assert.notEqual(result.status, 0)
  assert.equal(result.stdout, '')
})

test('bootstrap prefers cursor-agent over a generic agent command', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const start = source.indexOf('is_cursor_agent_cli()')
  const end = source.indexOf('\nresolve_cursor_cli_for_acp()')
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)

  const helpers = source.slice(start, end)
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-bootstrap-cursor-agent-'))
  const binDir = path.join(home, 'bin')
  mkdirSync(binDir)
  writeFileSync(path.join(binDir, 'agent'), `#!/usr/bin/env bash
printf 'grok 0.2.101 (5bc4b5dfadcf) [stable]\\n'
`)
  writeFileSync(path.join(binDir, 'cursor-agent'), `#!/usr/bin/env bash
printf '2026.07.01-41b2de7\\n'
`)
  chmodSync(path.join(binDir, 'agent'), 0o755)
  chmodSync(path.join(binDir, 'cursor-agent'), 0o755)

  const output = execFileSync('bash', ['-c', `
set -euo pipefail
PATH="$1/bin:/usr/bin:/bin"
CURSOR_LOCAL_BIN="$1/missing-cursor-bin"
${helpers}
find_cursor_agent_cli
`, 'bash', home], { encoding: 'utf8' })

  assert.equal(output.trim(), path.join(binDir, 'cursor-agent'))
})

test('bootstrap separates Trae CLI Next, internal Coco, and external TraeCode discovery', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const start = source.indexOf('resolve_trae_cli_candidate()')
  const end = source.indexOf('\nresolve_cursor_cli_for_acp()', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)

  const helpers = source.slice(start, end)
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-bootstrap-trae-cli-split-'))
  const binDir = path.join(home, 'bin')
  mkdirSync(binDir)
  for (const name of ['traecli', 'coco', 'traex']) {
    writeFileSync(path.join(binDir, name), '#!/usr/bin/env bash\nexit 0\n')
    chmodSync(path.join(binDir, name), 0o755)
  }

  const output = execFileSync('bash', ['-c', `
set -euo pipefail
PATH="$1/bin:/usr/bin:/bin"
AAMP_TRAE_CLI_BIN=""
AAMP_TRAECODE_CLI_BIN=""
TRAE_CLI_BIN=""
TRAECODE_CLI_BIN=""
${helpers}
find_traex_cli
find_legacy_trae_cli
find_traecode_cli
AGENT=traex
TRAE_CLI_BIN=""
resolve_trae_cli
AGENT=coco
TRAE_CLI_BIN=""
resolve_trae_cli
AGENT=traecli
TRAECODE_CLI_BIN=""
resolve_trae_cli
`, 'bash', home], { encoding: 'utf8' })

  assert.deepEqual(output.trim().split('\n'), [
    path.join(binDir, 'traex'),
    path.join(binDir, 'coco'),
    path.join(binDir, 'traecli'),
    path.join(binDir, 'traex'),
    path.join(binDir, 'coco'),
    path.join(binDir, 'traecli'),
  ])
})

test('bootstrap keeps a stuck Trae CLI Next（内部版） login status bounded without falling back to legacy CLI', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const start = source.indexOf('resolve_trae_cli_candidate()')
  const end = source.indexOf('\nprint_cursor_gatekeeper_help()', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)

  const helpers = source.slice(start, end)
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-bootstrap-traex-status-stuck-'))
  const binDir = path.join(home, 'bin')
  const calls = path.join(home, 'legacy-calls.log')
  mkdirSync(binDir)
  writeFileSync(path.join(binDir, 'traex'), `#!${process.execPath}
setTimeout(() => {}, 60_000)
`)
  writeFileSync(path.join(binDir, 'traecli'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(calls)}
if [ "$1" = "login" ] && [ "$2" = "status" ]; then
  exit 0
fi
exit 1
`)
  chmodSync(path.join(binDir, 'traex'), 0o755)
  chmodSync(path.join(binDir, 'traecli'), 0o755)

  const result = spawnSync('bash', ['-c', `
set -euo pipefail
PATH="$1/bin:${path.dirname(process.execPath)}:/usr/bin:/bin"
AAMP_TRAE_CLI_BIN=""
AAMP_TRAE_LOGIN_STATUS_TIMEOUT_SECONDS=1
AGENT=traex
TRAE_CLI_BIN=""
agent_detail() { printf '[detail] %s\\n' "$*"; }
agent_log() { printf '[log] %s\\n' "$*"; }
${helpers}
set +e
run_traex_login_status
status=$?
set -e
printf 'status=%s\\nselected=%s\\n' "$status" "$(resolve_trae_cli)"
`, 'bash', home], { encoding: 'utf8', timeout: 5000 })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /status=124/)
  assert.match(result.stdout, new RegExp(`selected=${path.join(binDir, 'traex').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.equal(existsSync(calls), false)
})

test('successful Trae login status probe stays quiet while recording diagnostics', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const loggingStart = source.indexOf('write_one_click_log()')
  const loggingEnd = source.indexOf('\nrecord_version_line()', loggingStart)
  const loginStart = source.indexOf('run_quiet_command_with_timeout()')
  const loginEnd = source.indexOf('\nrun_traex_login()', loginStart)
  assert.notEqual(loggingStart, -1)
  assert.notEqual(loggingEnd, -1)
  assert.notEqual(loginStart, -1)
  assert.notEqual(loginEnd, -1)

  const root = mkdtempSync(path.join(tmpdir(), 'aamp-traex-status-quiet-'))
  const fakeTrae = path.join(root, 'traex')
  const logFile = path.join(root, 'one-click.log')
  writeFileSync(fakeTrae, '#!/usr/bin/env bash\nexit 0\n')
  chmodSync(fakeTrae, 0o755)

  const result = spawnSync('bash', ['-c', `
set -euo pipefail
PATH="$1:${path.dirname(process.execPath)}:/usr/bin:/bin"
ONE_CLICK_LOG="$2"
AAMP_ONE_CLICK_VERBOSE="false"
AAMP_TRAE_LOGIN_STATUS_TIMEOUT_SECONDS=5
TRAE_CLI_BIN=""
FAKE_TRAE="$3"
find_traex_cli() { printf '%s\\n' "$FAKE_TRAE"; }
${source.slice(loggingStart, loggingEnd)}
${source.slice(loginStart, loginEnd)}
run_traex_login_status
`, 'bash', path.dirname(fakeTrae), logFile, fakeTrae], { encoding: 'utf8' })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '')
  assert.match(readFileSync(logFile, 'utf8'), /checking Trae CLI login status/)
})

test('bootstrap returns structured cancellation when Coco upgrade is declined', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const start = source.indexOf('resolve_trae_cli_candidate()')
  const end = source.indexOf('\nprint_cursor_gatekeeper_help()', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)

  const loginStart = source.indexOf('ensure_agent_login()')
  const loginEnd = source.indexOf('\nrun_acp_bridge()', loginStart)
  const prepareStart = source.indexOf('run_internal_prepare_agent()')
  const prepareEnd = source.indexOf('\nrun_internal_ensure_profile()', prepareStart)
  assert.notEqual(loginStart, -1)
  assert.notEqual(loginEnd, -1)
  assert.notEqual(prepareStart, -1)
  assert.notEqual(prepareEnd, -1)

  const helpers = source.slice(start, end) + '\n' + source.slice(loginStart, loginEnd) + '\n' + source.slice(prepareStart, prepareEnd)
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-bootstrap-legacy-trae-decline-'))
  const binDir = path.join(home, 'bin')
  const calls = path.join(home, 'calls.log')
  const unexpected = path.join(home, 'unexpected.log')
  mkdirSync(binDir)
  writeFileSync(path.join(binDir, 'coco'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(calls)}
exit 72
`)
  chmodSync(path.join(binDir, 'coco'), 0o755)

  const result = spawnSync('bash', ['-c', `
set -euo pipefail
PATH="$1/bin:/usr/bin:/bin"
TEST_HOME="$1"
AAMP_TRAE_CLI_BIN=""
AAMP_TRAE_LOGIN_STATUS_TIMEOUT_SECONDS=5
TRAEX_INSTALLER_URL="https://code.byted.org/api/tos-proxy/download/traex_install.sh"
AGENT=coco
TRAE_CLI_BIN=""
AGENT_PREPARE_CANCELLED="false"
AGENT_PREPARE_CANCEL_REASON=""
agent_detail() { :; }
agent_log() { :; }
agent_fail() { printf '%s\\n' "$*" >&2; exit 1; }
clear_codex_quarantine() { :; }
clear_cursor_quarantine() { :; }
${helpers}
confirm_trae_upgrade() { return 1; }
run_traex_installer() { printf 'unexpected installer\\n' >&2; return 1; }
prepare_internal_agent_environment() { :; }
ensure_codex_cli_updated() { :; }
maybe_mock_fail() { :; }
ensure_acpx() { touch "$TEST_HOME/unexpected.log"; }
build_acp_agent_command() { touch "$TEST_HOME/unexpected.log"; }
emit_internal_result() { printf '%s\\n' "$1"; }
json_escape() { printf '%s' "$1"; }
run_internal_prepare_agent
`, 'bash', home], { encoding: 'utf8', timeout: 5000 })

  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout.trim())
  assert.equal(payload.cancelled, true)
  assert.equal(payload.agent_type, 'coco')
  assert.match(payload.reason, /飞书任务 Agent 暂不支持使用 Trae CLI（内部版）建立连接/)
  assert.match(payload.reason, /本次未启动飞书任务连接/)
  assert.match(payload.reason, /Trae CLI Next（内部版）/)
  assert.doesNotMatch(payload.reason, /ACP|login|TUI/)
  assert.equal(Object.hasOwn(payload, 'acp_command'), false)
  assert.equal(existsSync(calls), false)
  assert.equal(existsSync(unexpected), false)
})

test('bootstrap can upgrade Coco to traex and continue with the traex ACP command', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const start = source.indexOf('resolve_trae_cli_candidate()')
  const end = source.indexOf('\nprint_cursor_gatekeeper_help()', start)
  const loginStart = source.indexOf('ensure_agent_login()')
  const loginEnd = source.indexOf('\nrun_acp_bridge()', loginStart)
  const commandStart = source.indexOf('build_acp_agent_command()')
  const commandEnd = source.indexOf('\nvalidate_codex_acp_command()', commandStart)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  assert.notEqual(loginStart, -1)
  assert.notEqual(loginEnd, -1)
  assert.notEqual(commandStart, -1)
  assert.notEqual(commandEnd, -1)

  const helpers = source.slice(start, end) + '\n' + source.slice(loginStart, loginEnd) + '\n' + source.slice(commandStart, commandEnd)
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-bootstrap-legacy-trae-upgrade-'))
  const binDir = path.join(home, 'bin')
  mkdirSync(binDir)
  writeFileSync(path.join(binDir, 'coco'), '#!/usr/bin/env bash\nexit 72\n')
  chmodSync(path.join(binDir, 'coco'), 0o755)

  const result = spawnSync('bash', ['-c', `
set -euo pipefail
PATH="$1/bin:${path.dirname(process.execPath)}:/usr/bin:/bin"
TEST_BIN_DIR="$1/bin"
AAMP_TRAE_CLI_BIN=""
AAMP_TRAE_LOGIN_STATUS_TIMEOUT_SECONDS=5
AGENT=coco
TRAE_CLI_BIN=""
agent_detail() { :; }
agent_log() { printf '[log] %s\\n' "$*"; }
agent_fail() { printf '%s\\n' "$*" >&2; exit 1; }
clear_codex_quarantine() { :; }
clear_cursor_quarantine() { :; }
${helpers}
confirm_trae_upgrade() { return 0; }
run_traex_installer() {
  printf '%s\\n' '#!/usr/bin/env bash' 'exit 0' > "$TEST_BIN_DIR/traex"
  chmod +x "$TEST_BIN_DIR/traex"
}
ensure_agent_login
build_acp_agent_command
printf 'agent=%s\\ncommand=%s\\n' "$AGENT" "$ACP_AGENT_COMMAND"
`, 'bash', home], { encoding: 'utf8', timeout: 5000 })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /agent=traex/)
  assert.match(result.stdout, new RegExp(`command=${path.join(binDir, 'traex').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} acp serve`))
})

test('non-interactive agent preparation never launches a Codex login flow', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const helperStart = source.indexOf('ensure_interactive_agent_recovery_allowed()')
  const helperEnd = source.indexOf('\nrun_acp_bridge()', helperStart)
  assert.notEqual(helperStart, -1)
  assert.notEqual(helperEnd, -1)
  const helpers = source.slice(helperStart, helperEnd)
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-codex-non-interactive-login-'))
  const loginMarker = path.join(root, 'login-called')

  const result = spawnSync('bash', ['-c', `
set -euo pipefail
AGENT=codex
AAMP_TASK_NON_INTERACTIVE=true
LOGIN_MARKER="$1"
agent_detail() { :; }
agent_log() { :; }
agent_fail() { printf '%s\\n' "$*" >&2; exit 64; }
clear_codex_quarantine() { :; }
run_codex_login_status() { return 1; }
run_codex_login() { touch "$LOGIN_MARKER"; return 0; }
${helpers}
ensure_agent_login
`, 'bash', loginMarker], { encoding: 'utf8', timeout: 5000 })

  assert.equal(result.status, 64)
  assert.match(result.stderr, /后台服务无法完成交互式准备.*feishu-task-agent start/)
  assert.equal(existsSync(loginMarker), false)
})

test('bootstrap help owns log commands and success output stays concise', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const controller = readFileSync(path.resolve(__dirname, '../bin/feishu-task-agent-controller.mjs'), 'utf8')
  const usageStart = source.indexOf('usage()')
  const usageEnd = source.indexOf('\nwrite_one_click_log()', usageStart)
  const usage = source.slice(usageStart, usageEnd)
  const successStart = source.indexOf('agent_success()')
  const successEnd = source.indexOf('\nagent_fail()', successStart)
  const success = source.slice(successStart, successEnd)

  assert.match(source, /--mock-fail-stage/)
  assert.match(source, /AAMP_ONE_CLICK_MOCK_FAIL_STAGE/)
  assert.match(source, /print_local_log_hints/)
  assert.match(usage, /日志命令/)
  assert.match(usage, /aamp-logs list-runs/)
  assert.match(usage, /aamp-logs collect --run-dir/)
  assert.match(usage, /aamp-logs collect --task-id xxx/)
  assert.match(usage, /aamp-logs collect --task-guid yyy/)
  assert.match(success, /🟢 保持终端打开，你可以给 agent 派发飞书任务/)
  assert.doesNotMatch(success, /print_local_log_hints/)
  assert.match(controller, /🟢 保持终端打开，你可以给 agent 派发飞书任务/)
  assert.match(controller, /\[aamp-one-click\] 启动成功：\$\{bindingLabel\(binding, runtimeAgentType\)\}/)
  assert.equal(controller.match(/printBindingStarted\(/g)?.length, 4)
  assert.doesNotMatch(controller, /已接入飞书任务，可以开始对话 & 派发任务/)
  assert.doesNotMatch(controller, /飞书 Bot：/)
  assert.doesNotMatch(controller, /保持此终端打开；按 Ctrl\+C 停止本次启动的本地连接。/)
  assert.equal(controller.match(/printLogHints\(true\)/g)?.length, 1)
  assert.doesNotMatch(source, /近期日志打包/)
  assert.match(source, /aamp-logs/)
  assert.match(source, /errors\.jsonl/)
  assert.match(source, /已接入飞书任务，可以开始对话 & 派发任务/)
  assert.match(source, /运行失败，本地飞书任务连接没有启动成功/)
  assert.match(source, /AAMP_ONE_CLICK_VERBOSE/)
})

test('bootstrap failure UX prints friendly log hints', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const start = source.indexOf('write_one_click_log()')
  const end = source.indexOf('\nwrite_run_manifest()')
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)

  const helpers = source.slice(start, end)
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-bootstrap-failure-'))
  const result = spawnSync('bash', ['-c', `
set -euo pipefail
AAMP_RUN_LOG_DIR="$1/run"
AAMP_LOGS_BIN="$1/bin/aamp-logs"
AAMP_TASK_INTERNAL=false
ONE_CLICK_LOG="$1/one-click.log"
ERRORS_LOG="$1/errors.jsonl"
mkdir -p "$AAMP_RUN_LOG_DIR" "$(dirname "$AAMP_LOGS_BIN")"
${helpers}
agent_fail "测试失败"
`, 'bash', home], { encoding: 'utf8' })

  assert.equal(result.status, 1)
  const stderr = result.stderr
  assert.match(stderr, /运行失败，本地飞书任务连接没有启动成功/)
  assert.match(stderr, /原因：测试失败/)
  assert.match(stderr, /运行日志目录：/)
  assert.match(stderr, /运行日志打包：.* collect --run-dir .*\/run/)
  assert.match(stderr, /特定任务日志打包：.* collect --task-id xxx/)
  assert.match(stderr, /特定任务日志打包：.* collect --task-guid yyy/)
})

test('bootstrap mock failure stages use friendly failure UX', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const start = source.indexOf('write_one_click_log()')
  const end = source.indexOf('\nwrite_run_manifest()')
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)

  const helpers = source.slice(start, end)
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-bootstrap-mock-failure-'))
  const result = spawnSync('bash', ['-c', `
set -euo pipefail
AAMP_RUN_LOG_DIR="$1/run"
AAMP_LOGS_BIN="$1/bin/aamp-logs"
AAMP_TASK_INTERNAL=false
AAMP_ONE_CLICK_MOCK_FAIL_STAGE="agent-login"
ONE_CLICK_LOG="$1/one-click.log"
ERRORS_LOG="$1/errors.jsonl"
mkdir -p "$AAMP_RUN_LOG_DIR" "$(dirname "$AAMP_LOGS_BIN")"
${helpers}
validate_mock_fail_stage
maybe_mock_fail "node-toolchain"
maybe_mock_fail "agent-login"
`, 'bash', home], { encoding: 'utf8' })

  assert.equal(result.status, 1)
  const stderr = result.stderr
  assert.match(stderr, /运行失败，本地飞书任务连接没有启动成功/)
  assert.match(stderr, /原因：模拟启动失败：agent-login/)
  assert.match(stderr, /运行日志打包：.* collect --run-dir .*\/run/)
  assert.match(stderr, /特定任务日志打包：.* collect --task-id xxx/)
  assert.match(stderr, /特定任务日志打包：.* collect --task-guid yyy/)

  const mockStageList = source.match(/node-toolchain\|agent-login\|feishu-bot\|agent-bridge\|feishu-bridge/)?.[0] ?? ''
  assert.equal(mockStageList.split('|').length, 5)
})

test('bootstrap accepts lark-cli user auth token that needs refresh', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const start = source.indexOf('lark_cli_user_auth_satisfied()')
  const end = source.indexOf('\nnormalize_lark_cli_auth_excludes()')
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)

  const helpers = source.slice(start, end)
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-bootstrap-auth-status-'))
  const binDir = path.join(home, 'bin')
  const statusFile = path.join(home, 'auth-status.json')
  execFileSync('mkdir', ['-p', binDir])
  writeFileSync(path.join(binDir, 'lark-cli'), `#!/usr/bin/env bash
if [ "$1" = "--profile" ] && [ "$3" = "auth" ] && [ "$4" = "status" ]; then
  cat "$LARK_STATUS_FILE"
  exit 0
fi
exit 1
`)
  chmodSync(path.join(binDir, 'lark-cli'), 0o755)
  writeFileSync(statusFile, JSON.stringify({
    identities: {
      user: {
        available: true,
        tokenStatus: 'needs_refresh',
        scope: 'im:message task:task',
      },
    },
  }))

  const output = execFileSync('bash', ['-c', `
set -euo pipefail
PATH="$1/bin:$PATH"
export LARK_STATUS_FILE="$2"
FEISHU_USER_AUTH_REQUIRED_SCOPES="im:message task:task"
FEISHU_USER_AUTH_EXCLUDES=""
agent_log() { printf '%s\\n' "$*"; }
${helpers}
lark_cli_user_auth_satisfied test-profile
printf 'ok\\n'
`, 'bash', home, statusFile], { encoding: 'utf8' })

  assert.equal(output, 'ok\n')
})

test('scope manifest defaults to tenant-safe Task and IM capabilities', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const start = source.indexOf('feishu_scope_manifest_json()')
  const end = source.indexOf('\nlark_cli_user_auth_satisfied()', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)

  const helpers = source.slice(start, end)
  const output = execFileSync('bash', ['-c', `
set -euo pipefail
FEISHU_SCOPE_MANIFEST_VERSION=""
FEISHU_APP_SCOPES_TENANT=""
FEISHU_APP_SCOPES_USER=""
FEISHU_USER_AUTH_CORE_SCOPES=""
FEISHU_USER_AUTH_OPTIONAL_SCOPES=""
FEISHU_USER_AUTH_REQUIRED_SCOPES=""
FEISHU_USER_AUTH_REQUESTED_SCOPES=""
${helpers}
initialize_feishu_scope_manifest
node -e '
process.stdout.write(JSON.stringify({
  version: process.env.FEISHU_SCOPE_MANIFEST_VERSION,
  tenant: process.env.FEISHU_APP_SCOPES_TENANT.split(",").filter(Boolean),
  user: process.env.FEISHU_APP_SCOPES_USER.split(",").filter(Boolean),
  core: process.env.FEISHU_USER_AUTH_CORE_SCOPES.split(/\\s+/).filter(Boolean),
  optional: process.env.FEISHU_USER_AUTH_OPTIONAL_SCOPES.split(/\\s+/).filter(Boolean),
}));
'
`], { encoding: 'utf8' })
  const manifest = JSON.parse(output)

  assert.equal(manifest.version, '2')
  assert.equal(manifest.tenant.includes('im:message:send_as_bot'), true)
  assert.equal(manifest.tenant.includes('task:task:write'), true)
  assert.equal(manifest.tenant.includes('task:attachment:write'), true)
  assert.equal(manifest.user.includes('task:task:read'), true)
  assert.deepEqual(manifest.core, [])
  assert.equal(manifest.optional.includes('task:task:read'), true)

  const requested = new Set([...manifest.tenant, ...manifest.user, ...manifest.core, ...manifest.optional])
  const unsupportedGrayScopes = [
    'task:attachment:delete',
    'task:attachment:file:download',
    'task:attachment:upload',
    'task:comment:delete',
    'task:comment:writeonly',
    'task:task:delete',
    'task:tasklist:delete',
    'task:tasklist:writeonly',
    'vc:meeting.realtime:read',
  ]
  for (const scope of unsupportedGrayScopes) assert.equal(requested.has(scope), false, scope)
  for (const scope of requested) {
    assert.doesNotMatch(scope, /^(?:base|calendar|mail|minutes|vc|wiki):/, scope)
  }
})

test('saving a legacy bot profile migrates it to the Task-only manifest', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const start = source.indexOf('save_bot_config()')
  const end = source.indexOf('\nremove_bot_config()', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)

  const helpers = source.slice(start, end)
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-profile-manifest-migration-'))
  const configFile = path.join(home, 'task-profiles-v2.json')
  writeFileSync(configFile, JSON.stringify({
    version: 1,
    profiles: [{
      app_id: 'cli_task',
      profile: 'profile-task',
      auth_mode: 'lark-cli',
      capabilities: ['im', 'task'],
      domains: ['base', 'calendar', 'mail', 'task', 'vc'],
    }],
  }))

  execFileSync('bash', ['-c', `
set -euo pipefail
BOT_CONFIG_FILE="$1"
FEISHU_USER_AUTH_DOMAINS="base,calendar,mail,task,vc"
FEISHU_TASK_PROFILE_DOMAINS="task"
FEISHU_SCOPE_MANIFEST_VERSION="2"
FEISHU_USER_AUTH_MODE="optional"
${helpers}
save_bot_config "Task Bot" cli_task profile-task secret
`, 'bash', configFile])

  const saved = JSON.parse(readFileSync(configFile, 'utf8')).profiles[0]
  assert.deepEqual(saved.domains, ['task'])
  assert.equal(saved.scope_manifest_version, 2)
  assert.equal(saved.user_auth_mode, 'optional')
})

test('creating a Lark profile passes the tenant brand to lark-cli', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const start = source.indexOf('feishu_scope_manifest_json()')
  const end = source.indexOf('\nforget_current_bot_after_feishu_start_failure()', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)

  const helpers = source.slice(start, end)
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-lark-profile-brand-'))
  const fakeCli = path.join(home, 'lark-cli')
  const callsFile = path.join(home, 'calls.log')
  writeFileSync(fakeCli, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$CALLS_FILE"
case "$*" in
  "profile list") printf '[]\\n' ;;
  "profile add "*) cat >/dev/null ;;
esac
`)
  chmodSync(fakeCli, 0o755)

  const result = spawnSync('bash', ['-c', `
set -euo pipefail
LARK_CLI_CMD="$1"
CALLS_FILE="$2"
export CALLS_FILE
AAMP_FEISHU_AUTH_STATE_DIR="$3"
FEISHU_USER_AUTH_MODE="disabled"
FEISHU_SCOPE_MANIFEST_VERSION=""
FEISHU_APP_SCOPES_TENANT=""
FEISHU_APP_SCOPES_USER=""
FEISHU_USER_AUTH_CORE_SCOPES=""
FEISHU_USER_AUTH_OPTIONAL_SCOPES=""
FEISHU_USER_AUTH_REQUIRED_SCOPES=""
FEISHU_USER_AUTH_REQUESTED_SCOPES=""
FEISHU_USER_AUTH_EXCLUDES=""
agent_detail() { :; }
agent_log() { :; }
agent_fail() { printf '%s\\n' "$*" >&2; exit 1; }
${helpers}
initialize_feishu_scope_manifest
ensure_lark_cli_profile_locked cli_task secret profile-task lark
`, 'bash', fakeCli, callsFile, path.join(home, 'state')], { encoding: 'utf8' })

  assert.equal(result.status, 0, result.stderr)
  const calls = readFileSync(callsFile, 'utf8')
  assert.match(calls, /^profile add --name profile-task --app-id cli_task --brand lark --app-secret-stdin$/m)
  assert.doesNotMatch(calls, /profile add .*--brand feishu/)
})

test('Lark registrations use an isolated profile name while Feishu keeps the legacy name', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const start = source.indexOf('task_profile_name_for_app_id()')
  const end = source.indexOf('\nsave_bot_config()', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)

  const helper = source.slice(start, end)
  const result = spawnSync('bash', ['-c', `
set -euo pipefail
agent_fail() { printf '%s\\n' "$*" >&2; exit 1; }
${helper}
task_profile_name_for_app_id cli_task
printf '\\n'
task_profile_name_for_app_id cli_task feishu
printf '\\n'
task_profile_name_for_app_id cli_task lark
printf '\\n'
`], { encoding: 'utf8' })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, [
    'aamp-feishu-task-cli_task',
    'aamp-feishu-task-cli_task',
    'aamp-feishu-task-cli_task-lark',
    '',
  ].join('\n'))
})

test('optional user auth keeps an existing profile ready without login', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const start = source.indexOf('feishu_scope_manifest_json()')
  const end = source.indexOf('\nforget_current_bot_after_feishu_start_failure()', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)

  const helpers = source.slice(start, end)
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-optional-user-auth-'))
  const fakeCli = path.join(home, 'lark-cli')
  const callsFile = path.join(home, 'calls.log')
  writeFileSync(fakeCli, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$CALLS_FILE"
case "$*" in
  "profile list") printf '["profile-task"]\\n' ;;
  "--profile profile-task auth status --json") printf '{"identities":{"user":{"available":false,"tokenStatus":"missing","scope":""}}}\\n' ;;
  *" auth login "*) exit 91 ;;
esac
`)
  chmodSync(fakeCli, 0o755)

  const result = spawnSync('bash', ['-c', `
set -euo pipefail
LARK_CLI_CMD="$1"
CALLS_FILE="$2"
export CALLS_FILE
AAMP_FEISHU_AUTH_STATE_DIR="$3"
FEISHU_USER_AUTH_MODE="optional"
FEISHU_SCOPE_MANIFEST_VERSION=""
FEISHU_APP_SCOPES_TENANT=""
FEISHU_APP_SCOPES_USER=""
FEISHU_USER_AUTH_CORE_SCOPES=""
FEISHU_USER_AUTH_OPTIONAL_SCOPES=""
FEISHU_USER_AUTH_REQUIRED_SCOPES=""
FEISHU_USER_AUTH_REQUESTED_SCOPES=""
FEISHU_USER_AUTH_EXCLUDES="vc:meeting.realtime:read"
agent_detail() { :; }
agent_log() { printf '%s\\n' "$*"; }
agent_fail() { printf '%s\\n' "$*" >&2; exit 1; }
${helpers}
initialize_feishu_scope_manifest
ensure_lark_cli_profile_locked cli_task secret profile-task
`,'bash', fakeCli, callsFile, path.join(home, 'state')], { encoding: 'utf8' })

  assert.equal(result.status, 0, result.stderr)
  const calls = readFileSync(callsFile, 'utf8')
  assert.doesNotMatch(calls, /auth login/)
  assert.match(result.stdout, /Task bridge ready; optional user capabilities unavailable/)
  const snapshot = JSON.parse(readFileSync(path.join(home, 'state', 'profile-task.json'), 'utf8'))
  assert.equal(snapshot.manifestVersion, 2)
  assert.equal(snapshot.tokenStatus, 'missing')
  assert.equal(snapshot.capabilities.task_user, false)
  assert.deepEqual(snapshot.missingCoreScopes, [])
  assert.equal(snapshot.missingOptionalScopes.includes('task:task:read'), true)
})

test('optional user auth stays ready when the capability snapshot cannot be written', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const start = source.indexOf('feishu_scope_manifest_json()')
  const end = source.indexOf('\nforget_current_bot_after_feishu_start_failure()', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)

  const helpers = source.slice(start, end)
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-optional-user-auth-snapshot-failure-'))
  const fakeCli = path.join(home, 'lark-cli')
  const callsFile = path.join(home, 'calls.log')
  const blockedStateDir = path.join(home, 'not-a-directory')
  writeFileSync(blockedStateDir, 'blocked')
  writeFileSync(fakeCli, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$CALLS_FILE"
case "$*" in
  "profile list") printf '["profile-task"]\\n' ;;
  "--profile profile-task auth status --json") printf '{"identities":{"user":{"available":false,"tokenStatus":"missing","scope":""}}}\\n' ;;
  *" auth login "*) exit 91 ;;
esac
`)
  chmodSync(fakeCli, 0o755)

  const result = spawnSync('bash', ['-c', `
set -euo pipefail
LARK_CLI_CMD="$1"
CALLS_FILE="$2"
export CALLS_FILE
AAMP_FEISHU_AUTH_STATE_DIR="$3"
FEISHU_USER_AUTH_MODE="optional"
FEISHU_SCOPE_MANIFEST_VERSION=""
FEISHU_APP_SCOPES_TENANT=""
FEISHU_APP_SCOPES_USER=""
FEISHU_USER_AUTH_CORE_SCOPES=""
FEISHU_USER_AUTH_OPTIONAL_SCOPES=""
FEISHU_USER_AUTH_REQUIRED_SCOPES=""
FEISHU_USER_AUTH_REQUESTED_SCOPES=""
FEISHU_USER_AUTH_EXCLUDES=""
agent_detail() { :; }
agent_log() { printf '%s\\n' "$*"; }
agent_fail() { printf '%s\\n' "$*" >&2; exit 1; }
${helpers}
initialize_feishu_scope_manifest
ensure_lark_cli_profile_locked cli_task secret profile-task
`,'bash', fakeCli, callsFile, blockedStateDir], { encoding: 'utf8' })

  assert.equal(result.status, 0, result.stderr)
  const calls = readFileSync(callsFile, 'utf8')
  assert.doesNotMatch(calls, /auth login/)
  assert.match(result.stdout, /unable to persist optional user capability snapshot/)
})

test('required user auth cannot pass the ready-profile probe with missing scopes', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const start = source.indexOf('feishu_scope_manifest_json()')
  const end = source.indexOf('\nensure_lark_cli_profile_locked()', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)

  const helpers = source.slice(start, end)
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-required-user-auth-probe-'))
  const fakeCli = path.join(home, 'lark-cli')
  writeFileSync(fakeCli, `#!/usr/bin/env bash
case "$*" in
  "profile list") printf '["profile-task"]\\n' ;;
  "--profile profile-task auth status --json") printf '{"identities":{"user":{"available":false,"tokenStatus":"missing","scope":""}}}\\n' ;;
esac
`)
  chmodSync(fakeCli, 0o755)

  const result = spawnSync('bash', ['-c', `
set -euo pipefail
LARK_CLI_CMD="$1"
FEISHU_USER_AUTH_MODE="required"
FEISHU_SCOPE_MANIFEST_VERSION=""
FEISHU_APP_SCOPES_TENANT=""
FEISHU_APP_SCOPES_USER=""
FEISHU_USER_AUTH_CORE_SCOPES=""
FEISHU_USER_AUTH_OPTIONAL_SCOPES=""
FEISHU_USER_AUTH_REQUIRED_SCOPES=""
FEISHU_USER_AUTH_REQUESTED_SCOPES=""
FEISHU_USER_AUTH_EXCLUDES=""
agent_detail() { :; }
agent_log() { :; }
agent_fail() { printf '%s\\n' "$*" >&2; exit 1; }
${helpers}
initialize_feishu_scope_manifest
if probe_lark_cli_profile_locked profile-task; then
  exit 91
fi
`, 'bash', fakeCli], { encoding: 'utf8' })

  assert.equal(result.status, 0, result.stderr)
})

test('optional mode enforces an explicitly configured core scope', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const start = source.indexOf('feishu_scope_manifest_json()')
  const end = source.indexOf('\nforget_current_bot_after_feishu_start_failure()', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)

  const helpers = source.slice(start, end)
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-optional-user-auth-core-'))
  const fakeCli = path.join(home, 'lark-cli')
  const readyFile = path.join(home, 'auth-ready')
  const callsFile = path.join(home, 'calls.log')
  writeFileSync(fakeCli, `#!/usr/bin/env bash
case "$*" in
  "profile list") printf '["profile-task"]\\n' ;;
  "--profile profile-task auth status --json")
    if [ -f "$AUTH_READY_FILE" ]; then
      printf '{"identities":{"user":{"available":true,"tokenStatus":"valid","scope":"task:task:read"}}}\\n'
    else
      printf '{"identities":{"user":{"available":false,"tokenStatus":"missing","scope":""}}}\\n'
    fi
    ;;
esac
`)
  chmodSync(fakeCli, 0o755)

  const result = spawnSync('bash', ['-c', `
set -euo pipefail
LARK_CLI_CMD="$1"
AUTH_READY_FILE="$2"
CALLS_FILE="$3"
export AUTH_READY_FILE CALLS_FILE
AAMP_FEISHU_AUTH_STATE_DIR="$4"
FEISHU_USER_AUTH_MODE="optional"
FEISHU_SCOPE_MANIFEST_VERSION=""
FEISHU_APP_SCOPES_TENANT=""
FEISHU_APP_SCOPES_USER=""
FEISHU_USER_AUTH_CORE_SCOPES="task:task:read"
FEISHU_USER_AUTH_OPTIONAL_SCOPES=""
FEISHU_USER_AUTH_REQUIRED_SCOPES=""
FEISHU_USER_AUTH_REQUESTED_SCOPES=""
FEISHU_USER_AUTH_EXCLUDES=""
agent_detail() { :; }
agent_log() { :; }
agent_fail() { printf '%s\\n' "$*" >&2; exit 1; }
${helpers}
run_lark_cli_auth_login_with_browser_open() {
  printf '%s\\n' "$*" >> "$CALLS_FILE"
  touch "$AUTH_READY_FILE"
}
initialize_feishu_scope_manifest
ensure_lark_cli_profile_locked cli_task secret profile-task
`, 'bash', fakeCli, readyFile, callsFile, path.join(home, 'state')], { encoding: 'utf8' })

  assert.equal(result.status, 0, result.stderr)
  assert.match(readFileSync(callsFile, 'utf8'), /auth login --scope/)
})

test('non-interactive profile preparation never launches Feishu authorization', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const start = source.indexOf('feishu_scope_manifest_json()')
  const end = source.indexOf('\nforget_current_bot_after_feishu_start_failure()', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)

  const helpers = source.slice(start, end)
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-profile-non-interactive-auth-'))
  const fakeCli = path.join(home, 'lark-cli')
  const loginMarker = path.join(home, 'auth-login-called')
  writeFileSync(fakeCli, `#!/usr/bin/env bash
case "$*" in
  "profile list") printf '["profile-task"]\\n' ;;
  "--profile profile-task auth status --json") printf '{"identities":{"user":{"available":false,"tokenStatus":"missing","scope":""}}}\\n' ;;
esac
`)
  chmodSync(fakeCli, 0o755)

  const result = spawnSync('bash', ['-c', `
set -euo pipefail
LARK_CLI_CMD="$1"
LOGIN_MARKER="$2"
AAMP_FEISHU_AUTH_STATE_DIR="$3"
AAMP_TASK_NON_INTERACTIVE=true
FEISHU_USER_AUTH_MODE="optional"
FEISHU_SCOPE_MANIFEST_VERSION=""
FEISHU_APP_SCOPES_TENANT=""
FEISHU_APP_SCOPES_USER=""
FEISHU_USER_AUTH_CORE_SCOPES="task:task:read"
FEISHU_USER_AUTH_OPTIONAL_SCOPES=""
FEISHU_USER_AUTH_REQUIRED_SCOPES=""
FEISHU_USER_AUTH_REQUESTED_SCOPES=""
FEISHU_USER_AUTH_EXCLUDES=""
agent_detail() { :; }
agent_log() { :; }
agent_fail() { printf '%s\\n' "$*" >&2; exit 64; }
${helpers}
run_lark_cli_auth_login_with_browser_open() { touch "$LOGIN_MARKER"; }
initialize_feishu_scope_manifest
ensure_lark_cli_profile_locked cli_task secret profile-task
`, 'bash', fakeCli, loginMarker, path.join(home, 'state')], { encoding: 'utf8' })

  assert.equal(result.status, 64)
  assert.match(result.stderr, /后台服务无法完成交互式准备.*feishu-task-agent start/)
  assert.equal(existsSync(loginMarker), false)
})

test('explicit user login uses fixed scopes and intersects stale excludes', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const start = source.indexOf('feishu_scope_manifest_json()')
  const end = source.indexOf('\nensure_lark_cli_profile()', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)

  const helpers = source.slice(start, end)
  const output = execFileSync('bash', ['-c', `
set -euo pipefail
FEISHU_USER_AUTH_REQUESTED_SCOPES="task:task:read task:task:write"
FEISHU_USER_AUTH_REQUIRED_SCOPES=""
FEISHU_USER_AUTH_CORE_SCOPES=""
FEISHU_USER_AUTH_OPTIONAL_SCOPES=""
${helpers}
run_lark_cli_auth_login_with_browser_open() { printf '%s\\n' "$*"; }
LARK_CLI_CMD="/tmp/lark-cli"
run_lark_cli_auth_login profile-task "vc:meeting.realtime:read,task:task:write"
`], { encoding: 'utf8' })

  assert.doesNotMatch(output, /--domain/)
  assert.doesNotMatch(output, /vc:meeting\.realtime:read/)
  assert.match(output, /^\/tmp\/lark-cli --profile profile-task auth login --scope task:task:read task:task:write --exclude task:task:write\n$/)
})

test('bootstrap manifest includes full app and bridge identity', () => {
  const source = readFileSync(bootstrap, 'utf8')

  assert.match(source, /"app_id":/)
  assert.match(source, /"bot_name":/)
  assert.match(source, /"feishu_bridge_name": "aamp-feishu-bridge"/)
  assert.match(source, /"feishu_bridge_email":/)
  assert.match(source, /"agent_bridge_type":/)
  assert.match(source, /"agent_bridge_name":/)
  assert.match(source, /"agent_bridge_email":/)
  assert.doesNotMatch(source, /"app_id_prefix":/)
  assert.doesNotMatch(source, /"feishu_bridge_package":/)
  assert.doesNotMatch(source, /"feishu_bridge_log":/)
  assert.doesNotMatch(source, /"agent_bridge_package":/)
  assert.doesNotMatch(source, /"agent_bridge_log":/)
})

test('bootstrap extracts bridge emails', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const start = source.indexOf('extract_email_from_pairing_url()')
  const end = source.indexOf('\ninit_log_run()')
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)

  const helpers = source.slice(start, end)
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-bootstrap-mail-id-'))
  const feishuLog = path.join(home, 'feishu-bridge.jsonl')
  writeFileSync(feishuLog, `${JSON.stringify({
    message: '[bridge] starting target=agent@meshmail.ai mailbox=feishu@meshmail.ai events=task',
  })}\n`)
  const output = execFileSync('bash', ['-c', `
set -euo pipefail
${helpers}
extract_email_from_pairing_url 'aamp://connect?mailbox=agent%40meshmail.ai&pair_code=abc'
printf '\\n'
printf '%s' '{"agents":[{"email":"acp@meshmail.ai","pairing":{"mailbox":"acp-pairing@meshmail.ai"}}]}' | extract_agent_email_from_acp_init_output
printf '\\n'
extract_feishu_email_from_log "$1"
printf '\\n'
`, 'bash', feishuLog], { encoding: 'utf8' })

  assert.deepEqual(output.trim().split('\n'), [
    'agent@meshmail.ai',
    'acp@meshmail.ai',
    'feishu@meshmail.ai',
  ])
})

test('bootstrap summarizes long lark-cli auth scopes output', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const start = source.indexOf('auth_scope_tokens=()')
  const end = source.indexOf('\nrun_lark_cli_auth_login_with_browser_open()')
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)

  const helpers = source.slice(start, end)
  const output = execFileSync('bash', ['-c', `
set -euo pipefail
${helpers}
while IFS= read -r line; do
  print_lark_cli_auth_output_line "$line"
done <<'EOF'
OK: 授权成功! 用户: foo
  本次请求 scopes:
    im:message im:message:readonly task:task task:comment
next line
EOF
flush_lark_cli_auth_scopes
`], { encoding: 'utf8' })

  assert.equal(output, [
    'OK: 授权成功! 用户: foo',
    '  本次请求 scopes: im:message, im:message:readonly 等共计 4 个权限。',
    'next line',
    '',
  ].join('\n'))
})


test('bootstrap installs short command and auto-updates at startup', () => {
  const source = readFileSync(bootstrap, 'utf8')

  assert.ok(source.includes('AAMP_TASK_START_MODE="start"'))
  assert.ok(source.includes('AAMP_TASK_ACTION=""'))
  assert.ok(source.includes('AAMP_TASK_ACTION="${AAMP_TASK_DEFAULT_ACTION:-install}"'))
  assert.ok(source.includes('AAMP_TASK_COMMAND_NAME="${AAMP_TASK_COMMAND_NAME:-feishu-task-agent}"'))
  assert.ok(source.includes('AAMP_TASK_COMMAND_PATH="${AAMP_TASK_COMMAND_PATH:-$AAMP_BIN_DIR/$AAMP_TASK_COMMAND_NAME}"'))
  assert.ok(source.includes('AAMP_TASK_SHIM_DIR="${AAMP_TASK_SHIM_DIR:-$HOME/.local/bin}"'))
  assert.ok(source.includes('AAMP_TASK_UPDATE_CACHE_FILE="${AAMP_TASK_UPDATE_CACHE_FILE:-$HOME/.aamp/feishu-task-agent/update-cache.json}"'))
  assert.ok(source.includes('AAMP_TASK_UPDATE_CACHE_TTL_SECONDS="${AAMP_TASK_UPDATE_CACHE_TTL_SECONDS:-86400}"'))
  assert.ok(source.includes('record_version_line()'))
  assert.ok(source.includes('record_install_success()'))
  assert.ok(source.includes('当前版本：$AAMP_TASK_AGENT_VERSION'))
  const versionStart = source.indexOf('record_version_line()')
  const versionEnd = source.indexOf('\nprint_local_log_hints()', versionStart)
  const versionHelper = source.slice(versionStart, versionEnd)
  assert.ok(versionHelper.includes('printf '))
  assert.ok(source.includes('[aamp-one-click] start with: '))
  const installStart = source.indexOf('record_install_success()')
  const installEnd = source.indexOf('\nensure_selected_agent_for_start()', installStart)
  const installHelper = source.slice(installStart, installEnd)
  assert.ok(!installHelper.includes('printf '))
  assert.ok(source.includes('script_file_task_agent_version()'))
  assert.ok(source.includes('short_command_is_current()'))
  assert.ok(source.includes('write_task_update_cache()'))
  assert.ok(source.includes('task_update_cache_is_fresh()'))
  assert.ok(source.includes('install_short_command_from_version()'))
  assert.ok(source.includes('install_short_command_shim()'))
  assert.ok(source.includes('install_short_command_current()'))
  assert.ok(source.includes('local source_file="${BASH_SOURCE[0]:-}"'))
  assert.ok(source.includes('""|/dev/fd/*|/private/dev/fd/*|/proc/*'))
  assert.ok(source.includes('ensure_task_agent_global_install "$version"'))
  assert.ok(source.includes('source_file="$package_dir/bootstrap/aamp-feishu-task-agent-bootstrap.sh"'))
  assert.ok(source.includes('cat >"$tmp" <<EOF'))
  assert.ok(source.includes('exec "$target" "\\$@"'))
  assert.ok(source.includes('cmp -s "$tmp" "$shim"'))
  assert.ok(source.includes('resolve_latest_task_agent_version()'))
  assert.ok(source.includes('"$NPM_BIN" view "$AAMP_TASK_AGENT_NAME@$AAMP_TASK_AGENT_CHANNEL" version'))
  assert.ok(source.includes('auto_update_short_command_if_needed normal'))
  assert.ok(source.includes('auto_update_short_command_if_needed force'))
  assert.ok(source.includes('if [ "$mode" != "force" ] && task_update_cache_is_fresh; then'))
  assert.ok(source.includes('run_task_agent_update_command()'))
  assert.ok(source.includes('if [ "$AAMP_TASK_ACTION" = "update" ]; then'))
  assert.ok(source.includes('if [ "$AAMP_TASK_START_MODE" = "start" ]; then'))
  assert.ok(source.includes('RESTART_ARGS=()'))
  assert.ok(source.includes('AAMP_TASK_AUTO_UPDATE_DONE=true exec "$AAMP_TASK_COMMAND_PATH" "${RESTART_ARGS[@]}"'))
  assert.ok(source.includes('write_task_update_cache "$AAMP_TASK_AGENT_VERSION"'))
  assert.ok(source.includes('return 0'))
  assert.ok(source.includes('AAMP_TASK_START_MODE="start"'))

  assert.ok(source.indexOf('install_short_command || agent_fail') < source.indexOf('auto_update_short_command_if_needed normal'))
  assert.ok(source.indexOf('auto_update_short_command_if_needed normal') < source.indexOf('  record_version_line\n'))
  assert.ok(source.indexOf('  record_version_line\n') < source.indexOf('  run_task_agent_controller\n'))
})

test('short command identity includes the task-agent npm scope', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const helperStart = source.indexOf('script_file_task_agent_version()')
  const helperEnd = source.indexOf('\nwrite_task_update_cache()', helperStart)
  const helpers = source.slice(helperStart, helperEnd)
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-short-command-scope-'))
  const legacyCommand = path.join(root, 'legacy-command.sh')
  const currentCommand = path.join(root, 'current-command.sh')

  writeFileSync(legacyCommand, `#!/usr/bin/env bash
AAMP_TASK_AGENT_NAME="\${AAMP_TASK_AGENT_NAME:-@zengxingyuan/aamp-feishu-task-agent}"
AAMP_TASK_AGENT_VERSION="0.1.0-dev.172"
`)
  writeFileSync(currentCommand, `#!/usr/bin/env bash
AAMP_TASK_AGENT_NAME="\${AAMP_TASK_AGENT_NAME:-@larktask/aamp-feishu-task-agent}"
AAMP_TASK_AGENT_VERSION="0.1.0-dev.172"
`)
  chmodSync(legacyCommand, 0o755)
  chmodSync(currentCommand, 0o755)

  const shell = `
set -euo pipefail
AAMP_TASK_AGENT_NAME="@larktask/aamp-feishu-task-agent"
AAMP_TASK_AGENT_VERSION="0.1.0-dev.172"
${helpers}
if short_command_is_current "$1"; then
  exit 41
fi
short_command_is_current "$2"
`
  execFileSync('bash', ['-c', shell, 'bash', legacyCommand, currentCommand])
})

test('short command refreshes when same-version bootstrap content changes', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const helperStart = source.indexOf('script_file_task_agent_version()')
  const helperEnd = source.indexOf('\nwrite_task_update_cache()', helperStart)
  const helpers = source.slice(helperStart, helperEnd)
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-short-command-content-'))
  const staleCommand = path.join(root, 'stale-command.sh')
  const sourceCommand = path.join(root, 'source-command.sh')

  writeFileSync(staleCommand, `#!/usr/bin/env bash
AAMP_TASK_AGENT_NAME="\${AAMP_TASK_AGENT_NAME:-@larktask/aamp-feishu-task-agent}"
AAMP_TASK_AGENT_VERSION="0.1.0-dev.175"
AIME_ACP_PKG="\${AIME_ACP_PKG:-@tengchengwei/aime-acp@0.1.0}"
`)
  writeFileSync(sourceCommand, `#!/usr/bin/env bash
AAMP_TASK_AGENT_NAME="\${AAMP_TASK_AGENT_NAME:-@larktask/aamp-feishu-task-agent}"
AAMP_TASK_AGENT_VERSION="0.1.0-dev.175"
AIME_ACP_PKG="\${AIME_ACP_PKG:-@tengchengwei/aime-acp@0.1.0-dev.7}"
`)
  chmodSync(staleCommand, 0o755)
  chmodSync(sourceCommand, 0o755)

  const shell = `
set -euo pipefail
AAMP_TASK_AGENT_NAME="@larktask/aamp-feishu-task-agent"
AAMP_TASK_AGENT_VERSION="0.1.0-dev.175"
${helpers}
if short_command_is_current "$1" "$2"; then
  exit 41
fi
short_command_is_current "$2" "$2"
`
  execFileSync('bash', ['-c', shell, 'bash', staleCommand, sourceCommand])
})

test('bootstrap removes the legacy scoped package before installing the new scope', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const helperStart = source.indexOf('legacy_task_agent_global_package_dir()')
  const helperEnd = source.indexOf('\ntask_agent_global_package_version()', helperStart)
  assert.notEqual(helperStart, -1)
  assert.notEqual(helperEnd, -1)

  const helpers = source.slice(helperStart, helperEnd)
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-task-agent-scope-migration-'))
  const prefix = path.join(root, 'npm-global')
  const legacyDir = path.join(prefix, 'lib/node_modules/@zengxingyuan/aamp-feishu-task-agent')
  const fakeNpm = path.join(root, 'npm')
  const argsFile = path.join(root, 'npm-args.txt')
  mkdirSync(legacyDir, { recursive: true })
  writeFileSync(fakeNpm, `#!/usr/bin/env bash
printf '%s\\n' "$@" >"$NPM_ARGS_FILE"
`)
  chmodSync(fakeNpm, 0o755)

  const shell = `
set -euo pipefail
NPM_GLOBAL_PREFIX="$1"
AAMP_TASK_AGENT_NAME="@larktask/aamp-feishu-task-agent"
AAMP_TASK_AGENT_LEGACY_NAME="@zengxingyuan/aamp-feishu-task-agent"
NPM_BIN="$2"
NPM_REGISTRY="https://registry.npmjs.org/"
NPM_CACHE_DIR="$3/cache"
ONE_CLICK_LOG="$3/one-click.log"
NPM_ARGS_FILE="$4"
export NPM_ARGS_FILE
agent_detail() { :; }
sanitize_inherited_npm_exec_env() { :; }
${helpers}
remove_legacy_task_agent_global_install
`
  execFileSync('bash', ['-c', shell, 'bash', prefix, fakeNpm, root, argsFile])

  assert.deepEqual(readFileSync(argsFile, 'utf8').trim().split('\n'), [
    'uninstall',
    '-g',
    '--registry',
    'https://registry.npmjs.org/',
    '--cache',
    path.join(root, 'cache'),
    '--prefix',
    prefix,
    '@zengxingyuan/aamp-feishu-task-agent',
  ])
})

test('bootstrap keeps the npm-global task-agent package and aamp-logs on the launcher version', () => {
  const source = readFileSync(bootstrap, 'utf8')

  assert.ok(source.includes('TASK_AGENT_UPDATE_LOCK_DIR='))
  assert.ok(source.includes('task_agent_global_package_version()'))
  assert.ok(source.includes('task_agent_global_install_is_current()'))
  assert.ok(source.includes('ensure_task_agent_global_install()'))
  assert.ok(source.includes('with_task_agent_update_lock()'))
  assert.ok(source.includes('npm_install_global "$AAMP_TASK_AGENT_NAME@$expected_version"'))
  assert.ok(source.includes('install_aamp_logs_bin "$AAMP_TASK_AGENT_VERSION"'))
  assert.ok(source.includes('install_aamp_logs_bin "$installed_version"'))
  assert.ok(source.includes('ln -s "$NPM_GLOBAL_PREFIX/bin/aamp-logs" "$tmp"'))
  assert.ok(source.indexOf('ensure_task_agent_global_install "$latest"') < source.indexOf('install_short_command_from_version "$latest"'))
})

test('bootstrap exposes aamp-logs through the user PATH shim directory', () => {
  const source = readFileSync(bootstrap, 'utf8')

  assert.ok(source.includes('install_aamp_logs_shim()'))
  assert.ok(source.includes('install_command_shim "$AAMP_LOGS_BIN" "aamp-logs"'))
  assert.ok(source.indexOf('install_aamp_logs_bin()') < source.indexOf('install_aamp_logs_shim()'))
})

test('explicit update restarts into the newly installed launcher before running migrations', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const updateStart = source.indexOf('auto_update_short_command_if_needed()')
  const updateEnd = source.indexOf('\nadopt_newer_global_task_agent_if_available()', updateStart)
  const updateHelper = source.slice(updateStart, updateEnd)
  const commandStart = source.indexOf('run_task_agent_update_command()')
  const commandEnd = source.indexOf('\nnpm_install_global()', commandStart)
  const updateCommand = source.slice(commandStart, commandEnd)

  assert.ok(updateCommand.includes('auto_update_short_command_if_needed force'))
  assert.ok(updateHelper.includes('AAMP_TASK_AUTO_UPDATE_DONE=true exec "$AAMP_TASK_COMMAND_PATH" "${RESTART_ARGS[@]}"'))
})

test('bootstrap validates the npm-global package version before reusing its binaries', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const start = source.indexOf('task_agent_global_package_dir()')
  const end = source.indexOf('\nshort_command_is_current()', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)

  const helpers = source.slice(start, end)
  const home = mkdtempSync(path.join(tmpdir(), 'aamp-task-agent-global-'))
  const prefix = path.join(home, 'npm-global')
  const packageDir = path.join(prefix, 'lib/node_modules/@larktask/aamp-feishu-task-agent')
  mkdirSync(path.join(packageDir, 'bootstrap'), { recursive: true })
  mkdirSync(path.join(packageDir, 'bin'), { recursive: true })
  mkdirSync(path.join(prefix, 'bin'), { recursive: true })
  writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version: '9.8.7' }))
  writeFileSync(path.join(packageDir, 'bootstrap/aamp-feishu-task-agent-bootstrap.sh'), '#!/usr/bin/env bash\n')
  writeFileSync(path.join(packageDir, 'bin/feishu-task-agent-controller.mjs'), '#!/usr/bin/env node\n')
  writeFileSync(path.join(packageDir, 'bin/traecode-readiness.mjs'), '#!/usr/bin/env node\n')
  writeFileSync(path.join(prefix, 'bin/aamp-logs'), '#!/usr/bin/env node\n')
  chmodSync(path.join(prefix, 'bin/aamp-logs'), 0o755)

  const output = execFileSync('bash', ['-c', `
set -euo pipefail
NPM_GLOBAL_PREFIX="$1"
AAMP_TASK_AGENT_NAME="@larktask/aamp-feishu-task-agent"
ONE_CLICK_LOG="$2"
${helpers}
task_agent_global_package_version
task_agent_global_install_is_current "9.8.7"
if task_agent_global_install_is_current "9.8.6"; then
  exit 1
fi
`, 'bash', prefix, path.join(home, 'one-click.log')], { encoding: 'utf8' })

  assert.equal(output, '9.8.7')
})

test('bootstrap pins lark-cli to one absolute binary and serializes writes', () => {
  const source = readFileSync(bootstrap, 'utf8')

  assert.match(source, /AAMP_LARK_CLI_BIN=/)
  assert.match(source, /select_lark_cli_bin\(\)/)
  assert.match(source, /lark_cli_candidate_paths\(\)/)
  assert.match(source, /LARK_CLI_INSTALL_LOCK_DIR/)
  assert.match(source, /LARK_CLI_CONFIG_LOCK_DIR/)
  assert.match(source, /with_lark_cli_install_lock/)
  assert.match(source, /with_lark_cli_config_lock/)
  assert.match(source, /export AAMP_LARK_CLI_BIN/)
  assert.match(source, /export AAMP_LARK_CLI_BIN=\"\$LARK_CLI_CMD\"/)
  assert.match(source, /\"\$LARK_CLI_CMD\" --profile \"\$profile\" auth status/)
  assert.match(source, /run_lark_cli_auth_login_with_browser_open \"\$LARK_CLI_CMD\"/)
  assert.match(source, /\"\$LARK_CLI_CMD\" profile list/)
  assert.match(source, /\| \"\$LARK_CLI_CMD\" profile add/)
})

test('bootstrap detects the Codex CLI bundled in the renamed ChatGPT app', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const helperStart = source.indexOf('resolve_codex_cli_for_acp()')
  const helperEnd = source.indexOf('\nbuild_acp_agent_command()', helperStart)
  assert.notEqual(helperStart, -1)
  assert.notEqual(helperEnd, -1)

  const helper = source.slice(helperStart, helperEnd)
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-chatgpt-codex-cli-'))
  const bundledCodex = path.join(root, 'ChatGPT.app/Contents/Resources/codex')
  mkdirSync(path.dirname(bundledCodex), { recursive: true })
  writeFileSync(bundledCodex, '#!/usr/bin/env bash\nprintf "codex-cli 1.2.3\\n"\n')
  chmodSync(bundledCodex, 0o755)

  const result = spawnSync('bash', ['-c', `
set -euo pipefail
PATH="/usr/bin:/bin"
CODEX_APP_CLI="$1/missing/Codex.app/Contents/Resources/codex"
CODEX_CHATGPT_APP_CLI="$2"
is_macos() { return 0; }
${helper}
resolve_codex_cli_for_acp
`, 'bash', root, bundledCodex], { encoding: 'utf8' })

  assert.equal(result.status, 0)
  assert.equal(result.stdout.trim(), bundledCodex)
})

test('bootstrap asks before a newer Codex update and keeps update failures nonblocking', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const helperStart = source.indexOf('ensure_codex_cli_updated()')
  const helperEnd = source.indexOf('\nrun_codex_login_status()', helperStart)
  const helper = source.slice(helperStart, helperEnd)
  const prepareStart = source.indexOf('run_internal_prepare_agent()')
  const prepareEnd = source.indexOf('\nrun_internal_ensure_profile()', prepareStart)
  const prepare = source.slice(prepareStart, prepareEnd)

  assert.notEqual(helperStart, -1)
  assert.notEqual(helperEnd, -1)
  assert.ok(source.includes('CODEX_UPDATE_LOCK_DIR='))
  assert.ok(helper.includes('resolve_codex_cli_for_acp'))
  assert.ok(helper.includes('resolve_latest_codex_cli_version'))
  assert.ok(helper.includes('codex_cli_update_available'))
  assert.ok(helper.includes('当前 Codex CLI 版本是：'))
  assert.ok(helper.includes('最新版本是：'))
  assert.ok(helper.includes('confirm_codex_cli_update'))
  assert.ok(helper.includes('检测到 Codex CLI 有可用更新。不升级可能导致后续任务执行失败。'))
  assert.ok(!helper.includes('本次启动前需升级 Codex CLI'))
  assert.ok(source.includes('是否现在升级？[y/n]'))
  assert.ok(helper.includes('agent_log "正在更新 Codex CLI..."'))
  assert.ok(source.includes('codex_update_output_file()'))
  assert.ok(source.includes('report_codex_update_warning()'))
  assert.ok(helper.includes('run_codex_cli_update "$codex_bin" "$update_log"'))
  assert.ok(helper.includes('Codex CLI 升级失败'))
  assert.ok(!helper.includes('agent_fail "Codex CLI 升级失败'))
  assert.ok(prepare.indexOf('prepare_internal_agent_environment') < prepare.indexOf('ensure_codex_cli_updated'))
  assert.ok(prepare.indexOf('ensure_codex_cli_updated') < prepare.indexOf('ensure_agent_login'))
})

test('Codex update failure prints raw output and continues startup after user confirms', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const helperStart = source.indexOf('codex_cli_version()')
  const helperEnd = source.indexOf('\nrun_codex_login_status()', helperStart)
  const helpers = source.slice(helperStart, helperEnd)
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-codex-update-'))
  const fakeCodex = path.join(root, 'codex')
  const logFile = path.join(root, 'one-click.log')
  const updateLogFile = path.join(root, 'codex-update.log')
  const detailFile = path.join(root, 'details.log')

  writeFileSync(fakeCodex, [
    '#!/usr/bin/env bash',
    'case "$1" in',
    '  --version) printf "codex-cli 1.2.3\\n" ;;',
    '  update) printf "update stdout\\n"; printf "installation method error\\n" >&2; exit 42 ;;',
    'esac',
    '',
  ].join('\n'))
  chmodSync(fakeCodex, 0o755)

  const shell = [
    'set -euo pipefail',
    'AGENT="codex"',
    'CODEX_AUTO_UPDATE="true"',
    'CODEX_UPDATE_LOCK_DIR="$1/update.lock"',
    'ONE_CLICK_RUN_ID="test-$$"',
    'AAMP_RUN_LOG_DIR="$1"',
    'ONE_CLICK_LOG="$2"',
    'DETAIL_FILE="$3"',
    'FAKE_CODEX="$4"',
    'resolve_codex_cli_for_acp() { printf "%s\\n" "$FAKE_CODEX"; }',
    'agent_detail() { printf "%s\\n" "$*" >>"$DETAIL_FILE"; }',
    'agent_log() { printf "[aamp-one-click] %s\\n" "$*"; }',
    'agent_fail() { printf "[aamp-one-click] ERROR: %s\\n" "$*" >&2; exit 1; }',
    'write_one_click_log() { printf "%s\\n" "$*" >>"$DETAIL_FILE"; }',
    'release_dir_lock() { command rm -f "$1/owner"; command rmdir "$1"; }',
    helpers,
    'resolve_latest_codex_cli_version() { printf "9.9.9\\n"; }',
    'confirm_codex_cli_update() { return 0; }',
    'ensure_codex_cli_updated',
    'printf "startup-continued"',
  ].join('\n')
  const result = spawnSync('bash', ['-c', shell, 'bash', root, logFile, detailFile, fakeCodex], { encoding: 'utf8' })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /当前 Codex CLI 版本是：1\.2\.3，最新版本是：9\.9\.9/)
  assert.match(result.stdout, /\[aamp-one-click\] 正在更新 Codex CLI\.\.\./)
  assert.match(result.stdout, /startup-continued$/)
  assert.match(result.stderr, /Codex CLI 升级失败（状态码：42）/)
  assert.match(result.stderr, /update stdout/)
  assert.match(result.stderr, /installation method error/)
  assert.match(result.stderr, /已忽略本次升级失败，继续后续启动流程/)
  assert.match(readFileSync(logFile, 'utf8'), /update stdout/)
  assert.match(readFileSync(logFile, 'utf8'), /installation method error/)
  assert.match(readFileSync(updateLogFile, 'utf8'), /update stdout/)
  assert.match(readFileSync(updateLogFile, 'utf8'), /installation method error/)
})

test('Codex update warning remains nonblocking when captured output cannot be read', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const helperStart = source.indexOf('report_codex_update_warning()')
  const helperEnd = source.indexOf('\nconfirm_codex_cli_update()', helperStart)
  const helper = source.slice(helperStart, helperEnd)
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-codex-warning-read-'))
  const updateLogFile = path.join(root, 'codex-update.log')
  writeFileSync(updateLogFile, 'captured updater output\n')

  const shell = [
    'set -euo pipefail',
    'agent_detail() { :; }',
    'cat() { printf "simulated read failure\\n" >&2; return 1; }',
    helper,
    'report_codex_update_warning "Codex CLI 升级失败（状态码：42）。" "$1"',
    'printf "startup-continued"',
  ].join('\n')
  const result = spawnSync('bash', ['-c', shell, 'bash', updateLogFile], { encoding: 'utf8' })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /startup-continued$/)
  assert.match(result.stderr, /simulated read failure/)
  assert.match(result.stderr, /无法读取 Codex CLI 升级输出/)
  assert.match(result.stderr, /已忽略本次升级失败，继续后续启动流程/)
})

test('Codex update lock timeout reports diagnostics and continues startup', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const helperStart = source.indexOf('codex_cli_version()')
  const helperEnd = source.indexOf('\nrun_codex_login_status()', helperStart)
  const helpers = source.slice(helperStart, helperEnd)
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-codex-lock-timeout-'))
  const fakeCodex = path.join(root, 'codex')
  const updateMarker = path.join(root, 'update-attempted')
  const logFile = path.join(root, 'one-click.log')
  writeFileSync(fakeCodex, `#!/usr/bin/env bash
case "$1" in
  --version) printf 'codex-cli 1.2.3\\n' ;;
  update) touch ${JSON.stringify(updateMarker)} ;;
esac
`)
  chmodSync(fakeCodex, 0o755)

  const shell = [
    'set -euo pipefail',
    'AGENT="codex"',
    'CODEX_AUTO_UPDATE="true"',
    'CODEX_UPDATE_LOCK_DIR="$1/update.lock"',
    'ONE_CLICK_RUN_ID="test-$$"',
    'ONE_CLICK_LOG="$1/one-click.log"',
    'FAKE_CODEX="$2"',
    'resolve_codex_cli_for_acp() { printf "%s\\n" "$FAKE_CODEX"; }',
    'agent_detail() { :; }',
    'agent_log() { printf "%s\\n" "$*"; }',
    'write_one_click_log() { :; }',
    'agent_fail() { printf "%s\\n" "$*" >&2; exit 1; }',
    'release_dir_lock() { :; }',
    helpers,
    'acquire_codex_update_lock() { return 1; }',
    'resolve_latest_codex_cli_version() { printf "9.9.9\\n"; }',
    'confirm_codex_cli_update() { return 0; }',
    'ensure_codex_cli_updated',
    'printf "startup-continued"',
  ].join('\n')
  const result = spawnSync('bash', ['-c', shell, 'bash', root, fakeCodex], { encoding: 'utf8' })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /startup-continued$/)
  assert.match(result.stderr, /Codex CLI 升级失败（状态码：75）/)
  assert.match(result.stderr, /无法获取 Codex CLI 升级锁/)
  assert.match(readFileSync(logFile, 'utf8'), /无法获取 Codex CLI 升级锁/)
  assert.equal(existsSync(updateMarker), false)
})

test('declining a newer Codex update skips updating and continues startup', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const helperStart = source.indexOf('codex_cli_version()')
  const helperEnd = source.indexOf('\nrun_codex_login_status()', helperStart)
  const helpers = source.slice(helperStart, helperEnd)
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-codex-decline-'))
  const fakeCodex = path.join(root, 'codex')
  const updateMarker = path.join(root, 'update-attempted')
  writeFileSync(fakeCodex, `#!/usr/bin/env bash
case "$1" in
  --version) printf 'codex-cli 1.2.3\\n' ;;
  update) touch ${JSON.stringify(updateMarker)} ;;
esac
`)
  chmodSync(fakeCodex, 0o755)

  const shell = [
    'set -euo pipefail',
    'AGENT="codex"',
    'CODEX_AUTO_UPDATE="true"',
    'CODEX_UPDATE_LOCK_DIR="$1/update.lock"',
    'ONE_CLICK_RUN_ID="test-$$"',
    'ONE_CLICK_LOG="$1/one-click.log"',
    'FAKE_CODEX="$2"',
    'resolve_codex_cli_for_acp() { printf "%s\\n" "$FAKE_CODEX"; }',
    'agent_detail() { :; }',
    'agent_log() { printf "%s\\n" "$*"; }',
    'write_one_click_log() { :; }',
    'agent_fail() { printf "%s\\n" "$*" >&2; exit 1; }',
    'release_dir_lock() { command rm -f "$1/owner"; command rmdir "$1"; }',
    helpers,
    'resolve_latest_codex_cli_version() { printf "9.9.9\\n"; }',
    'confirm_codex_cli_update() { return 1; }',
    'ensure_codex_cli_updated',
    'printf "startup-continued"',
  ].join('\n')
  const result = spawnSync('bash', ['-c', shell, 'bash', root, fakeCodex], { encoding: 'utf8' })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /已跳过 Codex CLI 升级，继续使用当前版本/)
  assert.match(result.stdout, /startup-continued$/)
  assert.equal(existsSync(updateMarker), false)
})

test('Codex update confirmation fails when no interactive terminal is available', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const helperStart = source.indexOf('confirm_codex_cli_update()')
  const helperEnd = source.indexOf('\nensure_codex_cli_updated()', helperStart)
  const helper = source.slice(helperStart, helperEnd)
  assert.match(helper, /AAMP_CODEX_UPDATE_TTY/)

  const root = mkdtempSync(path.join(tmpdir(), 'aamp-codex-no-tty-'))
  const output = execFileSync('bash', ['-c', `
set -euo pipefail
AAMP_CODEX_UPDATE_TTY="$1/missing-tty"
${helper}
set +e
confirm_codex_cli_update 2>/dev/null
status=$?
set -e
printf '%s' "$status"
`, 'bash', root], { encoding: 'utf8' })

  assert.equal(output, '2')
})

test('Codex update confirmation unavailable skips updating and continues startup', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const helperStart = source.indexOf('codex_cli_version()')
  const helperEnd = source.indexOf('\nrun_codex_login_status()', helperStart)
  const helpers = source.slice(helperStart, helperEnd)
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-codex-no-confirmation-'))
  const fakeCodex = path.join(root, 'codex')
  const updateMarker = path.join(root, 'update-attempted')
  writeFileSync(fakeCodex, `#!/usr/bin/env bash
case "$1" in
  --version) printf 'codex-cli 1.2.3\\n' ;;
  update) touch ${JSON.stringify(updateMarker)} ;;
esac
`)
  chmodSync(fakeCodex, 0o755)

  const shell = [
    'set -euo pipefail',
    'AGENT="codex"',
    'CODEX_AUTO_UPDATE="true"',
    'CODEX_UPDATE_LOCK_DIR="$1/update.lock"',
    'ONE_CLICK_RUN_ID="test-$$"',
    'ONE_CLICK_LOG="$1/one-click.log"',
    'FAKE_CODEX="$2"',
    'resolve_codex_cli_for_acp() { printf "%s\\n" "$FAKE_CODEX"; }',
    'agent_detail() { :; }',
    'agent_log() { printf "%s\\n" "$*"; }',
    'write_one_click_log() { :; }',
    'agent_fail() { printf "%s\\n" "$*" >&2; exit 1; }',
    'release_dir_lock() { command rm -f "$1/owner"; command rmdir "$1"; }',
    helpers,
    'resolve_latest_codex_cli_version() { printf "9.9.9\\n"; }',
    'confirm_codex_cli_update() { return 2; }',
    'ensure_codex_cli_updated',
    'printf "startup-continued"',
  ].join('\n')
  const result = spawnSync('bash', ['-c', shell, 'bash', root, fakeCodex], { encoding: 'utf8' })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /无法读取 Codex CLI 升级确认，已跳过升级并继续使用当前版本/)
  assert.match(result.stdout, /startup-continued$/)
  assert.equal(existsSync(updateMarker), false)
})

test('Codex update exit zero without an actual version change warns and continues startup', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const helperStart = source.indexOf('codex_cli_version()')
  const helperEnd = source.indexOf('\nrun_codex_login_status()', helperStart)
  const helpers = source.slice(helperStart, helperEnd)
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-codex-confirm-'))
  const fakeCodex = path.join(root, 'codex')
  const updateMarker = path.join(root, 'update-attempted')
  writeFileSync(fakeCodex, `#!/usr/bin/env bash
case "$1" in
  --version) printf 'codex-cli 1.2.3\\n' ;;
  update) touch ${JSON.stringify(updateMarker)}; printf 'update completed without replacement\\n' ;;
esac
`)
  chmodSync(fakeCodex, 0o755)

  const shell = [
    'set -euo pipefail',
    'AGENT="codex"',
    'CODEX_AUTO_UPDATE="true"',
    'CODEX_UPDATE_LOCK_DIR="$1/update.lock"',
    'ONE_CLICK_RUN_ID="test-$$"',
    'ONE_CLICK_LOG="$1/one-click.log"',
    'FAKE_CODEX="$2"',
    'resolve_codex_cli_for_acp() { printf "%s\\n" "$FAKE_CODEX"; }',
    'agent_detail() { :; }',
    'agent_log() { printf "%s\\n" "$*"; }',
    'write_one_click_log() { :; }',
    'agent_fail() { printf "%s\\n" "$*" >&2; exit 1; }',
    'release_dir_lock() { command rm -f "$1/owner"; command rmdir "$1"; }',
    helpers,
    'resolve_latest_codex_cli_version() { printf "9.9.9\\n"; }',
    'confirm_codex_cli_update() { return 0; }',
    'ensure_codex_cli_updated',
    'printf "startup-continued"',
  ].join('\n')
  const result = spawnSync('bash', ['-c', shell, 'bash', root, fakeCodex], { encoding: 'utf8' })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /startup-continued$/)
  assert.match(result.stderr, /Codex CLI 升级未生效/)
  assert.match(result.stderr, /update completed without replacement/)
  assert.match(result.stderr, /已忽略本次升级失败，继续后续启动流程/)
  assert.equal(existsSync(updateMarker), true)
})

test('Codex update with an unreadable resulting version warns and continues startup', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const helperStart = source.indexOf('codex_cli_version()')
  const helperEnd = source.indexOf('\nrun_codex_login_status()', helperStart)
  const helpers = source.slice(helperStart, helperEnd)
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-codex-unverifiable-'))
  const fakeCodex = path.join(root, 'codex')
  const updateMarker = path.join(root, 'update-attempted')
  writeFileSync(fakeCodex, `#!/usr/bin/env bash
case "$1" in
  --version)
    if [ -f ${JSON.stringify(updateMarker)} ]; then
      printf 'codex-cli unknown\\n'
    else
      printf 'codex-cli 1.2.3\\n'
    fi
    ;;
  update) touch ${JSON.stringify(updateMarker)}; printf 'replacement output\\n' ;;
esac
`)
  chmodSync(fakeCodex, 0o755)

  const shell = [
    'set -euo pipefail',
    'AGENT="codex"',
    'CODEX_AUTO_UPDATE="true"',
    'CODEX_UPDATE_LOCK_DIR="$1/update.lock"',
    'ONE_CLICK_RUN_ID="test-$$"',
    'ONE_CLICK_LOG="$1/one-click.log"',
    'FAKE_CODEX="$2"',
    'resolve_codex_cli_for_acp() { printf "%s\\n" "$FAKE_CODEX"; }',
    'agent_detail() { :; }',
    'agent_log() { printf "%s\\n" "$*"; }',
    'write_one_click_log() { :; }',
    'agent_fail() { printf "%s\\n" "$*" >&2; exit 1; }',
    'release_dir_lock() { command rm -f "$1/owner"; command rmdir "$1"; }',
    helpers,
    'resolve_latest_codex_cli_version() { printf "9.9.9\\n"; }',
    'confirm_codex_cli_update() { return 0; }',
    'ensure_codex_cli_updated',
    'printf "startup-continued"',
  ].join('\n')
  const result = spawnSync('bash', ['-c', shell, 'bash', root, fakeCodex], { encoding: 'utf8' })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /startup-continued$/)
  assert.match(result.stderr, /无法验证 Codex CLI 升级结果/)
  assert.match(result.stderr, /replacement output/)
  assert.match(result.stderr, /已忽略本次升级失败，继续后续启动流程/)
  assert.equal(existsSync(updateMarker), true)
})

test('confirming a newer Codex update continues after the installed version changes', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const helperStart = source.indexOf('codex_cli_version()')
  const helperEnd = source.indexOf('\nrun_codex_login_status()', helperStart)
  const helpers = source.slice(helperStart, helperEnd)
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-codex-confirm-updated-'))
  const fakeCodex = path.join(root, 'codex')
  const updateMarker = path.join(root, 'update-attempted')
  const logFile = path.join(root, 'one-click.log')
  writeFileSync(fakeCodex, `#!/usr/bin/env bash
case "$1" in
  --version)
    if [ -f ${JSON.stringify(updateMarker)} ]; then
      printf 'codex-cli 9.9.9\\n'
    else
      printf 'codex-cli 1.2.3\\n'
    fi
    ;;
  update)
    touch ${JSON.stringify(updateMarker)}
    printf 'successful update stdout\\n'
    printf 'successful update stderr\\n' >&2
    ;;
esac
`)
  chmodSync(fakeCodex, 0o755)

  const shell = [
    'set -euo pipefail',
    'AGENT="codex"',
    'CODEX_AUTO_UPDATE="true"',
    'CODEX_UPDATE_LOCK_DIR="$1/update.lock"',
    'ONE_CLICK_RUN_ID="test-$$"',
    'ONE_CLICK_LOG="$1/one-click.log"',
    'FAKE_CODEX="$2"',
    'resolve_codex_cli_for_acp() { printf "%s\\n" "$FAKE_CODEX"; }',
    'agent_detail() { :; }',
    'agent_log() { printf "%s\\n" "$*"; }',
    'write_one_click_log() { :; }',
    'agent_fail() { printf "%s\\n" "$*" >&2; exit 1; }',
    'release_dir_lock() { command rm -f "$1/owner"; command rmdir "$1"; }',
    helpers,
    'resolve_latest_codex_cli_version() { printf "9.9.9\\n"; }',
    'confirm_codex_cli_update() { return 0; }',
    'ensure_codex_cli_updated',
    'printf "startup-continued"',
  ].join('\n')
  const result = spawnSync('bash', ['-c', shell, 'bash', root, fakeCodex], { encoding: 'utf8' })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /startup-continued$/)
  assert.doesNotMatch(result.stdout, /successful update stdout|successful update stderr/)
  assert.doesNotMatch(result.stderr, /successful update stdout|successful update stderr/)
  assert.match(readFileSync(logFile, 'utf8'), /successful update stdout/)
  assert.match(readFileSync(logFile, 'utf8'), /successful update stderr/)
  assert.equal(existsSync(updateMarker), true)
})

test('Codex update is skipped when the selected CLI is already latest', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const helperStart = source.indexOf('codex_cli_version()')
  const helperEnd = source.indexOf('\nrun_codex_login_status()', helperStart)
  const helpers = source.slice(helperStart, helperEnd)
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-codex-current-'))
  const fakeCodex = path.join(root, 'codex')
  const updateMarker = path.join(root, 'update-attempted')
  const logFile = path.join(root, 'one-click.log')
  const detailFile = path.join(root, 'details.log')

  writeFileSync(fakeCodex, [
    '#!/usr/bin/env bash',
    'case "$1" in',
    '  --version) printf "codex-cli 1.2.3\\n" ;;',
    `  update) printf "attempted\\n" >${JSON.stringify(updateMarker)} ;;`,
    'esac',
    '',
  ].join('\n'))
  chmodSync(fakeCodex, 0o755)

  const shell = [
    'set -euo pipefail',
    'AGENT="codex"',
    'CODEX_AUTO_UPDATE="true"',
    'CODEX_UPDATE_LOCK_DIR="$1/update.lock"',
    'ONE_CLICK_RUN_ID="test-$$"',
    'ONE_CLICK_LOG="$2"',
    'DETAIL_FILE="$3"',
    'FAKE_CODEX="$4"',
    'resolve_codex_cli_for_acp() { printf "%s\\n" "$FAKE_CODEX"; }',
    'agent_detail() { printf "%s\\n" "$*" >>"$DETAIL_FILE"; }',
    'agent_log() { printf "[aamp-one-click] %s\\n" "$*"; }',
    'write_one_click_log() { printf "%s\\n" "$*" >>"$DETAIL_FILE"; }',
    'release_dir_lock() { command rm -f "$1/owner"; command rmdir "$1"; }',
    helpers,
    'resolve_latest_codex_cli_version() { printf "1.2.3\\n"; }',
    'ensure_codex_cli_updated',
  ].join('\n')
  const output = execFileSync(
    'bash',
    ['-c', shell, 'bash', root, logFile, detailFile, fakeCodex],
    { encoding: 'utf8' },
  )

  assert.doesNotMatch(output, /当前 Codex CLI 版本是：1\.2\.3，最新版本是：1\.2\.3/)
  assert.doesNotMatch(output, /正在更新 Codex CLI/)
  assert.match(readFileSync(detailFile, 'utf8'), /Codex CLI is already current: current=1\.2\.3 latest=1\.2\.3/)
  assert.equal(existsSync(updateMarker), false)
})

test('Codex latest-version lookup is cached while the installed version is unchanged', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const helperStart = source.indexOf('codex_cli_version()')
  const helperEnd = source.indexOf('\nrun_codex_login_status()', helperStart)
  const helpers = source.slice(helperStart, helperEnd)
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-codex-update-cache-'))
  const fakeCodex = path.join(root, 'codex')
  const lookupMarker = path.join(root, 'registry-lookups')
  const cacheFile = path.join(root, 'cache.json')
  const detailFile = path.join(root, 'details.log')

  writeFileSync(fakeCodex, '#!/usr/bin/env bash\nprintf "codex-cli 1.2.3\\n"\n')
  chmodSync(fakeCodex, 0o755)

  const shell = [
    'set -euo pipefail',
    'AGENT="codex"',
    'CODEX_AUTO_UPDATE="true"',
    'CODEX_NPM_PACKAGE="@openai/codex"',
    'CODEX_UPDATE_CACHE_FILE="$1/cache.json"',
    'CODEX_UPDATE_CACHE_TTL_SECONDS="86400"',
    'ONE_CLICK_LOG="$1/one-click.log"',
    'DETAIL_FILE="$1/details.log"',
    'LOOKUP_MARKER="$1/registry-lookups"',
    'FAKE_CODEX="$1/codex"',
    'resolve_codex_cli_for_acp() { printf "%s\\n" "$FAKE_CODEX"; }',
    'agent_detail() { printf "%s\\n" "$*" >>"$DETAIL_FILE"; }',
    'write_one_click_log() { :; }',
    helpers,
    'resolve_latest_codex_cli_version() { printf "lookup\\n" >>"$LOOKUP_MARKER"; printf "1.2.3\\n"; }',
    'ensure_codex_cli_updated',
    'ensure_codex_cli_updated',
  ].join('\n')
  const result = spawnSync('bash', ['-c', shell, 'bash', root], { encoding: 'utf8' })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(lookupMarker, 'utf8').trim().split(/\n/).length, 1)
  assert.match(readFileSync(detailFile, 'utf8'), /Codex CLI update check cache is fresh/)
  const cache = JSON.parse(readFileSync(cacheFile, 'utf8'))
  assert.equal(cache.current_version, '1.2.3')
  assert.equal(cache.latest_version, '1.2.3')
  assert.equal(cache.package, '@openai/codex')
  assert.equal(cache.registry, 'https://registry.npmjs.org/')
})

test('Codex latest-version cache invalidates on version, registry, and malformed data', () => {
  const source = readFileSync(bootstrap, 'utf8')
  const helperStart = source.indexOf('codex_cli_version()')
  const helperEnd = source.indexOf('\nrun_codex_login_status()', helperStart)
  const helpers = source.slice(helperStart, helperEnd)
  const root = mkdtempSync(path.join(tmpdir(), 'aamp-codex-update-cache-version-'))
  const fakeCodex = path.join(root, 'codex')
  const versionFile = path.join(root, 'version')
  const lookupMarker = path.join(root, 'registry-lookups')

  writeFileSync(versionFile, '1.2.3\n')
  writeFileSync(fakeCodex, '#!/usr/bin/env bash\nprintf "codex-cli %s\\n" "$(cat "$VERSION_FILE")"\n')
  chmodSync(fakeCodex, 0o755)

  const shell = [
    'set -euo pipefail',
    'AGENT="codex"',
    'CODEX_AUTO_UPDATE="true"',
    'CODEX_NPM_PACKAGE="@openai/codex"',
    'NPM_REGISTRY="https://registry-one.example/"',
    'CODEX_UPDATE_CACHE_FILE="$1/cache.json"',
    'CODEX_UPDATE_CACHE_TTL_SECONDS="86400"',
    'ONE_CLICK_LOG="$1/one-click.log"',
    'VERSION_FILE="$1/version"',
    'LOOKUP_MARKER="$1/registry-lookups"',
    'FAKE_CODEX="$1/codex"',
    'export VERSION_FILE',
    'resolve_codex_cli_for_acp() { printf "%s\\n" "$FAKE_CODEX"; }',
    'agent_detail() { :; }',
    'write_one_click_log() { :; }',
    helpers,
    'resolve_latest_codex_cli_version() { printf "lookup\\n" >>"$LOOKUP_MARKER"; cat "$VERSION_FILE"; }',
    'ensure_codex_cli_updated',
    'printf "1.2.4\\n" >"$VERSION_FILE"',
    'ensure_codex_cli_updated',
    'NPM_REGISTRY="https://registry-two.example/"',
    'ensure_codex_cli_updated',
    `CACHE_FILE="$CODEX_UPDATE_CACHE_FILE" node -e 'const fs=require("fs");const value=JSON.parse(fs.readFileSync(process.env.CACHE_FILE,"utf8"));value.latest_version={};fs.writeFileSync(process.env.CACHE_FILE,JSON.stringify(value));'`,
    'ensure_codex_cli_updated',
  ].join('\n')
  const result = spawnSync('bash', ['-c', shell, 'bash', root], { encoding: 'utf8' })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(lookupMarker, 'utf8').trim().split(/\n/).length, 4)
  const cache = JSON.parse(readFileSync(path.join(root, 'cache.json'), 'utf8'))
  assert.equal(cache.current_version, '1.2.4')
  assert.equal(cache.latest_version, '1.2.4')
  assert.equal(cache.registry, 'https://registry-two.example/')
})
