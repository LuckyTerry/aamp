import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  KNOWN_AGENTS,
  WORKBUDDY_AI_APP_CLI,
  WORKBUDDY_APP_CLI,
  defaultAcpCommand,
  defaultAgentCommand,
  detectKnownAgent,
  findExecutableOnPath,
  missingAgentWarning,
} from '../src/agent-resolver.js'
import { expectedFakePathVersion, withFakePath } from './path-fixture.js'

function parseAcpCommand(command: string): string[] {
  const parsed = spawnSync('bash', [
    '-c',
    'eval "set -- $1"; printf "%s\\0" "$@"',
    'bash',
    command,
  ], { encoding: 'buffer' })

  assert.equal(parsed.status, 0, parsed.stderr.toString())
  return parsed.stdout.toString().split('\0').filter(Boolean)
}

test('registers canonical Traex and TraeCode CLI names', () => {
  for (const name of ['traex', 'traecli']) {
    assert.equal(KNOWN_AGENTS.filter((candidate) => candidate === name).length, 1)
  }
  for (const nonNativeName of ['trae', 'coco']) {
    assert.equal(KNOWN_AGENTS.some((name) => name === nonNativeName), false)
  }
})

test('detects native TraeCode CLI and maps its ACP command', () => {
  withFakePath([{ name: 'traecli', version: 'trae-cli version 0.120.52' }], () => {
    assert.deepEqual(detectKnownAgent('traecli'), {
      command: 'traecli',
      acpCommand: 'traecli acp serve',
      version: expectedFakePathVersion('trae-cli version 0.120.52'),
    })
    assert.equal(defaultAgentCommand('traecli'), 'traecli')
    assert.equal(defaultAcpCommand('traecli'), 'traecli acp serve')
  })
})

test('TraeCode CLI never falls back to internal Traex or Coco commands', () => {
  withFakePath([
    { name: 'traex', version: 'internal next' },
    { name: 'coco', version: 'internal legacy' },
  ], () => {
    assert.equal(detectKnownAgent('traecli'), undefined)
    assert.equal(defaultAgentCommand('traecli'), 'traecli')
    assert.equal(defaultAcpCommand('traecli'), 'traecli acp serve')
    assert.equal(missingAgentWarning('traecli'), 'traecli was not found on PATH.')
  })
})

test('detects native traex and maps its ACP command', () => {
  withFakePath([{ name: 'traex', version: 'traecli 0.200.19' }], () => {
    assert.deepEqual(detectKnownAgent('traex'), {
      command: 'traex',
      acpCommand: 'traex acp serve',
      version: expectedFakePathVersion('traecli 0.200.19'),
    })
    assert.equal(defaultAgentCommand('traex'), 'traex')
    assert.equal(defaultAcpCommand('traex'), 'traex acp serve')
  })
})

test('does not fall back from traex to traecli or coco', () => {
  withFakePath([
    { name: 'traecli', version: 'legacy' },
    { name: 'coco', version: 'legacy' },
  ], () => {
    assert.equal(detectKnownAgent('traex'), undefined)
    assert.equal(defaultAcpCommand('traex'), 'traex acp serve')
    assert.equal(missingAgentWarning('traex'), 'traex was not found on PATH.')
  })
})

test('registers WorkBuddy and WorkBuddy AI as distinct canonical agents', () => {
  assert.equal(KNOWN_AGENTS.filter((name) => name === 'workbuddy').length, 1)
  assert.equal(KNOWN_AGENTS.filter((name) => name === 'workbuddy_ai').length, 1)
  for (const alias of ['workbuddy ai', 'workbuddy-ai', 'workbuddyai']) {
    assert.equal(KNOWN_AGENTS.includes(alias), false)
  }
})

test('WorkBuddy products launch ACP with isolated config and no Marketplace initialization', { skip: process.platform === 'win32' ? 'macOS WorkBuddy command contract requires a POSIX shell; Windows detection remains unavailable' : false }, () => {
  const cases = [
    ['workbuddy', join(homedir(), '.workbuddy'), WORKBUDDY_APP_CLI],
    ['workbuddy_ai', join(homedir(), '.workbuddy-ai'), WORKBUDDY_AI_APP_CLI],
  ] as const

  for (const [name, configDir, cli] of cases) {
    assert.deepEqual(parseAcpCommand(defaultAcpCommand(name)), [
      'env',
      `CODEBUDDY_CONFIG_DIR=${configDir}`,
      'CODEBUDDY_SKIP_BUILTIN_MARKETPLACE=1',
      cli,
      '--acp',
    ])
  }
})

