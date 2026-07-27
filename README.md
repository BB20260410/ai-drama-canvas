# AI 漫剧无限画布

面向本机 AI 短剧生产的文件驱动工作台。应用扫描真实素材目录，将剧本、硬锁资产、首尾帧、视频和验收状态映射到无限画布，并通过本地 stdio MCP 让 Codex 领取和回写任务。

当前桌面端包含：生产画布、故事图谱、生产设计、分集/原镜头提示词编辑器、15 秒单元清单、原镜头时间线、导演剪辑台、资产库、视频工作台、导演验收、Codex 接续台、可恢复生成队列、任务中心、项目中心和项目设置。文件系统始终是完成状态的事实来源。

当前研发状态（2026-07-19）：**P0–P14 均已按各自 final-validation 关账，禁止无授权重建**。P11–P14 采用用户确认的 `codex-primary-v1` 验收配置：Codex 全新会话、真实单图写回、桌面审片、正式备份恢复、安装版规模门和 30 分钟长稳均已通过；Grok 因用户无额度被移出实时完成门，只保留离线合同兼容，不宣称 live PASS。实时事实与唯一下一步见 [当前开发交接](docs/当前开发交接.md)，完整结果见 [P11–P14 验证报告](docs/验证报告_20260719_P11_P14零说明桌面生产闭环.md)。

正式受管工程是 `projects/codex-ai-drama-studio`，不是空库：当前约 1.1GB，包含 85 项资产、541 个 15 秒单元、3246 个宫格和 1152 项媒体。用户通过 `/Applications/AI 漫剧画布.app` 查看、整理和审片；0.2.0 已用 Developer ID 安装为本机 local-only 版本，未做 Apple 公证、上传或公开发布。App 的“Agent 连接”使用自带 Electron runtime 配置 MCP，不依赖系统 Node，切换工程也不需要重配客户端。

新开 Codex 后只需说“继续当前 AI 漫剧项目”，标准链路固定为：`get_capabilities → get_active_managed_studio_context → readiness / freeze / dispatch(provider=codex) → commit_agent_imagegen_result_bundle → Review`。MCP 工具数量从 `release-manifest.json` 动态读取；已安装 0.2.0（P15）为 183，源码构建自 P19 起为 186，历史文档中的 134/165/180/181 只表示当时快照。合同层仍离线兼容 Grok，但当前正式执行默认且已验收的是 Codex；浏览器、Artlist 和网页自动化不得进入正式供应链。

黄金面具唯一权威图是 `/Users/hxx/Desktop/豆姐参考图.png`，SHA-256 `02e9438ecee038f7d14860da37cb315bf358db4a26fa224e342eee5b592b55a9`；正式资产 `prop-d01-golden-mask` 当前为 revision 9、`approved`。旧 D01 Binding、连续性、冻结包和结果均为 stale 历史，不得提升或覆盖该权威版本。

生产设计把“原文→章节→故事事件→故事骨架→改编策略→分集剧本→导演规划→视觉圣经→角色/场景/道具/音色资产→正式分镜→首尾帧→视频→成片剪辑→导演总验收→发布版本”保存为 15 阶段显式状态机；每阶段都有明确输入、输出、验收条件、失败路径和 Codex 下一动作。同时维护导演、视觉、角色、世界观 Bible，每单元最多 6 镜、累计不超过 15 秒的正式分镜表，以及父子派生/版本/参考资产关系和角色音色硬锁。Codex 可在修改节点、故事事件、硬锁或 Bible 前分析下游任务、生成结果、分镜和剪辑片段影响。

生产阶段不再只相信手工状态。桌面端和 `get_production_workflow` 会实时核验原文/章节文件与 SHA-256、确认事件证据、事实/节拍/改编引用、物化单元、导演与视觉 Bible、权威资产、正式分镜、首尾帧和视频视觉验收、剪辑渲染及发布回执。通过现有写接口标记完成会保存验证指纹；后续领取任务或生成前重新核验，证据漂移会拒绝继续。执行门禁按当前任务节点核验媒体证据，某个单元返工不会无故阻塞其他证据完整的单元；工作流总览仍会显示全项目漂移。旧侧车可继续读取，但会明确标记为“completed 尚未建立验证指纹”。

`doctor_project` 和 `get_project_snapshot` 也使用同一套实时证据审计。Doctor 把已完成阶段的证据漂移作为错误、把旧 completed 缺少核验指纹作为警告；统一快照返回紧凑的阶段计数、阻塞阶段、旧状态、下一阶段和修复调用链。两者不会恢复渲染任务、初始化默认 Skill、创建剪辑侧车或争抢写锁。下游阶段标记 completed 前还会重新核验所有已有指纹的前置阶段，不能只靠旧状态越过漂移证据。

Codex 接续台从真实扫描快照生成下一任务、阻塞项、关联上下文和可复制提示词；若生成回执不明，会清空自动开工候选、显示 R4/clientJobId 并强制先对账。项目记忆保存在 `.aicanvas/context.json`，可关联节点与来源路径，并联合检索真实节点、硬锁、验收和事件。项目 Skill 保存在 `.aicanvas/skills/*.md`，每次编辑前自动备份到 `.aicanvas/history/skills/`；启用 Skill 会自动进入新任务包和接续提示词。接续 Markdown 可落盘到 `.aicanvas/handoffs/`，不依赖旧聊天恢复工作。

