import { readdirSync } from 'node:fs';
import { delimiter } from 'node:path';
import { register } from 'node:module';

const pathEntries = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
if (pathEntries.length !== 1) throw new Error('unsafe fake acpx PATH');
if (readdirSync(pathEntries[0]).some((entry) => /bytedcli/i.test(entry))) {
  throw new Error('global bytedcli is reachable in fake acpx PATH');
}
if (process.env.CREDENTIAL_SENTINEL !== 'credential-do-not-emit') {
  throw new Error('credential sentinel was not inherited');
}
if (process.env.CWD_SENTINEL !== 'cwd-do-not-emit') {
  throw new Error('cwd sentinel was not inherited');
}
if (process.env.RAW_TOOL_SENTINEL !== 'raw-tool-do-not-emit') {
  throw new Error('raw tool sentinel was not inherited');
}

register(
  new URL('./fake-acpx-loader.mjs', import.meta.url).href,
  import.meta.url,
);
