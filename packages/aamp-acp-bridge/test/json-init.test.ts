import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runJsonInit } from '../src/json-init.js'

test('JSON init supplies the native traex ACP command', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aamp-traex-json-init-'))
  const configPath = join(directory, 'config.json')
  const credentialsFile = join(directory, 'traex-credentials.json')

  try {
    writeFileSync(credentialsFile, JSON.stringify({
      email: 'traex@example.com',
      smtpPassword: 'fixture-password',
    }))

    const result = await runJsonInit(configPath, {
      agents: [{ name: 'traex', credentialsFile }],
    })

    assert.equal(result.agents[0].acpCommand, 'traex acp serve')
    assert.equal(result.agents[0].registered, false)
    const written = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(written.agents[0].name, 'traex')
    assert.equal(written.agents[0].acpCommand, 'traex acp serve')
    assert.equal(written.agents[0].slug, 'traex-bridge')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('JSON init preserves an existing custom traex ACP command', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aamp-traex-json-init-'))
  const configPath = join(directory, 'config.json')
  const credentialsFile = join(directory, 'traex-credentials.json')
  const customCommand = 'traex acp serve --config model="custom"'

  try {
    writeFileSync(credentialsFile, JSON.stringify({
      email: 'traex@example.com',
      smtpPassword: 'fixture-password',
    }))
    writeFileSync(configPath, JSON.stringify({
      aampHost: 'https://meshmail.ai',
      rejectUnauthorized: false,
      agents: [{
        name: 'traex',
        acpCommand: customCommand,
        credentialsFile,
      }],
    }))

    const result = await runJsonInit(configPath, {
      agents: [{ name: 'traex', credentialsFile }],
    })

    assert.equal(result.agents[0].acpCommand, customCommand)
    const written = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(written.agents[0].acpCommand, customCommand)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