任务包使用 schema v2 修订与租约：领取时记录稳定执行者、随机 lease ID、心跳和到期时间；其他 Codex 或桌面窗口不能覆盖活跃租约。领取、续租、释放和结束批次全部强制提交当前 `expectedRevision`，缺失或过期修订不会产生副作用；统一命令总线的同幂等键重试仍直接重放原结果。过期租约可审计接管；`cancel_task` 只接受带 `expectedRevision` 和真实原因的待领取任务或租约已过期任务，活跃租约、验收中和终态任务均拒绝取消。批次结束必须逐项归档成功/失败并重新扫描机械门禁。任务会锁定本批权威素材 ID、SHA-256 和最早验收时间；旧版本的通过记录不能完成新批次。图片或视频批次始终进入 `awaiting_review`，项目配置不能关闭视觉事实门禁。

故事图谱支持导入 TXT、Markdown 和 DOCX 原文；应用提取只读文本快照并按中文章节、Markdown 标题或约 1.2 万字段落稳定拆分。章节快照写入 `.aicanvas/story/chapters/`。事件分为草稿、已确认和弃用，只有已确认事件能进入生产上下文和任务包；事件可连接依赖、引用原文句段、关联角色/场景/道具和具体 15 秒节点。重导入会备份旧索引与原文快照，不静默删除失去章节引用的历史事件。

自动改编工作台在章节快照之上建立“小说事实 → 剧情节拍 → 精简/拆分方案 → 15 秒单元 → 独立镜头”链路。事实保留章节、字符区间、内容哈希和“原文确认/模型推断/不确定”状态；镜头保存景别、机位、焦段、构图、运镜、人物调度、表情、情绪、视线、轴线、屏幕方向、声音、前后连续性、生图/图生视频提示词、来源证据和参考资产。正式分镜检查器可逐镜编辑完整导演合同；局部保存必须携带当前镜头修订，只合并明确修改的字段，不会因旧版客户端只提交对白或提示词而清空其他导演字段。硬校验会阻止超过 15 秒、超过 6 镜、重复 ID/顺序、缺失引用、对白超时和硬锁冲突；修改上游事实或节拍后，旧分镜生产契约会失效，不能继续生成。无限画布可按需显示原文、事实、节拍、两种方案和真实生产单元的叙事关系。

模型分析采用 provider-neutral 任务合同：桌面端或 Codex 先创建只含真实章节路径、修订、SHA-256、约束和输出 Schema 的分析任务，Codex/外部模型再提交结构化事实与节拍提案。提案只进入人工确认轨道，不直接改写事实层；程序逐项核对章节范围、字符区间、原文摘录和事实引用。证据异常提案不能接受，节拍必须等待引用事实先通过；接受/拒绝均保存双重修订和追加审计。当前已接通 Codex、OpenAI-compatible 和本地模型执行器；正文外发、私网访问与密钥环境变量均有显式边界。用户真实付费模型的质量、计费和供应商兼容性仍需在提供端点后校准。

导演验收台提供 A/B 图片或视频版本对照、首尾帧已查看门禁、逐项视觉检查、权威版本选择、通过/返工/待定结论和追加式历史。每条 ReviewRecord 除逻辑 `artifactId` 外，还保存 `rootSlot + relativePath + kind + variant + size + SHA-256` 的不可变内容证据；图片与视频 pass 分别保存在相位证据中。同路径替换媒体后，旧记录仍可显示为历史，但不能证明新内容通过：图片漂移回到待视觉验收，视频漂移回到待视频验收。视频验收与单元完成还要求当前四张权威首尾帧仍有有效 image pass。验收页面提交的是所见快照 SHA，`scanId` 只作来源追踪；提交前后内容变化会失败关闭并自动刷新。导演可以暂停视频或选中图片，在具体内容版本画面上添加问题、保留、疑问或连续性批注；视频同时记录当前时间码，画面落点以 `0..1` 标准化坐标保存。记录保存在 `.aicanvas/reviews.json`。

生产画布支持自由拖拽、导演批注、自定义视觉分组和人工关系线。连续性、参考、依赖、说明关系写入 `.aicanvas/canvas.json`；Codex 可通过 MCP 读取和回写同一语义层，删除批注或关系线不会删除生产节点与素材。

自定义分组保存成员相对坐标，移动分组会带动成员生产节点；成员仍可单独拖动。语义画布支持 `⌘Z` / `⌘⇧Z` 持久化撤销重做，历史写入 `.aicanvas/canvas-history.json`，最多保留 80 步并限制为 8MB。

四阶段项目入库向导会依次确认目录边界、识别结果、分流规则和写入范围。默认“制作目录”模式要求真实识别出生产节点，未知目录不能被误导入为空画布；用户可在规则步骤补充带 `episode/unit/shot` 命名组的正则或 JSON 手工映射。明确选择“小说起步项目”时允许暂时没有生产节点，但预检仍检查主根存在、可读写和全部来源边界，确认页会再次提示只建立空索引与侧车、不会伪造制作进度。预检不创建侧车；最终确认后才建立 `.aicanvas/`，导入失败会回滚新建侧车。重新导入已有项目会保留画布、任务、验收和版本历史。附加来源根会参与真实素材与硬锁扫描，跨根同编号版本会明确告警并按权威规则合并。

图片生成结果落盘后会先验图，再以独立新路径派生 labeled 检查版，不覆盖 raw 或既有版本。

