# Task Agent 类型展示与 Coco 正式类型设计

## 背景

Task Agent 当前把内部类型转换成产品文案，例如把 `trae` 显示为“Trae CLI（内部版）”、把 `traex` 显示为“Trae CLI Next（内部版）”。与此同时，旧版内部 Coco 的正式类型仍叫 `trae`，与实际可执行文件和探测语义不一致。

## 目标

所有用户可见的智能体名称直接展示正式 `agent_type`：

```text
codex
cursor
coco
traex
traecli
workbuddy
```

将旧版内部 Coco 的正式类型从 `trae` 不兼容地重命名为 `coco`。不兼容旧的 `--agent trae`，也不兼容配置中的 `agent_type: trae`。

## 类型契约

- Bootstrap 参数、自动探测结果和 Controller 白名单统一使用六项新类型。
- 仓库内 npm 发包技能生成的一键启动命令默认使用 `--agent coco`，并只接受同一组六项正式类型。
- 检测到旧版内部 Coco 时返回 `coco`，不再返回 `trae`。
- `--agent trae` 直接返回参数错误。
- 加载含 `agent_type: trae` 的旧配置时直接返回配置校验错误；不自动迁移、不静默替换。
- 选择或保存 `coco` 后，仍使用现有旧版内部 CLI 升级流程：优先复用已安装的 `traex`，检测到 Coco 时提示升级，升级成功后使用 `traex`。
- pending `coco` 绑定准备为 `traex` 或 `traecli` 时，仍可沿用现有事务式归一化；ready `coco` 绑定保留自己的稳定邮箱身份。

## 展示方案

Shell 和 Node.js 的展示函数都退化为恒等映射：输入什么正式类型，就展示什么类型。首次绑定、已保存绑定、启动/移除选择、检查与启动日志都不再使用产品别名。

当启动准备把 `coco` 解析成 `traex` 或 `traecli` 时：

- 绑定列表继续展示持久化的 `binding.agent_type`。
- 明确描述实际运行时的日志可展示解析后的原始类型 `traex` 或 `traecli`。
- 命令示例和错误修复指令保持真实命令名，不受展示逻辑影响。

## 兼容性与非目标

- 这是有意的 breaking change，不增加 `trae` 别名或配置迁移。
- 不修改 ACP Bridge 的原生 `traex`、`traecli`、WorkBuddy 支持。
- 不修改智能体探测优先级、ACP 命令、登录与升级行为。
- 不修改包版本，不发布 npm 包。

## 测试

- 先增加六项正式类型与恒等展示断言，并确认当前实现失败。
- 断言自动探测 Coco 返回 `coco`。
- 断言 `--agent trae` 和旧 `agent_type: trae` 均被拒绝。
- 将现有 Coco 升级、取消、归一化和 TraeCode 回退测试切换到 `coco`，确保业务行为不回退。
- 为 npm 发包技能补充回归测试，确保默认生成 `--agent coco`，并拒绝已移除的 `trae`。
- 运行 Task Agent 全量测试、Bootstrap `bash -n` 和 `git diff --check`。
