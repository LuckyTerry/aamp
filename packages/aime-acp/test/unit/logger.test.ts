import { describe, expect, it, vi } from 'vitest';

import { createLogger } from '../../src/logger.js';

describe('stderr logger', () => {
  it('writes one safe JSON line to injected stderr without using stdout consoles', () => {
    const writes: string[] = [];
    const stderr = {
      write: vi.fn((line: string) => {
        writes.push(line);
        return true;
      }),
    };
    const log = vi.spyOn(console, 'log');
    const info = vi.spyOn(console, 'info');

    createLogger(stderr, 'info').info('session.connected', {
      operation: 'session/new',
      durationMs: 12,
    });

    expect(log).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(writes).toEqual([
      '{"level":"info","event":"session.connected","operation":"session/new","durationMs":12}\n',
    ]);
  });

  it('throws instead of accepting an unsafe log field', () => {
    const stderr = { write: vi.fn() };
    const logger = createLogger(stderr, 'debug');

    expect(() =>
      logger.info('session.connected', {
        credential: 'SENTINEL',
      }),
    ).toThrow(/not allowed/i);
  });

  it('filters messages below the selected level after validating fields', () => {
    const stderr = { write: vi.fn() };
    createLogger(stderr, 'warn').info('session.connected', { operation: 'x' });

    expect(stderr.write).not.toHaveBeenCalled();
  });
});
