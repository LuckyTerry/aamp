import { readFileSync } from 'node:fs';

const SCENARIO_FD = 3;

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value
    : {};
}

function scenarioFromPipe() {
  const raw = readFileSync(SCENARIO_FD, 'utf8');
  const value = JSON.parse(raw);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('fake bytedcli scenario must be an object');
  }
  return value;
}

function scriptedError(value) {
  const source = record(value);
  const error = new Error('synthetic bytedcli failure');
  Object.assign(error, source);
  return error;
}

const scenario = scenarioFromPipe();
if (Number.isSafeInteger(scenario.exitCode)) {
  process.once('beforeExit', () => {
    process.exitCode = scenario.exitCode;
    if (typeof scenario.exitStderr === 'string')
      process.stderr.write(scenario.exitStderr);
  });
}
const authScenario = record(scenario.auth);
const space = record(scenario.space);
const promptQueue = Array.isArray(scenario.prompts)
  ? scenario.prompts.map((value) => record(value))
  : [];
const sessions = new Map();
for (const [sessionId, value] of Object.entries(record(scenario.sessions))) {
  const source = record(value);
  sessions.set(sessionId, {
    id: sessionId,
    status: typeof source.status === 'string' ? source.status : 'completed',
    sourceSpaceId:
      typeof source.sourceSpaceId === 'string'
        ? source.sourceSpaceId
        : String(space.id ?? 'remote-space'),
    messages: Array.isArray(source.messages) ? [...source.messages] : [],
    events: Array.isArray(source.events) ? [...source.events] : [],
    gateAfterOffset: undefined,
    gateOpen: true,
    streamErrorOnceAtOffset: undefined,
    streamErrorRaised: false,
  });
}

function session(sessionId) {
  const value = sessions.get(sessionId);
  if (value === undefined) {
    throw scriptedError({ status: 404, code: 'SESSION_NOT_FOUND' });
  }
  return value;
}

function eventOffset(value) {
  return Number(record(record(value).data).event_offset ?? -1);
}

function waitForAbort(signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal?.addEventListener('abort', resolve, { once: true });
  });
}

export const auth = {
  async getExternalBytecloudAuthStatus() {
    if (authScenario.externalStatusError !== undefined)
      throw scriptedError(authScenario.externalStatusError);
    return {
      authenticated: typeof authScenario.externalSource === 'string',
      auth_source: authScenario.externalSource ?? null,
    };
  },
  async byteCloudAuthEnsureAuth() {
    if (authScenario.statusError !== undefined)
      throw scriptedError(authScenario.statusError);
    return authScenario.authenticated === false
      ? { status: 'login_required' }
      : {
          status: 'ready',
          authType: 'user',
          expiresAt: '2035-01-02T03:04:05.000Z',
        };
  },
  async byteCloudAuthUserInfo() {
    if (authScenario.identityError !== undefined)
      throw scriptedError(authScenario.identityError);
    const identity = record(authScenario.identity);
    const field =
      typeof identity.field === 'string' ? identity.field : 'employeeId';
    return { [field]: String(identity.value ?? 'fake-user-1001') };
  },
  async byteCloudAuthLogin({ onEvent }) {
    onEvent?.({ type: 'auth.login.waiting', payload: {} });
    return { status: 'success' };
  },
  async byteCloudAuthBeginLogin() {
    return {
      challengeToken: scenario.resumeToken ?? 'synthetic-resume-token',
      preferredUrl: 'https://login.example.test/verify',
      displayCode: 'SAFE-CODE',
      expiresAt: '2035-01-02T03:04:05.000Z',
    };
  },
  async byteCloudAuthCompleteLogin() {
    return { status: 'success' };
  },
};

export const utils = {
  setCloudSite() {},
  setAuthAs() {},
  setHttpConfig() {},
};

export const api = {
  aime: {
    async listSpaces() {
      if (scenario.listSpacesError !== undefined)
        throw scriptedError(scenario.listSpacesError);
      return {
        spaces: [
          {
            id: String(space.id ?? 'remote-space'),
            type: 'personal',
            status: 'active',
          },
        ],
      };
    },
    async listModels() {
      return {
        text_models_by_execution_mode: { fast: [], max: [] },
      };
    },
    async createSession(spaceId) {
      const id = String(scenario.newSessionId ?? 'remote-new-session');
      if (!sessions.has(id)) {
        sessions.set(id, {
          id,
          status: 'completed',
          sourceSpaceId: spaceId,
          messages: [],
          events: [],
          gateAfterOffset: undefined,
          gateOpen: true,
          streamErrorOnceAtOffset: undefined,
          streamErrorRaised: false,
        });
      }
      const created = session(id);
      return { id, source_space_id: created.sourceSpaceId };
    },
    async getSession(sessionId, options = {}) {
      const value = session(sessionId);
      return {
        id: value.id,
        status: value.status,
        source_space_id: value.sourceSpaceId,
        ...(options.withMessages ? { messages: value.messages } : {}),
      };
    },
    async sendMessage(sessionId, content) {
      const value = session(sessionId);
      const prompt = promptQueue.shift();
      if (prompt === undefined)
        throw scriptedError({ code: 'UNEXPECTED_PROMPT' });
      if (prompt.error !== undefined) throw scriptedError(prompt.error);
      const events = Array.isArray(prompt.events) ? prompt.events : [];
      value.events.push(...events);
      value.gateAfterOffset = Number.isSafeInteger(prompt.gateAfterOffset)
        ? prompt.gateAfterOffset
        : undefined;
      value.gateOpen = value.gateAfterOffset === undefined;
      value.streamErrorOnceAtOffset = Number.isSafeInteger(
        prompt.streamErrorOnceAtOffset,
      )
        ? prompt.streamErrorOnceAtOffset
        : undefined;
      value.streamErrorRaised = false;
      value.lastPrompt = content;
      return {
        message_id: String(prompt.messageId ?? 'synthetic-user-message'),
        created_at: String(prompt.createdAt ?? '2033-05-18T03:33:20.000Z'),
      };
    },
    async *streamEvents(sessionId, options = {}) {
      const value = session(sessionId);
      const offset = Number(options.eventOffset ?? 0);
      for (const item of value.events) {
        const currentOffset = eventOffset(item);
        if (currentOffset < offset) continue;
        if (
          value.streamErrorOnceAtOffset !== undefined &&
          currentOffset >= value.streamErrorOnceAtOffset &&
          !value.streamErrorRaised
        ) {
          value.streamErrorRaised = true;
          throw scriptedError({ code: 'ECONNRESET' });
        }
        if (
          value.gateAfterOffset !== undefined &&
          currentOffset > value.gateAfterOffset &&
          !value.gateOpen
        ) {
          await waitForAbort(options.signal);
          value.gateOpen = true;
          return;
        }
        yield item;
      }
    },
  },
};
