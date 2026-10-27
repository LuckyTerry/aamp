import path from 'node:path'
import {homedir} from 'node:os'

// Preparation and the background service must resolve this before the service
// replaces AAMP_TASK_RUNTIME_HOME with its versioned runtime directory.
export function resolveWindowsNpmPrefix(environment, home=homedir()) {
  const runtime=environment.AAMP_TASK_RUNTIME_HOME ?? path.join(home,'.aamp','feishu-task-agent')
  return environment.NPM_GLOBAL_PREFIX ?? environment.AAMP_TASK_NPM_GLOBAL_PREFIX ?? path.join(runtime,'npm-global')
}
