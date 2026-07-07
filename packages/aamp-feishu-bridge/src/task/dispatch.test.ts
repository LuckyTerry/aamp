import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildFeishuTaskPromptRules } from './dispatch.js'

test('buildFeishuTaskPromptRules explains nested multiline JSON escaping', () => {
  const rules = buildFeishuTaskPromptRules()

  assert.match(rules, /Because FEISHU_TASK_RESULT_JSON is embedded inside AAMP_RESULT_JSON\.output/i)
  assert.match(rules, /multiline user-visible fields must appear as `\\\\n` in the final visible AAMP_RESULT_JSON text/i)
  assert.match(rules, /after parsing the outer JSON, the inner FEISHU_TASK_RESULT_JSON must still contain `\\n` escape sequences/i)
  assert.match(rules, /Example multiline answered bridge-comment:/)
  assert.match(rules, /第一行\\\\n\\\\n第二行\\\\n- item/)
})
