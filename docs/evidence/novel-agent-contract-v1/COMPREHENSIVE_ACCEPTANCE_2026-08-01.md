# AI-first 轻量小说合同全面验收

## 验收结论

**PASS（通过）。**

原全面验收的 1 个 P1 和 2 个 P2 已全部解决：live MCP 已切到 207-tool 当前构建；Codex/Grok 新连接统一走防旧版稳定入口；首次启动文案测试与路由 smoke 清理合同已更新。完整 fast 分区现为 210/210 files、1144/1144 tests 全绿。

本轮没有引入数据库、向量库、云服务、第二份正文或额外人类 UI。百万字搜索仍使用现有按章并发一致性路径，新鲜抽验为 90ms。

## 决定性结果

| 验收面 | 结果 | 新鲜证据 |
|---|---|---|
| 防旧版启动 | PASS | 只接受同时匹配 live sourceDigest、文件数、字节数和工具数的 sealed candidate；无匹配时在 MCP handshake 前 exit 1 |
| 当前候选 | PASS | `dc83a3bf…`，935 source files，207 tools，完整 runtime tree 426 files |
| Codex 配置 | PASS | 已指向稳定 launcher；配置 mode 0600 |
| Grok 配置 | PASS | 已指向同一 launcher；真实 doctor：handshake OK、207 tools、healthy=1 |
| 当前 live MCP | PASS | manifest/buildId=`888504be…`，207 tools；packaged Electron runtime 1/1 通过 |
| 定向回归 | PASS | 9 files / 31 tests，31 passed |
| 全仓 fast | PASS | 210 files / 1144 tests，全部通过，236.53s |
| TypeScript | PASS | `npm run typecheck` exit 0 |
| 100 字 AI 闭环 | PASS | MCP/CLI 五类读语义全等；跨接口幂等重放；stale CAS 拒绝 |
| 1M/500 章搜索 | PASS | 热搜索 90ms；500/500；0 external changes；唯一命中 1；来源未变 |

## 防止以后再次运行旧版

稳定入口为 `scripts/launch-current-mcp-candidate.ts`，选择 owner 为 `src/core/current-mcp-runtime.ts`，候选完整性继续复用 `src/core/immutable-mcp-runtime-candidate.ts`。

每次新建 MCP 连接时，入口会：

1. 重新计算当前工作区 sourceDigest、输入文件数/字节数和源码声明工具数。
2. 扫描 `.aicanvas-runtime/mcp-candidates`，逐个核验 receipt、release manifest、入口 SHA、完整 runtime tree fingerprint 和只读权限。
3. 只启动四项 live 身份全部相等的候选；不存在时明确返回 `CURRENT_MCP_CANDIDATE_NOT_FOUND`，不会回退到 `dist-mcp` 或任意旧候选。

源码变化后唯一恢复命令：

```bash
npm run mcp:candidate:build
```

构建器在隔离 stage 完成 `build:mcp + build:identity`，发布前后核对 live 源码和 live dist 未漂移。客户端配置不再写死 candidateId、sourceDigest 或入口 SHA，因此构建出当前候选后无需再次修改 Codex/Grok 配置。

## 当前构建与部署身份

- candidate：`mcp-candidate-dc83a3bfcd946134-b4ada03692a089a0-d7c158e3`
- sourceDigest：`dc83a3bfcd946134b55671f68834f7eda13667b420e41a219072978374ee621c`
- buildId：`888504be50c74ed9e5be526da817d58d`
- MCP tools：207
- builtAt：`2026-08-01T17:57:35.220Z`
- entry SHA-256：`4fc9cd250ffe77e3f2bba29a935e18c459be4fab44db2ec90e970e112b8c21fd`
- runtime tree：426 files / 12,648,384 bytes / `b4ada03692a089a0…`

工作区 `dist-mcp` 与 `release-manifest.json` 已用同文件系统 rename 快速切换到上述身份。旧 202-tool 原件没有删除，完整保存在：

`/Users/hxx/Documents/无限画布/.aicanvas-runtime/mcp-live-backups/2026-08-01T17-57-35Z-dc83a3bf`

Codex/Grok 原配置的 0600 备份位于：

`/Users/hxx/.aicanvas/agent-config-backups/2026-08-01T17-57-35Z-workspace-current-launcher`

## 三个原问题的关账

### P1：live MCP 202/207 差异

**已解决。** live manifest/runtime 已是 207 tools；真实 candidate SDK 会话包含全部 5 个小说工具；Electron packaged runtime 测试通过。旧 PID 8162、51269 和旧 candidate PID 16916 均已准确终止。

### P2：首次启动文案测试过期

**已解决。** 测试改为锁定当前真实语义“新建本地工程 / 可选择小说或短剧”，没有把产品恢复成过期的“新建短剧工程”。三入口和“不猜项目列表第一项”合同仍保留。

### P2：recursive cleanup owner 无法机械证明

**已解决。** 新建夹具只用非递归 `rmdir` 删除准确的空 CAS 叶目录；意外有内容时会失败关闭。没有放宽全局静态规则，也没有新增 audited exception。

## 百万字一致性证据

新鲜 r4 验收重新生成并导入 1,000,000 UTF-16 字符、500 章夹具：

- MCP 热搜索 90ms，扫描 500/500，跳过外部变化 0，唯一锚点命中 1。
- 512 字 context pack 未超预算，excerpt 可按 chapterId + SHA + UTF-16 半开区间逐字反查。
- 来源文件 SHA、字节数和字符数在导入、搜索、上下文读取前后完全一致。
- 100 字场景中 workspace/list/range/search/context 的 MCP/CLI 语义全部相同。
- MCP 首次 CAS 保存可由 CLI 同键重放且不重复写；旧 revision/SHA 保存返回 `COMMAND_REJECTED`。

历史 r2 SHA 在抽验前后保持 `d8d098f4…`，新结果独立保存为 r4，没有覆盖历史证据。

## 运行态边界

两个已经运行多日的 Grok TUI 主会话仍缓存启动时的 direct `dist-mcp` target。它们在 live 207-tool 部署后拉起的新子进程 PID 99034/99037，实际路径内容已是当前 207-tool tree，因此不是旧 202-tool 工件；但要让这两个旧窗口的 argv 也显示稳定 launcher，需要在方便时重开旧 Grok 会话。

本轮没有为此结束用户的 Grok/Codex 主进程。新启动的 Codex 和 Grok 4.5 会话已分别观察到通过稳定 launcher 进入当前 `dc83a3bf…` candidate。

## 证据入口

- `docs/evidence/novel-agent-contract-v1/comprehensive-acceptance-20260801.json`
- `docs/evidence/novel-agent-contract-v1/ai-first-v1-acceptance-r4.json`
- `docs/evidence/novel-mode-lite-v1/agent-contract-full-acceptance-20260801.json`
- `docs/evidence/novel-mode-lite-v1/agent-contract-full-acceptance-20260801.png`
- `docs/novel-mode/AI_AGENT_CONTRACT_V1.md`

## 未执行边界

- 未全跑 90 个 medium、35 个 integration、5 个 heavy 文件；已覆盖完整 fast、小说依赖基线、9 文件运行态定向组、typecheck、真实 MCP/CLI、packaged runtime 和百万字 smoke。
- 未调用远程 Grok/Claude 账号进行验收；Grok doctor 只启动本机 MCP。
- 未执行 Git stage、commit、push、PR、外站上传、发布或付费操作。
- 未修改正式小说来源或用户正式素材。
