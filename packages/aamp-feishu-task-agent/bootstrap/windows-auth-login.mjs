import { spawn } from 'node:child_process'
import { defaultOpenUrl } from './register-feishu-app.mjs'

// Keep authorization in lark-cli; only mirror its output and open its first URL.
export function runWindowsAuthLogin(command, args, {
  env = process.env, openUrl = defaultOpenUrl,
  stdout = process.stdout, stderr = process.stderr,
} = {}) {
  return new Promise((resolve, reject) => {
    const descriptor = typeof command === 'string' ? { command, argsPrefix: [] } : command
    const child = spawn(descriptor.command, [...(descriptor.argsPrefix || []), ...args], {
      env, stdio: ['inherit', 'pipe', 'pipe'], shell: false,
    })
    let opened = false
    const inspectLine = line => {
      if (opened || env.AAMP_AUTO_OPEN_AUTH_URL === 'false' || env.AAMP_TASK_TEST_NO_BROWSER === 'true') return
      const url = line.match(/https:\/\/[^\s]+/)?.[0]
      if (!url) return
      opened = true
      const failed = () => stderr.write('未能自动打开浏览器，请手动打开上述授权链接。\n')
      try { Promise.resolve(openUrl(url)).catch(failed) } catch { failed() }
    }
    for (const [stream, output] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      let pending = ''
      stream.setEncoding('utf8')
      stream.on('data', chunk => {
        output.write(chunk)
        pending += chunk
        const lines = pending.split(/\r\n|\n|\r/)
        pending = lines.pop()
        for (const line of lines) inspectLine(line)
      })
      stream.on('end', () => inspectLine(pending))
    }
    child.once('error', reject)
    child.once('close', code => code === 0
      ? resolve()
      : reject(Object.assign(new Error(`command failed (${code}): `), { code })))
  })
}
