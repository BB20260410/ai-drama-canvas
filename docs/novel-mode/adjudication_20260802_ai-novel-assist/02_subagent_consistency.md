# 子代理裁决：人物 / 正典一致性如何机械化

> 席位：无限画布·人物/正典一致性专属分析（只读）  
> 日期：2026-08-02  
> 范围：brief A/B/C/E/G/H + 部分 D/F  
> 权威基线：`AI_AGENT_CONTRACT_V1.md`、`07-writing-os-v1-delivery.md`、`src/core/novel-types.ts`、`novel-writing-state.ts`、`novel-agent-service.ts`  
> 对照：漫剧 BindingSet / `generation-ready` / P19 `get_studio_consistency_evaluation`

---

## A. 一句话结论

**Writing OS V1 已把「章前状态投影 + 指纹绑定写前门 + 写后状态候选人工 commit」做成闭环；人物一致性要真正不漂，必须把八项动态卡 / 知情账 / 关系区间从「pack 里的可选 JSON」升级为「cast 强制装载 + 禁揭分层 + 写后机审四态 + generation-ready 同构门」，且机审只拦结构违规、永不自动文学 PASS。**

---

## B. 当前能力 vs 真实写作痛点

| 痛点 | 现有机械能力（已落地） | 仍缺口（一致性视角） |
|---|---|---|
| 模型不知「写到哪一章的正典」 | `get_novel_writing_state(cutoff=before\|through)` 时态投影；`planned_later` 无 `effectiveFrom` 不入投影 | 投影是**读面**；Agent 可跳过 `characterIds`，预算下非强制角色可被 `pushBudgeted` 静默省略 |
| 外形/声口/八项漂移 | 八项字段 schema 固定：`body/emotion/known/unknown/relationships/goals/psychology/unresolved`；实体有 `baseSummary` + L1–L4 | 字段全是自由文本/字符串列表，**无结构化外形锁、无声口特征表**；无「与上一切片 diff 必须覆盖」的机审 |
| 知情越权（角色说了不该知道的） | `NovelKnowledgeRecord.status`：known/unknown/partial/misbelieved/planned_later/forgotten/unresolved；按章区间过滤 | **正文不校验**是否使用了 `unknown`/`planned_later` 事实；知情条目与八项 `fields.known/unknown` 可能双写不一致 |
| 禁揭 / 作者只知 | `hardCanon.visibility = writer \| author_only`；pack **只装载 writer**（已实现） | `author_only` 仍在 state 文件内；多 Agent 若直读磁盘/绕 pack 仍可泄露；无「禁揭 token 黑名单」机审 |
| 关系进度乱跳 | `NovelRelationshipRecord` 有 `throughChapterId` + latest-by-key 投影 | 关系 `relation/state` 自由文本；无有序状态机（陌生→认识→结盟…）；写后不强制 delta |
| 跨模型接力人设各写各的 | preflight 绑定 pack fingerprint + state revision/fingerprint；缺 commit → `state_commit_required` | **没有 model/provider 身份进 save 账本强制字段**；接力协议靠文档约定，非门禁 |
| 百万字后上下文爆炸 | pack 预算优先硬正典/任务；指定角色强制装载；正文最后裁 | 未指定 cast 时关系/知情可能被裁光仍 `ready=true`；缺「本场 cast 清单」硬门 |
| 状态与正文双轨漂移 | 保存正文不改正典；candidate 绑定 chapter+state CAS；人工 accept 才推进 `currentThroughChapterId` | stage 内容**无机器对照正文**；人审负担高，漏审即正典污染 |
| 像漫剧一样「未就绪禁止生成」 | preflight `ready` 仅挡：`state_commit_required`、`hard_canon_conflict` | **无**类似 BindingSet 的 cast 完备、知情完备、brief mustNot 装载完备门；无四态一致性评价器 |
| 审稿 vs 写作角色混淆 | `review_chapter` → `writePreflightInput=null`；只能 `novel_attach_review_ticket` | ticket 不回写状态；审稿模型若误走 continue 仍可写（靠契约纪律） |

