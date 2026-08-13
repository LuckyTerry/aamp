import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadConfig } from '../src/config.js'
import { runJsonInit } from '../src/json-init.js'
import {
  defaultAcpCommand,
  WORKBUDDY_AI_APP_CLI,
  WORKBUDDY_APP_CLI,
} from '../src/agent-resolver.js'

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
