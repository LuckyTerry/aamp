import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
);

describe('package contract', () => {
  it('pins the only production SDK dependencies and exposes one bin', () => {
    expect(pkg.name).toBe('@tengchengwei/aime-acp');
    expect(pkg.bin).toEqual({ 'aime-acp': 'dist/bin.js' });
    expect(pkg.engines).toEqual({ node: '>=20' });
    expect(pkg.dependencies).toEqual({
      '@agentclientprotocol/sdk': '0.28.1',
      '@bytedance-dev/bytedcli': '0.123.0',
    });
    expect(JSON.stringify(pkg.dependencies).toLowerCase()).not.toContain(
      'togo',
    );
  });

  it('publishes only internal deliverables', () => {
    expect(pkg.publishConfig.registry).toBe('https://bnpm.byted.org');
    expect(pkg.files).toEqual(['dist', 'README.md', 'LICENSE']);
  });
});
