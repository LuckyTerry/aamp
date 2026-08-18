import { describe, expect, it } from 'vitest';

import { convertPromptContent } from '../../src/acp/prompt-content.js';

describe('convertPromptContent', () => {
  it('preserves text and HTTP(S) link order', () => {
    expect(
      convertPromptContent([
        { type: 'text', text: 'Read /tmp/verbatim ' },
        {
          type: 'resource_link',
          name: 'design',
          title: 'Design [v2]',
          uri: 'https://example.test/d)',
        },
        { type: 'text', text: ' and summarize.' },
      ]),
    ).toBe(
      'Read /tmp/verbatim \n[Design \\[v2\\]](https://example.test/d\\))\n and summarize.',
    );
  });

  it('accepts HTTP links and falls back to a safe nonempty label', () => {
    expect(
      convertPromptContent([
        {
          type: 'resource_link',
          name: '   ',
          title: ' ',
          uri: 'http://example.test/a',
        },
      ]),
    ).toBe('[example.test](http://example.test/a)');
  });

  it('falls back when supplied labels are not safe for inline markdown', () => {
    expect(
      convertPromptContent([
        {
          type: 'resource_link',
          name: 'name\nwith a line break',
          title: 'also\nunsafe',
          uri: 'https://example.test/a',
        },
      ]),
    ).toBe('[example.test](https://example.test/a)');
  });

  it('escapes both markdown destination parentheses after URL normalization', () => {
    expect(
      convertPromptContent([
        {
          type: 'resource_link',
          name: 'parentheses',
          uri: 'https://example.test/a(b)',
        },
      ]),
    ).toBe('[parentheses](https://example.test/a\\(b\\))');
  });

  it.each([
    { type: 'resource_link', name: 'local', uri: 'file:///tmp/a' },
    { type: 'resource_link', name: 'local', uri: '/tmp/a' },
    { type: 'resource_link', name: 'script', uri: 'javascript:alert(1)' },
    {
      type: 'resource_link',
      name: 'credential',
      uri: 'https://a:b@example.test/a',
    },
    { type: 'resource_link', name: 'missing', uri: '' },
    { type: 'resource_link', name: 'bad', uri: 7 },
    { type: 'text', text: 7 },
    { type: 'audio', data: 'AA==', mimeType: 'audio/wav' },
    { type: 'image', data: 'AA==', mimeType: 'image/png' },
    { type: 'resource', resource: { uri: 'https://example.test/r' } },
    { type: 'mystery', value: 'nope' },
    null,
  ])('rejects unsupported runtime content atomically: %#', (block) => {
    expect(() =>
      convertPromptContent([
        { type: 'text', text: 'must-not-partially-send' },
        block,
      ] as never),
    ).toThrowError(
      expect.objectContaining({ code: 'AIME_UNSUPPORTED_CONTENT' }),
    );
  });
});
