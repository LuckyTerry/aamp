# 飞书任务 AAMP Windows 原生支持执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans 按本计划逐任务实现与验证。使用 `- [ ]` 记录进度。当前已进入实现；勾选表示已完成该具体步骤，实机验证与发布保持独立，详细证据见验收记录。

**Goal:** 在 Windows 11 x64 原生环境跑通现有飞书任务 → AAMP → 本地 Codex → 飞书结果回传，以及安装、绑定、后台运行、停止、日志和卸载。

**Architecture:** 共用既有 Node Controller / Feishu Bridge / ACP Bridge；Windows 增加 Node helper、必要进程适配和当前用户 Task Scheduler。优先复用已有启动器，仅实测缺口允许局部采用 cross-spawn。

**Tech Stack:** 现有 Node.js / TypeScript / ESM，Windows PowerShell 5.1，Task Scheduler，CIM，npm。Windows 验收 Node 22/24，PowerShell 7 仅补充验证。

**Spec:** [Windows 原生支持设计与选型](../specs/2026-09-07-aamp-feishu-task-windows-native-design.md)。本文细化任务与验证，设计文档持有业务及平台约束；发生冲突时先修正文档，不扩大范围实现。

## 本次开发状态（2026-09-08）

代码与本地验证在用户指定分支进行。用户明确要求先开发，因此原生 Codex 探针、Windows 普通用户桌面闭环及远程 CI 均延期，不能勾选通过。详细命令、测试数和包 integrity 见 [验收记录](../../testing/feishu-task-windows-native-acceptance.md)。

| 任务 | 开发状态 | 未完成验收 |
|---|---|---|
| 1–4 入口、helper、默认值和平台边界 | 本地实现、回归通过 | Windows 实际 shim、普通用户 ACL |
| 5 Agent / Bridge | Codex 代码链路与本地回归通过 | 原生 Codex session、真实 Task |
| 6–7 后台与进程 | 本地实现、复审通过 | 登录会话、崩溃、进程树隔离实机 |
| 8 日志与实际包 | 本地实现、三包 tgz 安装验证通过 | Windows 完整安装、更新、卸载 |
| 9 CI | 配置已添加 | 尚未推送或运行 |
| 10 交付证据 | 记录已建立 | Windows 全部实机与发布门禁 |

## Global Constraints

- 工作位置为用户指定的当前 AAMP checkout；分支 `feat/feishu-task-windows-native`，基线 `7c4b7ff50b2fc766f9076dcbc7d87ce910ca8b76`，来自 `origin/fix/feishu-auth-scope-negotiation`。不另建 worktree，不切换其他仓库。
- 只改 Task Agent、ACP Bridge、活跃 Feishu Bridge 与其测试、文档、必要 CI/锁文件。`aamp-feishu-task-bridge` 为旧实现，不接入本次链路。
- Task/AAMP schema、Task/IM scopes、Sender Policy、配对、Owner、结果、并发与失败处理语义不变；不修业务补偿、去重、取消或 `add` 自动启动。
- macOS/Linux 保留当前行为；不重写完整 Bootstrap、不新增 Linux service。Windows 不依赖 WSL、Bash、MSYS、Docker、管理员权限。
- 不引入 PM2、WinSW、Electron、Tauri、oclif、SEA、Go/Rust 宿主；保留 npm 分发。
- 不改变上游 Agent 审批方式、不额外请求 scopes。未经原生探针验证的 Agent 不进入可用清单；Codex 是发布必过项。
- 凭证不上 argv、日志或 CI；沿用产品状态模型。Windows 使用 ACL，不把 chmod 成功当作隔离证据。
- 本地提交按下列交付单元组织；本计划不自动 push、注册真实 Bot、派发真实任务或 npm publish。实机业务验证需专用测试身份和授权输入，未取得时完成其他验证并明确缺失项。

## 0. 执行环境、命令与证据

### 0.1 源码已核验事项

三个包各有 package-lock.json。Task Agent 的 `npm test` 为 `node --test "test/**/*.test.mjs"`；ACP 的 `npm test` 同时覆盖 `src/` 与五个 `test/` 测试入口；Feishu Bridge **没有 test script**，需显式执行测试。现有 CI 只覆盖 SDK，不修改它来承载产品测试。

当前 checkout 未找到 AGENTS.md / CLAUDE.md；实施前重新检查。原有 `runtime-package-executable.test.mjs` 内部仍有直接 `execFileAsync('npm', ...)`：测试工具自身也需要原生调用适配，不能把该失败误判为产品失败或靠 skip 隐藏。

### 0.2 统一运行口径

所有路径相对 AAMP 根目录。先分别在三个 package 内运行 `npm ci`，Windows 使用 `npm.cmd ci`。不在仓根执行不存在的 monorepo 安装命令。macOS/Linux 将下文 npm.cmd 换成 npm。

```powershell
# Task Agent 目录：完整旧套件用于 macOS 回归；Windows 按 Task 9 分类执行。
npm.cmd test
# ACP Bridge 目录：不得只执行 src 而漏掉 test/。
npm.cmd test
npm.cmd exec -- tsc --noEmit
# Feishu Bridge 目录：已有测试无需添加新框架。
node --import tsx --test "src/**/*.test.ts"
npm.cmd exec -- tsc --noEmit
```

