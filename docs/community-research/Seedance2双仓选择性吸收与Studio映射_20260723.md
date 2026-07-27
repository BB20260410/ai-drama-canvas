# Seedance 2.0 双仓选择性吸收与 Studio 映射（2026-07-23）

## 结论

两个仓库都有参考价值，但都不应整仓安装进「AI 漫剧无限画布」：

- [Emily2040/seedance-2.0](https://github.com/Emily2040/seedance-2.0) 的高价值部分是**连续视频的状态合同、引用职责和提示词编译纪律**。本项目采用 clean-room 映射，继续由既有 Studio/CAS/Authority/BindingSet/Review/ledger 掌握真相。
- [dexhunter/seedance2-skill](https://github.com/dexhunter/seedance2-skill) 主要提供紧凑的 `@Image` / `@Video` 文案示例，适合校对最终自然语言，不足以承担身份、状态、防重、Review 或持久化。
- 两者都不是视频模型后端、正式 API 适配器或可靠任务队列，不能据此宣称 Seedance 已接通或真实视频已生成。

本轮不安装第三方 Skill、不复制上游源码、不增加 npm/Python 依赖、不调用真实视频模型。

## 来源身份与许可证

| 仓库 | 本轮只读 pin | 许可证 | 处理 |
|---|---|---|---|
| Emily2040/seedance-2.0 | `57d01dc66f93ecb03c2475be5f22dc416d9b701d` | MIT | 只吸收合同思想，clean-room 实现 |
| dexhunter/seedance2-skill | `e06c7c63a766d623004a2807881c30685ce517af` | MIT | 仅作文案示例，不安装 |

上游 Emily 仓库自身 6 项单元测试在隔离临时克隆中通过；这只能证明上游样例可读，**不等于本软件验证通过**。其 `eval_run.py --run` 会进入外部 API 路径，不能按“离线 Skill”字样整包执行。

## 选择性吸收矩阵

| 上游概念 | 本项目既有 owner | 本轮映射 |
|---|---|---|
| canonical reference 与 transient source 分离 | CanonicalAsset Authority、BindingSet、Review | `referenceRegistry` 明确 `canonical-*` 与 `accepted-*` 职责 |
| exact reference tag | 冻结包引用顺序、媒体 SHA | `exactTag` 逐字保留；标签、媒体类型、职责不一致即拒绝 |
| accepted footage 决定真实开场 | Review、raw/labeled、trace | 续作必须有 Review 身份、媒体 SHA 与 `observedEndState` |
| source carries state, text carries delta | 九字段连续性、镜头/声音规格 | 来源携带开场瞬态；文本只写动作、摄影机、光线和声音变化 |
| completed/current/reserved 事件防火墙 | 剧本 revision、15 秒单元 | 三组 beat ID 必须互斥；当前 prompt 只执行 current，另外两组只作排除 |
| extension depth / scheduled re-anchor | trace、checkpoint、Authority | 场景续作深度 0—3；超过上限显式停用旧输出并回到 Authority |
| accepted result 再续作 | Review head | 未通过 Review 或缺回执/observed state 时失败关闭 |
| provider provenance | generation dispatch/result/call | 视频包从真实 Grok/Codex result 派生 provider，不再写死 Codex |

## 本轮产品落点

### 1. 纯提示词编译器

`src/core/studio-seedance-prompt-compiler.ts` 是无 I/O 的 provider/surface 编译层：

- 输入只接受调用方从既有 owner 取出的 Authority、Review、SHA、九字段状态和事件范围；
- 不读取路径、不扫描素材、不写数据库、不决定 Core nextAction；
- 不静默丢引用：计划重锚时，被停用的旧输出标签单独进入 `inactiveReferenceTags`；
- 只产出当前 clip 的自然语言 `prompt`、`negativePrompt`、引用注册表、lineage 和内容指纹；
- 合同被改写后由 `assertStudioSeedancePromptContract` 按 fingerprint 失败关闭。

### 2. Grok/Codex 静态视频包共链

`src/core/studio-video-package.ts` 的 Review authority 现在要求：

- raw/labeled provider 一致；
- pre-call/result provider 一致；
- 派生视频规格写入真实 `grok|codex` provider；
- provider 由不可变 result/call 闭包和 source-spec SHA 绑定；旧 intent/input fingerprint 算法保持不变，避免破坏历史幂等重放，也不为旧 schema 伪造第二字段。

历史 no-generation 导入继续保持 `provider=null`，不会伪造模型调用。

## 明确没有做

- 未把编译器接到真实 Seedance API、网页或第三方路由；
- 未上传图片、视频或提示词；
- 未调用真实视频模型，动态模型状态仍必须是 `NOT_RUN/not-run`；
- 未宣称平台支持固定数量的引用、固定时长或固定模型名；这些必须在实际 surface 调用前动态核验；
- 未在当前静态包中伪造逐格裁图 SHA。裁图 SHA 只有 builder 真正生成后才存在，下一步应在受管 builder 后处理阶段以真实 SHA 编译合同，不能用整张宫格 raw SHA 冒充；
- 未把 dexhunter 的短语模板、Emily 的 JSON 状态或任何第三方脚本变成新的数据库/Review/账本。

## 验收口径

- 编译器定向测试：精确标签、Authority 闭合、observed state、事件互斥、深度重锚和 fingerprint 篡改拒绝。
- 视频包定向测试：临时受管工程中以 `provider=grok` 完成 dispatch → pre-call → fixture raw/labeled → Review → 静态视频包，并检查派生规格真实记录 Grok。Fixture 只验证软件合同，不是 Grok 或 Seedance live。
- 全项目 typecheck、真实视频、App 安装分别报告，不用局部测试冒充全部完成。
