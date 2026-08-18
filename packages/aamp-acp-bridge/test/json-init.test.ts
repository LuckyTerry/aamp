import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/config.js'
import { runJsonInit } from '../src/json-init.js'
import {
  defaultAcpCommand,
  WORKBUDDY_AI_APP_CLI,
  WORKBUDDY_APP_CLI,
} from '../src/agent-resolver.js'
import { resolvePairingFile } from '../src/pairing.js'

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const cliPath = join(packageDirectory, 'src', 'index.ts')

function runCli(
  directory: string,
  args: string[],
  input?: unknown,
  environment: NodeJS.ProcessEnv = {},
) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', cliPath, ...args], {
    cwd: packageDirectory,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: directory,
      USERPROFILE: directory,
      ...environment,
    },
    ...(input === undefined ? {} : { input: JSON.stringify(input) }),
  })
  assert.equal(result.status, 0, result.stderr)
  return result
}

function withCliFixture(name: string, run: (fixture: {
  directory: string
  configPath: string
  remoteCredentialsFile: string
  localCredentialsFile: string
  remotePairingFile: string
  localPairingFile: string
  remoteCommand: string
  localCommand: string
}) => void): void {
  const directory = mkdtempSync(join(tmpdir(), `aamp-${name}-public-cli-`))
  const configPath = join(directory, 'CONFIG_PATH_SENTINEL.json')
  const remoteCredentialsFile = join(directory, 'REMOTE_CREDENTIAL_PATH_SENTINEL.json')
  const localCredentialsFile = join(directory, 'local-credentials.json')
  const remotePairingFile = join(directory, 'REMOTE_PAIRING_PATH_SENTINEL.json')
  const localPairingFile = join(directory, 'local-pairing.json')
  const remoteCommand = "'/Users/private/REMOTE_COMMAND_SENTINEL' --acp"
  const localCommand = 'LOCAL_COMMAND_SENTINEL acp'
  writeFileSync(remoteCredentialsFile, JSON.stringify({
    email: 'aime@example.com',
    smtpPassword: 'remote-fixture-password',
  }))
  writeFileSync(localCredentialsFile, JSON.stringify({
    email: 'codex@example.com',
    smtpPassword: 'local-fixture-password',
  }))
  writeFileSync(configPath, JSON.stringify({
    aampHost: 'https://meshmail.ai',
    rejectUnauthorized: false,
    agents: [
      {
        name: 'aime',
        acpCommand: remoteCommand,
        credentialsFile: remoteCredentialsFile,
        pairingFile: remotePairingFile,
        attachmentPolicy: 'reject',
        executionLocation: 'remote',
      },
      {
        name: 'codex',
        acpCommand: localCommand,
        credentialsFile: localCredentialsFile,
        pairingFile: localPairingFile,
      },
    ],
  }))

  try {
    run({
      directory,
      configPath,
      remoteCredentialsFile,
      localCredentialsFile,
      remotePairingFile,
      localPairingFile,
      remoteCommand,
      localCommand,
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function withCredentials(name: string, run: (paths: {
  directory: string
  configPath: string
  credentialsFile: string
}) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), `aamp-${name}-json-init-`))
  const configPath = join(directory, 'config.json')
  const credentialsFile = join(directory, `${name}-credentials.json`)
  writeFileSync(credentialsFile, JSON.stringify({
    email: `${name}@example.com`,
    smtpPassword: 'fixture-password',
  }))

  return run({ directory, configPath, credentialsFile })
    .finally(() => rmSync(directory, { recursive: true, force: true }))
}

test('JSON init supplies the native traex ACP command', async () => {
  await withCredentials('traex', async ({ configPath, credentialsFile }) => {
    const result = await runJsonInit(configPath, {
      agents: [{ name: 'traex', credentialsFile }],
    })

    assert.equal(result.configPath, configPath)
    assert.equal('configPathConfigured' in result, false)
    assert.equal(result.agents[0].acpCommand, 'traex acp serve')
    assert.equal(result.agents[0].registered, false)
    const written = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(written.agents[0].name, 'traex')
    assert.equal(written.agents[0].acpCommand, 'traex acp serve')
    assert.equal(written.agents[0].slug, 'traex-bridge')
  })
})

test('JSON init supplies the native TraeCode CLI ACP command', async () => {
  await withCredentials('traecli', async ({ configPath, credentialsFile }) => {
    const result = await runJsonInit(configPath, {
      agents: [{ name: 'traecli', credentialsFile }],
    })

    assert.equal(result.agents[0].acpCommand, 'traecli acp serve')
    const written = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(written.agents[0].name, 'traecli')
    assert.equal(written.agents[0].acpCommand, 'traecli acp serve')
    assert.equal(written.agents[0].slug, 'traecli-bridge')
  })
})

test('JSON init preserves an explicit TraeCode CLI command', async () => {
  await withCredentials('traecli', async ({ configPath, credentialsFile }) => {
    const command = 'env TRAE_CONFIG_DIR=/tmp/fixture traecli acp serve'
    const result = await runJsonInit(configPath, {
      agents: [{ name: 'traecli', acpCommand: command, credentialsFile }],
    })
    assert.equal(result.agents[0].acpCommand, command)
  })
})

test('JSON init rejects empty and whitespace-only explicit ACP commands', async () => {
  await withCredentials('traex', async ({ configPath, credentialsFile }) => {
    for (const acpCommand of ['', '   ', '\t\r\n']) {
      await assert.rejects(runJsonInit(configPath, {
        agents: [{ name: 'traex', acpCommand, credentialsFile }],
      }))
    }
  })
})

test('JSON init preserves a quoted multi-token ACP command verbatim', async () => {
  await withCredentials('traex', async ({ configPath, credentialsFile }) => {
    const command = '  traex acp serve --model "doubao pro"  '
    const result = await runJsonInit(configPath, {
      agents: [{ name: 'traex', acpCommand: command, credentialsFile }],
    })

    assert.equal(result.agents[0].acpCommand, command)
    const written = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(written.agents[0].acpCommand, command)
  })
})

test('JSON init preserves explicitly supplied WorkBuddy legacy commands', async () => {
  const cases = [
    ['workbuddy', `${WORKBUDDY_APP_CLI} --acp`],
    ['workbuddy_ai', `'${WORKBUDDY_AI_APP_CLI}' --acp`],
  ] as const

  for (const [name, command] of cases) {
    await withCredentials(name, async ({ configPath, credentialsFile }) => {
      const result = await runJsonInit(configPath, {
        agents: [{ name, acpCommand: command, credentialsFile }],
      })

      assert.equal(result.agents[0].acpCommand, command)
      const written = JSON.parse(readFileSync(configPath, 'utf8'))
      assert.equal(written.agents[0].name, name)
      assert.equal(written.agents[0].acpCommand, command)
    })
  }
})

test('JSON init upgrades saved generated WorkBuddy commands when omitted', async () => {
  const cases = [
    ['workbuddy', `${WORKBUDDY_APP_CLI} --acp`],
    ['workbuddy_ai', `'${WORKBUDDY_AI_APP_CLI}' --acp`],
  ] as const

  for (const [name, legacyCommand] of cases) {
    await withCredentials(name, async ({ configPath, credentialsFile }) => {
      writeFileSync(configPath, JSON.stringify({
        aampHost: 'https://meshmail.ai',
        rejectUnauthorized: false,
        agents: [{ name, acpCommand: legacyCommand, credentialsFile }],
      }))

      const result = await runJsonInit(configPath, {
        agents: [{ name, credentialsFile }],
      })

      assert.equal(result.agents[0].acpCommand, defaultAcpCommand(name))
      const written = JSON.parse(readFileSync(configPath, 'utf8'))
      assert.equal(written.agents[0].acpCommand, defaultAcpCommand(name))
    })
  }
})

test('JSON init supplies the isolated native WorkBuddy AI ACP command', async () => {
  await withCredentials('workbuddy_ai', async ({ configPath, credentialsFile }) => {
    const result = await runJsonInit(configPath, {
      agents: [{ name: 'workbuddy_ai', credentialsFile }],
    })

    const command = defaultAcpCommand('workbuddy_ai')
    assert.equal(result.agents[0].acpCommand, command)
    const written = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(written.agents[0].name, 'workbuddy_ai')
    assert.equal(written.agents[0].acpCommand, command)
    assert.equal(written.agents[0].slug, 'workbuddy-ai-bridge')

    const loaded = loadConfig(configPath)
    assert.equal(loaded.agents[0].name, 'workbuddy_ai')
    assert.equal(loaded.agents[0].slug, 'workbuddy-ai-bridge')
    assert.equal(loaded.agents[0].acpCommand, command)
  })
})

test('JSON init persists, reports, and preserves an attachment policy without exposing credentials', async () => {
  await withCredentials('remote-agent', async ({ configPath, credentialsFile }) => {
    const first = await runJsonInit(configPath, {
      agents: [{ name: 'remote-agent', credentialsFile, attachmentPolicy: 'reject' }],
    })

    assert.equal(first.agents[0].attachmentPolicy, 'reject')
    const serializedResult = JSON.stringify(first)
    assert.doesNotMatch(serializedResult, /fixture-password|smtpPassword|mailboxToken/)
    let written = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(written.agents[0].attachmentPolicy, 'reject')

    const preserved = await runJsonInit(configPath, {
      agents: [{ name: 'remote-agent', credentialsFile }],
    })
    assert.equal(preserved.agents[0].attachmentPolicy, 'reject')
    written = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(written.agents[0].attachmentPolicy, 'reject')
  })
})

test('JSON init preserves remote execution location when an Agent is updated', async () => {
  await withCredentials('aime', async ({ configPath, credentialsFile }) => {
    const first = await runJsonInit(configPath, {
      agents: [{
        name: 'aime',
        credentialsFile,
        attachmentPolicy: 'reject',
        executionLocation: 'remote',
      }],
    })
    assert.equal(first.agents[0].executionLocation, 'remote')
    let written = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(written.agents[0].executionLocation, 'remote')

    const preserved = await runJsonInit(configPath, {
      agents: [{ name: 'aime', credentialsFile }],
    })
    assert.equal(preserved.agents[0].executionLocation, 'remote')
    written = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(written.agents[0].executionLocation, 'remote')
  })
})

test('remote JSON init output hides command and credential paths while private config retains them', async () => {
  await withCredentials('aime', async ({ configPath, credentialsFile }) => {
    const acpCommand = "'/Users/private/AIME_ACP_COMMAND_SENTINEL' --acp"
    const result = await runJsonInit(configPath, {
      agents: [{
        name: 'aime',
        acpCommand,
        credentialsFile,
        attachmentPolicy: 'reject',
        executionLocation: 'remote',
      }],
    })

    assert.deepEqual(result.agents[0], {
      name: 'aime',
      bridge: 'acp-bridge',
      connection: 'acp_bridge',
      email: 'aime@example.com',
      registered: false,
      credentialsConfigured: true,
      acpCommandConfigured: true,
      attachmentPolicy: 'reject',
      executionLocation: 'remote',
    })
    assert.equal('configPath' in result, false)
    assert.equal(result.configPathConfigured, true)
    const serializedResult = JSON.stringify(result)
    assert.doesNotMatch(serializedResult, /AIME_ACP_COMMAND_SENTINEL/)
    assert.equal(serializedResult.includes(credentialsFile), false)
    assert.equal(serializedResult.includes(configPath), false)

    const written = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(written.agents[0].acpCommand, acpCommand)
    assert.equal(written.agents[0].credentialsFile, credentialsFile)
  })
})

test('partial local JSON init hides configPath when the final config still contains a remote Agent', async () => {
  await withCredentials('local-agent', async ({ directory, configPath, credentialsFile }) => {
    const remoteCredentialsFile = join(directory, 'REMOTE_EXISTING_CREDENTIAL_SENTINEL.json')
    const remoteCommand = "'/Users/private/REMOTE_EXISTING_COMMAND_SENTINEL' --acp"
    writeFileSync(remoteCredentialsFile, JSON.stringify({
      email: 'remote-agent@example.com',
      smtpPassword: 'remote-fixture-password',
    }))
    writeFileSync(configPath, JSON.stringify({
      aampHost: 'https://meshmail.ai',
      rejectUnauthorized: false,
      agents: [
        {
          name: 'remote-agent',
          acpCommand: remoteCommand,
          credentialsFile: remoteCredentialsFile,
          attachmentPolicy: 'reject',
          executionLocation: 'remote',
        },
        {
          name: 'local-agent',
          acpCommand: 'local-agent acp',
          credentialsFile,
        },
      ],
    }))

    const result = await runJsonInit(configPath, {
      agents: [{
        name: 'local-agent',
        acpCommand: 'local-agent updated-acp',
        credentialsFile,
      }],
    })

    assert.equal(result.configPathConfigured, true)
    assert.equal('configPath' in result, false)
    assert.equal(result.agents[0].executionLocation, 'local')
    assert.equal(result.agents[0].acpCommand, 'local-agent updated-acp')
    assert.doesNotMatch(
      JSON.stringify(result),
      /CONFIG_PATH_SENTINEL|REMOTE_EXISTING_COMMAND_SENTINEL|REMOTE_EXISTING_CREDENTIAL_SENTINEL/,
    )

    const persisted = loadConfig(configPath)
    const remote = persisted.agents.find((agent) => agent.name === 'remote-agent')
    assert.equal(remote?.acpCommand, remoteCommand)
    assert.equal(remote?.credentialsFile, remoteCredentialsFile)
  })
})

test('init --json redacts top-level config path for a remote requested Agent while persisting exact private values', () => {
  withCliFixture('remote-init', ({
    directory,
    configPath,
    remoteCredentialsFile,
    remoteCommand,
  }) => {
    rmSync(configPath)
    const result = runCli(directory, [
      'init', '--json', '--input', '-', '--config', configPath,
    ], {
      agents: [{
        name: 'aime',
        acpCommand: remoteCommand,
        credentialsFile: remoteCredentialsFile,
        attachmentPolicy: 'reject',
        executionLocation: 'remote',
      }],
    })
    const output = JSON.parse(result.stdout)

    assert.deepEqual(Object.keys(output).sort(), [
      'aampHost',
      'agents',
      'bridge',
      'configPathConfigured',
      'schemaVersion',
      'type',
    ])
    assert.equal(output.configPathConfigured, true)
    assert.doesNotMatch(result.stdout, /CONFIG_PATH_SENTINEL|REMOTE_COMMAND_SENTINEL|REMOTE_CREDENTIAL_PATH_SENTINEL/)

    const persisted = loadConfig(configPath)
    assert.equal(persisted.agents[0].acpCommand, remoteCommand)
    assert.equal(persisted.agents[0].credentialsFile, remoteCredentialsFile)
  })
})

test('list public output redacts remote paths and commands while preserving local-only compatibility', () => {
  withCliFixture('list', ({
    directory,
    configPath,
    remoteCredentialsFile,
    localCredentialsFile,
    remoteCommand,
    localCommand,
  }) => {
    const jsonResult = runCli(directory, ['list', '--json', '--config', configPath])
    const output = JSON.parse(jsonResult.stdout)
    assert.deepEqual(Object.keys(output).sort(), [
      'aampHost',
      'agents',
      'bridge',
      'configPathConfigured',
      'schemaVersion',
    ])
    assert.equal(output.configPathConfigured, true)
    assert.deepEqual(output.agents[0], {
      name: 'aime',
      bridge: 'acp-bridge',
      connection: 'acp_bridge',
      email: 'aime@example.com',
      executionLocation: 'remote',
      acpCommandConfigured: true,
      credentialsConfigured: true,
      configured: true,
    })
    assert.deepEqual(output.agents[1], {
      name: 'codex',
      bridge: 'acp-bridge',
      connection: 'acp_bridge',
      email: 'codex@example.com',
      acpCommand: localCommand,
      credentialsFile: localCredentialsFile,
      configured: true,
    })
    assert.doesNotMatch(
      jsonResult.stdout,
      /CONFIG_PATH_SENTINEL|REMOTE_COMMAND_SENTINEL|REMOTE_CREDENTIAL_PATH_SENTINEL/,
    )

    const humanResult = runCli(directory, ['list', '--config', configPath])
    assert.match(humanResult.stdout, /aime: aime@example\.com \(remote Agent; ACP command configured\)/)
    assert.match(humanResult.stdout, new RegExp(`codex: codex@example\\.com \\(${localCommand}\\)`))
    assert.doesNotMatch(
      humanResult.stdout,
      /REMOTE_COMMAND_SENTINEL|REMOTE_CREDENTIAL_PATH_SENTINEL|Users\/private/,
    )

    const localOnlyConfigPath = join(directory, 'local-only-config.json')
    writeFileSync(localOnlyConfigPath, JSON.stringify({
      aampHost: 'https://meshmail.ai',
      rejectUnauthorized: false,
      agents: [{
        name: 'codex',
        acpCommand: localCommand,
        credentialsFile: localCredentialsFile,
      }],
    }))
    const localOnlyResult = runCli(directory, ['list', '--json', '--config', localOnlyConfigPath])
    const localOnlyOutput = JSON.parse(localOnlyResult.stdout)
    assert.equal(localOnlyOutput.configPath, localOnlyConfigPath)
    assert.equal('configPathConfigured' in localOnlyOutput, false)
    assert.deepEqual(localOnlyOutput.agents[0], {
      name: 'codex',
      bridge: 'acp-bridge',
      connection: 'acp_bridge',
      email: 'codex@example.com',
      acpCommand: localCommand,
      credentialsFile: localCredentialsFile,
      configured: true,
    })
    assert.equal(remoteCredentialsFile.includes('REMOTE_CREDENTIAL_PATH_SENTINEL'), true)
    assert.equal(remoteCommand.includes('REMOTE_COMMAND_SENTINEL'), true)
  })
})

test('discover --json redacts configured remote command fields while preserving local candidates', () => {
  withCliFixture('discover', ({
    directory,
    configPath,
    remoteCommand,
    localCommand,
  }) => {
    const result = runCli(
      directory,
      ['discover', '--json', '--config', configPath],
      undefined,
      { PATH: directory },
    )
    const output = JSON.parse(result.stdout)
    const remote = output.candidates.find((candidate: { id?: string }) => candidate.id === 'aime')
    const local = output.candidates.find((candidate: { id?: string }) => candidate.id === 'codex')

    assert.deepEqual(remote, {
      id: 'aime',
      displayName: 'aime',
      connection: 'acp_bridge',
      detected: false,
      configured: true,
      confidence: 'medium',
      executionLocation: 'remote',
      commandConfigured: true,
      acpCommandConfigured: true,
      email: 'aime@example.com',
      warnings: ['Remote Agent adapter was not detected.'],
    })
    assert.equal(local.acpCommand, localCommand)
    assert.equal('acpCommandConfigured' in local, false)
    assert.doesNotMatch(
      result.stdout,
      /REMOTE_COMMAND_SENTINEL|REMOTE_CREDENTIAL_PATH_SENTINEL|Users\/private/,
    )
    assert.equal(remoteCommand.includes('REMOTE_COMMAND_SENTINEL'), true)
  })
})

test('pair --json redacts the remote pairing path while preserving the private file and local response', () => {
  withCliFixture('pair', ({
    directory,
    configPath,
    remotePairingFile,
    localPairingFile,
  }) => {
    const remoteResult = runCli(directory, [
      'pair', '--agent', 'aime', '--json', '--no-start', '--config', configPath,
    ])
    const remoteOutput = JSON.parse(remoteResult.stdout)
    assert.deepEqual(Object.keys(remoteOutput).sort(), [
      'agent',
      'bridge',
      'connectUrl',
      'expiresAt',
      'mailbox',
      'pairCode',
      'pairingFileConfigured',
      'type',
      'webUrl',
    ])
    assert.equal(remoteOutput.pairingFileConfigured, true)
    assert.doesNotMatch(remoteResult.stdout, /REMOTE_PAIRING_PATH_SENTINEL/)
    assert.equal(existsSync(remotePairingFile), true)

    const config = loadConfig(configPath)
    const remoteAgent = config.agents.find((agent) => agent.name === 'aime')
    assert.ok(remoteAgent)
    assert.equal(resolvePairingFile(remoteAgent.pairingFile, remoteAgent.name), remotePairingFile)

    const localResult = runCli(directory, [
      'pair', '--agent', 'codex', '--json', '--no-start', '--config', configPath,
    ])
    const localOutput = JSON.parse(localResult.stdout)
    assert.equal(localOutput.pairingFile, localPairingFile)
    assert.equal('pairingFileConfigured' in localOutput, false)
    assert.equal(existsSync(localPairingFile), true)
  })
})

test('JSON init validates unchanged Agents before re-persisting a partial update', async () => {
  await withCredentials('updated-agent', async ({ configPath, credentialsFile }) => {
    writeFileSync(configPath, JSON.stringify({
      aampHost: 'https://meshmail.ai',
      rejectUnauthorized: false,
      agents: [
        {
          name: 'unsafe-remote',
          acpCommand: 'unsafe-remote-acp',
          executionLocation: 'remote',
          attachmentPolicy: 'allow',
        },
        {
          name: 'updated-agent',
          acpCommand: 'updated-agent-acp',
          credentialsFile,
        },
      ],
    }))

    await assert.rejects(runJsonInit(configPath, {
      agents: [{ name: 'updated-agent', credentialsFile }],
    }), /remote Agent requires attachmentPolicy=reject/)
  })
})

test('JSON init defaults attachment policy to allow and rejects unknown values', async () => {
  await withCredentials('remote-agent', async ({ configPath, credentialsFile }) => {
    const result = await runJsonInit(configPath, {
      agents: [{ name: 'remote-agent', credentialsFile }],
    })

    assert.equal(result.agents[0].attachmentPolicy, 'allow')
    const written = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(written.agents[0].attachmentPolicy, 'allow')

    await assert.rejects(runJsonInit(configPath, {
      agents: [{ name: 'remote-agent', credentialsFile, attachmentPolicy: 'drop' }],
    }))
  })
})
