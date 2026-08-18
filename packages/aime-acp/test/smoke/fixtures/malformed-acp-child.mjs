import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

let terminating = false;

process.on('SIGTERM', () => {
  if (terminating) return;
  terminating = true;
  const holder = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "setTimeout(() => process.stderr.write('LATE_STDERR_AFTER_TERM\\n'), 100); setTimeout(() => process.exit(0), 180);",
    ],
    { stdio: ['ignore', 'ignore', process.stderr] },
  );
  process.stderr.write(`HOLDER_PID=${String(holder.pid)}\n`);
  process.exit(0);
});

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const frame = JSON.parse(line);
  if (frame.method === 'initialize') {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {} })}\n`,
    );
    return;
  }
  process.stdout.write('not-json\n');
});
