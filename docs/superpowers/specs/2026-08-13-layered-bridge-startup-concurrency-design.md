# Task Agent 分层并发启动设计

状态：已于 2026-08-13 完成方案确认，尚未开始实现。

## 背景

`feishu-task-agent start` 当前将多智能体启动拆成两个完全串行的阶段：

1. 相同 `aamp_host` 下只启动一个 `aamp-acp-bridge` 进程，但该进程内部按配置顺序逐个
   `await` 启动 AgentBridge；Task Agent 等到整个进程发出 `bridge.running` 后才继续。
2. Task Agent 随后按绑定顺序逐个准备并启动 Feishu Bridge，等前一个绑定 ready 后才启动
   下一个。

2026-08-12 的四绑定样本包含 `traex`、`workbuddy`、`codex`、`cursor`：

- ACP 初始化约 1.4 秒；
- ACP 启动约 60.2 秒，四个 Agent 分别约需 11.7、10.9、18.9、17.6 秒；
- Feishu 启动阶段合计约 67 秒，单个绑定约需 7.6、7.7、22.3、29.4 秒；
- 加上 Agent 检测、登录检查和其他准备，用户整体感知约为 2～3 分钟。

这两个主要阶段的耗时都接近各成员耗时之和，而非最慢成员耗时。由于 Agent 检测可能
包含登录、升级和终端交互，不能简单把整个启动流程改为无界 `Promise.all`。

## 目标

1. 保持相同 `aamp_host` 只运行一个 ACP Bridge 进程，并在进程内部并发启动不同 Agent。
2. ACP 阶段结果明确后，并发启动相互独立的 Feishu 绑定。
3. 交互式 Agent 准备和 lark-cli 授权仍然串行，避免多个 TUI 或浏览器授权流程竞争终端。
4. 单个 Agent 或绑定失败不阻塞其他可用绑定，保持现有部分成功语义。
5. 并发启动期间确保配置、运行清单、错误日志、配对文件和进程监督状态一致。
6. 四绑定常规启动从约 2～3 分钟降低到约 35～60 秒，并提供可重复测量的性能标准。

## 非目标

- 不为每个绑定单独启动 ACP Bridge。
- 不改变 ACP 协议、Agent mailbox、绑定 schema、配置路径或 Agent 类型。
- 不把当前六类 Agent 切换到 CLI Bridge；`codex`、`cursor`、`coco`、`traex`、
  `traecli`、`workbuddy` 继续走 ACP Bridge。
- 不让 Feishu Bridge 与尚未结束的 ACP 阶段跨阶段并发。
- 不并发执行可能触发 Agent 登录、升级、lark-cli 登录或浏览器授权的流程。
- 不改变 npm 包安装、自动更新、发布或用户展示文案。
- 不以 Bridge 进程启动成功代替真实飞书任务链路验收。

## 方案选择

采用“分层、有界并发”方案：

```text
绑定校验与 Agent 准备（串行）
              ↓
按 aamp_host 初始化 ACP Bridge（主机组之间串行）
              ↓
每个 ACP Bridge 内的 AgentBridge（最多 4 个并发）
              ↓
根据 Agent 成功、失败、取消结果筛选绑定
              ↓
Feishu profile/runtime 预检（串行）
              ↓
Feishu Bridge 按绑定启动（最多 4 个并发）
              ↓
按用户选择顺序汇总并进入监督
```

没有采用以下方案：

- **绑定级全流程并发**：多个绑定可能共享同一个 ACP 进程和 Agent identity，跨阶段并发
  会引入重复启动、失败联动和共享进程引用计数问题。
- **每个 Agent 或绑定独立 ACP 进程**：隔离更强，但会重复创建 AAMP 连接、会话和进程，
  破坏当前按 host 聚合的架构。
- **只并发 Feishu Bridge**：风险最低，但保留约 60 秒的 ACP 串行瓶颈，无法达到性能目标。
- **所有步骤无界并发**：会让交互流程互相干扰，并在绑定数量增加时产生突发进程和网络
  压力。

## 并发模型

### 并发上限

- ACP Bridge 内 AgentBridge 默认最多并发 4 个。
- Feishu Bridge 默认最多并发启动 4 个绑定。
- 超过上限的任务按原配置或用户选择顺序排队。
- 本次先使用固定内部常量，不增加新的用户参数；测试可通过依赖注入验证其他上限。

固定上限可以覆盖当前六种 Agent 和常见绑定数量，同时避免一次启动大量 Node、ACP 和
lark-cli 子进程。后续只有在真实数据证明需要时，才增加环境变量或 CLI 配置。

### 顺序稳定性

