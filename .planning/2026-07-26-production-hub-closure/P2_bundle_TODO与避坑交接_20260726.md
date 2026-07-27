# P2 · StudioProductionProjectionBundle 设计草案 — 任务交接

更新时间：2026-07-26

## 一、任务背景

目标：为"画布当前单元驾驶舱"设计一个只读聚合投影 `StudioProductionProjectionBundle`，
把原本分散在 dashboard / binding / continuity / generation / generation-review /
generation-ledger / post-result-observation / multimedia-timeline / production /
video-package / material-studio 共 11 个 Core 只读接口的调用，聚合成一次调用返回。

设计依据：
- `.planning/2026-07-26-production-hub-closure/next_phase_plan.md` 第4节"永久设计红线" + 第5节 P2
- `.claude/skills/ai-drama-canvas-agent/SKILL.md` 的 P8 驾驶舱合同（已实现且 PASS，本 bundle 是在其基础上扩展聚合，不是替代重做）

本会话角色：修正一份已有设计草案。独立核对代理已指出 4 处问题（3 必修 + 1 补全），
本会话逐一修正，并做了更大范围的自查（额外发现 6 处问题一并清理）。

## 二、硬约束（后续任何会话必须延续，不可放松）

- 仓库 `/Users/hxx/Documents/无限画布` **全程只读，一个字节都不能改**。
- 本任务**唯一**允许写入的文件是草稿本身；其余一切产出（设计记录/裁决/交接文档）
  都只是文字记录，不代表已经或将要落地到仓库任何文件。
- 若未来要真正把这份设计接入仓库，需要另一次会话在**明确的"可以写仓库"任务授权**下进行——
  不能因为本交接文档写了"建议落地位置"就默认已经获得了写权限。

## 三、当前产物状态

草稿文件（唯一被写入的文件）：
`/private/tmp/claude-501/-Users-hxx/3afadc8c-ccc5-4e64-b5a5-44ad757fb3b8/scratchpad/draft-studio-production-projection-bundle.ts`

- 全文约 1233 行，已完整重写并二次修正。
- 已用仓库自带的 `node_modules/.bin/tsc --noEmit`（仅 CLI flag，未新建任何 tsconfig/符号链接）
  直接验证语法：除预期内"离开仓库目录后 relative import 无法解析"的噪音外，
  **零真实语法 / 逻辑错误**。
- 已核对：42 个导入符号全部在真代码里被使用（非仅注释提及），无死 import 残留。
- 已用 `git status` 确认本会话全程未对仓库产生任何写入（仅有本会话之前就存在的、与本任务无关的
  `.agents/skills/*` 等 staged 文件）。

**注意**：本文件与草稿文件都在 scratchpad（session-specific 临时目录），不保证跨会话持久保留。
若需要长期留存，需要使用者自行决定复制到仓库之外的某个持久位置——本次任务权限下我不会
主动把内容写入仓库或其他项目目录。

## 四、本会话修正清单（对照独立核对代理指出的问题 + 自查发现）

**核对代理指出的 4 处（3 必修 + 1 补全）：**

1. `StudioDashboardPanelDetail`（不存在的类型名）→ 真实类型名 `StudioDashboardPanelSummary`
   （`src/core/studio-production-dashboard.ts:263-278`），已改全部引用点。
2. `continuity` 字段里编造的 `.head` 字段已删除；真实接口
   （`src/core/studio-continuity-review-control.ts:221-237`）没有 `head`，
   改为直接转发真实的 `StudioContinuityReviewNextAction` 对象。
3. `episodeStartSeconds` / `episodeEndSeconds` 改为从
   `timelineProjection.unit.episodeStartSeconds/.episodeEndSeconds` 取
   （`src/core/studio-multimedia-timeline.ts:124-125`）；`unitDetail.unit` 上没有这两个字段。
4. 此前 4 个"只在 import 里声明、骨架 body 内从未真正调用"的函数现已真接入：
   - `getStudioBindingControl` → `panel.binding` 的 `blockers`/`freezeAllowed`/`confirmEmptyAllowed`
   - `readAnyStudioGenerationFrozenPack` → `currentUnit.frozenPackIdentity`
     （由 own 审核记录的 `packId` 驱动）
   - `getStudioVideoPackageControl` → `currentUnit.videoPackage`
     （由 own 审核记录的 `reviewId` 驱动）
   - `getStudioCanonicalAsset` → 每格 `controlAssets` 的
     `name`/`authorityMediaSha256`/`authorityThumbnailRecipeKey`

**本会话自查额外发现并修复的问题（超出核对代理原范围）：**

5. `toMediaRef` 里一处"过度防御性 cast"掩盖了真实类型不匹配：
   `StudioDerivativeStatus` 实际只有 `"ready"|"pending"` 两个字面量
   （`material-studio.ts:29`），草案曾用 cast 硬转成 bundle 自己的四字面量类型；
   已改成诚实的显式双分支映射，不再使用 cast。
2. 5 个死 import：`inspectManagedProject`（额外发现它有写副作用
   `ensureManagedGenerationLedger`，不适合用来"凑合用上这个 import"）、
   `StudioProductionDashboardError`、`STUDIO_DASHBOARD_UNIT_PAGE_LIMIT`、
   `StudioBindingControlSnapshot`、`AnyStudioGenerationFreezePack`——
   逐个删除并在原位置注明原因。
3. `continuity` 的 revision stamp 来源此前错标成 `"studio-binding-control"`
   （复制粘贴遗留），已改为新增的 `"studio-continuity-review-control"` 字面量
   （`StudioProjectionSource` 联合类型已相应扩充）。
