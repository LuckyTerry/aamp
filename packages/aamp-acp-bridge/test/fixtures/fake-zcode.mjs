#!/usr/bin/env node

import { appendFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)

if (args[0] === '--version') {
  process.stdout.write('0.16.1\n')
  process.exit(0)
}

if (args[0] !== 'app-server') {
  process.stderr.write('expected app-server\n')
  process.exit(2)
}

const scenario = process.env.FAKE_ZCODE_SCENARIO ?? 'happy'
const recordPath = process.env.FAKE_ZCODE_RECORD_PATH
const exitPath = process.env.FAKE_ZCODE_EXIT_PATH
const startPath = process.env.FAKE_ZCODE_START_PATH
const requests = []

if (startPath) writeFileSync(startPath, String(process.pid))
if (process.env.FAKE_ZCODE_DIAGNOSTIC === '1') {
  process.stderr.write('fake ZCode diagnostic\n')
}

function record(message) {
  if (recordPath) appendFileSync(recordPath, JSON.stringify(message) + '\n')
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function resultFor(message) {
  switch (message.method) {
    case 'session/list':
      return { sessions: [] }
    case 'session/create':
      return {
        protocol: { name: 'ZCode Protocol', version: 1 },
        session: { sessionId: 'sess_fake' },
      }
    default:
      return { ok: true, method: message.method, params: message.params }
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })

input.on('line', (line) => {
  const message = JSON.parse(line)
  record(message)

  if (!('id' in message)) return

  if (scenario === 'timeout') return

  if (scenario === 'crash') {
    process.stderr.write('{"authorization":"Bearer quoted-secret","nested":{"api_key":"json-secret"}}\n')
    process.exit(17)
  }

  if (scenario === 'malformed') {
    process.stdout.write('not-json\n')
    return
  }

  if (scenario === 'oversized') {
    send({ id: message.id, result: { value: 'x'.repeat(4096) } })
    return
  }

  if (scenario === 'protocol-error') {
    send({
      id: message.id,
      error: {
        code: -32603,
        message: 'model unavailable',
        data: {
          code: 'model_config_missing',
          authorization: 'super-secret',
        },
      },
    })
    return
  }

  if (scenario === 'coalesced-frames') {
    requests.push(message)
    if (requests.length === 2) {
      const [first, second] = requests
      process.stdout.write(
        JSON.stringify({ id: second.id, result: { sessions: [{ sessionId: 'sess_second' }] } })
        + '\n'
        + JSON.stringify({ id: first.id, result: { sessions: [{ sessionId: 'sess_first' }] } })
        + '\n',
      )
    }
    return
  }

  if (scenario === 'split-frames') {
    const payload = JSON.stringify({ id: message.id, result: resultFor(message) }) + '\n'
    const midpoint = Math.floor(payload.length / 2)
    process.stdout.write(payload.slice(0, midpoint))
    setTimeout(() => process.stdout.write(payload.slice(midpoint)), 5)
    return
  }

  if (scenario === 'runtime-preferences') {
    if (message.method === 'session/create') {
      requests.push(message)
      send({
        id: 'server-1',
        method: 'session/requestRuntimePreferences',
        params: { sessionId: 'sess_fake', scope: 'session' },
      })
      return
    }
    if (message.id === 'server-1' && 'result' in message) {
      const create = requests.shift()
      send({ id: create.id, result: resultFor(create) })
    }
    return
  }

  if (scenario === 'notification') {
    send({
      method: 'session/event',
      params: { sessionId: 'sess_fake', seq: 1, type: 'session.updated' },
    })
  }

  if (scenario === 'happy' && message.method === 'session/send') {
    const inputId = message.params.inputId
    const queryId = message.params.queryId
    send({
      id: message.id,
      result: {
        sessionId: message.params.sessionId,
        accepted: true,
        stateRevision: 1,
      },
    })
    setTimeout(() => {
      send({
        method: 'session/event',
        params: {
          eventId: 'evt_fake_text',
          sessionId: 'sess_fake',
          seq: 1,
          timestamp: '2026-08-12T00:00:00.000Z',
          type: 'model.streaming',
          payload: {
            kind: 'text_delta',
            assistantMessageId: 'msg_fake',
            partId: 'part_fake',
            delta: 'fake-ok',
          },
        },
      })
      send({
        method: 'session/event',
        params: {
          eventId: 'evt_fake_complete',
          sessionId: 'sess_fake',
          seq: 2,
          timestamp: '2026-08-12T00:00:00.001Z',
          type: 'turn.completed',
          payload: {
            resultType: 'success',
            inputId,
            queryId,
          },
        },
      })
    }, 5)
    return
  }

  send({ id: message.id, result: resultFor(message) })
})

process.on('exit', () => {
  if (exitPath) writeFileSync(exitPath, String(process.pid))
})

process.once('SIGINT', () => process.exit(0))
process.once('SIGTERM', () => process.exit(0))