并发只改变实际执行时间，不改变用户可观察的稳定顺序：

- `bridge.running.agents` 按 ACP 配置顺序输出；
- 成功、失败、取消清单按用户选择的绑定顺序输出；
- 同一队列内超过并发上限的成员按输入顺序开始；
- 日志用 Agent 或 `binding_id` 标识，不依赖并发完成顺序解释结果。

## 启动流程

### 第一阶段：绑定校验与 Agent 准备

Task Agent 继续按 `aamp_host` 和稳定 `agent_type` 去重，然后串行执行：

1. 校验绑定只使用 Online 环境。
2. 获取 Agent lease，防止另一个 Task Agent 实例使用同一 Agent identity。
3. 探测本地 Agent、检查登录状态并处理 Coco 升级选择。
4. 处理 `coco -> traex/traecli` 的新绑定归一化，同时保留已 ready 的历史身份。
5. 生成原生 ACP 命令和 Agent 专属 credentials、pairing、sender-policy 路径。

若用户取消或某 Agent 准备失败，只记录对应 Agent 的取消或失败；其他 Agent 继续准备。
准备阶段可能读取 TTY、执行登录或升级，因此本阶段不并发。

### 第二阶段：ACP 初始化和 Agent 并发启动

每个 `aamp_host` 仍生成一份包含多个 Agent 的 ACP 配置，并启动一个
`aamp-acp-bridge` 进程。不同 host 继续按现有顺序处理；本次性能样本只有一个 host，
不扩展跨 host 调度范围。

`AampAcpBridge.start()` 将“启动一个 Agent”的逻辑提取为独立、可测试的内部单元，并用
有界并发池调度：

1. Agent 获得执行槽位时发出 `agent.starting`。
2. 创建 `AgentBridge` 并等待其完成 identity、AAMP 连接、历史邮件 reconcile、目录同步
   和 ACP session 准备。
3. 成功后加入运行中 Agent map，发出 `agent.started`，包含邮箱和传输状态。
4. 失败时先对这个部分初始化的 Agent 执行 best-effort `stop()`，再发出
   `agent.failed`；清理失败只写日志，不能覆盖原始启动错误。
5. 等全部 Agent 尝试结束后：至少一个成功则发出 `bridge.running`；全部失败则抛出
   `No agents started successfully`。

`agent.started` 和 `agent.failed` 增加 `durationMs`，其余字段保持兼容。Task Agent 本次仍
等待整个 `bridge.running` 阶段结束，不在单个 `agent.started` 后提前进入 Feishu 阶段。

ACP Bridge 停止时对当前已运行 Agent 使用相同的有界并发上限。这样网络重试、正常退出
和 Ctrl+C 不会因多个 ACP session 逐个关闭而额外线性等待。无论单项停止成功与否，都
尝试停止其他 Agent；单项错误写入日志但不让 `stop()` 提前失败，最终清空运行 map 并
发出 `bridge.stopped`。

### 第三阶段：ACP 结果映射

Task Agent 在 `bridge.running` 后建立每个稳定 Agent 的结果：

- `agent.started`：记录可用 Agent 和实际 mailbox；
- `agent.failed`：记录脱敏后的 Agent 专属错误；
- 准备期取消：记录取消原因；
- `bridge.running` 中缺少且没有明确失败事件：生成“Agent Bridge 未启动”的兜底错误。

随后逐项筛选绑定：

- Agent 可用且 mailbox 与 ready 绑定一致：进入 Feishu 预检；
- Agent 失败：依赖它的全部绑定失败，但不影响其他 Agent 的绑定；
- mailbox 与持久化记录不同：对应 ready 绑定失败，并提示使用 `add` 或 `install` 重新
  绑定；
- 用户取消：对应绑定进入取消清单。

### 第四阶段：Feishu 预检

对仍可启动的绑定按选择顺序串行执行：

1. 状态记为 `starting`。
2. ready 绑定校验现有 IM/Task runtime、Agent mailbox 和 Bot App ID。
3. 写入该绑定的 Feishu runtime profile。
4. 检查 lark-cli profile、用户授权域和 scope。
5. 产出不再需要交互的 `PreparedFeishuStart` 描述，包括命令参数、环境和日志路径。

预检失败的绑定立即进入失败清单，不占用并发启动槽位。保持此阶段串行，是为了避免授权
失效时同时打开多个浏览器或设备授权流程。已有 profile 且授权有效时，这一阶段只是快速
检查。

### 第五阶段：Feishu Bridge 并发启动

预检成功的绑定进入并发上限为 4 的启动池：

- ready 绑定使用持久化 `agent_target_email`，等待
  `bridge.task_runtime.running`；
