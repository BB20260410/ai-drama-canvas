# AI 漫剧无限画布 · 长期事实写路径 Revision CAS 闭环验证报告

验证日期：2026-07-14（Asia/Shanghai）  
验证范围：当前工作区 Core、Command Bus、source/compiled MCP、IPC/Renderer 与两个独立 Electron 进程；不读取正式创作项目，不生成或覆盖安装包

## 1. 优先级核验与结论

恢复当前文件系统后，`docs/当前开发交接.md` 指定的 P0 仍成立：production workflow、Creative Bible、AssetRelation、VoiceIdentity、ProjectContext 的既有事实更新没有统一强制 revision CAS；Context delete 没有 revision，未知 Context id 还能退化为创建。这会让旧窗口静默覆盖导演规则、连续性、资产血缘、音色身份和生产阶段证据。

本轮没有重复建设已验证的 Review 内容身份、关键帧、嵌套、Effect/Transition 或隔离 package 框架。当前 P0 已完成 Core → 命令账本 → MCP → IPC/Renderer → 双 Electron → 全量回归的完整纵向切片。

## 2. 统一写入合同

- create 不携带 `id` 或 `expectedRevision`；create 携带 revision 明确拒绝为 `invalid_create_revision`。
- existing update 必须携带非空 `id` 和匹配的 `expectedRevision`；缺失、非法、过期 revision 分别拒绝为 `revision_required`、`invalid_revision`、`revision_conflict`。
- 指定未知既有 id 拒绝为 `not_found`，不得静默创建；空 id 拒绝为 `invalid_id`。
- Context delete 改为 `{ contextId, expectedRevision }`，同样要求实体存在且 revision 匹配。
- 确定性拒绝统一抛出 `RejectedCommandFailure`，结果包含 `schemaVersion=1`、`applied=false`、reason、entityType、entityId/expectedRevision/currentRevision。
- Relation/Voice 在读取项目索引前完成 CAS；stale loser 不得因为失败请求触发隐式扫描。
- Bible、Voice 与 Context 的 UI 局部更新不得擦除调用方没有提交的隐藏 arrays/tags。

## 3. 红灯证据

先补测试后实现时，3 个测试文件、20 项测试得到 15 passed / 5 failed，失败准确暴露：

1. Workflow 既有更新缺 revision 仍可写；
2. Relation create 携带 revision 仍被接受；
3. Context create 携带 revision 仍被接受；
4. Relation/Voice 的确定性拒绝仍会读取项目索引；
5. Context delete 没有 revisioned input。

实现后同一组 Core 测试 20/20 通过；最终定向证据扩展到 Command Bus、跨进程竞争与 MCP，共 34/34 通过。

## 4. Core、Command Bus 与 UI 实现

- `src/core/command-outcome.ts` 提供统一长期事实拒绝原因和 `assertRevisionedUpsert` / `assertExistingRevision`。
- Workflow、Bible、Relation、Voice、Context update/delete 全部在项目级跨进程锁内读取当前事实并做 CAS，再执行任何依赖读取和原子写入。
- `src/core/types.ts` 用 `RevisionedUpsertInput<T>` 区分 create/update，并为五类事实和 Context delete 建立强类型输入。
- `src/core/command-bus.ts`、main IPC、preload bridge 与 Renderer 使用同一强类型合同；Context delete 成功返回窄化 `{ deleted }`，避免成功副作用因 undefined 结果摘要被误记为 unknown。
- ProductionDesign 明确区分 Bible/Relation/Voice create/update，Relation 增加可选择修订 UI；Continuation 明确区分 Context create/update/delete。
- Command Bus 对六条长期事实缺 revision 写路径全部记录 `failed`，`command.failed committed:false`，不进入 unknown，事实侧车不变化。
- 两个独立 Node 进程用不同幂等键和同一 Context revision 竞争，恰好一个成功、一个 `revision_conflict`，最终 revision 只增加 1。

## 5. source / compiled MCP

永久证据：`docs/evidence/revision-cas-mcp-20260714-2157.json`

