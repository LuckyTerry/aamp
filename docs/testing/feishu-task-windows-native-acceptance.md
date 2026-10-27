# 飞书任务 Windows 原生开发与验收记录

日期：2026-09-07 至 2026-09-10。状态：Win11普通用户/AIME矩阵已取证并完成卸载；产品修复已推送，三平台×Node22/24六组CI通过。本机文件能力不支持，实际注销由用户跳过；PR与飞书摘要已同步并回读，保留Draft。

用户先要求“先开发”，随后提供 Windows SSH 测试机，并明确确认上传三个消费包源码、测试与开发 tgz，后续授权真实 Bot 与任务业务补测。下表汇总最新证据；未完成的验收项仍是发布门禁。

## 源码与环境

- 仓库：ILUO/aamp；分支：`feat/feishu-task-windows-native`。
- 固定基线：`7c4b7ff50b2fc766f9076dcbc7d87ce910ca8b76`，来自 `fix/feishu-auth-scope-negotiation`。
- 开发主机：macOS 26.5.2 arm64、Node v22.22.2。实测主机：Windows 10 企业版 22H2 / 10.0.19045 x64、Administrator、PowerShell 5.1.19041.6456、Node 22.22.2 / 24.20.0、Codex 0.153.4；存在活动 console 登录，无 RDP。该条描述历史Win10基线；Win11普通用户实测见最新结论及末尾记录。
- Windows 目标：Windows 11 x64 普通用户、PowerShell 5.1、Node 22/24。
- 已注册专用新 Bot、完成用户 OAuth 与真实任务补测；已推送开发分支并创建 Draft PR https://github.com/ILUO/aamp/pull/1，未合并或 npm 发布。

## 验证记录

最新结论（2026-09-10 Win11/AIME）：产品d626d3c、验收提交111f154已推送；对应run34471995377六组CI逐项成功。Win11 Node22/24 Task Agent各283通过、15跳过、0失败；更新后793/done、锁屏893/done、故障恢复901/done和最终卸载已核验。本机文件UNSUPPORTED，注销/登录USER_SKIPPED。详细状态见下表和最后CI小节；PR保持Draft。

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

### 历史验证记录（不替代以上Win11/AIME状态）

历史范围调整（后续实测已更新结论）：用户改为验证 Codex 以外的 Agent，允许改验 AIME，覆盖前轮“先通过 Coco”的执行顺序。AIME 租户资格和原生扫描通过，固定适配器安装/认证/doctor 通过；真实 ACP 返回正确391，但严格仅整数断言失败，远程计算后 EOF 15秒未退出。仅握手后 EOF 正常退出。产品代码未改，飞书任务闭环及原三包失败仍未关闭，详见末节。

本轮 Win11/Coco 接手复验（2026-09-10，代码 a8b68b9）：真实普通用户 Session 1 的 CIM 查询通过；npm 含空格 Node 路径失败及两项 ACP CIM 夹具失败均已重新复现。Coco 0.121.0 只读启动探针耗时 11.620s、8.605s，第三次 145.621s 无输出后仅终止已验证身份的测试进程。P1/P2 未关闭；详见末节。先验 Coco，通过后再验其他 Agent，正常流程必须扫描可用 Agent 并由用户选择。

最新 2026-09-10 普通用户修复：ACL 重复保护与不安全权限修正已在 Win10 标准用户通过，三包实际打包和安装 help 通过；该账号的 SSH 会话拒绝本机 CIM/WMI 查询，TaskAgent/ACP 普通用户全量及生命周期尚未转绿。详见末节；以下历史记录不覆盖当前提交。

本轮 2026-09-09 范围修正：Node 24 本机 TaskAgent 全量 477 通过/10 跳过，Win10 原生 278 通过/14 跳过；Agent 扫描和手动选择使用测试 CLI 验证，真实 Win11/Coco 业务仍待验收。新结果详见末节。以下表格保留 2026-09-08 业务补测证据，不将旧提交成功等同于本轮代码验收。真实桌面证据来自 Windows 10 Enterprise 22H2 Administrator；CI 的 Windows runner 是 Windows Server 2025，不是 Windows 11。Node 24 已完成三包原生测试及更新后真实后台任务闭环。历史失败保留在下方，不将已被后续证据覆盖的旧状态作为当前结论。

| 验证层 | 当前状态 | 说明 |
|---|---|---|
| 三平台 × Node 22/24 CI | 最新产品代码六组通过 | 产品代码 `32af180` 的 run 34229593027 及文档提交 `0732a02` 的 run 34230292680 全部通过，含三包测试、类型检查、pack 与安装入口；此前 Windows 配置锁超时已有原生红绿复现并修复 |
| Win10 Node 22/24 原生包测试 | 通过 | Node 24.20.0：Task Agent 250 通过/13 跳过，ACP 193/4，Feishu 112/0；新增进程元数据完整文件 31/31、文件大小边界 3/3 等另轮验证，见下方 |
| 实际 npm pack / 全新 prefix 安装 | 通过 | 三包实际 tgz；新 Bot 注册、用户 OAuth、自动绑定与真实任务恢复均有证据；不把修复后恢复称为初版安装全程无故障 |
| npm shim / argv / stdin / exit | 通过 | 原生 npm shim，中文、空格、特殊字符、CRLF 与退出码；包含标准安装 Codex/acpx |
| ACL / CIM / 进程树隔离 | 通过（修复后） | 原生身份、ACL、父子孙清理、旁观者存活；CIM 缺路径增加有界复查及原生句柄/创建时间补查。最终包真实启动和任务已通过，仍拒绝未知身份 |
| Codex ACP 与特殊目录 | 核心闭环通过 | 交互 Session 1 实际计算、读写及上传通过；特殊目录标准安装及原生 Codex sandbox 命令通过。SSH Session 0 runner pipe-in 超时边界保留；不据此声称 headless 可用 |
| 注册 / 用户授权 / 普通任务 / need_help | 通过 | 新 Bot 普通计算 527、Owner 补充 493，服务端 done/4 与日志交叉核验 |
| 单次提醒 / 重复任务 / 父子任务 | 通过 | 单次 133，父子 48；真实每日重复任务连续两实例均得到 91，第二实例提前 due 加速验证，不是等待完整 24 小时 |
| 附件输入及 Windows 产物上传 | 核心与中文/CRLF 边界通过 | 中文输入、中文空格输出路径，上传后服务端下载校验 marker/49/CRLF。50 MiB 前一字节、等于上限、超一字节以真实 NTFS 文件＋受控上传接口验证，不冒充三次真实大文件云上传 |
| stop/start/restart / 崩溃恢复 | 已验部分通过 | 实际 controller 强退后同 worker 自动恢复，新 controller ready；测试覆盖三次重试耗尽及等待期间 stop。关闭终端后交互后台业务继续；锁屏、注销/重新登录仍待可恢复交互登录条件 |
| 运行中 update / 卸载 | 通过（修复后） | 非法包拒绝且旧服务/包不变；合法包安装保留绑定；后续修复包 Node 24 任务 361/done。正常 stop 与 npm uninstall 退出 0，计划任务/入口/隔离包移除，绑定字节不变，受管 Node 0，三个旁观进程存活 |
| 异常与安全边界 | 受控测试通过 | Windows profile/ACL/CLI 缺失、网络错误分类与重试、CIM 权限拒绝/PID 重用、多绑定隔离纳入已通过的原生/CI 测试；不表示真实租户 token 撤销、拔网或修改企业策略已实测 |
| Windows 11 普通用户 | 历史表当时未验证 | 最新Win11/AIME证据见顶部矩阵及末节；仍不能用Win10管理员或Windows Server CI替代 |

## 原生验收录入模板

每个用例记录：OS build / 架构 / PowerShell / Node / Agent 版本、三个实际包的版本及 integrity、源码提交、操作、预期、实际、退出码、Task ID（适用时）、脱敏日志位置、通过或失败原因。不得放入 App Secret、OAuth token 或原始 profile。

## 发布与范围

源码 Bridge 的 package name 与默认发布 scope 不同。开发测试通过明确的本地 tgz 覆盖选择修改后的 Bridge，不能把 registry 中的旧包当成本分支。发布顺序仍为必要 Bridge patch → 核验真实 artifact 与精确引用 → Task Agent patch；目前没有分配或发布 Windows 版本。

仅涉及三个消费包与专用测试工作流。Task/AAMP 协议、scopes、Owner、结果与取消规则、SDK、服务端、旧 Task Bridge 不在本次改动范围。原有业务缺陷不因 Windows 适配声明已解决。

## 首次本地交付开发包（历史，未发布）

三个包均在本机通过 `npm pack --json` 构建。两 Bridge 的 prepack 执行 build/prepare-bin，随后三个确切 tgz 在全新临时 prefix 安装并运行安装后入口。这里只证明 macOS 上包内容与入口可加载，Windows `.cmd` 和业务闭环仍未执行。版本号沿用源码基线，不代表同名 registry 包包含这些修改；用 integrity 区分此次开发 artifact。

- `zengxingyuan-aamp-acp-bridge-0.1.29-dev.0.tgz`
  - 包：`@zengxingyuan/aamp-acp-bridge@0.1.29-dev.0`
  - Integrity：`sha512-VNleMRo7abRSCJHETbeF+W+2qNFgd1+/rn4QK4+GBDUolM8IFU9okjTfscXfaVUhxG7O3cmuqmDZDiVQU4sEwA==`
- `zengxingyuan-aamp-feishu-bridge-0.1.52-dev.5.tgz`
  - 包：`@zengxingyuan/aamp-feishu-bridge@0.1.52-dev.5`
  - Integrity：`sha512-L/mAr6CWLnWZ2ySbIjkJXPL4oBSp6m8gPzqih5S9Tiq45NbdBujI3uUfyoRcIT8EI2CNNHI4TXRinKERgdewcA==`
- `larktask-aamp-feishu-task-agent-0.1.1-dev.6.tgz`
  - 包：`@larktask/aamp-feishu-task-agent@0.1.1-dev.6`
  - Integrity：`sha512-Dr5Ey5zVlm4D4AWPJ2u2lg1QRKo/mWaWOnq3zeZnla31EYAC1gAOsJ06q/uqZcGozSCVNZMN7W4EDd7jK1p+Vg==`

安装验证：首次离线安装因 SDK 元数据未缓存失败；允许下载包已声明的依赖后，再将最终三包离线安装到全新 prefix 成功。安装过程未运行 lifecycle scripts；Bridge 构建已由 pack 的 prepack 完成。

## 实施决策

- 使用用户指定 checkout 与开发分支，没有另建工作树；代码留在该分支供后续审查。
- 按用户要求先开发，Windows 实机门禁延期；若原生 API 或上游 artifact 行为不同，仍需后续修正后才能发布。
- Windows 私有身份 journal 和操作锁用于落实既定进程生命周期约束，未扩展为跨平台可靠性协议；其 Windows 行为仍需桌面验收。
- 历史版本曾将 Windows Agent 限制为 Codex；该限制违背原生兼容应保留用户选择的要求，已在 2026-09-09 范围修正中移除。当前扫描原生 CLI 后由用户选择；发现入口与真实业务验收分开记录。

## 首次本地交付自动化结果（历史）

| 包 / 检查 | 实际命令 | 结果与日志文件 |
|---|---|---|
| Task Agent | `node scripts/run-platform-tests.mjs` | 437 项：434 通过、0 失败、3 跳过；`/tmp/aamp-task-agent-final-accepted.log` |
| ACP Bridge | `npm test` | 176/176；`/tmp/aamp-acp-final.log` |
| Feishu Bridge | `node --import tsx --test 'src/**/*.test.ts'` | 99/99；`/tmp/aamp-feishu-final-crossfix.log` |
| 两 Bridge 类型 | `node node_modules/typescript/bin/tsc --noEmit` | 通过 |
| 共享数据 | `node scripts/sync-bootstrap-defaults.mjs --check` | 通过 |
| 独立 Bash 入口 | `bash -n bootstrap/aamp-feishu-task-agent-bootstrap.sh` | 通过；原有 Bootstrap 契约纳入完整回归 |
| Diff | `git diff --check` / `git diff --cached --check` | 通过；真实 npm shim 的 CRLF 以单文件 Git 属性保留 |

3 项跳过是 Windows 原生 ACL/进程树和真实 npm Windows argv fixture，未计入通过数。完整测试包括纯逻辑分支、受控依赖和现有 macOS 行为，不代表 Windows 原生实机执行。

最终复审已确认 npm shim/Codex/lark-cli 入口、CLI 提示词、锁的恢复、后台事务、前台协作退出和持久进程身份修复；无剩余阻断级静态发现。