- pending 绑定先向对应 ACP 配置创建 pairing，再等待 Feishu Bridge ready 且 pairing
  被消费，之后读取并校验 runtime metadata，最后原子更新为 ready；
- 每个绑定保留独立的网络重试、日志文件、ready 超时和进程记录；
- 单个绑定失败时停止其本次 Feishu 进程，其他绑定继续。

同一 `aamp_host + stable agent_type` 共用一个 pairing 文件，因此 pending 配对使用按该键
划分的串行队列。不同 key 的配对可以并发；ready 绑定不进入 pairing 队列。配对队列只
覆盖“创建 pairing 到确认消费”区间，确保下一项不会覆盖仍在使用的 pairing code。

## 网络重试与失败语义

### ACP 阶段

保留现有 Task Agent 的整组 ACP 网络重试：

- 如果任一 `agent.failed` 是可重试网络错误且仍有重试次数，停止当前 ACP 进程并重启
  整个 host 组；
- 非网络类 Agent 错误不触发整组重试，其他成功 Agent 可以继续；
- 每次重试都重新建立本次进程的运行状态，不能混用上一次尝试的事件；
- 诊断探测继续在后台执行，不能阻塞真实重试。

### Feishu 阶段

- 每个绑定独立执行现有网络重试；一个绑定退避时不占用其他绑定的结果处理，但其任务仍
  占用一个启动槽位，防止重试期间超过并发上限。
- pairing 已消费后发生可重试失败时，不复用已消费 pairing，并沿用当前不可重试错误。
- 至少一个绑定成功时保留成功进程并进入监督；全部失败才整体失败。
- 只有取消项且没有失败项时，沿用正常取消语义。

### 运行监督

- 某个 Feishu Bridge 退出：只将该绑定标记失败。
- 共享 ACP Bridge 退出：将该 host 下仍在运行的绑定标记失败并停止其 Feishu Bridge。
- 收到 SIGINT/SIGTERM：停止调度新的并发任务，等待正在执行的启动步骤进入可清理状态，
  然后停止全部受管进程并释放 leases。
- 启动摘要前继续执行 retained-process reconcile，避免把刚 ready 随即退出的进程列为
  成功。

## 共享状态安全

### Manifest

当前 `setBindingStatus()` 更新内存 map 后会整体重写 `manifest.json`。并发调用必须通过
一个串行写队列：

- 每次入队时只标记内存中的最新状态；
- 队列实际写入时从 `bindingStatuses` 重新生成最新快照，而不是捕获旧快照；
- 调用方等待自己触发的写入完成；
- 首次写入错误作为真实启动错误传播，不能静默丢失状态。

这样即使多个绑定同时从 `starting` 变为 `running/failed`，最后落盘也包含所有最新状态。

### 配置与日志

- 绑定 store 继续通过现有配置锁和 `writeJsonAtomic()` 更新，不改变原子替换语义。
- `errors.jsonl` 使用进程内串行 writer，确保单行 JSON 不交错，并在退出前 flush。
- 每个 Bridge 已使用独立日志文件；同一个 ACP 日志的事件继续通过现有 serialized writer
  写入。
- 用户选择顺序保存在输入索引中，结果聚合不依赖 Promise 完成顺序。

## 可观测性

保留现有日志 schema，并补充能够定位并发瓶颈的字段：

- ACP `agent.started`、`agent.failed`：`durationMs`；
- ACP `bridge.running`：保留 `agentCount` 和有序 agents，并增加整个 Agent 启动阶段耗时；
- Task Agent ACP stage：继续记录总 `durationMs`、attempt 和网络分类；
- Feishu binding stage：继续记录每个绑定的 `durationMs`、attempt 和日志路径；
- 并发池不逐条打印调度噪声，只有开始、成功、失败和最终摘要进入用户输出。

日志和摘要继续执行 secret redaction，不输出 App Secret、mailbox token、pairing code、OAuth
设备码或其他凭据。

## 兼容性

- 单 Agent 配置仍经历相同事件和成功/失败条件，只是使用并发池容量中的一个槽位。
- `bridge.running` 仍在所有配置 Agent 完成启动尝试后发出。
- 已有 `agent.started`、`agent.failed` 消费方无需读取新增的 `durationMs`。
- binding store、Agent credentials、pairing、sender-policy、Feishu runtime 的路径均不变。
- 多个绑定共享同一 `agent_type` 时，ACP 配置仍只包含一个 Agent，Feishu Bridge 各自独立。
- 多 host 行为保持现状，不在本次增加 host 级并发。

## 测试方案

实现按 TDD 拆为 ACP Bridge 和 Task Agent 两组测试。

