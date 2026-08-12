# 子代理评估：百万字规模与不崩塌

**议题切片**：brief A / B / F / D / I（规模与工程门）  
**工作区**：`/Users/hxx/Documents/无限画布`  
**模式**：只读代码与证据；本文件为裁决输入，不宣称已改产品  
**日期**：2026-08-01  
**权威证据**：
- `docs/novel-mode/07-writing-os-v1-delivery.md`
- `docs/evidence/novel-agent-contract-v1/writing-os-v1-1m-500-acceptance.json`
- `docs/novel-mode/03-acceptance-spec.md`（规范目标，≠全部已实现）
- 实现：`src/core/novel-manuscript.ts`、`novel-writing-state.ts`、`novel-agent-service.ts`、`command-ledger-store.ts`、`studio-project-write-lease.ts`

---

## A. 一句话结论

**约 100 万字 / 500 章的「正文 CAS + 有界 pack/preflight + 人工状态 commit」路径已工程可证（S1 smoke PASS）；「长程人物一致性不漂 + 多代理接力不崩 + 规范 S3/S5 检索/索引 SLA」尚未同构落地，主瓶颈是单文件 `writing-state.json` 全量读写/指纹、线性全库搜索、以及小说写路径缺少与生图同级的写租约。**

---

## B. 当前能力 vs 真实写作痛点

| 痛点 | 当前软件能力 | 规模下风险 | 判定 |
|---|---|---|---|
| 100 万字入库与可检索 | managed Markdown + 章级 manifest CAS；S1 导入 33.999 s；热搜索 109 ms 扫 500 章 | 搜索为**逐章读盘 + `indexOf`**，无 `novel-derived` FTS 索引 | 正文 S1 **可**；S3/S5 **未用规范 SLA 关账** |
| 写前不丢硬正典 | Context Pack 2.0：硬正典/任务硬预算，装不下 fail-close；正文后裁 | pack 默认 12k、上限 200k 字符；与模型上下文仍需人工选角色/章 | **机械门可用** |
| 写后状态不静默污染 | 候选 + 人工 commit；`state_commit_required` 挡下一章 | `chapterCompletions` 与 upsert 数组随章增长；全文件 CAS 重写 | **正确性可**；**吞吐会降** |
| 崩溃半写入 | 正文：`operations/` intent + recover；命令账本 SQLite | writing-state 靠 confined CAS 替换；无独立「状态半提交」账本 | 正文 **强**；状态 **中等** |
| 多 AI 同时写同一工程 | 进程内 `withProjectLock("novel-manuscript")` + revision/fingerprint CAS | **小说命令不在** `STUDIO_WRITE_LEASE_ENFORCED_COMMANDS`；异主只能靠 CAS 撞车 | **多代理接力弱于生图侧** |
| 人物八项/知情跨模型 | `get_novel_writing_state` 时态投影 + pack 注入 | 投影每次**整文件 load + 内存 filter**；历史版本若用新 ID 膨胀会爆 | 稀疏状态 **可**；稠密年表 **会崩** |
| 规范级记忆库 | 合同写 `novel-derived.sqlite` / 故事圣经分文件 JSONL | **源码无 `novel-derived` 实现**；Writing OS 用单文件 state 替代分表 | **规范领先于实现** |
| UI 百万章不挂 | list `offset/limit≤500`；验收要求 DOM 上限 | Electron 1M UI 仅 short100 smoke，非 S5 虚拟滚动关账 | **未充分证明** |

### 已测量化基线（S1，非长期 SLA）

来源：`writing-os-v1-1m-500-acceptance.json`（`status=PASS`，`remoteModelsCalled=false`）

| 项 | 值 |
|---|---:|
| UTF-16 字符 | 1,000,000 |
| UTF-8 字节 | 2,601,296 |
| 章数 | 500 |
| 导入 | 33,999 ms（**已超**规范冷导入 S1 ≤10s，但 Writing OS 仍标 PASS） |
| 状态 seed（499 completions） | 744 ms |
| Context Pack 2.0（budget 4096） | 41 ms，确定性重复 |
| 热搜索 | 109 ms，`scannedChapters=500`，1 命中 |
| 硬上限（实现） | 单章/state 读 64 MiB；manifest 32 MiB；搜索 limit≤200；list limit≤500 |

规范目标（`03-acceptance-spec.md`）S1 检索 p95≤150 ms、冷导入≤10 s——**Writing OS 证据只覆盖「一次热搜索 / 一次导入」**，不是 30 次 p95，也不是 S3/S5。

