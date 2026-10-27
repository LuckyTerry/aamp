# 飞书任务 AAMP Windows 原生支持设计与选型

> 本文持有设计约束与选型。详细执行顺序、测试命令和任务进度统一见 [执行计划](../plans/2026-09-07-aamp-feishu-task-windows-native-execution.md)。实现已开始；Windows 实机及发布验收状态见 [验收记录](../../testing/feishu-task-windows-native-acceptance.md)。

**Goal:** 在 Windows 原生环境中完成现有飞书任务 Agent 的安装、绑定、运行、停止、日志与卸载流程，保持现有飞书任务业务语义。

**Architecture:** 复用现有 Node Controller、Feishu Bridge 与 ACP Bridge，只在操作系统边界增加 Windows 实现。Windows 使用 Node CLI 入口和当前用户计划任务；macOS/Linux 继续使用现有 Bootstrap 和运行方式。任务事件、AAMP 协议、结果契约和业务鉴权规则保持原样。

**Tech Stack:** Node.js、现有 TypeScript/ESM 包、Windows PowerShell 5.1、Windows Task Scheduler、CIM、现有 npm 发布链。

**Revision:** 2026-09-07，根据 macOS/Windows 兼容方案调研更新组件选择与实施约束；已按后续授权进入实现，原生实机验收按用户指示延期。

**Structure:** 本文 §1–§8 为设计规格，§9 为实施领域映射，§10–§12 为验收与交付约束；实际勾选只维护执行计划。

## Global Constraints

- 基线：`ILUO/aamp`，`fix/feishu-auth-scope-negotiation`，提交 `7c4b7ff50b2fc766f9076dcbc7d87ce910ca8b76`。
- 只增加 Windows 原生运行所必需的平台适配；不修复已知跨平台业务缺陷。
- 不要求 WSL、Git Bash、MSYS2、Cygwin、Docker、管理员权限或飞书桌面端常驻。
- 保持 `bindings-v1.json` 的业务 schema、Agent 类型名、Task/IM scopes、Sender Policy、配对规则、结果格式不变。
- 保持 macOS/Linux 原有命令行为；不增加 Linux 后台服务，不重写完整 Bash Bootstrap。
- Windows 默认使用用户登录态后台运行；保留 `start --foreground`。不提供未登录运行、系统级 Windows Service 或远程部署。
- 不新增 Agent 产品或协议适配器；仅适配已有 Agent 的 Windows 原生入口。
- 默认不新增进程执行依赖；仅按 §3.3 的实测缺口局部采用 cross-spawn。不迁移 CLI 框架，不引入 PM2、Electron、Tauri、WinSW、Go/Rust 宿主或自包含安装包。
- 本文所有 `packages/**` 和 `.github/**` 路径均属于 AAMP 仓库；存放本文的聚合仓不承担实现。
- 按用户后续指定，直接使用当前 AAMP checkout 的 `feat/feishu-task-windows-native` 分支，不另建 worktree。重新核验分支与包版本，若已有 Windows 适配先缩减本方案。

## 1. 交付范围与支持口径

### 1.1 Windows 基线

首批支持与验收基线为 Windows 11 x64、Windows PowerShell 5.1、Node.js 22/24。PowerShell 7 作为额外运行壳验证，不作为安装前提。这里的 Node 版本是 Windows 验收矩阵，不顺带提高其他平台的版本下限或全局升级用户 Node。

Windows 10、ARM64、Windows Server、受企业策略禁止计划任务/PowerShell 执行的设备不计入首批后台支持承诺。对不满足条件的设备给出具体前置缺失；不得显示绑定已正常后台运行。

原生含义：Controller、Feishu Bridge、ACP Bridge 以及本地 Agent 都运行在 Windows 进程中；安装和执行过程不借用 Linux 子系统或 Unix 模拟工具。

### 1.2 用户命令

增加 Node bin dispatcher，npm 自动生成 Windows `.cmd` shim；PowerShell 文档显式写 `.cmd`，避免优先选择 npm 的 `.ps1` shim。安装示例中的版本由实际发布版本填入，不能提前承诺现有 `dev.6` 已支持：

```powershell
# 初次安装后，使用 npm 输出的实际全局 bin 路径；不强制修改系统 PATH。
npm.cmd install --global @larktask/aamp-feishu-task-agent@<windows-release-version>
feishu-task-agent.cmd install
feishu-task-agent.cmd status
feishu-task-agent.cmd list
feishu-task-agent.cmd start
feishu-task-agent.cmd start --foreground
feishu-task-agent.cmd stop
feishu-task-agent.cmd restart
feishu-task-agent.cmd logs
feishu-task-agent.cmd add
feishu-task-agent.cmd remove
feishu-task-agent.cmd update
aamp-logs.cmd collect --task-id <aamp-task-id>
```