### ACP Bridge

通过注入可控的 AgentBridge factory 或内部启动函数，覆盖：

1. 四个 Agent 在任一测试 Agent 释放 readiness 前都已进入 `start()`。
2. 并发上限为 4；第五个 Agent 只有在前四个之一结束后才开始。
3. 单 Agent 失败不影响其他 Agent，且失败 Agent 执行 best-effort 清理。
4. 全部失败时不发出 `bridge.running` 并返回原有总失败错误。
5. 部分成功时 `bridge.running.agents` 只包含成功项，并保持配置顺序而非完成顺序。
6. `agent.starting -> agent.started/agent.failed -> bridge.running` 的单项事件顺序正确。
7. `durationMs` 为非负有限数。
8. stop 有界并发、单项 stop 失败不阻止其他 Agent 被停止，最终仍清理 map。

### Feishu Task Agent

使用可控 fake Bootstrap、ACP Bridge 和 Feishu Bridge 进程覆盖：

1. Agent 准备按输入顺序串行，后一个不会在前一个结束前开始。
2. Task Agent 仍等待 ACP `bridge.running`，不会因单个 `agent.started` 提前启动 Feishu。
3. Agent 失败只淘汰依赖该 Agent 的绑定。
4. Feishu profile/auth 预检串行，并且预检失败项不进入启动池。
5. 四个 ready Feishu 绑定在任一 fake ready 前都已启动。
6. Feishu 并发上限为 4，第五项等待槽位。
7. 同 Agent 的两个 pending 配对不重叠；不同 Agent 的 pending 配对可以重叠。
8. 一个绑定重试或失败不阻止其他绑定完成。
9. manifest 并发更新后包含所有绑定的最终状态，不会发生旧快照覆盖。
10. errors JSONL 每行都可独立解析，退出前无未 flush 内容。
11. 最终摘要按用户选择顺序展示成功、失败和取消项，而非完成顺序。
12. 部分成功、全部失败、仅取消、ACP 进程早退、Feishu 进程早退和停止信号保持现有退出
    语义。

### 回归命令

- ACP Bridge 全量单测和 TypeScript build；
- Feishu Task Agent 全量单测；
- Feishu Bridge 现有全量单测和 build；
- Bootstrap `bash -n`；
- Controller Node 语法检查；
- `git diff --check`；
- 本地 tgz 安装后的真实启动验证。

## 验收标准

### 功能与并发

1. 相同 host 下选择 `codex`、`cursor`、`traex`、`workbuddy` 时，只产生一个 ACP Bridge
   进程，配置中每种 Agent 只有一项。
2. 四个 Agent 的启动区间存在真实重叠，峰值并发为 4；五个以上时峰值仍不超过 4。
3. ACP 内一个 Agent 失败不会阻止无依赖关系的 Agent 和绑定成功。
4. Task Agent 只在 ACP 阶段结束后进入 Feishu 阶段。
5. 四个 ready Feishu Bridge 的启动区间存在真实重叠，峰值并发不超过 4。
6. 同 Agent 的 pending pairing 不重叠，不同 Agent pairing 可以重叠。
7. 用户需要登录、升级或补充 lark-cli 授权时，只出现一个可操作的交互流程。
8. 最终摘要、manifest、binding store、errors JSONL 和受管进程状态一致。

### 性能

在 npm 缓存就绪、Agent 已登录、lark-cli 已授权、无网络重试的同一台机器上，连续运行
三次并取中位数：

- 四个全部 ready 绑定：从用户确认选择到打印启动摘要，中位数不超过 50 秒，任一次不
  超过 60 秒；
- 两个 ready 加两个 pending 绑定：中位数不超过 70 秒；
- 与修改前同场景基线相比，中位数至少下降 50%；
- 日志应显示 ACP 总耗时接近最慢 Agent 而非四项之和，Feishu 总耗时接近最慢绑定而非
  四项之和。

Agent 升级、浏览器授权、首次 npm 下载和真实网络重试属于用户或外部等待，不计入上述
常规性能基线，但仍必须有明确日志，不能表现为无输出卡住。

### 真实端到端

启动 `traex`、`workbuddy`、`codex`、`cursor` 四个绑定后，分别派发一条代表性飞书任务，
每个绑定都必须验证完整链路：

```text
飞书任务事件
→ 对应 Feishu Bridge
→ AAMP
→ 正确的 ACP Agent
→ 流式事件与最终结果
→ 飞书任务评论、Step 和最终状态更新
```

单纯看到 `agent.started`、`bridge.running`、Feishu Bridge ready、安装成功或 npm 包发布成功，
都不能作为端到端验收通过的依据。
