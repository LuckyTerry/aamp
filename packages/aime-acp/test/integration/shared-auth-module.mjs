import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const SCENARIO_FD = 3;
const completionOutcomes = new Set(['success', 'pending', 'expired', 'denied']);

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value
    : {};
}

function scenarioFromPipe() {
  const scenario = record(JSON.parse(readFileSync(SCENARIO_FD, 'utf8')));
  if (
    typeof scenario.storePath !== 'string' ||
    !isAbsolute(scenario.storePath)
  ) {
    throw new TypeError('shared auth store path must be absolute');
  }
  return scenario;
}

const scenario = scenarioFromPipe();
const storePath = scenario.storePath;

function readStore() {
  return record(JSON.parse(readFileSync(storePath, 'utf8')));
}

function writeStore(value) {
  const temporaryPath = `${storePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, storePath);
}

function tokenHash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function selectedOutcome(store) {
  return completionOutcomes.has(store.outcome) ? store.outcome : 'denied';
}

export const auth = {
  async getExternalBytecloudAuthStatus() {
    return {
      authenticated: readStore().authenticated === true,
      auth_source: 'bytecloud_auth',
    };
  },
  async byteCloudAuthEnsureAuth() {
    return readStore().authenticated === true
      ? {
          status: 'ready',
          authType: 'user',
          expiresAt: '2035-01-02T03:04:05.000Z',
        }
      : { status: 'login_required' };
  },
  async byteCloudAuthUserInfo() {
    return { employeeId: 'shared-fake-user' };
  },
  async byteCloudAuthLogin() {
    return { status: 'pending' };
  },
  async byteCloudAuthBeginLogin() {
    const resumeToken = `resume_${randomBytes(32).toString('base64url')}`;
    const store = readStore();
    writeStore({
      ...store,
      authenticated: false,
      tokenHash: tokenHash(resumeToken),
    });
    return {
      challengeToken: resumeToken,
      preferredUrl: 'https://login.example.test/verify',
      displayCode: 'SAFE-CODE',
      expiresAt: '2035-01-02T03:04:05.000Z',
    };
  },
  async byteCloudAuthCompleteLogin(resumeToken) {
    const store = readStore();
    if (
      typeof store.tokenHash !== 'string' ||
      store.tokenHash !== tokenHash(resumeToken)
    ) {
      return { status: 'invalid_ticket' };
    }
    const outcome = selectedOutcome(store);
    writeStore({
      ...store,
      authenticated: outcome === 'success',
      lastOutcome: outcome,
    });
    return { status: outcome };
  },
};

export const utils = {
  setCloudSite() {},
  setAuthAs() {},
  setHttpConfig() {},
};