每个任务遵循：先加失败测试 → 运行并确认失败原因 → 最小实现 → 同一测试通过 → 相关回归 → 检查 diff → 提交该任务文件。不得提交整个工作区或无关变更。

真实平台证据分为：macOS 基线、Windows 自动化、Windows 交互桌面、实际 npm 安装包、真实业务闭环。不能以模拟 `platform='win32'` 替代后四项。当前仅核对源码，尚未在新 checkout 安装依赖或执行测试。

### 0.3 依赖顺序与阶段退出条件

```text
Task 1 基线/启动验证 → Task 2 原生入口 → Task 3 helper/共享默认值
                   → Task 4 文件与凭证 → Task 5 Agent/Bridge 前台闭环
                   → Task 6 用户后台 → Task 7 退出/重启
                   → Task 8 日志/实际包 → Task 9 CI → Task 10 实机验收
```

Task 4 必须先于任何真实凭证写入。原定 Task 5 的 Codex 原生 ACP 探针顺序已按用户后续“先开发”指令延期；本地后台实现可以继续，发布前仍必须通过该探针；上游原生入口不支持时先定位该问题，不以后台框架绕过。Task 9 的测试运行脚本可在前序任务中随测试建立，CI 接线在相应入口稳定后完成。无 Windows 设备时仍可完成本地实现和纯逻辑测试，但不能勾选原生验证通过。

## Task 1：冻结基线并验证现有启动器

**Files:** 修改 `packages/aamp-feishu-task-agent/test/runtime-package-executable.test.mjs`；新增 `packages/aamp-feishu-task-agent/test/fixtures/windows-argv.mjs`。仅确有产品缺口时修改 `bin/runtime-package-executable.mjs`。

**现有接口:** `createPackageExecutableLauncher({materialize,spawnProcess,platform})` 返回 `{resolve,launch,launchPrepared}`。保留 descriptor 校验、包解析缓存及环境合并。

- [x] 执行 `git status --short --branch`、`git rev-parse HEAD origin/fix/feishu-auth-scope-negotiation`；记录当前 SHA，不拉取后静默移动开发基线。
- [x] 三包 `npm ci`，按 §0.2 执行 macOS 基线；记录失败和环境原因，已有失败单列，不顺带修业务。
- [ ] fixture 原样输出 argv 与 stdin；由测试生成临时 npm 包及 shim，不依赖机器预装 Agent：

```javascript
// test/fixtures/windows-argv.mjs
let input = '';
for await (const chunk of process.stdin) input += chunk;
process.stdout.write(JSON.stringify({args: process.argv.slice(2), input}));
```

- [ ] 基于现有 `npmMaterialize` / `collectOutput` 测试工具覆盖以下输入及非零退出：

```javascript
const values = ['中文 空格', 'a&b', '(item)', 'x%PATH%', 'a!b', "a'b", 'a"b', 'C:\\space dir\\'];
// output 为真实子进程 JSON；不是只断言 spawn mock 的入参。
assert.deepEqual(JSON.parse(output).args, values);
assert.equal(JSON.parse(output).input, '中文\r\nsecond line');
```

- [ ] Windows 测试内定位 npm 的真实 Node bin，避免测试工具本身直接 execFile npm.cmd；测试中先保持产品实现原样，确认失败归属。
- [ ] 命令：`node --test test/runtime-package-executable.test.mjs`。Windows 必须执行实际 shim case；缺 Windows 设备时只记录待验。
- [ ] 若真实 bin 和现有 launcher 已覆盖，不引入库；否则记录最小失败样例，按设计 §3.3 修复或局部采用 cross-spawn。不能复制新 cmd 转义器。
- [ ] 提交：`test(feishu-task-agent): cover native Windows executable launching`；若有产品修复则标题准确说明修复内容。

**Done:** 有真实 argv/stdin/退出码证据，且能区分测试夹具失败、产品失败和上游缺失。

## Task 2：Node bin 入口与 Windows 前台控制台

**Files:** 新增 `packages/aamp-feishu-task-agent/bin/feishu-task-agent.mjs`、`bootstrap/windows-entry.mjs`、`bin/windows-platform.mjs`、`test/windows-entry.test.mjs`；修改该包 `package.json`、必要锁文件及 `bin/feishu-task-agent-controller.mjs` 的入口/terminal 分支。

**新增接口:** `runWindowsEntry(argv): Promise<void>`；`resolveNativeCommand(name,env): Promise<{command,argsPrefix}>`；`openWindowsTerminal(): {input,output}`。真实 Node bin 对应 `command=process.execPath`、`argsPrefix=[binPath]`，保留剩余参数数组。

- [ ] 用子进程测 `.cmd help/list` 成功、非 TTY install/add 明确失败、帮助命令不写凭证、不启动后台。
- [ ] bin dispatcher 的控制流如下；Windows entry 只做原有参数/环境接线，最终调用 Controller，不复制业务命令实现：

```javascript
if (process.platform === 'win32') {
  const {runWindowsEntry} = await import('../bootstrap/windows-entry.mjs');
  await runWindowsEntry(process.argv.slice(2));
} else {
  // spawn('bash', [现有 Bootstrap 的绝对路径, ...argv], {stdio:'inherit'})
  // 转发退出码与终端中断；不重做原有 flags 解析。
}
```

