import assert from 'node:assert/strict'
import test from 'node:test'

let describeBridgeError: ((error: unknown) => string) | undefined
let describeBridgeEventError: ((error: unknown) => string) | undefined
let UserFacingBridgeError: (new (message: string, options?: ErrorOptions) => Error) | undefined
try {
  ({ describeBridgeError, describeBridgeEventError, UserFacingBridgeError } = await import('./errors.js'))
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

test('user-facing bridge errors keep event messages concise while retaining diagnostic causes', () => {
  assert.equal(typeof describeBridgeEventError, 'function')
  assert.equal(typeof UserFacingBridgeError, 'function')
  const cause = new Error('acpx command failed: Authentication required')
  const error = new (UserFacingBridgeError as new (message: string, options?: ErrorOptions) => Error)(
    'WorkBuddy is not logged in. Open WorkBuddy and sign in, then retry.',
    { cause },
  )

  assert.equal(
    (describeBridgeEventError as (error: unknown) => string)(error),
    'WorkBuddy is not logged in. Open WorkBuddy and sign in, then retry.',
  )
  assert.match((describeBridgeError as (error: unknown) => string)(error), /cause=acpx command failed/)
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
