import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import {
  AIME_ACP_PACKAGE_NAME,
  AIME_ACP_PACKAGE_VERSION,
} from '../../src/package-info.js';

const pkg = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
);

describe('package identity', () => {
  it('uses package metadata as the runtime identity source', () => {
    expect(AIME_ACP_PACKAGE_NAME).toBe(pkg.name);
    expect(AIME_ACP_PACKAGE_VERSION).toBe(pkg.version);
  });
});
