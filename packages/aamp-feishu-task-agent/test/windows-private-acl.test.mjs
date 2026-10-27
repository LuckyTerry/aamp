import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ensurePrivateWindowsDirectory as protect } from '../bin/windows-platform.mjs'
const poison = String.raw`
$ErrorActionPreference = 'Stop'
$directory = New-Object System.IO.DirectoryInfo($env:AAMP_ACL_TEST_DIRECTORY)
$acl = $directory.GetAccessControl([System.Security.AccessControl.AccessControlSections]'Access, Owner')
$acl.SetAccessRuleProtection($true, $false)
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$everyone = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')
if ($env:AAMP_ACL_TEST_MODE -eq 'unexpected') {
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($everyone, 'ReadAndExecute', 'Allow')))
} elseif ($env:AAMP_ACL_TEST_MODE -eq 'deny') {
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($current, 'ExecuteFile', 'Deny')))
} else {
  foreach ($rule in @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))) {
    if ($rule.IdentityReference.Value -eq $current.Value) { [void]$acl.RemoveAccessRuleSpecific($rule) }
  }
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($current, 'FullControl', 'ContainerInherit, ObjectInherit', 'InheritOnly', 'Allow')))
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($current, 'ReadPermissions, ChangePermissions', 'Allow')))
}
$directory.SetAccessControl($acl)
`
const verify = String.raw`
$ErrorActionPreference = 'Stop'
$directory = New-Object System.IO.DirectoryInfo($env:AAMP_ACL_TEST_DIRECTORY)
$acl = $directory.GetAccessControl([System.Security.AccessControl.AccessControlSections]'Access, Owner')
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $current -or -not $acl.AreAccessRulesProtected) { throw 'owner or protection mismatch' }
$full = $false
foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -ne 'Allow' -or @($current, 'S-1-5-18', 'S-1-5-32-544') -notcontains $rule.IdentityReference.Value) { throw 'unsafe ACL remains' }
  if ($rule.IdentityReference.Value -eq $current -and $rule.PropagationFlags -eq 'None' -and [int]$rule.InheritanceFlags -eq 3 -and ([int]$rule.FileSystemRights -band 2032127) -eq 2032127) { $full = $true }
}
if (-not $full) { throw 'missing effective inheritable user FullControl' }
`

test('native private directory protection repeats and repairs unsafe protected ACLs as the current user', { skip: process.platform !== 'win32', timeout: 120_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aamp-private-acl-'))
  const run = (script, mode = '') => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 15_000,
    env: { ...process.env, AAMP_ACL_TEST_DIRECTORY: directory, AAMP_ACL_TEST_MODE: mode },
  })
  try {
    for (let repeat = 0; repeat < 3; repeat++) { await protect(directory); assert.doesNotThrow(() => run(verify)) }
    for (const mode of ['unexpected', 'deny', 'inherit-only']) {
      run(poison, mode)
      assert.throws(() => run(verify), `fixture ${mode} must be unsafe`)
      await protect(directory)
      assert.doesNotThrow(() => run(verify))
      await protect(directory)
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
