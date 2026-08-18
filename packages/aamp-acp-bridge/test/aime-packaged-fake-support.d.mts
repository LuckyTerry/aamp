export function fakeEventOffset(value: unknown): number

export interface FakeRemoteSession {
  id: string
  sourceSpaceId: string
  status: string
  events: unknown[]
  gateAfterOffset: number | undefined
  gateFile: string | undefined
  awaitingDrain: boolean
}

export class FakeRemoteSessions {
  constructor(processId?: number, prefix?: string)
  readonly createdIds: string[]
  create(sourceSpaceId: string): FakeRemoteSession
  load(id: string, sourceSpaceId: string): FakeRemoteSession
  get(id: string): FakeRemoteSession
}