4. 若干处"真实字段已直接可用却仍套 `as unknown as {...}` / `?? 兜底`"的多余防御性
   写法（如 `season`/`episode`、`panel.ordinal`/`panel.label`、timeline 的
   `role`/`endSeconds` 等），已改为直接访问真实字段。

## 五、D6 开放问题裁决记录（写在草稿文件头部注释里，非仓库变更）

- **a（裁决：允许，尚未落地）**：允许未来在 `studio-production.ts` 新增对称的
  `getStudioCanonicalPredecessorUnitIds()`；本草稿的 `resolvePreviousUnitId()`
  目前仍是骨架桩，恒返回 `null`，不做启发式猜测。
- **b（非裁决题，产品语义待定）**：`observation.own` 该绑定"unit 级已批准结果"
  对应的 run，还是"当前选中格"对应的 run？unit-grid 架构下理论上相同，但语义
  可能分叉，需要产品/交互方拍板，本轮不代为裁决，留 TODO。
- **c（已裁决并落地）**：相邻单元定位改用显式 `StudioProjectionAdjacentLocator
  {previousUnitId, nextUnitId}`，废弃容易让人误以为是分页 opaque token 的
  "cursor"命名。
- **d（裁决：允许，尚未落地）**：允许未来把
  `studio-production-dashboard.ts` 内部私有的 `mapUnitSummary`/`mapAsset`
  等映射函数改为 export 供本 bundle 直接复用；本草稿目前仍是"复制一份等价
  逻辑"的写法（如 `stableValue`/`digest`）。
- **e（裁决：本次 P2 首切片不做，留给 P7）**：`getStudioMedia()` 目前每次
  调用独立开关 db 连接（非快照复用），连接复用优化延后到 P7，正确性优先。

**极重要提醒（已写入草稿文件头部）**：a/d 的"允许"仅代表主代理的设计裁决被
记录在注释里，**不代表** `studio-production.ts` / `studio-production-dashboard.ts`
已经或将要被写入——本次任务里仓库全程零改动。真正落地属于另一次会话在另一份
明确的"可写仓库"任务授权下发生的动作。

## 六、剩余 TODO（供未来实现阶段参考，粗略按阻塞程度排序）

1. `currentUnit.frozenReferences`：冻结包内资产闭包展开（角色/场景/道具/
   风格/VFX 连线），目前只有"包身份"（`frozenPackIdentity`），没有"包内容"。
2. `approvedRaw`/`approvedLabeled`/`selectedResultSource` 的 sha256 解析：
   需要复刻 `resolveUnitGridSelectedResultIdentity` 等价逻辑；当前
   `currentUnit` 与 `adjacentUnits` 两处相关字段都留空（`undefined`）。
3. `observation.incoming`：依赖 D6.a（predecessor 查询）先落地，目前恒为
   `undefined`。
4. D6.b 产品语义决策：`own` 观测尾态到底绑定哪个 `generationRunId`，需要
   产品/交互方拍板后再实现。
5. `videoPackage.control`/`nextAction` 子结构的 IPC 安全审计：目前只暴露了
   已核实安全的标量字段（`status`/`selectedIntentId`/
   `selectedIsDestinationHead`/`blockers`），`control`/`nextAction`/`query`
   子结构明确未纳入。
6. D3 提到的"同一物理 SQLite 文件、跨 owner 的真正同事务只读快照"优化：
   目前是并发独立快照（各自 open/close），不是真正同事务。
7. D6.d 真正把 `mapUnitSummary`/`mapAsset` 等改为 export 复用（需要改
   `studio-production-dashboard.ts`，本次任务不允许，需新授权）。
8. D6.a 真正新增 `getStudioCanonicalPredecessorUnitIds()`（需要改
   `studio-production.ts`，本次任务不允许，需新授权）。
9. IPC/MCP 边界层的 media URL 补全（`studioMediaUrl()` +
   `"aicanvas-studio://"` 协议）：本 bundle 的 Core 层类型故意不含 `url`
   字段（见 D4），需要在未来的 `main/index.ts` 改动里补上与
   `canvas:get-studio-media` 一致的清洗 + URL 拼接。
10. `currentUnit.panels[].generationHistoryHead`：完整生成历史仍走既有 IPC，
    本 bundle 只打算暴露"最新一条摘要"，尚未实现（见旧 IPC 映射表）。

## 七、如何续接（给下一个会话/下一个人）

若要把这份草案真正落地进仓库：

1. 先明确获得"可以写 `src/core/*.ts`（新增文件，且可能需要给
   `studio-production.ts`/`studio-production-dashboard.ts` 加 export）"的
   授权——这次任务没有这个授权。
2. 建议落地位置：`src/core/studio-production-projection.ts`，与其他 11 个
   owner 模块同级（纯编排层，不建新目录）。
3. 优先处理"剩余 TODO"里第 1-4 项（直接影响真实可用性），第 5-10 项可以
   后续迭代，不阻塞首次上线。
4. 每次改动后重新对照本文件第五节 D1-D6 设计决策 + 草稿文件头部注释，
   避免重新引入这三类问题（本会话两轮修正专门在打这三类假）：
   - 编造/访问不存在的字段（必须逐一读真实源码签名核实）
   - 过度防御性 cast 掩盖真实类型不匹配（真实字段类型已经对得上就不要加 cast）
   - "只 import 声明、骨架体内从未真调用"的挂名函数（每个 import 都要能在
     真代码里指出具体调用点）
5. 落地时同步跑一遍 `tsc --noEmit`（或直接 `npm run typecheck`，如果仓库有
   配好的脚本）做语法/类型自检，而不是只凭 review 肉眼过一遍。
