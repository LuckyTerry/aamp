import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin });
lines.once('line', (line) => {
  const frame = JSON.parse(line);
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {} })}\n`,
    () => {
      const holder = spawn(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          "setTimeout(() => process.stderr.write('STDIN_ERROR_TERMINATED\\n'), 100); setTimeout(() => process.exit(0), 400);",
        ],
        { stdio: ['ignore', 'ignore', process.stderr] },
      );
      process.stderr.write(`STDIN_HOLDER_PID=${String(holder.pid)}\n`);
      process.exit(0);
    },
  );
});