- [x] 两个 Agent bin 改指 Node dispatcher，aamp-logs 保持现有 bin；同步 package.files 包含 Windows entry，否则源码通过但安装包缺文件。
- [ ] 逐项对照 Bootstrap 传入 Controller 的环境，保留 command、foreground、配置路径、版本覆盖与原有代理策略。Windows 不打开 `/dev/tty`。
- [x] 执行 `node --test test/windows-entry.test.mjs`；macOS 执行现有 `test/bootstrap.test.mjs`，验证直接 Bash 入口与 Node 转发语义。
- [ ] 提交：`feat(feishu-task-agent): add native Windows CLI entry`。

**Done:** 安装入口可原生启动；此时不宣称授权或任务执行可用。

## Task 3：五个 helper、默认值与注册程序

**Files:** 新增 `packages/aamp-feishu-task-agent/bootstrap/windows-helper.mjs`、`bootstrap/task-agent-defaults.json`、`bootstrap/register-feishu-app.mjs`、`scripts/sync-bootstrap-defaults.mjs`、`test/windows-helper.test.mjs`、`test/windows-profile.test.mjs`；修改原 Bootstrap、Controller helper 调用及打包文件列表。

**接口:** `runWindowsHelper(action,payload,extraEnv): Promise<object>`。动作限定为 `__discover-agents`、`__register-binding`、`__prepare-agent`、`__probe-profile`、`__ensure-profile`；返回字段逐项沿用设计 §3.1。IPC 为 request/result/error，不扩业务 schema。

- [ ] fake SDK/CLI 记录注册输入，分别覆盖 Feishu/Lark 和 optional/required/disabled；断言结果字段与旧 helper 一致，日志无测试 secret。
- [x] 原样提取 scope manifest v2、固定版本/包名和注册 Node 程序；Bash 内嵌默认值由 JSON 生成。Controller 中相同包默认值也消费唯一来源，保留原有环境变量覆盖优先级，避免第三份手写版本继续漂移。
- [x] 生成器定义 `node scripts/sync-bootstrap-defaults.mjs --check`：只比较生成块，不写文件；不一致返回非零。普通调用才同步生成块。禁止生成器改写业务函数。
- [ ] fork IPC 的边界代码形态：

```javascript
const child = fork(helperPath, [], {stdio: ['inherit', 'inherit', 'inherit', 'ipc'], env});
child.send({kind: 'request', action, payload});
// 收到一次 result 后收尾；error/exit/disconnect 无 result 时 reject。
// 用户取消返回既有 cancelled 结果；stdout 不解析成业务结果。
```

- [ ] SDK 模块从原有 materialize 目录解析；Bash 独立下载入口在既有产品安装后定位注册程序。复制单个 Bootstrap 到临时空目录，执行原有 mock 流程验证自包含行为。
- [ ] 保留 profile 锁、exact profile、品牌、租户键、取消和 pending 状态。后台 __service-run 不等待人工授权。
- [x] 执行 `node --test test/windows-helper.test.mjs test/windows-profile.test.mjs test/controller-profile.test.mjs test/binding-persistence.test.mjs`；Bash 契约在 macOS 执行。
- [ ] 提交：`feat(feishu-task-agent): implement Windows bootstrap helpers`。

**Done:** 五个接口具备独立假依赖验证；真实注册须等 Task 4 完成且提供测试身份。

## Task 4：Windows 私有目录、凭证写入与进程身份

**Files:** 扩展 `packages/aamp-feishu-task-agent/bin/windows-platform.mjs`；修改 Controller 的本产品目录/文件写入口；仅当原生失败需要时修改 `packages/aamp-feishu-bridge/src/private-json.ts` 及测试；新增 Task Agent `test/windows-platform.test.mjs`。

**接口:** `ensurePrivateWindowsDirectory(dir): Promise<void>`；`readWindowsProcessIdentity(pid): Promise<{pid,startedAt,command,executablePath,ownerSid}|undefined>`。CIM 结果转换为稳定字段，访问拒绝不能视为确认不存在。通过私有父目录 ACL 保护继承文件，写新凭证前先校验权限。

- [ ] 编写 ACL 失败时不写凭证、UTF-8/CRLF、文件占用时保留旧 JSON、进程身份读取拒绝与 PID 重用测试。
- [x] 当前 SID 精确配置 ACL；保留必要 SYSTEM/Administrators；不新增 DPAPI，不改 lark-cli 私有实现。跨包仅改实际 Windows 写入问题，不新建凭证框架。
- [x] 原子替换仅对设计中的共享占用错误有界重试，5 次间隔 100/200/400/800/1600ms，不先删旧文件；测试用注入的 rename/sleep 验证，不真实等待完整退避。
- [x] 使用固定 PowerShell 脚本和结构化输入查询 CIM/ACL；不把路径或密钥拼接为 shell 程序。授权 URL 通过 env 传给固定 Start-Process 脚本。
- [x] 执行 `node --test test/windows-platform.test.mjs test/binding-persistence.test.mjs`；Feishu 修改时执行 `node --import tsx --test src/private-json.test.ts`。
- [ ] Windows 普通用户实测 ACL；第二普通用户读取拒绝由具备该环境的实机验证，不要求产品提权创建用户。
- [ ] 提交：`feat(feishu-task-agent): protect Windows runtime state`。