test('migrates exact legacy WorkBuddy defaults and preserves custom commands', () => {
  const cases = [
    ['workbuddy', `${WORKBUDDY_APP_CLI} --acp`],
    ['workbuddy_ai', `'${WORKBUDDY_AI_APP_CLI}' --acp`],
  ] as const

  for (const [name, legacyCommand] of cases) {
    assert.equal(defaultAcpCommand(name, legacyCommand), defaultAcpCommand(name))
    const customCommand = `${legacyCommand} --model custom`
    assert.equal(defaultAcpCommand(name, customCommand), customCommand)
  }
})

test('migrates WorkBuddy defaults created before the Marketplace bypass', () => {
  for (const name of ['workbuddy', 'workbuddy_ai']) {
    const currentCommand = defaultAcpCommand(name)
    const previousGeneratedCommand = currentCommand.replace(
      ' CODEBUDDY_SKIP_BUILTIN_MARKETPLACE=1',
      '',
    )

    assert.notEqual(previousGeneratedCommand, currentCommand)
    assert.equal(defaultAcpCommand(name, previousGeneratedCommand), currentCommand)
  }
})

test('resolves WorkBuddy AI only from its international macOS bundle', () => {
  const seen: string[] = []
  const resolution = detectKnownAgent('workbuddy_ai', {
    platform: 'darwin',
    pathIsExecutable: (candidate) => {
      seen.push(candidate)
      return candidate === WORKBUDDY_AI_APP_CLI
    },
    versionFor: () => '2.115.0',
  })

  assert.deepEqual(resolution, {
    command: WORKBUDDY_AI_APP_CLI,
    acpCommand: defaultAcpCommand('workbuddy_ai'),
    version: '2.115.0',
  })
  assert.deepEqual(seen, [WORKBUDDY_AI_APP_CLI])
  assert.notEqual(WORKBUDDY_AI_APP_CLI, WORKBUDDY_APP_CLI)
})

test('WorkBuddy AI ACP command keeps the application path as one shell word', {
  skip: process.platform === 'win32',
}, () => {
  const resolution = detectKnownAgent('workbuddy_ai', {
    platform: 'darwin',
    pathIsExecutable: (candidate) => candidate === WORKBUDDY_AI_APP_CLI,
    versionFor: () => '2.115.0',
  })
  assert.ok(resolution)

  assert.deepEqual(
    parseAcpCommand(resolution.acpCommand),
    [
      'env',
      `CODEBUDDY_CONFIG_DIR=${join(homedir(), '.workbuddy-ai')}`,
      'CODEBUDDY_SKIP_BUILTIN_MARKETPLACE=1',
      WORKBUDDY_AI_APP_CLI,
      '--acp',
    ],
  )
})

test('WorkBuddy products do not fall back to each other', () => {
  assert.equal(detectKnownAgent('workbuddy_ai', {
    platform: 'darwin',
    pathIsExecutable: (candidate) => candidate === WORKBUDDY_APP_CLI,
  }), undefined)
  assert.equal(detectKnownAgent('workbuddy', {
    platform: 'darwin',
    pathIsExecutable: (candidate) => candidate === WORKBUDDY_AI_APP_CLI,
  }), undefined)
})

test('WorkBuddy AI warnings name the international product and exact path', () => {
  assert.equal(
    missingAgentWarning('workbuddy_ai', { platform: 'darwin' }),
    `WorkBuddy AI was not found at ${WORKBUDDY_AI_APP_CLI}.`,
  )
  assert.equal(
    missingAgentWarning('workbuddy_ai', { platform: 'linux' }),
    'WorkBuddy AI auto-detection is only supported on macOS; configure acpCommand explicitly.',
  )
})

test('resolves an executable standard macOS WorkBuddy app', () => {
  assert.deepEqual(detectKnownAgent('workbuddy', {
    platform: 'darwin',
    pathIsExecutable: (candidate) => candidate === WORKBUDDY_APP_CLI,
    versionFor: () => '2.115.0',
  }), {
    command: WORKBUDDY_APP_CLI,
    acpCommand: defaultAcpCommand('workbuddy'),
    version: '2.115.0',
  })
})