- source 与 compiled stdio 各自从隔离项目启动，均发现 134 tools。
- `update_production_workflow_stage`、`upsert_creative_bible`、`upsert_asset_relation`、`upsert_voice_identity`、`upsert_context`、`delete_context`、`execute_command` 的公开 input schema 都真实包含 revision 合同；未再退化为空 object schema。
- schema 层拒绝 update 缺 revision、create 带 revision、Workflow 缺 revision及 `execute_command` 缺 revision。
- 实际调用覆盖 current/stale/unknown/create/delete 及 Workflow/Bible/Relation/Voice 冲突；两模式 failed ledger reasons 均为确定的 conflict/not_found，`unknownLedgerCount=0`。

## 6. 两个独立 Electron 客户端

权威证据：

- JSON：`docs/evidence/revision-cas-electron-ui-20260714-1418.json`
- PNG：`docs/evidence/revision-cas-electron-ui-20260714-1418.png`

两个 Electron 进程使用不同 `--user-data-dir`，但共享同一隔离 project root 与 registry。A、B 在 winner 写入前都先载入 revision 1/0 的旧快照，随后真实完成六组竞争：

| 实体/动作 | A | B | 结果 |
| --- | --- | --- | --- |
| Context update | revision 1 → 2 | revision 1 stale update | B 显示冲突，loser 未落盘 |
| Context delete | revision 1 → 2 update | revision 1 stale delete | `canvas:delete-context` 明确拒绝，实体保留 |
| Workflow | revision 0 → 1 | revision 0 stale update | B 显示冲突 |
| Bible | revision 1 → 2 | revision 1 stale update | B 显示冲突，隐藏 tags 保留 |
| Relation | revision 1 → 2 | revision 1 stale update | B 显示冲突 |
| Voice | revision 1 → 2 | revision 1 stale update | B 显示冲突，隐藏 tags 保留 |

最终侧车不含任何 `_LOSER` 值，每个实体只推进一次 revision；A/B pageerror 均为 0。截图为 1560×980、180,207 bytes、SHA-256 `c057ff18c062122bc9423a21732e169e1167f2fae69b4414ffabc1241a61339e`，人工目视确认 Production Design 资产/音色表单、B 的 stale draft 和底部“当前修订 2”错误 toast 均清晰可见，不是黑屏或占位图。

## 7. 最终门禁

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | passed |
| `npm run build` | Electron main/preload/renderer + compiled MCP passed |
| CAS 定向 Vitest JSON | 5 files / 34 tests passed |
| source/compiled MCP CAS smoke | 2 modes / 134 tools each / passed |
| 双 Electron CAS smoke | 6 stale conflicts / 0 pageerror / passed |
| `npm test` | 39 files / 241 tests passed |

定向测试 JSON：`docs/evidence/revision-cas-tests-20260714-2220.json`。全量运行只有 Node SQLite experimental warning，没有失败。

## 8. 证据身份

| 文件 | bytes | SHA-256 |
| --- | ---: | --- |
| MCP CAS JSON | 19,254 | `c33a22fa1fbba6342750e1c362a29e53d6da908f383039651a3e4f359a2e2ce4` |
| CAS 定向测试 JSON | 12,831 | `d6f02ba44682bad8ff57bfcfe60072c30ab56a072b591fcfbb18e85a56970c5e` |
| Electron CAS JSON | 7,326 | `20d98f56dc29bd793ec089f79b7d8dc3f46258fbd9a5e895865a765dc274959e` |
| Electron CAS PNG | 180,207 | `c057ff18c062122bc9423a21732e169e1167f2fae69b4414ffabc1241a61339e` |

## 9. 权限边界

- 只修改当前工作区源码、测试、脚本、文档和 evidence。
- 没有扫描、导入或修改正式 AI 漫剧项目，没有访问生成网站、上传、付费、安装、发布、公证或 Git 外部写入。
- 没有重新运行 package 构建，也没有生成、覆盖或重签 DMG；旧 DMG 仍为 136,652,595 bytes、SHA-256 `ee7c78f16104b3881650353052669fa60c8fd4deb196cc5f49a2f1c765a20972`。
- 本报告验证的是当前源码 build 的 source Electron 与 source/compiled MCP；不能冒充 packaged Electron 的专项行为证据。

## 10. 后续唯一优先级

CAS 切片已完成，长期 goal 仍保持 active。后续唯一安全本地优先级将在当前源码与永久 evidence 的独立复核完成后写入 `docs/当前开发交接.md`；需要正式项目路径、可写边界或发布授权的动作继续等待用户明确授权。
