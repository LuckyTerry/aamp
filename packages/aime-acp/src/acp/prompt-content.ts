import type { ContentBlock } from '@agentclientprotocol/sdk';

import { AimeAcpError } from '../errors.js';

interface RenderableText {
  readonly kind: 'text';
  readonly text: string;
}

interface RenderableLink {
  readonly kind: 'link';
  readonly label: string;
  readonly href: string;
}

type RenderableBlock = RenderableText | RenderableLink;

function unsupportedContent(type: unknown): never {
  const description = typeof type === 'string' ? type : 'unknown';
  throw new AimeAcpError(
    'AIME_UNSUPPORTED_CONTENT',
    `AIME does not support ${description} prompt content.`,
    false,
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function nonemptyLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const label = value.trim();
  const hasControlCharacter = [...label].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  return label.length > 0 && !hasControlCharacter ? label : undefined;
}

function validateLink(
  block: Readonly<Record<string, unknown>>,
): RenderableLink {
  if (typeof block.uri !== 'string' || block.uri.trim().length === 0) {
    return unsupportedContent('resource_link');
  }

  let url: URL;
  try {
    url = new URL(block.uri);
  } catch {
    return unsupportedContent('resource_link');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.hostname.length === 0 ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    return unsupportedContent('resource_link');
  }

  return {
    kind: 'link',
    label:
      nonemptyLabel(block.title) ?? nonemptyLabel(block.name) ?? url.hostname,
    href: url.href,
  };
}

function validateBlock(block: unknown): RenderableBlock {
  if (!isRecord(block) || typeof block.type !== 'string') {
    return unsupportedContent(undefined);
  }
  if (block.type === 'text') {
    if (typeof block.text !== 'string') return unsupportedContent(block.type);
    return { kind: 'text', text: block.text };
  }
  if (block.type === 'resource_link') return validateLink(block);
  return unsupportedContent(block.type);
}

function escapeMarkdownLabel(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]');
}

function escapeMarkdownDestination(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('(', '\\(')
    .replaceAll(')', '\\)');
}

/** Converts only ACP text and explicit HTTP(S) links without accessing local data. */
export function convertPromptContent(blocks: readonly ContentBlock[]): string {
  const validated = (blocks as readonly unknown[]).map(validateBlock);
  return validated
    .map((block) =>
      block.kind === 'text'
        ? block.text
        : `[${escapeMarkdownLabel(block.label)}](${escapeMarkdownDestination(block.href)})`,
    )
    .join('\n');
}
