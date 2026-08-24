# 连接 Codex

AI 漫剧画布的 MCP 服务使用本地 stdio，不监听网络端口。Codex 官方配置支持在 `[mcp_servers.<server-name>]` 中设置 `command`、`args`、`env` 和 `cwd`：[Model Context Protocol 配置](https://learn.chatgpt.com/docs/extend/mcp#configure-with-configtoml)。

## 受管 Studio 标准环（当前唯一正式链路）

新开 Codex 后无需粘贴工程路径或长说明，只需说“继续当前 AI 漫剧项目”。固定顺序为：

`get_capabilities → get_active_managed_studio_context → readiness / freeze / dispatch → commit_agent_imagegen_result_bundle → Review`

1. `get_capabilities` 核对 release manifest、build identity 与当前协议。
2. `get_active_managed_studio_context` 从共享活动注册表读取唯一活动受管工程、UI locator、锁定资产摘要和 `projectContextToken`；不从项目列表猜第一个。
3. 读取 readiness，冻结当前 Binding/连续性/提示词/最多六项参考，并用 `dispatch_studio_generation_pack(provider=codex)` 登记执行意图。
3a-1. P19：审片前可调用只读 `get_studio_consistency_evaluation` 获取结果与参考的机器一致性辅助判定（四态：一致/需复核/明显漂移/无法检查；人物/场景/道具分类权重，动物按人物；证据绑定 generationRunId 与全部参考版本，任一输入变即 stale）。机器只辅助不自动 Review PASS；黄金面具等结构项走"无法检查+人工硬锁清单"，不用人脸算法判道具。
3a-2. P20：剧本拆格可用只读 `suggest_studio_storyboard_draft` 获取建议（每单元严格 15 秒、2–6 格；每格含来源范围/起止秒/原镜或扩写/景别/运镜/转场/对白/服装状态/场景光线/负提示词；扩写（extension）格不锚原文、仅允许位于单元末尾连续后缀且至少 1 格原镜）。软件负责 Schema/时长/资产/消歧/连续性校验与物化；扩写不冒充原镜，未审核/未硬锁不冻结。
3b. P21：可选先 `create_studio_generation_plan` 对多宫格建立计划（内容寻址幂等，重复开始不重复派发）；命中 plan 节点的 pack 派发必须使用计划推导 runId（`<planId>:node:<i>:attempt:<n>`）。失败必须 `fail_studio_generation_run` 登记（否则该宫格永久 in-flight 并触发 `panel-run-in-flight`）；取消用 `cancel_studio_generation_run`；失败/取消后重试用 `retry_studio_generation_plan_nodes`（新 attempt，旧结果保留不动）。逐节点状态经 `get_studio_generation_control` 的 `plan` operation 读取；已取消 run 拒绝新结果登记。
3c. P24：追溯一律用只读 `get_studio_trace`：`by-pack`/`by-run`/`by-result` 返回当时链投影（剧本 revision、原文 spans、单元修订、提示词 revision、BindingSet、连续性指纹、runs/results/reviews 有界列表与预期/非预期变化分类——历史身份经冻结包还原，绝不读 head；`changeClassification` 由 BindingSet currentness 实时重算，`expected`=用户有意推进修订，`unexpected`=pin 破坏/资产语义变化/未知原因，需人工复核）；`script-revision-impact` 按剧本 revision 反查受影响单元修订→宫格→冻结包→runs→结果（两层分页 limit≤100）。`get_studio_production_unit_snapshot` 新增可选 `unitRevision` 读取不可变历史快照（缺省=head）。
4. Agent 单图生成后调用 `commit_agent_imagegen_result_bundle`；它原子校验并导入 raw、本地派生 labeled、登记同 provider 结果，失败可幂等重试但不会自动视觉通过。
5. 用户在桌面端 Review，通过或返工仍写入受管 Review owner。

仓库短 skill：`.agents/skills/managed-studio-agent-loop/SKILL.md`。当前正式生图默认且已实时验收的是 Codex；合同层保留 Grok 离线兼容，但用户因无额度已将 Grok live 移出本轮。浏览器、Artlist 和网页自动化不得作为正式供应商。

当前活动正式工程为 `projects/codex-ai-drama-studio`，约 1.1GB，包含 85 项资产、541 个 15 秒单元、3246 个宫格和 1152 项媒体，不是空库。桌面端 0.2.0 已用 Developer ID 安装到 `/Applications/AI 漫剧画布.app`，仅供本机使用；未 Apple 公证、未上传、未公开发布。

## 验证服务

```bash
cd /Users/hxx/Documents/无限画布
npm run build:mcp
npm run mcp:smoke
```

工具总数禁止写成长期常量：以安装包内 `release-manifest.json.mcpToolCount` 和 `get_capabilities` 为权威。已安装 0.2.0（P15）为 183 tools；源码构建自 P19 起为 186 tools（P19 一致性评估 +1、P20 分镜建议 +1、P24 追溯 +1，P19–P24 终验 buildId `22799978`）。构建与文档若不一致必须失败关闭，不能用 165/180/181 等历史数字放宽门禁。服务同时暴露 Resources、Resource Templates 与 Prompts。

P0–P14 已按各自 final-validation PASS；下文 P2–P7 的 165/180/181 等数字仅为各历史阶段快照。P11–P14 的当前关账配置为 `codex-primary-v1`：Codex live、真实 canary、安装版、备份恢复、规模和 30 分钟 soak 均通过；Grok live 为 `NOT_RUN` 且不计入完成门。权威机器证据为 `docs/evidence/p11-p14-final/final-validation-20260719-p11-p14-codex-primary-desktop-loop.json`。

黄金面具唯一权威图固定为 `/Users/hxx/Desktop/豆姐参考图.png`，SHA-256 `02e9438ecee038f7d14860da37cb315bf358db4a26fa224e342eee5b592b55a9`；正式资产 `prop-d01-golden-mask` 为 revision 9、Review `approved`。所有旧 D01 Binding、连续性、冻结包和生成结果均为 stale 历史，不得提升。任何生成提示词、参考板或冻结包必须消费当前权威版本，禁止半面具、裂面具、口型或结构替换。

> **历史兼容提示**：下文 P2–P7、网页生成、Artlist、浏览器、ComfyUI 与旧工具数段落仅用于解释旧工程和回归测试，不是 P11–P14 正式生产指令。其中“第三季 Artlist 当前固定”的“当前”只指当时历史快照，现已失效；正式链路一律回到本文顶部的 Codex 受管 Studio 标准环。

P2 逐宫格引用闭包新增 7 个工具：`audit_fusion_panel_references`、
`list_fusion_panel_reference_resolutions`、`get_fusion_panel_reference_resolution`、
`list_derived_panel_reference_assets`、`materialize_fusion_panel_references`、
`upsert_panel_reference_override`、`register_derived_panel_reference_artifact`。正式 store 反查当前
宫格合同、分镜行、连续性时间段和 `continuityReferenceAssetIds`；不能只证明
`semanticAssets ↔ referenceSlots` 内部自洽。`contractCoverageVersion=1` 时，合同资产减去
显式排除必须全部进入语义资产，宫格显式连续性参考必须全部进入语义资产，语义资产必须
全部被最多 6 个槽完整覆盖。超过 6 项只返回版本化派生组合定义；在真实图片和 Review
通过前状态仍为 `pending-derived-artifact`，不得伪装成可生成。旧 store 缺少该审计版本时
currentness 返回 `resolver-contract-coverage` 并失败关闭。

P3 结构化剧情与视觉硬锁新增 5 个工具：
`audit_fusion_visual_constraints`、`list_fusion_visual_constraints`、
`get_fusion_visual_constraint`、`materialize_fusion_visual_constraints`、
`upsert_fusion_visual_constraint_override`。正式 store 逐格冻结 `mustAppear`、
`mustNotAppear`、身份/空间/连续性锁、模型安全载荷和人工 Review 规则的独立指纹；列表只返回
分页身份、锁计数和警告摘要，完整模型载荷只允许按单格读取，任何接口都不返回媒体二进制。
EP32 前模型载荷不得出现黄金面具身份、详细外观或本地路径；P01 只能作为闭合不透明布囊
处理。presence/reveal 修订必须通过命令账本和 store revision CAS，且最终视觉结论仍要求人工
逐格逐条 attestation，机械检查不得替代人工 Review。

P4 正式中文分镜板证据链新增 3 个工具：`get_fusion_storyboard_sheet_state`、
`list_fusion_storyboard_sheets`、`migrate_fusion_storyboard_sheets`。state 冻结当前合同、P3
requirement、有效 Review、逐格 Job/Publication/raw/labeled SHA 与渲染策略并返回候选指纹；
list 明确区分 `current`、`stale`、`invalid`、`legacy-invalid`，只返回结构化摘要和本地路径，不返回
媒体二进制；migrate 必须同时携带 store revision 和候选指纹做 CAS，只登记历史成板及其派生状态，
不修改 Job、Publication、Review、raw/labeled 或只读源，也不触发供应商或生图。正式 render 还必须
回传 state 给出的 `expectedInputFingerprint`，输入漂移时拒绝重放旧成板命令。

`get_production_workflow` 除 15 阶段状态外还返回 `evidenceAudit`：每阶段包含 `ready`、`statusEvidenceValid`、`legacyUnverified`、`issues`、计数指标、核验时间和证据指纹。完成状态不能代替该审计。用 `update_production_workflow_stage(status=completed)` 写入时会验证真实文件并保存完成指纹；标记任一下游阶段完成前，还会重新核验所有已有指纹的前置阶段。后续领取或生成同样会重新检查。媒体执行门禁按本次任务 `itemIds` 核验，允许不受影响单元继续，但全项目审计仍会暴露其他单元的漂移。

`filesystem` 导入的既有制作包如果已经存在真实 unit/shot、剪辑、渲染或 Publication，却没有可证明的 story-first 阶段历史，Doctor 会返回 `existing-production-recovery` error，普通任务包和生成继续失败关闭。不得把 15 阶段批量伪造为 completed。先调用只读 `preview_existing_production_recovery`，提交 itemIds、`image`/`video_continuation` 目标、完整分镜合同和参考素材；预检冻结 info/参考文件 SHA、扫描 ID 和 evidence fingerprint，不写 workflow。确认后通过带稳定 requestId/idempotencyKey 的 `commit_existing_production_recovery` 提交 `previewId + expectedWorkflowRevision`。成功只新增内容寻址 scoped baseline；未覆盖节点与普通 video 仍拒绝。GenerationJob 会冻结 baseline id/digest，`process_generation_queue`、`get_browser_generation_plan` 和每次网页检查点写入前都重新核验 scope 与文件哈希。显式 `create_task_pack(itemIds)` 也不能绕过该门禁。

production workflow、Creative Bible、AssetRelation、VoiceIdentity 和 ProjectContext 的既有事实写入都强制 revision CAS。命名工具与 `execute_command` 使用同一合同：create 不得携带 `id/expectedRevision`；update 必须携带非空 `id` 与当前 `expectedRevision`；`delete_context` 必须携带 `contextId/expectedRevision`。缺失、非法、过期 revision、未知 id、空 id 和 create 带 revision 在副作用前分别形成结构化拒绝；经命令总线执行时进入确定性 `failed` 账本，不进入 `unknown`。Relation/Voice 会在任何索引读取前完成 CAS，旧窗口失败请求不会顺带触发扫描。Bible/Voice/Context 的部分字段更新会保留未提交的隐藏数组和 tags。

以下门禁同时实跑 source/compiled stdio 的公开 schema 与写入行为，以及两个独立 Electron 进程的旧窗口 update/delete：

```bash
npm run mcp:revision-cas-smoke
npm run ui:revision-cas-smoke
```

该 P4 历史 MCP smoke 当时要求两模式各发现 165 tools、7 个相关工具公开 revision schema、所有确定性拒绝 `unknownLedgerCount=0`。它只用于解释旧证据，不能作为当前工具数门禁；当前总数必须从 release manifest 动态读取。Electron smoke 使用两个独立 `--user-data-dir` 共享同一隔离项目/registry，覆盖 Context stale update/delete、Workflow、Bible、Relation、Voice；最终 winner 值落盘、loser 值不存在、每个事实 revision 只增加 1，并生成带 SHA-256/像素门禁的 1560×980 截图。该双窗口 CAS Electron 证据属于 source build；packaged ReviewStudio 的独立行为证据见下方隔离 package 门禁，二者不能互相替代。

导演验收以内容身份而非路径身份为准。`get_review_queue` 会先返回当前权威且必需的素材，再用历史版本填满最多 20 项的窗口，并公开 `artifactTotal` / `artifactsTruncated`；队列中用于提交的 snapshot 带每项 SHA-256。`submit_review` 的 `expectedScanId` 只追踪页面快照来源，真正的并发门禁是调用方所见 `expectedArtifactHashes` 与提交前两次定点重扫。ReviewRecord 保存不可变 `artifactEvidence`，图片与视频 pass 分相位持有；legacy artifactIds-only 记录不能证明当前完成。同路径图片漂移回到待视觉验收，视频漂移回到待视频验收；视频 pass 还要求当前四张权威首尾帧仍有有效 image pass。写记录前发现漂移时命令账本进入明确 `failed` 且不产生 ReviewRecord；记录已写、状态提交时再发生漂移则作为已确认副作用失败保留历史，并禁止以原幂等键危险重放。

应用关闭时的编译 MCP 闭环可重复运行：

```bash
AI_CANVAS_MCP_SERVER_PATH=/Users/hxx/Documents/无限画布/dist-mcp/mcp/server.js \
  npm run mcp:headless-smoke -- \
  /tmp/ai-canvas-mcp-compiled \
  /tmp/ai-canvas-mcp-compiled-registry.json
```

该段命令记录的是 P4 历史 headless smoke，当时覆盖 165 工具发现、生成供应商 CAS 增量配置与完整工作流回读、9 个 Resource Template、7 个 Prompt、任务幂等重放、租约、folder-video 落盘桥接、视觉验收、剪辑分割、后台导出、成片发布回执、时间线合成首帧、续接视频、生产阶段门禁、既有制作包 scoped recovery 和最终 Doctor。当前运行不得继续断言 165；应先读取 release manifest，再核对 `get_capabilities`。该历史脚本不会启动桌面窗口，也不会读取正式 AI 漫剧目录。

从空目录建立小说项目的纯 MCP 闭环可用下面的门禁验证；该脚本不直接导入任何 `src/core` 函数：

```bash
AI_CANVAS_MCP_SERVER_PATH=/Users/hxx/Documents/无限画布/dist-mcp/mcp/server.js \
  npm run mcp:empty-smoke -- \
  /tmp/ai-canvas-mcp-empty-compiled \
  /tmp/ai-canvas-mcp-empty-compiled-registry.json
```

流程为 `preview_project_import(projectMode=story_first) → commit_project_import → import_story_file → analyze_novel_chapters → generate/select/materialize → 逐镜确认 → validate → JSON/Markdown 导出 → 关闭并重连 MCP 验证恢复`。`projectMode` 是导入预检指纹的一部分，确认导入时会保留在幂等命令账本中，不会退回需要既有生产节点的 `filesystem` 模式。

`npm run package:isolated-smoke` 可在 `/tmp` 的独立 stage 构建临时 arm64 unpacked App，并验证包内 MCP/Electron。所有 builder 与 packaged runtime 子进程必须继承同一隔离 `HOME/TMPDIR/AI_CANVAS_REGISTRY_PATH/AI_CANVAS_MEDIA_RUNTIME_DIR/AI_CANVAS_PROJECT_ROOT`；`listResources()` 必须精确返回 `aicanvas://server/capabilities` 与 `aicanvas://projects`，任何具体 project URI 都会让门禁失败。2026-07-15 00:41 的 134-tool 结果是历史源码快照，只保留为旧证据。该隔离命令自身只创建并清理临时 App，不负责安装；当前 0.2.0 安装版是另一条已执行的 Developer ID 本机安装链，路径为 `/Applications/AI 漫剧画布.app`，local-only 且未公证、未公开发布。

命名写工具的外层统一返回幂等命令结果，业务值在 `result`。尤其注意：`process_generation_queue.result` 现为 `{ processedJobId, counts, recent }`，`recent` 只包含脱敏任务摘要，不返回提示词或签名结果 URL；恢复已有远程任务应传 `jobId`，避免顺带提交其他 queued 任务。每次轮询必须使用新的 `requestId`/`idempotencyKey`，否则只会重放旧等待态。`reconcile_http_generation_submission.result` 是窄化的对账结果，只包含任务/供应商稳定 ID、状态、HTTP 检查点、Publication 摘要和脱敏观测，不返回完整 GenerationJob、prompt、令牌或结果 URL；过期修订和非法证据会以 confirmed failed 写入命令账本，不会留下 `unknown` 或产生网络副作用。`apply_edit_operation.result` 是 `{ editProjectId, revision, updatedAt, affectedTrackIds, affectedClipIds }`，不是完整工程；后续渲染或续接前必须调用 `get_edit_project` 取得新工程和修订。`start_edit_render` 成功终态现在必须同时拥有 `publicationIntentId` 与 `publicationReceiptId`，否则剪辑生产阶段不会完成。

不要在文档里依赖容易过期的硬编码清单。连接后先调用 `get_capabilities`，它按导入、编排、素材、生成、验收、故事、生产设计、记忆、画布和剪辑域返回当前工具；`doctor_project` 检查路径、索引时效、15 阶段证据漂移/旧状态指纹、机械异常、队列、第三季六张一致性批次与 FFmpeg；`get_project_snapshot` 一次返回 Codex 继续工作所需的统一快照，并在 `productionDesign.evidence` 返回紧凑计数、`blockers`、`legacyUnverifiedStages`、`nextStage` 和 `suggestedCalls`，在 `productionDesign.assetConsistency` 返回批次成员、证据就绪度、复核有效性与硬锁进度。`runtimeResources` 返回扫描锁、前台媒体容量、活动成片 PID/ID、生成队列分布、受阻工具和当前跨进程锁；成片运行时 `suggestedNextCalls` 优先读取/取消成片，不再错误建议启动新代理或领取下游工作。Doctor 与统一快照使用只读渲染/剪辑/Skill 读取，不会通过一次检查创建六张侧车、恢复后台渲染或争抢写锁；显式 `prepare_fusion_asset_consistency_review` 才会安全接管仅 queued/plan_ready 且无远端副作用的旧资产任务。

`runtimeResources.machineMedia` 还公开全机容量、当前/可用权重、严格 FIFO 队列、当前项目活动/排队阶段和累计超时/孤儿回收指标；默认权重为 ffprobe 1、前台 FFmpeg 2、成片 FFmpeg 3，总容量 4。`get_capabilities.editor.mediaScheduling` 是桌面端、源码 MCP、编译 MCP 和安装结构 MCP 共用的合同。Doctor 的 `machine-media-runtime` 只读报告超容量、死亡宿主和运行指标；它不会为了“修好”报告而后台杀进程。显式媒体获取和 `list_edit_render_jobs` 恢复入口才会回收死亡宿主遗留的进程组与租约。

`scan_project` 每次仍以真实文件系统重新发现候选路径，但会从上一份索引复用未变化文件的机械检查；复用条件同时包含文件尺寸、mtime、ctime、检查器版本，以及本次是否要求 SHA-256。图片/音视频变化后才重新执行 Sharp/ffprobe，哈希采用 1 MiB 分块流式读取，机械检查并发固定为 6。扫描在普通素材和参考资产路径发现完成后读取原子发布快照：已处于 reserved 的目标被跳过；快照后新预留的目标在本轮发现时尚不存在，不能插入候选。这样既不会把浏览器下载或 FFmpeg 正在写入的部分文件登记为素材，也不会让长哈希/ffprobe 持有发布锁。`reservedPublicationFilesSkipped` 在返回值、MCP 进度、`get_progress`、Doctor 索引详情、统一快照 `scan.stats` 和桌面提示中公开；发布侧车 JSON 或结构损坏时，持久扫描失败关闭并保留旧索引。桌面扫描、监听刷新、`scan_project`、`execute_command(command=scan_project)` 和 `preview_scan_project` 均接收取消信号；stdio 客户端提供 `onprogress` 时还会收到严格递增的 MCP 进度通知。提交点前取消会终止在途 ffprobe，并保留上一份完整索引、SQLite 和扫描审计事件。

静态 Resources：`aicanvas://server/capabilities`、`aicanvas://projects`。Resource Templates 覆盖项目快照、节点、素材、画布语义、任务包、生成任务、剪辑工程、故事章节和增量变更游标：`aicanvas://projects/{projectId}/snapshot`、`.../items/{itemId}`、`.../artifacts/{artifactId}`、`.../canvas`、`.../tasks`、`.../generation/{jobId}`、`.../editor/{editProjectId}`、`.../story/chapters/{chapterId}`、`.../changes/{cursor}`。Prompts 包含 `resume_project`、`produce_next_image_batch`、`produce_next_video_batch`、`continue_video_from_last_frame`、`review_visual_batch`、`run_browser_generation`和 `recover_interrupted_work`。

Codex 写入优先统一调用 `execute_command`，每次携带稳定 `requestId` 与 `idempotencyKey`。命令执行前先以跨进程锁持久化 `running`；业务副作用完成后写入专用终态证据 `command.side-effect-committed`，成功回执后再写 `succeeded`。能证明业务已经闭合失败的路径写入 `outcomeStatus=failed` 的精确终态证据和账本 `failed`，原幂等键不会重放；只有副作用结果确实无法确认的异常才写 `unknown`。`scan_project` 在索引提交点前被明确取消时写入独立终态 `cancelled` 和 `command.cancelled`，不写副作用完成证据；原键不会重放，需要扫描时必须换新的 requestId/idempotencyKey。取消同键等待者不会终止已经在另一个请求中执行的原命令。其他可能产生付费或远端副作用的写命令不会因客户端断线被盲目中止。同一幂等键会自动附到内部素材、任务、状态等真实副作用事件。恢复时可调用 `reconcile_command`：只有找到请求哈希、命令和幂等键完全匹配的终态证据才会对账为 `succeeded` 或已确认 `failed`，且绝不重新执行；`cancelled` 只作为已确认终态返回，中间事件不能冒充完成，没有终态证据时继续保持未确认。Review、实际末态观察及 generation checkpoint/attestation 是普通“返回原结果”合同的明确例外：相同键重放返回完整不可变事件字段和回放时的只读 Head 提示，但 `head`、`current`、`eligibleForPass`、`approvedRawEligible`、`continuationEligible` 均不构成重新授权；调用方必须另读对应 control 获取当前动态资格。命令现已覆盖扫描/导入提交、任务租约、素材、生成、验收、故事/生产设计、画布、剧本、剪辑与续接。`get_capabilities.commandTypes` 返回当前命令，`get_capabilities.scan` 返回进度/取消边界，`list_command_ledger` 用于恢复和对账。所有可映射的命名剪辑写工具也进入同一账本；保存、原子编辑、撤销、重做、OTIO 导出、后台导出、时间线合成帧和续接都必须携带当前工程 `expectedRevision`，并由工程级跨进程锁完成原子 CAS。所有 MCP 结果同时包含结构化内容；错误统一返回代码、可重试标志和建议动作。

任务执行必须遵循 `create_task_pack → claim_task(expectedRevision, agentId, leaseSeconds) → heartbeat_task(expectedRevision, leaseId) → finish_batch(expectedRevision, leaseId)`。`claim_task`、`heartbeat_task`、`release_task` 和 `finish_batch` 在核心、命名工具、`execute_command` 与桌面 IPC 中都强制携带当前任务修订号；缺失或过期修订会在产生副作用前拒绝。统一命令总线使用相同幂等键重放时仍直接返回原结果，不会用旧修订再次执行。活跃任务不可重复建包或重复领取；过期租约重新领取时写入 `task.lease-expired`。放弃尚未执行的任务时可调用 `cancel_task(expectedRevision, reason)`，但只允许取消 `ready` 或租约已过期的 `claimed` 任务；活跃租约必须由当前执行者先 `release_task(expectedRevision, leaseId)`，验收中和终态任务不能取消。取消会保留原因、前一状态、租约来源和 `task.cancelled` 审计事件。任务包绑定已确认分镜的修订、首尾帧/视频提示词、时长、景别、运镜、动作、对白和参考素材，分镜变化后旧任务不能继续生成。`finish_batch` 验证成员集合、互斥成功/失败列表、真实扫描、权威文件和机械解码，只推进 `awaiting_review`。每个节点的视觉验收要求同时绑定本批素材 ID、SHA-256 和最早验收时间；旧验收或验收后被替换的文件不能完成新批次。关联的 `submit_review(pass)` 全部完成后，任务才转为 `completed`；返工验收会把任务标记为 `blocked`。

当前视觉验收永久门禁为 `tests/reviews.test.ts`、`tests/production.test.ts`、`tests/service.test.ts`、`tests/scanner.test.ts`、`tests/mcp.test.ts`、`tests/command-bus.test.ts`、source/compiled `tests/mcp-headless-workflow.test.ts`、`npm run ui:review-content-identity-smoke` 和 `npm run package:isolated-smoke` 的独立 packaged Review 分支。长期事实 CAS 追加 `tests/asset-registry.test.ts`、`tests/continuation.test.ts`、`npm run mcp:revision-cas-smoke` 与 `npm run ui:revision-cas-smoke`。既有制作包恢复追加 `tests/existing-production-recovery.test.ts`。全量当前基线为 41 个测试文件、252/252 通过；source 与 packaged Review UI 都必须通过旧快照拒绝、自动刷新 SHA、检查项重置、重验通过、完整 App 重启恢复、后续漂移失效、0 page errors、像素边缘覆盖与人工目视。

原文工作流：`import_story_file` 只接收本地文件路径并建立文本快照；Codex 用 `list_story_chapters` / `read_story_chapter` 逐章读取，再通过 `upsert_story_event` 写入草稿或已确认事件。只有 `confirmed` 事件会被 `build_story_context` 和新任务包引用，机械拆段或未审核摘要不能作为剧情事实。

小说自动分镜工作流：先用 `import_story_file` 或 `import_story_text` 建立真实章节快照，再调用 `analyze_novel_chapters` 提取带来源证据和修订号的事实/节拍；人工修订使用 `upsert_novel_fact`、`upsert_narrative_beat`。之后调用 `generate_adaptation_plans` 同时生成精简与拆分方案，分别用 `validate_adaptation_plan` 运行确定性门禁，选择方案后用 `select_adaptation_plan` 和 `materialize_adaptation_plan` 写入现有正式分镜与生产单元。事实或节拍变更后，先用只读 `analyze_adaptation_impact` 列出受影响节拍、方案、单元、镜头和生产节点，再用幂等写工具 `regenerate_adaptation_scope` 只重建指定方案中的受影响单元；未受影响单元保持原对象和镜头修订，重新物化也只写入 `pendingUnitIds`。最后用 `export_adaptation` 生成新路径 JSON/Markdown。所有写调用必须携带 `projectId`、`expectedRevision`、`requestId`、`idempotencyKey`；上游事实、节拍或章节内容改变后，已物化镜头的旧生产契约会在确认和任务读取时被拒绝。

模型辅助分析工作流：调用 `create_novel_analysis_task` 生成 Codex 或 `external` provider 的本地任务合同；根据返回的 `taskJsonPath` / `taskMarkdownPath` 逐章读取真实文件并生成结构化提案，再调用 `submit_novel_analysis_proposal`。该调用只建立待确认项。用 `list_novel_analysis_reviews` 读取证据问题，最后逐项调用 `review_novel_analysis_item`，或用 `review_novel_analysis_batch` 在一个事务中处理最多 200 条；批量接受会强制事实先于节拍，任一证据、引用或修订失败则整批不落盘。所有写工具都进入命令账本，模型输出不能绕过人工确认直接进入生产。

自动模型执行：先用 `get_novel_analysis_providers` 读取配置修订，再通过带 `requestId` / `idempotencyKey` 的 `upsert_novel_analysis_provider` 保存 OpenAI-compatible Base URL、模型名和密钥环境变量名。配置不会保存密钥值；`allowStoryUpload` 必须显式开启，访问 localhost、字面私网或 DNS 解析后的私网地址还必须开启 `allowPrivateNetwork`。`probe_novel_analysis_provider` 只访问同源 `/models`，不发送正文。短任务可直接调用 `execute_novel_analysis_task`；长篇应先调用 `plan_novel_analysis_run`，它按稳定章节顺序装箱，超长单章按句段边界切成不重叠、不丢字的绝对字符区间，再用 `get_novel_analysis_runs` 读取派生进度并逐次调用 `execute_next_novel_analysis_run_task`。每次只执行一个已解锁批次，前批人工确认完成后才允许下一批；跨批节拍使用独立全局序号区间。失败批次不能原地重置；只能用 `replace_novel_analysis_run_task` 创建带 `attempt` / `supersedesTaskId` 的新任务并保留旧错误。`submission_unknown` 还必须先人工对账并显式确认远端无可回收结果。执行器在请求前复核章节修订、SHA-256、Provider 修订和输入上限，正文不会附带本机绝对路径，响应大小受限且禁止重定向。模型 JSON 先经核心运行时 Schema，再写入任务目录的 `proposal.json`，最后仍只进入人工确认队列；`doctor_project` 会提示阻塞与对账。

成片工作流：先调用 `probe_video_engine`；再用 `list_edit_media` 读取可解码素材，需要波形/影片条时调用 `prepare_edit_media_preview`，高分辨率视频可用 `prepare_edit_media_proxy` 生成本地 H.264 代理；预览使用代理，导出仍读原素材。`create_edit_project` 建立项目级或单集工程，通过 `execute_command` 包装 `apply_edit_operation` 执行加轨、放素材、移动、播放头分割、裁切、Ripple 删除/留空和参数修改；桌面剪辑台也直接提供分割与 Ripple 删除。主画面与画中画共用同一 `EditKeyframe[]`，支持线性、渐快、渐慢、平滑、保持，以及 `easing=cubic_bezier` + `bezier={x1,y1,x2,y2}`；任意整数帧 split/trim 用 De Casteljau 生成只读 `derived_monotone` 子曲线，v2 的 `sourceWindow + sourceTransform` 是重建原轨迹的语义权威。曲线进入既有工程 JSON、revision CAS、`update_clip` 和撤销重做，不新增状态源。最低 `order` 的视觉轨固定为主画面；隐藏/静音主轨拒绝渲染且不会提升画中画，静音主画面片段保留等时长项目背景。主画面 X/Y 以项目画布中心为原点，等比适配后依次应用动态缩放、片段静态 opacity、旋转和位置。

复杂嵌套通过同一 `apply_edit_operation` 接口的 `add_nested_timeline` / `refresh_nested_timeline` 接入，并继续由 `execute_command` 提供幂等账本。新增会冻结子工程 ID、revision、时间基、画幅、可见源区间和 SHA-256 内容寻址快照；刷新必须显式携带当前子工程 revision，通用 `update_clip` 不能伪造冻结引用。父整数帧与子约分有理 source offset/step 是唯一映射权威；自身引用、循环、深度超过 8、缺失/篡改快照、缺失或漂移子工程和不可证明时长都拒绝。split/trim/move/ripple、CAS/history 和 undo/redo 沿用既有状态机。同步/后台成片、`extract_timeline_frame`、`prepare_timeline_continuation` 与 Electron 预览共享 `aicanvas.nested-timeline.ffmpeg.v1` resolver、依赖 manifest、render plan 和递归素材血缘；业务缓存使用可重建 FFV1+PCM，浏览器预览另派生内容寻址 H.264/AAC MP4。`get_capabilities.editor.nestedTimelines` 公开完整合同；正式《封神篇》项目校准完成后，`missingForFullNle=[]`。

OTIO 曲线继续接受 `aicanvas.cubic-bezier.v1/v2`，缺失、未知或伪造合同失败关闭。嵌套只接受 `metadata.aicanvas` 中 `aicanvas.nested-timeline.v1` 约束的 `Stack.1` 私有子集；导入会从冻结快照重建 canonical 标准 children 并交叉验证。标准 Effect/Transition 只接受 active `LinearTimeWarp.1`（精确 `effect_name=LinearTimeWarp`）和最低 order 主视觉轨相邻普通视频之间的 active `Transition.1/SMPTE_Dissolve`；根合同为 `aicanvas.otio-effect-transition.v1`。除该 allowlist 外，未知 Stack/Timeline、Effect、Transition、marker、disabled/opaque 对象和不支持组合会在创建工程前拒绝。工程支持 23.976/29.97/59.94 分数时间基，整数帧、FFmpeg 和 OTIO 使用同一有理速率。`undo_edit_project` / `redo_edit_project` 使用持久快照，`export_edit_otio` / `import_edit_otio` 与外部工具交换已声明的可保真子集，不冒充通用 NLE 兼容。长导出使用 `start_edit_render`，再用 `get_edit_render_job` 读取进度，必要时 `cancel_edit_render`；同一项目最多运行一个后台成片 FFmpeg。预览、代理、时间线帧、源视频末帧、时间线续接和同步导出共享项目级前台重媒体容量；后台成片启动后拥有资源优先级。取消请求会同步到真实运行任务，FFmpeg 退出后仍需通过 ffprobe 才能进入 `succeeded`，所有输出都是新文件。

`get_capabilities.editor.effectTransitions` 公开该有界合同：TimeWarp scalar 为 0.1–8，仅普通本地视频/音频；Dissolve offsets 是正整数帧，要求同轨紧邻切点以及经 FFprobe 验证、从媒体起点开始的 available range、incoming pre-roll 和 outgoing post-roll。首版不允许 Dissolve 与 TimeWarp、transform keyframe 或 fade envelope 组合；视觉 dissolve 不改变独立 audio track 时域，AI Canvas 既有 `fade` 仍是淡到背景。MCP 不新增旁路工具，仍通过 `apply_edit_operation(update_clip)` 或 `execute_command` 使用 revision CAS 和幂等账本。Effect/Transition 的源码永久门禁是 `tests/editor-effect-transition.test.ts`、`tests/mcp-editor-effect-transition.test.ts`、`npm run editor:effect-transition-render-smoke` 和 `npm run ui:editor-effect-transition-smoke`；正式《封神篇》校准又在 24000/1001、54 主片段、长后台成片、OTIO 往返、Publication、Continuation、source/compiled MCP 与 source Electron 完整重启中覆盖该合同，当前 `missingForFullNle=[]`。

正式剧本校准使用 `inspectFormalDramaSource` / `materializeFormalDramaProject` 将用户授权的只读权威源复制到工作区全新隔离根。正式源没有原生音视频时，manifest 必须保留 `sourceNativeMedia=false`，派生校准媒体不能冒充源素材。完整 NLE 成功 evidence 为 `formal-project-nle-core-20260715-0729.json`、`formal-project-nle-mcp-20260715-0748.json` 和 `formal-project-nle-ui-20260715-0751.json`；它们记录当时 source/compiled 134 tools、master r6、Doctor 0/0。P2 阶段源码为 157 tools，P3 阶段为 162，P4 关账快照为 165；这些都不是当前工具数。未入队 Continuation 仍通过 `update_video_continuation` revision CAS 明确取消，与当前 image job 相互独立。

项目级锁仍负责同一项目的业务不变量，但机器级运行时负责所有项目、桌面进程和 MCP 进程的总资源上限。后台渲染从真正取得容量开始到 FFmpeg 关闭始终持有权重 3；扫描和发布 ffprobe 只占权重 1，可以使用渲染保留槽位。取消与超时终止整个 POSIX 进程组；日志只保留受限尾部；成功、失败、取消和 `timed_out` 分别记录。严格 FIFO 不允许后来的轻任务越过已经等待的重任务，以避免永久饥饿。能力读取应以实时合同为准，不要把默认容量当成永不变化的常量。

末帧续视频默认使用 `prepare_timeline_continuation`，而不是只从单个源视频截图。该工具必须携带 request ID、幂等键、剪辑工程 ID、目标 15 秒节点和预期工程修订；它会一次完成合成末帧提取、目标首帧新版本登记、素材血缘、续接包和视频生成入队。续作任务的 `purpose` 为 `timeline_continuation`、参考模式为 `first_frame`，因此可从单个已解码合成首帧开始；普通视频任务仍只允许首尾帧视觉验收通过的节点。相同幂等键重试只返回原结果；核心层还会复用同一工程修订、时间点和目标节点的合成帧/续接包，防止桌面端重试产生重复队列。没有剪辑工程时，才退回 `extract_last_frame` + `create_video_continuation`，随后必须调用 `enqueue_generation(kind=video, continuation={continuationId, firstFrameArtifactId})` 绑定唯一 GenerationJob；这类任务标记为 `video_continuation`。续接包只投影关联 GenerationJob 的 `queued/preflight/uploaded/submission_unknown/submitted/processing/downloaded/completed/failed/cancelled` 状态，不能独立写成 submitted 或 completed。`update_video_continuation` 只允许带 `expectedRevision` 和原因放弃尚未入队的包；已绑定任务必须走网页检查点、队列处理和对账接口。Doctor 会报告未入队包、提交不明、投影漂移和任务/续接包引用缺失。

一图一子代理生图使用 v2 执行检查点。先用 `get_subagent_image_generation_plan` 读取当前修订、冻结提示词/参数/参考 SHA、raw/labeled bundle 和安全动作，再通过 `update_subagent_image_generation` 严格执行 `claim → heartbeat → start_call → generated → visual_accept|visual_rejected`。claim、heartbeat、release 和 takeover 都绑定 `leaseId + owner + fence`；只有 v2 租约字段完整、尚无 call intent 且 TTL 已过期时才能接管。`start_call` 必须在模型调用前原子持久化稳定 runId/callId；调用后必须保存 receipt。进程在生成中失联、旧协议已领取却缺 receipt，或任何无法证明远端副作用的情况，一律进入 `generation_unknown`：严禁 claim、takeover、cancel、process 或再次调用生图，只能用结构化既有证据执行 `reconcile_unknown`。`generated` 仅登记任务隔离候选，不写正式路径；主代理目视通过后，`visual_accept` 才把 raw/labeled 双成员 Publication bundle 原子登记，任一成员失败都不留下半套回执。项目级与供应商级并发均固定为 1。`migrate_generation_execution_state` 只迁移既有执行证据，不触发供应商调用或伪造 intent/receipt。

网页生成工作流：先调用 `get_generation_settings` 读取修订号和摘要；该读取对未配置项目仅返回修订 0 的默认值，不创建文件。需要编辑已有工作流时，用 `get_generation_provider` 读取单个供应商的完整非机密配置；再用带 `expectedRevision` / `requestId` / `idempotencyKey` 的 `upsert_generation_provider` 增量保存一个网站、HTTP 接口或本地工作流。它保留其他供应商，过期修订会在写入前拒绝，配置只允许保存凭据环境变量名。随后建立 `codex-browser` 供应商并配置网站地址。能力注册表明确参考模式、图/视频参考数量、时长、画幅、分辨率和并发限制；上传项按角色、服饰、道具、场景、风格、首帧、尾帧、源视频和遮罩语义标记。`process_generation_queue` 为任务生成受控操作计划；Codex 通过 `get_browser_generation_plan` 读取登录态检查、上传白名单、冻结 SHA-256、提示词、隔离下载路径与 `currentCheckpoint.revision`。每次 `update_browser_generation_job` 都必须携带刚读取的 `expectedRevision`、稳定 `requestId` 和 `idempotencyKey`；过期窗口会被 CAS 拒绝。预检未通过时使用 `preflight_blocked`，在 `preflightEvidence.blockers` 记录 `login_required`、`page_not_ready`、`generation_mode_mismatch`、`insufficient_credits`、`paid_action_unauthorized` 等结构化原因，并在 `observedGeneration` 保存当前可见模型、画幅、分辨率、图片数、Generate 是否可用和额度提示；它保持同一 job、Publication 与输出预留可恢复，严格拒绝上传和提交。阻塞解除后必须用同一 job 和新 CAS 修订回写完整 `preflight`，不得重新入队。通过后的回写只能依次经过 `preflight → uploaded → submit_intent → submitted → processing/downloaded`，不能直接从上传跳到提交。`preflight` 必须携带结构化 `preflightEvidence` 且 blockers 为空；`uploaded` 必须携带 `uploadEvidence.files[]`，逐项填写 `path`、`role`、`order` 和实际 `slot`。程序会拒绝白名单外路径、重复路径/槽位/顺序、语义角色错配、首尾帧顺序错误和计划后被修改的文件。完整分镜合同仍保留所有来源路径，但 Browser Action Plan 只上传当前模式需要的媒体，并排除审片用 labeled。点击网站提交按钮前必须先回写 `submit_intent`；返回的检查点会保存 `clientJobId` / `attempt` 并进入 `submission_unknown`。此后只有两条合法路径：拿到稳定外部任务 ID 后回写 `submitted`；或通过供应商任务列表、clientJobId 搜索、浏览器历史确认没有远端结果，提交 `submissionReconciliation.result=not_found` 后关闭旧任务并创建新版本。重启不会再次点击付费按钮；下载结果验证文件魔数和 SHA-256 后才登记。画布本身不保存网站账号、密码或 Cookie。

网页执行面现在是一等冻结身份：`GenerationProvider.executionSurface={id,version}` 会进入执行快照、browser request、checkpoint 和 `preflightEvidence`。`get_browser_generation_plan` 返回 `executionSurfaceStatus=current / legacy_unidentified / provider_mismatch`；配置切换浏览器后禁止沿用旧页面证据。对尚未提交且 Publication 仍为 reserved 的 `plan_ready/preflight_blocked` 任务，可用 `update_browser_generation_job(status=refresh_plan, expectedRevision, expectedSettingsRevision)` 原子刷新同一 job 的执行快照和计划；job ID、Publication、提示词、白名单与输出路径保持不变，旧 preflight evidence 被清除。第三季 Artlist 当前固定为 `codex-in-app-side-browser@1`，禁止静默切换 Chrome。成功 `preflight` 不再只相信 `generationModeVerified=true`：核心会把页面可见 model、aspectRatio、resolution、imageCount 与冻结计划逐项等值比较，并要求 Generate 明确可用。text-only 任务进入 uploaded 时还必须提交 `observedReferenceThumbnailCount=0`。`codex-browser` 只有 downloaded checkpoint、externalTaskId、隔离下载路径和 checkpoint 身份完整一致才允许验收；提前出现 expectedOutputPath 会写旁路拒绝事件且不登记 Publication。正式图片还要通过冻结画幅、最小尺寸/体积、完整解码和非低熵占位检查。

生成供应商新配置会拒绝 endpoint、poll/cancel endpoint 或 site URL 的敏感 query/fragment，必须改用 `apiKeyEnv` 和请求头。为了安全读取旧工程，`get_generation_settings`、`get_generation_provider`、`upsert_generation_provider` 命令回放、`list_command_ledger` 与 `reconcile_command` 都会在 MCP 输出边界脱敏 provider URL；生成任务摘要只返回结果主机名，不返回完整 `remoteResultUrl`。

`doctor_project` 会把任何 `submission_unknown` 或一图一子代理 `generation_unknown` 标成警告并优先给出对账动作。`generation_unknown` 建议先读取 `get_subagent_image_generation_plan`，不得领取、取消、接管、处理或重生；`candidate_generated` 则要求先核验隔离候选、call receipt 与 raw/labeled bundle，再由主代理视觉裁决。网页 `submission_unknown` 建议先读取 `get_browser_generation_plan`，HTTP 任务直接给出 `httpSubmissionCheckpoint.revision` 和 `reconcile_http_generation_submission`，ComfyUI 任务只允许用 `process_generation_queue(jobId)` 查询已保存 promptId 的 history/queue；混合存在时各自动作都会保留。可恢复的 `preflight_blocked` 也会单独计数并给出同一 job 的 `get_browser_generation_plan → update_browser_generation_job → doctor_project` 修复链；它不是远端提交不明，也不能被自动重排队。ComfyUI 原子取消未取得 pending 稳定 absent 或 exact `execution_interrupted` 时也会继续提示定向复核。缺少匹配结构化来源的 Generation Publication `failed/cancelled`、终态 Job 与检查点漂移、同任务混入多个适配器检查点会作为错误报告，不能借自由文本终态解锁重复提交。已 completed 阶段证据失效时返回 `production-evidence-drift` 错误，旧 completed 缺少指纹时返回 `production-evidence-verification` 警告，并优先建议 `get_production_workflow → execute_command → doctor_project`。`productionDesign.evidence.nextRepair` 给出下一阶段、原因、是否必须先修证据、当前证据路径/节点，以及可直接放入命令总线的 `requestIdHint`、`idempotencyKeyHint` 和 `request={command:update_workflow_stage,payload:{stageId,status,expectedRevision}}`。每成功修复一个阶段都必须刷新快照，不能用旧 revision 连续写多个阶段。付费提交待对账仍拥有最高恢复优先级，其他情况下证据修复优先于领取新任务。

通用 HTTP 生成在调用远端前先持久化 `generation.submission-intent` 和稳定客户端任务 ID。远端已经接收但本地未拿到可靠回执时，任务进入独立修订的 `httpSubmissionCheckpoint(stage=submission_unknown)`，重启后不会自动再次付费提交。先在供应商侧核对，再调用 `reconcile_http_generation_submission`：`found` 允许的方法为 `provider_task_list / client_job_id_search / provider_idempotency_lookup / provider_request_log / provider_support`，并必须提供稳定 `externalTaskId`、`evidenceReference` 和说明；它只把同一任务恢复为 `waiting_remote`。`not_found` 还必须提供 `confirmNoRemoteResult=true`，先以匹配 Job、clientJobId、attempt 与检查点修订的结构化来源关闭旧 Publication/Job，再允许显式创建新版本。两条路径都要求 `expectedRevision + requestId + idempotencyKey`，命令本身不执行 POST、GET、轮询或下载。`cancel_generation_job` / `cancel_generation` 只有在供应商声明支持并配置真实取消接口时才会调用远端取消；没有取消能力时拒绝制造“本地已取消”的假象。

已有 HTTP 远程身份的观测状态分为 `pending / succeeded / confirmed_failed / retryable_or_unknown`；5xx、超时、断连、坏 JSON、完成但缺结果 URL、下载中断或本地解码失败都保持 `waiting_remote` 与 Publication `reserved`，只有结构化远程失败值才关闭任务。恢复必须用 `process_generation_queue(jobId)` 定向同一任务，不会再 POST 或顺带提交其他 queued 任务。下载写入 `.aicanvas/generation-downloads/<job>/result.partial`，只有大小、魔数、完整解码和 SHA-256 通过才能不可覆盖地发布；目标内容冲突转为 `inspect_publication`。取消只在 HTTP 204，或 HTTP 200 且返回结构化 `cancelled/canceled` 终态时才关闭本地任务；Publication 已登记时优先恢复成功回执，不再向远程发送迟到的取消。Generation 只投影与 `projectId/jobId/itemId/clientJobId/attempt/externalTaskId/checkpointRevision` 匹配的结构化 Publication 终态来源；自由文本、旧版或修订不匹配的 `failed/cancelled` 保持任务锁定，`registered` 并发终态始终优先。HTTP 对账能力已经在核心、命名工具、`execute_command`、Capabilities、Doctor、Snapshot、Generation Resource、续接包和恢复 Prompt 中贯通。

ComfyUI 本机图片工作流使用 `adapter=comfyui-local`、loopback origin 和 API-format workflow 的显式 `promptInputs/outputNodeId/outputIndex`。任务在任何 POST 前冻结 canonical UUID promptId、稳定 clientId、attempt、物化工作流 SHA-256 和请求文件；暂态预检错误保持 `prepared` 并复用同一 attempt，确定性 4xx/缺节点才在提交前失败。回执断连后只按同一 promptId 查 queue/history，不得再 POST。官方 prompt 5-tuple 必须匹配 promptId、物化图、clientId、`extra_data.aicanvas` 的 Job/attempt/工作流/输出标签和 `outputs_to_execute`；history 只接受同 promptId 的 exact `execution_success/error/interrupted`，history 哈希漂移或矛盾终态保持锁定。成功输出还要匹配绑定节点/索引及安全的 `filename/subfolder/type=output`，随后进入隔离下载、完整解码、SHA-256 和不可覆盖 Publication。`cancel_generation_job` 只调用 `/api/jobs/{promptId}/cancel`：pending 要求 `cancelled:true` 后两次稳定 absent，running 必须等待 exact `execution_interrupted`；`cancelled:false`、503、无 history 或 registered/success 竞态不会制造本地假取消。Capabilities、Doctor、Snapshot、Generation Resource、Continuation 和桌面供应商设置均暴露这一脱敏合同；真实本机 ComfyUI 校准仍等待用户明确授权。

日常接续建议先调用 `get_continuation`。该工具组合真实扫描进度、下一任务、项目记忆、最近验收和启用 Skill；若需要长期保存，调用 `create_handoff` 将相同快照写入项目侧车。`search_context` 不读取聊天历史，只检索项目本地记忆和真实生产数据。

首次接入必须使用两段式导入：

1. 调用 `preview_project_import`，传入主根、附加来源根、输出根、忽略词和可选命名规则。命名规则支持自定义正则的 `episode` / `unit` / `shot` 命名组，以及路径前缀到节点的人工映射。
2. 向用户汇报识别数量、机械异常、跨根冲突和写入范围。
3. 用户确认后，将返回的 `previewId` 与完全相同的参数传给 `commit_project_import`。

若参数变化或预检存在错误，确认导入会拒绝执行。默认 `filesystem` 模式完全识别不到生产节点时仍视为导入错误，必须补命名规则或人工映射。桌面向导明确选择 `story_first` 时可以建立小说起步空项目，但仍验证主根存在、可读写和来源边界，并要求用同一模式完成两阶段确认；结果是带真实零计数的空索引，不代表生产完成。预检本身不会创建 `.aicanvas` 或登记项目。素材同时具有稳定 `artifactId` 与 `aicanvas://projects/{projectId}/artifacts/{artifactId}` URI；整体移动项目根目录后身份保持不变，绝对路径只用于本机落盘与打开文件。

安装版会将 MCP 解包到应用资源目录，Codex 可使用：

```text
/Applications/AI 漫剧画布.app/Contents/Resources/app.asar.unpacked/dist-mcp/mcp/server.js
```

这是当前 0.2.0 本机安装版的真实 MCP 路径。桌面端“Agent 连接”会用同一 App 的可执行文件以 `ELECTRON_RUN_AS_NODE=1` 启动它，并绑定包内 release manifest 与共享活动注册表；不依赖系统 Node，也不能从历史 `/tmp` 临时包路径继续启动。

生成链在入队时通过 `preflight_publication` 预留唯一新版本路径；`register_publication` 先在短锁内读取 intent/receipt 和瞬态文件身份，释放项目锁后执行 Sharp、ffprobe 与固定 `O_NOFOLLOW` FileHandle 的 SHA-256，再在短锁内按 revision、reservationToken、status、不可变意图字段和强文件身份 CAS 生成唯一回执。强身份包含 canonical root/parent 与 dev/ino/mode/nlink/size/mtimeNs/ctimeNs，不持久化也不经 MCP 暴露。同尺寸同 mtime 的 rename 替换会保留 `reserved` 并拒绝旧结果；校验期间取消或其他终态优先；两个进程并发注册同一 intent 只生成一份回执，输家复验后返回同一 receipt。锁外崩溃不产生 `validating` 中间态，仍可用原修订重试。稳定机械失败写入 Publication `failed` 和命令账本 confirmed failed；已登记幂等重放与剪辑恢复也必须复验当前文件哈希。reserved 期间即使目标文件已经出现，扫描也不会把它当成完成证据；进入终态后下次扫描再按真实文件和命名规则判断。`list_publications` 和统一快照只返回脱敏意图摘要/回执，不暴露预留令牌或瞬态指纹。`get_capabilities.publication.registrationConsistency` 返回上述合同，Doctor 把“目标已出现”表述为待机械校验而非 ready。所有发布写工具都进入幂等命令账本。

生成供应商可保存 `generic-json`、`comfyui-api` 或 `browser-recipe` 工作流。保存会拒绝 API key、Cookie、Authorization、密码等凭据字段，限制深度/条目/体积，并计算规范化 SHA-256。入队任务冻结供应商配置、工作流、提示词、参数、正式分镜和参考素材哈希；落盘请求单、网页 Action Plan、HTTP 提交和 ComfyUI 物化请求都携带 `executionSnapshotHash` / `workflowHash`。网页计划与 `run_browser_generation` Prompt 强制先做结构化预检：不满足时写入可恢复 `preflight_blocked`，满足后同一 job 写入 `preflight`，再依次经过 `uploaded`、`submit_intent`、`submitted` 和 `downloaded`，不能跳过状态机；ComfyUI 则由核心持久状态机自动处理，MCP 只需定向调用现有 `process_generation_queue` / `cancel_generation_job`，不新增旁路写接口。

开发工作区仍使用 `/Users/hxx/Documents/无限画布/dist-mcp/mcp/server.js`。

## 第三季融合生产入口

第三季融合包按“只读源预检 → 内容寻址隔离物化 → 资产/连续性查询 → 2–6 格合同 → 逐格唯一参考板与生图 → 本地中文成板”的顺序进入画布。MCP 只返回结构化摘要、本地路径和 SHA-256，不返回图片内容、base64 或 1288 个单元的整包正文。

| 入口 | 类型 | 合同 |
|---|---|---|
| `inspect_fusion_package` | 只读 | 核验 `15s_fused_units.json`、单元 MD、提示词表、资产库、源剧本、精确计数与全源清单 SHA-256；不创建侧车。 |
| `materialize_fusion_project` | 幂等写命令 | 重新预检后在 `targetParent` 建立 CAS 隔离工程；重复输入返回原工程，源漂移和目标冲突失败关闭。 |
| `list_fusion_production_assets` | 只读分页 | 返回资产定义、GPT Image 2 合同、生成/硬锁状态、权威快照路径与 SHA；默认 30，最大 100。 |
| `list_continuity_tracks` | 只读分页 | 返回角色、场景、道具跨集与单元的连续性摘要；最大 100。 |
| `get_continuity_spans` | 只读分页 | 返回指定资产的集、15 秒单元、原镜、秒段、同场资产和参考版本；最大 200。 |
| `build_fusion_reference_board` | 幂等写命令 | 从当前真实扫描索引构建参考板；仅接受已验收硬锁，最多 6 项，禁止静默裁剪。 |
| `build_fusion_storyboard_grid` | 幂等写命令 | 使用 `semantic-beat-v1` 从中文动作强标点、动作转折和秒点生成可审计的 2–6 格；`one-decimal-boundaries-then-difference-v1` 先量化可见边界再求显示时长，保证页面合计 15.0s。两项版本共同进入合同身份与 UI 幂等键；覆盖宫格数必须绑定当前修订和原因。 |
| `migrate_fusion_storyboard_evidence` | `execute_command` 幂等写命令 | 建立显式 current selection；仅当旧 pass Review 精确覆盖当前合同全部 `panelCount × 2` 个文件及 SHA 时追加派生 Review。旧记录保持不可变，不完整单元保持失败关闭。 |
| `get_fusion_storyboard_sheet_state` | 只读 | 返回指定单元当前成板证据闭包、store revision、候选输入指纹、current/history 状态与阻塞原因；不读取或返回媒体二进制。 |
| `list_fusion_storyboard_sheets` | 只读 | 列出已登记成板及 PNG/SVG/receipt 成员，逐项派生 `current` / `stale` / `invalid` / `legacy-invalid` 和原因；旧板不会因路径仍存在而重新成为权威。 |
| `migrate_fusion_storyboard_sheets` | 幂等写命令 | 必须携带 `expectedStoreRevision` 与 `expectedCandidateFingerprint`；可用 `itemIds` 限定范围，只登记旧成板和派生状态，不改上游生产事实、不触发生成。 |
| `get_fusion_asset_consistency` | 只读 | 返回每批 6 张的成员、`hidden-mask-first-then-first-appearance-v1` 冻结生产顺序与下一批、Publication/raw/labeled/单图 Review 就绪度、跨图复核有效性、硬锁进度及阻塞原因。 |
| `prepare_fusion_asset_consistency_review` | 幂等写命令 | 安全接管仅 queued/plan_ready 的旧任务；证据齐备后本地生成 2×3 中文复核板，明确标记为 review-only。 |
| `submit_fusion_asset_consistency_review` | 幂等写命令 | 用 store revision + snapshot SHA 做 CAS，七项标准必须逐项选择；P01 批次强制黄金面具完全不可见，只有不含 P01 的批次可将该项标为不适用。 |
| `seal_final_fusion_asset_consistency_batch` | 幂等写命令 | 仅在全季其他无权威资产均已入批时，显式封存最后 1–5 项；仍须完成同一复核。 |
| `enqueue_generation` | 幂等写命令 | 第三季资产必须严格按 P01 隐藏面具优先、其余首次出场顺序入批；跳号失败且不产生 Publication。第三季单元必须携带 `fusionStoryboardPanel={contractId,panelIndex}` 逐格入队；不同格可并存，同格、旧合同或未知旧任务拒绝重复付费。 |
| `render_fusion_storyboard_sheet` | 幂等写命令 | 正式入口强制携带 state 返回的 `expectedInputFingerprint`，只读取同一当前合同下已完成、已发布、raw/labeled 成对且拥有有效全格 Review requirement 的逐格图。v2 以内容寻址新路径生成中文 SVG/PNG/receipt 并登记正式 Artifact；图片默认 `contain`，任何 crop 必须有归一化焦点或裁切矩形证据，中文先测量再动态排版，不能用省略号静默删字。renderer 的 `layout-preview` 不能进入正式 receipt。 |

上述写入口既可使用同名工具，也可放进 `execute_command.request`；两种形式都会进入同一跨进程命令账本，必须提供稳定 `requestId` 与 `idempotencyKey`。权威输入必须显式包含小写完整 SHA-256 和是否可暴露给生成队列：

```json
{
  "projectRoot": "/Users/hxx/Documents/无限画布",
  "requestId": "fusion-materialize-s3-v1",
  "idempotencyKey": "fusion-materialize-s3-source-sha-v1",
  "request": {
    "command": "materialize_fusion_project",
    "payload": {
      "packageRoot": "/只读源/07_9x16_15秒融合制作包",
      "sourceRoot": "/只读源",
      "targetParent": "/Users/hxx/Documents/无限画布/production-projects",
      "authorities": [{
        "id": "ahang-authority",
        "assetId": "C01",
        "name": "阿航权威三视图",
        "sourcePath": "/Users/hxx/Desktop/阿航_青年_三视图_.jpg",
        "expectedSha256": "64位小写sha256",
        "rules": ["同脸、黑衣、发髻、左侧银白挑染"],
        "exposeToGeneration": true
      }]
    }
  }
}
```

物化命令结果刻意只保留 `targetRoot`、`contentAddress`、manifest/receipt SHA、计数、侧车路径和文件数量；完整 manifest、1288 单元和 2640 秒段留在本地隔离工程。构建参考板时必须把新工程的 `targetRoot` 作为 `projectRoot`，并使用稳定节点 ID，例如：

```json
{
  "projectRoot": "/隔离工程/gushujuan-s3-内容地址前缀",
  "requestId": "fusion-board-ep01-unit001-start-v1",
  "idempotencyKey": "fusion-board-ep01-unit001-start-current-index-v1",
  "request": {
    "command": "build_fusion_reference_board",
    "payload": { "itemId": "season-三-ep01-unit001", "variant": "start" }
  }
}
```

若正式分镜显式引用超过 6 项，命令会拒绝；必须先建立并审核群像或道具组合派生资产。若源哈希、权威输入哈希、当前索引、硬锁状态或参考文件内容漂移，也会失败关闭，不允许通过手改响应或省略参考绕过。

第三季正式图片不能再绕过宫格合同直接对整个 15 秒单元入队。先建立合同，再逐格生成；画面提示词冻结为无字纯画面，中文表格由本地 renderer 完成：

```json
{
  "projectRoot": "/隔离工程/gushujuan-s3-内容地址前缀",
  "requestId": "fusion-grid-ep01-unit001-v1",
  "idempotencyKey": "fusion-grid-ep01-unit001-storyboard-r1",
  "request": {
    "command": "build_fusion_storyboard_grid",
    "payload": { "itemId": "season-三-ep01-unit001" }
  }
}
```

随后用返回的 `contractId` 调用 `enqueue_generation(kind=image, itemIds=[...], fusionStoryboardPanel={contractId,panelIndex})`。扫描器按宫格槽位分别选权威，ReviewStudio 必须逐格查看，`submit_review(pass)` 必须携带 `expectedRequirementId` 并精确提交当前合同全部 `panelCount × 2` 个 artifactId 与 SHA。只有该 Review 仍有效时才可调用：

```json
{
  "projectRoot": "/隔离工程/gushujuan-s3-内容地址前缀",
  "requestId": "fusion-sheet-ep01-unit001-v1",
  "idempotencyKey": "fusion-sheet-ep01-unit001-grid-id-v1",
  "request": {
    "command": "render_fusion_storyboard_sheet",
    "payload": {
      "itemId": "season-三-ep01-unit001",
      "contractId": "grid-20位内容地址",
      "expectedInputFingerprint": "get_fusion_storyboard_sheet_state 返回的完整输入指纹"
    }
  }
}
```

本地成板固定包含顶部中文单元信息、逐格画面、画面内容/动作、景别/构图、拍摄方式、连续性/声音、台词/字幕、时长和底部节奏链。AI 逐格图禁止中文、英文、数字、字幕、表格线、水印或界面元素；因此不会把模型生成的乱码当成正式中文故事板。

## 隔离素材中心的 P6 剧本绑定与生成闭包

受管 `story_first` 工程默认不扫描历史素材。Codex 先用 `list_studio_production_units` 分页定位 15 秒单元，再用 `get_studio_binding_control` 读取 Core 返回的 source span、章节/场景来源、实体提案、阻塞项、BindingSet currentness 和唯一下一动作。桌面端的剧本绑定工作台使用同一投影，不维护第二套状态。

写入统一经过 `execute_command`：

这里的“统一写入咽喉”特指受管 Studio 生产域。旧版自由画布仍有少量历史 IPC 写路径，由对应 Core 函数自行完成路径、修订和原子性防护；它们不是新增功能的模板。所有新生产能力必须复用 `execute_command` 与既有命令账本，不得再增加旁路写入口。

1. `analyze_studio_script_entities`：必须携带当前 `unitId / panelId / expectedRevisionToken`；只分析该宫格的冻结 source span。
2. `resolve_studio_entity_proposal`：显式接受精确匹配、人工选择候选或排除；MCP transport 固定 reviewer 为 `codex`，不得静默采用第一候选。
3. `confirm_studio_panel_empty`：仅允许 0 提案分析，必须带非空审阅说明；形成追加式 `confirmed-empty` 裁决，不能由 `proposals=0` 自动触发。
4. `freeze_studio_asset_binding_set`：冻结当前人工决策或当前 confirmed-empty，生成内容寻址 BindingSet。
5. `freeze_studio_generation_pack`：只接受 generation-ready/current 的统一引用闭包；每格最多 6 项控制参考。
6. `dispatch_studio_generation_pack`：在任何模型调用前登记本地 dispatch intent；它不冒充远端或 imagegen 已经成功提交。
7. `register_studio_generation_result`：把 raw/labeled 媒体 SHA 登记回原冻结 pack。输入在 dispatch 后漂移时仍可保存晚返回结果，但 `inputCurrent=false / promotionEligible=false`，必须重新 Review，不能自动提升为当前权威。

普通 BindingSet 与 0 资产 confirmed-empty 都由 `PanelReferenceResolution Core V2` 生成唯一闭包。剧本、别名、Authority、媒体 SHA、确认 head 或宫格 scope 漂移会使相关闭包过期；无关宫格变化不会使整集失效。analyze、resolve、confirm-empty、freeze 的业务行、head 与 operation receipt 在同一 SQLite 事务提交，重复请求或崩溃恢复不会重放业务写入。

P6 关账时 compiled MCP 历史快照为 180 tools；该数字不代表当前构建。该能力只冻结“使用了哪个资产版本、SHA、锁、剧本证据和人工裁决”；同脸、犬纹、场景布局和画面质量仍必须由 P7 连续性账本与 Review 明确验收。

## 隔离素材中心的 P7 连续性、Review 与六图停检

P7 generation schema v4 在每个 allowed 资产上冻结九字段连续性：服装、伤势、持物、位置、朝向、情绪、布局、光线和参考 SHA。逐宫格或逐原镜跨度使用半开区间，空档不自动填充；`unresolved`、开放冲突、Authority SHA 漂移或旧 schema 都会阻断冻结或 dispatch。

Codex 先调用 `get_studio_continuity_review_control` 读取目标 unit/panel 的 readiness、冲突、generation、Review、六图 checkpoint 和 Core 唯一下一动作。该工具每次最多接收 6 个资产，所有历史页都有硬上限，不返回 SQLite、CAS object path 或媒体二进制。五条写操作仍只通过 `execute_command`：

1. `append_studio_continuity_observation`：为真实 scope/subject/field 追加有来源的状态。
2. `append_studio_continuity_correction`：按 Head CAS 追加修正并显式解决冲突，不覆盖历史。
3. `submit_studio_generation_review`：绑定实际 pack continuity fingerprint、raw/labeled 结果 ID 与 SHA；MCP reviewer 固定为 `codex`。
4. `refresh_studio_generation_checkpoint`：从当前 Review Head 构建每 6 个唯一生产槽的内容寻址快照。
5. `attest_studio_generation_checkpoint`：提交 `pass` 或 `rework`；MCP reviewer 固定为 `codex`。

上一格 raw 只有在同集真实相邻、当前 pack、raw/labeled 对与 pass Review 都有效时才进入 `continuity-frame`；它与身份参考合计最多 6 项。Review correction 会使旧 checkpoint/attestation 过期，第 7 个新生产槽在真实 `dispatch_studio_generation_pack` 入口被拒且零落账。refresh/attest 的业务 receipt 与命令回放分离，提交后返回前崩溃可恢复而不重放。

P7 关账时 compiled MCP 历史快照为 181 tools；该数字不代表当前构建。它没有暴露上述五条具名写工具，public schema 不包含 operationId、headKey、receiptId 或 request fingerprint。桌面端 reviewer 固定为 `user`，MCP 固定为 `codex`。

## 当前本机连接方式

普通用户不要手写 Node 路径、工程根、sourceDigest 或 release 时间戳：

1. 打开 `/Applications/AI 漫剧画布.app`。
2. 在项目中心切换到所需受管工程；活动注册表随之更新。
3. 打开“Agent 连接”，检查 Codex/Grok CLI、MCP 路径与构建身份。
4. 只有在用户明确点击“备份并修复 Agent 连接”后，App 才备份并修复两端配置。
5. 新开 Codex 或 Grok，说“继续当前 AI 漫剧项目”；Agent 从 `get_active_managed_studio_context` 读取当前工程。

App 写入的启动合同使用 `/usr/bin/env` 和安装版 Electron：

```text
ELECTRON_RUN_AS_NODE=1
/Applications/AI 漫剧画布.app/Contents/MacOS/AI 漫剧画布
/Applications/AI 漫剧画布.app/Contents/Resources/app.asar.unpacked/dist-mcp/mcp/server.js
```

实际配置还绑定包内 `release-manifest.json`、共享活动工程注册表、当前 `sourceDigest` 与构建时间；这些值由 App 从签名安装包动态生成，禁止复制旧文档常量。配置中不应再出现 `AI_CANVAS_PROJECT_ROOT`，因此切换工程无需重配客户端。开发态仍可从工作区构建 MCP 做研发烟测，但不能替代安装版 Agent 连接验收。
