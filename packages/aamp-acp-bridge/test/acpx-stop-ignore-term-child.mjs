import { appendFileSync } from 'node:fs'

const statePath = process.argv[2]
if (!statePath) throw new Error('state path is required')

function record(state) {
  appendFileSync(statePath, `${JSON.stringify({ pid: process.pid, state })}\n`, {
    mode: 0o600,
  })
}

process.on('SIGTERM', () => {
  record('sigterm-ignored')
})

record('ready')
setInterval(() => {}, 1_000)