**对照黑页 pilot 量级（隔离工程）**：17 实体 / 8 张动态卡 / 173 知情 / 5 关系 / 28 伏笔 / 29 硬正典 — 已证明投影与闭环可跑；**未证明**跨模型长程不漂。

---

## C. 目标架构（文字组件图）

```
┌─────────────────────────────────────────────────────────────────┐
│ 唯一真相源（CAS / revision）                                       │
│  manuscript/*  +  story-bible/writing-state.json                   │
│  + writing-source-objects/sha256/*  + change-sets / decisions      │
└────────────────────────────┬────────────────────────────────────┘
                             │ project(before N)
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Temporal Projector（已有 projectNovelWritingState）                 │
│  硬正典(writer) · 八项动态 · 知情区间 · 关系区间 · 日历 · 伏笔 · brief │
│  + Cast Resolver（新增）：本场必须角色 + 关系闭包 + 禁揭视图          │
└────────────────────────────┬────────────────────────────────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
     Context Pack 2.1   Write-Ready Gate   Author-Only Vault
     (强制装载顺序)      (generation-ready   (永不进 writer pack;
                         同构)              仅 owner 工具)
              │              │
              ▼              ▼
        Model 主笔/改写 ──► CAS save(aiWriteContext+provider)
              │
              ▼
     Post-Write Consistency Scanner（机审四态，不自动 PASS）
              │
              ▼
     State Candidate（delta 必须可机检字段） ──► 人工 accept/reject
              │
              ▼
     Chapter Completion ──► 下一章 preflight
```

**与漫剧同构映射**

| 漫剧 | 小说一致性 |
|---|---|
| AssetBindingSet 冻结 | **CastBindingSet**（本场角色 + 状态 revision 指纹） |
| panel `generation-ready` | chapter write **`write-ready`** |
| freeze pack → dispatch | pack 2.x → preflight → save |
| `get_studio_consistency_evaluation` 四态 | `evaluate_novel_chapter_consistency` 四态 |
| 机器不自动 Review PASS | 机器不自动 state accept / 文学 PASS |
| provider 必须与 dispatch 一致 | save 记录 `provider/model/role`，接力切换必须新 preflight |

---

## D. Top 产品改进（一致性相关切片，P0–P2）

> 完整 Top 10 产品列表由主审合成；此处只列**人物一致性硬相关**项。

| 优先级 | ID | 改进 | 验收门 |
|---|---|---|---|
| **P0** | CON-01 | **Cast 强制装载**：`chapterBrief.castEntityIds` 或 pack 入参 `characterIds` 非空且集合内角色基础卡+最新八项+知情**整包装入**；装不下 → fail-closed，禁止 `pushBudgeted` 静默省略 cast | 缺角色 / 预算不足 → `cast_incomplete` / `context_budget_cast_overflow` |
| **P0** | CON-02 | **Write-Ready 门扩展**：preflight blockers 增加 cast / brief.mustNot / hardCanon writer 完备；对齐 BindingSet 语义 | `ready=false` 时 AI save 仍拒 |
| **P0** | CON-03 | **禁揭视图硬化**：writer pack 零 `author_only`；`planned_later` 永不进 continue pack；新增 `banRevealTokens[]` 可选机扫 | 泄漏进 pack → 测试红；正文含 token → `ban_reveal_hit`（需复核或 fail） |
| **P1** | CON-04 | **知情账单一真相**：八项 `known/unknown` 改为**派生投影**（或 stage 时强制与 knowledge ledger 对齐校验） | 双写冲突 → `knowledge_ledger_inconsistent` |
| **P1** | CON-05 | **写后一致性机审** `evaluate_novel_chapter_consistency`：结构项 fail-closed 候选；文学项 needs-review | 四态 JSON + 不绑定 auto-accept |
| **P1** | CON-06 | **多模型接力信封**：save/stage 强制 `actor: { role, provider, modelId }`；跨 provider 必须新 pack | 缺 actor → `actor_identity_required` |
| **P1** | CON-07 | **关系区间状态机（可选 schema）**：`relationCode` + 允许转移表；自由文本保留作 gloss | 非法跳变 → `relationship_jump_illegal` |
| **P2** | CON-08 | **外形/声口锁字段**（结构化子集）：`appearanceLocks[]` / `voiceLocks[]` 进实体或 L1 卡 | 锁字段未入 pack → 不 write-ready |
| **P2** | CON-09 | UI：章级 CastBinding 面板 + 与漫剧 Binding 视觉同构 | 人工可见指纹与 ready 原因 |
| **P2** | CON-10 | 百万字：按 cast 分页的 state 投影 + 知情索引（派生 SQLite 可重建） | 1M 下 cast pack p95 门（非本次 SLA） |

