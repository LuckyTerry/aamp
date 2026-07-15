export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const details = error as Error & {
    code?: string
    errno?: number
    syscall?: string
    hostname?: string
    host?: string
    address?: string
    port?: number
    cause?: unknown
  }
  const parts = [details.message]
  if (details.code) parts.push(`code=${details.code}`)
  if (details.errno !== undefined) parts.push(`errno=${details.errno}`)
  if (details.syscall) parts.push(`syscall=${details.syscall}`)
  if (details.hostname) parts.push(`hostname=${details.hostname}`)
  if (details.host) parts.push(`host=${details.host}`)
  if (details.address) parts.push(`address=${details.address}`)
  if (details.port !== undefined) parts.push(`port=${details.port}`)
  if (details.cause) parts.push(`cause=${describeError(details.cause)}`)
  return parts.join(' | ')
}

export function isRetryableAampNetworkError(error: unknown): boolean {
  const message = describeError(error).toLowerCase()
  return message.includes('connect timeout')
    || message.includes('und_err_connect_timeout')
    || message.includes('etimedout')
    || message.includes('econnreset')
    || message.includes('econnrefused')
    || message.includes('eai_again')
}

export function isSmtpAuthError(error: unknown): boolean {
  const message = describeError(error).toLowerCase()
  return message.includes('535')
    || message.includes('invalid login')
    || message.includes('authentication credentials invalid')
}
