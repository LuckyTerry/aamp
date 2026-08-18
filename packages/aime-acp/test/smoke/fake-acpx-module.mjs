function event(type, offset, data) {
  return {
    type,
    data: {
      event_id: `event-${offset}`,
      event_offset: offset,
      timestamp: 2_000_000_000 + offset,
      event_key: type,
      ...data,
    },
  };
}

const remoteSession = {
  id: 'safe-remote-session',
  sourceSpaceId: 'safe-remote-space',
  events: [],
};
let promptAvailable = true;

export const auth = {
  async getExternalBytecloudAuthStatus() {
    return { authenticated: false, auth_source: null };
  },
  async byteCloudAuthEnsureAuth() {
    return {
      status: 'ready',
      authType: 'user',
      expiresAt: '2035-01-02T03:04:05.000Z',
    };
  },
  async byteCloudAuthUserInfo() {
    return { employeeId: 'safe-fake-user' };
  },
  async byteCloudAuthLogin() {
    return { status: 'success' };
  },
  async byteCloudAuthBeginLogin() {
    return {
      challengeToken: 'unused-fake-challenge',
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
      return {
        spaces: [
          { id: 'safe-remote-space', type: 'personal', status: 'active' },
        ],
      };
    },
    async listModels() {
      return { text_models_by_execution_mode: { fast: [], max: [] } };
    },
    async createSession(spaceId) {
      remoteSession.sourceSpaceId = spaceId;
      return { id: remoteSession.id, source_space_id: spaceId };
    },
    async getSession(sessionId, options = {}) {
      if (sessionId !== remoteSession.id) {
        throw Object.assign(new Error('synthetic not found'), { status: 404 });
      }
      return {
        id: sessionId,
        status: 'completed',
        source_space_id: remoteSession.sourceSpaceId,
        ...(options.withMessages ? { messages: [] } : {}),
      };
    },
    async sendMessage(sessionId) {
      if (sessionId !== remoteSession.id || !promptAvailable) {
        throw new Error('unexpected fake prompt');
      }
      promptAvailable = false;
      const rawToolSentinel = process.env.RAW_TOOL_SENTINEL;
      remoteSession.events = [
        event('session.message.create', 0, {
          message: {
            message_id: 'safe-user-message',
            role: 'user',
            content: 'reply with AIME_ACP_OK',
          },
        }),
        event('session.think.tips', 1, {
          tips: ['Preparing the safe response'],
        }),
        event('session.plan.update', 2, {
          plan_id: 'safe-plan',
          status: 'running',
        }),
        event('session.step.update', 3, {
          agent_step_id: 'safe-step',
          title: 'Use a remote safe tool',
          status: 'in_progress',
        }),
        event('session.action.use_tool', 4, {
          agent_step_id: 'safe-tool',
          tool_name: 'safe_lookup',
          status: 'in_progress',
          summary: 'Started safe remote lookup',
          raw_payload: rawToolSentinel,
        }),
        event('session.action.use_tool', 5, {
          agent_step_id: 'safe-tool',
          tool_name: 'safe_lookup',
          status: 'completed',
          summary: 'Completed safe remote lookup',
          raw_payload: rawToolSentinel,
        }),
        event('session.message.create', 6, {
          reply_message_id: 'safe-user-message',
          message: {
            message_id: 'safe-assistant-message',
            role: 'assistant',
            content: 'AIME_ACP_OK',
          },
        }),
        event('session.progress_notice', 7, { status: 'waiting_for_next' }),
      ];
      return {
        message_id: 'safe-user-message',
        created_at: '2033-05-18T03:33:20.000Z',
      };
    },
    async *streamEvents(sessionId, options = {}) {
      if (sessionId !== remoteSession.id) throw new Error('unknown session');
      const offset = Number(options.eventOffset ?? 0);
      for (const item of remoteSession.events) {
        if (item.data.event_offset >= offset) yield item;
      }
    },
  },
};
