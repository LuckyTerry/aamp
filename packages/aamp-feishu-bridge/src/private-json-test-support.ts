import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

export async function assertPrivateFile(path: string): Promise<void> {
  if (process.platform !== 'win32') {
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    return
  }
  // Read the effective persisted ACL independently of the writer's validation.
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$sidType = [System.Security.Principal.SecurityIdentifier]
$file = Get-Acl -LiteralPath $env:AAMP_TEST_PRIVATE_FILE
$parent = Get-Acl -LiteralPath $env:AAMP_TEST_PRIVATE_PARENT
@{
  currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  ownerSid = $file.GetOwner($sidType).Value
  parentOwnerSid = $parent.GetOwner($sidType).Value
  parentProtected = $parent.AreAccessRulesProtected
  rules = @($file.GetAccessRules($true, $true, $sidType) | ForEach-Object {
    @{ sid = $_.IdentityReference.Value; allow = $_.AccessControlType -eq 'Allow'; fullControl = ($_.FileSystemRights -band 2032127) -eq 2032127; inherited = $_.IsInherited }
  })
} | ConvertTo-Json -Depth 4 -Compress
`
  const { stdout } = await promisify(execFile)('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], { windowsHide: true, env: { ...process.env, AAMP_TEST_PRIVATE_FILE: path, AAMP_TEST_PRIVATE_PARENT: dirname(path) } })
  const acl = JSON.parse(stdout)
  assert.equal(acl.parentOwnerSid, acl.currentSid)
  assert.equal(acl.parentProtected, true)
  const allowed = new Set([acl.currentSid, 'S-1-5-18', 'S-1-5-32-544'])
  // Elevated Windows tokens may make BUILTIN\\Administrators the file owner.
  assert.ok(allowed.has(acl.ownerSid))
  assert.ok(acl.rules.length > 0)
  assert.ok(acl.rules.some((rule: { sid: string; fullControl: boolean }) => rule.sid === acl.currentSid && rule.fullControl))
  for (const rule of acl.rules) {
    assert.ok(allowed.has(rule.sid), `unexpected ACL principal ${rule.sid}`)
    assert.equal(rule.allow, true)
    assert.equal(rule.inherited, true, 'replacement must inherit the protected destination directory ACL')
  }
}
