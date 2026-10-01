# dsh-plugin-task-forge

dsh 插件：**先把大白话编译成任务书，再无损交接给任意窗口的 AI**。

普通人和 AI 协作的真实瓶颈不是"不会写提示词"，而是缺一道**编译工序**：你脑子里只有一个模糊需求，直接丢给干活的 AI，它理解歪了你也不知道；换了窗口、换了 IDE，上下文全靠人肉搬运。task-forge 把这件事产品化：

1. `/forge` 把你的大白话编译成一份开源项目标准的**任务书**（目标/背景/约束/验收标准/已定决策/开放缺口，全部编号）；
2. `/relay` 导出自包含的交接包（单文件 markdown），粘贴给任何窗口的任何 AI；
3. 对方 AI 必须先**回读握手**（复述理解 + 列缺口 + `STATUS: READY`）才被允许开工——LLM 之间传东西永远有损耗，这套协议把损耗逼到明面上、几轮内逼到零；
4. `/answer` 补缺口自动版本 +1；`/forge-list` 台账总览"哪个窗口手里是哪个版本"；进行中任务注入每个新会话的系统提示。

## 安装

```bash
dsh plugin --profile <你的profile> add <本仓库克隆路径>
```

## 命令

| 命令 | 作用 |
|---|---|
| `/forge <需求> [--mode interview]` | 编译。默认 auto：模型自己推演、暴露假设，定不了的写成编号缺口 Q1/Q2…；`--mode interview` 先出问题清单等你答完再编译。编译结果经 `forge_write` 工具落盘 |
| `/relay <id> [--to <窗口名>]` | 导出交接包到 `~/.dsh/task-forge/outbox/<id>-v<n>.md`，全文粘贴给对方窗口 |
| `/ack <id> <回读全文>` | 登记对方回读：READY 放行；NEED-INPUT 的缺口自动登记进任务书 |
| `/answer <id> <Q编号> <答案>` | 缺口答案写入已定决策（D 编号），版本 +1，提醒你重新 relay 新版 |
| `/forge-list` | 台账：任务 × 版本 × 交接窗口 × 状态 |
| `/forge-done <id>` | 标记完成（不再注入系统提示） |

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

## 借鉴来源与差异（不盲目抄）

| 来源 | 借鉴 | 改编 | 原创 |
|---|---|---|---|
| dsh-plugin-pinboard（自家） | `systemPrompt.section` 注入机制、limit/maxChars 预算模型 | 注入内容从静态便签换成读台账现算的任务状态 | —— |
| dsh-plugin-ide-hub（自家） | "一份本体多 IDE 生效"的指针思想 | 本体从规则文件换成任务书；交接走自包含单文件，不依赖任何 IDE 读取器 | —— |
| dsh-plugin-prompt-vault（自家） | `ctx.agents.followup()` 注入通道、v4 producer-owned source kind | vault 降级为非依赖；编译指令按 auto/interview 双模式生成 | —— |
| kaanozhan/Frame（394★） | spec 四件套、编号化决策 | 四件套收敛为单文件任务书，加版本号与握手 | 回读握手协议 |
| distilly（25k★） | "思维→结构化产物"的大方向 | 它蒸馏成 Skill，我们编译成任务书+握手，面向跨工具交接 | 无损传递的判定机制 |

## 测试

```bash
npm run check   # typecheck + node --test + tsc build
```

26 个测试覆盖纯函数层：任务书校验/版本推进/缺口应答、握手解析（中文冒号/旧版本/结构残缺/空缺口）、台账解析/折叠/注入预算。

## v0.2 路线（按使用频率决定）

- interview 模式的多轮访谈闭环（现在一轮问答）
- `.forge/` 接入 ide-hub 的指针生成器，任务书直达各 IDE
- 超长输入的非拦截"建议编译"提醒
- relay 自动派发（`ctx.agents.followup()` 的运行时验证仍在观察）

## License

MIT
