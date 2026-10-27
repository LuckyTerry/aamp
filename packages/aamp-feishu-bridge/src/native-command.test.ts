import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveNativeCommand } from './native-command.js'

test('resolveNativeCommand preserves an explicit native Windows executable', () => {
  const root = mkdtempSync(join(tmpdir(), 'aamp-feishu-native-command-'))
  try {
    const executable = join(root, 'lark-cli.exe')
    writeFileSync(executable, '')
    assert.deepEqual(resolveNativeCommand(executable, {
      platform: 'win32',
      env: {},
    }), { command: executable, argsPrefix: [] })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveNativeCommand resolves lark-cli npm shim to its real JavaScript entry', () => {
  const root = mkdtempSync(join(tmpdir(), 'aamp-feishu-native-command-'))
  try {
    const bin = join(root, 'bin')
    const packageDir = join(root, 'lark cli')
    mkdirSync(bin, { recursive: true })
    mkdirSync(packageDir, { recursive: true })
    const entry = join(packageDir, 'index.js')
    writeFileSync(entry, '')
    writeFileSync(join(bin, 'lark-cli.cmd'), [
      '@ECHO off',
      'SETLOCAL',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & node  "%dp0%\\..\\lark cli\\index.js" %*',
      '',
    ].join('\r\n'))

    assert.deepEqual(resolveNativeCommand('lark-cli', {
      platform: 'win32',
      env: { PATH: bin, PATHEXT: '.CMD' },
    }), { command: process.execPath, argsPrefix: [entry] })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})


test('explicit JavaScript CLI entries run through Node and preserve real argv and exit code', async () => {
  const {spawnSync}=await import('node:child_process')
  const root=mkdtempSync(join(tmpdir(), 'aamp-lark-js-'))
  try {
    for (const extension of ['js','cjs','mjs']) {
      const entry=join(root,`lark cli.${extension}`)
      writeFileSync(entry,`console.log(JSON.stringify(process.argv.slice(2)));process.exit(7)`)
      const resolved=resolveNativeCommand(entry,{platform:'win32',env:{}})
      assert.deepEqual(resolved,{command:process.execPath,argsPrefix:[entry]})
      const args=['--profile',`name ' & 中文`, 'auth', 'status']
      const result=spawnSync(resolved.command,[...resolved.argsPrefix,...args],{encoding:'utf8',shell:false})
      assert.equal(result.status,7)
      assert.deepEqual(JSON.parse(result.stdout),args)
      assert.deepEqual(resolveNativeCommand(entry,{platform:'linux',env:{}}),{command:entry,argsPrefix:[]})
    }
  } finally {rmSync(root,{recursive:true,force:true})}
})