---

## E. 人物一致性机械门清单

### E.1 现有八项动态卡（权威字段，不得改名）

```ts
// src/core/novel-types.ts — NovelCharacterDynamicFields
interface NovelCharacterDynamicFields {
  body: string;           // 身体/外形当下
  emotion: string;        // 情绪
  known: string[];        // 已知（宜派生自 knowledge）
  unknown: string[];      // 不知（宜派生）
  relationships: string[];// 关系摘要（宜对齐 relationship 记录）
  goals: string[];        // 目标
  psychology: string;     // 心理
  unresolved: string[];   // 未决
}
```

**强制输入原则**：Agent **不得**用聊天记忆或模型内权重替代上述投影；唯一合法输入是 `build_novel_context_pack` 返回的 `sections` + `fingerprint`。

### E.2 建议：CastBindingSet schema（新增，落盘候选不改正典）

```ts
interface NovelCastBindingSet {
  schemaVersion: 1;
  kind: "novel-cast-binding-set";
  projectId: string;
  targetChapterId: string;
  cutoff: "before";
  writingStateRevision: number;
  writingStateFingerprint: string;
  cast: Array<{
    entityId: string;
    level: "L1" | "L2" | "L3" | "L4";
    required: boolean;                 // brief.cast 或关系闭包
    stateId: string | null;            // 最新八项卡
    stateThroughChapterId: string | null;
    knowledgeIds: string[];            // 投影后仍有效的知情
    relationshipIds: string[];
  }>;
  hardCanonRuleIds: string[];          // visibility=writer only
  mustNotDo: string[];                 // 来自 chapterBrief
  banReveal: {
    authorOnlyRuleIds: string[];       // 仅计数/指纹，不输出文本
    plannedLaterKnowledgeIds: string[];
    tokens: string[];                  // 可选：显式禁揭短语
  };
  fingerprint: string;                 // 对上述语义字段 canonical JSON 的 SHA-256
}
```

**装载顺序（pack 2.1，相对 2.0 的增量）**

1. 硬正典 `writer`（装不下 → 错，已有）  
2. 目标章 brief（summary/mustDo/mustNotDo；**mustNotDo 升为 mandatory**）  
3. **Cast 闭包整包**（基础卡 + 八项 + 知情 + 相关关系；装不下 → 错，**禁止省略**）  
4. 时间线 / 开放伏笔（可预算裁，但 `status∈{setup,progression}` 优先）  
5. 正文证据（最后裁）

### E.3 Write-Ready / generation-ready 同构门

