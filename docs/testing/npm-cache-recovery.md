# npm 缓存不完整的启动检查与恢复

本次覆盖 Task Agent 共用的 ACP Bridge、Feishu Bridge 依赖准备，以及 ACP 会话所需的 acpx；macOS 和 Windows 共用恢复逻辑。

## 复现场景

- npm 的缓存目录仍有 package.json，但可执行入口或 Windows npm shim 缺失。
- Windows shim 存在，但它引用的 Node 脚本缺失。
- 入口存在，执行时因内部模块缺失报 ERR_MODULE_NOT_FOUND / MODULE_NOT_FOUND。例如 acpx 入口保留而 zod/index.js 缺失。

处理时先解析入口，再执行限时 --help 健康检查。仅明确属于受管理 npm 缓存的模块缺失才触发独立恢复缓存的一次重试；原目录保留，恢复缓存按包规格复用。外部用户安装、用户项目模块缺失、权限错误、网络错误和取消不会被当成缓存损坏。恢复后再做健康检查，失败不报告就绪。

acpx 优先复用 PATH 中健康的入口；不存在时准备 npm 入口。验证后的 PATH 传给实际 ACP Bridge，避免预检与后续执行选中不同缓存。本地 Agent 明确的 session.deferred 事件不再被 agent.started 的邮箱连接状态掩盖；远程 Agent 保持原有事件处理策略。

## 本机同类缓存审计

只读检查发现旧 npm 临时缓存中不止一个包有入口缺失，包括 ACP Bridge、Feishu Bridge、旧 Codex ACP 和旧 Codex CLI 缓存，以及部分依赖包。不能仅凭这些遗留目录断言当前选中的安装均已损坏，也不能由文件缺失推断删除者。

- ACP/Feishu Bridge：由本次公共入口与健康检查覆盖。
- acpx：本机已复现入口存在、zod 缺失；修复后通过控制器的实际准备函数和 --help 检查。
- Windows Codex ACP 的专用安装目录：已有完成标记、入口验证和重建；本次入口审计未发现该专用目录的入口缺失，但这不等于对全部传递依赖做了完整验证。
- 飞书 CLI：已有 --version 检查和安装后复检。
- 注册 SDK：已有真实模块导入检查和失败后的安装尝试；当前策略并不保证 npm 会修复所有局部损坏，因此不能视为完整缓存自愈。

--help 仅检查启动加载路径，不覆盖延迟加载插件、所有运行期功能或用户任务代码。不自动清理全部 npm 缓存，也不修复用户自行维护的全局 Agent 安装。

## 验证

专项测试使用本地打包 fixture，先破坏缓存再确认旧行为失败，然后验证恢复、复用、最多一次重试、无关错误不重试、Windows 悬空 shim，以及本地会话失败判定。

```powershell
node --test packages/aamp-feishu-task-agent/test/runtime-package-executable.test.mjs packages/aamp-feishu-task-agent/test/codex-session-readiness.test.mjs
node packages/aamp-feishu-task-agent/scripts/run-platform-tests.mjs
```

Windows 真实缓存检查不创建 ACP 会话、不派发任务。两个 Agent 的完整任务闭环留给用户手动验收；macOS 原生启动尚需在 Mac 上验证。

2026-10-10 验证结果：专项 20 通过、0 失败、4 个 POSIX 用例跳过；独立测试状态目录下 Windows 平台回归 406 通过、0 失败、18 跳过。首轮平台回归有一个服务生命周期锁用例因使用正式状态目录而超时；未修改正式锁，隔离目录重跑后该用例通过。真实 ACP/Feishu Bridge 的 --help 均通过，且两者实际启动环境均可运行恢复后的 acpx 0.19.4。另已覆盖真实目录别名、清理未完成时健康探测仍能超时报错，以及成功后定时器不再触发。
