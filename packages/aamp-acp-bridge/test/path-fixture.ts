import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

export interface FakePathCommand {
  name: string
  version: string
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

export function withFakePath<T>(
  commands: readonly FakePathCommand[],
  run: (directory: string) => T,
): T {
  if (process.platform === 'win32') {
    throw new Error('withFakePath is POSIX-only because the current resolver uses which')
  }

  const directory = mkdtempSync(join(tmpdir(), 'aamp-traex-path-'))
  const previousPath = process.env.PATH

  try {
    for (const command of commands) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(command.name)) {
        throw new Error(`Unsafe fake command name: ${command.name}`)
      }
      const executable = join(directory, command.name)
      writeFileSync(executable, [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then',
        `  printf '%s\\n' ${shellQuote(command.version)}`,
        'fi',
        'exit 0',
        '',
      ].join('\n'))
      chmodSync(executable, 0o755)
    }

    process.env.PATH = [directory, '/usr/bin', '/bin'].join(delimiter)
    return run(directory)
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    rmSync(directory, { recursive: true, force: true })
  }
}
