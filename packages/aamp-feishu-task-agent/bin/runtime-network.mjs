import dns from 'node:dns';
import os from 'node:os';

const PROXY_ENV_KEYS = [
  'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy',
  'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy',
  'NODE_USE_ENV_PROXY',
];

const DNS_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ENODATA', 'ESERVFAIL', 'ERR_DNS_SET_SERVERS_FAILED',
]);
const CONNECT_TIMEOUT_CODES = new Set(['UND_ERR_CONNECT_TIMEOUT']);
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ABORT_ERR',
]);
const RESET_CODES = new Set(['ECONNRESET', 'EPIPE', 'ENETRESET', 'UND_ERR_SOCKET']);
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN']);
const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

function asErrorDetails(error) {
  return error && typeof error === 'object' ? error : {};
}

function collectErrorChain(error) {
  const chain = [];
  const seen = new Set();
  let current = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    chain.push(current);
    if (typeof current !== 'object') break;
    seen.add(current);
    current = current.cause;
  }
  return chain;
}

function errorCodes(error) {
  return collectErrorChain(error)
    .map((item) => asErrorDetails(item).code)
    .filter((value) => typeof value === 'string')
    .map((value) => value.toUpperCase());
}

function errorStatus(error) {
  for (const item of collectErrorChain(error)) {
    const details = asErrorDetails(item);
    const value = Number(details.status ?? details.statusCode ?? details.response?.status);
    if (Number.isInteger(value) && value >= 100 && value <= 599) return value;
  }
  const text = collectErrorChain(error)
    .map((item) => item instanceof Error ? item.message : String(item))
    .join(' | ');
  const match = text.match(/(?:\bHTTP(?:\/\d(?:\.\d)?)?\s+|\bstatus(?:Code)?\s*[=:]\s*)([1-5]\d{2})\b/i);
  if (match) return Number(match[1]);
  return undefined;
}

function describeSingleError(error) {
  if (!(error instanceof Error)) return String(error);
  const details = asErrorDetails(error);
  const parts = [error.message || error.name];
  for (const [key, value] of [
    ['code', details.code],
    ['errno', details.errno],
    ['syscall', details.syscall],
    ['hostname', details.hostname],
    ['host', details.host],
    ['address', details.address],
    ['port', details.port],
    ['status', details.status ?? details.statusCode ?? details.response?.status],
  ]) {
    if (value !== undefined && value !== null && value !== '') parts.push(`${key}=${value}`);
  }
  return parts.join(' | ');
}

export function describeNetworkError(error) {
  const chain = collectErrorChain(error);
  if (!chain.length) return String(error);
  return chain
    .map((item, index) => `${index === 0 ? '' : 'cause='}${describeSingleError(item)}`)
    .join(' | ');
}

export function classifyNetworkError(error) {
  const status = errorStatus(error);
  if (status !== undefined) return status >= 500 ? 'http_5xx' : 'http_4xx';

  const codes = errorCodes(error);
  if (codes.some((code) => DNS_CODES.has(code))) return 'dns';
  if (codes.some((code) => CONNECT_TIMEOUT_CODES.has(code))) return 'connect_timeout';
  if (codes.some((code) => TIMEOUT_CODES.has(code))) return 'timeout';
  if (codes.some((code) => RESET_CODES.has(code))) return 'connection_reset';
  if (codes.some((code) => UNREACHABLE_CODES.has(code))) return 'unreachable';
  if (codes.some((code) => TLS_CODES.has(code) || code.startsWith('ERR_TLS_'))) return 'tls';

  const message = describeNetworkError(error).toLowerCase();
  const includesCode = (knownCodes) => [...knownCodes].some((code) => message.includes(code.toLowerCase()));
  if (includesCode(DNS_CODES) || message.includes('getaddrinfo') || message.includes('dns')) return 'dns';
  if (includesCode(CONNECT_TIMEOUT_CODES) || message.includes('connect timeout')) return 'connect_timeout';
  if (includesCode(TIMEOUT_CODES) || message.includes('timed out') || message.includes('timeout') || message.includes('aborted')) return 'timeout';
  if (includesCode(RESET_CODES) || message.includes('connection reset') || message.includes('socket closed')) return 'connection_reset';
  if (includesCode(UNREACHABLE_CODES)) return 'unreachable';
  if (includesCode(TLS_CODES) || message.includes('certificate') || message.includes('tls')) return 'tls';
  if (message.includes('fetch failed') || message.includes('network error')) return 'network';
  return 'unknown';
}

export function isRetryableHttpStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

export function isRetryableNetworkError(error) {
  const status = errorStatus(error);
  if (status !== undefined) return isRetryableHttpStatus(status);
  return ['dns', 'connect_timeout', 'timeout', 'connection_reset', 'unreachable', 'network']
    .includes(classifyNetworkError(error));
}

function defaultSleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withNetworkRetry(operation, options = {}) {
  const maxAttempts = Math.max(1, Number(options.maxAttempts) || 1);
  const baseDelayMs = Math.max(0, Number(options.baseDelayMs) || 0);
  const shouldRetry = options.shouldRetry || isRetryableNetworkError;
  const sleep = options.sleep || defaultSleep;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation({ attempt, maxAttempts });
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !shouldRetry(error)) throw error;
      const nextDelayMs = baseDelayMs * 2 ** (attempt - 1);
      await options.onRetry?.({
        attempt,
        maxAttempts,
        nextDelayMs,
        category: classifyNetworkError(error),
        error: describeNetworkError(error),
      });
      await sleep(nextDelayMs);
    }
  }
  throw lastError;
}

export function launchDetachedDiagnostic(operation, onError) {
  void Promise.resolve()
    .then(operation)
    .catch(async (error) => {
      try {
        await onError?.(error);
      } catch {
        // Diagnostics must never affect the real bridge operation.
      }
    });
}

export function agentStartRetryError(events, expectedAgentNames, attempt, maxAttempts) {
  if (Number(attempt) >= Number(maxAttempts)) return undefined;
  const expected = new Set(expectedAgentNames || []);
  for (const event of events || []) {
    if (event?.type !== 'agent.failed' || !expected.has(event.agent)) continue;
    const error = new Error(String(event.message || `${event.agent} Agent Bridge 启动失败`));
    if (isRetryableNetworkError(error)) return error;
  }
  return undefined;
}

export function safeDiagnosticUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

export function networkEnvironmentSummary(environment = process.env) {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    proxyEnvPresent: PROXY_ENV_KEYS.filter((key) => Boolean(environment[key])),
  };
}

function normalizedDnsResults(records) {
  const list = Array.isArray(records) ? records : [records];
  return list
    .filter((record) => record && typeof record.address === 'string')
    .map((record) => ({ address: record.address, family: Number(record.family) || record.family }));
}

function fetchTimeoutSignal(timeoutMs) {
  if (typeof AbortSignal?.timeout === 'function') return AbortSignal.timeout(timeoutMs);
  return undefined;
}

function withHardTimeout(operation, timeoutMs, createError) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(createError()), timeoutMs);
    timer.unref?.();
    Promise.resolve()
      .then(operation)
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

export async function probeEndpoint(rawUrl, options = {}) {
  const url = safeDiagnosticUrl(rawUrl);
  const parsed = new URL(url);
  const lookup = options.lookup || ((hostname) => dns.promises.lookup(hostname, { all: true }));
  const fetchImpl = options.fetchImpl || fetch;
  const runtime = networkEnvironmentSummary(options.environment);

  return withNetworkRetry(async ({ attempt, maxAttempts }) => {
    const startedAt = Date.now();
    let dnsRecords = [];
    try {
      const timeoutMs = Math.max(1, Number(options.timeoutMs) || 10_000);
      dnsRecords = normalizedDnsResults(await withHardTimeout(
        () => lookup(parsed.hostname),
        timeoutMs,
        () => Object.assign(new Error(`DNS lookup timed out for ${parsed.hostname}`), {
          code: 'ETIMEDOUT',
          syscall: 'dns.lookup',
          hostname: parsed.hostname,
        }),
      ));
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'follow',
        signal: fetchTimeoutSignal(timeoutMs),
      });
      try {
        const event = {
          type: 'network.probe',
          timestamp: new Date().toISOString(),
          url,
          hostname: parsed.hostname,
          attempt,
          maxAttempts,
          durationMs: Date.now() - startedAt,
          dns: dnsRecords,
          status: Number(response.status),
          statusText: String(response.statusText || ''),
          category: response.ok ? 'ok' : classifyNetworkError(Object.assign(new Error(`HTTP ${response.status}`), { status: response.status })),
          ...runtime,
        };
        await options.onAttempt?.(event);
        if (!response.ok) {
          throw Object.assign(new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim()), {
            status: response.status,
          });
        }
        return event;
      } finally {
        await response.body?.cancel?.().catch(() => {});
      }
    } catch (error) {
      if (errorStatus(error) === undefined) {
        await options.onAttempt?.({
          type: 'network.probe',
          timestamp: new Date().toISOString(),
          url,
          hostname: parsed.hostname,
          attempt,
          maxAttempts,
          durationMs: Date.now() - startedAt,
          dns: dnsRecords,
          category: classifyNetworkError(error),
          error: describeNetworkError(error),
          ...runtime,
        });
      }
      throw error;
    }
  }, {
    maxAttempts: options.maxAttempts ?? 3,
    baseDelayMs: options.baseDelayMs ?? 500,
    sleep: options.sleep,
    onRetry: options.onRetry,
  });
}

export function createSerializedLineWriter(append) {
  let pending = Promise.resolve();
  let firstError;
  return {
    write(line) {
      const current = pending.then(() => append(line));
      pending = current.catch((error) => {
        firstError ??= error;
      });
      return current;
    },
    async flush() {
      await pending;
      if (firstError) throw firstError;
    },
  };
}