历史兼容说明（非当前正式生图链）：分集剧本编辑器会在 `.aicanvas/history/documents/` 备份旧内容，并用修改时间阻止覆盖外部更新。旧生成队列支持落盘桥接、通用 JSON、ComfyUI API 与网页操作配方，并保留提交意图、白名单、SHA-256、隔离下载和不可覆盖 Publication 等安全合同。这些兼容代码不改变当前生产边界：正式图片只由 Codex/Grok 消费受管 Studio 冻结包并通过 `commit_agent_imagegen_result_bundle` 写回，禁止浏览器、Artlist 或网页自动化成为正式供应商。

生成供应商保存还会拒绝 endpoint、poll/cancel endpoint 或网页 site URL 的敏感 query/fragment，凭据必须改用 `apiKeyEnv` 和请求头。MCP 读取旧工程时会在输出边界再次脱敏这些 URL，并同步清理诊断文本、命令回放与账本中的凭据。远程结果一律先进入每任务的 `.aicanvas/generation-downloads/<job>/`；通过大小上限、魔数、完整解码与 SHA-256 后，才以不可覆盖方式发布到预留新版本路径。

原镜头时间线从真实目录建立“15 秒单元 → 原镜头”父子关系，允许调整镜头顺序与时长；单元最多 6 镜、累计不超过 15 秒。编排写入 `.aicanvas/timeline.json`，不会移动或改名原素材。

导演剪辑台从真实扫描索引建立本地素材库，支持项目/单集成片工程、多画面轨道与画中画、全部视觉轨（主画面与画中画）的位置/缩放/旋转关键帧、画面滤镜、主画面片段追加与排序、时长和源片裁切、播放头分割、跨未锁定轨道的 Ripple 删除、波形与影片条延迟预览、竖屏/横屏画幅、分数帧率、播放头预览、乐观修订保护及 FFmpeg H.264 MP4 导出。关键帧保留线性、渐快、渐慢、平滑、保持五种旧公式，并支持四个 `[0,1]` 控制点的 `cubic_bezier`；目标关键帧控制进入它的区间，Vue 预览与 FFmpeg 都从同一共享数学定义反解 x 后求 y。曲线随工程 JSON、CAS、撤销重做和 `update_clip` 保存；UI 提供四点数值与 SVG 曲线反馈。任意整数帧 split/trim 会用 De Casteljau 插入边界并重参数化入段曲线；派生曲线为只读 `derived_monotone`，以原 easing/整数帧窗口 `sourceWindow` 加原段首尾变换 `sourceTransform` 为语义权威，避免病态曲线和 yuv420 网格放大舍入误差。无派生曲线的 OTIO 写 `aicanvas.cubic-bezier.v1`，含派生曲线时写 v2；导入接受 v1/v2 并对未知、缺失或伪造合同失败关闭，不冒充跨编辑器标准曲线兼容。最低 `order` 的视觉轨固定为主画面，不会因隐藏或静音而把画中画提升为主画面；隐藏/静音主轨失败关闭，静音主画面片段则保留整数帧时长并输出项目背景。主画面 X/Y 是相对项目画布中心的项目像素，正方向为右/下；渲染顺序为等比适配、动态缩放、片段静态 opacity、绕中心旋转、位置合成到固定项目背景。无变换主画面继续走旧兼容路径；预览、同步/后台成片、合成帧和时间线续接消费同一主轨渲染图。

复杂嵌套时间线继续复用同一 `EditProject` / `EditClip` / revision / history 状态机。`add_nested_timeline` 会冻结子工程 ID、修订、时间基、画幅、可见源区间和内容寻址不可变快照；`refresh_nested_timeline` 是唯一显式更新入口，子工程漂移不会被静默读取。父帧到子帧使用约分有理数和整数交叉乘法映射；自身引用、环、深度超过 8、快照缺失或篡改、当前子工程缺失、修订漂移和越界范围都失败关闭。同步/后台成片、合成帧、Continuation、Publication 和 Electron 预览共享同一递归 resolver、依赖 manifest、render plan 与递归素材血缘；业务渲染缓存保留 FFV1+PCM，无损缓存再派生 H.264/AAC MP4 供 Chromium 解码。桌面端可插入、撤销/重做、split/trim/move/ripple、查看冻结身份与显式刷新；父工程存在未保存草稿或外部修订变化时刷新拒绝，避免丢稿。

标准 OTIO Effect/Transition 采用明确的有界 allowlist：active `LinearTimeWarp.1`（`effect_name=LinearTimeWarp`，0.1–8，普通本地视频/音频）和主视觉轨相邻普通视频之间的 active `Transition.1/SMPTE_Dissolve`。导入前会用 FFprobe 验证从媒体起点开始的 `available_range`，并按整数帧核对 pre-roll/post-roll handles、相邻切点、分数时基和不重叠时域；导出/reimport 保留标准对象与 `aicanvas.otio-effect-transition.v1` 身份。同步/后台 FFmpeg、抽帧、Continuation、MCP 和 Electron 双流预览共用该合同；视觉 dissolve 不改变独立音轨时域。generic `Effect.1`、`FreezeFrame`、自定义/disabled Transition、opaque metadata、marker，以及 Dissolve 与 TimeWarp/transform keyframe/fade envelope 的首版组合继续失败关闭。既有 `fade` 仍表示淡到项目背景，不冒充标准 cross dissolve。

