import { readFile } from 'node:fs/promises';

import { startLiveAcp } from '../smoke/auth-coexistence.mjs';

const mode = process.argv[2];
const fakeBin = process.argv[3];
const marker = process.argv[4];
const timeouts = {
  requestTimeoutMs: 300,
  closeTimeoutMs: 50,
  terminateTimeoutMs: 100,
};

if (mode === 'init-failure') {
  let rejected = false;
  try {
    await startLiveAcp(fakeBin, process.env, '/', 'cn', timeouts);
  } catch {
    rejected = true;
  }
  const cleaned =
    rejected &&
    marker !== undefined &&
    (await readFile(marker, 'utf8')) === 'terminated\n';
  process.stdout.write(`${JSON.stringify({ ok: cleaned })}\n`);
  process.exitCode = cleaned ? 0 : 1;
} else if (mode === 'bounded-stop') {
  const acp = await startLiveAcp(fakeBin, process.env, '/', 'cn', timeouts);
  const startedAt = Date.now();
  let rejected = false;
  try {
    await acp.stop();
  } catch {
    rejected = true;
  }
  const bounded = rejected && Date.now() - startedAt < 2_000;
  process.stdout.write(`${JSON.stringify({ ok: bounded, bounded })}\n`);
  process.exitCode = bounded ? 0 : 1;
} else {
  process.stdout.write(`${JSON.stringify({ ok: false })}\n`);
  process.exitCode = 1;
}
