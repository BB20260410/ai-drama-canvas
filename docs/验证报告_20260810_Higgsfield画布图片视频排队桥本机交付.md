# Higgsfield 画布图片/视频排队桥本机交付报告

时间：2026-08-10 07:55 CST  
范围：无限画布图片/视频请求、Codex 宿主队列桥、Unlimited-only 门禁、最终 candidate、隐藏隔离 App、本机安装  
结论：**本机排队桥已交付；真实免费生成仍被 Higgsfield 供应方能力阻塞**

## 1. 用户现在能得到什么

- 在受管画布的正式图片 generation run 上，可点击“用 Higgsfield 排队”。
- 在具备 unit-grid/video package 的受管工程中，可点击“加入 Higgsfield 视频队列”；供应方阻塞后可重新排队，重新取得新鲜预检。
- 请求写入既有 `studio-generation-ledger.sqlite`，不会新建平行数据库或第二套媒体库。
- 其他有 Higgsfield 连接器权限的 Codex 窗口可按项目 Skill 固定顺序读取队列、领取一个请求、执行真实免费预检、取得一次性调用单并回写 jobId/不确定态。
- 图片和视频都固定为 Unlimited-only；不能证明零扣费、出现参数调整或远端响应不明时，系统会阻断，绝不回退到积分队列。

## 2. 连接方式与安全边界

`app://asdk_app_6a3293e129088191abf0875820e839da` 是 Codex 宿主的连接器授权入口，不是 Electron 可直接请求的 HTTP API。因此本次实现的是：

`无限画布请求 → 本地 generation ledger → Codex 领取 → Higgsfield connector → 本地提交回执`

外部写命令只允许 Codex actor；授权时重新核对活动工程、工程 token、写租约、请求 revision 和五分钟 TTL。一次性 claim token、submission nonce、含本机路径的 connector request 不进入通用命令账本或普通只读投影。提交可能已经送达却没有 jobId 时进入 `submission_unknown`，禁止自动再生成。

图片继续绑定既有 `provider=codex` 的正式 pack/run/result owner；视频继续复用既有视频包/source closure 和 generation ledger。没有改写正式项目、正式素材、CAS 或 Review。

## 3. 固定生成参数

图片第一版固定：`gpt_image_2 / 1k / low / count 1 / use_unlim=true`，画幅从正式冻结包限制在 `9:16` 或 `16:9`。

视频固定：`seedance_2_5 / References(omni_reference) / 16:9 / 720p / 20s / audio on / count 1 / use_unlim=true`。画布 15 秒叙事单元不被偷偷放宽；未来完整 20 秒结果进入 CAS 后，只能显式把 0–15 秒绑定到既有时间线。

## 4. 为什么现在仍不能真实生成

同一天的真实 Higgsfield connector 只读复核已确认账户是 Ultra，但 `unlim_available=false`；Seedance 2.5 的精确 `use_unlim:true` 预检返回 `INVALID_ARGUMENT`。图片候选也没有返回可验证的零费用 Unlimited 回执。

所以本轮生成、上传和积分消耗均为 0。会员网页截图不能替代当前 connector 对这一笔请求的免费证明；也不能用普通积分调用“试一下”，因为那会违反用户“必须免费”的要求。

## 5. 验证结果

- 影响范围测试：8 files / 48 tests PASS。
- `npm run typecheck`、`npm run typecheck:app`、`git diff --check`：PASS。
- 最终 candidate：`mcp-candidate-bf4dbb751f21ab05-c53573f495670007-1caabe28`。
- 身份：sourceDigest `bf4dbb751f21ab05e76bc43a6f85288844d2f8a6e3cc2ddd3e671b585357cfd7`；buildId `019ba25fbcea817acb3c7984234fe0c6`；MCP 220 tools。
- `mcp:current:check`：PASS，8 个 publication 全部有效、invalid=0。
- stable launcher 真实 stdio initialize/tools/list：PASS；`get_studio_connector_work_queue` 已出现在实际工具清单。
- 唯一一次隐藏隔离 App smoke：PASS。4 次自然退出；8 份后台快照 show/focus=0，Dock hidden；无 TERM/KILL、无残留进程。
- 安装版独立验收：Developer ID deep/strict PASS，arm64，220 tools，show/focus=0，53ms 自然退出。

## 6. 本机安装与回滚

- 当前安装版：`/Applications/AI 漫剧画布.app`。
- 主可执行 SHA-256：`13f5c26d8a3ed389a2a4ad03ff5236fbe60a68a6b46b1522128f3f1cdd296fc3`。
- `app.asar` SHA-256：`92b27f97f619894581f8266f56104069e08adb707f2d846b68ec51f24d8c17e9`。
- 旧版回滚副本：`/Users/hxx/Documents/无限画布_交付归档/local-install-20260810-075412-bf4dbb75/previous-installed/AI 漫剧画布.app`。
- 按用户要求仅此 Mac 本地使用；Developer ID 已签名，未做 Apple 公证、上传、发布或自动更新。

## 7. 尚未完成

- 没有真实免费图片或视频 job，因此还没有真实 30 分钟轮询、下载、SHA/MIME/ffprobe/完整解码、CAS 导入、时间线绑定或 Review 回写。
- 当前桥只到“请求、领取、免费预检、一次性授权、提交回执”。供应方真正开放可验证的 Unlimited 后，下一独立切片才补 poll/download/CAS/Review，并只做一次隔离 canary。
- Core 对免费观测采用本机 Codex 宿主信任，不是 Higgsfield 的密码学签名；因此其他窗口必须真实调用连接器，不能自己构造 `zeroCredits=true`。
- 本轮没有重跑 fast/medium/integration/heavy 全量分区，也没有 Git stage、commit、push、PR、reset 或 clean。

## 8. 决定性证据

- 总证据：`docs/evidence/higgsfield-canvas-connector-queue-20260810-bf4dbb75.json`
- 隐藏隔离 smoke：`docs/evidence/isolated-package-smoke-20260809T234949877Z-36303-42a2d294.json`
- 安装版验收：`docs/evidence/installed-local-verify-20260809T235436Z-bf4dbb75.json`
- 供应方复核：`docs/evidence/higgsfield-unlimited-membership-programmatic-recheck-20260810.json`
- Codex 消费顺序：`.agents/skills/managed-studio-agent-loop/SKILL.md`
