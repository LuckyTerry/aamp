function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value
    : {}
}

export function fakeEventOffset(value) {
  const data = record(record(value).data)
  const raw = record(data.raw)
  return Number(data.event_offset ?? raw.event_offset ?? -1)
}

export class FakeRemoteSessions {
  constructor(processId = process.pid, prefix = 'safe-remote-session') {
    if (!Number.isSafeInteger(processId) || processId <= 0) {
      throw new TypeError('fake remote session process id must be positive')
    }
    this.processId = processId
    this.prefix = prefix
    this.sequence = 0
    this.sessions = new Map()
    this.createdIds = []
  }

  create(sourceSpaceId) {
    const id = `${this.prefix}-${this.processId}-${++this.sequence}`
    const value = this.#newSession(id, sourceSpaceId)
    this.sessions.set(id, value)
    this.createdIds.push(id)
    return value
  }

  load(id, sourceSpaceId) {
    const existing = this.sessions.get(id)
    if (existing !== undefined) return existing
    if (!id.startsWith(`${this.prefix}-`)) {
      throw Object.assign(new Error('not found'), { status: 404 })
    }
    const value = this.#newSession(id, sourceSpaceId)
    this.sessions.set(id, value)
    return value
  }

  get(id) {
    const value = this.sessions.get(id)
    if (value === undefined) {
      throw Object.assign(new Error('not found'), { status: 404 })
    }
    return value
  }

  #newSession(id, sourceSpaceId) {
    return {
      id,
      sourceSpaceId,
      status: 'completed',
      events: [],
      gateAfterOffset: undefined,
      gateFile: undefined,
      awaitingDrain: false,
    }
  }
}
