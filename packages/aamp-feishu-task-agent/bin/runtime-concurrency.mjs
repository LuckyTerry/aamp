export async function settleWithConcurrency(items, limit, worker) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('concurrency limit must be a positive integer')
  const results = new Array(items.length)
  let cursor = 0
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(limit, items.length) },
    () => run(),
  ))
  return results
}

export async function runLayeredStarts(items, { prepare, start, concurrency }) {
  const outcomes = new Array(items.length)
  const prepared = []
  for (let index = 0; index < items.length; index += 1) {
    try {
      prepared.push({ index, value: await prepare(items[index], index) })
    } catch (reason) {
      outcomes[index] = { status: 'rejected', phase: 'prepare', reason, item: items[index], index }
    }
  }
  const started = await settleWithConcurrency(
    prepared,
    concurrency,
    ({ index, value }) => start(value, index, items[index]),
  )
  started.forEach((result, preparedIndex) => {
    const { index } = prepared[preparedIndex]
    outcomes[index] = { ...result, phase: 'start', item: items[index], index }
  })
  return outcomes
}

export function createKeyedSerialExecutor() {
  const tails = new Map()
  return async (key, operation) => {
    const previous = tails.get(key) || Promise.resolve()
    const current = previous.catch(() => {}).then(operation)
    tails.set(key, current)
    try {
      return await current
    } finally {
      if (tails.get(key) === current) tails.delete(key)
    }
  }
}

export function createSerializedRunner(operation) {
  let tail = Promise.resolve()
  return {
    run() {
      const current = tail.catch(() => {}).then(operation)
      tail = current
      return current
    },
    flush() {
      return tail
    },
  }
}
