import { readFileSync } from 'node:fs';

interface PackageMetadata {
  readonly name: string;
  readonly version: string;
}

const metadata = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageMetadata;

export const AIME_ACP_PACKAGE_NAME = metadata.name;
export const AIME_ACP_PACKAGE_VERSION = metadata.version;
