#!/usr/bin/env node

import {
  parseBootstrapConfig,
  sanitizePackageEnvironment,
  validatePreImportEnvironment,
} from './config.js';
import { toSafeError } from './errors.js';

try {
  validatePreImportEnvironment(process.env);
  const config = parseBootstrapConfig(process.argv.slice(2), process.env);
  sanitizePackageEnvironment(process.env);
  const { runProgram } = await import('./program.js');
  process.exitCode = await runProgram(config, {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
} catch (error) {
  process.stderr.write(`${JSON.stringify(toSafeError(error))}\n`);
  process.exitCode = 1;
}