基线/中间失败：原有日志跟随测试固定等待150ms，在 tail 尚未监听时写入更新而超时；测试现采用两轮唯一 marker 握手后再写一次真实更新。AIME 投影测试需等待相应日志落盘后断言。两者仅修正测试同步，未改对应 POSIX 业务逻辑；日志用例连续3次14/14通过后，完整回归通过。共享 pin 抽取后，两处源码字面量断言改为验证唯一 JSON 来源。

提交时全局硬编码提示性 hook 曾超过其2秒上限，hook 自行放行，不能将该次扫描算作通过；本次未关闭或改写该 hook。

代码提交：ACP `29c3506`、Feishu Bridge `8e3f9d5`、Task Agent `a5e49fe`。均为本地开发提交。

## 2026-09-08 Windows 10 原生 SSH 实测

环境：Windows 10 企业版 22H2 / 10.0.19045 / x64，PowerShell 5.1.19041.6456；Administrator，存在 active console 会话，无 RDP。使用官方校验过的便携 Node 22.22.2 / npm 10.9.7。仅在独立测试目录操作；每次进程 PATH 仅含 Node 与 Windows 系统工具，无 Git Bash、MSYS、WSL。未修改系统 PATH，未注销或重启机器。

| 检查 | 结果 | 脱敏日志（远端测试根目录内） |
|---|---|---|
| Task Agent 正式平台测试 | 244 项：231 通过、13 平台跳过、0 失败/取消 | `task-agent-native-final.log` |
| ACP `npm test` | 176 项：172 通过、4 平台跳过、0 失败；tsc 通过 | `acp-canonical-fixed.log` |
| Feishu 全部 src 测试 | 106/106；tsc 通过 | `feishu-full-fixed2.log` |
| 原子替换最终重试窗口 | 7/7；最后对齐批准设计的 100/200/400/800/1600ms 间隔 | `rename-final.log` |
| 真实 npm cmd shim | argv 特殊字符、中文、stdin、exit code 通过 | `native-launcher-fixed1.log` |
| 真实 Task Scheduler | start、重复 start 保持 PID、restart 更换 PID、stop 返回 stopped | `scheduler-smoke-fixed.log` |
| 计划任务账号解析 | SID、完整账户名、短账户名；其他/不可解析账户拒绝，8/8 | `scheduler-principal-fixed.log` |
| 三个 tgz 新 prefix 安装 | ignore-scripts 安装成功；5 个 .cmd 帮助入口及空绑定 list 均通过 | `installed-native-final.log`、`installed-*-help.log`、`installed-list.log` |

Task Scheduler 读回 Interactive / Limited / IgnoreNew / RestartCount=3 / PT1M。受控 controller 仅模拟 readiness 和协作退出，不连接 AAMP/Feishu，不能算真实 Bot ready。确认 worker/controller 均退出后注销测试任务；不遗留后台任务。自动故障重启策略仅核对配置，未注入故障或实际注销登录。

macOS 增量回归：Task Agent 440 项、436 通过、4 原生跳过；ACP 176/176；Feishu 106/106。两 Bridge 类型检查与 pack build 通过。原生与 macOS 统计分开，不把跳过项算通过。

### 实机发现与最小修复

1. Windows npm exec 多行 eval 静默返回空描述符：固定 resolver 源码编码成单行 data URI，仅 Windows 使用；真实 npm 参数测试验证。
2. Path/PATH 重复导致 helper 覆盖无效：Windows 环境合并按大小写不敏感规则处理，POSIX 保持原规则。
3. Task Scheduler 把注册时的 SID 回读为 Administrator：归一化为 SID 后检查身份；仍拒绝其他身份或无法解析的账户。
4. 私密 JSON 的 chmod 在 Windows 不表达 ACL：秘密临时文件创建前设置并回读父目录私密 ACL，独立测试验证最终文件权限。
5. Windows rename 共享占用导致 EPERM：在文件替换边界对 EPERM/EACCES/EBUSY 最多重试 5 次、累计 3.1 秒；不先删除目标，不改变事件或结果语义。
6. 测试夹具修正：真实 Node 入口替代 shebang、USERPROFILE 隔离、Windows 路径及 PowerShell 断言、DNS mock 引用句柄及异步持久化完成条件。POSIX 专属测试明确跳过。

初次原生失败结果保留在 `*-full-initial.log`；一次扩大 ACP glob 意外包含额外 AIME packaged harness，其物料未在本次上传范围且含 POSIX 专属依赖，不作为正式 `npm test` 通过证据。随后按 package.json 的正式入口复跑并通过。

### 最终原生验证开发包（未发布）

版本号沿用开发基线，须按下列 integrity / SHA256 区分同名旧包。三个包安装到新的独立 prefix，远端 SHA256 与本地一致。

- `larktask-aamp-feishu-task-agent-0.1.1-dev.6.tgz`
  - Integrity：`sha512-dYmeNaFhyxEL1pDByLh+wcIqzwg4aZWF0DX5And1TwcRcOi0HGytsbmLs6dky0nAqzb9INiN4amayj1v/hoMMQ==`
  - SHA256：`8b6764f69d6bdaf6ce5150f2b770e0847ce1b36fd448efea8f80758e6c0362cb`

- `zengxingyuan-aamp-acp-bridge-0.1.29-dev.0.tgz`
  - Integrity：`sha512-zcijPRZRDGwUGc8TRYq1z0Y5Auo9TawxbQ/UocQbvQzwOAOw1nh7EneHJn8GeFAiCqQMgRHt5CnxggamuU4bnQ==`
  - SHA256：`1589b3bba191bf012357fce719a462ab82b34c1c99253e2d6bdc8192bdcb9119`

- `zengxingyuan-aamp-feishu-bridge-0.1.52-dev.5.tgz`
  - Integrity：`sha512-VGHSTH62u2DP9qlR0qjm8VrcdD5TAnLDF0Lv8j4Itjbc+dvBawbfHP5NOXHjoLSJVxjAQxgrRdkiqBfPyH5IXQ==`
  - SHA256：`b772040bbaa2a6dcb6127e8990e90e58897000fab5c1ab6c515a8711c2cfb0bf`

### 仍待验收

Windows 11 普通用户、Node 24、真正 Codex ACP session、飞书注册/OAuth/Owner 配对和完整 Task 业务矩阵、附件上传、注销登录恢复、故障重启、运行中更新卸载与 CI 矩阵。截至该轮测试尚无真实测试 Bot/用户授权材料，未注册、发送或派发业务任务；后续真实授权与业务测试见下节。Win10 Administrator 的原生测试不替代这些发布门禁。


## 2026-09-08 真实授权与业务验证

- Bot 注册已完成，用户在 Mac 浏览器授权，Windows SDK 轮询成功取得结果；无需浏览器回调 Windows localhost。
- App ID：`cli_aa1511303dba5bc1`；隔离 profile：`aamp-feishu-task-cli_aa1511303dba5bc1`。
- 用户 OAuth 已完成；CLI 1.0.94 的服务端 verify 检查返回 user available=true、status=ready、tokenStatus=valid，已授予所需 Task scopes。
- 首次授权结束时发现 CIM GetOwnerSid 进程退出竞态，以及 Windows helper 不兼容新版 profile 对象列表。已进行限定修复：前者重查同 PID 与创建时间后才忽略退出/复用，存活进程权限错误不忽略；后者支持旧字符串及具名对象，并保留 token/scope 校验。
- 原生专项：CIM 28/28、profile 16/16；macOS 增量全套 451 项、445 通过、6 原生跳过。随后另加入仅含 PID 与字段名的身份诊断；一次 invalid tree identity 未再次复现，保留为待跟踪项，不按通过处理。
- 旧安装流程在返回注册结果前中止，尚未写 bindings。已按官方 CLI v1.0.94 Windows DPAPI 存储实现，仅在该 Windows 用户内恢复本 App 的单个密钥引用，并经产品既有 buildPendingBinding/upsertBindings 保存 pending 绑定；密钥未输出或传出机器，未重复创建应用。
- 真实 Agent Bridge 与 Feishu Bridge 1/1 启动及 AAMP 配对完成。
- 首个 Task：`9b796fdb-7212-428b-ad39-b7e1c7bd9a9d`，仅分配给上述测试 Bot；幂等键 `aamp-win-native-20260908-smoke-01`。内容为 17×23。
- 已观察完整事件接收、AAMP dispatch、ACK、result 回写链路，但 result 为 rejected/failure。飞书虽为 done，不算成功闭环。AAMP Task ID：`feishu-task-9b796fdb-7212-428b-ad39-b7e1c7bd9a9d-eacdab79709ac050f83f8b6171f96085`。
- 失败根因：真实 acpx 0.15.1 在 Windows 拒绝 raw --agent command string，要求配置 argv array；Windows 原生适配已在后续轮次修复，业务结果/完成规则保持原样。
- 独立原生 Codex 0.153.4 只读计算探针最终输出 391。过程中 WebSocket 多次超时，自动切换 HTTPS 后成功，说明模型可调用但该主机网络存在明显等待。
- 首次失败任务后已正常 stop，保留 Bot、OAuth、绑定及任务作为验收证据。

### 第二轮真实任务与 Windows 长提示词问题

- Windows argv 配置修复后，真实 `agent.session.ready` 成功。原生回归：Task Agent 256 项（243 通过、13 跳过）；ACP Bridge 184 项（180 通过、4 POSIX 跳过）。
- 第二个 Task：`35b8692f-4e2d-44d1-a88e-e7bd0c2bed5f`；幂等键 `aamp-win-native-20260908-smoke-02`。事件、ACK、进度、结果回写均已发生，但仍为失败，不算业务通过。
- 评论确认失败原因为缺少 `FEISHU_TASK_RESULT_JSON`，返回内容为系统错误乱码。Windows 无副作用复现：`node npx-cli.js -y acpx --help` 携带 20 字符参数成功；携带 12000 字符参数返回退出码 1、`The command line is too long.`。
- 根因定位到 npx 内部 Windows 命令调用长度限制。修复限定为 Windows 使用 acpx 原生 `--file -` 从 stdin 读取提示词，保留 POSIX 调用和飞书结果判定规则。修复后成功结果见第三轮记录。
- stdin 初版原生全套为 189 项（185 通过、4 POSIX 跳过、无失败）；后续审查补充输入管道失败仍存活子进程的清理场景，因此该数字仅作为中间证据，最终版须再次验证。
- 第二轮停止命令正常返回 0，确认该轮 controller/bridge/acpx 进程已退出。等待达到分钟级：清理逐个 PID 做 PowerShell/CIM 验证，不将循环的 sleep 总时长等同于整体超时。
- 下一轮启动遇到旧记录 PID 6288 已复用而拒绝 taskkill，未误杀。恢复逻辑已修复：只对证实已退出的旧身份跳过，不吞掉权限或身份查询错误。

### 第三轮：普通文本任务真实闭环通过