- `install`：注册/选择 Bot、处理原有授权、选择原生 Agent、保存绑定、真实配对、检查 readiness，再交给计划任务运行。
- `add`：沿用指定分支代码，只保存 pending 绑定；下次 `start` 生效。不借本次适配实现文档声称的自动启动。
- `remove`：只移除本地绑定，不新增远端注销副作用；已运行进程处理方式与现有逻辑一致。
- `stop`：停用本产品的登录触发并停止本用户运行实例；再次登录不会自行启动，直到显式 `start`。
- `update`：更新产品包，不扩展为通用工具升级器。运行中被占用的产品版本先安全停止再切换；保留绑定。
- 卸载采用 `stop` 后显式注销本产品计划任务、npm 卸载、可选备份本产品状态的文档步骤；不新增远端 Agent 注销、不删除整棵其他工具状态。

### 1.3 Agent 支持边界

| 现有 Agent | Windows 本次处理 | 验收口径 |
|---|---|---|
| Codex | 必须完成 Windows CLI → 现有 Codex ACP 包 → AAMP 全链路；优先 CLI，不依赖猜测桌面安装路径 | Windows 支持发布的必过项 |
| Cursor、Trae 系列 | 只接已有 Windows 原生 CLI/ACP 命令；保留既有 Agent 类型、版本及登录判定 | 通过原生探测和无业务副作用 ACP 探针后才出现在可选列表 |
| WorkBuddy / WorkBuddy AI | 移除 Windows 路径上的 macOS 探测依赖；使用实际安装元数据/已公开 CLI 入口确认位置 | 找不到受支持的原生入口则不可选，不猜安装路径，不新增 Agent 协议 |
| AIME | 保留租户门禁、remote 标记、附件限制和并发限制；核验现有 adapter 及其 CLI 依赖是否可在 Windows 运行 | 上游不能原生运行时明确不可用，不为此移植 AIME 服务端或新建 adapter |

不把“Windows 支持”解释成所有第三方 Agent 自动获得 Windows 版本。交付清单逐个列出实测通过的 Agent；不能在实现中默默将未适配 Agent 映射为 Codex。

### 1.4 兼容路线选型与依据

本次采用“Node.js 共用业务逻辑 + 必要平台适配 + 系统原生后台托管”。命令执行、后台托管、安装分发分别选型；框架提供其中一层能力，不代表消除了 Bash 依赖或外部 Agent 的平台限制。以下为适用性判断，不代表市场占有率排名。

| 路线 | 成熟方案及能力 | 本次决策 |
|---|---|---|
| 跨平台命令执行 | cross-spawn 处理 Windows shim、命令解析和参数；Execa 提供更完整的子进程编排 | 优先复用现有启动器；有实测缺口才局部采用 cross-spawn，不全量迁移 Execa |
| 用户登录后后台运行 | macOS LaunchAgent；Windows Task Scheduler 交互用户身份及失败重启 | 保留现有 LaunchAgent，新增当前用户计划任务；具体生命周期仍按各平台验证 |
| 无用户登录的系统服务 | Windows Service / WinSW | 不采用；当前需求使用用户配置与授权，不增加服务账户、提权和 Session 0 适配 |
| 通用进程管理 | PM2 管理进程和日志，但官方 Windows startup 另指向外部安装方案 | 不采用；避免在已有 Controller 和系统托管之间增加管理层 |
| 桌面封装 | Electron、Tauri 提供桌面 UI、登录启动或更新等能力 | 不采用；本次没有桌面 UI 需求，底层 Bash/CLI 适配仍需完成 |
| 自包含分发 | oclif 可附带 Node 并生成安装包；Node SEA 可打包可执行程序 | 保留 npm；不迁移 oclif、不增加 SEA 或 MSI/EXE/PKG 打包链 |
| 原生宿主 | Go/Rust 可按平台构建本地程序 | 不采用；已有 Node 核心可复用，没有迁移语言的必要 |

官方依据（2026-09-07 调研）：

