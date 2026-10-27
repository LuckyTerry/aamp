import { rename } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'

interface RenameRuntime {
  platform?: NodeJS.Platform
  rename?: typeof rename
  delay?: (milliseconds: number) => Promise<unknown>
}

// Windows may temporarily deny replacement while another handle is closing.
// Keep the same atomic rename: never unlink the destination or copy over it.
export async function renameAtomic(source: string, destination: string, runtime: RenameRuntime = {}): Promise<void> {
  const renameFile = runtime.rename ?? rename
  const platform = runtime.platform ?? process.platform
  const delay = runtime.delay ?? setTimeout
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFile(source, destination)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (platform !== 'win32' || attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) throw error
      await delay(100 * (2 ** attempt))
    }
  }
}