| 门禁名 | 触发点 | 通过条件 | 失败错误码（建议） |
|---|---|---|---|
| `gate.writing_state_present` | pack/preflight | `writing-state.json` 存在 | `writing_state_missing`（已有语义） |
| `gate.prev_chapter_state_commit` | preflight | 上一章 completion 与正文 rev/SHA 一致 | `state_commit_required`（**已有**） |
| `gate.hard_canon_unconflicted` | preflight | 无 `canonStatus=conflicted` | `hard_canon_conflict`（**已有**） |
| `gate.context_pack_fresh` | save | preflight 重建 fingerprint 一致 | `context_preflight_stale` / `context_preflight_required`（**已有**） |
| `gate.cast_bound` | preflight **新增** | CastBindingSet 非空且 fingerprint 写入 preflight | `cast_binding_required` |
| `gate.cast_complete` | pack **新增** | 每个 `required` 角色有 entity；L1/L2 必须有 `through≤cutoff` 动态卡 | `cast_incomplete` |
| `gate.cast_budget` | pack **新增** | cast 整包 ≤ 预算 | `context_budget_cast_overflow` |
| `gate.brief_must_not_loaded` | pack **新增** | brief.mustNotDo 全进 mandatory | `brief_must_not_omitted` |
| `gate.author_only_excluded` | pack 断言 | sections 不含 author_only 文本 | `author_only_leak` |
| `gate.planned_later_excluded` | 投影/pack | continue 视图无 planned_later 正文 | `future_knowledge_leak` |
| `gate.actor_identified` | AI save **新增** | provider/model/role 齐全 | `actor_identity_required` |
| `gate.post_write_scan` | stage 前 **新增** | 机审无 P0 structure fail（或显式 acknowledge） | `consistency_scan_blocked` |

**preflight `ready` 扩展伪代码**

```ts
ready =
  blockers.length === 0
  // 现有
  && !state_commit_required
  && !hard_canon_conflict
  // 新增
  && castBinding.fingerprint === input.castBindingFingerprint
  && castBinding.cast.every(c => !c.required || c.stateId || c.level >= "L3" /* L3/L4 可无完整八项 */)
  && !authorOnlyInPack
  && actorIdentityPresent; // 若策略要求
```

### E.4 写后机审：`evaluate_novel_chapter_consistency`（P19 同构）

**四态**（与漫剧一致，禁止合成单一「PASS 分」冒充）：

| verdict | 含义 | 是否挡 stage/下一章 |
|---|---|---|
| `consistent` | 结构规则未命中违规 | 不挡；仍要人审状态候选 |
| `needs-review` | 可疑（启发式/软规则） | 不自动挡；ticket 或 UI 标黄 |
| `drifted` | 明确结构漂移 | **可**配置为挡 stage（P0 项） |
| `not-checkable` | 文学/声口/魅力等 | 只提示，永不当 PASS |

**建议机审准则表（code 稳定，供测试钉死）**

| code | 类型 | 规则概要 | 默认 verdict | fail-closed? |
|---|---|---|---|---|
| `KNOW_UNKNOWN_ASSERT` | 知情 | 角色对白/POV 断言命中该角色 `status=unknown\|planned_later` 的 fact 归一化键 | drifted | **是**（若开启严格模式） |
| `KNOW_MISBELIEF_BREAK` | 知情 | 角色表述与 `misbelieved` 条目矛盾且未标记纠正事件 | needs-review | 否 |
| `BAN_REVEAL_TOKEN` | 禁揭 | 正文含 `banReveal.tokens` 或 brief.mustNot 抽取 token | drifted | **是** |
| `AUTHOR_ONLY_PHRASE` | 禁揭 | 可选：owner 登记的 author-only 短语表 | drifted | **是** |
| `CAST_NAME_OUT_OF_SCOPE` | cast | 未绑定实体以主名/别名完整登场（白名单外） | needs-review | 否（误报多） |
| `REL_JUMP` | 关系 | `relationCode` 转移不在允许表 | drifted | 可配置 |
| `DYNAMIC_BODY_LOCK` | 外形 | `appearanceLocks` 负向词命中（「独眼」却写双眼） | needs-review / drifted | 锁存在时建议是 |
| `FORESHADOW_PAYOFF_EARLY` | 伏笔 | payoff 状态在 brief 禁止回收时出现明确回收句 | needs-review | 否 |
| `STYLE_VOICE` | 声口 | — | not-checkable | **永不**机判 PASS |
| `LIT_QUALITY` | 文学 | — | not-checkable | **永不** |

