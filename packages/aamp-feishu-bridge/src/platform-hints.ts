// Display-only CLI spelling; never used to execute commands.
export function bridgeCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'aamp-feishu-bridge.cmd' : 'aamp-feishu-bridge'
}
