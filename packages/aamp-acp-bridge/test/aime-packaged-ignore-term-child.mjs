import { appendFileSync } from 'node:fs'

const statePath = process.argv[2]
if (!statePath) throw new Error('state path is required')
const exitOnTerm = process.argv[3] === 'exit-on-term'

function record(state) {
  appendFileSync(statePath, `${JSON.stringify({ pid: process.pid, state })}\n`, {
    mode: 0o600,
  })
}

process.on('SIGTERM', () => {
  record(exitOnTerm ? 'sigterm-exit' : 'sigterm-ignored')
  if (exitOnTerm) process.exit(0)
})

record('ready')
setInterval(() => {}, 1_000)