**接口形状建议**

```ts
// MCP 只读
evaluate_novel_chapter_consistency({
  chapterId: string;
  expectedChapterRevision: number;
  expectedChapterSha256: string;
  castBindingFingerprint: string;      // 写前 cast
  writingStateRevision: number;
  writingStateFingerprint: string;
  mode: "strict" | "advisory";
}) -> {
  schemaVersion: 1;
  kind: "novel-chapter-consistency-evaluation";
  verdict: ConsistencyVerdict;         // 聚合 = max(rank)
  items: Array<{ code; entityId?; span?; verdict; note }>;
  evidence: { chapterSha256; stateFingerprint; castFingerprint; evaluatorVersion; configSha };
  // 永不包含 decision: accepted
}
```

### E.5 状态候选机检（stage 时）

在 `novel_stage_chapter_state_candidate` 增加**结构校验**（不替代人审）：

| 校验 | 错误码 |
|---|---|
| delta.characterStates.entityId ∈ cast 或本章出场集合 | `state_delta_unknown_entity` |
| knowledge 新 known 必须能在正文 UTF-16 证据或 summary 中定位（弱：summary 声明） | `knowledge_without_warrant`（P1 可先 advisory） |
| `fields.known/unknown` 与 knowledge ledger 投影冲突 | `knowledge_ledger_inconsistent` |
| relationship through 隐式 = 本章 | （已由 apply 逻辑设 throughChapterId） |
| foreshadowing planned→payoff 跳跃跳过 setup | `foreshadow_status_jump` |
| 空 delta 且章字数 > 阈值 | `state_delta_suspiciously_empty` → needs-review，不 fail-closed |

---

## F. 百万字不崩（一致性相关工程门 · 部分）

| 门 | 说明 |
|---|---|
| **投影不扫全文** | 状态按 chapter order 索引；cast 查询 O(角色+其知识条)，禁止每次 pack 反序列化后线性滤 10 万知识无索引（派生 SQLite 可重建，权威仍 JSON） |
| **cast 上限** | 单章 `required` cast ≤ 16（可配置）；超过必须拆章或标「群像章」用关系聚合卡 |
| **知情条预算** | 每角色装入 top-K by priority + 本章 brief 点名 factId；其余可检索 `search` 二次拉取，但二次拉取结果须并入 fingerprint 或禁止影响 preflight |
| **锁与 CAS** | 已有 command ledger + state revision/fingerprint；多代理写同书必须 `acquire` 类租约（可复用 studio write lease 模式） |
| **恢复** | 中断只丢未 accept 候选；completion 链是恢复点；禁止用聊天记录「补状态」 |
| **改旧章** | `revise_chapter` 使下游 completion stale → `state_commit_required` 连锁（已有 staleCompletion 逻辑）；产品上要 UI 显示「从章 K 起状态作废」 |

---

## G. 多 AI 协作协议（谁写 / 谁审 / 谁改状态）

### G.1 角色矩阵（软件可执行）

| 角色 role | 允许 | 禁止 |
|---|---|---|
| `writer`（Grok/千问/豆包/Claude 主笔） | pack → preflight → `novel_save_chapter`；之后可 `stage` 候选 | 直接 accept 状态；读 author_only；`whole_book_review` 自升级 |
| `reviewer`（GLM/DeepSeek/Codex 审） | `taskType=review_chapter`；`novel_attach_review_ticket`；只读 state/pack | save 正文；stage 伪装人审 |
| `state_suggester`（可与 writer 同模） | `novel_stage_chapter_state_candidate` | `novel_review_chapter_state_candidate` |
| `owner`（人类或显式 owner actor） | accept/reject 状态；seed；裁决 hard_canon conflict；维护 banReveal | 把「模型自动 accept」做成默认 |
| `consistency_scanner` | 只读 evaluate | 任何写 |

