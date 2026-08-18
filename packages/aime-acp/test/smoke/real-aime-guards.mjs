import { randomBytes } from 'node:crypto';
import { open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

function smokeFailure() {
  throw new Error('SMOKE_FAILED');
}

function textContent(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textContent).join('');
  if (
    typeof value === 'object' &&
    value !== null &&
    value.type === 'text' &&
    typeof value.text === 'string'
  ) {
    return value.text;
  }
  return '';
}

const toolProfiles = Object.freeze({
  'public-http-lookup': Object.freeze({
    expectedToolTitle: 'lookup',
    prompt:
      'Use only the read-only public HTTP lookup tool to fetch https://example.com and briefly summarize that public page. Do not authenticate, write or mutate data, upload anything, or access private or local resources.',
  }),
});

export function resolveToolProfile(name) {
  if (name !== 'public-http-lookup') return smokeFailure();
  return toolProfiles[name];
}

export async function observeLiveDeltaBeforeTerminal(startPrompt, timeoutMs) {
  let terminalSettled = false;
  let resolveDelta;
  const delta = new Promise((resolve) => {
    resolveDelta = resolve;
  });
  const terminal = Promise.resolve().then(() =>
    startPrompt((update) => {
      if (
        !terminalSettled &&
        update?.sessionUpdate === 'agent_message_chunk' &&
        textContent(update.content).trim() !== ''
      ) {
        resolveDelta();
      }
    }),
  );
  void terminal.then(
    () => {
      terminalSettled = true;
    },
    () => {
      terminalSettled = true;
    },
  );
  let timer;
  const first = await Promise.race([
    delta.then(() => 'delta'),
    terminal.then(() => 'terminal'),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (first !== 'delta') return smokeFailure();
  return terminal;
}

export function createEvidenceGetter(kind, frames, stderr) {
  return () => ({ kind, frames: [...frames], stderr: stderr() });
}

export function assertSafeToolTurn(updates, allowedName) {
  const tools = updates
    .map((update, index) => ({ update, index }))
    .filter(({ update }) =>
      ['tool_call', 'tool_call_update'].includes(update?.sessionUpdate),
    );
  if (
    tools.length < 2 ||
    tools.some(({ update }) => update.title !== allowedName)
  ) {
    return smokeFailure();
  }
  const created = tools.find(
    ({ update }) =>
      update.sessionUpdate === 'tool_call' &&
      typeof update.toolCallId === 'string' &&
      update.toolCallId !== '',
  );
  if (created === undefined) return smokeFailure();
  const completed = tools.find(
    ({ update, index }) =>
      index > created.index &&
      update.sessionUpdate === 'tool_call_update' &&
      update.toolCallId === created.update.toolCallId &&
      update.status === 'completed',
  );
  if (completed === undefined) return smokeFailure();
  const finalText = updates
    .slice(completed.index + 1)
    .filter((update) => update?.sessionUpdate === 'agent_message_chunk')
    .map((update) => textContent(update.content))
    .join('')
    .trim();
  if (finalText === '') return smokeFailure();
}

const sensitiveField =
  /"(?:accessToken|refreshToken|cookie|employeeId|openId|rawInput|rawOutput|rawPayload|raw_payload)"\s*:/i;

export function scanPrivacyEvidence(evidence, forbiddenValues) {
  if (typeof evidence !== 'string' || sensitiveField.test(evidence)) {
    return smokeFailure();
  }
  for (const value of forbiddenValues) {
    if (typeof value === 'string' && value !== '' && evidence.includes(value)) {
      return smokeFailure();
    }
  }
}

export async function createEphemeralEvidenceLog(root) {
  const path = join(
    root,
    `.aime-acp-real-aime-smoke-${randomBytes(12).toString('hex')}.raw.ndjson`,
  );
  const handle = await open(path, 'wx', 0o600);
  let closed = false;
  let bytes = 0;
  return {
    path,
    async append(value) {
      if (closed) return smokeFailure();
      const line = `${JSON.stringify(value)}\n`;
      bytes += Buffer.byteLength(line);
      if (bytes > 16 * 1024 * 1024) return smokeFailure();
      await handle.write(line);
    },
    async sync() {
      if (closed) return smokeFailure();
      await handle.sync();
    },
    async readAndScan(forbiddenValues) {
      if (closed) return smokeFailure();
      await handle.sync();
      const evidence = await readFile(path, 'utf8');
      scanPrivacyEvidence(evidence, forbiddenValues);
      return evidence;
    },
    async closeAndDelete() {
      if (!closed) {
        closed = true;
        let closeFailure;
        try {
          await handle.sync();
        } catch (error) {
          closeFailure = error;
        }
        try {
          await handle.close();
        } catch (error) {
          closeFailure ??= error;
        }
        await rm(path, { force: true });
        if (closeFailure !== undefined) throw closeFailure;
      } else {
        await rm(path, { force: true });
      }
    },
  };
}
