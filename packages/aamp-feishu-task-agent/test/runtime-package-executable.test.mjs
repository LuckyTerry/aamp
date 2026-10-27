import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createPackageExecutableLauncher,
  npmExecutableResolverArgs,
  npmExecutableResolverCommand,
  parseResolvedPackageExecutable,
  isMissingCachedModule,
  prepareRuntimeExecutableEnvironment,
} from '../bin/runtime-package-executable.mjs'

const execFileAsync = promisify(execFile)

test('damaged default and legacy recovery caches rebuild once in a fresh directory', async()=>{
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'aamp-double-cache-'))
 const cacheDir=path.join(root,'cache')
 try {
  const pkg=path.join(root,'package')
  await writePackage(pkg,{name:'fixture-double-bridge',version:'1.0.0',bin:{'fixture-double-bridge':'bin/run.mjs'}},
   {'run.mjs':'#!/usr/bin/env node\nconsole.log("healthy")\n'})
  const packed=JSON.parse((await npmRun(['pack','--json','--pack-destination',root,pkg],{timeout:15000})).stdout)
  const spec=path.join(root,packed[0].filename)
  const legacy=path.join(cacheDir,'_aamp-recovery-v1',createHash('sha256').update(spec).digest('hex'))
  const broken=new Map()
  for(const dir of [cacheDir,legacy]) {
   const descriptor=await npmMaterialize(spec,'fixture-double-bridge',dir)
   const binDir=path.dirname(descriptor.command)
   await fsp.unlink(path.join(binDir,'..','fixture-double-bridge','bin','run.mjs'))
   broken.set(dir,descriptor)
  }
  let builds=0
  const launcher=createPackageExecutableLauncher({cacheDir,
   materialize:async(s,e,context)=>{
    const dir=context.npmCacheDir||cacheDir
    if(broken.has(dir)) {
     const env={...process.env}
     for(const key of Object.keys(env))if(key.toLowerCase()==='path')delete env[key]
     env[process.platform==='win32'?'Path':'PATH']=path.dirname(broken.get(dir).command)
     const {stdout}=await execFileAsync(process.execPath,npmExecutableResolverArgs(e),{env,timeout:10000})
     return parseResolvedPackageExecutable(stdout,e)
    }
    builds++;return npmMaterialize(s,e,dir)
   },
   validate:async descriptor=>{
    const entry=path.join(path.dirname(descriptor.command),'..','fixture-double-bridge','bin','run.mjs')
    assert.equal((await execFileAsync(process.execPath,[entry],{timeout:10000})).stdout.trim(),'healthy')
   },
  })
  const result=await launcher.resolve(spec,'fixture-double-bridge')
  assert.equal(builds,1)
  for(const descriptor of broken.values())assert.notEqual(result.command,descriptor.command)
  for(const descriptor of broken.values())assert.ok(await fsp.stat(path.join(path.dirname(descriptor.command),'..','fixture-double-bridge','package.json')))
 } finally {await fsp.rm(root,{recursive:true,force:true})}
})

test('missing dependency in a real-path cache is recognized through a directory alias', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aamp-cache-alias-'))
  const real = path.join(root, 'real')
  const alias = path.join(root, 'alias')
  try {
    await fsp.mkdir(path.join(real, '_npx', 'abc', 'node_modules', 'zod'), {recursive:true})
    await fsp.symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const missing = path.join(real, '_npx', 'abc', 'node_modules', 'zod', 'index.js')
    assert.equal(isMissingCachedModule({stderr:`ERR_MODULE_NOT_FOUND: Cannot find module '${missing}'`}, alias), true)
    assert.equal(isMissingCachedModule({stderr:`ERR_MODULE_NOT_FOUND: Cannot find module '${path.join(alias, '_npx', 'abc', 'node_modules', 'zod', 'index.js')}'`}, real), true)
  } finally {
    await fsp.unlink(alias).catch(() => {})
    await fsp.rm(root, {recursive:true,force:true})
  }
})

test('cache dependency classification excludes user projects, sibling paths and non-module failures', () => {
  for (const [platform, cache, owned, outside] of [
    ['win32', 'C:\\cache', 'C:\\cache\\_npx\\abc\\node_modules\\zod\\index.js', 'C:\\cache-other\\_npx\\abc\\index.js'],
    ['darwin', '/tmp/cache', '/tmp/cache/_npx/abc/node_modules/zod/index.js', '/tmp/cache-other/_npx/abc/index.js'],
  ]) {
    assert.equal(isMissingCachedModule({stderr:`Error [ERR_MODULE_NOT_FOUND]: Cannot find module '${owned}'`}, cache, platform), true)
    assert.equal(isMissingCachedModule({stderr:`Error [ERR_MODULE_NOT_FOUND]: Cannot find module '${outside}' imported from ${owned}`}, cache, platform), false)
    assert.equal(isMissingCachedModule({stderr:`Error: Cannot find module 'zod'\nRequire stack:\n- ${owned}\ncode: 'MODULE_NOT_FOUND'`}, cache, platform), true)
    assert.equal(isMissingCachedModule({stderr:`Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'zod' imported from ${outside}`}, cache, platform), false)
    assert.equal(isMissingCachedModule({stderr:`EACCES ${owned}`}, cache, platform), false)
  }
})

