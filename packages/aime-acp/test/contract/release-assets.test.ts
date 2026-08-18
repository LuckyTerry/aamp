import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ERROR_CODES } from '../../src/errors.js';

const packageRoot = dirname(
  fileURLToPath(new URL('../../package.json', import.meta.url)),
);

async function source(path: string): Promise<string> {
  return readFile(join(packageRoot, path), 'utf8');
}

async function run(
  file: string,
  args: readonly string[] = [],
): Promise<{
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(packageRoot, file), ...args], {
      cwd: packageRoot,
      env: { LANG: 'C.UTF-8', PATH: process.env.PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('release assets', () => {
  it('documents the exact install, auth, doctor, and acpx commands', async () => {
    const readme = await source('README.md');
    for (const command of [
      'npm install -g @tengchengwei/aime-acp@0.1.0 --registry=https://bnpm.byted.org',
      'aime-acp auth login --site cn',
      'aime-acp auth status --site cn --json',
      'aime-acp doctor --site cn --json',
      'acpx aime-acp "summarize this HTTP link"',
      'acpx --agent "aime-acp --site i18n-tt" "answer this question"',
    ]) {
      expect(readme).toContain(command);
    }
    for (const schemaMember of [
      '"command": "auth.login.begin"',
      '"command": "auth.login.complete"',
      '"resumeToken": "opaque-resume-token"',
      '"ok": false',
      '"safeMetadata": {}',
      '"code": -32001',
    ]) {
      expect(readme).toContain(schemaMember);
    }
    expect(readme).toContain(
      '| `auth login --begin` | `0` challenge, `1` error |',
    );
    expect(readme).toContain('| `auth login --complete` | `0`, `2`, `1` |');
    expect(readme).toContain(`{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32001,
    "message": "Managed user authentication is required. Run \`aime-acp auth login --site cn\`.",
    "data": {
      "code": "AUTH_REQUIRED",
      "retryable": false
    }
  }
}`);
    expect(readme).toContain(`{
  "schemaVersion": 1,
  "ok": false,
  "command": "auth.login.complete",
  "site": "cn",
  "error": {
    "code": "AUTH_REQUIRED",
    "message": "Authentication did not complete.",
    "retryable": false
  }
}`);
  });

  it('documents every stable error and all security and compatibility boundaries', async () => {
    const readme = await source('README.md');
    for (const code of ERROR_CODES) expect(readme).toContain(`\`${code}\``);
    for (const statement of [
      'one active `aime-acp` ACP process per OS user and site; stop it before login/logout/account changes.',
      'Node.js 20',
      'Node.js 22.13',
      '`cn` and `i18n-tt`',
      'does not execute a global `bytedcli`',
      'does not detect the corporate network',
      "does not access the caller's local workspace",
      'does not connect to MCP servers',
      'text and HTTP(S) links only',
      'soft cancellation',
      'no `logout` command',
    ]) {
      expect(readme).toContain(statement);
    }
    expect(readme).toContain('compatible same-user/site managed auth state');
    expect(readme).toContain('not guaranteed across arbitrary versions');
    expect(readme).not.toMatch(/AAMP.{0,30}(supported|verified)/i);
    expect(readme).not.toMatch(/Feishu.{0,30}(supported|verified)/i);
  });

  it('keeps the package proprietary and separates all release evidence gates', async () => {
    const license = await source('LICENSE');
    expect(license).toContain('UNLICENSED');
    expect(license).toContain('ByteDance');
    expect(license).toContain('internal use');
    expect(license).not.toMatch(/MIT License|Apache License/i);

    const checklist = await source('docs/release-checklist.md');
    for (const heading of [
      'Local deterministic gates',
      'Credentialed AIME gates: cn',
      'Credentialed AIME gates: i18n-tt',
      'AAMP and Feishu Task end-to-end gate',
      'Package-owner publish approval',
    ]) {
      expect(checklist).toContain(heading);
    }
    expect(checklist).toContain('tengchengwei-aime-acp-<version>.tgz');
    expect(checklist).toContain('SHA-256');
    expect(checklist).toContain('dist.integrity');
    expect(checklist).toContain(
      'Do not publish without explicit package-owner approval.',
    );
  });

  it('locks the fake packaged acpx smoke to the public CLI and test-only injection', async () => {
    const smoke = await source('test/smoke/fake-acpx.mjs');
    for (const evidence of [
      "const acpxVersion = '0.11.2'",
      "const registry = 'https://bnpm.byted.org'",
      "'pack'",
      "'--json'",
      'acpx@',
      'acpxVersion',
      "'--agent'",
      "'./node_modules/.bin/aime-acp'",
      "'--format'",
      "'json'",
      "'--json-strict'",
      "'reply with AIME_ACP_OK'",
      '--import=',
      'AIME_ACP_OK',
      'agent_thought_chunk',
      "'plan'",
      "'tool_call'",
      "'tool_call_update'",
      'NO_GLOBAL_BYTEDCLI',
      'CREDENTIAL_SENTINEL',
      'CWD_SENTINEL',
      'RAW_TOOL_SENTINEL',
    ]) {
      expect(smoke).toContain(evidence);
    }
    expect(smoke).not.toContain('spawn(installedBin');
    expect(smoke).not.toContain('execFile(installedBin');
    expect(smoke).toMatch(
      /\[\s*acpx,\s*'--agent',\s*agent,\s*'--format',\s*'json',\s*'--json-strict',\s*'reply with AIME_ACP_OK',\s*\]/,
    );

    const fakeMetadata = JSON.parse(
      await source('test/smoke/fake-acpx-bytedcli/package.json'),
    );
    expect(fakeMetadata).toMatchObject({
      name: '@bytedance-dev/bytedcli',
      version: '0.123.0',
      type: 'module',
      exports: './dist/index.mjs',
    });
    expect(
      await source('test/smoke/fake-acpx-bytedcli/dist/index.mjs'),
    ).toContain("export * from '../../fake-acpx-module.mjs'");
    expect(smoke).toContain(
      "installedRequire.resolve(\n      '@bytedance-dev/bytedcli'",
    );
    expect(smoke).toContain(
      "dirname(resolvedFakeEntry),\n      '..',\n      'package.json'",
    );
  });

  it('makes the real AIME smoke release-only and complete for both sites', async () => {
    const result = await run('test/smoke/real-aime.mjs');
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split(/\r?\n/)).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: false,
      sites: ['cn', 'i18n-tt'],
      errorCode: 'INVALID_ARGUMENT',
    });

    const smoke = await source('test/smoke/real-aime.mjs');
    const guards = await source('test/smoke/real-aime-guards.mjs');
    const implementation = `${smoke}\n${guards}`;
    for (const evidence of [
      "const requiredSites = ['cn', 'i18n-tt']",
      '--approve-real-aime-smoke',
      "'auth', 'status'",
      "'auth', 'login'",
      "'doctor'",
      "'session/new'",
      "'session/load'",
      "'session/prompt'",
      "'session/cancel'",
      'agent_message_chunk',
      'waiting_for_next',
      "sessionUpdate === 'tool_call'",
      "sessionUpdate === 'tool_call_update'",
      "stopReason !== 'cancelled'",
      "createHash('sha256')",
      'closeAndDelete',
      "'--tool-profile'",
      "'public-http-lookup'",
      'https://example.com',
      'assertWaitingForNext',
      'cancelLatencyMs',
      'SESSION_BUSY',
      'privacyCanaries',
      'scanPrivacyEvidence',
      'randomBytes(8)',
      'closeTimeoutMs',
      'observeLiveDeltaBeforeTerminal',
      'createEphemeralEvidenceLog',
      'readAndScan',
      '...clients.map((client) => client.evidence())',
      'promptStrings.push(',
    ]) {
      expect(implementation).toContain(evidence);
    }
    expect(smoke).not.toContain('--allowlisted-tool-name');
    expect(smoke).not.toContain('--allowlisted-tool-prompt');
    expect(smoke).not.toContain('options.toolPrompt');
    expect(smoke).not.toContain('options.allowlistedToolName');
    expect(smoke).not.toMatch(/AIME_USER_CLOUD_JWT|BYTEDCLI_USER_CLOUD_JWT/);
    expect(smoke).not.toContain('--resume-token');

    const rejected = await run('test/smoke/real-aime.mjs', [
      '--allowlisted-tool-name',
      'delete-resource',
      '--allowlisted-tool-prompt',
      'upload private data',
    ]);
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toBe('');
    expect(JSON.parse(rejected.stdout)).toMatchObject({
      ok: false,
      errorCode: 'INVALID_ARGUMENT',
    });
  });
});
