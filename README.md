# dsh-plugin-task-forge

**EN** · Compiles a rough need into a versioned task book, then hands it to any other AI window through a **read-back handshake**: `/forge` compiles, `/relay` emits, `/ack` proves the receiver got it byte-for-byte, `/answer` returns — aimed at the lossy copy-paste handoff between agents. · 61 `node --test` green · design notes in `TASK-FORGE-DESIGN.md`.

dsh 插件：**先把大白话编译成任务书，再无损交接给任意窗口的 AI**。

普通人和 AI 协作的真实瓶颈不是"不会写提示词"，而是缺一道**编译工序**：你脑子里只有一个模糊需求，直接丢给干活的 AI，它理解歪了你也不知道；换了窗口、换了 IDE，上下文全靠人肉搬运。task-forge 把这件事产品化：

1. `/forge` 把你的大白话编译成一份开源项目标准的**任务书**（目标/背景/约束/验收标准/已定决策/开放缺口，全部编号）；
2. `/relay` 导出自包含的交接包（单文件 markdown），粘贴给任何窗口的任何 AI；
3. 对方 AI 必须先**回读握手**（复述理解 + 列缺口 + `STATUS: READY`）才被允许开工——LLM 之间传东西永远有损耗，这套协议把损耗逼到明面上、几轮内逼到零；
4. `/answer` 补缺口自动版本 +1；`/forge-list` 台账总览"哪个窗口手里是哪个版本"；进行中任务注入每个新会话的系统提示。

## 安装

三步，实测于 `@deepseek-ai/dsh@0.1.7-alpha.1`（需 `pnpm` 在 PATH 上）：

```sh
# ① 装进 profile：dsh plugin 把参数原样转发给 pnpm，git 包会自动跑 prepare 构建 lib/
dsh plugin --profile web add github:121212165/dsh-plugin-task-forge
```

② 把本仓库根目录 `cordis.patch.yml` 的内容**并进** `$DSH_HOME/profiles/web/cordis.patch.yml`。
该文件默认是 `[]`，所以要么整份替换，要么把 insert 条目并进同一个数组；**不要直接追加**——
追加会形成两个 YAML 文档，启动即报
`failed to parse overlay ... end of the stream or a document separator is expected`（本机实测踩过）。

③ 重启 dsh。配置层与 client 半都要重启才生效（客户端按 boot 时算出的内容 rev 下发，硬刷新浏览器没用）。

自检挂载：`dsh --profile web --dump-config | grep dsh-plugin-task-forge`，应看到该条目。
## 命令

| 命令 | 作用 |
|---|---|
| `/forge <需求> [--mode interview]` | 编译。默认 auto：模型自己推演、暴露假设，定不了的写成编号缺口 Q1/Q2…；`--mode interview` 先出问题清单等你答完再编译。编译结果经 `forge_write` 工具落盘 |
| `/relay <id> [--to <窗口名>\|ide:<工具名>]` | 导出交接包到 `~/.dsh/task-forge/outbox/<id>-v<n>.md`，全文粘贴给对方窗口；`--to ide:zcode` 这类还会在当前项目 `<hubPath>/tasks/` 落一份同字节副本，并打印该 IDE 的接手步骤。输出还带**这份任务书预计烧多少 token**（见下） |
| `/ack <id> [--to <窗口名>] <回读全文>` | 登记对方回读：READY 放行并给该窗口盖上「确认了哪一版」；NEED-INPUT 的缺口自动登记进任务书。有多个窗口时必须带 `--to`，否则不知道该记在谁头上 |
| `/answer <id> <Q编号> <答案>` | 缺口答案写入已定决策（D 编号），版本 +1，提醒你重新 relay 新版；**interview 任务答完最后一个 Q 会自动重新注入编译指令**，不用你二次触发 |
| `/forge-list` | 台账：任务 × 版本 × 每个窗口的回读状态（`窗口A✓v2 / 窗口B◐v1 / 窗口C○`）× 缺口/决策计数 × 下一步 |
| `/forge-done <id>` | 标记完成（不再注入系统提示） |

## 单任务 token 预估

派发之前先知道这一趟要烧多少。口径在 `src/task-cost.ts`（纯函数，同输入同输出）：

- **分相**：`编译`（任务书自身 token）+ `回读`（有观测就取各步 output 的中位数，没有就按任务书字数的 40%）+ `交接`（任务书 × 持有窗口数，每窗口都要重发一遍全文）+ `执行`（唯一给区间的一段：有观测按中位步长 × 6–20 步，没有就按任务书规模 × 8–18 倍）；
- **基数分两种，输出里写明是哪种**：`基于 3 步观测` 或 `按字数启发式估算（无观测）`——`tokens ≈ 字数 / 2.4` 是混合中英文的近似，**不是分词器**，别拿这个数去跟厂商对账；
- **钱只在有真实价目时出现**：单价从 quota 自己的仪表里取（`todayCostMicros / todayTokens` 的混合单价），拿不到就只报 token，不编价格；
- `/forge-list` 每个任务多一行 `预估 99k–232k`。

## 回读握手协议（无损的全部保障）

每份任务书尾部固定携带握手指令，要求接收方在开工前输出：

```
version: <它读到的版本号>
【回读】用自己的话复述目标、约束、验收标准（逐条对应编号）
【缺口】发现的信息不足或矛盾，逐条编号；没有写"无"
STATUS: READY 或 STATUS: NEED-INPUT
```

- 回读**结构不完整**（缺 STATUS / 缺 version / 缺复述）→ `/ack` 直接判无效并给出补救话术；
- version 和最新版不一致 → 按旧版处理并警告，需要重发新版；
- 缺口逐条 `/answer` 后版本 +1，**所有交接引用必须带 `id@version`**——版本号是跨窗口唯一权威。

