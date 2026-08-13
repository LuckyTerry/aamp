import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface FakePathCommand {
  name: string
  version: string
  versionExitCode?: number
  executable?: boolean
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

export function expectedFakePathVersion(
  version: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32' ? 'installed' : version
}

export function withFakePath<T>(
  commands: readonly FakePathCommand[],
  run: (directory: string) => T,
): T {
  const directory = mkdtempSync(join(tmpdir(), 'aamp-agent-path-'))
  const previousPath = process.env.PATH

  try {
    for (const command of commands) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(command.name)) {
        throw new Error(`Unsafe fake command name: ${command.name}`)
      }

      const hasWindowsExtension = /\.(?:cmd|bat|exe|com)$/i.test(command.name)
      const fileName = process.platform === 'win32' && !hasWindowsExtension
        ? `${command.name}.cmd`
        : command.name
      const executable = join(directory, fileName)
      if (process.platform === 'win32') {
        writeFileSync(executable, [
          '@echo off',
          'if "%~1"=="--version" (',
          `  echo ${command.version}`,
          `  exit /b ${command.versionExitCode ?? 0}`,
          ')',
          'exit /b 0',
          '',
        ].join('\r\n'))
      } else {
        writeFileSync(executable, [
          '#!/bin/sh',
          'if [ "$1" = "--version" ]; then',
          `  printf '%s\\n' ${shellQuote(command.version)}`,
          `  exit ${command.versionExitCode ?? 0}`,
          'fi',
          'exit 0',
          '',
        ].join('\n'))
        chmodSync(executable, command.executable === false ? 0o644 : 0o755)
      }
    }

    process.env.PATH = directory
    return run(directory)
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    rmSync(directory, { recursive: true, force: true })
  }
}