时间线片段可直接拖动、左右裁切并吸附播放头、整秒、其他片段边缘和成片边界；主画面拖动会重排并保持连续，锁定轨道拒绝修改。关键帧边缘裁切先显示本地预览，pointercancel 会从非代理快照完整恢复且不推进修订；真实 pointerup 则恢复预览后走现有原子 `trim_to_playhead`。主画面、画中画和音频轨统一同步播放头、裁切、变速、静音、音量和淡入淡出，不再各自循环。所有时间在数据层以整数帧保存；23.976、29.97、59.94 等速率保存为 `24000/1001`、`30000/1001`、`60000/1001` 时间基，FFmpeg 与 OTIO 使用同一时间基。界面播放头步长、拖动、裁切、吸附、关键帧、分割和 Ripple 也按当前有理时间基量化，时间码显示 `时:分:秒+帧` 与绝对帧号，不再先用小数秒编辑再等待保存纠偏。已有工程的保存、原子编辑、撤销、重做、OTIO 导出、合成帧、后台导出和时间线续接都强制校验当前修订；同一工程的读—校验—历史—写入由跨进程工程锁串行化。OTIO 导入会先完整预检再创建工程，按源 `RationalTime.rate` 换算；嵌套只接受 AI Canvas `aicanvas.nested-timeline.v1` 私有合同约束的 `Stack.1` 子集，并把标准 children 与冻结快照 canonical 重建结果交叉校验。除上述 `LinearTimeWarp.1` / `SMPTE_Dissolve` allowlist 外，未知 Stack/Timeline、Effect/Transition、marker 或曲线合同会在创建工程前明确拒绝，不静默丢片或留下空工程。后台渲染在启动 FFmpeg 前先创建 `PublicationIntent` 并预留不可覆盖的新版本路径；只有 ffprobe 和 SHA-256 发布回执都成功才会进入 `succeeded`。后台完成回调、轮询恢复和应用重启并发确认同一回执时按幂等成功合并；失败或取消会关闭预留。时间线末端受分数帧率和源媒体 EOF 舍入影响时，合成帧会在审计中记录实际时间并最多逐帧回退 4 帧，避免“FFmpeg 退出码 0 但没有输出图片”。取消时只终止经命令行核验属于本任务的 PID。导演台进入时会记录最近工程、最近稳定修订、正常关闭标记和未完成渲染 ID；检测到上次异常退出时，界面会阻塞并要求明确选择“恢复最近稳定修订”或“打开最新修订”，不会静默替用户猜测。恢复稳定修订会复用现有历史快照并保存为新的更高修订，不覆盖已有版本。工程写入 `.aicanvas/editor/projects/`，会话状态写入 `.aicanvas/editor/editor-session.json`，导出记录写入 `.aicanvas/editor/renders.json`，帧来源写入 `.aicanvas/editor/provenance.jsonl`；成片和合成帧均生成新文件，不覆盖既有输出。

视频与音频素材验收依赖本机 `ffprobe`，会读取可解码性、真实时长以及视频画面尺寸。旧通用生成兼容层仍保留落盘桥接、Codex 浏览器、HTTP JSON 和 Mock 的可恢复合同，但它们不属于当前正式生图供应链。远程兼容任务会先持久化提交意图与稳定 `client_job_id`；回执不明时必须先对账，不能自动重提。正式受管 Studio 图片仍只允许 `provider=codex|grok`，且不在项目或 App 中保存 API 密钥。

通用 HTTP 任务把远程观测分为 `pending / succeeded / confirmed_failed / retryable_or_unknown`。持久化 `externalTaskId` 或结果地址后，5xx、超时、断连、坏 JSON、完成但缺结果 URL、下载中断和解码失败都保持 `waiting_remote` 与 Publication `reserved`；只有供应商返回结构化失败值才闭合失败。恢复使用 `process_generation_queue(jobId)` 只处理该任务，不会重新 POST 或顺带提交其他 queued 任务。取消只在 HTTP 204，或 HTTP 200 且结构化状态为 `cancelled/canceled` 时才关闭本地任务；否则任务与 Publication 保持可恢复。

`comfyui-local` 是独立的本机图片执行适配器，不再把 `comfyui-api` 工作流格式冒充通用 HTTP。地址只允许 localhost / `127.0.0.1` / `[::1]`；提交前持久化 canonical UUID `promptId`、稳定 `clientId`、attempt、物化工作流哈希和输出节点绑定。POST 前暂态预检失败保留同一 `prepared` 检查点和 Publication，重启仍使用同一 attempt；POST 回执断连后只查询同一 promptId 的 queue/history，绝不重提。history/queue 必须携带官方 prompt 5-tuple，并同时匹配 promptId、物化图哈希、clientId、任务/attempt/工作流/输出标签和 `outputs_to_execute`；成功还必须有同 promptId 的 exact `execution_success`。输出绑定 `promptId + outputNodeId + outputIndex + filename + subfolder + type=output + history SHA-256`，随后才进入每任务隔离下载、完整解码、SHA-256 和不可覆盖 Publication。取消只调用原子 `/api/jobs/{promptId}/cancel`：pending 要求服务端 acted 且连续两次从 queue/history 消失，running 必须等待 exact `execution_interrupted`；未确认、`cancelled:false`、503 或成功竞态均保持锁定/让 registered 胜出。WebSocket 只可增强进度，不能单独证明终态。当前永久验证使用本地协议 loopback；真实本机 ComfyUI 版本与节点兼容性仍需用户授权后校准。

