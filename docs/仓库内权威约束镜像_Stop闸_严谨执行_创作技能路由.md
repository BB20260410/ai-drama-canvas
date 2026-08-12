# 仓库内权威约束镜像：Stop 闸 / 严谨执行模式 / 创作技能路由

> 状态：镜像快照，2026-08-12 从用户目录源文件提取（只读，未修改用户目录）。  
> 目的：让 `AGENTS.md` 引用的「始终需要」约束在仓库内可解析。本文件是仓库内落点；
> 用户目录原文件仍存在时作为**可选增强**（更完整的原文与运行时联动），不存在或不可读时以本镜像为准。  
> 冲突顺序：用户本轮指令 > 项目 `AGENTS.md` > 本镜像 > 用户目录原文件的历史版本。

---

## 1. Goal Stop 闸（长任务自动续跑的常需要点）

镜像自（可选增强）：`~/.grok/bin/goal-stop-continue.sh`、`~/.grok/hooks/goal-continue-stop.json`、`~/.grok/memory/MEMORY.md`「Goal 自动续跑基础设施」节。

### 1.1 行为合同

- Stop 闸在会话停止时检查：**session `goal/state.json` 处于 active 且未完成**为主信号，仓库根 `STATUS.md` 进行中为次级信号；任一命中则 block stop，强制续跑。
- 单回合最多续跑 **8 次**（客户端硬顶）；跨回合靠 wake 武装（`goal/wake-armed.json`）+ durable scheduler。
- 进度真相只在磁盘：`STATUS.md` / `TASKS.md` / `docs/当前开发交接.md`；压缩或新会话后从 earliest 未完成项续跑，不从零问目标。
- 进程死亡不静默装登录项；恢复走显式 opt-in 或 `--resume`/`--continue`。

### 1.2 Hook 注册面（Grok 客户端，运行时配置）

`~/.grok/hooks/goal-continue-stop.json` 注册四类 hook：

| 事件 | 作用 |
|------|------|
| `Stop` | 调 `goal-stop-continue.sh` → `goal_continue_lib.py stop`，active goal/进行中 STATUS 则 block（timeout 30s） |
| `SessionStart` | `goal-session-start.sh`：恢复 goal 武装状态（timeout 15s） |
| `UserPromptSubmit` | `goal-user-prompt-submit.sh`：提示词入口同步 goal 状态（timeout 10s） |
| `PreCompact` | 内联 bash：提示「进度只信磁盘；压缩后从 earliest 未完成项续跑」 |

### 1.3 仓库内最小执行约束（不依赖用户目录即可执行）

1. **禁止**切片完成就关账 goal；仅整目标关账后可 completed。
2. **回合末禁止**只输出「下一步」清单；必须工具续做，或在 `STATUS.md` 写真阻塞（仅用户能解）。
3. compact / 新会话：先读 `STATUS.md` earliest，立刻干。
4. Skeptic/修 bug 结束后立刻回产线 earliest，禁止停在解释。
5. Stop 闸/scheduler 本体缺失时（换机、新环境），上述 1–4 条纪律仍然有效；基础设施按 1.2 重建即可。

---

## 2. 严谨执行模式（常需要点）

镜像自（可选增强）：`~/.grok/memory/rigorous-execution-mode.md`（主规则全文）与 `~/.grok/memory/MEMORY.md`「严谨执行（永久入口）」节。

### 2.1 身份切换（最重要）

每个任务必须承担两个角色：**执行者**（推进、实现、落盘、跑测）与**审计者**（找反例、抠表述、验阻断、对 digest）。关账/汇报前必须进入审计者模式至少一轮，假设「下一位审计会拆穿我」。禁止只做执行者。

### 2.2 核心排序

事实 > 报告；证据 > 自述；**当前运行 > 历史聊天/旧 final-validation**；正确性 > 速度；用户真实目标 > 任务编号形式；小而完整纵向切片 > 大量半成品；不确定则保守，高风险失败关闭。不把「做过」写成「做好」，不把「测试通过」写成「产品完整可用」。

### 2.3 六维完成门（动手前先写门）

| 维度 | 问什么 |
|------|--------|
| 机械 | 文件/行/SHA/schema/测试绿？ |
| 功能 | 正式入口可达、状态机正确？ |
| UI | 真窗口/真路径打开过？ |
| 性能 | 目标规模下测过？还是只测了小样本？ |
| 视觉/一致性 | 人眼或显式标准？还是脚本写死 pass？ |
| 外部真实 | 真 API/真供应商回执？还是本地伪造 provider？ |

任一维度未做 → 结论最高只能是**部分完成**，禁止「已完成关账」。

### 2.4 审计者自检（关账/汇报前强制）

- **表述防火墙**：规模数字拆四列（索引/落盘对象/可解码抽检/UI 真入口）；「真实供应商 canary」必须有 requestId/回执，否则写「本地导入登记，供应商未溯源」；脚本自动 pass 写「机械字段，非视觉验收」。
- **阻断探针**：凡「拒绝/不允许」类能力，必须制造失败条件后**再调一次本应被挡的接口**；仍成功 = 告警未失败关闭，不得写「已拦截」。
- **digest 探针**：关账前独立计算当前 sourceDigest 与证据 JSON 比对；不一致 → 重跑或标注过期。旧 final-validation 在源码继续变更后默认作废，直到在当前 digest 下重跑。
- **对抗自问至少 3 条**：哪句话会被只信命令输出的审计拆穿？是否用绿测掩盖未测维度？正式工程路径是否与 fixture 混同？

