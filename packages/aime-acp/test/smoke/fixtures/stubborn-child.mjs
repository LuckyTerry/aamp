process.on('SIGTERM', () => {
  process.stdout.write('TERM_OBSERVED\n');
});

setInterval(() => undefined, 1_000);