Generation 只信任与 `projectId/jobId/itemId/clientJobId/attempt/externalTaskId/checkpointRevision` 匹配的结构化 Publication 终态来源；ComfyUI 失败/取消还必须匹配 exact history 或原子取消响应哈希。自由文本、旧版或修订不匹配的 `failed/cancelled` Publication 不会解锁同节点重复提交，而会保持任务锁定并要求 `inspect_publication`；并发 `registered` 回执始终优先恢复成功。历史成功 Publication 的复验是幂等的，不会把已经通过导演验收的节点降回“待视频验收”。Doctor、统一快照、Generation Resource、续接包和恢复 Prompt 会区分 Browser、HTTP 与 ComfyUI 检查点，并只暴露脱敏的可执行动作。

所有内置 FFmpeg/ffprobe 现在共用跨项目、跨进程的机器级加权 FIFO 运行时。默认总容量为 4：ffprobe 权重 1、预览/代理/帧提取等前台 FFmpeg 权重 2、成片渲染权重 3；严格 FIFO 防止重任务永久饥饿，渲染仍保留一个探测槽位。子进程以独立进程组运行，支持阶段超时、Abort、SIGTERM→SIGKILL 进程树清理和短尾部日志；死亡宿主遗留的租约会在下一次受控媒体操作或渲染恢复时回收。协调状态位于 `~/.aicanvas/runtime/media-v1`，它可重建且不是项目业务事实源；测试可用 `AI_CANVAS_MEDIA_RUNTIME_DIR` 隔离，容量和超时可分别用 `AI_CANVAS_MEDIA_CAPACITY`、`AI_CANVAS_FFMPEG_TIMEOUT_MS`、`AI_CANVAS_FFPROBE_TIMEOUT_MS` 调整。

Publication 登记采用“短锁快照 → 锁外 Sharp/ffprobe/固定文件句柄 SHA-256 → 短锁 CAS 提交”。CAS 同时核对 intent 修订、令牌、状态、不可变字段、canonical root/parent，以及文件的 dev/ino/mode/nlink/size/mtimeNs/ctimeNs；这些瞬态身份不会写入侧车或经 MCP 暴露。同尺寸同 mtime 的原子替换也会被拒绝并保留 `reserved` 供重试；校验期间的取消或其他终态优先，两个进程并发登记同一 intent 只生成一份回执。宿主在锁外阶段崩溃时不需要回收 `validating` 状态，因为持久状态仍是 `reserved`。已登记回执的重放和剪辑恢复也会复验当前文件哈希，不能只凭 receiptId 宣告成功。稳定机械失败在命令账本中记录为已确认 `failed`，不再伪装成 `unknown`；只有副作用无法确认的异常仍保持 `unknown` 并禁止重放。

项目 Doctor 与统一快照会主动暴露待对账生成任务、网页检查点修订、clientJobId、尝试次数和已有对账结果，并把恢复顺序置于领取新任务之前。

时间线末帧续视频是一个原子闭环：锁定剪辑修订，提取包含画中画、变换、滤镜、转场和字幕的合成末帧，登记为目标 15 秒单元的新首帧，写入源素材血缘，创建续接包并自动绑定唯一视频 GenerationJob。该任务明确标记为 `timeline_continuation`，使用新合成帧作为 `first_frame`；从源视频提取末帧时则建立 `video_continuation`，并通过同一 `enqueue_generation(...continuation)` 接口绑定任务。续接包不再拥有独立的提交/完成状态机，只投影 GenerationJob 的预检、上传、提交意图、提交不明、已提交、下载、验收和终态；已绑定续接包禁止手工写成 submitted/completed。关联任务通过机械验收并取得发布回执后，续接包自动绑定真实输出并进入 `completed`；`submission_unknown` 会保留 clientJobId，重启后必须先对账，不能重复付费提交。未入队包只能带当前修订和真实原因明确取消。Doctor 会报告未入队、投影漂移和引用缺失。生成结果仍必须经过导演视觉验收。

## 开发

```bash
npm install
npm run dev
```

## 扫描真实项目

```bash
npm run scan -- <用户已明确授权并完成导入的项目根>
```

建议首次接入使用桌面端“项目 → 导入项目目录”，或让 Codex 先调用 `preview_project_import`，确认 `previewId`、来源根和忽略规则后再调用 `commit_project_import`。不要用写入式扫描代替首次导入预检。

## MCP

开发态：

```bash
npm run mcp
```

构建后入口：`dist-mcp/mcp/server.js`。MCP 仅通过 stdio 通信，不监听网络端口。

Codex 连接配置见 [docs/CODEX_MCP.md](docs/CODEX_MCP.md)。请在导入真实项目后再写入项目路径。

production workflow、Creative Bible、AssetRelation、VoiceIdentity 与 ProjectContext 属于长期事实。create 不携带 `id/expectedRevision`；既有实体 update 必须携带当前 `id + expectedRevision`，Context delete 必须携带 `contextId + expectedRevision`。缺失、非法或过期 revision、未知 id 和 create 携带 revision 都会在副作用前确定性拒绝；通过 `execute_command` 调用时写入 `failed` 账本而不是 `unknown`。桌面端同样保留各编辑草稿所见 revision，旧窗口保存或删除会显示冲突并要求刷新。

在隔离临时项目验证 Core/Command Bus、source/compiled MCP 和两个独立 Electron 客户端的长期事实 CAS：

```bash
npx vitest run tests/production.test.ts tests/asset-registry.test.ts tests/continuation.test.ts tests/command-bus.test.ts tests/mcp.test.ts
npm run mcp:revision-cas-smoke
npm run ui:revision-cas-smoke
```