**Done:** 可以安全保存真实测试配置，身份查询失败会阻止破坏性清理。

## Task 5：Agent/Bridge 原生前台闭环

**Files:** 修改 `packages/aamp-acp-bridge/src/acpx-client.ts`、`src/agent-resolver.ts`、`src/discovery.ts` 及现有对应测试；修改 `packages/aamp-feishu-bridge/src/feishu-cli.ts`、`src/task/dispatch.ts` 及其测试；扩展 Windows helper；新增 Task Agent `bin/windows-agent-wrapper.mjs`、`test/windows-agent-wrapper.test.mjs`。

**接口:** wrapper 私有配置 `{command,args,env}`，原有 `acp_command` 字段仍是字符串。不改协议；wrapper 优先执行真实 Node bin。远程 Agent 提示词不按宿主 Windows 改写。

- [ ] 对 Feishu CLI、acpx、ACP 子进程做真实 fixture argv/stdin/退出码测试，使用 Task 1 相同输入数据。
- [ ] 补齐 acpx/npx/lark-cli 调用；包内局部封装只处理必要入口，不从另一包相对 import 私有实现。cross-spawn 仅按已证明缺口引入，更新受影响 package.json/锁文件。
- [ ] Codex wrapper 保留锁定 adapter 和 CODEX_PATH，程序骨架：

```javascript
const child = spawn(config.command, config.args, {
  env: {...process.env, ...config.env}, stdio: 'inherit', shell: false,
});
child.once('error', () => { process.exitCode = 1; });
child.once('close', code => { process.exitCode = code ?? 1; });
// 退出协调由 Task 7 补齐；这里不得把 shell 字符串放入 command。
```

- [ ] 通过 acpx 实际 `--agent` 解析测试空格、中文、引号路径；不能只直接运行 wrapper 就认定链路成立。
- [x] Windows prompt 用 PowerShell 调用运算符、路径转义和 exact profile；测试 POSIX/remote 文本原样，Task 结果结构原样。
- [ ] Codex 真实原生 session 创建/关闭作为门槛；其他已有 Agent 按原生入口和登录探针决定可用性，不新建适配器，不静默替换 Agent 类型。
- [x] Task Agent 执行 wrapper tests；ACP 按 §0.2 执行完整 npm test 和 tsc；Feishu 执行全部 src tests 和 tsc。
- [ ] 提交：`fix(acp-bridge): launch native Windows agents`；`fix(feishu-bridge): support native Windows CLI commands`；Task Agent wrapper 随关联变更单独提交。

**Done:** fake Agent 完成原结果契约，Codex 无业务副作用探针通过；真实飞书任务写回在 Task 10 验收。

## Task 6：当前用户后台托管

**Files:** 新增 `packages/aamp-feishu-task-agent/bin/windows-service.mjs`、`bin/windows-service-worker.mjs`、`test/windows-service.test.mjs`；修改 Controller 的 Windows lifecycle 分支和 `test/service-lifecycle.test.mjs`。不重构 launchd 后端。

**接口:** `createWindowsServiceManager(options)` 返回现有 manager 对应 `start/stop/status/restart/selection/selectionSnapshot/markReady/recentLogs/paths` 形状；参考 launchd-service.mjs 的实际返回契约。不抽象一个新的跨平台管理框架。

- [ ] 先扩展现有选择测试：

```javascript
assert.equal(controller.shouldUseBackgroundService('start', 'win32', false), true);
assert.equal(controller.shouldUseBackgroundService('start', 'win32', true), false);
assert.equal(controller.shouldUseBackgroundService('__service-run', 'win32', false), false);
assert.equal(controller.shouldUseBackgroundService('start', 'linux', false), false);
```

- [ ] fake scheduler/identity 测试：Scheduler Running 而 generation、bindings 或进程身份不同，ready 必须 false。
- [x] 固定 PowerShell 程序注册 SID 唯一任务名、Interactive/Limited、AtLogOn、IgnoreNew、ExecutionTimeLimit=0、电池允许运行、失败重启 3 次/1 分钟。结构化输入承载参数，不写登录密码，不设置系统 ExecutionPolicy。
- [x] 稳定 worker 引用安装后的实际 Node 路径与产品 worker 文件，不能依赖 npx cache；不随产品捆绑新 Node 发行版。Node 路径丢失时报可修复错误，start 重新检查。
- [x] worker 托管 Controller 并等待其退出，转发失败退出码给 Scheduler；不生成脱离 worker 后仍误报成功的进程。selection/readiness 保持既有语义。
- [x] 前台 readiness → 释放前台资源 → 后台启动 → 后台重新确认 readiness。Task Scheduler Running 不替代 Bridge ready。
- [x] `node --test test/windows-service.test.mjs test/service-lifecycle.test.mjs`；macOS 追加 `test/launchd-service.test.mjs`。
- [ ] 提交：`feat(feishu-task-agent): manage Windows user background tasks`。

**Done:** 后台方案注册和状态语义有测试；关闭终端及真实登录场景另有实机证据。

## Task 7：停止、重启、更新时的进程树清理

