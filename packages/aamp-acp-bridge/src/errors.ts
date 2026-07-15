type ErrorDetails = {
  cause?: unknown
  code?: unknown
  errno?: unknown
  syscall?: unknown
  hostname?: unknown
  host?: unknown
  address?: unknown
  port?: unknown
  status?: unknown
  statusCode?: unknown
  response?: { status?: unknown }
}

function errorDetails(error: unknown): ErrorDetails {
  return error && typeof error === 'object' ? error as ErrorDetails : {}
}

function describeSingleError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const details = errorDetails(error)
  const parts = [error.message || error.name]
  const fields: Array<[string, unknown]> = [
    ['code', details.code],
    ['errno', details.errno],
    ['syscall', details.syscall],
    ['hostname', details.hostname],
    ['host', details.host],
    ['address', details.address],
    ['port', details.port],
    ['status', details.status ?? details.statusCode ?? details.response?.status],
  ]
  for (const [name, value] of fields) {
    if (value !== undefined && value !== null && value !== '') parts.push(`${name}=${String(value)}`)
  }
  return parts.join(' | ')
}

export function describeBridgeError(error: unknown): string {
  const parts: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current !== undefined && current !== null && !seen.has(current)) {
    parts.push(`${parts.length === 0 ? '' : 'cause='}${describeSingleError(current)}`)
    if (typeof current !== 'object') break
    seen.add(current)
    current = errorDetails(current).cause
  }
  return parts.join(' | ') || String(error)
}
