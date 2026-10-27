import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// Protect the destination before creating any temporary file containing secrets.
// The Bridge is independently runnable and cannot rely on Controller setup.
export async function protectPrivateJsonDirectory(directory: string): Promise<void> {
  const script = String.raw`
$ErrorActionPreference = 'Stop'

$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
$administratorsSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
$allowedSids = @($currentSid.Value, $systemSid.Value, $administratorsSid.Value)
$inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$propagation = [System.Security.AccessControl.PropagationFlags]::None
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
$sections = [System.Security.AccessControl.AccessControlSections]'Access, Owner'
$directory = New-Object System.IO.DirectoryInfo($env:AAMP_PRIVATE_JSON_DIRECTORY)
function Test-PrivateDirectoryAcl($acl) {
  if (-not $acl.AreAccessRulesProtected) { return $false }
  if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $currentSid.Value) { return $false }
  $hasCurrentUserFullControl = $false
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    $sid = $rule.IdentityReference.Value
    if ($rule.AccessControlType -ne $allow -or $allowedSids -notcontains $sid -or $rule.IsInherited) { return $false }
    # InheritOnly does not grant access to this directory; NoPropagate cannot
    # protect nested private files. Require effective, propagating FullControl.
    if ($sid -eq $currentSid.Value -and ($rule.FileSystemRights -band $fullControl) -eq $fullControl -and
      $rule.InheritanceFlags -eq $inheritance -and $rule.PropagationFlags -eq $propagation) {
      $hasCurrentUserFullControl = $true
    }
  }
  return $hasCurrentUserFullControl
}
# Read only owner and DACL: standard users must never need SACL privileges.
$acl = $directory.GetAccessControl($sections)
if (-not (Test-PrivateDirectoryAcl $acl)) {
  # A fresh descriptor tracks only the sections changed below. Do not persist
  # an unchanged owner or an audit section through the PowerShell ACL provider.
  $replacement = New-Object System.Security.AccessControl.DirectorySecurity
  $replacement.SetAccessRuleProtection($true, $false)
  foreach ($sid in @($currentSid, $systemSid, $administratorsSid)) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, $fullControl, $inheritance, $propagation, $allow)
    [void]$replacement.AddAccessRule($rule)
  }
  if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $currentSid.Value) { $replacement.SetOwner($currentSid) }
  $directory.SetAccessControl($replacement)
  if (-not (Test-PrivateDirectoryAcl ($directory.GetAccessControl($sections)))) { throw 'private directory ACL verification failed' }
}
@{ path = $env:AAMP_PRIVATE_JSON_DIRECTORY; ownerSid = $currentSid.Value } | ConvertTo-Json -Compress

`
  await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], { timeout: 15_000, windowsHide: true, env: { ...process.env, AAMP_PRIVATE_JSON_DIRECTORY: directory } })
}