**Files:** 扩展 Task Agent `bin/windows-platform.mjs`、`bin/windows-service.mjs`、Controller、wrapper；修改 `packages/aamp-acp-bridge/src/acpx-client.ts` 的 Windows terminateProcessTree；新增 Task Agent `test/windows-process-tree.test.mjs`，扩展 ACP acpx-client tests。

**接口:** `stopOwnedWindowsTree(identity): Promise<void>` 只接受经核验的 `{pid,startedAt,executablePath,ownerSid}`；Windows 停止消息 `{generation}` 写在私有 runtime。身份未知或变更时不得 taskkill。

- [ ] fixture 启动父→子→孙与一个独立旁观 Node 进程；测试 stop 后受管树退出、旁观者存活。
- [ ] 正常 stop：停用登录触发 → 写本 generation 请求 → 现有 shutdown（最多 10 秒）→ 重读身份 → 必要时 taskkill 指定 PID /T /F → 确认退出 → 清理本实例 lease。
- [ ] 不能用 Windows SIGTERM 模拟 Unix 优雅退出；超时、Ctrl+C、IPC 断开和 wrapper 失败均覆盖。主动 stop 不应被计划任务再次拉起。
- [ ] PID 重用、CIM 拒绝、旧 generation、另一用户进程全部拒绝清理。只清理已记录身份的本产品遗留进程，不按 node/Agent 名扫描杀进程。
- [ ] restart 保留 selection；先完成停止再启动，update 先释放被占用文件再替换包。运行中 Agent 业务中断语义保持原样。
- [ ] `node --test test/windows-process-tree.test.mjs test/windows-service.test.mjs`；ACP `node --import tsx --test src/acpx-client.test.ts`。
- [ ] Windows 实机验证关闭终端仍运行、stop 后重新登录不启动、显式 start 后登录启动、restart 单实例。
- [ ] 提交：`fix(feishu-task-agent): stop owned Windows process trees`，ACP 对应变更单独提交。

**Done:** 实际进程树清理与旁观进程隔离通过；崩溃重启不被描述为任务补偿或无限自愈。

## Task 8：日志、打包与用户操作

**Files:** 修改 `packages/aamp-feishu-task-agent/bin/aamp-logs.mjs`、README/package.files；新增 `test/windows-logs.test.mjs`、`test/windows-packaged.test.mjs`；三包仅必要版本与锁文件引用。

- [ ] 日志测试覆盖 KnownFolder Desktop 重定向、中文目录、尾部多字节切片、追加/截断/Ctrl+C、压缩归档脱敏。
- [x] Windows 使用系统 tar.exe，tail 用 Node；保留其他平台行为与归档格式。不另写归档框架。
- [ ] 在三个 package 目录分别执行 `npm.cmd pack --json`，记录产物名/integrity；两个 Bridge 的 prepack 应完成 tsc/build。用实际 tgz 路径安装到测试 prefix，不能让 shell glob 选择多个版本。
- [ ] 用现有 `AAMP_TASK_ACP_BRIDGE_PKG` / `AAMP_TASK_FEISHU_BRIDGE_PKG` 覆盖指向本地 tgz 验证修改后的 Bridge；避免表面测源码实际运行旧的 registry 包。
- [ ] npm 安装生成的 .cmd 调用 install/list/start/stop/restart/logs/add/remove/update 按原语义验证；明确 add 只保存 pending。
- [x] 文件清单包含新增 entry/helper/defaults/wrapper/worker，测试脚本不成为运行依赖；单文件 Bash 下载方式继续通过原 mock 验证。
- [x] 发布 scope 有已知差异：源码 Bridge 名为 @zengxingyuan，Controller 默认为 @luckyterry/@iluolyx。记录真实发布归属和必要依赖引用，不擅自改组织名或猜测新版本。
- [ ] README 写 stop → 注销本产品任务 → npm 卸载步骤；验证无残留受管进程，不删除其他 Agent/profile，不注销远端应用。
- [ ] 提交：`feat(feishu-task-agent): package and document native Windows support`。

**Done:** 从 tgz 安装的链路可运行；没有新增安装包格式或 npm publish。

## Task 9：Windows CI 与平台测试覆盖

**Files:** 新增 `.github/workflows/feishu-task-windows.yml`、`packages/aamp-feishu-task-agent/scripts/run-platform-tests.mjs`；必要时调整现有 fixture，不改 SDK workflow。

- [x] runner 枚举现有 test 文件，维护唯一 POSIX-only 分类及原因；Windows 对五个 helper 等被替代行为必须有对等测试。新测试文件默认纳入，不用允许列表静默漏测。
- [x] runner 通过 process.execPath + 参数数组运行 node:test，继承退出码；输出 executed/excluded 清单。Windows-only 测试在 Windows 不得 skip；没有实际执行用例不能判通过。
- [x] workflow 路径只覆盖三个包与该 workflow；沿用仓库 checkout/setup-node action 主版本，Windows Node 22/24 矩阵，Windows 默认 PowerShell 5.1，POSIX 使用 pwsh，另做打包后 PowerShell 5.1 smoke。
- [x] 配置示意：

```yaml
strategy:
  matrix:
    node: ['22', '24']
runs-on: windows-latest
defaults:
  run:
    shell: powershell
# Windows 示例；完整工作流还含 macOS/Ubuntu 的 pwsh。
# 每个包单独 working-directory，分别 npm.cmd ci；
# Agent: node scripts/run-platform-tests.mjs
# ACP: npm.cmd test + npm.cmd exec -- tsc --noEmit
# Feishu: node --import tsx --test "src/**/*.test.ts" + tsc
```

