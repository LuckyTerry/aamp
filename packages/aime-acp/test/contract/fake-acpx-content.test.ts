import { describe, expect, it } from 'vitest';

import { agentMessageText } from '../smoke/fake-acpx-content.mjs';

describe('fake acpx response extraction', () => {
  it('extracts only explicit ACP text content fields', () => {
    const frames = [
      {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'ignored',
          update: {
            sessionUpdate: 'agent_message_chunk',
            type: 'not-response-text',
            status: 'not-response-text',
            title: 'not-response-text',
            content: { type: 'text', text: 'AIME_ACP_OK' },
          },
        },
      },
    ];

    expect(agentMessageText(frames)).toBe('AIME_ACP_OK');
  });
});
