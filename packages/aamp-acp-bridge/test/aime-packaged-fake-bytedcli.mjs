import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { FakeRemoteSessions, fakeEventOffset } from './aime-packaged-fake-support.mjs'

const scenarioPath = process.env.AIME_ACP_FAKE_SCENARIO
const initialScenario = JSON.parse(readFileSync(scenarioPath, 'utf8'))
const tracePath = process.env.AIME_ACP_FAKE_TRACE
const sourceSpaceId = String(initialScenario.space.id)
const sessions = new FakeRemoteSessions()

function trace(value) {
  appendFileSync(tracePath, `${JSON.stringify({ pid: process.pid, ...value })}\n`, { mode: 0o600 })
}

function waitForGate(path, signal) {
  return new Promise((resolve) => {
    const poll = () => {
      if (signal?.aborted || existsSync(path)) return resolve()
      setTimeout(poll, 10)
    }
    poll()
  })
}

export const auth = {
  async getExternalBytecloudAuthStatus() { return { authenticated: false, auth_source: null } },
  async byteCloudAuthEnsureAuth() { return { status: 'ready', authType: 'user', expiresAt: '2035-01-02T03:04:05.000Z' } },
  async byteCloudAuthUserInfo() { return { employeeId: 'safe-fake-user' } },
  async byteCloudAuthLogin() { return { status: 'success' } },
  async byteCloudAuthBeginLogin() { return { challengeToken: 'unused', preferredUrl: 'https://login.example.test', displayCode: 'SAFE', expiresAt: '2035-01-02T03:04:05.000Z' } },
  async byteCloudAuthCompleteLogin() { return { status: 'success' } },
}

export const utils = { setCloudSite() {}, setAuthAs() {}, setHttpConfig() {} }

export const api = {
  aime: {
    async listSpaces() {
      trace({ method: 'listSpaces' })
      return { spaces: [{ id: sourceSpaceId, type: 'personal', status: 'active' }] }
    },
    async listModels() { return { text_models_by_execution_mode: { fast: [], max: [] } } },
    async createSession(spaceId) {
      const state = sessions.create(spaceId)
      trace({ method: 'createSession', sessionId: state.id, spaceId })
      return { id: state.id, source_space_id: state.sourceSpaceId }
    },
    async getSession(requestedSessionId, options = {}) {
      const state = sessions.load(requestedSessionId, sourceSpaceId)
      trace({ method: 'getSession', sessionId: state.id, withMessages: options.withMessages === true, status: state.status })
      return { id: state.id, status: state.status, source_space_id: state.sourceSpaceId, ...(options.withMessages ? { messages: [] } : {}) }
    },
    async sendMessage(requestedSessionId) {
      const state = sessions.get(requestedSessionId)
      const currentScenario = JSON.parse(readFileSync(scenarioPath, 'utf8'))
      const prompt = currentScenario.prompts[0]
      if (!prompt) throw new Error('unexpected prompt')
      state.events.push(...prompt.events)
      state.gateAfterOffset = prompt.gateAfterOffset
      state.gateFile = prompt.gateFile
      state.status = 'running'
      trace({ method: 'sendMessage', sessionId: state.id, messageId: prompt.messageId })
      return { message_id: prompt.messageId, created_at: prompt.createdAt }
    },
    async *streamEvents(requestedSessionId, options = {}) {
      const state = sessions.get(requestedSessionId)
      const start = Number(options.eventOffset ?? 0)
      let yieldCount = 0
      trace({ method: 'streamEvents.start', sessionId: state.id, offset: start, status: state.status })
      try {
      for (const item of state.events) {
        const current = fakeEventOffset(item)
        if (current < start) continue
        if (Number.isSafeInteger(state.gateAfterOffset) && current > state.gateAfterOffset) {
          await waitForGate(state.gateFile ?? '/nonexistent-packaged-aime-gate', options.signal)
          state.gateAfterOffset = undefined
          state.gateFile = undefined
          if (options.signal?.aborted) {
            state.awaitingDrain = true
            trace({ method: 'cancel', sessionId: state.id })
            return
          }
        }
        if (item?.data?.status === 'waiting_for_next') {
          state.status = 'completed'
          if (state.awaitingDrain) {
            state.awaitingDrain = false
            trace({ method: 'drain.waiting_for_next', sessionId: state.id, offset: current, status: 'waiting_for_next' })
          }
        } else if (item?.data?.eventType === 'session.action.tool_call_required') {
          state.status = 'completed'
        }
        yieldCount += 1
        yield item
      }
      } finally {
        trace({ method: 'streamEvents.done', sessionId: state.id, offset: start, yieldCount, aborted: options.signal?.aborted === true, status: state.status })
      }
    },
  },
}