- [x] 清理测试进程 PATH 中的 Bash/MSYS/Git usr/bin 路径，保留 Node 和 Windows 系统工具；fixture 检查启动命令不得解析到 sh/bash/wsl。主机预装 Git Bash 不作为支持依据。
- [x] 为本次包补 macOS 回归与 Linux 前台兼容检查（不新增 Linux 产品能力）。旧 POSIX 脚本测试保持在相应系统执行。
- [x] Hosted Windows CI 不代替 Windows 11 普通用户登录测试；CI 不携带真实 Feishu secret，不自动发真实任务。上传脱敏测试报告和包清单。
- [x] 已提交专用 Windows/macOS/Linux CI；最新证据见验收记录。

**Done:** CI 覆盖完整业务测试与 Windows 对等行为；报告明确哪些场景仍需实机。

## Task 10：实机闭环、发布证据与交付审查

**Files:** 新建 `docs/testing/feishu-task-windows-native-acceptance.md`；仅在实际执行后填写对应结果。代码阶段可先使用下列结构创建记录，状态必须写未执行，不预填通过。

```text
环境：OS build / architecture / PowerShell / Node / Agent / 三包版本与 integrity
源码：HEAD / 开发分支 / base SHA
用例：动作、预期、实际、退出码、task ID、脱敏日志位置
证据：自动化 / 普通用户桌面 / 实际 tgz / 真实业务
结论：通过 / 失败 / 未执行；失败原因与剩余工作
```

- [x] Windows 11 普通用户，无 Bash/WSL：全新隔离安装 → 新Bot/OAuth → 正常扫描后用户选择AIME → 实际wrapper/计算/取消 → 后台启动。用户改验Codex之外的AIME；本机文件不支持另列，不用历史Codex结果代替。
- [x] 专用测试Bot普通任务ACK/结果/完成、need_help + Owner继续、提醒/重复/子任务：Win10历史与Win11/AIME均有独立证据；重复第二轮提前due加速。
- [x] 历史Win10/Codex附件输入与产物上传有服务端回读证据。
- [ ] UNSUPPORTED：Win11/AIME远程运行不支持本机文件交付；已验证派发前拒绝边界，不把历史Codex附件通过移用为AIME通过。
- [x] Win10 关闭启动终端后真实后台任务继续、stop/start/restart、controller 崩溃自动恢复与旁观进程存活；重试耗尽及等待中 stop 另有受控测试。
- [x] Win11实际锁屏期间从手机派发任务，893/done落在两次WTS锁屏观测之间。
- [ ] USER_SKIPPED：用户明确跳过注销/重新登录及实际登录触发；不是PASS，不把锁屏当作登录证据。
- [x] 异常的受控测试层：授权能力/网络错误、CLI 缺失、ACL/身份查询拒绝、PID 重用、多绑定隔离；中文/特殊路径、旁观进程另有 Win10 原生证据。不表示真实 token 撤销、拔网或企业策略变更已实测。
- [x] tgz 更新和卸载闭环；保留绑定、清理本产品任务，远端应用和其他产品数据不受影响。
- [x] 按设计验收矩阵逐项填写结果，已知非 Windows 业务缺陷独立记录；不得通过修业务缺陷使本次范围变大。
- [x] 执行 `git diff --check` 和 `git diff --stat 7c4b7ff50b2fc766f9076dcbc7d87ce910ca8b76`，逐文件解释对应平台阻断点；检查无 SDK/服务端/旧 Task Bridge 改动。
- [x] 发布准备仅记录：必要 Bridge patch → Controller 精确包引用 → Task Agent patch；发布身份/版本核验完成后才具备发布条件。未获发布授权不执行 npm publish。
- [x] 用户确认后d626d3c及验收/计划111f154已推送并回读远端SHA；最终CI结果补充见验收记录。
- [x] 包含d626d3c的111f154对应三平台×Node22/24 CI run34471995377六组成功，三包测试/类型/pack及Windows安装入口已逐项核对。
- [x] 最终Draft PR描述与飞书摘要revision28已同步并回读；不改变Draft或发布状态。

**完成标准:** Windows 原生普通用户完整闭环 + tgz 验证 + CI/实机证据齐全 + macOS/Linux 回归。当前 macOS 上通过静态检查不等于支持完成。

## 交付与回滚

执行时优先在 Task 1–5 暴露原生 Agent/包依赖阻断，避免最后才发现上游不支持。每个提交保持独立可审查；无必要不合并无关重构。

回滚只涉及产品包/必要 Bridge 依赖和本产品计划任务：先停止受管进程、注销 Windows 任务，再切回已知可用版本。保留绑定和用户数据；旧包不支持 Windows 时明确退回不可用状态，不声称旧版可继续后台运行。macOS 回归失败则修复必要的平台边界或回退相关提交，不连带升级其他依赖。

本执行计划更新后，设计约束以仓内 Spec 为准；聚合仓原方案保留为历史来源，不再作为并行维护的执行状态。用户指定当前 checkout 的指令覆盖旧方案中的另建 worktree 路径。

