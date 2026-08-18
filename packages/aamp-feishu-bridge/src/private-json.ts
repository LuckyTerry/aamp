import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export async function writePrivateJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const parent = dirname(filePath)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await chmod(parent, 0o700)
  const tempPath = join(parent, `.${basename(filePath)}.${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(tempPath, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(tempPath, filePath)
    await chmod(filePath, 0o600)
  } finally {
    await handle?.close().catch(() => undefined)
    await rm(tempPath, { force: true }).catch(() => undefined)
  }
}
