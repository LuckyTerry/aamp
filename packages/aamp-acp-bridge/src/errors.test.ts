import assert from 'node:assert/strict'
import test from 'node:test'

let describeBridgeError: ((error: unknown) => string) | undefined
try {
  ({ describeBridgeError } = await import('./errors.js'))
} catch {
  // The first test run intentionally demonstrates the missing implementation.
}

test('bridge errors retain nested fetch DNS and socket details', () => {
  assert.equal(typeof describeBridgeError, 'function')
  const describe = describeBridgeError as (error: unknown) => string

  const cause = Object.assign(new Error('getaddrinfo ENOTFOUND meshmail.ai'), {
    code: 'ENOTFOUND',
    errno: -3008,
    syscall: 'getaddrinfo',
    hostname: 'meshmail.ai',
  })
  const error = new Error('fetch failed', { cause })

  assert.equal(
    describe(error),
    'fetch failed | cause=getaddrinfo ENOTFOUND meshmail.ai | code=ENOTFOUND | errno=-3008 | syscall=getaddrinfo | hostname=meshmail.ai',
  )
})

test('bridge errors retain HTTP response status without serializing response bodies', () => {
  assert.equal(typeof describeBridgeError, 'function')
  const describe = describeBridgeError as (error: unknown) => string
  const error = Object.assign(new Error('registration failed'), {
    response: { status: 503, data: { token: 'must-not-be-logged' } },
  })

  const detail = describe(error)
  assert.match(detail, /status=503/)
  assert.doesNotMatch(detail, /must-not-be-logged/)
})