test('runtime command keeps healthy PATH choice and exposes recovered executable to child processes', async () => {
  const environment = { Path: 'C:\\original', SENTINEL: 'preserved' }
  let resolutions = 0
  const base = { executable: 'acpx', kind: 'cmd', command: 'C:\\original\\acpx.cmd', pathValue: environment.Path, environment: {} }
  const options = { executable: 'acpx', environment, platform: 'win32', cacheDir: 'C:\\cache',
    find: async () => base, probe: async () => {},
    resolve: async () => { resolutions++; return {...base,pathValue:'C:\\recovered;C:\\original'} },
  }
  assert.deepEqual(await prepareRuntimeExecutableEnvironment(options), environment)
  assert.equal(resolutions, 0)
  const result = await prepareRuntimeExecutableEnvironment({...options, find: async () => {
    throw Object.assign(new Error('missing'), {code:78,stderr:'unable to resolve npm executable shim: acpx\n'})
  }})
  assert.equal(result.Path, 'C:\\recovered;C:\\original')
  assert.equal(result.SENTINEL, 'preserved')
  assert.equal(resolutions, 1)
  await assert.rejects(prepareRuntimeExecutableEnvironment({...options, probe: async () => { throw new Error('user installation failed') }}), /user installation failed/)
  assert.equal(resolutions, 1)
})

