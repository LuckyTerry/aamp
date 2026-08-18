import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  cleanupAuthenticatedHome,
  runApprovedSmoke,
} from '../smoke/auth-coexistence.mjs';

const mode = process.argv[2];
const root = process.argv[3];
const testHome = join(root, 'supplied-home');
await mkdir(testHome, { recursive: true });
await writeFile(join(testHome, 'caller.marker'), 'preserve\n');

const events = [];
let createdSibling;

function processResult(code, json) {
  return { code, json, stdout: '', stderr: '', signal: null };
}

function classifyRun(argv) {
  if (argv.includes('auth') && argv.includes('login')) return 'login';
  if (argv.includes('auth') && argv.includes('status')) return 'status';
  if (argv.includes('doctor')) return 'doctor';
  const source = argv[argv.indexOf('--eval') + 1];
  if (source?.includes('byteCloudAuthLogin')) return 'bytedcli-login';
  if (source?.includes('byteCloudAuthEnsureAuth')) return 'probe';
  throw new Error('unexpected run');
}

const dependencies = {
  async runJson(_file, argv) {
    const operation = classifyRun(argv);
    events.push(`run:${operation}`);
    if (operation === 'login' && mode === 'primary-login-failure') {
      return processResult(1, { status: 'unauthenticated' });
    }
    if (operation === 'login' || operation === 'status') {
      return processResult(0, { status: 'authenticated' });
    }
    if (operation === 'probe') {
      return processResult(0, {
        ok: true,
        authenticated: true,
        aimeReachable: true,
      });
    }
    if (operation === 'bytedcli-login') {
      return processResult(mode === 'sibling-login-failure' ? 1 : 0, {
        ok: mode !== 'sibling-login-failure',
      });
    }
    return processResult(0, {
      authenticated: true,
      aimeReachable: true,
    });
  },
  async startLiveAcp() {
    if (mode === 'primary-and-cleanup-failure') {
      events.push('start:failure');
      throw Object.assign(new Error('AUTH_IDENTITY_CHANGED'), {
        safeCode: 'AUTH_IDENTITY_CHANGED',
      });
    }
    events.push('start:live-child');
    let requestIndex = 0;
    return {
      async request() {
        requestIndex += 1;
        if (requestIndex === 1) {
          events.push('request:live-child:baseline');
          return { sessionId: 'not-emitted' };
        }
        if (requestIndex === 2) {
          events.push('request:live-child:auth-required');
          throw { data: { code: 'AUTH_REQUIRED' } };
        }
        events.push('request:live-child:identity-changed');
        throw { data: { code: 'AUTH_IDENTITY_CHANGED' } };
      },
      async stop() {
        events.push('stop:live-child');
      },
    };
  },
  async acknowledgeExternalMutation(_input, action, expected) {
    if (action.includes('logout') && expected === 'LOGOUT COMPLETE') {
      events.push('prompt:logout');
      return;
    }
    if (
      action.includes('different managed account') &&
      expected === 'ACCOUNT SWITCH COMPLETE'
    ) {
      events.push('prompt:switch');
      return;
    }
    throw new Error('unexpected mutation prompt');
  },
  async mkdtemp() {
    createdSibling = join(root, 'script-sibling');
    await mkdir(createdSibling, { recursive: true });
    events.push('make:sibling');
    return createdSibling;
  },
  async cleanupAuthenticatedHome(home, site, input, bin, packageDirectory) {
    const label = home === testHome ? 'primary' : 'sibling';
    await cleanupAuthenticatedHome(home, site, input, bin, packageDirectory, {
      async acknowledgeExternalMutation(_cleanupInput, _action, expected) {
        if (expected !== 'CLEANUP LOGOUT COMPLETE') {
          throw new Error('unexpected cleanup prompt');
        }
        events.push(`cleanup-prompt:${label}`);
      },
      async runJson() {
        events.push(`cleanup-status:${label}`);
        const shouldFail =
          (mode === 'cleanup-status-failure' && label === 'sibling') ||
          mode === 'primary-and-cleanup-failure';
        return shouldFail
          ? processResult(0, { status: 'authenticated' })
          : processResult(1, { status: 'unauthenticated' });
      },
    });
  },
  async rm(path, options) {
    events.push('remove:sibling');
    await rm(path, options);
  },
};

let errorCode;
try {
  await runApprovedSmoke(testHome, 'cn', {}, dependencies);
} catch (error) {
  errorCode = error?.safeCode;
}

const output = {
  ok: errorCode === undefined,
  ...(errorCode === undefined ? {} : { errorCode }),
  suppliedHomePreserved: existsSync(join(testHome, 'caller.marker')),
  siblingRemoved:
    createdSibling === undefined ? true : !existsSync(createdSibling),
  events,
};
process.stdout.write(`${JSON.stringify(output)}\n`);
