# Seedance 选择性吸收与 Studio 桥接验证证据（2026-07-23）

## 结论

状态：`PARTIAL / OFFLINE_CONTRACT_ACCEPTED`。

已完成 Seedance 连续视频提示词的离线受管合同，以及 Grok/Codex Review 结果向静态视频包的真实 provider 血缘。未接入真实 Seedance 后端，未调用视频模型，不能声明视频生产闭环完成。

## 源码身份

- 工作树 sourceDigest：`2f35d839cd21f7d4e3a6337eaff6e9269485c43405e9229c28c3572b0182199f`
- source files / bytes：`561 / 12,802,766`
- 以动态工具数 189 计算的 buildId：`5c02dd04f0c28e26d992a6210aa8bb4e`
- release manifest：`de1ecd2f073fcd4fe6be40fe2cc5568e635e3e5179523b2c2938166483ede8a0` / 558 files / buildId `0b8dffb6eb755212141731b08afc5e59`
- 判定：`build currentness=false`；未运行 build:mcp/build:identity，未改写 release manifest。

## 变更范围

- `src/core/studio-seedance-prompt-compiler.ts`
- `src/core/studio-video-package.ts`
- `tests/studio-seedance-prompt-compiler.test.ts`
- `tests/studio-video-package-provider.test.ts`
- `docs/community-research/Seedance2双仓选择性吸收与Studio映射_20260723.md`
- `docs/community-research/INDEX.md`
- `.agents/.grok/.claude` 三份 `ai-drama-production-prompts/SKILL.md`

没有安装或复制第三方仓库，没有增加依赖，没有建立新数据库、Review 或 ledger owner。

## 实跑验证

| 命令 | 结果 |
|---|---|
| `npx vitest run tests/studio-seedance-prompt-compiler.test.ts tests/studio-video-package-provider.test.ts` | PASS；2 files / 7 tests；119.91s |
| `npx tsc --noEmit -p tsconfig.node.json` | PASS |
| 编译器 + 测试的隔离 `tsc --noEmit` | PASS |
| `npm run typecheck` | FAIL；仅见 `src/renderer/src/components/ManagedStudioCanvasView.vue:935` 的 `reviewDecision: string` 不满足 timeline union；属并发 L31 切片，本轮未扩大修复 |

`studio-video-package-provider.test.ts` 使用临时受管工程、确定性 fixture PNG 和 `provider=grok`，验证 dispatch → pre-call → raw/labeled 原子写回 → Review → managed-evidence 静态视频包。它不调用 Grok、Codex 或 Seedance 模型，不代表视觉验收。

## 并发写者事故与防重

- 检测到 Grok PID 7288 在本工作区派生 PGID 45163，其中包含 `codex exec --enable image_generation`、源码 MCP 和 code host。
- 仅对该精确项目进程组执行 `SIGTERM`；随后终止其精确父 Grok PID 7288。无关 Grok/安装版 MCP 未终止，复核未持有本工作区项目/源码句柄。
- 当前调用：
  - pack：`studio-generation-freeze-093616079dd0778f247b32ecfdb286a1`
  - run：`codex-ug-run-mrwecb5s`
  - call：`studio-imagegen-call-22d2e50d4918b3559fc22f74b7d2501b6509af6c`
  - provider：`codex`
  - pre-call：`callAllowed=true`
- 当前 call 的授权 quarantine 为空：`candidate.png` 与 `execution-receipt.json` 均不存在；日志未出现图像工具调用。
- `codex-image-exec-summary.json` 曾给出 `candidateOk=true`，但 console 明确显示它扫描到旧的 `prop-qingdeng-lantern-authority.png`，随后本 call quarantine 仍为空。该摘要不能作为候选或回执。
- 由于没有 Core 认可的 remote-not-created 结构化证明，状态保守保持 `generation_unknown`；禁止 retry、fail、cancel、复制旧图、Review 或 commit。

## 数据保护与非声明

- 《嘟嘟》generation ledger：SHA-256 `0998c00f8bc84583f207ae3e434a7171d1597ed177cc21c595082f665bfc54af`，10,190,848 B，mtime `2026-07-22T18:38:09+08:00`；未改 U28/U29。
- 真实 Seedance、真实视频、真实新 Grok/Codex canary、用户人工视觉验收：`NOT_RUN`。
- Electron smoke、全量测试、性能、build、App 安装：`NOT_RUN`。
- Git stage/commit/push/PR、上传、付费、发布、公证、部署：`NOT_RUN`。

## 唯一下一步

`RECONCILE_ISOLATED_CODEX_CALL_22D2_UNKNOWN_ONLY`

只接受该 call 的可信迟到候选+回执，或可被 Core 验证的 remote-not-created 结构化证明。未关闭前不得对同一目标发起新调用。