---

## F. 百万字不崩的工程门（规模 / 锁 / 恢复）

### F0. 分层真相源（必须坚持）

| 层 | 路径 / 机制 | 职责 |
|---|---|---|
| 正文权威 | `manuscript/**/*.md` + `chapters.json` revision/SHA | 唯一正文；媒体/模型输出不得当权威 |
| 写作状态权威 | `story-bible/writing-state.json` + fingerprint CAS | 八项动态、知情、关系、时间线、伏笔、completions |
| 不可变源对象 | `.aicanvas/novel/writing-source-objects/sha256/` | 设定原文 CAS |
| 候选/裁决/审稿 | `change-sets/`、`change-set-decisions/`、`reviews/` | 不改正典直至人工 accept |
| 正文操作恢复 | `.aicanvas/novel/operations/<requestHash>/` | intent → mutate → receipt；`novel_recover_manuscript` |
| 命令幂等 | `command-ledger.sqlite`（非 JSON 全量改写） | 同 idempotencyKey 副作用一次 |
| 派生索引（规范） | `novel-derived.sqlite` | **未实现**；实现前不得当唯一权威 |

### F1. 单文件 `writing-state.json` 是否会成瓶颈

**会，但是「条件触发」而不是「500 章必然」。**

实现要点：
- 硬顶：`MAX_WRITING_STATE_BYTES = 64 * 1024 * 1024`
- 每次 load：整文件读入 → JSON.parse → **整对象 stable 排序后 JSON.stringify 再 SHA 复验 fingerprint**
- 每次 accept 候选：整文档深拷贝式 upsert → 新 revision → **整文件 CAS 替换**
- 角色状态按 `stateId` upsert（同 ID 覆盖）；knowledge/relationship/timeline/foreshadowing 亦按 ID upsert
- `chapterCompletions` **只增不缩**（每章一条）
- seed schema 允许 knowledge 等数组 **max 1_000_000**

#### 量化门槛（建议产品门，超过则必须拆分或投影）

| 指标 | 绿（可维持单文件） | 黄（监控/优化） | 红（必须分卷/分库/索引） |
|---|---:|---:|---:|
| `writing-state.json` 体积 | ≤ 2 MiB | 2–8 MiB | > 8 MiB 或接近 64 MiB |
| `chapterCompletions.length` | ≤ 600 | 600–2 000 | > 2 500（S5）且仍全量指纹 |
| knowledge + timeline + foreshadowing 总条数 | ≤ 20k | 20k–100k | > 100k |
| `get_novel_writing_state` / pack 前 load 冷耗时 p95 | ≤ 50 ms | 50–200 ms | > 200 ms（S1 规范章级状态门） |
| 单次 state CAS 写（含 fingerprint）p95 | ≤ 100 ms | 100–500 ms | > 500 ms |
| 每章 AI 候选平均新增 **新** knowledgeId 数 | ≤ 20 | 20–80 | > 80（稠密年表爆炸） |

**经验估算**（量级，非承诺）：
- 稀疏状态（类《黑页》pilot：~17 实体、~173 知情）：整文件远小于 1 MiB，**500 章无瓶颈**。
- 若每章新增 50 条永不复用 knowledge（~200 字/条）→ 500 章 ≈ 25k 条 ≈ 数 MiB JSON + 每次双重 stringify 指纹 → 进入黄区。
- 若百万条级（schema 允许）→ 单文件 + 全量指纹 **数学上会先于 64 MiB 在 CPU/锁持有时间上崩**。

**结论**：单文件适合 **「当前水位投影 + 有限实体 upsert」**；不适合 **「全书事件流水账」**。长程一致性要的是「截止章投影」，不是把全书对话日志塞进一个 JSON。

### F2. 搜索 / pack / preflight 预算与分页

#### 搜索（当前实现）

```text
searchChapters:
  concurrency = 32
  读全章 content → indexOf(query)
  直到 hits 满或扫完所有章
  两次 snapshot 一致才返回；否则重试 1 次
```

| 门 | S1 已证 | 工程建议门 | 说明 |
|---|---|---|---|
| 热精确检索 | 109 ms / 500 章全扫 | p95 ≤ 150 ms（规范） | **无索引**时 S1 勉强；S3 1 500 章、S5 2 500 章 I/O 线性放大 |
| `limit` | ≤ 200 | 保持；UI ≤ 100 DOM | 已分页结果，**扫描不一定短路**（无命中时扫完全书） |
| `list_novel_manuscript_chapters` | limit ≤ 500 | UI 默认 50–100 | 分页已有 |
| 单章读 | maxCharacters 默认 12k / 上限 200k | 禁止「整本进 prompt」 | 已有界 |

