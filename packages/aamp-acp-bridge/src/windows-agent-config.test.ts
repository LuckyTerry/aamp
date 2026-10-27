import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ensureWindowsAgentConfig, parseWindowsAgentArgv, windowsAgentAlias, WINDOWS_CONFIG_ACL_COMPARISON_SCRIPT } from './windows-agent-config.js'
function fixture(t: { after: (fn: () => void) => void }): string {
  const cwd = mkdtempSync(join(tmpdir(), 'aamp-windows-config-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  return cwd
}
test('Windows argv preserves native paths, Unicode and metacharacters as data', () => {
  assert.deepEqual(parseWindowsAgentArgv(String.raw`"C:\Program Files\node.exe" "C:\中文 & (test)\wrapper.mjs" "C:\config.json"`), ['C:\\Program Files\\node.exe', 'C:\\中文 & (test)\\wrapper.mjs', 'C:\\config.json'])
  assert.deepEqual(parseWindowsAgentArgv(String.raw`node.exe "say \"hello\"" "" "C:\tail\\" %PATH% ^ &`), ['node.exe', 'say "hello"', '', 'C:\\tail\\', '%PATH%', '^', '&'])
  assert.throws(() => parseWindowsAgentArgv('"unclosed'), /unterminated/)
  assert.throws(() => parseWindowsAgentArgv(''), /requires an executable/)
  assert.throws(() => parseWindowsAgentArgv('node\nnext'), /control/)
})
test('Windows registry preserves user config and is idempotent', t => {
  const cwd = fixture(t), target = join(cwd, '.acpxrc.json')
  const original = { defaultAgent: 'codex', agents: { existing: { argv: ['other.exe'] } }, auth: { token: 'sentinel' } }
  writeFileSync(target, JSON.stringify(original))
  const argv = ['C:\\node.exe', 'C:\\space dir\\wrapper.mjs', 'C:\\config.json']
  const alias = ensureWindowsAgentConfig(cwd, argv)
  assert.equal(alias, windowsAgentAlias(argv))
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { ...original, agents: { ...original.agents, [alias]: { argv } } })
  const once = readFileSync(target, 'utf8')
  assert.equal(ensureWindowsAgentConfig(cwd, argv), alias)
  assert.equal(readFileSync(target, 'utf8'), once)
  assert.deepEqual(readdirSync(cwd), ['.acpxrc.json'])
})
test('Windows registry rejects malformed config and reserved conflicts without replacing files', t => {
  const cwd = fixture(t), target = join(cwd, '.acpxrc.json'), argv = ['node.exe', 'wrapper.mjs']
  for (const original of ['bad json', '[]', '{"agents":[]}', JSON.stringify({ agents: { [windowsAgentAlias(argv)]: { argv: ['different.exe'] } } })]) {
    writeFileSync(target, original)
    assert.throws(() => ensureWindowsAgentConfig(cwd, argv))
    assert.equal(readFileSync(target, 'utf8'), original)
    assert.deepEqual(readdirSync(cwd), ['.acpxrc.json'])
  }
})
test('Windows registry bounds lock waits and never removes another writer lock', t => {
  const cwd = fixture(t), lock = join(cwd, '.aamp-acpx-config.lock')
  writeFileSync(lock, 'other-writer')
  const waits: number[] = []
  assert.throws(() => ensureWindowsAgentConfig(cwd, ['node.exe'], { wait: ms => { waits.push(ms) } }), /config is busy/)
  assert.equal(waits.length, 20)
  assert.ok(waits.every(value => value === 50))
  assert.equal(readFileSync(lock, 'utf8'), 'other-writer')
  assert.deepEqual(readdirSync(cwd), ['.aamp-acpx-config.lock'])
})

test('native Windows config ACL stays private for new files and survives credential-preserving merges', { skip: process.platform !== 'win32' }, async t => {
  const { execFileSync } = await import('node:child_process')
  const cwd = fixture(t), target = join(cwd, '.acpxrc.json')
  const readAcl = (file: string) => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(String.raw`
$ErrorActionPreference='Stop'
$acl=Get-Acl -LiteralPath $env:AAMP_TEST_ACL_PATH
$sidType=[Security.Principal.SecurityIdentifier]
@{sddl=$acl.Sddl; protected=$acl.AreAccessRulesProtected; currentSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; rules=@($acl.GetAccessRules($true,$true,$sidType) | ForEach-Object { @{sid=$_.IdentityReference.Value; allow=$_.AccessControlType -eq 'Allow'} })} | ConvertTo-Json -Depth 4 -Compress
`, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, AAMP_TEST_ACL_PATH: file }, stdio: ['ignore', 'pipe', 'pipe'] }))
  const parentAcl = readAcl(cwd)
  ensureWindowsAgentConfig(cwd, ['node.exe', 'first.mjs'])
  const firstAcl = readAcl(target)
  assert.equal(firstAcl.protected, true)
  const allowed = new Set([firstAcl.currentSid, 'S-1-5-18', 'S-1-5-32-544'])
  assert.ok(firstAcl.rules.length > 0)
  for (const rule of firstAcl.rules) { assert.ok(allowed.has(rule.sid)); assert.equal(rule.allow, true) }
  const config = JSON.parse(readFileSync(target, 'utf8'))
  writeFileSync(target, JSON.stringify({ ...config, auth: { credential: 'PRIVATE_SENTINEL' } }))
  ensureWindowsAgentConfig(cwd, ['node.exe', 'second.mjs'])
  assert.equal(readAcl(target).sddl, firstAcl.sddl)
  assert.equal(readAcl(cwd).sddl, parentAcl.sddl)
  assert.equal(JSON.parse(readFileSync(target, 'utf8')).auth.credential, 'PRIVATE_SENTINEL')
})


test('native ACL comparison tolerates only DACL auto-inherited bookkeeping', {skip:process.platform !== 'win32'}, async () => {
  const {execFileSync}=await import('node:child_process')
  const script=WINDOWS_CONFIG_ACL_COMPARISON_SCRIPT + String.raw`
$ErrorActionPreference='Stop'
$expected=Get-ComparableConfigSddl 'O:SYG:BAD:P(A;;FA;;;SY)'
if ($expected -ne (Get-ComparableConfigSddl 'O:SYG:BAD:PAI(A;;FA;;;SY)')) { throw 'AI normalization failed' }
foreach ($different in @(
  'O:SYG:BAD:AI(A;;FA;;;SY)',
  'O:BAG:BAD:P(A;;FA;;;SY)',
  'O:SYG:SYD:P(A;;FA;;;SY)',
  'O:SYG:BAD:P(A;;FR;;;SY)',
  'O:SYG:BAD:P(D;;FA;;;SY)',
  'O:SYG:BAD:P(A;;FA;;;SY)(A;;FR;;;WD)'
)) { if ($expected -eq (Get-ComparableConfigSddl $different)) { throw 'Effective ACL difference was ignored' } }
Write-Output 'ACL_COMPARISON_OK'
`
  const result=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',timeout:15000})
  assert.match(result,/ACL_COMPARISON_OK/)
})