## 数据落盘

```
~/.dsh/task-forge/
├── tasks/<id>/task.md      # 任务书本体（frontmatter + 六段正文 + 握手指令）
├── outbox/<id>-v<n>.md     # 交接包导出
└── ledger.jsonl            # 握手台账（每次 created/revised/relayed/acked/… 一行）
```

进行中任务（非 done）按 limit/maxChars 预算注入每个会话的系统提示（`## 进行中任务（task-forge）`），新窗口一开就知道有哪些任务在飞。

## 配置

| 字段 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | 关掉后 apply 直接返回，不注册任何命令/工具/注入 |
| `dataPath` | `~/.dsh/task-forge` | 任务书本体、交接包与台账的根目录；支持 `~` 前缀 |
| `hubPath` | `.hub` | `--to ide:<工具名>` 那份项目内副本的目录，相对当前工作目录解析（写绝对路径也可以） |
| `quotaSummaryPath` | `~/.dsh/quota/summary.json` | quota 发布的预算契约文件；读不到就当没装 quota，不警告也不报错。支持 `~` 前缀 |
| `quotaHistoryPath` | `~/.dsh/quota/history.json` | quota 的每步用量历史（`{sessionId: [{input,output,cacheRead}]}`），**单任务预估**的观测基数；读不到就退回按字数的启发式并在输出里明说 |
| `limit` / `maxChars` | `8` / `900` | 注入段的条数与字符预算；超限的行截断而不是丢弃最新任务 |
| `order` | `690` | 注入段在系统提示里的排序位置 |

`limit`、`maxChars`、`order`、`hubPath`、`quotaHistoryPath` 都走启动自检：填错**启动即失败并点名 task-forge**，不会带着一个不可用的台账静默运行。

## 借鉴来源与差异（不盲目抄）

| 来源 | 借鉴 | 改编 | 原创 |
|---|---|---|---|
| dsh-plugin-pinboard（自家） | `systemPrompt.section` 注入机制、limit/maxChars 预算模型 | 注入内容从静态便签换成读台账现算的任务状态 | —— |
| dsh-plugin-ide-hub（自家） | "一份本体多 IDE 生效"的指针思想 | 本体从规则文件换成任务书；交接走自包含单文件，不依赖任何 IDE 读取器 | —— |
| dsh-plugin-prompt-vault（自家） | `ctx.agents.followup()` 注入通道、v4 producer-owned source kind | vault 降级为非依赖；编译指令按 auto/interview 双模式生成 | —— |
| kaanozhan/Frame（394★） | spec 四件套、编号化决策 | 四件套收敛为单文件任务书，加版本号与握手 | 回读握手协议 |
| distilly（25k★） | "思维→结构化产物"的大方向 | 它蒸馏成 Skill，我们编译成任务书+握手，面向跨工具交接 | 无损传递的判定机制 |
| dsh-auto-review（222★，PerryLink） | 装配层测试方法论：mock ctx harness + 把命令 handler 当真函数调，补上"纯函数层测试好、装配层零覆盖"的断层（其五层模型的第 1-3 层） | 它用 vitest fork pool，我们按家族标准用 node:test + 真临时目录；其第 4-5 层（真实 Loader 子进程组装）暂未引入 | —— |

## 测试

```bash
npm run check   # typecheck + node --test + tsc build
```

82 个测试，两层：

- **纯函数层（53）**：单任务预估的分相、中位数斜率、无观测降级、窗口倍数、坏 history 容错；任务书校验/版本推进/缺口应答、frontmatter 里每个窗口的回读版本（旧格式纯字符串照常解析）、interview 相位（`phase`）落盘与清除、答复被编译器丢掉时自动补回、握手解析（中文冒号/旧版本/结构残缺/空缺口/自作主张的 READY 降级）、台账解析/折叠/注入预算、IDE 派发表；
- **装配层（29，`test/harness.ts` + `test/plugin.test.ts`）**：真实 `apply()` 挂到脚本化 mock ctx 上（命令/工具/注入/followup 全部捕获），在真临时目录里驱动完整协议流——`/forge` 落盘并注入编译指令（含 headless 粘贴回退）、`forge_write` 校验拒绝、interview 出问题清单 → `/answer` 答完最后一问**自动二次注入编译**、`/relay` 导出交接包与 `--to ide:*` 的项目内同字节副本、`/ack` 垃圾输入拒绝/READY 放行/降级/旧版本拦截/每窗口盖章、`/answer` 版本推进与缺口编号不复用、`/forge-list` 的每窗口状态、`forge_write` 的 presentCall/presentResult 卡片、坏配置启动点名。全家第一个有装配层覆盖的插件，harness 可直接复制给其他 17 个。

## 已做到 / 下一步

v0.2 已落地：interview 多轮闭环（答完最后一问自动重编译）、`--to ide:<工具名>` 派发（落项目内副本 + 逐 IDE 接手步骤）、每窗口回读台账（`✓当前版 / ◐旧版 / ○未回读`）、`forge_write` 的 presentCall/presentResult 卡片。

- IDE 侧仍是**人工接手一步**：真自动注入等 ide-hub 的指针生成器（`/hub-init`）上线后接上；
- `/relay` 会读 quota 的 `summary.json`（家族契约：`budgetTokens`/`maxSessionRatio`/`nextTurnEstTokens`），预算已用到 80% 以上时在交接输出里追加一行警告；quota 没装、文件坏、或读数是**一小时以前**的都保持沉默——拿昨天的仪表吓人是更糟的结果；
- 超长输入的非拦截"建议编译"提醒；
- `ctx.agents.followup()` 的运行时验证仍在观察（headless 无活动会话时走粘贴回退，已在测试里覆盖）。

## License

MIT