**何时必须上 FTS/派生索引**：
- 任意连续 30 次热搜 p95 超规范；或
- `scannedChapters` 常态 = 全书且章数 ≥ 1 500；或
- 冷启动后首次搜索 > 1 s。

**何时不必**：纯续写工作流几乎不用全文搜、只读近 3 章 + 角色投影时（pack 默认 recent 路径）。

#### Context Pack 2.0

| 参数 | 默认 | 上限 | 裁剪顺序 |
|---|---:|---:|---|
| `maxCharacters` | 12_000 | 200_000 | 硬正典+任务 **不可裁** → 角色包 → 关系/日历/伏笔 → 正文 excerpts |
| `maxSearchHits` | 20 | 50 | query 触发时先 search（全库扫描风险） |
| `chapterIds` | — | 50 | 显式选章 |
| 默认无 query | 近 3 章 | — | 不扫全书 |

Preflight：**同参重建 pack** 并绑定 manuscript revision、章 SHA、writing-state revision/fingerprint、pack fingerprint。代价 ≈ 1× pack；漂移 → `context_preflight_stale`。

| 门 | 建议 |
|---|---|
| pack p95（无 query，S1） | ≤ 400 ms（规范）；已测 41 ms @ 4k budget |
| pack 含 query | 计费 = search + 读章；黄线 = 单独超 search 门 |
| 硬正典叙事字符 | 必须 < `maxCharacters`；建议硬正典预算 ≤ 预算 30% |
| 禁止 | 把 100 万字正文塞进 pack；禁止无 cutoff 的「全书审查伪装续写」 |

### F3. 崩溃恢复：lease / ledger / CAS / 备份

| 机制 | 小说正文 | writing-state | 多代理 |
|---|---|---|---|
| 写锁 | `withProjectLock(..., "novel-manuscript")` | 同锁域内 mutation | 同进程互斥；跨进程主要靠 CAS |
| 写租约 | **未强制**（生图命令才 enforce） | 同左 | **缺口**：异主 AI 可同时抢写，只靠 revision 冲突失败 |
| 操作日记 | `operations/` intent + after-content + receipt | 无对称 operation 日志 | — |
| 恢复入口 | `novel_recover_manuscript` / 写前 auto-recover | 依赖 CAS 原子替换；坏 JSON 直接失败 | 需人工/备份 |
| 命令账本 | SQLite upsert，幂等重放 | 经 `execute_command` 同一账本 | 同 key 不双写 |
| 备份 | 规范要求新目录打开；权威= manuscript + state + source-objects | 派生库可删重建（实现后） | 备份不得含密钥 |

**崩溃场景门（必须可测）**：

1. **save 中断在 file mutation 后、manifest 前**：重启 recover → 恰好一次提交或可恢复到一致。  
2. **state accept 中断**：要么旧 revision 完整，要么新 revision 完整；禁止半 JSON。  
3. **100 次快速编辑 + SIGKILL**：无空文件、无丢 revision（规范 §7）。  
4. **双写同章不同 idempotencyKey**：一成一败，CAS `revision_conflict`。  
5. **异主无 lease**：今日可并发撞 CAS；**P0 产品改进应把 novel 写命令纳入写租约或独立 novel lease**。

### F4. 何时必须分卷 / 分库 / 索引，何时不必

#### 不必（维持单库 + 单 writing-state）

- 目标 **≤ S1（1e6 字 / ≤500 章）**  
- 状态模型为 **实体 upsert + 截止章投影**，knowledge 总量 < 20k  
- 工作流以 **续写下一章** 为主，全文检索低频  
- 单写者（或单租约持有者）+ 人工 state commit  
- 已测：seed 499 completions 744 ms、pack 41 ms、热搜 109 ms 量级仍成立

#### 必须（触发任一条即立项工程化）

| 触发 | 动作 |
|---|---|
| 章数 ≥ 1 500 或字数 ≥ 3e6 且检索为产品路径 | 落地 **派生 FTS**（规范 `novel-derived.sqlite`），增量索引；删除可重建 |
| `writing-state.json` > 8 MiB 或 load p95 > 200 ms | **拆分**：completions / knowledge 事件 → JSONL 或 SQLite；头文件只留水位 + 实体当前卡 |
| 多代理（Grok/Claude/Codex）同工程日更 | **novel 写租约**（对齐 studio lease）+ heartbeat |
| 每章状态候选 > 100 新 ID 或流水账式时间线 | 禁止进 monostate；改为 **章级 append-only log + 物化视图** |
| 冷导入持续 > 规范 2× | 并行 SHA/批处理；仍失败则分卷导入收据 |
| Electron RSS / heap 破 S5 门 | 虚拟滚动、禁止挂载全量 DOM；列表强制分页 |