### G.2 跨模型接力防漂协议（强制顺序）

```
Agent-A(writer, provider=qwen):
  1. get_novel_writing_state(before N)
  2. build_novel_context_pack(continue, cast=…)  // 得 fingerprint + castBinding
  3. preflight_novel_chapter_write(原样 writePreflightInput)
  4. 生成正文（仅使用 pack.sections；禁止外挂「全书摘要记忆」覆盖八项）
  5. novel_save_chapter(aiWriteContext + actor)
  6. evaluate_novel_chapter_consistency(advisory|strict)
  7. novel_stage_chapter_state_candidate(delta)
  8. 停止 — 等待 owner accept

Owner:
  9. novel_review_chapter_state_candidate(accepted|rejected)

Agent-B(writer, provider=grok) 写 N+1:
  10. 必须重新 1–3；禁止复用 A 的 preflightId / fingerprint
  11. 若 B 想「参考 A 的聊天」→ 非法；只读 CAS 正文 + state 投影
```

### G.3 防三类故障的机械对策

| 故障 | 机制 |
|---|---|
| **人设漂移** | Cast 强制八项+locks 进 pack；写后 DYNAMIC_BODY_LOCK / 人审；禁止无 preflight save |
| **知情越权** | knowledge 投影过滤 + KNOW_* 机审 + known/unknown 与 ledger 对齐 |
| **禁揭泄露** | author_only 不进 writer pack；banReveal tokens；reviewer 用 through 也不得把 author_only 塞进 ticket 正文建议的「应写内容」——ticket schema 可禁 `suggestedCanonText` 超长粘贴 |

### G.4 模型切换检查表（实现为 preflight 附加条件更佳）

- 新 provider ⇒ 新 `requestId`/`idempotencyKey`/`preflightId`  
- 同一章多 writer 接力改稿：以**当前章 CAS** 为底，不得并行两个 in-flight save（ledger CAS）  
- 审稿模型输出只能进 ticket；要把审稿意见写进正文，必须 **owner 或 writer 重新走 continue/revise 全链**

---

## H. 明确「软件做不到 / 不该做」

### 做不到（物理/语义极限）

1. **保证文笔、魅力、节奏、「像人」** — 无确定性算法。  
2. **理解所有隐喻性泄密**（角色用暗码说出禁揭）— 机审只能抓显式 token/结构化 fact 键。  
3. **在模型权重内删除已读的未来情节** — 只能不把未来装进输入；若用户粘贴剧透，软件管不了模型脑内。  
4. **自动合并同名角色/别名** 为正典 — 必须人确认（合同已禁）。  
5. **用聊天窗口记忆当跨会话真相** — 明确禁止。

### 不该做（产品红线）

1. **机器自动 `accepted` 状态候选**（等于自动改正典）。  
2. **机器自动文学 Review PASS / 自动锁版**。  
3. **为省预算静默丢弃 cast 角色八项/知情**（应 fail-closed）。  
4. **把 author_only 硬正典放进任何 writer/reviewer 默认可读 pack**（审全稿应用显式 owner 工具 + 审计日志）。  
5. **平行第二份 writing-state / SQLite 正典 / Agent 私有 character card 文件** 绕过 CAS。  
6. **推翻漫剧 P0–P14 owner** 或把小说状态写进 `material-studio.sqlite`。  
7. **用向量相似度单独充当知情边界**（可作检索辅助，不可作唯一门）。  
8. **把 formal 测试 PASS 写成「百万字人物永不崩」产品承诺**。

---

## 与现实现状的精确差距（实现者向）

