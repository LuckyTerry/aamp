import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TaskResult } from 'aamp-sdk'
import { classifyFeishuTaskResult } from './runtime.js'

for (const filePath of [String.raw`C:\Users\Tester\node_modules\report\result.csv`, String.raw`\\server\reports\native\result.csv`]) {
  for (const wrapped of [false, true]) {
    test(`Windows file delivery preserves path separators (${wrapped ? 'wrapped' : 'direct'} ${filePath})`, { skip: process.platform !== 'win32' }, () => {
      const payload = { schema: 'feishu_task_result.v2', status: 'succeeded', summary: String.raw`First\nSecond`, outputs: [{ kind: 'file_delivery', path: filePath }] }
      const inner = 'FEISHU_TASK_RESULT_JSON:' + JSON.stringify(payload)
      const result: TaskResult = { protocolVersion: '1.1', intent: 'task.result', taskId: 'windows-path', status: 'completed', output: wrapped ? 'AAMP_RESULT_JSON:' + JSON.stringify({ output: inner }) : inner, from: 'agent@meshmail.ai', to: 'bridge@meshmail.ai' }
      const disposition = classifyFeishuTaskResult(result, 'local')
      assert.equal(disposition.kind, 'succeeded')
      if (disposition.kind !== 'succeeded') throw new Error('Expected successful local file output')
      assert.deepEqual(disposition.outputs, [{ kind: 'file_delivery', path: filePath }])
    })
  }
}