test('damaged npm cache is recovered once without deleting old files, and recovery cache is reusable', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aamp-cache-recovery-'))
  const cacheDir = path.join(root, 'cache')
  try {
    const pkg = path.join(root, 'package')
    await writePackage(pkg, {
      name: 'fixture-recovery-bridge', version: '1.0.0',
      bin: { 'fixture-recovery-bridge': 'bin/run.mjs' },
    }, { 'run.mjs': '#!/usr/bin/env node\nconsole.log("recovered")\n' })
    const packed = JSON.parse((await npmRun(['pack', '--json', '--pack-destination', root, pkg], { timeout: 15_000 })).stdout)
    const spec = path.join(root, packed[0].filename)
    const initial = await npmMaterialize(spec, 'fixture-recovery-bridge', cacheDir)
    const binDir = path.dirname(initial.command)
    for (const file of await fsp.readdir(binDir)) await fsp.unlink(path.join(binDir, file))
    const entry = path.join(binDir, '..', 'fixture-recovery-bridge', 'bin', 'run.mjs')
    await fsp.unlink(entry)
    // Local tarball npm specs reinstall eagerly, unlike an already-satisfied
    // registry version. Run the real resolver in the retained broken bin PATH.
    const probeBrokenCache = async () => {
      const env = { ...process.env }
      for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
      env[process.platform === 'win32' ? 'Path' : 'PATH'] = binDir
      const { stdout } = await execFileAsync(process.execPath, npmExecutableResolverArgs('fixture-recovery-bridge'), { env, timeout: 10_000 })
      return parseResolvedPackageExecutable(stdout, 'fixture-recovery-bridge')
    }
    await assert.rejects(probeBrokenCache(), /unable to resolve npm executable shim/)
    const notices = []
    const makeLauncher = () => createPackageExecutableLauncher({
      cacheDir,
      onCacheRecovery: (event) => notices.push(event),
      materialize: (packageSpec, executable, context) => context.npmCacheDir
        ? npmMaterialize(packageSpec, executable, context.npmCacheDir)
        : probeBrokenCache(),
    })
    const launcher = makeLauncher()
    const descriptor = await launcher.resolve(spec, 'fixture-recovery-bridge')
    const result = await collectOutput(launcher.launchPrepared({ preparedExecutable: descriptor, spawnOptions: { stdio: ['ignore', 'pipe', 'pipe'] } }))()
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stdout.trim(), 'recovered')
    assert.notEqual(path.dirname(descriptor.command), binDir)
    assert.equal(await fsp.readFile(path.join(binDir, '..', 'fixture-recovery-bridge', 'package.json'), 'utf8').then(() => true), true)
    assert.equal(notices.length, 1)
    const again = await makeLauncher().resolve(spec, 'fixture-recovery-bridge')
    assert.equal(again.command, descriptor.command)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('cache recovery stops after one retry and does not retry unrelated failures', async () => {
  for (const [code, stderr, expectedAttempts] of [
    [78, 'unable to resolve npm executable shim: fixture-bridge\n', 2],
    [78, 'npm warn config deprecated option\nunable to resolve npm executable shim: fixture-bridge\n', 2],
    [1, 'unable to resolve npm executable shim: fixture-bridge\n', 1],
    [78, 'network or authentication failure\n', 1],
  ]) {
    let attempts = 0
    const failure = Object.assign(new Error('fixture failure'), {
      code, stderr,
    })
    const launcher = createPackageExecutableLauncher({
      cacheDir: path.join(os.tmpdir(), 'aamp-unused-cache'),
      materialize: async () => { attempts++; throw failure },
    })
    await assert.rejects(launcher.resolve('fixture@1.0.0', 'fixture-bridge'), /fixture failure/)
    assert.equal(attempts, expectedAttempts)
  }
})

test('Windows resolver rejects a retained npm shim whose JavaScript entry was removed', {
  skip: process.platform !== 'win32',
}, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aamp-dangling-shim-'))
  try {
    await fsp.writeFile(path.join(root, 'fixture-missing.cmd'), '@SET "dp0=%~dp0"\r\n"%_prog%" "%dp0%\\missing.js" %*\r\n')
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
    env.Path = root
    await assert.rejects(execFileAsync(process.execPath, npmExecutableResolverArgs('fixture-missing'), { env }), (error) => error.code === 78)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('retained executable with a missing dependency recovers before it is returned as ready', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aamp-missing-dependency-'))
  const cacheDir = path.join(root, 'cache')
  try {
    const pkg = path.join(root, 'package')
    await writePackage(pkg, { name: 'fixture-dependency-bridge', version: '1.0.0',
      bin: { 'fixture-dependency-bridge': 'bin/run.mjs' },
    }, { 'run.mjs': '#!/usr/bin/env node\nimport "./dependency.mjs"; console.log("healthy");\n',
      'dependency.mjs': 'export const healthy = true;\n' })
    const packed = JSON.parse((await npmRun(['pack', '--json', '--pack-destination', root, pkg], { timeout: 15_000 })).stdout)
    const spec = path.join(root, packed[0].filename)
    const initial = await npmMaterialize(spec, 'fixture-dependency-bridge', cacheDir)
    await fsp.unlink(path.join(path.dirname(initial.command), '..', 'fixture-dependency-bridge', 'bin', 'dependency.mjs'))
    const probe = async descriptor => {
      const entry = path.join(path.dirname(descriptor.command), '..', 'fixture-dependency-bridge', 'bin', 'run.mjs')
      return execFileAsync(process.execPath, [entry, '--help'], { timeout: 10_000 })
    }
    await assert.rejects(probe(initial), /ERR_MODULE_NOT_FOUND/)
    let notices = 0
    const launcher = createPackageExecutableLauncher({ cacheDir,
      onCacheRecovery: () => { notices++ },
      validate: probe,
      materialize: (s, e, context) => context.npmCacheDir ? npmMaterialize(s, e, context.npmCacheDir) : initial,
    })
    const descriptor = await launcher.resolve(spec, 'fixture-dependency-bridge')
    assert.equal((await probe(descriptor)).stdout.trim(), 'healthy')
    assert.equal(notices, 1)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})
const NPM_EXEC_CONTEXT_KEYS = [
  'npm_lifecycle_event',
  'npm_package_json',
  'npm_command',
  'npm_execpath',
  'npm_node_execpath',
  'INIT_CWD',
]

function withoutNpmExecContext(environment) {
  const next = { ...environment }
  for (const key of Object.keys(next)) {
    if (NPM_EXEC_CONTEXT_KEYS.some((allowed) => allowed.toLowerCase() === key.toLowerCase())) {
      delete next[key]
    }
  }
  return next
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withTimeout(promise, timeoutMs, message) {
  let timeout
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

function directDescriptor(command, pathValue = process.env.PATH || path.dirname(command)) {
  return {
    executable: 'fixture-bridge',
    kind: 'direct',
    command,
    pathValue,
    environment: {},
  }
}

async function until(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(10)
  }
  assert.fail(message)
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
}

function collectOutput(child) {
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk) => { stdout += chunk })
  child.stderr?.on('data', (chunk) => { stderr += chunk })
  return async () => ({ ...await waitForExit(child), stdout, stderr })
}

async function npmRun(args, options = {}) {
  if (process.platform !== 'win32') return execFileAsync('npm', args, options)
  const { resolveNativeCommand } = await import('../bin/windows-platform.mjs')
  const npm = await resolveNativeCommand('npm', options.env || process.env)
  return execFileAsync(npm.command, [...npm.argsPrefix, ...args], options)
}

async function npmMaterialize(packageSpec, executable, cacheDir, environment = process.env) {
  const { stdout } = await npmRun([
    'exec', '--yes', '--offline', '--cache', cacheDir,
    '--package', packageSpec, '--',
    npmExecutableResolverCommand(), ...npmExecutableResolverArgs(executable),
  ], {
    env: { ...environment, npm_config_offline: 'true' },
    timeout: 15_000,
  })
  return parseResolvedPackageExecutable(stdout, executable)
}

async function writePackage(root, manifest, bins) {
  await fsp.mkdir(path.join(root, 'bin'), { recursive: true })
  await fsp.writeFile(path.join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  for (const [name, content] of Object.entries(bins)) {
    const file = path.join(root, 'bin', name)
    await fsp.writeFile(file, content, { mode: 0o755 })
    await fsp.chmod(file, 0o755)
  }
}

async function stopChildren(children) {
  await Promise.all(children.map(async (child) => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await Promise.race([waitForExit(child).catch(() => {}), delay(2_000)])
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await Promise.race([waitForExit(child).catch(() => {}), delay(2_000)])
    }
  }))
}

async function createWorkerFixture(root) {
  const worker = path.join(root, 'fixture-bridge.mjs')
  await fsp.writeFile(worker, `#!/usr/bin/env node
import fs from 'node:fs'

const [id, eventsFile, releaseFile, mode = 'success'] = process.argv.slice(2)
fs.appendFileSync(eventsFile, \`start:\${id}\\n\`)
if (mode === 'fail') {
  process.stderr.write(\`failed:\${id}\\n\`)
  process.exit(7)
}
const deadline = Date.now() + 5_000
while (!fs.existsSync(releaseFile)) {
  if (Date.now() >= deadline) throw new Error('release timeout')
  await new Promise((resolve) => setTimeout(resolve, 10))
}
fs.appendFileSync(eventsFile, \`end:\${id}\\n\`)
`, { mode: 0o700 })
  return worker
}

test('same package materializes once before four real business processes overlap', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aamp-package-launch-'))
  const worker = await createWorkerFixture(root)
  const eventsFile = path.join(root, 'events.log')
  const releaseFile = path.join(root, 'release')
  const launched = []
  let materializations = 0
  let activeMaterializations = 0
  let peakMaterializations = 0
  const launcher = createPackageExecutableLauncher({
    async materialize(packageSpec, executable) {
      assert.equal(packageSpec, 'fixture-package@1.0.0')
      assert.equal(executable, 'fixture-bridge')
      materializations += 1
      activeMaterializations += 1
      peakMaterializations = Math.max(peakMaterializations, activeMaterializations)
      await delay(40)
      if (activeMaterializations > 1) throw new Error('shared package tree was materialized concurrently')
      activeMaterializations -= 1
      return directDescriptor(process.execPath)
    },
    spawnProcess(command, args, options) {
      launched.push(args[1])
      return spawn(command, args, options)
    },
  })
  const children = []
  try {
    children.push(...await Promise.all(['traex', 'workbuddy', 'codex', 'cursor'].map((id) => (
      launcher.launch({
        packageSpec: 'fixture-package@1.0.0',
        executable: 'fixture-bridge',
        args: [worker, id, eventsFile, releaseFile],
        spawnOptions: { stdio: ['ignore', 'pipe', 'pipe'] },
      })
    ))))
    await until(async () => {
      const content = await fsp.readFile(eventsFile, 'utf8').catch(() => '')
      return content.split(/\r?\n/).filter((line) => line.startsWith('start:')).length === 4
    }, 'four business processes did not overlap')

    const beforeRelease = await fsp.readFile(eventsFile, 'utf8')
    assert.deepEqual(beforeRelease.trim().split(/\r?\n/).sort(), [
      'start:codex', 'start:cursor', 'start:traex', 'start:workbuddy',
    ])
    assert.equal(materializations, 1)
    assert.equal(peakMaterializations, 1)
    assert.deepEqual(launched, ['traex', 'workbuddy', 'codex', 'cursor'])

    await fsp.writeFile(releaseFile, 'release')
    const exits = await Promise.all(children.map(waitForExit))
    assert.deepEqual(exits, Array.from({ length: 4 }, () => ({ code: 0, signal: null })))
  } finally {
    await stopChildren(children)
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('same package serializes distinct executable materializations', async () => {
  const events = []
  let active = 0
  let peak = 0
  const launcher = createPackageExecutableLauncher({
    async materialize(_packageSpec, executable) {
      active += 1
      peak = Math.max(peak, active)
      events.push(`start:${executable}`)
      await delay(20)
      events.push(`end:${executable}`)
      active -= 1
      return {
        executable,
        kind: 'direct',
        command: `/tmp/${executable}`,
        pathValue: '/tmp',
        environment: {},
      }
    },
  })

  assert.deepEqual(await Promise.all([
    launcher.resolve('fixture-package@1.0.0', 'first'),
    launcher.resolve('fixture-package@1.0.0', 'second'),
  ]), [
    { executable: 'first', kind: 'direct', command: '/tmp/first', pathValue: '/tmp', environment: {} },
    { executable: 'second', kind: 'direct', command: '/tmp/second', pathValue: '/tmp', environment: {} },
  ])
  assert.equal(peak, 1)
  assert.deepEqual(events, ['start:first', 'end:first', 'start:second', 'end:second'])
})

test('materialization failure is shared, evicted, and does not poison retry', async () => {
  const expected = new Error('controlled materialization failure')
  let attempts = 0
  let spawns = 0
  const launcher = createPackageExecutableLauncher({
    async materialize() {
      attempts += 1
      await delay(20)
      if (attempts === 1) throw expected
      return {
        executable: 'fixture-bridge',
        kind: 'direct',
        command: '/tmp/recovered',
        pathValue: '/tmp',
        environment: {},
      }
    },
    spawnProcess() {
      spawns += 1
      throw new Error('spawn should not run in this test')
    },
  })

  const failed = await Promise.allSettled(Array.from({ length: 4 }, () => (
    launcher.resolve('fixture-package@1.0.0', 'fixture-bridge')
  )))
  assert.equal(attempts, 1)
  assert.equal(spawns, 0)
  assert.equal(failed.every((item) => item.status === 'rejected' && item.reason === expected), true)
  assert.deepEqual(
    await launcher.resolve('fixture-package@1.0.0', 'fixture-bridge'),
    {
      executable: 'fixture-bridge',
      kind: 'direct',
      command: '/tmp/recovered',
      pathValue: '/tmp',
      environment: {},
    },
  )
  assert.equal(attempts, 2)
})

test('one business startup failure stays isolated after shared preparation', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aamp-package-failure-'))
  const worker = await createWorkerFixture(root)
  const eventsFile = path.join(root, 'events.log')
  const releaseFile = path.join(root, 'release')
  let materializations = 0
  const launcher = createPackageExecutableLauncher({
    async materialize() {
      materializations += 1
      return directDescriptor(process.execPath)
    },
  })
  const children = []
  try {
    children.push(...await Promise.all([
      launcher.launch({
        packageSpec: 'fixture-package@1.0.0', executable: 'fixture-bridge',
        args: [worker, 'bad', eventsFile, releaseFile, 'fail'], spawnOptions: { stdio: ['ignore', 'pipe', 'pipe'] },
      }),
      launcher.launch({
        packageSpec: 'fixture-package@1.0.0', executable: 'fixture-bridge',
        args: [worker, 'good', eventsFile, releaseFile], spawnOptions: { stdio: ['ignore', 'pipe', 'pipe'] },
      }),
    ]))
    const badExit = await waitForExit(children[0])
    assert.deepEqual(badExit, { code: 7, signal: null })
    assert.equal(children[1].exitCode, null)
    await fsp.writeFile(releaseFile, 'release')
    assert.deepEqual(await waitForExit(children[1]), { code: 0, signal: null })
    assert.equal(materializations, 1)
  } finally {
    await stopChildren(children)
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('prepared direct-launch children remain independently stoppable', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aamp-package-cleanup-'))
  const worker = await createWorkerFixture(root)
  const eventsFile = path.join(root, 'events.log')
  const releaseFile = path.join(root, 'never-release')
  const launcher = createPackageExecutableLauncher({ materialize: async () => directDescriptor(process.execPath) })
  const children = []
  try {
    children.push(...await Promise.all(['one', 'two'].map((id) => launcher.launch({
      packageSpec: 'fixture-package@1.0.0',
      executable: 'fixture-bridge',
      args: [worker, id, eventsFile, releaseFile],
      spawnOptions: { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' },
    }))))
    await until(async () => {
      const content = await fsp.readFile(eventsFile, 'utf8').catch(() => '')
      return content.split(/\r?\n/).filter((line) => line.startsWith('start:')).length === 2
    }, 'cleanup fixtures did not start')
    for (const child of children) child.kill('SIGTERM')
    const exits = await Promise.all(children.map(waitForExit))
    assert.equal(exits.every(({ code, signal }) => signal === 'SIGTERM' || code !== null), true)
  } finally {
    await stopChildren(children)
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('Windows npm resolver transports fixed source as a single-line data module', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aamp-resolver-transport-'))
  try {
    const executable = process.platform === 'win32' ? 'transport-fixture.exe' : 'transport-fixture'
    const native = path.join(root, executable)
    await fsp.copyFile(process.execPath, native)
    await fsp.chmod(native, 0o755)
    const args = npmExecutableResolverArgs(executable, {platform: 'win32'})
    assert.equal(args[0], '--input-type=module')
    assert.equal(args[1], '--eval')
    assert.match(args[2], /^import\('data:text\/javascript;base64,[A-Za-z0-9+/=]+'\)$/)
    assert.equal(args[3], executable)
    assert.match(npmExecutableResolverArgs(executable, {platform: 'linux'})[2], /\nimport fs/)
    const {stdout} = await execFileAsync(process.execPath, args, {env: withoutNpmExecContext({...process.env, PATH: root}), timeout: 5000})
    assert.equal(parseResolvedPackageExecutable(stdout, executable).command, native)
  } finally {await fsp.rm(root, {recursive: true, force: true})}
})

test('resolver captures the executable shim and exact npm PATH without shell lookup', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aamp-package-resolver-'))
  try {
    const binDir = path.join(root, 'node_modules', '.bin')
    await fsp.mkdir(binDir, { recursive: true })
    const shim = path.join(binDir, process.platform === 'win32' ? 'fixture-bridge.exe' : 'fixture-bridge')
    await fsp.copyFile(process.execPath, shim)
    await fsp.chmod(shim, 0o755)

    for (const env of [
      withoutNpmExecContext({
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
      }),
      { Path: binDir },
    ]) {
      const { stdout } = await execFileAsync(
        process.execPath,
        npmExecutableResolverArgs('fixture-bridge'),
        { env, timeout: 5_000 },
      )
      assert.deepEqual(parseResolvedPackageExecutable(stdout, 'fixture-bridge'), {
        executable: 'fixture-bridge',
        kind: 'direct',
        command: shim,
        pathValue: env.PATH || env.Path,
        environment: {},
      })
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('real npm directory package resolves the executable shim created for the requested package', {
  skip: process.platform === 'win32' && 'POSIX directory-link fixture',
}, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aamp-directory-package-'))
  const packageRoot = path.join(root, 'requested')
  const cacheDir = path.join(root, 'npm-cache')
  try {
    await writePackage(packageRoot, {
      name: '@fixture/directory-bridge',
      version: '1.0.0',
      bin: { 'fixture-directory-bridge': 'bin/bridge.sh' },
    }, {
      'bridge.sh': '#!/bin/sh\nprintf "%s\\n" directory-requested\n',
    })

    const descriptor = await npmMaterialize(
      packageRoot,
      'fixture-directory-bridge',
      cacheDir,
    )

    assert.equal(descriptor.kind, 'direct')
    assert.equal(descriptor.executable, 'fixture-directory-bridge')
    assert.equal(path.basename(descriptor.command), 'fixture-directory-bridge')
    assert.match(descriptor.command, /node_modules[/\\]\.bin[/\\]fixture-directory-bridge$/)
    assert.ok(descriptor.pathValue.split(path.delimiter).includes(path.dirname(descriptor.command)))
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('real npm shim keeps requested-bin precedence, shell semantics, and package-local PATH', {
  skip: process.platform === 'win32' && 'POSIX shell fixture',
}, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aamp-real-npm-shim-'))
  const requestedRoot = path.join(root, 'z-requested')
  const shadowRoot = path.join(root, 'a-shadow')
  const cacheDir = path.join(root, 'npm-cache')
  try {
    await writePackage(shadowRoot, {
      name: 'a-shadow',
      version: '1.0.0',
      bin: {
        'fixture-collision': 'bin/shadow.sh',
        'fixture-helper': 'bin/helper.sh',
      },
    }, {
      'shadow.sh': '#!/bin/sh\nprintf "%s\\n" shadow-wrong\n',
      'helper.sh': '#!/bin/sh\nprintf "%s\\n" dependency-helper\n',
    })
    await writePackage(requestedRoot, {
      name: 'z-requested',
      version: '1.0.0',
      bin: {
        'fixture-collision': 'bin/requested.sh',
        'fixture-helper': 'bin/helper.sh',
      },
      dependencies: { 'a-shadow': `file:${shadowRoot}` },
    }, {
      'requested.sh': '#!/bin/sh -e\ncase "$-" in *e*) ;; *) exit 9;; esac\nprintf "%s\\n" requested-shell\nfixture-helper\n',
      'helper.sh': '#!/bin/sh\nprintf "%s\\n" package-local-helper\n',
    })
    const packed = JSON.parse((await npmRun([
      'pack', '--json', '--pack-destination', root, requestedRoot,
    ], { timeout: 10_000 })).stdout)
    const packageSpec = path.join(root, packed[0].filename)

    const launcher = createPackageExecutableLauncher({
      materialize: (packageSpec, executable, context) => npmMaterialize(
        packageSpec,
        executable,
        cacheDir,
        context.env,
      ),
    })
    const child = await launcher.launch({
      packageSpec,
      executable: 'fixture-collision',
      context: { env: process.env },
      spawnOptions: { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
    })
    const result = await collectOutput(child)()
    assert.deepEqual(result, {
      code: 0,
      signal: null,
      stdout: 'requested-shell\npackage-local-helper\n',
      stderr: '',
    })
    const materializedRoots = await fsp.readdir(path.join(cacheDir, '_npx'))
    assert.equal(materializedRoots.length, 1)
    const shadowManifest = JSON.parse(await fsp.readFile(path.join(
      cacheDir,
      '_npx',
      materializedRoots[0],
      'node_modules',
      'a-shadow',
      'package.json',
    ), 'utf8'))
    assert.equal(shadowManifest.name, 'a-shadow')
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('prepared shim receives the real allowlisted npm lifecycle context and caller environment', {
  skip: process.platform === 'win32' && 'POSIX real-npm fixture',
}, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aamp-npm-context-'))
  const packageRoot = path.join(root, 'context-package')
  const cacheDir = path.join(root, 'npm-cache')
  const safeEnvironment = {
    HOME: root,
    PATH: process.env.PATH || '',
    TMPDIR: os.tmpdir(),
    npm_config_offline: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  }
  try {
    await writePackage(packageRoot, {
      name: '@fixture/context-bridge',
      version: '1.0.0',
      bin: { 'fixture-context-bridge': 'bin/context.mjs' },
    }, {
      'context.mjs': `#!/usr/bin/env node
const keys = ${JSON.stringify(NPM_EXEC_CONTEXT_KEYS)}
const context = {}
for (const key of keys) {
  if (Object.hasOwn(process.env, key)) context[key] = process.env[key]
}
process.stdout.write(JSON.stringify({
  context,
  caller: process.env.AAMP_CALLER_SENTINEL || '',
  pathValue: process.env.PATH || process.env.Path || '',
}) + '\\n')
`,
    })

    const baselineResult = await npmRun([
      'exec', '--yes', '--offline', '--cache', cacheDir,
      '--package', packageRoot, '--', 'fixture-context-bridge',
    ], { env: safeEnvironment, timeout: 15_000 })
    const baseline = JSON.parse(baselineResult.stdout.trim().split(/\r?\n/).at(-1))
    assert.deepEqual(Object.keys(baseline.context).sort(), [...NPM_EXEC_CONTEXT_KEYS].sort())

    const launcher = createPackageExecutableLauncher({
      materialize: (packageSpec, executable, context) => npmMaterialize(
        packageSpec,
        executable,
        cacheDir,
        context.env,
      ),
    })
    const descriptor = await launcher.resolve(
      packageRoot,
      'fixture-context-bridge',
      { env: safeEnvironment },
    )
    assert.deepEqual(descriptor.environment, baseline.context)
    assert.deepEqual(Object.keys(descriptor.environment).sort(), [...NPM_EXEC_CONTEXT_KEYS].sort())
    assert.equal(
      Object.keys(descriptor.environment).some((key) => /npm_config|token|credential/i.test(key)),
      false,
    )

    const callerEnvironment = {
      ...safeEnvironment,
      AAMP_CALLER_SENTINEL: 'caller-preserved',
    }
    for (const key of NPM_EXEC_CONTEXT_KEYS) callerEnvironment[key] = `caller-${key}`
    const child = launcher.launchPrepared({
      preparedExecutable: descriptor,
      spawnOptions: { env: callerEnvironment, stdio: ['ignore', 'pipe', 'pipe'] },
    })
    const result = await collectOutput(child)()
    assert.equal(result.code, 0)
    assert.equal(result.stderr, '')
    const launched = JSON.parse(result.stdout.trim())
    assert.deepEqual(launched.context, baseline.context)
    assert.equal(launched.caller, 'caller-preserved')
    assert.equal(launched.pathValue, descriptor.pathValue)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('Windows cmd descriptors use ComSpec escaping without shell mode', () => {
  const calls = []
  const launcher = createPackageExecutableLauncher({
    platform: 'win32',
    materialize: async () => ({
      executable: 'fixture-bridge',
      kind: 'cmd',
      command: 'C:\\npm cache\\node_modules\\.bin\\fixture-bridge.cmd',
      pathValue: 'C:\\npm cache\\node_modules\\.bin;C:\\Windows\\System32',
      environment: {},
    }),
    spawnProcess(command, args, options) {
      const call = { command, args, options }
      calls.push(call)
      return call
    },
  })
  const descriptor = {
    executable: 'fixture-bridge',
    kind: 'cmd',
    command: 'C:\\npm cache\\node_modules\\.bin\\fixture-bridge.cmd',
    pathValue: 'C:\\npm cache\\node_modules\\.bin;C:\\Windows\\System32',
    environment: {},
  }

  const child = launcher.launchPrepared({
    preparedExecutable: descriptor,
    args: ['plain', 'space value', 'left&right'],
    spawnOptions: {
      env: { Path: 'C:\\old', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      stdio: 'pipe',
      detached: false,
    },
  })

  assert.equal(child, calls[0])
  assert.equal(calls[0].command, 'C:\\Windows\\System32\\cmd.exe')
  assert.deepEqual(calls[0].args.slice(0, 3), ['/d', '/s', '/c'])
  assert.match(calls[0].args[3], /fixture-bridge\.cmd/)
  assert.match(calls[0].args[3], /space/)
  assert.match(calls[0].args[3], /left\^\^\^&right/)
  assert.equal(calls[0].options.shell, false)
  assert.equal(calls[0].options.windowsVerbatimArguments, true)
  assert.equal(calls[0].options.stdio, 'pipe')
  assert.equal(calls[0].options.detached, false)
  assert.equal(calls[0].options.env.Path, descriptor.pathValue)
  assert.equal(Object.hasOwn(calls[0].options.env, 'PATH'), false)
})

test('controller resolver resists a package-local node bin and managed cleanup records exit', {
  skip: process.platform === 'win32' && 'POSIX process-group fixture',
  timeout: 60_000,
}, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aamp-managed-npm-shim-'))
  const packageRoot = path.join(root, 'managed-package')
  const cacheDir = path.join(root, 'npm-cache')
  const logFile = path.join(root, 'logs', 'managed.jsonl')
  const previousCache = process.env.AAMP_TASK_NPM_CACHE_DIR
  process.env.AAMP_TASK_NPM_CACHE_DIR = cacheDir
  let controller
  let record
  let pendingStart
  try {
    await writePackage(packageRoot, {
      name: '@fixture/managed-bridge',
      version: '1.0.0',
      bin: {
        'fixture-managed-bridge': 'bin/bridge.sh',
        node: 'bin/shadow-node.sh',
      },
    }, {
      'bridge.sh': [
        '#!/bin/sh',
        'if [ "$1" = "--help" ]; then exit 0; fi',
        'trap "exit 0" TERM INT',
        'printf \'%s\\n\' \'{"type":"fixture.started","source":"requested-shell"}\'',
        'while :; do sleep 1; done',
        '',
      ].join('\n'),
      'shadow-node.sh': '#!/bin/sh\nprintf "%s\\n" resolver-node-shadowed >&2\nexit 13\n',
    })
    controller = await import(`../bin/feishu-task-agent-controller.mjs?managed-shim=${Date.now()}`)

    pendingStart = controller.startManagedProcess({
      label: 'Fixture Managed Bridge',
      packageSpec: packageRoot,
      executable: 'fixture-managed-bridge',
      args: [],
      env: { ...process.env, npm_config_offline: 'true' },
      logFile,
    })
    record = await withTimeout(
      pendingStart,
      15_000,
      'managed launch timed out',
    )
    await until(
      () => record.events.some((event) => (
        event.type === 'fixture.started' && event.source === 'requested-shell'
      )),
      'managed launch did not emit its ready event',
    )

    await controller.cleanupAll()
    assert.equal(record.exited, true)
    assert.equal(record.expectedStop, true)
    assert.equal(record.exit.code === 0 || record.exit.signal === 'SIGTERM', true)

    const lines = (await fsp.readFile(logFile, 'utf8')).trim().split(/\r?\n/)
    const started = JSON.parse(lines[0])
    const exited = JSON.parse(lines.at(-1))
    assert.deepEqual({ type: started.type, status: started.status }, {
      type: 'bridge.process', status: 'started',
    })
    assert.equal(started.package, packageRoot)
    assert.equal(started.executable, 'fixture-managed-bridge')
    assert.deepEqual({ type: exited.type, status: exited.status, expectedStop: exited.expectedStop }, {
      type: 'bridge.process', status: 'exited', expectedStop: true,
    })
  } finally {
    // A timeout in withTimeout does not cancel the launch. Let its bounded
    // probe settle before cleanup/removing the cache it may still be using.
    await pendingStart?.catch(() => {})
    if (typeof controller?.cleanupAll === 'function') await controller.cleanupAll()
    if (previousCache === undefined) delete process.env.AAMP_TASK_NPM_CACHE_DIR
    else process.env.AAMP_TASK_NPM_CACHE_DIR = previousCache
    await fsp.rm(root, { recursive: true, force: true })
  }
})


test('native Windows npm package shim preserves argv stdin and exit code', {skip: process.platform !== 'win32' && 'requires native Windows cmd.exe'}, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aamp-windows-argv-'))
  try {
    const pkg = path.join(root, '中文 package')
    await fsp.mkdir(pkg, {recursive:true})
    await fsp.writeFile(path.join(pkg,'package.json'), JSON.stringify({name:'aamp-windows-argv-fixture',version:'1.0.0',type:'module',bin:{'argv-fixture':'argv.mjs'}}))
    await fsp.copyFile(new URL('./fixtures/windows-argv.mjs',import.meta.url),path.join(pkg,'argv.mjs'))
    const packed = JSON.parse((await npmRun(['pack','--json','--pack-destination',root,pkg],{timeout:30000})).stdout)
    const packageSpec=path.join(root,packed[0].filename)
    const launcher=createPackageExecutableLauncher({materialize:(spec,bin)=>npmMaterialize(spec,bin,path.join(root,'cache'))})
    const args=['中文 空格','a&b','(item)','x%PATH%','a!b',"a'b",'a"b','C:\\space dir\\']
    const child=await launcher.launch({packageSpec,executable:'argv-fixture',args,spawnOptions:{stdio:['pipe','pipe','pipe']}})
    const output=collectOutput(child)
    child.stdin.end('中文\r\nsecond line')
    const result=await output()
    assert.equal(result.code,7,result.stderr)
    assert.deepEqual(JSON.parse(result.stdout),{args,input:'中文\r\nsecond line'})
  } finally {await fsp.rm(root,{recursive:true,force:true})}
})
