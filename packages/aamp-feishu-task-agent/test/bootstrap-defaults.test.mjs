import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

test('defaults JSON owns exact package pins and scope manifest v2', () => {
  const defaults=JSON.parse(readFileSync(new URL('../bootstrap/task-agent-defaults.json',import.meta.url),'utf8'))
  assert.equal(defaults.schemaVersion,1); assert.equal(defaults.scopeManifest.version,2)
  assert.equal(defaults.packages.codexAcp,'@agentclientprotocol/codex-acp@1.0.2')
  for (const key of ['acpBridge', 'feishuBridge', 'aimeAcp']) {
    assert.match(defaults.packages[key], /^@[^/]+\/[^@]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, `${key} must pin an exact package version`)
  }
  assert.equal(defaults.scopeManifest.app.tenant.includes('im:message:send_as_bot'),true)
  assert.deepEqual(defaults.profile.domains,['task'])
})

test('checked-in Bash defaults are generated from the JSON owner', () => {
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/sync-bootstrap-defaults.mjs',import.meta.url)),'--check'],{encoding:'utf8'})
  assert.equal(result.status,0,result.stderr)
})
