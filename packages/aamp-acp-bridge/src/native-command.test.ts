import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveNativeCommand } from './native-command.js'

test('resolveNativeCommand launches an npm Windows shim through its real Node bin', () => {
  const root = mkdtempSync(join(tmpdir(), 'aamp-native-command-'))
  try {
    const bin = join(root, 'bin')
    const packageDir = join(root, 'fixture package')
    mkdirSync(bin, { recursive: true })
    mkdirSync(packageDir, { recursive: true })
    const entry = join(packageDir, 'cli.mjs')
    writeFileSync(entry, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')
    writeFileSync(join(bin, 'acpx.cmd'), [
      '@ECHO off',
      'SETLOCAL',
      'IF EXIST "%~dp0\\node.exe" (',
      '  SET "_prog=%~dp0\\node.exe"',
      ') ELSE (',
      '  SET "_prog=node"',
      ')',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%~dp0\\..\\fixture package\\cli.mjs" %*',
      '',
    ].join('\r\n'))

    const resolved = resolveNativeCommand('acpx', {
      platform: 'win32',
      env: { Path: bin, PATHEXT: '.EXE;.CMD' },
    })
    assert.deepEqual(resolved, { command: process.execPath, argsPrefix: [entry] })

    const result = spawnSync(resolved.command, [...resolved.argsPrefix, '中文 path', 'quote"value'], {
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, '["中文 path","quote\\\"value"]')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveNativeCommand rejects an unverified Windows command script', () => {
  const root = mkdtempSync(join(tmpdir(), 'aamp-native-command-'))
  try {
    writeFileSync(join(root, 'acpx.cmd'), '@echo arbitrary command\r\n')
    assert.throws(
      () => resolveNativeCommand('acpx', {
        platform: 'win32',
        env: { PATH: root, PATHEXT: '.CMD' },
      }),
      /npm-generated Node shim/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveNativeCommand supports the npm npx.cmd variable form', () => {
  const root = mkdtempSync(join(tmpdir(), 'aamp-native-command-'))
  try {
    const npmBin = join(root, 'npm bin')
    const entry = join(npmBin, 'node_modules', 'npm', 'bin', 'npx-cli.js')
    mkdirSync(join(npmBin, 'node_modules', 'npm', 'bin'), { recursive: true })
    writeFileSync(entry, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')
    writeFileSync(join(npmBin, 'npx.cmd'), [
      ':: Created by npm, please don\'t edit manually.',
      '@ECHO OFF',
      'SETLOCAL',
      'SET "NODE_EXE=%~dp0\\node.exe"',
      'IF NOT EXIST "%NODE_EXE%" ( SET "NODE_EXE=node" )',
      'SET "NPX_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npx-cli.js"',
      '"%NODE_EXE%" "%NPX_CLI_JS%" %*',
      '',
    ].join('\r\n'))

    assert.deepEqual(resolveNativeCommand('npx', {
      platform: 'win32',
      env: { Path: npmBin, PATHEXT: '.CMD' },
    }), { command: process.execPath, argsPrefix: [entry] })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