test('requires an executable WorkBuddy app and reports platform-specific guidance', () => {
  assert.equal(detectKnownAgent('workbuddy', {
    platform: 'darwin',
    pathIsExecutable: () => false,
  }), undefined)
  assert.equal(
    missingAgentWarning('workbuddy', { platform: 'darwin' }),
    `WorkBuddy was not found at ${WORKBUDDY_APP_CLI}.`,
  )
  assert.equal(detectKnownAgent('workbuddy', {
    platform: 'linux',
    pathIsExecutable: () => true,
  }), undefined)
  assert.equal(
    missingAgentWarning('workbuddy', { platform: 'linux' }),
    'WorkBuddy auto-detection is only supported on macOS; configure acpCommand explicitly.',
  )
})

test('keeps detection when an executable cannot report a version', () => {
  assert.equal(expectedFakePathVersion('traecli 0.200.19', 'win32'), 'installed')
  assert.equal(expectedFakePathVersion('traecli 0.200.19', 'linux'), 'traecli 0.200.19')

  withFakePath([{ name: 'traex', version: 'unavailable', versionExitCode: 1 }], () => {
    assert.deepEqual(detectKnownAgent('traex'), {
      command: 'traex',
      acpCommand: 'traex acp serve',
      version: 'installed',
    })
  })
})

test('preserves explicit commands and representative existing mappings', () => {
  withFakePath([
    { name: 'claude', version: 'claude 1.0.0' },
    { name: 'hermes', version: 'hermes 1.0.0' },
  ], () => {
    assert.deepEqual(detectKnownAgent('claude'), {
      command: 'claude',
      acpCommand: 'claude',
      version: expectedFakePathVersion('claude 1.0.0'),
    })
    assert.deepEqual(detectKnownAgent('hermes'), {
      command: 'hermes',
      acpCommand: 'hermes acp',
      version: expectedFakePathVersion('hermes 1.0.0'),
    })
    assert.equal(defaultAcpCommand('codex', 'npx -y custom-codex-acp'), 'npx -y custom-codex-acp')
    assert.equal(defaultAcpCommand('workbuddy', 'custom-codebuddy --acp'), 'custom-codebuddy --acp')
    assert.equal(defaultAcpCommand('trae', 'traex acp serve'), 'traex acp serve')
  })
})

test('ignores blank commands and preserves quoted commands verbatim', () => {
  withFakePath([{ name: 'traex', version: 'traecli 0.200.19' }], () => {
    assert.equal(defaultAcpCommand('traex', ''), 'traex acp serve')
    assert.equal(defaultAcpCommand('traex', '   '), 'traex acp serve')
    const customCommand = '  traex acp serve --model "doubao pro"  '
    assert.equal(defaultAcpCommand('traex', customCommand), customCommand)
  })
})

test('POSIX lookup requires an executable file on PATH', {
  skip: process.platform === 'win32',
}, () => {
  withFakePath([{ name: 'traex', version: 'traecli 0.200.19', executable: false }], (directory) => {
    assert.equal(findExecutableOnPath('traex', {
      platform: 'linux',
      env: { PATH: directory },
    }), undefined)
  })
})

test('Windows lookup honors PATHEXT and already-suffixed commands', () => {
  withFakePath([
    { name: 'traex.CMD', version: 'traecli 0.200.19' },
    { name: 'traecli.CMD', version: 'trae-cli version 0.120.52' },
    { name: 'claude.EXE', version: 'claude 1.0.0' },
  ], (directory) => {
    const env = { PATH: directory, PATHEXT: '.EXE;.CMD' }
    assert.equal(findExecutableOnPath('traex', { platform: 'win32', env }), join(directory, 'traex.CMD'))
    assert.equal(findExecutableOnPath('traex.CMD', { platform: 'win32', env }), join(directory, 'traex.CMD'))
    assert.equal(findExecutableOnPath('claude', {
      platform: 'win32',
      env: { Path: directory },
    }), join(directory, 'claude.EXE'))
  })
})

test('Windows lookup discovers canonical TraeCode wrappers through PATHEXT', () => {
  withFakePath([{ name: 'traecli.CMD', version: 'trae-cli version 0.120.52' }], (directory) => {
    const env = { PATH: directory, PATHEXT: '.EXE;.CMD' }
    assert.equal(
      findExecutableOnPath('traecli', { platform: 'win32', env }),
      join(directory, 'traecli.CMD'),
    )
  })
})
