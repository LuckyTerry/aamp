import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const controllerPath = path.resolve(testDir, '../bin/feishu-task-agent-controller.mjs')

test('multi-select prompt explains Space selection and the effect of selecting all', () => {
  const source = readFileSync(controllerPath, 'utf8')
  const chooseManyStart = source.indexOf('async function chooseMany(')
  const chooseManyEnd = source.indexOf('\nasync function confirm(', chooseManyStart)

  assert.notEqual(chooseManyStart, -1, 'chooseMany must exist')
  assert.notEqual(chooseManyEnd, -1, 'confirm must follow chooseMany')

  const chooseMany = source.slice(chooseManyStart, chooseManyEnd)
  assert.match(
    chooseMany,
    /使用 ↑\/↓ 移动，按空格键选择（支持多选），按回车键确认；选择“全部”会取消其他选项的选中状态。/,
  )
})