本地交付提交按消费包组织：ACP `29c3506`、Feishu Bridge `8e3f9d5`、Task Agent `a5e49fe`；同包内入口、helper、平台原语与生命周期相互依赖，一并提交。原生验收相关未勾选项继续保留，不将代码交付解释为 Windows 支持发布完成。


### 2026-09-08 原生实机增量

用户确认后，在 Windows 10 22H2 Administrator SSH 环境完成三包原生测试、真实 npm tgz 安装入口、ACL/CIM/进程树及受控 Task Scheduler 启停验证。修复 npm eval、环境大小写、账户 SID 归一化、私密 ACL 与 Windows 原子替换；业务协议不变。完整证据及 package integrity 见 `docs/testing/feishu-task-windows-native-acceptance.md`。Task 10 的 Windows 11 普通用户、真实业务闭环与登录/故障恢复门禁继续保留未完成。

### 2026-09-08 真实业务验收增量

在授权的 Windows 10 22H2 主机上完成 Bot/用户 OAuth、真实 Codex ACP 与普通文本任务闭环；成功任务为 `c32c432b-1907-4e44-949f-ee59abf90858`（17×23=391，飞书评论及 answered 日志交叉确认）。实测发现并限定修复 Windows CLI profile 格式、CIM 竞态、acpx argv/长提示词 stdin、输入失败清理和旧进程 journal 恢复。最终 ACP 原生 186 通过/4平台跳过，Task Agent 原生250通过/13平台跳过。细节与包哈希见验收记录。Task 10 保留未完成：Owner 补充、附件及扩展业务矩阵、Windows 11 普通用户等门禁未因普通任务成功而勾选。

### 2026-09-08 Win10补测增量

新建独立Bot并完成用户OAuth，空状态安装自动保存绑定及启动成功；新任务因Windows IM状态原子替换EPERM中断，尚不判业务通过。已复用现有Windows renameAtomic补接遗漏路径，并将ACP周期CIM采样改为有界异步single-flight。ACP原生197项（193通过、4平台跳过），IM原子替换专项原生9/9；本地Feishu Bridge108/108。具体失败链、性能对照及包哈希见验收记录。真实恢复、其余业务、生命周期和Win11门禁仍保持未完成。

修复包恢复后，新Bot普通计算527、Owner补充继续493、父子计算48及单次提醒133均已由飞书服务端结果/状态和Bridge日志交叉确认。附件场景返回runner pipe-in超时，未生成产物，仍为失败。Task 10不整体勾选，Win11及生命周期矩阵仍待验收。代码本地提交0a70b18，未推送/发布。

### 2026-09-08 附件阻塞定位增量

已用独立Codex sandbox探针定位SSH Session0的runner失败，同用户Interactive/Limited Session1成功；同profile的DPAPI凭证也只有Session1可用。沿用现有后台restart模式，实际CSV读取/求和/写入成功。随后真实上传发现Windows路径被展示文本转义规则损坏，已仅修复win32 file_delivery.path，原生4项红绿验证及全套112/112通过。完整附件交付仍以验收记录的最终服务端回读为准，不提前勾选Task10。

附件最终已通过：交互会话后台模式下实际生成并上传result.csv，服务端重新下载确认WIN10-ROUNDTRIP-9821/49，任务done，交付日志succeeded；Windows路径修复提交51950e5。SSH Session0限制和启动口径已写入包README。该结果解除附件专项阻塞，Task10整体仍受Windows11及其他未执行矩阵约束。

## 2026-09-08 非 Win11 补测进展

已推送开发分支，Draft PR https://github.com/ILUO/aamp/pull/1，未合并或 npm 发布。`4f00ce2` 三平台 × Node 22/24 六组 CI 全绿；后续 Windows CIM 元数据修复正在复跑最新提交，不能把旧绿代替最新结果。Win10 Node 24 三包原生测试、真实重复任务两实例、中文/CRLF 附件下载核验、50 MiB 出站边界、特殊目录原生 Codex sandbox、controller 崩溃清理和同 worker 自动恢复均已取得证据。非法更新保持旧服务与包，合法更新保留 bindings 通过；更新后 Node 24 业务、卸载收尾仍在执行。锁屏与注销/重新登录待云控制台可恢复登录条件，Win11 普通用户仍为独立门禁。具体失败、修复、任务 ID、计数与 artifact 边界统一见验收记录的顶部汇总和最新补测小节，不整体勾选 Task 10。

最新增量：`e989ec6` 的 CI run 34227906679 六组全绿；Windows 锁预算排除 ACL 初始化耗时，原生绑定测试 20/20。真实 Node 24 更新后后台仍有持续 CIM 缺路径，任务 `6015d748-78f3-4613-a868-339aa4c5171a` 尚未取得结果；卸载仍待收尾。

最终业务增量：`32af180` 六组 CI 全绿，Win10 Node 24 实际 controller 13336 ready；专用更新后任务 `6015d748-78f3-4613-a868-339aa4c5171a` 已 ACK、结果 361、服务端 done、ACP completed。此前 CIM/锁/PATH 失败保留为历史证据，不再作为当前业务阻塞。最终卸载与登录会话门禁独立跟踪。

