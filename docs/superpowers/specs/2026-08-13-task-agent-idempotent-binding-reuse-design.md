# Task Agent 幂等绑定复用设计

状态：已于 2026-08-13 完成方案确认。

## 背景

`feishu-task-agent install` 和 `feishu-task-agent add` 当前以
`bot.app_id` 判断 Bot 是否已存在。只要命中已有记录，就展示旧、新绑定并询问是否
替换；即使用户再次选择的是同一个 Agent 与同一个 Bot，也会制造一次没有必要的冲突。

## 目标

1. 相同绑定关系再次出现时，将操作视为幂等复用，不提示冲突，也不创建新记录。
2. `install` 复用已有记录后，仍按正常安装流程启动该绑定。
3. `add` 复用已有记录后，不写配置，也能正常成功结束。
4. 真正改变绑定关系时，继续使用现有的显式确认、原子替换和并发校验。

## 非目标

- 不修改配置 schema 或 `bot.app_id` 唯一键。
- 不静默替换已有绑定，不生成新的 `binding_id` 或 runtime 目录。
- 不刷新复用记录中的 App Secret、lark-cli profile 或展示名。
- 不改变 pending/ready 启动、配对、摘要和运行中 Bridge 的语义。

## 绑定关系判定

新增一个纯函数判断两个记录是否表达同一绑定关系。以下字段使用严格字符串相等：

- `agent_type`
- `aamp_host`
- `environment.name`
- `bot.app_id`

以下字段不参与判定：

- `bot.app_secret`
- `bot.lark_cli_profile`
- `bot.display_name`
- `binding_id`、`feishu_config_dir`
- `state`、`agent_target_email`、`runtime`
- `created_at`、`updated_at`

其中 `app_secret` 和 `lark_cli_profile` 是授权或本地配置资料，不定义 Agent 与 Bot 的
路由关系。复用时保留旧记录整体，避免一次幂等操作意外改写凭据或运行态。

## 方案选择

采用“选择阶段分类复用”：在 `runBindingSession` 得到草稿并找到同 `app_id` 的旧记录后，
先判断关系是否一致。

- 一致：把旧记录加入本次已接受绑定，不加入 upsert intent，也不进入替换确认。
- 不一致：保持现有“展示旧/新绑定、确认替换、生成 pending 新记录”的流程。
- 不存在：保持现有新增流程。

没有采用以下方案：

- 持久化层把重复 upsert 变成 no-op：该层无法自然告诉 `install` 应启动旧记录，且仍会
  触发无意义的配置文件写入。
- 不提示但用草稿替换旧记录：这属于静默替换，会丢失旧 runtime 身份并重新进入
  pending，与“复用”目标相反。

## 数据流

选择阶段同时维护三类数据：

1. `selectedBindings`：所有已完成选择的条目，包含取消项，用于保持计划数和摘要顺序。
2. `bindingIntents`：仅包含新增或明确确认替换的草稿，用于批量原子 upsert。
3. `acceptedBindings`：按用户选择顺序保存真正要使用的绑定；新增/替换使用草稿，幂等
   复用使用旧记录。

持久化阶段仅在 `bindingIntents` 非空时调用 `upsertBindings`。这样只有复用项时不会
触碰 `bindings-v1.json`。

### `install`

`install` 将 `acceptedBindings` 交给现有共享启动器：

- 复用 ready 记录时，沿用其 runtime 和配对信息并正常启动。
- 复用 pending 记录时，继续完成首次配对，成功后由现有逻辑更新为 ready。
- 新增或替换记录仍先原子保存为 pending，再进入启动流程。
- 混合选择时保持原始选择顺序，不因“保存项/复用项”分组而重排启动摘要。

### `add`

`add` 只持久化新增或确认替换项。复用项计为本次正常接受的绑定，但不启动 Bridge、
不写配置，也不输出重复绑定、拟替换或确认提示。只有复用项时仍走正常成功返回。

“静默”仅针对重复冲突提示；正常的选择反馈和命令结束摘要可以保留。

## 并发与错误处理

- `install`、`add` 继续受 mutation lock 保护。
- 新增与替换继续由 `upsertBindings` 在 config lock 内执行旧记录快照校验。
- 复用不写配置，因此不产生新的原子写入或替换竞态。
- 若关系不同，仍要求用户明确确认；拒绝仍作为取消而不是系统错误。
- 比较和日志不得输出 App Secret。

## 测试方案

按 TDD 增加回归覆盖：

1. 关系比较忽略 App Secret、lark-cli profile、展示名和全部运行态字段。
2. `agent_type`、`aamp_host`、`environment.name` 或 `bot.app_id` 任一不同均不复用。
3. `install` 遇到相同 ready 关系时不提示替换、不 upsert，并把旧记录交给共享启动器。
4. `install` 遇到相同 pending 关系时复用旧记录并保留首次启动语义。
5. `add` 只有相同关系时不写配置且正常成功结束。
6. 相同 `app_id` 但关系不同，`install` 和 `add` 都保留现有确认式替换。
7. 新增、复用和取消混合时保持选择顺序与计划数。
8. 运行 Task Agent 全量测试、Node 语法检查、Bootstrap `bash -n` 和
   `git diff --check`。
