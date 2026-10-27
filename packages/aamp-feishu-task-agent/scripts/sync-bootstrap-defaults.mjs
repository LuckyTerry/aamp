#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const defaults = JSON.parse(await readFile(new URL('bootstrap/task-agent-defaults.json', root), 'utf8'))
const bootstrapUrl = new URL('bootstrap/aamp-feishu-task-agent-bootstrap.sh', root)
const source = await readFile(bootstrapUrl, 'utf8')
const registerSource = (await readFile(new URL('bootstrap/register-feishu-app.mjs', root), 'utf8')).trimEnd()
const scalar = `# BEGIN GENERATED TASK AGENT DEFAULTS
CODEX_NPM_PACKAGE="\${CODEX_NPM_PACKAGE:-${defaults.packages.codexCli}}"
CODEX_ACP_PKG="\${CODEX_ACP_PKG:-${defaults.packages.codexAcp}}"
LARK_REGISTER_APP_SDK="\${LARK_REGISTER_APP_SDK:-${defaults.packages.registerAppSdk}}"
LARK_CLI_MIN_VERSION="\${LARK_CLI_MIN_VERSION:-${defaults.larkCli.minVersion}}"
# END GENERATED TASK AGENT DEFAULTS`
const bridge = `# BEGIN GENERATED TASK AGENT BRIDGE DEFAULTS
ACP_BRIDGE_PKG="\${ACP_BRIDGE_PKG:-${defaults.packages.acpBridge}}"
FEISHU_BRIDGE_PKG="\${FEISHU_BRIDGE_PKG:-${defaults.packages.feishuBridge}}"
AIME_ACP_PKG="\${AIME_ACP_PKG:-${defaults.packages.aimeAcp}}"
# END GENERATED TASK AGENT BRIDGE DEFAULTS`
const manifest = `# BEGIN GENERATED TASK AGENT SCOPE MANIFEST
  cat <<'JSON'
${JSON.stringify(defaults.scopeManifest)}
JSON
# END GENERATED TASK AGENT SCOPE MANIFEST`
const register = `# BEGIN GENERATED FEISHU REGISTER HELPER
  cat >"$register_script" <<'NODE'
${registerSource}
NODE
  # END GENERATED FEISHU REGISTER HELPER`
function replaceBlock(value,start,end,replacement){const pattern=new RegExp(`${start.replace(/[.*+?^${}()|[\\]\\]/g,'\\$&')}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\\]\\]/g,'\\$&')}`);if(!pattern.test(value))throw new Error(`missing generated block: ${start}`);return value.replace(pattern,replacement)}
let generated=replaceBlock(source,'# BEGIN GENERATED TASK AGENT DEFAULTS','# END GENERATED TASK AGENT DEFAULTS',scalar)
generated=replaceBlock(generated,'# BEGIN GENERATED TASK AGENT BRIDGE DEFAULTS','# END GENERATED TASK AGENT BRIDGE DEFAULTS',bridge)
generated=replaceBlock(generated,'# BEGIN GENERATED TASK AGENT SCOPE MANIFEST','# END GENERATED TASK AGENT SCOPE MANIFEST',manifest)
generated=replaceBlock(generated,'# BEGIN GENERATED FEISHU REGISTER HELPER','# END GENERATED FEISHU REGISTER HELPER',register)
if(process.argv.includes('--check')) { if(generated!==source){console.error('bootstrap defaults are out of sync; run node scripts/sync-bootstrap-defaults.mjs');process.exitCode=1} }
else await writeFile(bootstrapUrl,generated)