| 能力 | 代码位置 | 状态 |
|---|---|---|
| 八项 schema | `NovelCharacterDynamicFields` | ✅ |
| 知情/关系/伏笔时态投影 | `projectNovelWritingState` | ✅ |
| writer-only 硬正典 | `buildNovelContextPackV2Attempt` filter | ✅ |
| 指定 characterIds 强制整包 | 同上 `requestedCharacters` 分支 | ✅ 半套：未指定则仍可省略 |
| preflight 双 blocker | `deriveNovelWritePreflight` | ✅ 仅 commit/conflict |
| AI save 指纹 | `validateNovelAiWriteContext` | ✅ |
| 状态候选人工 commit | stage/review 命令 | ✅ |
| CastBindingSet / write-ready cast 门 | — | ❌ 未建 |
| 正文 vs 知情机审 | — | ❌ 未建 |
| actor/provider 强制 | — | ❌ 未建 |
| known/unknown 派生一致性 | — | ❌ 双写自由文本 |
| 外形/声口结构化锁 | — | ❌ 仅 body 自由文本 |

---

## 建议错误码总表（稳定字符串，便于 MCP/CLI）

| code | HTTP/CLI | 含义 |
|---|---|---|
| `state_commit_required` | reject write | 上章状态未 commit 或正文 SHA 变（已有） |
| `hard_canon_conflict` | reject write | 硬正典冲突未裁决（已有） |
| `context_preflight_required` | reject write | 无 aiWriteContext（已有） |
| `context_preflight_stale` | reject write | pack/state/正文漂移（已有） |
| `writing_state_missing` | reject | 未 seed（已有） |
| `cast_binding_required` | reject preflight | 缺 CastBindingSet |
| `cast_incomplete` | reject pack | 必选角色缺卡 |
| `context_budget_cast_overflow` | reject pack | cast 装不下 |
| `brief_must_not_omitted` | reject pack | mustNotDo 未进 mandatory |
| `author_only_leak` | reject pack | 禁揭进了 writer 视图 |
| `future_knowledge_leak` | reject pack/投影 | planned_later 泄漏 |
| `ban_reveal_hit` | reject 或 advisory | 正文命中禁揭 token |
| `knowledge_ledger_inconsistent` | reject stage | 八项与知情账冲突 |
| `relationship_jump_illegal` | reject stage | 关系非法跳变 |
| `foreshadow_status_jump` | reject stage | 伏笔状态机违规 |
| `consistency_scan_blocked` | reject stage | 严格模式机审 drifted |
| `actor_identity_required` | reject save | 缺 provider/model/role |
| `state_delta_unknown_entity` | reject stage | delta 实体不在场 |
| `state_delta_suspiciously_empty` | advisory | 长章空 delta |

---

## MVP 落地顺序（仅一致性轨，供主审排期）

1. **文档+合同**：CastBindingSet 与错误码写入 `AI_AGENT_CONTRACT` 下一版草案（不改关账证据）。  
2. **P0 门**：`characterIds` 缺省策略改为「从 brief.cast 推导，否则 fail」+ cast 预算 fail-closed。  
3. **P0 禁揭断言测试**：pack 永不含 author_only / planned_later 正文。  
4. **P1** evaluate 只读工具 + strict 可挡 stage。  
5. **P1** stage 时 knowledge↔八项对齐。  
6. **P2** 外形/声口 locks 与 UI Cast 面板。

---

## 验收话术（避免过度宣称）

- 可宣称：「写章前状态投影与指纹门可机械阻断无状态续写；cast 强制后可机械阻断缺卡开写。」  
- 不可宣称：「跨 Grok/Codex/千问 人物永远一致 / 软件替代作者过手。」  
- 与漫剧对齐句式：**机器四态辅助，不自动 PASS；generation-ready（write-ready）只表示结构可写，不表示成文优质。**

---

## 本席交付边界

- 已答：A/B/C/E/G/H 全文；D/F 中与一致性直接相关切片。  
- 未答：完整 90 天路线图（I）、纯 UI/性能 SLA 细节 — 交主审或其他子代理。  
- 只读分析，未改 `src/**`，未跑模型，未触达《黑页》正式源。
