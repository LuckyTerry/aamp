const args = process.argv.slice(2);

if (args.includes('pack')) {
  process.stdout.write(
    `${JSON.stringify([
      {
        filename: 'aime-acp-cleanup-probe.tgz',
        files: [],
      },
    ])}\n`,
  );
  process.exit(0);
}

if (args.includes('install')) {
  process.exit(0);
}

process.stderr.write('unexpected fake npm invocation\n');
process.exit(2);
