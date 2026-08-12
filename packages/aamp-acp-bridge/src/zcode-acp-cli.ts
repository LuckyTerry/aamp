#!/usr/bin/env node

import { Readable, Writable } from 'node:stream'
import {
  ndJsonStream,
  type AgentConnection,
} from '@agentclientprotocol/sdk'
import { PACKAGE_VERSION } from './version.js'
import { createZcodeAcpAgent } from './zcode-acp/agent.js'
import {
  DEFAULT_ZCODE_CLI_PATH,
  detectZcodeInstallation,
  resolveZcodeCliPath,
  ZCODE_CLI_OVERRIDE,
} from './zcode-acp/app-locator.js'
import { ZCodeAcpRuntime } from './zcode-acp/runtime.js'
import { ZCodeRpcClient } from './zcode-acp/rpc-client.js'

const HELP = `Usage:
  aamp-zcode-acp serve
  aamp-zcode-acp --version
  aamp-zcode-acp --help

Commands:
  serve       Serve ZCode over ACP on stdin/stdout

Environment:
  ${ZCODE_CLI_OVERRIDE}  Override the embedded ZCode CLI path
`

function writeStderr(message: string): void {
  process.stderr.write(`aamp-zcode-acp: ${message}\n`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function serve(): Promise<void> {
  const cliPath = resolveZcodeCliPath()
  if (!cliPath) {
    throw new Error(
      `ZCode CLI was not found. Install ZCode at ${DEFAULT_ZCODE_CLI_PATH} `
      + `or set ${ZCODE_CLI_OVERRIDE}.`,
    )
  }
  const installation = detectZcodeInstallation()
  if (!installation) {
    throw new Error(`Unable to run ZCode CLI at ${cliPath}`)
  }

  const backend = new ZCodeRpcClient({
    cliPath: installation.command,
    cwd: process.cwd(),
  })
  let runtime: ZCodeAcpRuntime | undefined
  let connection: AgentConnection | undefined
  let fatalError: Error | undefined
  let unsubscribeBackendClose: (() => void) | undefined
  let closePromise: Promise<void> | undefined

  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      connection?.close()
      if (runtime) await runtime.close()
      else await backend.close()
    })()
    return closePromise
  }
  const onSignal = () => {
    void close().catch((error) => writeStderr(errorMessage(error)))
  }

  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    await backend.start()
    runtime = new ZCodeAcpRuntime({
      backend,
      cliPath: installation.command,
      cliVersion: installation.version,
    })
    const app = createZcodeAcpAgent(runtime, PACKAGE_VERSION)
    const stream = ndJsonStream(
      Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    )
    connection = app.connect(stream)
    unsubscribeBackendClose = backend.onClose((error) => {
      fatalError = error
      connection?.close(error)
    })
    await connection.closed
    if (fatalError) throw fatalError
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    unsubscribeBackendClose?.()
    await close()
  }
}

async function main(args: string[]): Promise<number> {
  const command = args[0]
  if (command === '--version' || command === '-v') {
    process.stdout.write(`${PACKAGE_VERSION}\n`)
    return 0
  }
  if (command === '--help' || command === '-h' || command === undefined) {
    process.stdout.write(HELP)
    return 0
  }
  if (command !== 'serve' || args.length !== 1) {
    writeStderr(`Unknown command: ${args.join(' ')}`)
    return 2
  }

  try {
    await serve()
    return 0
  } catch (error) {
    writeStderr(errorMessage(error))
    return 1
  }
}

process.exitCode = await main(process.argv.slice(2))
