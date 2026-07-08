import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveFeishuWebsocketDomain } from './runtime.js'

test('resolveFeishuWebsocketDomain uses online domain for pre websocket endpoint', () => {
  assert.equal(resolveFeishuWebsocketDomain('https://open.feishu-pre.cn'), 'https://open.feishu.cn')
})

test('resolveFeishuWebsocketDomain tolerates trailing slashes in pre domain', () => {
  assert.equal(resolveFeishuWebsocketDomain(' https://open.feishu-pre.cn/ '), 'https://open.feishu.cn')
})

test('resolveFeishuWebsocketDomain keeps non-pre domains unchanged', () => {
  assert.equal(resolveFeishuWebsocketDomain(undefined), undefined)
  assert.equal(resolveFeishuWebsocketDomain('https://open.feishu.cn'), 'https://open.feishu.cn')
  assert.equal(resolveFeishuWebsocketDomain('https://open.feishu-boe.cn'), 'https://open.feishu-boe.cn')
  assert.equal(resolveFeishuWebsocketDomain('https://custom.example.com'), 'https://custom.example.com')
})