收尾：Win10 隔离安装已完成正常 stop、计划任务移除与 npm 卸载，绑定字节保留、受管 Node 为 0、三旁观进程存活。剩余实机门禁明确为锁屏/注销重新登录（需云控制台配合）及 Win11 普通用户；受控异常测试与实际租户/网络/企业策略改动分开表述。


### 2026-09-10 Win11/AIME 本地矩阵收尾

| 用例 | 最终本地状态 | 证据与范围 |
|---|---|---|
| A01 | PASS | Win11 Pro 26200 x64，普通用户中完整性 Session1，PowerShell5.1；Node22.22.2/24.19.0，AIME真实入口/认证/ACP探针；正常扫描后由用户选择。 |
| A02 | 部分通过 / 文件UNSUPPORTED | 实际产品 Windows wrapper 在 Node22/24 均创建会话、收到运行中输出后取消、返回 cancelled、退出0；计算由真实任务证明。AIME远程运行不支持本机文件，不能判文件交付通过。 |
| A03 | PASS（Windows本地） | 3930c5a三包测试/类型/pack/安装入口见前文；d626d3c仅改Task Agent，其Node22/24全量各298项、283通过、15平台跳过、0失败，sync及pack退出0。最新跨平台CI另列。 |
| B01 | PASS | 专用新Bot、OAuth、正常选择AIME；391及Owner继续361，ACK/结果/完成。 |
| B02 | PASS | 缺输入经后台重启、真实第二账号拒绝、Owner补充N=11后407/done。 |
| B03 | PASS | 父子任务84/104/188，服务端全部done。 |
| B04 | PASS | 单次203、每日重复两实例217；第二实例提前due加速，非24小时耐久测试；后继重复已清理。 |
| B05 | BOUNDARY_PASS / UNSUPPORTED | 真实中文CSV附件在远程AIME派发前拒绝；不冒充本机读取/产物上传通过。负例任务保留待确认，未执行可选远端关闭。 |
| B06 | 部分通过 / 输出UNSUPPORTED | 中文、空格、&和括号目录实际安装入口退出0；中文CRLF输入上传。远程AIME本机输出能力不支持。 |
| B07 | PASS（受控API） | 实际NTFS文件52,428,799/52,428,800字节上传一次，52,428,801字节上传前拒绝；没有执行三次真实云大文件传输。 |
| C01 | PASS | 后台启动终端退出后，真实B03任务完成。 |
| C02 | PASS | 用户保持锁屏从手机发47×19，事件处理区间位于两次WTS锁屏观测之间，893/done；首次43×17不计锁屏证据。 |
| C03 | USER_SKIPPED | 用户明确要求跳过注销；没有实际注销/重新登录。 |
| C04 | PASS / 登录部分USER_SKIPPED | 正常stop禁用任务且旧进程消失；显式start恢复enabled/ready并保留绑定；首次准备超时保留历史。实际登录触发未验。 |
| C05 | PASS（含历史首次超时） | 真实controller故障后第二次重试恢复，后续901/done；独立原生worker三次默认60秒重试耗尽退出23、等待中stop及旁观进程存活。 |
| C06 | PASS（修复后复测） | 非法包stop前拒绝；dev8首次恢复失败保留；d626d3c的dev9正常update退出0、ready、绑定未变、实际安装controller与源码哈希一致，随后793/done。 |
| C07 | PASS | 三个隔离prefix卸载退出0；所属计划任务和入口均移除；最新复核受管进程0、测试registry进程0、绑定哈希未变、原Coco身份存活。 |
| D01 | PASS（受控） | 缺CLI、登录/权限、网络错误、ACL失败的关闭/提示/重试断言；没有实际撤权、拔网或修改企业策略。 |
| D02 | PASS（分层证据） | 身份/CIM/PID重用/旧generation/外部用户为受控断言；真实原生故障清理与旁观者保护另有证据。Node22/24多绑定集合及generation就绪探针通过，非真实第二Bot并行业务。 |
| CI | PASS | 提交111f154（包含产品修复d626d3c）的[run34471995377](https://github.com/ILUO/aamp/actions/runs/34471995377)六个job全部Success；三包测试/类型/pack及两组Windows打包入口逐项核验通过。后续仅文档变化不冒充新产品代码。 |
| 交付 | 已同步 | 产品/验收已推送；PR描述及飞书摘要revision28已写入并回读。最终CI证据补充在本节；保持Draft，未合并或npm发布。 |

最终隔离安装已卸载；保留绑定及证据。C06更新后793/done及C07独立现场复核通过；d626d3c本地Task Agent在Node22/24各283通过、15跳过、0失败。间歇AIME准备超时历史保留，不宣称根因已消除。Task10整体仍未完成，具体证据以验收记录顶部和最后一节为准。


授权推送后：111f154对应run34471995377六组CI已核对success，本次仅追加文档，产品源码与该运行一致。用户注销跳过和AIME文件能力不支持仍单独记录。PR描述与飞书摘要revision28已同步回读；未合并或npm发布。


最终同步回读：PR1保持open/Draft，正文包含实际通过的run34471995377；飞书摘要revision28包含同一产品与CI证据。Task10按用户指定AIME完成全部可执行矩阵与交付，A02/B05/B06本机文件为UNSUPPORTED、C03/C04实际注销登录为USER_SKIPPED；这些状态没有被改成PASS。没有其他已知未执行的本轮适用用例。