- Task GUID：`c32c432b-1907-4e44-949f-ee59abf90858`；幂等键 `aamp-win-native-20260908-smoke-03`；[飞书任务](https://applink.larkoffice.com/client/todo/detail?guid=c32c432b-1907-4e44-949f-ee59abf90858)。
- AAMP Task ID：`feishu-task-c32c432b-1907-4e44-949f-ee59abf90858-2c91cc116c79fd43aeb3e59e76095989`；run `1788854392120-14248`。
- 2026-09-08 08:02:24 UTC 真实 ACP session ready；08:03:55 接收任务；08:06:39 ACP completed；Feishu Bridge 随后记录 `answered` 与父任务完成。
- 服务端回读确认评论 `7683072876475419577`：`391. Multiplying 17 by 20 and by 3 gives 340 + 51 = 391.`；任务 status=done、agent_task_status=4。此轮由内容与协议成功日志共同判定通过，不只看 done。
- 验证范围：Mac 浏览器授权 → Windows 取得 Bot / 用户凭证 → AAMP 配对 → 原生 Codex ACP → 飞书任务事件/ACK/执行/评论结果/完成。未引入 Bash、WSL 或 Windows 远程桌面。
- 最终产品修复限定为 Windows：CIM 退出竞态、CLI profile 对象列表兼容、acpx argv 配置、长提示词 stdin 传输及失败子进程清理、旧 journal 的已退出 PID 代次恢复。飞书业务协议与 POSIX prompt 传递保持原样。
- Task Agent 最终原生全套：263 项，250 通过、13 平台跳过。ACP 清理测试曾因 Windows fd/pipe 差异及 PID 退出先于 close 事件产生夹具失败，已修正夹具并保留失败记录，最终重跑结果另记。
- 最终 tgz 版本号不变、未发布；以下 SHA256 已与远端核对一致：Task Agent `1ebaa938965e5b8a6925dd1418e5f3de994add84c72e37f380cfe1dead7d18f4`；ACP Bridge `8fcf12ba78b68f11c32b08566291a4a15c9249c94b853b3723b2e617792741c3`。ACP 实机文件名带 `windows-stdin-final` 后缀以避开 npm 旧缓存。
- 尚未验收：need_help + Owner 评论继续、提醒/重复/子任务、附件输入/上传、Windows 11 普通用户、Node 24、注销恢复/故障重启/更新卸载和远端 CI。普通任务成功不替代完整发布门禁。
- 最终 ACP 全套：Windows 190 项（186 通过、4 POSIX 跳过、0 失败）；macOS 相同测试集合串行执行 190 项（187 通过、3 Windows 跳过、0 失败）。并行运行曾出现已有超时夹具的慢启动失败；HEAD 对照可复现 TERM 夹具超时，记录保留，未删改或跳过该 POSIX 用例。
- 第三轮业务完成后 stop 返回 0，前台会话退出；保留已授权 Bot、用户 profile、绑定和三个测试任务供复核。
- 最终 Task Agent macOS 串行全套：459 项，451 通过、6 Windows 跳过、2 AIME 相关测试失败（远端 helper 进程组清理夹具 5 秒超时、噪声 npm 输出分类夹具 25 秒超时）。未报告全绿；两项不属于本次 Windows 改动文件，修改前 HEAD `2236a31` 隔离对照中，进程组清理同样约 5 秒超时，噪声输出分类约 8 秒通过；后者不能据此判定为已确认的既有失败。
- 最终 Windows 进程回查仅剩测试前已存在的 other Node PID 8548/7832/7672；本轮 controller、bridge、acpx 和 held-input 夹具均无残留。
- 噪声输出分类补充受控对照：HEAD 临时包仅覆盖本轮三个 Task Agent Windows 产品文件后，noisy 单项约 17.7 秒通过；当前 checkout 隔离仍达 25 秒超时。证据不足以将该失败归因于 Windows 改动，也不足以宣称当前 checkout 的 macOS 全套已通过，继续保留限制。

## 2026-09-08 Win10 业务与生命周期补测（进行中）

继续使用提交 `598acc0` 的已验证包、原隔离 Bot 和 Win10 Administrator，未引入新的业务代码。

| 场景 | Task GUID | 当前证据 |
|---|---|---|
| need_help / Owner 继续 | `1c859119-6e94-4499-bde2-a4200a13860c` | 日志 `help-needed` 和 blocked；Owner 已评论补充29，预期17×29=493，结果待回读 |
| 附件输入/CSV交付 | `4216434f-75ea-4fc2-ab68-5c98f888623f` | 85字节合成input.csv上传成功；附件GUID `c73bad00-f1c4-4e7a-8e07-44a403e98bab`；内容17/23/9、唯一标记，预期总和49 |
| 单次提醒 | `f8452498-b5ac-4b09-bee5-b98eeeaba10b` | due=1788856916000ms，截止时提醒，预期19×7=133；观察创建时延迟执行与提醒事件 |

附件任务先创建、上传、再分配Bot。实际 `task_assignees_update` 被既有allowlist忽略，已通过Owner评论触发；不将单独负责人变更视为已验证执行入口，未扩大修改事件语义。

补测中断记录：run `1788856157522-9888` 在 08:38:24 UTC 出现 `windows-process-journal: Windows process timed out after 30000ms`，Controller 按保护策略停止全部 Bridge。Owner 继续评论已经 ACK，附件任务 dispatch attachments=1，但尚未得到终态，不能判通过；提醒和父子任务需要恢复运行后重新触发。

原生诊断：同一主机 readIdentity 约0.9秒；空闲根进程树快照1.68秒，8个子进程2.72秒。ACP 每500ms同步执行快照时，两个空闲受管进程令100ms心跳最大间隔从125ms增至3551ms（10秒仅7次心跳）。这证明周期同步采样会显著阻塞事件循环；尚不能仅凭此把单次30秒CIM超时完全归因于它。修复限定为Windows异步、有界周期查询，保留身份验证及cleanup生命周期。

干净安装第一次尝试使用 `fresh-install-598acc0`：用户确认注册页面复用了旧Bot，故不算新注册通过；已正常stop，未撤销旧应用。按用户要求在新的空目录 `fresh-install-598acc0-r2` 重新发起注册，必须核对新App ID不同于旧 `cli_aa1511303dba5bc1`。


### 新 Bot 干净安装与新增 Windows 阻塞

- R2 空状态目录安装创建了新 App `cli_aa15713357f89bc4`（不同于旧 Bot），绑定 `0ed2b29e-a310-475f-b006-ce1b433d634a`。Bot 注册和用户 OAuth 分别完成，安装流程自行保存绑定并启动 1/1，无需手动恢复密钥。
- 新 Bot 冒烟任务 `5328fd0a-9ef7-4428-81d3-8e95c9420759`，17×31，预期527；服务端回读仅有 ACK `7683087206512069577`，不能认定业务通过。
- run `1788857506724-12068` 于09:04:34 UTC因 `writeJsonAtomic` 替换 IM state.json 返回 `EPERM`，Feishu Bridge退出1。ACP于09:04:58完成，但结果未回写。该轮仍使用 stdin-final ACP包；与异步采样修复的验证分开记录。仅凭错误码不能确定文件被哪个进程占用。

### Windows 异步进程采样验证

- ACP周期采样改为有界异步、single-flight，停止/取消等待在途采样结束后清理；保持PID代次和所有者校验。初始身份校验与最终清理仍包含有界同步操作，不宣称完全无阻塞。
- macOS ACP串行：197项，194通过、3Windows跳过、0失败。Windows ACP全套：197项，193通过、4POSIX跳过、0失败，约62秒。
- 同一Win10主机100ms心跳基线最大115ms；两个监控含启动身份校验最大1889ms、10秒93次；稳定阶段最大126ms、10秒93次。此前同步周期采样为最大3551ms、10秒7次。这支持周期阻塞已改善，不证明所有CIM超时已消失。
- 新ACP测试包文件名 `zengxingyuan-aamp-acp-bridge-0.1.29-dev.0-windows-async.tgz`；SHA256 `fc7817da4e5081d7a700dc0304ea47f17d0821bd70d9f5cc67da5e1a8459d068`，本地与Windows回读一致；尚待真实业务复验。

- IM持久化限定修复：将config.ts遗漏的直接rename接入包内既有renameAtomic，与Task路径共用。Windows临时EPERM/EACCES/EBUSY最多5次重试，总等待3.1秒；不unlink目标，失败保留原始错误，POSIX不重试。不能把重试等同于已证实占用来源或彻底解决所有EPERM。
- Feishu Bridge本地src测试108/108、build退出0；Windows原子替换专项9/9，含暂时/永久拒绝时旧JSON完整性。修复包 `zengxingyuan-aamp-feishu-bridge-0.1.52-dev.5-windows-im-rename.tgz` SHA256 `766652be1075a98a0cf16ded59c45683b5242eed4153b150ba9bf32d62953b2d`，本地与远端一致。

### 新Bot恢复后的真实闭环通过

- run `1788859026150-8992` 使用异步ACP与IM rename修复包，复用新Bot授权启动1/1。Owner继续评论 `7683091901909765058` 触发原任务；AAMP Task ID `feishu-task-5328fd0a-9ef7-4428-81d3-8e95c9420759-fbe716c1ebc30e8019905a01904613b2`。
- 最终评论 `7683092546850966490`：`17 × 31 = 527. Calculate 17 × 30 + 17 = 510 + 17 = 527.`。服务端回读 status=done、agent_task_status=4、completed_at=1788859383000，日志answered、completed parent=1 children=0，errors.jsonl为空。
- 结论：新Bot注册/用户OAuth/自动绑定成功；初次业务被EPERM中断，修复包恢复后由Owner评论触发的真实结果闭环通过。不将其改写为原598acc0包干净安装全程无故障，也不声称验证了结果自动重放。运行中仍有AAMP连接超时及流事件fetch失败，但本次最终回写成功。产品修复本地提交 `0a70b18`，未推送或发布。

- 新Bot本轮正常stop返回0，前台会话确认停止并退出；保留授权与绑定。

### 原Bot扩展场景恢复

- run `1788859546112-9380`，两个Windows修复包，1/1绑定恢复。Owner/附件/父子继续评论分别为 `7683093937623485414` / `7683093939989040080` / `7683093942392622032`，均ACK且ACP于09:28:34 UTC收到。
- 单次提醒重新设为due `1788860078000`，原截止时提醒保留。CLI +update的毫秒值入口返回1470400，改用文档支持的ISO日期成功；未改产品或CLI，尚待提醒触发验证。

- Owner继续通过：`1c859119-6e94-4499-bde2-a4200a13860c`，结果评论 `7683094672184478985` 为17×29=493，服务端done/agent_task_status=4；与此前need_help评论共同覆盖请求补充→Owner继续→完成（跨重启）。
- 父子通过：父 `ae73f174-a946-40b9-8098-c5b6630e6f4a`、子 `5ca6ce48-9d75-4d50-bb47-bc76b60af54e` 均done/agent_task_status=4，父评论 `7683094730036481246` 为6×8=48，日志answered及completed parent=1 children=1。
- 附件失败：结果评论 `7683095099516964040` 报告文件读取执行前连接runner pipe-in超时15000ms、替代Node runtime退出，未验证marker/total，未创建artifact。Feishu日志dispatch attachments=1、attachment_notes=0，终态result closed status=failure；虽然done不能算通过。错误来源目前为Agent结果报告，未独立定位Windows runner的系统根因，未绕过沙箱或改动权限策略。
- 新截止时间后已观察单次 `task_reminder_fire`、dispatch及ACK，事件 `a587731c241acac81022446764dba21f`；等待最终133回写。

- 单次提醒闭环通过：最终评论 `7683096245686029249` 为19×7=133，服务端done/agent_task_status=4；ACP于09:37:32 UTC completed，触发来源确认为task_reminder_fire，没有用Owner评论替代。
- 本轮明确未完成：附件输入到原生产物上传的完整闭环（runner执行失败）；重复任务、普通用户Win11、Node24、注销/故障恢复、运行中更新卸载和远端CI。当前成功场景不能替代这些门禁。

- 原Bot扩展补测结束正常stop返回0、前台SSH退出。停止完成后CIM回查仅有测试前既存Node PID8548/7832/7672，无本轮Node残留。保留两套Bot授权/绑定及任务证据。

## 2026-09-08 附件runner阻塞定位

- 原始Codex会话 `01a0802a-f612-72f0-ae3a-da3661e1cc30` 对应本附件任务。09:30:57 UTC首个Get-Content（读skill/CSV）在进程创建阶段报runner pipe-in连接15000ms超时；09:32:00仅读CSV且login=false仍复现。会话为workspace-write、network_access=false、on-request；未通过降低沙箱复测。SSH直接读取合成CSV正常。
- sandbox日志显示setup refresh errors=[]、command-runner复制/选择成功，错误出现在执行进程管道连接阶段。不能把setup成功等同于runner可用。
- 独立于AAMP的最小探针：同一Codex0.153.4执行 `codex sandbox -P :workspace --include-managed-config -C <test_root> -- powershell.exe -NoProfile -Command 'Write-Output AAMP_RUNNER_PROBE'`。SSH Session0失败（同样15000ms pipe-in超时）；一次性同用户Interactive/Limited计划任务位于Session1，输出标记并exit0。机器已有Administrator活动console登录；本对照未依赖RDP、未关闭沙箱、未修改用户Codex配置。
- 当前证据将阻塞定位为SSH Session0启动原生Codex runner的会话上下文问题；内核/runner更深层原因未定位。上游同类公开报告 https://github.com/openai/codex/issues/30839 截至检索仍Open，只作旁证，不代替本机对照。
- 产品已有后台模式使用Interactive/Limited Task Scheduler，可复用该执行路径；正在对同一附件任务重开并复测完整产物。独立诊断任务AAMP-Runner-Probe-20260908已移除，日志保留。

- 授权对照补充：相同隔离profile在SSH Session0返回bot not_configured/user missing；同用户Session1调用auth status --verify返回bot/user available=true、verified=true、tokenStatus=valid，Task scopes齐全。凭证未丢失，无需重新授权。lark-cli源码的Windows backend使用HKCU+DPAPI，读取失败对外返回missing；本机证据确认会话相关可用性差异，尚未独立输出具体DPAPI错误码。
- `start` 从SSH仍在前台预检授权，故在移交后台前被上述凭证读取阻断（0/1）；使用既有绑定的产品 `restart` 路径让worker在交互会话完成准备，无须手动导出凭证或改沙箱配置。完整业务结果待回读。

### 后台执行成功后暴露的Windows文件路径损坏

- run `1788861690737-14264`，后台worker PID14264经回查为Session1，ready=1/1；Owner重试评论 `7683103363885485282`，AAMP Task ID后缀 `c7872db28601ded0af0a200ea08f9a31`。新Codex会话 `01a0807a-daf4-7622-ba77-cb4b525d2c58` 于10:07:33 UTC实际Get-Content成功，10:08:31实际Import-Csv→求和→写result.csv→回读验证，exit0，内容marker,total及WIN10-ROUNDTRIP-9821,49。确认runner执行阻塞在交互会话消失。
- 随后交付仍失败，评论 `7683104669452471272`：路径被损坏后stat ENOENT。根因在task/runtime.ts的parseResultOutput使用展示文本getString读取file_delivery.path，二次把Windows路径中的反斜杠n/r转换成换行，导致node_modules/report/result.csv等路径段损坏。
- 限定修复：仅win32的file_delivery.path改用已有getRawString，保留JSON已解码路径；POSIX和展示文本换行处理不变。新增盘符/UNC各直接和外层AAMP JSON共4个原生回归，修改前4/4断言失败（路径换行），修改后4/4通过。Windows全套112/112；macOS108通过、4原生专项跳过；npm pack/build退出0。
- 修复包 `zengxingyuan-aamp-feishu-bridge-0.1.52-dev.5-windows-path.tgz` SHA256 `b85c5a932e3ee688bd0dd776e729886283a874fb2a42089ed63f34c6e6bddb80`，尚待最终实际上传复验。

### 附件最终闭环通过（交互会话后台模式）

- run `1788862696265-15364`，PID15364，修复包哈希与本地一致。原任务 `4216434f-75ea-4fc2-ab68-5c98f888623f` 重开，Owner评论 `7683107506259758063`；AAMP Task ID `feishu-task-4216434f-75ea-4fc2-ab68-5c98f888623f-38c28e12f936c77d99b9f1f9b569a47c`。
- 最终日志file_delivery=1、result closed status=succeeded、completed parent=1 children=0；服务端回读done/agent_task_status=4，交付附件 `e866b836-1172-4e05-a7d7-533d0a426840`，result.csv，37字节，resource.type=task_delivery。
- 通过服务端attachment.list/get取得临时URL，仅在Windows内下载回读，内容严格为 `marker,total\nWIN10-ROUNDTRIP-9821,49\n`。下载链接及凭证未输出；验证副本保留在隔离测试fixtures/verified-result.csv。
- 本次验证覆盖附件上传→AAMP派发→原生Codex实际读取/求和/生成→Bridge上传→服务端下载核验→任务完成。没有用预生成文件代替Agent产物，没有关闭沙箱；SSH Session0 foreground依然不作为可执行附件的已验收入口。
- 本地代码提交 `51950e5`，未推送/发布。两项一次性会话诊断任务已移除；完整Windows11/注销恢复等矩阵仍未完成。

- 本轮正常stop返回0；随后仅剩既存Node PID8548/7832/7672，产品计划任务Disabled，两项一次性诊断任务均不存在。授权、绑定与测试产物保留。

## 2026-09-08 非 Win11 补测与远端 CI

用户授权将除 Win11 外的验收继续推进并推送开发分支。接受新增协作者邀请后，HTTPS 推送成功，Draft PR 为 https://github.com/ILUO/aamp/pull/1；没有合并、发布 npm 或修改上游协议/scopes。

### 原生环境及 CI

Win10 新增官方 Node v24.20.0 x64，zip SHA256 `6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba`。Node 24 原生三包日志 `node24-task-agent.log`、`node24-acp.log`、`node24-feishu.log` 分别为 250 通过/13 跳过、193/4、112/0，均 fail=0。后续新增测试单独补测，不把早先计数标成最新全量。

CI https://github.com/ILUO/aamp/actions/runs/34223830533（`4f00ce2`）六组全部通过，每组 fail=0：

| 平台（各含 Node 22、24） | Task Agent 通过/跳过 | ACP 通过/跳过 | Feishu 通过/跳过 |
|---|---|---|---|
| Windows Server 2025 / PowerShell 5.1 | 253/13 | 194/4 | 115/0 |
| macOS | 455/7 | 194/4 | 108/7 |
| Ubuntu | 453/9 | 194/4 | 108/7 |

CI 发现并修正的测试环境问题：打包 Bash fixture 固定 LF；POSIX 假 AIME 消费 FD4 输入避免提前退出；Windows 使用 PowerShell 5.1，避免 PS7 父进程模块路径污染；Windows ACL 比较只忽略系统写回的 `DiscretionaryAclAutoInherited` bookkeeping 位，保留 owner/group/ACE/保护位完整比较与负例。没有改变 POSIX 业务语义。

最新 `902b856` 增加重试耗尽测试后，run 34224980298 的 Windows Node 22 有一项配置锁超时；新增测试本身通过。`0917e60` 修复实机发现的 CIM 元数据竞态，完整矩阵复跑中。

### 真实重复任务两轮

首实例 `7344ff4a-7b34-4a1b-9538-5ef0882027bb` 使用 `FREQ=DAILY;INTERVAL=1` 和到期提醒，真实提醒触发，ACK `7683122693738073017`，结果评论 `7683123385169103840` 为 91，服务端 done/4。

服务端生成次实例 `a0c25ff3-4b7b-497c-9fe4-6258a3ea9248`。将该实例 due 提前以加速验证，再由真实提醒触发，ACK `7683125069731630020`，结果 `7683125763029093623` 为 91，服务端 done/4。第三实例 `366808a5-2930-47f0-a26e-1c59afc706d0` 已执行清除 repeat_rule 并完成，清理命令退出 0，日志 `remaining-acceptance/recurring-cleanup.log`。没有声称跨完整 24 小时稳定性。

### 中文、空格、CRLF 与附件大小

任务 `02a9ae6a-da3e-4301-a48b-21f38243cdb7`：输入 `输入 数据 CRLF.csv`（98 字节，附件 `818bf073-6124-445f-9826-323896caff3b`），Owner 评论 `7683120648364838187`，ACK `7683120708850928590`。实际 Codex 生成 `验收 产物/结果 report.csv`，交付附件 `4152fd94-8159-44b4-9b23-1d1e82c3ae0e` 为 43 字节。服务端下载的精确文本为 `marker,amount\r\nWIN10-BOUNDARY-20260908,49\r\n`，任务 done/4。运行 `1788865689373-13240` 于 11:21:15.963 UTC 完成。

出站附件限制以真实 NTFS 文件测试 52,428,799、52,428,800、52,428,801 字节：前两者调用上传，超限者在上传前拒绝。Node 24 3/3，`delivery-size-boundary.log`。上传接口受控，不等同真实云 API 的 50 MiB 压测。

标准 npm 安装目录 `验收 & paths (24)` 中，原生 JS 入口解析后 Codex/acpx 版本与 Task Agent help 均退出 0；交互 Session 1 中标准 Codex sandbox 输出 `AAMP_SPECIAL_DIRECTORY_RUNNER_OK`，退出 0，未弱化 sandbox。直接从 PowerShell 调用该含 `&` prefix 的 npm `.cmd` 会被 cmd 解析失败；产品的 native JS 入口路径已通过，不能扩大为任意直接 batch 调用均通过。

### controller 故障清理与自动恢复

实测 Task Scheduler 的 RestartOnFailure 未在此环境为 controller 非零退出重新拉起。首次还发现记录过的 Feishu 子进程遗留，已增加 worker 退出前 journal 身份验证清理，再由 worker 内部执行最多三次、间隔 60 秒的 controller 恢复；等待可被 stop 或 generation 变化中止。

最终真实故障注入：2026-09-08T12:04:28.764Z 强退本轮 controller 16196；worker 13160 保持，新 controller 4896 于 12:06:18.4424193Z ready，同 generation `8d94e3ff-06db-47f1-9bd5-18cd14f803fa`，约 109.678 秒。原 controller 消失，旁观 Node 8548/7832/7672 均存活，无手动 restart。证据 `remaining-acceptance/supervised-recovery-result.json`。原生测试另覆盖 journal 留存身份的存活进程清理、等待中 stop 与重试三次后返回失败。

### 运行中更新及待收尾项

仅在 127.0.0.1 临时 registry 提供本地打包测试版本，结束即关闭，未向外发布。非法包缺少 Windows helper，product update 退出 1，原包字节不变、controller 4896 仍活且身份不变。合法包 product update 退出 0，安装版本 `0.1.1-dev.6.acceptance.1`，bindings 文件字节完全一致。证据 `remaining-acceptance/update-verification.log`。

更新后切换 Node 24 真实启动时，部分短生命周期 powershell/conhost 的初始 CIM 快照有空 ExecutablePath，故安全拒绝并耗尽恢复。`0917e60` 仅在确认同 PID、创建时间后刷新缺失元数据；退出/PID 重用返回不存在，读取拒绝或仍缺路径仍失败关闭。新增测试修复前 0/2、修复后完整 Windows 文件 31/31。真实启动与最终卸载正在复验，不提前标通过。

已测 artifact：Task Agent supervisor 包 SHA256 `f990a4bbd53625663815810c49a3a6b8b4d44c45fae386974199efcd2bb26dee`；ACP ACL 包 `fff6cf06b70db6507cf4b9678da88c0887be8e9ef4e78620f0b5d86ff59461d6`；Feishu path 包 `b85c5a932e3ee688bd0dd776e729886283a874fb2a42089ed63f34c6e6bddb80`。CIM 修复包为后续新 artifact，不能沿用 supervisor 哈希。

锁屏与注销/重新登录仍需要用户确认能通过云控制台恢复交互登录；SSH 不能替代该登录条件，未冒险注销。Win11 普通用户独立保留待验收。

### 最新产品提交 CI 与锁计时复验

`e989ec6` 的 https://github.com/ILUO/aamp/actions/runs/34227906679 六组全部成功，fail=0。每个 Node 22/24 Windows runner 的 Task Agent 257 通过/13 跳过，ACP 194/4，Feishu 115/0；macOS 分别 456/10、194/4、108/7；Ubuntu 分别 454/12、194/4、108/7。

Windows 目录 ACL 初始化原来占用了锁等待预算；实机约 3 秒初始化即使无竞争也误报占用。现仅 Windows 在 ACL 成功后开始锁等待计时。原生回归修复前失败，修复后完整绑定文件 20/20；macOS 19 通过/1 Windows 跳过。另对 CIM 缺字段最多复查五次、间隔 100ms，每次校验 PID/创建时间；原生进程测试 31/31。不过真实 Node 24 后台仍捕获持续缺路径，进一步诊断中，不能据 CI 全绿宣布实机通过。

最终待复验 Task Agent tgz SHA256 `a0eab2efab82714877666d7f3e414ef9c19e66ccc0c14bb9a291828c7e97c4a4`。Node 24 测试 PATH 补回了原 Node 22 prefix 中既有 Codex 的入口（Node 24 优先），修正的是隔离测试环境，不是新增产品兼容逻辑。专用后续任务 `6015d748-78f3-4613-a868-339aa4c5171a` 已创建分配，结果尚未验证。

### 原生句柄补查与最终复验进行中

仅 CIM 有界复查后仍缺路径时，`32af180` 打开原生进程句柄，校验其创建时间（原生 FILETIME 100ns，CIM 微秒，截去不足一微秒部分），读取句柄对应的 MainModule 路径，再复核 CIM 身份。已退出、PID 重用返回不存在；权限拒绝和存活但路径仍缺失继续报错。原生完整测试 31/31，临时回退旧模块时新补查用例 0/2，恢复修复模块。没有按进程名字放行或删除身份检查。

`e989ec6` 在纠正测试 PATH 后曾由 worker 重试恢复到 ready（PID 8500），但还没有任务结果，不能算 Node 24 业务完成。最终包 SHA256 `ad065a2240b7d423944df5720631ec009ac9532f6d6b19f768fe1bb0da94338b` 已安装，`32af180` CI run 34229593027 和真实闭环继续复验。SDK 已确认重复任务第三实例 `366808a5-2930-47f0-a26e-1c59afc706d0` 为 done、repeat_rule 为空，清理完成。

### Node 24 更新后真实闭环通过

最终包 `ad065a2240b7d423944df5720631ec009ac9532f6d6b19f768fe1bb0da94338b` 本地/Windows 哈希一致。CIM 回读 controller 13336 的 executablePath 为 `node-v24.20.0-win-x64/node.exe`；worker 16936，generation `d8647166-7c7e-48da-a820-e5674490d2a9`，绑定 1/1 ready。实际运行中未引入 Bash/WSL、降级 sandbox 或重新授权。

任务 `6015d748-78f3-4613-a868-339aa4c5171a` 在早先失败期间创建，无 ACK；最终服务启动后由 Owner 评论 `7683150085093346270` 触发。ACK `7683150127195769828`，结果评论 `7683150816017943743` 内容为 `361`。SDK 服务端回读 status=done、completed_at=1788872950000。ACP `task.received` 为 13:06:26.859 UTC，`task.completed` 为 13:09:08.516 UTC；AAMP task ID `feishu-task-6015d748-78f3-4613-a868-339aa4c5171a-d7bf1de62636c58847d9e67744ed300e`。证据 `remaining-acceptance/node24-final-result.json` 与 run 后缀 `-13336` 的 ACP 日志，errors.jsonl 为 0 字节。

这是合法更新后继续安装修复 artifact、经故障修复及 Owner 触发后取得的闭环，不是首个更新测试包一遍成功。`32af180` 的 CI https://github.com/ILUO/aamp/actions/runs/34229593027 六组全绿，执行计数与上轮 e989ec6 相同。

### Win10 卸载最终通过与剩余门禁

2026-09-08T13:14:53.9524179Z：正常 stop 退出 0，移除当前 SID 的产品计划任务，隔离 prefix 中 npm uninstall 退出 0；包目录、`.cmd` 入口、产品任务均不存在，bindings SHA256 前后完全相同，受管测试 Node 0，旁观 PID 8548/7832/7672 均存活。一次性 `AAMP-Remaining-Acceptance` 任务也已删除，测试日志/绑定/原始安装目录保留，未删除远端 Bot。证据 `remaining-acceptance/uninstall-result.json`。

首次卸载因任务 Principal 返回 `Administrator` 而非 SID 被示例安全拒绝，尚未删除任务或 npm 包。将账户名解析到 SID 后确认与当前用户完全一致，才完成卸载；README 同步这一正确校验方式。

可独立执行的非 Win11 业务、包、CI 与更新/卸载补测已完成；锁屏、注销后重新登录及登录触发仍未实测，需要能从云控制台恢复交互登录，SSH 不能替代。异常注入仅按相应受控测试层通过，不声称已撤销真实租户 token、断开测试机网络或更改企业策略。Win11 普通用户仍为独立门禁，不做完整 Windows 支持/发布结论。


## 2026-09-09 兼容范围修正（替代“仅剩 Win11”的旧结论）

本轮按用户确认修复范围审查发现的行为偏差；Windows 代理环境变量继续保留。恢复原生 Agent 扫描与手动选择，Coco 选择保持 Coco 身份及 `coco acp serve`，不自动替换为 Codex/Traex。同步修复 POSIX 注册终端输出和诊断、PATH 大小写、启动降级条件、应用 scopes/events 与 CLI/SDK/npm 配置覆盖、后台准备环境传递、Codex 登录/升级，以及 TaskAgent 更新和两个入口的无参行为。

现有 Win10/Codex 业务成功记录仍属于对应历史提交，不能直接当成本轮修复或 Win11/Coco 的验收证据。本轮已完成针对性回归、完整包测试和 Win10 原生测试，准确范围如下。真实 Win11/Coco 飞书任务闭环、普通用户及登录状态变化仍待接手机验证。

### 本轮验证结果

- 本机 Node 24.19.0：TaskAgent 全量 487 项，477 通过、10 平台跳过、0 失败；最后补充的 Codex prerelease 比较与注册输出定向 7 项通过。ACP 全量 200 项，196 通过、4 平台跳过；最终 PATH 拼接边界 4 项、类型检查和打包构建通过。
- Win10 Enterprise 22H2、PowerShell 5.1.19041.6456、Node 24.20.0：独立 `scope-repair-20260909-r2` 目录执行 TaskAgent 平台全量，292 项，278 通过、14 平台跳过、0 失败。包含扫描多个 Agent、手动选择 Coco、Node fixture 子进程执行 `acp serve`、代理传递、后台授权环境、更新状态/版本策略。该结果不是实际 Coco 模型调用或真实任务业务闭环。
- 首轮归档含 macOS `._` 元数据，导致 36 个伪测试文件失败；重新禁用元数据打包并使用全新 r2 目录后全量通过。首轮不计为有效验收。此前本机 Node 26 首轮两项 AIME 超时，隔离重跑通过；随后支持矩阵内 Node 24 全量通过。
- Win10 对最终 ACP tgz 编译产物补跑 5 项无网络断言：Windows PATH 合并、POSIX 大小写保持和 ENOENT/非 ENOENT 降级边界全部通过。
- Spec/Standards 两轮复审发现并修复后台配置丢失、不支持的 batch 入口以及预发布版本降级问题；复审通过。
- 实际打包检查确认长命令入口、Windows 多 Agent/更新模块与注册 helper 均包含在 tgz。TaskAgent SHA256：`9540d83453a2f510d09b789cde46255bf69c28c2ef33cf2371bf8cd6dd478776`；ACP SHA256：`be3deaf59a46914d9f9d10763c5b372722363472ad52450f4aa08b4c7deb1703`。
- 本轮未替换旧 Win10 业务安装，未重新授权/创建 Bot、派发真实飞书任务或进行 npm 发布。更新成功/失败后的服务恢复为受控测试；最终 npm 部分安装失败仍可能无法恢复旧文件，程序会报告恢复失败，不承诺事务回滚。
- Win11 接手方应拉取本开发分支最新提交，使用新包扫描并手选 Coco，验证真实 ACP、飞书授权及任务/附件闭环，再更新本文。原有“仅剩 Win11”结论仅限旧版本，不能覆盖本轮行为修正的实机业务边界。

### 远端提交与 CI 回读

代码修复提交 `43f8deabcfc6118ddb1a0118c00adba085e1b82c` 已推送至原开发分支。对应 [CI 34332705482](https://github.com/ILUO/aamp/actions/runs/34332705482) 六组全部 success：macOS、Ubuntu、Windows × Node22/24，包含三包测试/类型及实际打包。Windows CI 为 Server runner，不替代 Win11 普通用户与 Coco 真实业务。随后提交仅补写本段验证记录，不修改运行代码。飞书交接文档已回读 Win11 Coco 的 P0 新记录，保留接手方证据，并同步最新代码基线与测试入口。


## 2026-09-09 Agent 发现规则对齐

在前述范围修正之后，仅调整 Windows 发现规则以匹配现有 macOS：Trae 系列按 `traex > coco > traecli` 只展示第一个检测到的类型；通用 `agent` 命令执行 `login --help`，仅在退出成功且 stdout/stderr 含 `Authenticate with Cursor` 时作为 Cursor 候选。准备阶段使用同一身份检查，探针限时 10 秒；专用 `cursor-agent` 名称保持原有信任规则。扫描后的手动选择、所选 Agent 身份及 Windows 代理环境传递不变，macOS Bash 实现未修改。

验证：macOS Node 24.19.0 执行 TaskAgent 平台全量 489 项，479 通过、10 跳过、0 失败；Agent 选择与 Windows helper 定向 23 项全部通过。Win10 Enterprise 22H2（build 19045）、Node 24.20.0 在既有隔离测试副本运行同样定向测试，23 项全部通过。覆盖 Trae 三档优先级回退、非 Cursor 拒绝、stdout/stderr 识别、非零退出拒绝、准备阶段检查，以及手选 Coco 后 fixture 子进程执行与 HTTPS_PROXY 保留。Spec/Standards 审查均无发现，JS 语法检查与 diff 检查通过。本轮没有执行真实模型或飞书业务调用，不能替代 Win11/Coco 完整业务验收；上节 CI 结果属于原代码提交，不作为本次提交的 CI 结果。


## 2026-09-10 普通用户权限修复与验证边界

基于 `2aeb4a4` 修复，Windows Agent 手动选择、Trae 系列菜单优先级及代理传递保留，POSIX 产品逻辑未改。Node 24.20.0（npm 11.19.0）使用官方 Windows zip 和官方 SHA256 校验安装至标准用户 `%LOCALAPPDATA%/Programs/nodejs/node-v24.20.0-win-x64`，仅修改用户 PATH；新 SSH 会话已能发现 Node。测试目录为 `%LOCALAPPDATA%/AAMP-Standard-20260910`，未使用管理员业务安装或实际 Bot。

### 修复内容

- TaskAgent 与独立 Feishu Bridge 同步修复 ACL：只读 Owner/DACL；当前用户所有、断继承、仅允许当前用户/SYSTEM/Administrators、当前用户具备生效且可向下继承的 FullControl 时直接返回。不安全的已保护目录仍修正；使用仅含必要变更的 DirectorySecurity 写入，不重复写 Owner 或通过 Set-Acl 请求无关审计权限。
- ACP 单进程/进程树快照补齐 ExecutablePath 有界重查与原生句柄读取，保留创建时间/归属验证；查询不可用时只输出 PID 和固定错误类别，不按不可信 PID 杀进程。清理测试等待实际清理链路结束。
- Agent 发现测试隔离 PATH 与相关覆盖配置；符号链接测试仅在 Windows 实际出现 EPERM/EACCES 时标记能力不足跳过，产品对符号链接的拒绝规则保留。

### 结果

| 环境与检查 | 结果 |
| --- | --- |
| Win10 22H2 build19045 标准用户修复前重复 ACL | 第1次成功，第2/3次 SeSecurityPrivilege 失败；独立 Bridge 私有写入也失败 |
| 同账号修复后两套原生 ACL 回归 | 均通过：连续3次保护，以及多余主体、拒绝规则、InheritOnly 不安全权限的修正与再次调用 |
| 同账号 TaskAgent 定向（选择/helper/remote-pending/ACL） | 29项：17通过、11失败、1符号链接能力跳过；失败均源于 CIM 拒绝访问，包括1个父测试汇总 |
| 同账号 Feishu Bridge 全量与类型 | 116通过、0失败、0跳过；tsc通过 |
| 同账号 ACP 身份/归属确定性用例 | 13通过，包含实际 PowerShell 中模拟缺字段、退出、PID复用的用例；不等同于真实 CIM 查询和生命周期通过 |
| 同账号三包实际 pack + TaskAgent 安装 help | 全通过；两Bridge类型/构建、defaults同步检查通过 |
| macOS Node24 TaskAgent全量 | 490项：479通过、11平台跳过、0失败 |
| macOS Node24 ACP全量串行复跑 | 203项：197通过、6平台跳过、0失败 |
| macOS Node24 Feishu Bridge全量 | 116项：108通过、8平台跳过、0失败 |
| Spec/Standards静态审查 | 均无发现 |

macOS 初次并行跑三包时，原有 POSIX TERM-resistant fixture 用例超时并留下测试子进程；精确核对后清理，单条重跑及整包串行复跑通过，没有调整该 POSIX 测试超时或产品逻辑。保留初次失败，不能将其记为通过。

### 尚未解除的环境阻塞

该标准用户 SSH 会话为 Medium/NETWORK 令牌，仅有基础特权；执行 `Get-CimInstance Win32_Process` 查询当前 PowerShell 自身即报 `0x80041003 Access denied`，`Get-WmiObject` 也拒绝，而原生 .NET 可以读取自身镜像。此现象独立于 ACL 与 ExecutablePath 暂缺，不作为已修复的元数据竞态。修复前 ACP EPIPE 用例在该权限下失败并留下 fixture，已核对专属 PID、启动时间和镜像后清理。修复后没有绕过身份校验、授予额外系统权限或将依赖真实 CIM 的测试改为跳过。

继续验证需要一个能正常查询本机 CIM 的普通用户会话；随后重跑 TaskAgent/ACP 全量、真实进程清理和多绑定/重启。Win11 接手方先保留未提交改动、对齐含本节修复的最新分支，再用本地普通用户终端复测。Win11/Coco pack与真实飞书矩阵仍按其原计划推进，不能用本轮 Win10 打包帮助入口代替授权/任务/附件闭环。本轮未取得对应新提交的远端 CI 结论，不沿用旧提交 CI 成功。

本轮普通用户产物 SHA256：TaskAgent `c9c4d26f44c5f0bbb4a5d0f302ebe9cb7cbb36f2895eaeac1ef12a56a6fdb094`；ACP `88e47c8f6c950ece0646e93eb77a4aeaec241503913dcc574653ae1954350f52`；Feishu `ed9e9a4426a34f668f05f472b12364476d9623cfd5830a64d3856af01945acd8`。


## 2026-09-10 Windows 11 / Coco：Codex 接手与原生复现

- 记录 ID：W11-COCO-20260910-CODEX-01；时区 Asia/Shanghai。
- 执行器为 Codex，被测入口为原生 Coco；未以 Codex 的运行结果替代 Coco。
- 实际代码：a8b68b9860278bd7eb884cf0f5c5fbd33d8e8a25。fetch 后远端同 SHA，开始前工作区干净；本轮没有修改产品代码。
- 环境：Windows 11 专业版 10.0.26200 x64，真实用户中完整性、Administrators deny-only、交互 Session 1；Node 24.19.0 / npm 11.17.0；Coco 0.121.0，build 5c27ca56。
- Codex 沙箱账号的 CIM 查询拒绝访问；切回真实用户运行的只读盘点成功，未提权为管理员、未修改 WMI/企业策略。两种执行环境的结果分别记录。

| 项目 | 本轮命令/输入 | 本轮结果 |
|---|---|---|
| A03 npm 原生包入口 | Task Agent 包内：node --test --test-name-pattern="native Windows npm package shim" test/runtime-package-executable.test.mjs | FAIL，exit 1；执行 1、通过 0、失败 1、跳过 0。错误：'C:\Program' is not recognized as an internal or external command。调用使用 C:\Program Files\nodejs\node.exe；npm exec 内部将可执行路径作为命令文本，未保护空格边界。产品 materialize 同样传 process.execPath，尚未修复。 |
| A03 ACP 原生身份夹具 | ACP 包内：node --import tsx --test --test-name-pattern="native ACP (identity\|tree) recovers a live image" src/acpx-client.test.ts | FAIL，exit 1；两项均在夹具对 CIM 对象 ExecutablePath 赋值时出现 ReadOnlyCIMProperty，尚未进入预期的 native handle 回退验证；不得据此称产品身份校验失败或通过。 |
| A01 Coco 启动 1 | coco.exe --version；shell:false，stdin EOF，保留原环境 | 正常 exit 0；首字节 11606ms，退出 11620ms。 |
| A01 Coco 启动 2 | coco.exe acp serve --help；同上 | 正常 exit 0；首字节 8558ms，退出 8605ms。 |
| A01 Coco 启动 3 | coco.exe --version；同上 | BLOCKED：145621ms 无 stdout/stderr，未正常退出；核对 PID、父进程、创建时间和路径后结束该测试进程。用户原有 Coco PID 16916 仍存活。该退出码不算 Coco 自行失败退出。 |

历史日志回读（非本轮全量重跑）：此前本机 p3 日志 Task Agent 278 pass / 1 fail / 15 skip，ACP 197 pass / 2 fail / 4 skip，Feishu 116 pass。此前 acpx 日志包含会话、计算391、读取49及写文件；取消只有 nothing to cancel，不能作为运行中取消通过证据。

状态：A01 部分取证；A02 运行中取消/完整当前提交会话仍待复验；A03 失败且 Node22 尚未覆盖。B/C/D 的真实业务及桌面生命周期本轮 NOT_RUN，无本轮 Task ID、新 Bot/OAuth 或包哈希。不把以上状态计作完整 P1/P2 通过。

下一步：对 Coco 慢启动采集独立终端与受控子进程的对照，定位等待环节；不得仅增大超时后宣称修复。修正 npm 路径边界及 ACP 只读 CIM 夹具后重跑三包与 Node22/24。Coco 验证通过前不切换其他 Agent；安装必须保留扫描后用户选择流程。未升级 Coco，未合并 PR，未 npm 发布。

本地原始证据：C:\codex\aamp-evidence-20260910 下 task-shim-repro.log、acp-cim-repro.log、coco-timing.jsonl。上表完整列出可跨主机回读的最小复现、错误及数值；原始本地文件未上传，不能视为远端可访问附件。本节提交 SHA 与被测代码 SHA 分开，以 git log 查询本节提交。


## 2026-09-10 Windows 11 / AIME：用户改验与认证后 ACP 预检

- 执行器 Codex；被测 AIME 为 remote Agent，用户已明确切换目标。正常产品流程保留“扫描后由用户选择”，未修改绑定类型。Coco 的既有失败保留。
- 产品代码 a8b68b9860278bd7eb884cf0f5c5fbd33d8e8a25，上一轮验收记录提交 b048188；本轮仍未修改产品源码。
- 真实用户身份查询确认租户符合 AIME 条件；将服务端返回的实际 tenant_key 用于产品 runWindowsHelper('__discover-agents')，输出 codex、coco、aime。没有伪造租户门禁；此为能力预检，不代替未来新 Bot 的身份检查。
- 独立预检目录 C:\codex\aamp-aime-preflight；安装命令 npm install --prefix C:\codex\aamp-aime-preflight --registry https://bnpm.byted.org @tengchengwei/aime-acp@0.1.1-dev.1 --fetch-timeout=20000 --fetch-retries=0 --no-audit --no-fund。安装 exit 0、347 packages，入口 help 成功。不是三包重新 pack/产品安装已通过。
- 初次 auth status/doctor 为 unauthenticated/AUTH_REQUIRED；用户完成页面授权后，通过包原生 auth login --complete --resume-token-stdin --site cn --json 完成登录，exit 0。恢复凭据仅本机保存，未写入日志/Git/飞书；页面成功与本机认证完成分别验证。
- 最终 auth status：authenticated；doctor：compatible=true、authenticated=true、aimeReachable=true，均 exit 0。固定 aime-acp 0.1.1-dev.1、bytedcli 0.123.0、ACP SDK 0.28.1；Node 24.19.0。

| 原生 ACP 操作 | 实测证据 | 判定 |
|---|---|---|
| initialize | 2026-09-10 15:44:36 CST，1594ms，protocolVersion=1、agentInfo aime-acp 0.1.1-dev.1 | PASS |
| session/new | 15:44:37，session 8cfcf1cc-e505-4493-8341-3ad6371aa0b3 | PASS |
| session/prompt：17×23，仅整数 | 15:44:47 返回 end_turn；文本“收到，我来计算17乘以23的结果。17 × 23 = 391” | 数值正确；严格仅整数断言 FAIL，不改测试冒充全通过 |
| 完成计算后 stdin EOF | 15秒未退出，stderr 0字节；仅通过持有的测试子进程句柄终止，SIGTERM | 未满足本次15秒退出窗口；根因未定，不宣称永久挂死或已经修复 |
| 仅 initialize 后 EOF 对照 | 15:46:12，握手1956ms，随后约74ms exit 0，stderr 0字节 | PASS；退出延迟与远程任务路径相关，尚未进一步定位 |

本次没有向 AIME 提供私有文档、凭据、本地文件或 MCP；只发送无敏感数据的计算请求。AIME 的远程任务会话不是飞书 Task，本次没有 Task ID、ACK、飞书服务端完成证据。没有验证运行中取消或附件；按现有设计 AIME 不支持本地文件/附件交付，不能算这部分 Windows 本地能力通过。

证据目录 C:\codex\aamp-evidence-20260910：aime-auth-status.json、aime-doctor.json、aime-acp-probe.jsonl、aime-acp-initialize-only.jsonl，及对应探针脚本。上述表格包含供跨主机回读的完整最小结果；原始文件仅本地保留。下一步：定位远程任务后的退出收尾、修复/复验此前 P2 npm 路径和 CIM 夹具问题，再进入正常产品扫描选择及专用 Bot 业务。未合并 PR、未发布 npm 包。


## 2026-09-10 Win11 Node22/24：Windows 前置修复与 AIME 标准澄清

产品源码提交：3930c5a174841483f35002a949e063c8394e7790。本节是后续记录提交，不与被测代码 SHA 混淆。

用户澄清：返回正确391时附带说明/算式符合预期，远程任务完成后适配器常驻也符合预期。旧探针原始观测保留，但不是失败门禁；未为此改动 AIME、ACP取消/结果协议或驻留行为。

最小修复：npm 在 Windows 内部将 executable 当作 cmd 命令文本，单层引号仍被消费；双层命令引号保留 C:\Program Files\nodejs\node.exe 的边界，POSIX 保持原路径。原生 npm 包参数/中文/特殊符号/CRLF/stdin/exit 用例红绿复验通过。ACP 两项夹具把原生 CIM 对象只读字段改为脱离对象的字段视图，读取 owner 时先重核创建时间再调用真实 CIM；产品身份规则未改。独立代码审查未发现 actionable findings。

环境分离：首次从 Codex PowerShell7 继承模块路径时，两 Bridge 出现 Get-Acl/CouldNotAutoloadMatchingModule，不能算产品功能失败。对照原生 PowerShell5.1模块路径成功；仅给本轮子进程设置 PSModulePath 为 WindowsPowerShell/v1.0/Modules，保留代理和其他环境，未改系统设置。失败日志保留在 node24，复验存 node24-ps51。Task Agent 原轮已全量通过，未无故重跑。

Node22 首轮 Task Agent 为278通过/1失败/15跳过，唯一失败是测试夹具 npm pack 超过30秒。锁定 Node22/npm10.9.7 的定向复验通过；随后仅重跑 Task Agent 全量，结果见表，原失败日志保留。未延长测试超时、未跳过原用例。

Node24=24.19.0/npm11.17.0；Node22=22.22.2/npm10.9.7（官方便携 zip，SHA256 7c93e9d92bf68c07182b471aa187e35ee6cd08ef0f24ab060dfff605fcc1c57c）。真实用户中完整性、Session1、Win11 26200；PowerShell5.1为系统原生模块。

| 运行时 | 包 | 实测测试汇总 |
|---|---|---|
| v24.19.0 | aamp-feishu-task-agent | ℹ tests 294; ℹ pass 279; ℹ fail 0; ℹ cancelled 0; ℹ skipped 15 |
| v24.19.0 | aamp-acp-bridge | ℹ tests 203; ℹ pass 199; ℹ fail 0; ℹ cancelled 0; ℹ skipped 4 |
| v24.19.0 | aamp-feishu-bridge | ℹ tests 116; ℹ pass 116; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0 |
| v22.22.2 | aamp-acp-bridge | # tests 203; # pass 199; # fail 0; # skipped 4 |
| v22.22.2 | aamp-feishu-bridge | # tests 116; # pass 116; # fail 0; # skipped 0 |
| v22.22.2 | aamp-feishu-task-agent | # tests 294; # pass 279; # fail 0; # skipped 15 |

三包实际 npm pack 均 exit0，两 Bridge 类型检查均 exit0，共享 defaults 校验 exit0。Node24 Task Agent tgz 已装入独立 C:\codex\aamp-aime-run\installed，Node22 对应 tgz 安装在 C:\codex\aamp-aime-run-node22\installed，两者分别用对应 Node/npm 安装后实际 .cmd help exit0。

| artifact 来源目录 | 文件 | SHA256 |
|---|---|---|
| node24 | larktask-aamp-feishu-task-agent-0.1.1-dev.6.tgz | 3684aaeb19c53506b78df0956bf0591a65c4637fccd80497771091c6c9d43654 |
| node24-ps51 | zengxingyuan-aamp-acp-bridge-0.1.29-dev.0.tgz | 1d57839d591cd8807c652e853a75c9e5261b8703c19fcba8e9b140a63a604983 |
| node24-ps51 | zengxingyuan-aamp-feishu-bridge-0.1.52-dev.5.tgz | dc481f34dae593e4bae22ac60dd26640420c48d54c6d2e1fd35f30f3cf4840a8 |
| node22-ps51 | larktask-aamp-feishu-task-agent-0.1.1-dev.6.tgz | 3684aaeb19c53506b78df0956bf0591a65c4637fccd80497771091c6c9d43654 |
| node22-ps51 | zengxingyuan-aamp-acp-bridge-0.1.29-dev.0.tgz | 1d57839d591cd8807c652e853a75c9e5261b8703c19fcba8e9b140a63a604983 |
| node22-ps51 | zengxingyuan-aamp-feishu-bridge-0.1.52-dev.5.tgz | dc481f34dae593e4bae22ac60dd26640420c48d54c6d2e1fd35f30f3cf4840a8 |

原始证据 C:\codex\aamp-evidence-20260910；本表供跨主机回读，原始文件未作为公开附件上传。Node24 的产品安装使用 node24 Task Agent 与 node24-ps51 两 Bridge，明确开启本地包覆盖，关闭自动更新保持被测 SHA；不设默认 Agent、不跳过登录，文档 CLI 与新 Bot 配置隔离。CI 为单独证据，不能用本地通过代替三平台 CI。下一步正常 install / 扫描选择 AIME / 专用新 Bot 授权和任务闭环。未合并、未 npm 发布。


## 2026-09-10 Win11 / AIME：新 Bot 与两轮真实任务闭环

被测源码3930c5a174841483f35002a949e063c8394e7790；包及哈希沿用上一节，未修改产品代码。实际 Node24、原生 Windows PowerShell5.1、普通用户 Session1；显式前台运行，未把前台常驻冒充计划任务后台生命周期通过。

- 用户创建专用新 Bot：70Win11-Task / cli_aa28d75997f89be9。注册和用户 OAuth 两阶段分别收到 CLI 成功；独立配置 profile aamp-feishu-task-cli_aa28d75997f89be9，whoami 校验 identity=user / tokenStatus=ready。未保存凭据到证据或 Git。
- 正常 install 扫描菜单出现 codex、coco、aime，按用户此前明确选定的 AIME，通过方向键和回车选择；未设默认 Agent、未使用 --agent、未修改绑定 JSON。绑定ID f9af1493-218b-4d62-93f7-02fd85d315c3，远程ACP配对成功，产品报告启动1/1。
- 启动阶段日志曾报 agent.session.deferred / saved ACP session missing or stale；保留该观测，随后两轮任务正常完成，未手工删会话或修改AIME。不能据此宣称提示根因已修复。

真实 Task GUID b01d6406-b745-49dd-9836-119b2f1e42b9，显示ID t39218269，标题[W11-AIME-20260910] 普通任务计算验证。链接：https://applink.larkoffice.com/client/todo/detail?guid=b01d6406-b745-49dd-9836-119b2f1e42b9 。以下时间为UTC。

| 场景 | 证据 | 判定 |
|---|---|---|
| 普通任务17×23 | task_create事件f9b9c9d1b207150c1cdf57c18055f169；08:43:43.937 AIME收到，08:43:46.939 ACK；返回summary“计算结果：17×23=391。简要过程：17×(20+3)=340+51=391。”；08:45:13.920 task.completed，Bridge确认结果评论和完成；服务端status=done / agent_task_status=4 / completed_at=1789029914000 | PASS |
| Owner在已完成任务补充19×19 | 用户评论ID7683825390837615556；task_comment事件a9ad50bea3c7f196a8b46b7f04d272e7；08:46:54.794建执行记录，ACK/结果评论各一次；返回summary“新的计算结果：19×19=361。简要过程：19×19=(20-1)×(20-1)=400-20-20+1=361。”；08:47:53.756完成；独立服务端读取done / agent_task_status=4 / completed_at=1789030073000 | PASS，仅补充执行 |

两个AAMP任务ID均为feishu-task-加上述GUID-加各自事件ID，记录了各自ACK、resultHandled与feishuCompleted标记。Bot自己的评论事件被ignored reason=comment_authored_by_current_app忽略，未触发递归执行。AIME doctor复查compatible/authenticated/aimeReachable均true。

本轮证明除Codex外的AIME可经真实AAMP/飞书链路处理普通任务及Owner后续补充。Owner补充用例不是B02完整通过：尚未覆盖缺输入need_help、中间重启和非Owner拒绝；取消、父子/提醒重复完整矩阵、桌面后台/锁屏/注销恢复仍待验证。AIME远程本地文件/附件能力按既有边界记录，不计为Windows本地附件通过。未合并或npm发布；当前提交三平台CI仍未取得结论。

本地证据：C:/codex/aamp-evidence-20260910/aime-business-state.json、aime-basic-task-final.json、aime-followup-task-final.json；原始Bridge日志位于当前用户.aamp/logs/runs/1789028318172-13600。提取证据不包含认证token或内部思考步骤；原始文件未公开上传。前台运行保留供后续验收。


## 2026-09-10 Win11 / AIME：完整矩阵推进检查点一

用户已明确持续完成全部测试。保留交接A01–D02及交付要求的完整范围，AIME远程本地文件限制不替换为Codex结果。当前产品代码3930c5a，记录基线44baed5；工作树源码无新增修改。以下为真实Win11普通用户Session1，时间UTC。

| 用例 | 本轮结果及精确证据 | 当前判定 |
|---|---|---|
| A02运行中取消 | Node24会话114ee9f2-b793-4ca7-8805-c12d04f6b3d1；09:27:55.179收到agent_message_chunk，55.180发session/cancel，55.238 cancelled，exit0/stderr0。Node22会话b2fcfb06-12e7-4484-b743-38eea2e0491c；09:28:26.350收到输出，26.352取消，26.453 cancelled，exit0/stderr0。原生shell:false独立适配器，无本地工具/MCP | 原生取消PASS；本地文件能力见B05限制 |
| B02 | Task56af83c7-46f5-49bf-9b16-6f3f6f09eab4，09:12:22 need_help，服务端todo/3。停止前台并正常后台重启后，第二账号真实评论事件ce147dd9955b929d2b3cc23025804c30及fd2816a44359ada0c93dc2bcfc9c466f均comment_author_not_app_owner，用户确认收到拒绝。Owner评论7683835697697934293提供N=11，事件db56a028c0240b64a6d50d7c545f37e0，ACK与结果回写成功，37×11=407；服务端done/4，completed_at=1789032637000 | PASS |
| B03 | 父528615d4-7bf8-479a-aace-dfce85abe09d；子A8474cb3c-db1b-4c8b-a284-29437a6e9598，子B52017bec-0d7d-40e3-a7fa-e71d22fa75a3。父子准备后分配Bot，assignment事件按既有allowlist忽略；Owner评论7683835701158235097触发，事件6fa47b80c538481fd11eced1ee7df3c6，结果A=84/B=104/合计188。三个Task服务端均done/4，完成时间1789032543000/1789032497000/1789032498000 | PASS |
| B04单次 | 4fabed85-b8a9-428c-ad1e-1b2096016739，创建因已配置reminder延迟到真实task_reminder_fire，结果29×7=203，服务端done/4/completed_at1789032728000 | PASS |
| B04重复 | 第一8ec86003-d83a-4d42-bf55-c177d8fb3374，自动生成第二0887fdbd-506b-4de9-b2a5-e2662f2435b7。第二继承每日repeat及reminder，due从1789119060000提前为1789033037000；两次均真实task_reminder_fire、ACK/结果217/服务端done。第三753d02ae-f91f-4a6d-a4c5-295091d8bc81已清除repeat_rule与提醒并由验收执行器关闭；回读done/reminders=null/repeat_rule空/next_task_guid空。非24小时稳定性测试 | PASS |
| B05远程附件 | 8c4b6e16-b3f4-435b-b0b8-85217ffa8417；106字节UTF8 CRLF CSV、唯一marker w11-aime-b05-20260910-f43a，值17/23/9，中文空格目录和文件名；真实输入附件GUID490ec5d3-6d50-4aad-95e2-b450c7b338d5。Owner评论7683837113363664084触发后Bridge在派发前记录remote attachments blocked category=input_attachment count=1，服务端todo/3。没有AIME读取、输出CSV或文件交付 | 远程拒绝边界PASS；原本地CSV闭环UNSUPPORTED，不宣称完成 |
| B06特殊目录 | 原Node24 tgz实际安装到C:/codex/aamp 特殊 & (验收)/installed，安装exit0，Node直达已装原生入口help exit0；已有原生npm参数/中文/CRLF/stdin/exit测试通过。B05输入真实上传成功 | 安装和输入PASS；远程输出文件不支持 |
| B07边界 | 已审查src/task/runtime.test.ts真实Windows临时文件truncate到52428799/52428800/52428801字节，受控API断言前两完整内容上传、超限上传次数0；Node24全量日志131–133行分别128.3706/159.9961/53.6951ms均通过，Node22对应全量通过 | 原生NTFS+受控API PASS；未执行真实云大文件传输 |
| C01 | 前台13600停止后原Coco16916（2026-09-09 22:48:39）存活。无TTY start失败input.setRawMode is not a function，保留run1789031771775-1676；交互菜单选择已存绑定后后台ready PID22792、generation27a2abf7-da07-48ba-82eb-e1578f1a32b4。启动终端旧controller24468已退出，后台继续存活；退出后Owner评论触发的B03完整完成，另后台任务f09588cd-f2fa-45e8-81ab-11dce985e4a6返回533/done | PASS；无TTY失败单独保留 |
| C02 | 首条731因处理时间早于锁屏未计通过。用户按提示保持锁屏并从手机发送第二条；WTSINFOEX在17:44:34及17:53:50 CST均Session1/flags0=locked。复核事件5781108698c84777e9b9630875741837于09:49:33.081收到，09:51:05.093完成47×19=893；独立服务端回读done/4/completed_at1789033864000。用户确认手机已发送，已提示可解锁 | 锁屏执行PASS；解锁后的下一轮验证待用户恢复桌面 |
| C06无效更新 | 本机回环registry16736/49193，fixture0.1.1-dev.7缺bootstrap/windows-entry.mjs；正常update exit1明确保留当前版本。拒绝前后PID22792、创建时间、generation及ready未变，仍0.1.1-dev.6；bindings SHA256 1C30F78DB97DA250F88C87859765633B71D49FE7ABCC3A5D917B1BCD07E669C2 | 无效包PASS；有效包尚未执行 |

原生锁屏状态定义依微软文档：https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/ns-wtsapi32-wtsinfoex_level1_w 。观察脚本只读取当前session的状态字段，不采集用户名/域名。

CI：API回读run34457377857，head_sha44baed5cc34fdb0f531afda1c77c5b406ac24fcd，Feishu Task native platforms总体completed/success。随后jobs接口再次限流，六job细项待回读；不沿用旧提交结果。链接https://github.com/ILUO/aamp/actions/runs/34457377857 。

当前仍需C02解锁确认、C03/C04实际注销登录、C05原生故障恢复及三次耗尽/等待中stop、C06有效更新和后续业务、C07最终卸载、D01/D02逐项证据归档及多绑定、Node22完整运行补齐、CI作业/计划/PR最终审计。用户已确认能配合锁屏/注销与第二账号，注销前必须先保存并同步检查点，由用户自行退出和恢复登录；不自动注销承载Codex的会话。

证据位于C:/codex/aamp-evidence-20260910：b02-need-help-before-restart.json、aime-cancel-22.jsonl、aime-cancel-24.jsonl、c01-background-readiness.json、matrix-evidence-1789033537804.json、matrix-evidence-1789034059132.json、session-lock-observations.jsonl、update-fixtures/before-invalid.json和after-invalid.json。仅上传本节安全字段，运行日志/原始profile/worker环境/授权链接不入Git。


## 2026-09-10 Win11 / AIME：故障恢复与用户跳过注销

用户明确要求“注销这个跳过吧”：C03及C04中必须注销/重新登录的步骤标记USER_SKIPPED，不计PASS；当前会话继续，其余用例仍执行。C02解锁后继续操作正常，锁屏结果893已在上节记录。

C05真实故障：18:02:17 CST持有controller22792进程句柄，校验SID、创建时间、路径、父worker28828和generation后只终止该控制器。worker存活并清理journal后进入默认60000ms等待。第1次重启controller30000在Agent准备阶段command timed out，日志run1789034771858-30000保留；第2次重试controller23752（18:07:49.227 CST创建）恢复ready，仍由原worker28828承载，generation及bindings SHA256均未变。不得将60秒重试间隔写成总恢复时间；日志清理耗时较长。原Coco16916始终存活。

恢复后Owner评论7683846625722207450触发事件bb9781c43cdb9a87da8ed070fad85f72，Task f09588cd-f2fa-45e8-81ab-11dce985e4a6。10:09:17.652Z收到，10:10:13.270Z完成53×17=901；ACK/结果/完成标记齐全；独立服务端done/4/completed_at1789035012000。实际恢复及后续业务PASS，首轮超时为保留观测，未声称根因修复。

C05隔离原生worker测试使用已安装代码，真实spawn专用失败子进程，未注入runOnce/wait或缩短默认60000ms。等待中stop：1次启动，3923ms返回0，观察者存活。三次重试耗尽：四个controller PID6392/28448/28668/24764，总200323ms，三条retry 1/3、2/3、3/3日志均60000ms，最终返回23，不再启动第五次，观察者存活并由脚本持有句柄清理。证据native-worker-probe-o2fLab/evidence.json=result PASS。首次验收脚本因Windows ESM绝对路径导入失败，在任何spawn前终止；改为file URL后实际执行通过，非产品改动。

本地证据c05-before-crash.json、c05-after-recovery.json、matrix-evidence-1789035163910.json、native-worker-probe-o2fLab/evidence.json。login-after-20260910-180950.json只是复用只读快照脚本产生的文件名，并无注销发生，正式证据c05-after-recovery.json已明确scope。

D01/D02覆盖已逐项对照测试源和Node24/Node22最终日志，见本地D01-D02-coverage-audit.md。缺CLI/缺profile/缺scope/过期token均为受控helper测试，不撤销真实授权；CIM错误/PID身份变化/foreign SID/stale generation防误杀受控覆盖，企业策略与多绑定真实验收不能由这些单测替代。

CI精确记录提交61b2692对应run34463388746，公开运行页面标题确认SHA、整体Success；显示六组平台/Node矩阵及六份产物。API限流，匿名作业片段404，六job逐项详情尚未取得，保留待核。页面有六条GitHub Actions Node20运行时弃用警告。https://github.com/ILUO/aamp/actions/runs/34463388746

C06有效fixture dev8正常update已经开始，结果和后续业务尚待验证。当前尚未最终卸载，未合并或npm发布。

C06有效更新实际结果：FAIL，更新命令exit1。有效fixture dev8安装成功，bindings SHA256保持1C30F78DB97DA250F88C87859765633B71D49FE7ABCC3A5D917B1BCD07E669C2，但后台恢复未完成：前两轮AIME准备command timed out，第三轮run1789035523041-14504记录Cannot verify Windows process28692; refusing cleanup。更新调用方另报计划任务查询30秒超时及“更新已安装；后台恢复失败”。当前安装仍dev8，不能宣称回滚或业务恢复。worker29636/controller14504及该子进程仍存在，原Coco16916存活；保留现场继续排查，未绕过身份保护或启动重复实例。

排查发现首次windowsIdentity查询异常被catch为undefined，后续采样直接返回、停止拒绝清理；此为待复现的源码线索，尚未修复。独立AIME auth/doctor约2.25/2.09秒通过；复用worker环境时约9.06/2.12秒也通过，不能断言登录失效。完整状态保存在本地C06-FAILURE-CHECKPOINT.md，原始环境和认证数据未上传。

## 2026-09-10 Win11/AIME 最终本地复测与清理（远端交付待完成）

产品提交为 d626d3c295bf3ceb453c45ade91505afc000aa71。现场复核时间 2026-09-10T19:26:27.9219000+08:00。本节和顶部结论覆盖旧段落的“待执行”状态；失败经过继续保留。原用户选择AIME代替Coco、接受额外解释文字与任务后驻留、跳过注销的决定不变。

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

### 修复与回归证据

d626d3c只修改Task Agent控制器及两个测试文件：活进程身份采样缺失时保留原始错误并拒绝；启动返回前等待第一次已验证采样。原先错误被吞掉或首次采样尚未完成即可返回的缺陷均先有失败复现；未放宽身份清理、Owner或取消规则。独立审查指出测试子进程可能泄漏，已增加独立30秒寿命。Node22/24完整Task Agent测试、配置同步和实际pack结果分别保存在 identity-fix-validation/node22-ps51-task-recheck/summary.json 和 node24-ps51-task-recheck/summary.json。Bridge源码未因本修复变化，原三包基线结果保留，不能据此替代新提交的跨平台CI。

真实wrapper取消证据：aime-wrapper-cancel-22.jsonl、aime-wrapper-cancel-24.jsonl；均在agent_message_chunk之后发送cancel，返回cancelled且进程退出0。D02多绑定补证：multi-binding-readiness-F445ik/evidence.json（Node22）和 multi-binding-readiness-o0izrr/evidence.json（Node24），部分集合/不同绑定/旧generation均false，同一集合逆序true；调度器及身份为受控注入。

### C06有效更新复测

本地fixture包0.1.1-dev.9基于d626d3c构建，仅测试版本元数据变化，未npm发布。tgz SHA256为0257cc44baa2a4b76ce41062d3d921b9f2acbad702d447b9f2fe6080d29b5fc7。通过正常update从dev8更新，命令退出0，恢复ready。update-fixtures-identity/after.json记录实际安装controller与源码SHA256均为6755342B69F78B32C3B496D38E8F728DCB8CB6B21CBB6F2485CF1F24CBE7A409；绑定未变化。

更新后真实任务f09588cd-f2fa-45e8-81ab-11dce985e4a6，Owner评论7683863562703359250，事件6869933c3e3b562eb82727d1731b2476：2026-09-10T11:15:02.030Z收到，11:16:06.152Z完成，61×13=793；ACK、结果、完成记录齐全，服务端done/4，completed_at=1789038965000。证据matrix-evidence-1789038989068.json。dev8初次恢复失败和间歇AIME准备超时仍为历史事实；后续同预算prepare探针通过不能证明间歇超时根因已修复。

### C07最终状态

c07-uninstall.json记录三个隔离安装目录正常卸载退出0、验证归属后移除本产品计划任务；保留远端Bot、绑定和本地证据。c07-final-verification.json再次独立查询确认计划任务0、安装入口0、受管产品进程0、测试registry服务0，原Coco PID16916创建时间匹配且存活。绑定SHA256保持1C30F78DB97DA250F88C87859765633B71D49FE7ABCC3A5D917B1BCD07E669C2。不要依据旧失败检查点重启已卸载服务。

全部脱敏本地证据根目录为C:/codex/aamp-evidence-20260910。该目录包含测试脚本、日志和结果，不是额外产品包。本轮只把所需摘要写入仓库文档，不把整个目录提交。自动审批先后拒绝验收记录推送与单独代码推送，尚未上传d626d3c或本节；也拒绝了可选关闭B05负例任务，已放弃该清理动作，任务保持待确认。当前没有测试后台服务在运行。

## 2026-09-10 授权推送后的三平台CI核验

用户明确确认推送后，远端分支已回读为111f154f14b7090d5815cec3cc65d7daf686ac80，包含产品修复d626d3c295bf3ceb453c45ade91505afc000aa71。此前自动审批拦截已由用户授权解除，原段落保留为历史经过。

[CI run34471995377](https://github.com/ILUO/aamp/actions/runs/34471995377)实际head_sha为111f154；六个job逐一回读成功：

| Job | ID | 结论 |
|---|---|---|
| native (windows-latest, 24) | 102853809820 | success |
| native (macos-latest, 24) | 102853809919 | success |
| native (ubuntu-latest, 24) | 102853809972 | success |
| native (windows-latest, 22) | 102853809975 | success |
| native (ubuntu-latest, 22) | 102853810045 | success |
| native (macos-latest, 22) | 102853810061 | success |

每组Task Agent平台测试、ACP测试与类型、Feishu测试与类型、三个实际包pack均为success；Windows两组另有PowerShell5.1安装后.cmd help成功。日志已确认Windows两组首次身份采样测试实际通过，没有SKIP；Windows Server CI仍不替代Win11普通用户。完整job/step回读保存在current-ci-jobs.json，run回读在current-ci-run-final.json，日志归档ci-34471995377-logs.zip。

本次追加只更新验收文档及执行计划；产品内容与通过CI的111f154相同。若文档推送触发额外CI，其实际结果在PR/飞书交接同步时再次核对，不将尚在运行的job声明成功。AIME本机文件UNSUPPORTED、用户跳过实际注销/登录、间歇准备超时历史保持不变；测试服务已卸载，绑定及原Coco保留。


CI日志计数（每组失败均为0）：

| 平台 / Node | Task Agent通过/跳过 | ACP通过/跳过 | Feishu通过/跳过 |
|---|---|---|---|
| windows / 22 | 284/14 | 199/4 | 116/0 |
| windows / 24 | 284/14 | 199/4 | 116/0 |
| macos / 22 | 482/12 | 197/6 | 108/8 |
| macos / 24 | 482/12 | 197/6 | 108/8 |
| ubuntu / 22 | 480/14 | 197/6 | 108/8 |
| ubuntu / 24 | 480/14 | 197/6 | 108/8 |

Win11本地Task Agent为283通过/15跳过，Windows CI为284/14；唯一额外本地跳过是普通用户无创建符号链接权限的可信配对文件用例，CI对应断言实际通过。本轮未开启Developer Mode或修改权限。PR正文及飞书交接摘要revision28均已同步回读，包含正确的源码/CI链接和UNSUPPORTED、USER_SKIPPED边界。


## 2026-09-10 npm dev 发布完成

用户明确授权发布 dev。发布源码提交为 `18d267f`，基于验收产品代码 `d06c14a`，只更新三包版本、TaskAgent 精确依赖引用及相应测试期望。发布账号为 `zhengqilin`，通过 npm 官方浏览器 2FA 逐包认证；未合并开发分支。

| 源码包 | 发布目标 | 版本 / 标签 |
|---|---|---|
| @zengxingyuan/aamp-acp-bridge | @zhengqilin/aamp-acp-bridge | 0.1.29-dev.1 / dev |
| @zengxingyuan/aamp-feishu-bridge | @zhengqilin/aamp-feishu-bridge | 0.1.52-dev.6 / dev |
| @larktask/aamp-feishu-task-agent | @larktask/aamp-feishu-task-agent | 0.1.1-dev.8 / dev |

TaskAgent 的 `latest` 保持 `0.1.0-dev.171`。两个 Bridge 是当前账号下的新包；npm 为新包自动生成的 latest 不属于 TaskAgent 稳定渠道变更。TaskAgent 使用精确版本引用两个 Bridge，AIME ACP 的原有内部 registry 引用保持不变。

发布检查：两个 Bridge TypeScript 构建通过；Bootstrap/defaults 回归 70/70 通过；runtime-package-executable 定向测试此前 12 通过、1 跳过；同步默认值与 git diff 检查通过。三个公开 registry 版本元数据均可读取，实际下载 tgz 的 SHA512 与发布前产物逐一完全相同；从 npm 在隔离目录安装 TaskAgent dev.8 并执行帮助入口成功。本轮没有重跑 Windows 实机业务；实机结论及 UNSUPPORTED、USER_SKIPPED 边界沿用上文，不扩大声明。

| 发布目标 | tgz SHA512 integrity |
|---|---|
| ACP Bridge | `sha512-fz2teIKXOIL/7Wz8Icwivby7C8wTAxB0CWxACsq9gqYHmDw7NdV4gTFkj9ZeNZgFdyvVwCKeAHCcyaBv2jBXXw==` |
| Feishu Bridge | `sha512-iC/BYOEsl5QD6AKL0WKEpDNVjzmnTYI4/FUV2FajSfvcirZmniWeIl9DH4902qAkB7UUeeBoTMlopvPM0kXOSg==` |
| TaskAgent | `sha512-NbiPsU9Vy1qwFdoah1b81VOcH9XOIZjclMJbDj+4vix9We5/Q2UxvQoN+lE5CdAxsXTBbQoaKuH+501hR8+OWA==` |

Windows 原生安装使用 `npm.cmd install --global @larktask/aamp-feishu-task-agent@0.1.1-dev.8`，再运行 `feishu-task-agent.cmd install`，保持扫描后用户手动选择 Agent。后续启动使用 `feishu-task-agent.cmd start`。

## 2026-09-11 Controller PID 恢复入口补齐与 CI 修复

产品提交 `f11a38fdd7cc7dbe5c2b4c7d792e77d7a76c91ba` 基于 `5bef7f7`，补齐历史 Controller PID 查询的 `exitedBefore` 创建时间条件，并在默认平台适配器中转发该参数。只有确认原 PID 已属于更新进程后，才继续清理日志记录的旧子进程；不会终止复用 PID 的新 Controller。原 Controller 仍存活时不清理；身份查询失败时保留日志并报错。显式停止与子进程归属校验保持原有行为。

回归测试先复现 Controller owner access denied，再验证修复。新增三种恢复状态测试，并扩展原生 PowerShell PID 复用测试，覆盖实际 journal 恢复调用链。AIME/Trae 的两处既有测试同步三项旧发布引用断言，版本一致性检查保持有效；未改变产品依赖或 npm 版本。

验证结果：

- 本地 macOS / Node 26.7.0，TaskAgent 全量 502 项：489 通过、13 跳过、0 失败。
- [CI run 34556332449](https://github.com/ILUO/aamp/actions/runs/34556332449) 精确对应上述产品提交：Windows/macOS/Ubuntu × Node 22/24 六组全部通过，含三包测试、Bridge 类型检查、实际打包和 Windows PowerShell 5.1 安装帮助入口。
- 已回读 Windows Node 24 日志：PID 复用原生 PowerShell 用例与 Controller reused/live/inaccessible 三种边界用例均实际通过。
- 本轮没有重跑 Win10/Win11 的真实飞书业务；没有合并分支或发布新 npm 版本。已发布 dev.8 不包含此后新增的 Agent 默认值修复和 PID 恢复修复，需要另行发布新版本才能交付 npm 用户。