#### 分卷策略（产品语义 vs 存储）

- **文学分卷**（`volumes[]`）：已有；**不等于**存储分库。  
- **存储分库**：仅在红线触发时按 `volumeId` 或章号段拆 manifest/索引；**projectId 不变**，跨卷 ID 全局唯一。  
- **禁止**：为「听起来更大」过早分库，破坏 CAS 与单一 project 锁语义。

---

## D. Top 10 产品改进（规模相关优先级）

| # | 优先级 | 改进 | 验收要点 |
|---|---|---|---|
| 1 | **P0** | 小说写命令纳入写租约（或 `novel-write-lease`） | 异主 `novel_save_chapter` / state commit 失败关闭；同主 heartbeat |
| 2 | **P0** | `writing-state` 体积分位监控 + 黄/红门 | MCP/桌面显示字节数、条数；红线拒绝无脑大候选 |
| 3 | **P0** | 状态候选配额：每章 knowledge/timeline 新增上限 | 超限 `invalid_target`；逼模型合并 ID |
| 4 | **P1** | 实现规范派生 FTS（可删重建） | S1/S3 精确 Recall 与 p95；删库三轮重建 |
| 5 | **P1** | search 无命中短路与「已扫完」指标暴露 | 返回 `scannedChapters/total`；便于 SLA |
| 6 | **P1** | pack 路径默认 **禁止隐式全库 search**；query 需显式 | 文档 + 测试：无 query 时 0 次全表读 |
| 7 | **P1** | state 投影缓存：`(stateRev, cutoffChapterId)` 记忆化 | 同 revision 重复 get_state p95 下降 |
| 8 | **P2** | completions 外置或 SQLite | 单文件只保留 `currentThrough` + 近 N 章 |
| 9 | **P2** | S3/S5 acceptance 自动化（现有 fixture 矩阵） | 证据 JSON 含 p50/p95，非单次 |
| 10 | **P2** | 工程备份向导：权威集合清单一键复制 | 新根打开检索一致；旧根 SHA 不变 |

（人物一致性机械门细则见其他子代理；本表只列规模/不崩相关。）

---

## I. 90 天路线图（规模与恢复切片）

### 0–30 天（关 S1 真 SLA + 多写安全）

- 把现有 1M/500 从「单次 PASS」升级为 **冷 1 次 + 热 30 次** p50/p95 报告。  
- novel 写路径 lease。  
- writing-state 体积/条数遥测与候选配额。  
- 故障注入：SIGKILL save、双窗口 CAS（复用规范 §7 子集）。  
- **出口**：S1 检索/状态/pack p95 门有证据；多代理异主不能双写成功。

### 31–60 天（索引与状态瘦身设计）

- 若检索仍是产品路径：实现 `novel-derived.sqlite` FTS + 增量；权威仍是 Markdown。  
- 设计 state 分层：`head.json`（水位+实体卡）+ `events/` 或 sqlite；保持 cutoff 投影语义。  
- S3 fixture（3e6 / 1500）导入 + 热搜 + pack 证据。  
- **出口**：S3 规范表有一条可复现 PASS 或书面降级决策。

### 61–90 天（S5 或明确不做）

- 仅当 owner 需要 2500 章产品形态：S5 资源门（RSS/heap/DOM）+ 30 min soak。  
- 否则书面冻结「产品支持上限 = S1 或 S3」，避免虚假百万字营销。  
- 备份恢复与「删派生库三轮」若已有 FTS 则关账。  
- **出口**：对外宣称的规模上限 = 证据上限。

---

## 验收命令建议

> 均在仓库根执行；**只读验证**优先；大规模夹具写临时目录，勿碰正式小说源与 `docs/evidence/**` 既有 PASS。

### 1) 回归与 Writing OS 终验（已有）

```bash
cd /Users/hxx/Documents/无限画布
npx tsx scripts/validate-novel-writing-os-final.ts
# 断言含 writing-os-v1-1m-500-acceptance.json status=PASS
```

### 2) 规模夹具生成与校验（S1/S3/S5）