- [cross-spawn](https://github.com/moxystudio/node-cross-spawn)、[Execa Windows 支持](https://github.com/sindresorhus/execa/blob/main/docs/windows.md)。依赖选择不能代替真实 Windows argv/退出测试。
- [Apple LaunchAgent](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)、[Task Scheduler 登录身份](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/ne-taskschd-task_logon_type)、[失败重启](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-restartonfailure-settingstype-element)。InteractiveToken 要求用户已经登录；本方案不承诺未登录运行。
- [WinSW](https://github.com/winsw/winsw)、[Windows Session 0 限制](https://learn.microsoft.com/en-us/windows/win32/services/interactive-services)、[PM2 startup](https://pm2.keymetrics.io/docs/usage/startup/)。系统服务和用户会话后台是不同的部署模型。
- [Electron 登录启动接口](https://www.electronjs.org/docs/latest/api/app)、[Tauri sidecar](https://v2.tauri.app/develop/sidecar/)。桌面封装不解决外部 CLI 的操作系统兼容问题。
- [oclif 分发](https://oclif.io/docs/releasing/)、[Node SEA](https://nodejs.org/api/single-executable-applications.html)。自包含分发属于后续独立需求，不能成为本次 Windows 发布前提。

## 2. 已核实的 Windows 阻断点

| 位置（基线行号） | 当前行为 | 最小适配 |
|---|---|---|
| `aamp-feishu-task-agent/package.json` | bin 指向 Bash 脚本 | 增加 Node dispatcher；非 Windows 转发现有脚本 |
| `bin/feishu-task-agent-controller.mjs:181` | 打开 `/dev/tty` | Windows 使用原生交互 stdio；不走管道安装入口 |
| 同文件 `:1310–1400` | `spawn('bash')`，FD 3/4 返回内部 JSON | Windows Node helper + IPC；POSIX 保留原协议 |
| `bootstrap/*.sh:4979–5095` | 发现、注册、准备 Agent、profile 检查依赖 shell | 只迁移这五个被 Controller 调用的 helper 行为 |
| `bin/launchd-service.mjs:111` | `/bin/ps` 查询进程身份 | Windows CIM 查询创建时间、命令和所有者 |
| Controller `:3497–3610` | 仅 macOS 后台运行 | 新增 Windows 用户计划任务后端 |
| `bin/runtime-package-executable.mjs` | 已有 `.cmd`、PATHEXT、Path 合并适配 | 复用已有行为，不再实现第二套一般 shell 转义 |
| `aamp-acp-bridge/src/acpx-client.ts:432` | 直接 spawn `acpx`/`npx` | Windows 解析真实 Node 入口或受控 `.cmd` 启动 |
| 同文件 `:597` | Windows 只 kill 根进程 | 精确处理属于本次运行的子进程树 |
| `aamp-feishu-bridge/src/feishu-cli.ts:60` | execFile/spawn CLI，可能落到 `.cmd` | Windows CLI 入口适配，不改变身份和接口参数 |
| `aamp-feishu-bridge/src/task/dispatch.ts:237` | prompt 强制 `unset; env -u` Bash 前缀 | 仅 Windows 渲染为 PowerShell 可执行命令 |
| `bin/aamp-logs.mjs:364,456` | 外部 `tar` / `tail` | Windows 使用自带 `tar.exe`；tail 用 Node 文件读取 |
| private JSON 写入 | POSIX chmod/umask | Windows 当前用户 ACL，保留既有凭证存储模型 |

Node 官方说明 `.cmd/.bat` 不能像原生 executable 一样直接 `execFile`，并且 Windows 环境变量键不区分大小写。这是必须覆盖整条子进程链的原因，而不仅是把 `npm` 改成 `npm.cmd`。[Node 文档](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows)

## 3. 平台边界设计

### 3.1 入口和五个 helper

新增 `bin/feishu-task-agent.mjs`：

```javascript
if (process.platform === 'win32') {
  await runWindowsEntry(process.argv.slice(2));
} else {
  // 保留既有 flags、无参数 help/install 区别、退出码和信号转发。
  await runExistingBootstrap(process.argv.slice(2));
}
```

`runExistingBootstrap` 是本次 Node bin dispatcher 内的小函数，不重写 shell 启动流程。用户已有直接执行 Bash Bootstrap 的入口仍保留。

Windows helper 仅支持现有五个内部动作，输入输出字段不扩展业务含义：

| action | 输入 | 输出 |
|---|---|---|
| `__discover-agents` | 原有 agent/host 与环境 | `{ agents: string[] }` |
| `__register-binding` | 原有注册上下文 | `{ app_id, app_secret, display_name, tenant_brand, tenant_key, lark_cli_profile, auth_mode }` |
| `__prepare-agent` | binding/agent/host | `{ agent_type, acp_command, lark_cli_config_dir? }` 或既有 cancelled 结果 |
| `__probe-profile` | 完整 binding，通过私有 IPC | `{ ready, lark_cli_bin?, lark_cli_config_dir? }` |
| `__ensure-profile` | 完整 binding，通过私有 IPC | `{ lark_cli_bin, lark_cli_config_dir }` |

使用 `fork()` 的 IPC 消息传入 binding 并返回结果，stdout/stderr 只承载交互及已有脱敏日志；不把 app secret 写入 argv。既有 FD 3/4 协议依赖 Bash 重定向，本方案直接使用 Node 支持的 `process.send()`/`message` 通道，不把 POSIX 描述符假设带入 Windows。此处不声称 Windows 一概不支持额外 pipe。[Node IPC 文档](https://nodejs.org/api/child_process.html#optionsstdio)

Windows helper 的人工交互使用继承的控制台 stdio；`__service-run` 必须非交互，缺授权时退出并提示前台处理，不能后台悬挂等待输入。Ctrl+C 中断当前 helper 并退出本次流程，保留既有 pending 绑定语义。

### 3.2 共享数据只有一个 owner

从现有 Bootstrap 原样提取 `bootstrap/task-agent-defaults.json`，仅存当前已存在的包名/固定版本、scope manifest v2、事件名和用户授权默认值。Windows 直接读取；Bash 的独立下载入口必须保留自包含能力，因此通过 `scripts/sync-bootstrap-defaults.mjs` 在维护/打包时生成原位置的内嵌默认值块，不能运行时要求用户先下载旁路 JSON。生成块禁止手改，CI 检查与唯一 JSON 来源一致；不顺带改变其中的值或把全部环境配置集中化。

现有 shell 内嵌 `registerApp` Node 代码可提取为 `bootstrap/register-feishu-app.mjs`，分别用原有 FD 输出包装与 Windows IPC 包装调用。保持原有 SDK materialize 步骤，将该模块放到已准备 SDK 的 helper 工作目录后执行，避免模块解析到错误版本。独立 Bash 入口先完成既有产品包安装，再定位包内 helper；行为相同，包括品牌解析、应用名、scope、事件和错误处理。此提取仅用于避免 Windows 再维护一套注册逻辑，不改注册 API。

其余 shell 安装、登录、profile 行为按五个接口在 Windows helper 实现；共同结果由契约测试钉住，不要求将数千行 Bash 全部迁移成 Node。

### 3.3 子进程启动

优先级：已核验原生 `.exe` → 当前安装包的真实 `.js/.mjs` bin 配合 `process.execPath` → 必要时通过已有 `.cmd` launcher。

- npm 自身优先定位实际 `npm-cli.js`，通过 Node 执行，避免 bootstrap 阶段就需要另一层 cmd 转义。
- 已有 `runtime-package-executable.mjs` 的解析、包身份绑定、Path 合并和 `.cmd` 转义继续作为 Controller 的唯一实现。
- Feishu/ACP 包独立发布，不得从其他包的源码相对路径 import 私有 helper。可在各包内使用其真实 Node bin，只有确实需要 `.cmd` 的入口增加局部调用封装，并共享同一组黑盒 argv 测试数据；不为此新建通用运行时包。
- 禁止将所有 spawn 改成 `shell:true`；prompt、任务内容、令牌均通过原有 stdin/IPC/环境数据传递，不能拼入 shell 字符串。
- PATH 键按 Windows 不区分大小写处理，保留原有代理和环境选择策略；路径使用 `path.delimiter`，不拼 Unix 系统目录。

组件复用决策顺序：

1. 先在原生 Windows 对现有启动器、Feishu CLI 和 ACP 链路运行同一组 argv/退出测试，定位实际失败入口；现有实现通过则直接保留。
2. 对失败入口先尝试真实 Node bin 或原生 executable。必须保留包身份校验、固定版本、环境合并和原始退出码，不仅检查“进程启动成功”。
3. 仍必须调用 shim 且现有封装无法覆盖时，允许在受影响包中局部引入 cross-spawn；先记录失败用例，再以同一用例验证替换结果。使用与现有 Node/ESM 兼容的已核验版本并锁定依赖，不顺带升级其他包。
4. cross-spawn 仅承担必要的命令启动，不替代包解析与身份校验；不在 Controller 中并存两套一般转义实现，不复制新的自制 cmd 转义到各 Bridge，也不为统一风格迁移已通过的调用。
5. 不引入 Execa 全量重构或新通用平台包。若以上路径均不能通过原生测试，记录具体上游限制，重新评估该入口，不以新增框架掩盖失败。

## 4. Windows 原生 Agent 执行

### 4.1 发现和探针

在 Windows 路径中使用 PATH/PATHEXT 与已核验的安装元数据，识别 `.exe/.cmd`；不能要求用户复制 `where.exe` 为 `which.exe`。已有 resolver 支持 Windows candidate 的部分直接复用。

每个候选依次验证：真实文件存在 → 版本命令退出成功 → 原生 ACP session 创建/关闭成功。探针不能发送会修改工作区的业务 prompt。登录需要交互时返回前台登录步骤；不调整 Agent 原有审批策略。

### 4.2 消除 `env CODEX_PATH=... npx ...`

保持既有 `acp_command` 字符串兼容。Windows 为当前 Agent 生成固定 Node wrapper 和同目录配置：wrapper 读取固定 executable/args/env，用 `spawn(command, args, { shell:false })` 启动真实 ACP 入口，透传 stdin/stdout/stderr 与退出码。

Codex wrapper 设置既有 `CODEX_PATH`，调用锁定的 Codex ACP 包实际入口；不升级到另一套 adapter。命令只有受信任的 Node 和 wrapper 路径，不包含业务 prompt、密钥或 shell 内联 env 语法。

wrapper 写在当前 Agent runtime 目录，路径含空格、中文、单引号、`&`、括号时也要能通过 acpx 的 `--agent` 解析。若锁定 acpx 不支持该表达，先验证其原生配置方式；不能用未经验证的引号拼接宣称完成。所有 wrapper 都只用于原有 Agent 入口适配，不新增 Agent 类型。

### 4.3 任务 prompt 中的命令

Windows 分支仅替换 `renderFeishuLarkCliProfileRules()` 中平台相关示例：

```powershell
& '<resolved-lark-cli>' --profile '<existing-profile>' auth status --json
```

使用 PowerShell 单引号转义：内部 `'` 写成 `''`。CLI 为 `.cmd` 时复用其真实 Node bin或经过验证的调用方法。原有 Bash 导出函数清理由启动前对 child env 的 Windows 局部处理完成；不再向 Windows Agent 强制发送 `unset`/`env -u`。

渲染平台取当前本地运行时，不新增 AAMP Header 或任务字段；remote/AIME 提示词保持原样。授权规则、结果 JSON、交付优先级、Owner 规则以及 Agent 执行审批选项都不改变。

## 5. 注册、凭证、文件和终端

- Windows 沿用应用注册、用户 profile、品牌/租户获取三步及原有失败语义。保留 optional/required/disabled 授权模式；不把用户授权“全部改为必需”，不为读取文档补新 scopes。
- SDK 的 `registerApp` 版本、lark-cli 版本下限和包覆盖策略沿用基线。发布前核验原生 Windows artifact；上游 artifact 缺失时视为发布阻断，不能静默降级到 WSL。
- 授权页通过固定 PowerShell 命令接收环境变量中的 HTTPS URL 后调用 `Start-Process`；不把含 `&` 的 URL直接拼入 `cmd /c start`。打开失败仍打印原始链接和既有有效期；不强改系统浏览器。
- Windows CLI 使用 `os.homedir()` 和既有目录后缀推导状态位置；不写死盘符或用户目录。独立传递 `LARKSUITE_CLI_CONFIG_DIR`，沿用绑定的 exact profile。
- NTFS ACL 对包含 binding、token、mailbox、pairing 和运行配置的产品私有目录限制为当前用户以及必要的 SYSTEM/Administrators；禁用不适当的继承后核验 ACL。POSIX `chmod 0600` 不当作 Windows 隔离成功证据。[ACL 参考](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/icacls)
- 保持凭证当前存储模型，不新增 DPAPI、Credential Manager 或凭证迁移专项；不修改 lark-cli 自身的加密后端。
- JSON 使用 UTF-8 无 BOM；命令输出显式 UTF-8，正确处理多字节分片和 CRLF，不能全局替换业务正文换行。
- Windows 原子文件替换只对共享占用引起的 `EPERM/EACCES/EBUSY` 做短有界重试（5 次，间隔 100/200/400/800/1600ms）；始终保留旧文件直至替换成功，不先 unlink 旧绑定。保持原有配置锁。
- 安装入口直接在 PowerShell 执行 npm 命令，不用管道把脚本交给解释器后再读键盘；非 TTY 的 `install/add` 给出明确错误，`status/list/logs` 可重定向。

## 6. Windows 后台与进程生命周期

### 6.1 后台方案

新增 `windows-service.mjs`，适配现有 Controller 使用的 service 操作，不重构 `launchd-service.mjs`。Windows 计划任务使用当前 SID 的唯一任务名，登录触发，`Interactive` logon type、普通权限，不保存 Windows 登录密码。

这里的 `service` 文件名沿用 Controller 后台操作的命名，实际后端是 Task Scheduler，不注册 Windows SCM Service。关闭终端后继续运行与注销用户后继续运行是不同要求；本次只交付前者及下次登录启动。不使用 S4U 绕过登录条件：其网络/加密文件访问限制不适合当前链路。

配置采用固定 PowerShell 程序体和 JSON 输入，用 ScheduledTasks API 创建：

```powershell
$principal = New-ScheduledTaskPrincipal -UserId $config.sid -LogonType Interactive -RunLevel Limited
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $config.sid
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
```

action 指向已安装 Node 的稳定 `node.exe` 路径 + 产品 `windows-service-worker.mjs`（不捆绑新的 Node 发行版），不是 npx 缓存临时路径。计划任务不带凭证和 pairing URL；worker 从私有目录读取选择与环境快照，用独立日志 stdio 启动现有 `__service-run`。

不设置系统 ExecutionPolicy，不使用永久 bypass；若企业策略阻止调用系统计划任务接口，明确后台前置不满足，保留显式 `--foreground`，不自动报成功。

状态文件放在既有 runtime 内的 `windows-service-v1` 子目录，沿用 selection/readiness 的 generation、binding IDs 语义。Windows 增加本地进程创建时间校验，既有 binding schema 不变。

Scheduler “Running”不足以表示业务 ready。必须同时满足：任务属于当前 SID、worker/controller 仍为预期进程、generation 匹配、选中 bindings 一致、现有 Bridge readiness 已完成。登录后自动运行只承诺用户会话存在时；断网恢复不增加新业务对账逻辑。

三次、间隔一分钟的故障重启只作用于 Windows 宿主进程；耗尽后 status 显示退出原因，用户修复后 restart。不得将其描述为无限自愈或任务级重试。[Principal 参考](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtaskprincipal?view=windowsserver2025-ps)、[Settings 参考](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasksettingsset?view=windowsserver2025-ps)

### 6.2 stop 与进程身份

通过 `Get-CimInstance Win32_Process` 获取 PID、ParentProcessId、CreationDate、CommandLine、ExecutablePath；通过 GetOwnerSid 校验用户。正常 stop 使用私有 runtime 目录中的停止请求（含 generation）；Controller Windows 分支监听请求，调用现有 shutdown 流程。

不能把 Windows `child.kill('SIGTERM')` 当作 Unix 可捕获的优雅退出通知。停止请求负责协作关闭，超时后再清理已核验进程树；引入进程执行库也不能省略该语义。[Execa 跨平台退出说明](https://github.com/sindresorhus/execa/blob/main/docs/termination.md)

停止顺序：停用登录触发 → 发送本 generation 的停止请求 → 等待已有关闭逻辑最多 10 秒 → 重查 PID/创建时间/路径/SID → 只对核验后的根进程执行 `taskkill /PID <pid> /T /F` → 读取确认退出 → 清除本实例 lease。Windows API 无法保证纯 PID 操作绝对无竞态，身份校验失败时停止清理，不按进程名兜底。

Controller 内多个 Bridge 的 stop/超时退出也要覆盖子进程树；不能只杀 cmd 或 npx 留下 ACP/Agent。父进程被强制结束的清理需记录子进程身份并在下一次 start 校验后清理本次遗留；不引入全局 node 清扫器，不新增跨平台可靠性协议。

`stop` 只控制本产品宿主；不等价于新增飞书任务取消语义。强制停止时沿用原有在途任务中断限制。[进程身份参考](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process)、[taskkill 参考](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill)

## 7. 日志、文件交付与发布

- `logs` 读取本产品已有日志；Windows 的 `aamp-logs tail -f` 用 Node 轮询读取文件 offset，处理截断/轮转和 Ctrl+C，不依赖 `tail.exe`。
- `collect` 保留 `.tar.gz` 格式和原有脱敏/筛选规则，Windows 用绝对系统路径 `tar.exe`，安装前置检查可执行；输出目录优先通过 Windows Desktop Known Folder 解析，覆盖 OneDrive 重定向。不存在则使用当前产品日志目录并明确输出位置。
- 不引入另一套日志平台、不新增脱敏策略专项；不能将 profile 或原始凭证打入包。
- 本地文件交付验证 Windows `C:\...` 路径、中文/空格文件名和 CRLF 正文可上传；不放宽现有 50MB 限制，不顺带增加远端附件能力或网络盘支持承诺。
- 修改三个实际消费包时，发布其 Windows patch 版本并只更新必要的锁定引用。当前 Bootstrap 使用的 scope 与目录 package name 不一致，必须以真实发布 artifact 核对，不能只修改源码后默认用户安装到了它。
- SDK、AAMP 服务端、独立 deprecated Task Bridge不因这次 Windows 需求发版。

## 8. 文件级改动边界

| 文件/目录（相对 AAMP root） | 动作与职责 |
|---|---|
| `packages/aamp-feishu-task-agent/package.json` | bin dispatcher、打包清单、必要版本 |
| `.../bin/feishu-task-agent.mjs` | 新增 Windows/POSIX 入口分发 |
| `.../bootstrap/windows-entry.mjs` | 新增 Windows 安装、命令准备与 Controller 环境 |
| `.../bootstrap/windows-helper.mjs` | 新增五个内部动作、IPC 包装 |
| `.../bootstrap/register-feishu-app.mjs` | 从 Bash 原样提取注册 SDK 逻辑供两个平台使用 |
| `.../bootstrap/task-agent-defaults.json` | 提取当前所需版本与 scope 数据唯一来源 |
| `.../scripts/sync-bootstrap-defaults.mjs` | 生成/检查独立 Bash 入口的内嵌默认值块，保留自包含入口 |
| `.../bootstrap/aamp-feishu-task-agent-bootstrap.sh` | 仅接共享数据/注册 helper；其余流程保留 |
| `.../bin/windows-platform.mjs` | Windows 终端、进程身份、ACL、命令与 URL 适配 |
| `.../bin/windows-service.mjs` | Windows service backend 和计划任务配置 |
| `.../bin/windows-service-worker.mjs` | 稳定宿主入口，日志、环境、Controller 生命周期 |
| `.../bin/feishu-task-agent-controller.mjs` | Windows helper、terminal、service、stop 分发 |
| `.../bin/runtime-package-executable.mjs` | 原样复用优先；仅 Windows 实测证明的缺口可改 |
| `.../bin/aamp-logs.mjs` | Windows tail、tar、Desktop 处理 |
| `packages/aamp-acp-bridge/src/acpx-client.ts` | Windows acpx/npx 启动与进程树停止 |
| `.../src/agent-resolver.ts`、`.../src/discovery.ts` | 仅当前任务链路实际经过的 Windows 原生发现 |
| `packages/aamp-feishu-bridge/src/feishu-cli.ts` | Windows CLI 启动、浏览器打开 |
| `.../src/task/dispatch.ts` | 仅 Windows 命令示例渲染 |
| 上述三包对应 tests/锁文件/README | Windows 用例、必要依赖锁定、用户说明 |
| `.github/workflows/feishu-task-windows.yml` | 新增本次相关范围的 Windows CI，不重排已有流水线 |

`.../` 在此表只缩写上一行相同 package 前缀；实施任务使用完整路径。可增加同 package 内的局部 Windows helper 文件，不得新增通用平台框架。

明确禁止：修改 `task/runtime.ts` 的结果回写补偿、事件去重、状态定义、评论 Owner 规则、取消协议；修改 `sdks/**`、AAMP 服务端、飞书任务 Core；新增数据库、队列、服务框架；调整多 Agent 并发策略；借机实现 `add` 自动启动、自动远端注销、Linux systemd 或新版 UI。

## 9. 实施领域映射

详细步骤与唯一进度记录见 [执行计划](../plans/2026-09-07-aamp-feishu-task-windows-native-execution.md)。

| 设计范围 | 执行任务 |
|---|---|
| §3.3 现有启动器与组件复用 | Task 1、Task 5 |
| §3.1 入口与 helper | Task 2、Task 3 |
| §3.2 共享默认值与注册 | Task 3 |
| §5 文件、凭证、终端 | Task 2、Task 4 |
| §4 Agent 与提示词 | Task 5 |
| §6 后台及进程 | Task 6、Task 7 |
| §7 日志与包、§8 改动边界 | Task 8、Task 10 |
| §10–§11 验收与发布准备 | Task 9、Task 10 |

## 10. 必须通过的验收矩阵

| 类别 | 场景 | 判定 |
|---|---|---|
| 纯原生 | 不安装 WSL/Git Bash；PATH 中没有 sh/bash | 安装、配对、执行、停止全部成功 |
| 安装 | 全新普通用户；已有 Node/npm；产品未安装 | 不提权，生成可运行 `.cmd`，安装的实际包可追踪 |
| 字符 | 中文用户名、空格、`&`、括号、引号；Path/PATH 混合 | 不损坏 argv、不执行额外命令、不丢凭证路径 |
| 注册授权 | Feishu/Lark 品牌；optional/required/disabled；取消 | 原有 scopes/租户规则不变，无 secret 输出 |
| 普通任务 | Task → AAMP → Windows Codex → Bridge | 有 ACK、允许的步骤、结果和原有完成状态 |
| 人工介入 | need_help → Owner 评论 | 复用原会话，新 Task ID 行为不变 |
| 调度 | 带提醒/重复规则、子任务 | 沿用当前触发策略；不是本次新增调度能力 |
| 文件 | Windows 本地附件输入与产物输出 | 可读取/上传，原大小上限和 remote 限制保持 |
| 背景 | 关闭终端、重新登录、stop/start/restart | 预期运行、不重复、不残留本产品子进程 |
| 故障 | CLI 不存在、登录过期、网络断开、企业策略拒绝 | 原因明确，无假 ready，无全局清理 |
| 隔离 | 同用户多个绑定、另一个 Agent 正在运行 | 只管理本产品实例，保留现有共享/租约逻辑 |
| 更新卸载 | 更新运行包、停止后卸载 | 绑定可保留，无多余计划任务，无其他产品删除 |
| 回归 | macOS 全套现有测试、Linux 前台测试 | 原行为保留，原有问题单独记录 |

此前发现的业务缺陷不是此矩阵中可以默认为已修复的能力：进程崩溃后任务回写不对账、回写失败提前 handled、评论编辑去重、失败任务显示完成、飞书取消未下发等，都保留现状并单独标注，不扩大 Windows 改动。

## 11. 发布顺序与退出条件

1. 执行计划 Task 1–5 的原生 Windows 前台最小链路仍是发布门禁。用户后续明确要求先开发，因此允许后台代码与本地测试继续，实机门禁延期且不视为通过。
2. 执行计划 Task 6–7 完成后台生命周期，Task 8 完成真实包与用户操作，Task 9–10 收齐验证。
3. 只发布受影响 ACP/Feishu Bridge Windows patch，再更新 Task Agent 的精确依赖引用并发布 Task Agent；检查发布 scope，不能猜测拥有哪个 npm scope 权限。
4. 先用新安装实例验收，再验证已有 Windows 测试绑定的更新；POSIX 用户不自动切换新启动方式之外的业务配置。
5. 回滚只切回产品包与必要依赖版本、停止并清理本产品 Windows 计划任务；不注销飞书 Agent、不回滚用户任务数据。

方案完成不等于 Windows 支持完成。发布条件是 Windows 原生实机闭环和发布包验证通过，而不是在 macOS 上模拟 `process.platform='win32'` 的测试通过。

## 12. 方案自检

- §2 的入口、helper、TTY、命令、服务、进程、prompt、日志、权限，每项都映射到 §9 的实施任务。
- 对外 Task/AAMP schema 零变更，原有业务缺陷零修复，macOS/Linux 生命周期零增强。
- 共享抽取只限 Windows/POSIX 必须一致的 scope/版本数据与现有注册程序；没有整体 Bootstrap 重写。
- §1.4 的组件决策落实到执行计划 Task 1/5 的启动器复用验证、Task 6/7 的交互用户后台验证和 Task 8 的 npm 分发检查；若新增 cross-spawn，必须附对应的原生失败/通过证据，不进行全量进程框架迁移。
- 新后台 service、Windows ACL、进程树处理均是复现现有桌面可用性所必需的平台操作，不能扩成跨平台治理专项。
- 未验证的第三方 Windows CLI 由执行计划 Task 5 原生探针决定支持清单；不会凭静态猜测给出全 Agent 支持承诺。
- 本文以固定源码快照和官方 Windows/Node 文档制定；实现与本地验证已启动，未执行真实飞书授权、Windows 计划任务注册或 npm 发布。
