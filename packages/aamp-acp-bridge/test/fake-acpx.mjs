import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const cwd = process.env.AAMP_FAKE_ACPX_CWD
const mode = process.env.AAMP_FAKE_ACPX_MODE
const args = process.argv.slice(2)
appendFileSync(join(cwd, 'acpx.log'), args.join(' ') + '\n')
if (args.includes('--file')) {
  let input = ''
  for await (const chunk of process.stdin) input += chunk.toString('utf8')
  writeFileSync(join(cwd, 'stdin.json'), input)
}

if (args.includes('prompt')) {
  switch (mode) {
    case 'auth-failure':
      console.error('Authentication required. Please use /login command to sign in to your account')
      break
    case 'auth-with-output':
      console.log('partial assistant reply')
      console.error('warning: session disconnected\n[error] Authentication required')
      break
    case 'json-auth-failure':
      console.log('partial assistant reply')
      console.log(JSON.stringify({ jsonrpc: '2.0', id: '1', error: { message: 'Authentication required' } }))
      break
    case 'json-aime-auth-failure':
      console.log(JSON.stringify({ jsonrpc: '2.0', id: '1', error: { code: -32001, message: 'Managed user authentication is required. Run `aime-acp auth login --site cn`.', data: { code: 'AUTH_REQUIRED', retryable: false } } }))
      break
    case 'json-aime-sources': {
      const output = 'FEISHU_TASK_RESULT_JSON: ' + JSON.stringify({ schema: 'feishu_task_result.v2', status: 'answered', summary: '成都天气', reply_written: false })
      for (const update of [
        { content: { type: 'text', text: 'AAMP_RESULT_JSON: ' + JSON.stringify({ output }) } },
        { _meta: { 'aime.acp.message_kind': 'sources' }, content: { type: 'text', text: 'Sources:\n- [Guide](https://example.test/guide)' } },
      ]) console.log(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'aamp-aime', update: { sessionUpdate: 'agent_message_chunk', messageId: 'aime-sources', ...update } } }))
      console.log(JSON.stringify({ jsonrpc: '2.0', id: '1', result: { stopReason: 'end_turn' } }))
      break
    }
    case 'auth-discussion':
      console.log('The phrase authentication required may appear in diagnostic logs.')
  }
} else if (args.includes('new')) {
  if (mode === 'auth-failure') {
    console.error('Authentication required')
    process.exitCode = 1
  } else if (mode === 'timeout') {
    setTimeout(() => {}, 5000)
  } else console.log('probe-session-id')
} else if (args.includes('close')) {
  const countFile = join(cwd, 'close-count')
  const count = existsSync(countFile) ? Number(readFileSync(countFile, 'utf8')) + 1 : 1
  if (mode === 'close-retry') writeFileSync(countFile, String(count))
  if (mode === 'close-retry' && count === 1) {
    console.error('temporary cleanup failure')
    process.exitCode = 1
  } else console.log('probe-session-id')
}