```bash
npx tsx scripts/create-novel-scale-fixtures.ts --scale S1 --out /tmp/novel-scale-S1
npx tsx scripts/validate-novel-scale-fixture.ts /tmp/novel-scale-S1

# 需要时：
npx tsx scripts/create-novel-scale-fixtures.ts --scale S3 --out /tmp/novel-scale-S3
npx tsx scripts/create-novel-scale-fixtures.ts --scale S5 --out /tmp/novel-scale-S5
```

### 3) FTS 运行时探针（系统 Node / Electron；≠ 正文检索已接 FTS）

```bash
node scripts/probe-novel-fts5-runtime.mjs
# 测试：tests/novel-fts5-runtime-probe.test.ts
```

### 4) 1M 闭环复跑（建议固化为脚本；逻辑对齐 acceptance）

```bash
# 示意：导入 S1 语料到临时 managed novel 工程 → seed writing-state →
# build_context_pack(taskType, targetChapterId, maxCharacters) →
# preflight →（可选）search_novel_manuscript
# 记录：importMs, seedMs, packMs×30, searchMs×30, stateBytes, completionCount
printf '%s' '{"schemaVersion":1,"operation":"capabilities"}' | npm run --silent novel:agent
```

### 5) 崩溃恢复

```bash
# 正文
# execute_command novel_recover_manuscript
# 或依赖写路径前置 recoverIncompleteOperationsUnlocked

# 幂等：相同 idempotencyKey 重放 → 账本返回原结果，无第二份正文
```

### 6) 体积与条数门（手工/小脚本）

```bash
# 对活动工程（示例路径替换）
python3 - <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1])
raw = p.read_bytes()
doc = json.loads(raw)
keys = ["chapterCompletions","knowledge","relationships","timeline","foreshadowing","characterStates","hardCanon","entities"]
print("bytes", len(raw))
for k in keys:
    v = doc.get(k)
    print(k, len(v) if isinstance(v, list) else type(v))
PY
/path/to/project/story-bible/writing-state.json
```

**通过判据建议**：`bytes ≤ 2_097_152` 绿；`> 8_388_608` 红。

### 7) 对照规范性能表（关账用）

以 `docs/novel-mode/03-acceptance-spec.md` §5 为门；证据 JSON 必须含：

- `scale`, `corpusSha256`, `samples`, `p50`, `p95`, `max`, `machine`, `buildIdentity`
- 单次 hot 109 ms **不得**单独宣称 p95 PASS

---

## 总判（回写 brief）

| 问 | 答 |
|---|---|
| 百万字能否工程化？ | **正文与写章闭环：能（S1 已证）。** 长程一致 + 多代理 + 规范 S3/S5：**部分能，缺索引/租约/状态分片。** |
| 单文件 state 瓶颈？ | **稀疏不瓶颈；稠密事件流必瓶颈（64MiB 顶 + 全量指纹）。** |
| 现在就要分库吗？ | **S1 生产续写：不必。** 上 S3 检索或 state>8MiB：**必须索引或分片。** |
| 最大诚实表述 | 「支持约 100 万字受管正文与 500 章机械写章门」= **有证据**；「百万字人物永不崩、多 AI 无限接力」= **过度宣称**。 |

---

## 证据与代码锚点

| 主题 | 位置 |
|---|---|
| S1 实测 | `docs/evidence/novel-agent-contract-v1/writing-os-v1-1m-500-acceptance.json` |
| 交付叙述 | `docs/novel-mode/07-writing-os-v1-delivery.md` |
| 线性搜索 | `NovelRepository.searchChapters` in `src/core/novel-manuscript.ts` |
| state 64MiB + CAS | `src/core/novel-writing-state.ts` |
| pack 预算 | `src/core/novel-agent-service.ts`（`NOVEL_AGENT_*_CONTEXT_*`） |
| 正文恢复 | `recoverIncompleteOperationsUnlocked` in `novel-manuscript.ts` |
| 命令账本 SQLite | `src/core/command-ledger-store.ts` |
| 写租约仅生图 | `STUDIO_WRITE_LEASE_ENFORCED_COMMANDS` in `studio-project-write-lease.ts` |
| 规范 FTS/S5 门 | `docs/novel-mode/03-acceptance-spec.md`（**超前于实现**） |
| 夹具 S1/S3/S5 | `scripts/create-novel-scale-fixtures.ts`、`tests/fixtures/novel-scale/manifest.json` |

---

*本子代理不修改产品代码；结论供主审合成 brief 总稿。*
