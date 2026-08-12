# Higgsfield Seedance 2.5 Unlimited 接入与供应方阻塞验证报告

时间：2026-08-10 06:48 CST  
范围：上一任务收尾、本地软件桥、Higgsfield 只读能力实测、最终 candidate、隐藏隔离 App、本机安装版  
结论：**软件桥与本机交付 PASS；真实 Unlimited 视频生成被供应方能力阻塞**

## 1. 直接结论

- 上一轮代码审查、修复、candidate、隐藏 smoke 和本机安装没有遗留收尾项；本轮开始前已复核通过。
- 本地软件已增加 Higgsfield Seedance 2.5 视频生成的安全桥：能够从既有视频包/source closure 冻结 References、提示词与固定参数，先落 `submit_intent`，再由 Codex Agent 调用 Higgsfield connector，并把远端 jobId 或 `submission_unknown` 回写同一 generation ledger。
- 当前不能生成用户截图所示的免费 Unlimited 视频。真实 connector 返回 `unlim_available=false`，Seedance 2.5 没有 `supports_unlim=true`；精确 `use_unlim:true` 成本预检返回 `INVALID_ARGUMENT: Unlimited generations aren't supported for seedance_2_5.`。
- 因双门失败，本轮没有上传参考图、没有创建视频任务、没有扣 credits，也没有用普通 130 credits 队列、网页自动化或私有 API 绕过。
- 新版本已按用户要求仅安装在这台 Mac，本机 Developer ID 签名有效，未公证、未发布。

## 2. 关键实现

- 固定 profile：`seedance_2_5 / omni_reference / 20s / 720p / audio on / count 1 / unlimited_only / concurrency 1`。
- 15 秒叙事单元与 20 秒输出分开建模；15–20 秒只允许保持末态，不静默改写全局 15 秒单元合同。
- 复用既有 `.aicanvas/studio-generation-ledger.sqlite`、视频包、source closure 和媒体 owner；没有新建平行数据库或第二套 CAS。
- 新增三条 Codex-only 写命令：capability attestation、prepare、record submission；三者都要求 Studio 写租约，prepare 还要求活动工程 token 与 activation fence。
- 只有首次 prepare 调用栈能得到 `callAllowed=true` 与受控参考路径；持久命令账本删除整个 `connectorRequest` 并撤销一次性许可，重放不能再次提交。
- 远端无 jobId 或提供方改写参数时进入 `submission_unknown`，禁止自动重提。
- URL、Authorization、password、credential、signature、token/cookie/secret/key/email 等内容在写 SQLite 前脱敏。
- Renderer 只显示真实 capability/run/blocker，不提供可绕过 Codex actor 的提交按钮；Unavailable 时禁止回退付费队列。

## 3. 与截图和网页 Unlimited 的差异

截图证明网页 UI 当时显示 Seedance 2.5、References、720p、20s、Audio On 和 Unlimited 开关，但不能证明 connector/API 对同一模型公开 Unlimited。

本轮使用用户点名的 Higgsfield connector 做了只读实测：普通 20s/720p 请求成本为 130 credits；显式 `use_unlim:true` 被业务层拒绝。Higgsfield 官方 CLI 的公开问题也记录了网页 Unlimited 与 CLI 队列能力不一致：[Higgsfield CLI issue #16](https://github.com/higgsfield-ai/cli/issues/16)。因此不能把网页按钮自动化当成稳定正式接口。

## 4. 审查与定向验证

- 独立终审先发现路径投影、malformed prompt 孤立 intent、actor provenance、freshness、敏感回执和 write lease 等问题；修复后最终结论为 CLEAN。
- 定向测试：4 files / 21 tests PASS。
- `npm run typecheck`：PASS。
- `npm run typecheck:app`：PASS。
- `git diff --check`：PASS。
- 按用户限定没有重新运行 fast/medium 全量分区；结论仅覆盖本切片影响范围、candidate 与打包/安装 smoke。

## 5. Candidate 与 App 验收

- candidate：`mcp-candidate-f893b386dca3c97b-7e28b6fd352a08ea-87156694`。
- sourceDigest：`f893b386dca3c97bb11aa856f53685e0395894c6cff52c3af67745880c47b6ec`。
- buildId：`249252297e368251f29b75b3c23177cf`。
- MCP：219 tools；current `ok=true`，检查 7 个 publication，invalid=0；真实 SDK initialize/tools/list PASS。
- 唯一一次隐藏隔离 App smoke：PASS。4 次自然 exit 0；8 份快照 show/focus=0、Dock hidden；无 TERM/KILL、无残留进程。
- 当前安装版：`/Applications/AI 漫剧画布.app`，arm64，Developer ID deep/strict PASS。
- 安装版后台独立验证：同一 sourceDigest/buildId、219 tools、show/focus=0、Dock hidden、48ms 自然退出。
- 主可执行 SHA-256：`e5c02be0af0d115d83020a3a8eac9e74b472de7c29488509e2376282e9ef5de2`。
- `app.asar` SHA-256：`1e24bf6d2f30f0368578b4a2ce35bd62deeefb2f56ba69720d9738351cad7fe9`。
- 旧安装版回滚副本：`/Users/hxx/Documents/无限画布_交付归档/local-install-20260810-064700-f893b386/previous-installed/AI 漫剧画布.app`。

## 6. 决定性证据

- 本报告结构化证据：`docs/evidence/higgsfield-seedance25-unlimited-integration-20260810-f893b386.json`。
- 隐藏隔离 smoke：`docs/evidence/isolated-package-smoke-20260809T224151641Z-77651-3d018683.json`。
- 安装版验收：`docs/evidence/installed-local-verify-20260809T224800Z-f893b386.json`。
- 实施计划：`.planning/2026-08-10-higgsfield-seedance25-unlimited-integration/task_plan.md`。

## 7. 尚未完成的外部闭环

- 没有真实 Unlimited job，因此没有 30 分钟轮询、20 秒/720p 解码验收、下载、CAS 导入或时间线绑定。
- 当前切片只实现到安全 prepare/submit receipt；远端 job 状态轮询、下载校验、CAS/Publication 与时间线 commit 仍未实现，不能把“软件桥已装好”写成“视频生成全链已打通”。
- 继续条件不是重复测试或改用付费队列，而是 connector 同时明确返回账户 `unlim_available=true` 和模型 `supports_unlim=true`。条件满足后，再用隔离工程补 poll/download/commit，并且只提交一次 canary。

## 8. 边界

- 没有修改正式项目、正式素材、CAS、Review 或生产账本。
- 没有上传、付费、生成视频、浏览器登录自动化、私有 API、Apple 公证、公开发布或自动更新。
- 没有 Git stage、commit、push、PR、reset 或 clean。
- App 验收后已关闭，不占用前台或数据库。