最后一个命令会重建当前 Electron 产物，让两个独立 `--user-data-dir` 共享同一临时项目与 registry，并验证 Context stale update/delete、Workflow、Bible、Relation 和 Voice 的真实 UI 冲突；它不读取正式创作目录，也不生成或覆盖 DMG。

真实项目只读链路验证：

```bash
npm run mcp:real-smoke -- /Users/hxx/Desktop/Ai漫剧
```

追加 `--create` 会在 `.aicanvas/tasks/` 创建一个待领取任务包，但不会生成或覆盖媒体文件。

以只读《封神篇》正式剧本和参考板建立全新隔离工程，验证真实长时间线、分数时基、多轨、嵌套、Effect/Transition、OTIO、Publication、Continuation、source/compiled MCP 与 Electron 完整重启：

```bash
npm run formal:nle-calibration -- '/Users/hxx/Desktop/豆包版本/剧本_封神篇' "$PWD/formal-calibration/全新内容寻址目录" "$PWD/docs/evidence/全新-core-evidence.json"
npm run build
npm run formal:nle-mcp-smoke -- "$PWD/formal-calibration/全新内容寻址目录/calibration-state.json" "$PWD/docs/evidence/全新-mcp-evidence.json"
npm run ui:formal-nle-smoke -- "$PWD/formal-calibration/全新内容寻址目录/calibration-state.json" "$PWD/docs/evidence/全新-ui-evidence.json"
```

目标目录必须不存在且位于工作区 `formal-calibration/` 下；脚本不会回写正式源。当前正式源没有原生音视频，校准视频与音轨只在隔离副本中派生并写明 `sourceNativeMedia=false`，不能把它们描述成源目录原生素材。当前权威实跑见 [正式封神篇项目 NLE 校准闭环验证报告](docs/验证报告_正式封神篇项目NLE校准闭环_2026-07-15.md)。

在隔离临时项目上验证“桌面应用关闭、独立 stdio MCP 继续任务→视频落盘→视觉验收→23.976 剪辑→发布回执→时间线续接→Resources/Prompts→Doctor”的闭环：

```bash
npm run mcp:headless-smoke -- /tmp/ai-canvas-mcp-headless /tmp/ai-canvas-mcp-headless-registry.json
```

验证 400 个真实生产单元、400 张有效 PNG 在 Electron 中的筛选、自动布局、缩放、平移到第 400 节点、视口卸载和缩略图解码：

```bash
npm run ui:large-smoke
```

验证 400 单元首次扫描、未变化复用、单文件变化重检和取消不落半份索引：

```bash
npm run scan:incremental-smoke
```

验证真实 24 单元视频扫描与 36 秒后台成片并发，并确认写入中的 PublicationIntent 输出不会进入素材索引：

```bash
npm run scan:render-contention-smoke -- /tmp/ai-canvas-scan-render-contention-20260714 docs/evidence/scan-render-contention.metrics.json 24
```

在隔离临时项目上用真实 FFmpeg/ffprobe 验证 Publication 锁外校验、取消优先、强文件 CAS、双进程单回执和崩溃恢复：

```bash
npm run publication:consistency-smoke -- docs/evidence/publication-consistency-smoke.json
```

验证通用 HTTP 观测分流、单次 POST、真实 SIGKILL partial 恢复、严格取消、不可覆盖发布，以及提交断连后的 `found/not_found` 结构化对账和清理：

```bash
npm run generation:http-resilience-smoke -- docs/evidence/http-generation-reconciliation-smoke-20260714.json
```

验证 ComfyUI 本机专用适配的 official prompt tuple、prepared/fresh-Node 恢复、history 归属、输出身份、原子取消、legacy 端点零调用，以及真实 Electron queued→verified 闭环：

```bash
npm run generation:comfyui-protocol-smoke
npm run ui:comfyui-local-smoke
```

验证自定义关键帧曲线的共享求值、真实 H.264 像素轨迹和当前源码 Electron 编辑闭环：

```bash
npm run editor:bezier-render-smoke
npm run ui:editor-bezier-smoke
```

验证病态自定义曲线在任意 split/trim 后的逐帧渲染等价、OTIO v2、撤销重做、真实边缘手势和可见 UI：

```bash
npm run editor:subdivision-render-smoke
npm run ui:editor-subdivision-smoke
```

验证主画面逐片段 transform、横竖屏 H.264、任意 split、合成帧、OTIO v1/v2 和当前源码 Electron 编辑闭环：

```bash
npm run editor:main-track-render-smoke
npm run ui:editor-main-track-smoke
```

验证三层复杂嵌套的冻结快照、有理帧映射、递归视音频/字幕/叠加、OTIO/MCP、跨进程 Continuation，以及真实 Electron 插入、漂移拒绝、显式刷新与完整应用重启：

```bash
npx vitest run tests/editor-nested.test.ts tests/editor-nested-continuation.test.ts tests/mcp-editor-nested.test.ts --maxWorkers=1
npm run ui:editor-nested-smoke
```

验证标准 OTIO `LinearTimeWarp.1` / `Transition.1/SMPTE_Dissolve` 的失败关闭 allowlist、分数时基真实媒体、同步/后台成片、抽帧/Continuation、source/compiled MCP 和 Electron 双流编辑/重启：

