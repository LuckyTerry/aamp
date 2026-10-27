import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {cliName, npxBridgeHint, missingConfigHint} from './platform-hints.js'

test('Windows examples reference the actual packaged identity and version',()=>{
 const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'))
 assert.equal(npxBridgeHint('win32'),`npx.cmd --yes --package ${pkg.name}@${pkg.version} aamp-acp-bridge`)
 assert.equal(cliName('aamp-acp-bridge','win32'),'aamp-acp-bridge.cmd')
 assert.equal(cliName('npm','win32'),'npm.cmd')
})
test('Windows recovery displays the original config path with literal PowerShell quoting',()=>{
 const file="C:\\Users\\O'Brien $test\\配置\\config.json"
 assert.equal(missingConfigHint(file,'win32'),`Config file not found: ${file}. Run "aamp-acp-bridge.cmd init --config 'C:\\Users\\O''Brien $test\\配置\\config.json'" first.`)
})
test('macOS keeps the existing messages verbatim',()=>{
 assert.equal(npxBridgeHint('darwin'),'npx aamp-acp-bridge')
 assert.equal(cliName('aamp-acp-bridge','darwin'),'aamp-acp-bridge')
 assert.equal(missingConfigHint('/tmp/config.json','darwin'),"Config file not found: /tmp/config.json. Run 'aamp-acp-bridge init' first.")
})
