# 独立 CodeBuddy CLI 接入验收

开发分支：`fix/feishu-auth-scope-negotiation`，基于 `2b82c99`。

## 改动范围

- Task Agent 新增独立 `codebuddy` 类型。macOS、Windows 从 PATH 按 `codebuddy`、`cbc` 顺序寻找，只展示一个选项。
- 用户仍需在扫描结果中手动选择；与 WorkBuddy / WorkBuddy AI 分别展示、分别绑定。
- 使用选中 CLI 的原生 `--acp`，不注入桌面 WorkBuddy 配置目录，不自动安装、升级或登录。
- Windows 复用原生启动描述符；补充标准 npm shim 中无扩展名 Node 入口解析，校验 Node shebang 后通过 Node 运行，不执行批处理文本。
- 不修改 ACP Bridge、Feishu Bridge、任务协议、模型选择或桌面版认证机制。

## macOS 验证

- CodeBuddy CLI：`2.164.0`，独立入口 `/opt/homebrew/bin/codebuddy`，`cbc` 为同包别名。
- 直接 ACP 初始化和创建会话成功；实际计算 `17 × 23` 返回 `391`、`end_turn`、`SUCCESS`。
- Task Agent 实际发现：`codex, traex, workbuddy, codebuddy`。授权租户符合条件时另展示 AIME。
- 正常 add 菜单手动选择 codebuddy，保存 Bot `70-mac-codebuddy`，应用 `cli_aa434c2422f95bc2`。
- 前台仅选 CodeBuddy 启动 1/1 成功；完成真实任务闭环：
  - Task GUID：`41c6bebf-e09e-4389-9776-54ce2e20ab24`。
  - 16:05:43 收到任务，16:06:15 ACP Bridge `task.completed status=completed`。
  - Feishu Bridge 记录 `answered`；服务端读回任务 `status=done`、`agent_task_status=4`。
  - 服务端评论 `7694947521549880289`：`17 × 23 = 391`，计算过程 `17 × 20 = 340，17 × 3 = 51，340 + 51 = 391。`。
  - 本地证据目录：`~/.aamp/logs/runs/20261010T160400-94379/`。不提交原始日志、凭据。
- 后台仅选 CodeBuddy 启动成功（launchd，PID 5266），启动命令退出 0，`status` 确认为后台运行。第二轮真实任务闭环也通过：
  - Task GUID：`b1051686-908a-487c-adaa-13c5ea381355`。
  - 16:11:03 收到任务，16:13:43 ACP Bridge `task.completed status=completed`，约 160 秒。
  - 服务端评论 `7694949455037664436`：`29 × 31 = 899`，计算过程 `(30 − 1) × (30 + 1) = 30² − 1 = 899`。
  - 服务端读回 `status=done`、`agent_task_status=4`；Feishu Bridge 记录 `answered`。
  - 本地证据目录：`~/.aamp/logs/runs/20261010T160838-5266/`。
- 环境观察：本次 AAMP 通道曾出现 429 限流，未阻止上述任务最终完成。混合启动旧 WorkBuddy/Codex 时等待旧绑定准备；改为仅选 CodeBuddy 后，后台验证通过。前台 stop 两次先报进程未退出，随后进程检查确认已退出；本次不修改现有服务生命周期逻辑。
- 本地打包 helper 因无法解析当前 controller package pin 失败；本次用隔离缓存 `npm pack` 安装 Task Agent，未修改发布工具、未发布 npm。
- 完整 Task Agent 回归：595 pass / 0 fail / 24 skip。命令：

```sh
TMPDIR=/private/tmp node --test packages/aamp-feishu-task-agent/test/*.test.mjs
node packages/aamp-feishu-task-agent/scripts/sync-bootstrap-defaults.mjs --check
```

Windows 原生进程、ACL 等测试在 macOS 上跳过，不能替代 Windows 实机验收。

## Windows 手动验收（待执行）

前提：原生 PowerShell、Node/npm 已就绪；已安装并在终端登录独立 CodeBuddy CLI，确认能完成简单对话。建议普通用户执行。

在仓库根目录拉取开发分支后运行：

```powershell
git fetch origin
git switch fix/feishu-auth-scope-negotiation
git pull --ff-only
node packages/aamp-feishu-task-agent/scripts/run-platform-tests.mjs
```

安装本地包，避免误测 npm 上尚未包含本次改动的版本：

```powershell
$artifactDir = Join-Path $env:TEMP 'aamp-codebuddy-acceptance'
New-Item -ItemType Directory -Force $artifactDir | Out-Null
$packed = npm.cmd pack ./packages/aamp-feishu-task-agent --pack-destination $artifactDir --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'npm pack failed' }
npm.cmd install --global (Join-Path $artifactDir $packed[0].filename)
if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
$launcher = Join-Path (npm.cmd prefix --global) 'feishu-task-agent.cmd'
$env:AAMP_TASK_AUTO_UPDATE = 'false'
& $launcher stop
& $launcher add
& $launcher status
```

`AAMP_TASK_AUTO_UPDATE=false` 只作用于当前 PowerShell 会话，防止测试期间被远端包覆盖。此次未发布 npm / 未更新版本号，不能只凭版本号判定是否加载了本次代码。

检查并记录：

| 场景 | 预期 | Windows 实测 |
|---|---|---|
| 正常扫描 | 菜单出现 codebuddy，等待用户选择 | NOT_RUN |
| codebuddy / cbc 同时存在 | 只展示一个 codebuddy | NOT_RUN |
| PATH 仅有 cbc | 仍能扫描并以 --acp 启动 | NOT_RUN |
| 同时安装桌面 WorkBuddy | 与 codebuddy 分别展示 | NOT_RUN |
| npm 自定义 prefix / 含空格路径 | 正确定位 Node 与无扩展名脚本，无 MODULE_NOT_FOUND | NOT_RUN |
| 绑定保存、自动启动 | codebuddy 与所选 Bot 绑定，启动成功 | NOT_RUN |
| 飞书派发 `17 × 23` | 收到任务，回写 391；日志成功而非仅页面状态 done | NOT_RUN |
| stop 后 start | 重启成功，同一 Bot 再次执行新任务成功 | NOT_RUN |
| 独立 CLI 未登录 | 记录实际错误；不应要求登录 WorkBuddy 桌面版 | NOT_RUN |

只用测试 Bot / 测试任务；不要修改其他绑定。任务失败时，记录 Task GUID、错误原文、包来源、Node / CodeBuddy 版本，并执行 `aamp-logs.cmd collect --since 1h` 收集日志。不要把包含凭据的绑定配置或认证文件提交到仓库。将测试结果和脱敏日志摘要更新到本文件后提交至同一分支。