```bash
npx vitest run tests/editor-effect-transition.test.ts tests/mcp-editor-effect-transition.test.ts --maxWorkers=1
npm run editor:effect-transition-render-smoke
npm run ui:editor-effect-transition-smoke
AI_CANVAS_MCP_SERVER_PATH="$PWD/dist-mcp/mcp/server.js" npx vitest run tests/mcp-editor-effect-transition.test.ts --maxWorkers=1
```

验证导演验收的不可变内容身份、图片/视频相位证据、同路径漂移、提交窗口竞态、MCP 当前权威素材优先，以及真实 Electron 旧快照拒绝与重验：

```bash
npx vitest run tests/reviews.test.ts tests/production.test.ts tests/service.test.ts tests/scanner.test.ts tests/mcp.test.ts tests/command-bus.test.ts --maxWorkers=1
npm run ui:review-content-identity-smoke
AI_CANVAS_MCP_SERVER_PATH="$PWD/dist-mcp/mcp/server.js" npx vitest run tests/mcp-headless-workflow.test.ts --maxWorkers=1
```

验证当前源码的隔离安装结构、包内 MCP 与 packaged Electron，不生成或覆盖发布产物：

```bash
npm run package:isolated-smoke
```

该命令只在 `/tmp` 的隔离 stage 中运行构建与 `electron-builder --dir`，生成临时 arm64 unpacked App；逐文件核对 `out ↔ app.asar`、`dist-mcp ↔ app.asar.unpacked`，并实跑包内 MCP、空项目 fresh restart、Effect/Transition Electron 完整重启，以及 ReviewStudio 旧快照拒绝、自动新 SHA、检查项重置、重验通过、完整 App 重启恢复和再次同路径漂移失效。ReviewStudio 使用独立 project/registry/user-data，并生成独立 `*-review-ui.json/png`；guard 会拒绝退回 source Electron、缺失业务断言、page error、错误尺寸或未清理路径。builder、packaged MCP、测试夹具和 packaged Electron 共用同一隔离 `HOME`、`TMPDIR`、项目 registry、媒体运行目录与默认项目根；capability smoke 强制 Resources 精确为 `aicanvas://server/capabilities` 和 `aicanvas://projects`，任何动态项目 URI 都失败。门禁还保护宿主 registry、宿主媒体运行时状态、旧 DMG 以及工作区 `dist/`、`out/`、`dist-mcp/` 的前后身份。它显式关闭 publish、Developer ID 签名和公证，不生成 DMG、不安装 App。滚动命令只写 `isolated-package-smoke-latest*`；正式切片证据应显式传入新的文件名，避免覆盖历史证据。

stdio MCP 的 `scan_project`、`execute_command(command=scan_project)` 与只读预检支持进度通知和提交点前安全取消。取消会终止在途 ffprobe、保留旧索引，并在命令账本写入 `cancelled`；重新扫描必须使用新的 requestId/idempotencyKey。对应回归门禁为 `npx vitest run tests/mcp-scan-cancel.test.ts tests/command-bus.test.ts`。

## macOS 安装包

```bash
npm run package:mac
```

若钥匙串中存在 Developer ID，构建器会自动签名；仅做无签名本机测试时可显式使用 `CSC_IDENTITY_AUTO_DISCOVERY=false npm run package:mac`。DMG 输出在 `dist/`。签名不等于 Apple 公证，对外分发仍需配置 notarization 凭据。

`package:mac` 是真正的 DMG 构建入口，需要单独的覆盖、签名和发布授权；`package:isolated-smoke` 只创建随测试清理的临时 unpacked App，不是发布构建。

2026-07-14 01:08 的既有 DMG 本体没有 codesign，且没有 stapled ticket；DMG 内嵌的 `AI 漫剧画布.app` 使用 `Developer ID Application: YIHANG LI (3JS43BTTJ3)` 签名并通过 deep/strict 校验，但 App 同样没有 stapled ticket。项目记录仍为未公证。该 DMG 是旧源码快照，本轮没有覆盖、重签或重新生成它。其大小和 SHA-256 见 [扫描与发布快照保护验证报告](docs/验证报告_扫描与发布快照保护_2026-07-14.md)。

当前 0.2.0 App 已另行安装到 `/Applications/AI 漫剧画布.app`，使用现有 Developer ID 签名，仅供本机使用；没有 Apple 公证、stapled ticket、公开发布或自动更新。上述 2026-07-14 DMG 与 2026-07-15 的 134-tool 隔离包都只是历史证据；165-tool、P5 恢复点、空库和“未安装”结论同样已经过期。P11–P14 已按 `codex-primary-v1` final-validation 关账；当前源码工具数和构建身份必须从 `release-manifest.json` 动态读取，源码后续阶段是否关账以 `docs/当前开发交接.md` 的最新验证入口为准，不能拿已安装 0.2.0 的历史工具数冒充当前源码状态。

## 数据边界

