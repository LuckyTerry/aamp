import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SseStreamParser } from './stream-parser.js'

test('SseStreamParser treats Codem done final_text as finalText', () => {
  const parser = new SseStreamParser()

  const updates = parser.push(`${[
    'event: done',
    'data: {"final_answer_structured":null,"final_text":"AAMP_RESULT_JSON: {\\"output\\":\\"done\\"}","reason":"end_turn","synthetic":false}',
    '',
  ].join('\n')}\n`)

  assert.equal(updates.length, 1)
  assert.equal(updates[0]?.event.type, 'done')
  assert.equal(updates[0]?.finalText, 'AAMP_RESULT_JSON: {"output":"done"}')
})