### 2.5 结论用语（硬枚举）与失败关闭

- 结论只用：**已完成 / 部分完成 / 阻塞 / 失败 / 未开始**。禁用「基本完成、应该没问题、大概通过」。
- 下列情况停危险动作（可继续只读诊断与可逆修复）：SHA/文件与预期不符、revision 冲突、目标已存在且无覆盖授权、路径越出允许根、权威/绑定歧义、外部提交状态未知、可能重复付费/重复生成、备份完整性失败、用户授权不足。

### 2.6 固定动作序列

```
读规则与交接 → 恢复真实状态（涉关账含 digest）→ 写完成门六维
→ 执行纵向切片（完成门→合同→实现→单测→集成→构建→真跑→证据→交接）
→ 审计者自检 → 更新交接与证据 → 一次性汇报
```

汇报固定结构：结论（枚举）→ 实际结果 → 验证（命令与结果）→ 证据路径 → 未验证项 → 风险与边界 → 下一唯一优先级 → Git/文件状态。

---

## 3. 创作技能自动路由（最小必要映射）

上游权威（可选增强）：`story-production-router` 统一路由技能（源：`/Users/hxx/Documents/嘟嘟专属剧情。/技能开发/story-production-router/SKILL.md`，经 `~/.agents/skills` 同源分发到 Codex/Grok/Kimi/Claude）。
注：`AGENTS.md` 旧版指向的「全局 `~/.codex/AGENTS.md` 的创作技能自动路由」段已不在该文件内（2026-08-12 核实，该文件仅含通用纪律与 Codex 分层调度）；现以本节为仓库内权威最小映射。

### 3.1 路由表（最小必要映射）

| 用户目标 | 主技能 | 可按需叠加 | 禁止抢占 |
|---|---|---|---|
| 写、改、续写、综合审查微短剧正文 | `short-drama` | 明确要求结构工作时加 `cinematic-screenplay-structure` | `cinematic-shot-card` 不得提前改写正文 |
| 只诊断三幕、节拍、冲突、弧光或小说改剧本结构 | `cinematic-screenplay-structure` | 需要完整 coverage 时加 `script-analysis-dramaturgical` | 不自动调用 `short-drama` 写正式正文 |
| 全面分析剧本、beat map、场次 coverage | `script-analysis-dramaturgical` | 需要结构重构建议时加 `cinematic-screenplay-structure` | 不把分析建议写成已批准正典 |
| 写、改、续写、压缩、定稿普通或非连载小说 | `novel-writing` | 页面落笔加 `creative-writing-craft`；长程正典加 `fiction-story-bible-manager` | `story-long-write` 不得作为共同主技能 |
| 连载网文开书、卷纲/细纲、日更、补纲、回炉 | `story-long-write` | 长程正典加 `fiction-story-bible-manager` | `novel-writing` 不得作为共同主技能 |
| 只做页面级场景、对白、POV、节奏、文风修订 | `creative-writing-craft` | `llm-writing`、`writing-principles`、`creative-writing-modes` 按需 | 不接管长篇项目状态 |
| 将锁版剧本拆成 Shot Card、镜头表或 2–6 格故事板 | `cinematic-shot-card` | 跨两个以上镜头时加 `ai-drama-continuity` | 未锁版不得把分镜建议反写为剧本事实 |
| 从源稿做角色/场景/道具资产板、BindingSet 或正式模型提示词 | `ai-drama-production-prompts` | 有跨镜状态时加 `ai-drama-continuity` | 普通分镜阶段不得提前调用 |
| 专项运镜或表情设计 | 当前阶段主技能 | `cinematic-camera-movement` 或 `facial-expression-system` | 不把专项库整体塞进每个任务 |

跨体裁/阶段不明确时先走 `story-production-router` 薄路由恢复权威再选主技能。

### 3.2 阶段门（最小集）

- **剧本→分镜**：剧本版本明确 + 用户批准或文件标锁版 + 未决事实登记 `unresolved` + 分镜引用锁版版本/内容哈希，四条全满足才进分镜。分镜不得以「镜头更好看」反改锁版事件、对白或角色知识。
- **分镜→生产提示词**：交付物明确包含资产板、BindingSet、正式生图/视频提示词或生成包时才进 `ai-drama-production-prompts`。计划态不得写成已生成/已审片/已发布。
- **连续性**：`planned_end_state` 是计划；`observed_end_state` 只能来自原尺寸审片通过的实际画面；未审候选不得成为下一镜事实尾帧。

### 3.3 本仓库覆盖规则

- 本项目的结构层与分镜层分别以 `cinematic-screenplay-structure`、`cinematic-shot-card` 为项目内唯一源。
- 项目 `AGENTS.md`、锁版源稿、资产硬锁（如黄金面具）与当前生产合同始终高于通用 Skill；每次只加载满足任务所需的最小技能集合。

---

## 4. 镜像维护

- 本镜像是 2026-08-12 的快照；上游用户目录文件更新后，本仓库不自动同步，需显式重提并在本节登记新快照日期。
- 用户目录文件不可写回（本项目红线）；同步方向永远是「用户目录 → 本镜像」。
- 本镜像只收录「始终需要」的最小约束；完整原文（禁句库 `rigorous-execution-lessons.md`、多模型席位、套件审计脚本等）仍在上游，按需读取。
