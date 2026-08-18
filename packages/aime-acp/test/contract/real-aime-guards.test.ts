import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as guards from '../smoke/real-aime-guards.mjs';

describe('release-only real AIME guards', () => {
  it('resolves only the checked-in public HTTP lookup profile', () => {
    expect(typeof guards.resolveToolProfile).toBe('function');
    expect(guards.resolveToolProfile?.('public-http-lookup')).toEqual({
      expectedToolTitle: 'lookup',
      prompt:
        'Use only the read-only public HTTP lookup tool to fetch https://example.com and briefly summarize that public page. Do not authenticate, write or mutate data, upload anything, or access private or local resources.',
    });
    for (const unsafe of [
      'shell',
      '../write-file',
      'upload-private-data',
      'delete-resource',
      '',
    ]) {
      expect(() => guards.resolveToolProfile?.(unsafe)).toThrow();
    }
  });

  it('requires ordered tool create, matching update, completion, and final text', () => {
    const updates = [
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'remote-1',
        title: 'safe_lookup',
        status: 'in_progress',
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'remote-1',
        title: 'safe_lookup',
        status: 'completed',
      },
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'safe result' },
      },
    ];
    expect(() =>
      guards.assertSafeToolTurn(updates, 'safe_lookup'),
    ).not.toThrow();
    expect(() =>
      guards.assertSafeToolTurn(updates, 'different_tool'),
    ).toThrow();
    expect(() =>
      guards.assertSafeToolTurn(updates.slice(0, 2), 'safe_lookup'),
    ).toThrow();
  });

  it('requires a nonempty message delta before the prompt terminal settles', async () => {
    expect(typeof guards.observeLiveDeltaBeforeTerminal).toBe('function');
    let finish!: (value: { stopReason: string }) => void;
    const terminal = new Promise<{ stopReason: string }>((resolve) => {
      finish = resolve;
    });
    const observed = guards.observeLiveDeltaBeforeTerminal?.((onUpdate) => {
      queueMicrotask(() =>
        onUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'live' },
        }),
      );
      return terminal;
    }, 100);
    queueMicrotask(() => finish({ stopReason: 'end_turn' }));
    await expect(observed).resolves.toEqual({ stopReason: 'end_turn' });

    await expect(
      guards.observeLiveDeltaBeforeTerminal?.((onUpdate) => {
        setTimeout(
          () =>
            onUpdate({
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'too late' },
            }),
          0,
        );
        return Promise.resolve({ stopReason: 'end_turn' });
      }, 100),
    ).rejects.toThrow('SMOKE_FAILED');
  });

  it('reads process evidence at call time so late stderr is included', () => {
    expect(typeof guards.createEvidenceGetter).toBe('function');
    let stderr = '';
    const frames: unknown[] = [];
    const evidence = guards.createEvidenceGetter?.('acp', frames, () => stderr);
    frames.push({ method: 'session/update' });
    stderr = 'late stderr';
    expect(evidence?.()).toEqual({
      kind: 'acp',
      frames: [{ method: 'session/update' }],
      stderr: 'late stderr',
    });
  });

  it('rejects category canaries and raw sensitive fields in evidence', () => {
    expect(() =>
      guards.scanPrivacyEvidence('{"safe":"summary"}', ['credential-canary']),
    ).not.toThrow();
    expect(() =>
      guards.scanPrivacyEvidence('credential-canary', ['credential-canary']),
    ).toThrow();
    expect(() =>
      guards.scanPrivacyEvidence('{"rawInput":"payload"}', []),
    ).toThrow();
    expect(() =>
      guards.scanPrivacyEvidence('{"employeeId":"identity"}', []),
    ).toThrow();
  });

  it('writes, scans, and deletes an exclusive 0600 ephemeral raw log', async () => {
    expect(typeof guards.createEphemeralEvidenceLog).toBe('function');
    const root = await mkdtemp(join(tmpdir(), 'real-aime-log-contract-'));
    const log = await guards.createEphemeralEvidenceLog?.(root);
    if (log === undefined) throw new Error('missing evidence log helper');
    try {
      expect((await stat(log.path)).mode & 0o777).toBe(0o600);
      await log.append({ kind: 'late-stderr', stderr: 'captured after close' });
      await log.sync();
      expect(await readFile(log.path, 'utf8')).toContain(
        'captured after close',
      );
      await expect(log.readAndScan([])).resolves.toContain(
        'captured after close',
      );
    } finally {
      await log.closeAndDelete();
    }
    await expect(stat(log.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(root, { recursive: true, force: true });
  });
});