- 素材文件是事实来源。
- `.aicanvas/index.json` 是扫描快照，SQLite 仅作缓存。
- 重扫仍遍历候选路径，但只对尺寸、mtime、ctime、检查器版本或哈希需求发生变化的文件重新执行 Sharp/ffprobe/流式 SHA-256；扫描并发固定为 6。
- 扫描先完成普通素材和参考资产路径发现，再读取原子发布快照；已处于 `reserved` 的写入中目标只计入发现数，不进入候选、机械验收或素材索引。快照后新预留的目标在本轮路径发现时尚不存在，因此不会插入本轮候选；长扫描不持有发布锁。发布侧车损坏时扫描失败关闭并保留旧索引。
- 桌面手动扫描和文件监听扫描都可取消；提交点前取消不会覆盖上一份完整 JSON/SQLite 快照，也不会写入 `project.scanned`。
- `.aicanvas/canvas.json` 保存自定义画布语义，不改变真实素材完成状态。
- `.aicanvas/canvas-history.json` 只保存画布语义历史，不复制图片或视频。
- `.aicanvas/reviews.json` 保存追加式视觉验收结论、图片/视频相位证据 ID、不可变素材内容证据，以及绑定具体内容版本的时间码/标准化画面坐标批注；缺少内容证据的 legacy 记录只作历史显示。
- `.aicanvas/context.json` 保存项目事实、连续性、决策、问题与交接记忆。
- `.aicanvas/skills/*.md` 保存可编辑的 Codex 执行规则，旧版进入历史目录。
- `.aicanvas/handoffs/*.md` 保存可复制到新任务的接续快照。
- `.aicanvas/story/index.json` 保存原文来源和章节元数据。
- `.aicanvas/story/chapters/` 保存逐章文本证据快照。
- `.aicanvas/story/events.json` 保存事件状态、生产节点关联和事件依赖。
- `.aicanvas/story/adaptation.json` 保存带原文证据的小说事实、剧情节拍、精简/拆分方案、15 秒单元、独立镜头和修订引用。
- `.aicanvas/story/analysis-tasks/` 保存 Codex/外部模型分析任务的 JSON 合同和可读 Markdown 说明；不保存密钥，也不把未确认提案当成事实。
- `.aicanvas/story/analysis-providers.json` 保存小说分析模型的 Base URL、模型名、环境变量名和显式授权开关；密钥值只在运行时从环境变量读取。模型返回的结构化提案落在对应任务目录并继续经过人工确认。
- `.aicanvas/production-workflow.json` 保存内容生产阶段、证据路径、完成验证指纹和门禁状态；实时审计结果按读取时的真实文件生成，不作为第二套事实源持久化。
- `.aicanvas/creative-bibles.json` 保存导演、视觉、角色与世界观规则。
- `.aicanvas/storyboards.json` 保存正式分镜行和 6 镜 / 15 秒约束。
- `.aicanvas/asset-relations.json` 保存素材与生产节点的派生、版本和参考关系。
- `.aicanvas/voice-identities.json` 保存角色音色描述、样本路径、节点和硬锁绑定，不保存 API 密钥。
- `.aicanvas/panel-reference-resolutions.json` 保存 P2 当前逐宫格引用闭包、供应商槽位和输入 currentness。
- `.aicanvas/panel-visual-constraints.json` 保存 P3 逐格结构化视觉约束、模型安全载荷、人工 Review 规则、警告和内容指纹；其中 unresolved 只表示未知已失败关闭，不代表视觉通过。
- `.aicanvas/command-ledger.json` 在副作用前保存 Codex 写命令的 request ID、幂等键、请求哈希和 `running` 状态；成功后写入结果。中断或异常会保留为 `unknown` 并锁定原幂等键，恢复时必须先与真实文件和审计事件对账，不能盲目重放。
- 关键 JSON、Markdown、剧本文档和项目 Skill 使用“临时文件刷盘→原子替换→目录刷盘”；审计事件追加后立即刷盘。损坏 JSON 会停止写入并保留现场，不会被静默当成空状态覆盖。
- 素材同时保存当前绝对路径、稳定 root slot/相对路径和 `aicanvas://projects/.../artifacts/...` URI；整体移动项目主根不会改变素材 ID，权威覆盖优先按 ID 恢复。
- `.aicanvas/locks/` 使用原子文件锁协调桌面应用、开发 MCP 与安装版 MCP 的跨进程写入；持锁进程会心跳，回收前验证 PID 和 token，不能仅凭超时抢走仍活跃的长任务锁。异常退出留下的死亡 PID 锁经过短暂防竞态宽限即可回收，不必等待完整 120 秒失效窗口。
- `.aicanvas/generation-downloads/<job>/` 是网页与 HTTP 远程生成结果的每任务隔离验证区；`result.partial` 不代表完成，只有完整解码和 SHA-256 通过的文件才能不可覆盖地发布。
- `.aicanvas/generation.json` 保存供应商能力和可选工作流定义；凭据只保存环境变量名。`.aicanvas/generation-jobs.json` 为每个新任务保存不可变执行快照与哈希，旧任务不跟随供应商配置漂移。
- `.aicanvas/editor/projects/` 保存本地剪辑工程、轨道与片段时序。
- `.aicanvas/editor/history/` 保存剪辑工程的持久化撤销/重做快照。
- `.aicanvas/editor/editor-session.json` 保存最近工程、最近稳定修订、正常关闭标记和未完成渲染 ID；异常退出后由用户明确选择恢复目标。
- `.aicanvas/editor/otio/` 保存默认 OpenTimelineIO 交换文件。
- `.aicanvas/editor/previews/` 保存按需生成的波形、缩略图与影片条缓存。
- `.aicanvas/editor/proxies/` 保存用于流畅预览的本地 H.264 剪辑代理；正式导出仍使用原素材。
- `.aicanvas/editor/renders.json` 保存成片导出状态、输出路径、命令和短日志路径。
- `.aicanvas/editor/provenance.jsonl` 保存时间线合成帧的工程修订和素材来源链。
- 任何自动化只登记新版本，不删除或静默覆盖权威素材。
