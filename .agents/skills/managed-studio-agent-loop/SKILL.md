---
name: managed-studio-agent-loop
description: 当用户说“继续当前 AI 漫剧项目”、要求 Codex 或 Grok 连接 AI 漫剧画布、按已锁人物场景道具生图、回写 raw/labeled 或进入 Review 时强制使用。覆盖零参数活动工程发现、冻结包、供应方一致性、原子写回和审片边界。
---

# 受管 Studio Agent 标准环

用户通过桌面 App 查看和审片；Agent 只经 MCP 读写同一活动受管工程。正常续作不要求用户粘贴路径、ID、SHA、revision 或长提示词。

## 固定流程

1. 调用 `get_capabilities`，确认当前构建允许并记下协议能力。
2. 零参数调用 `get_active_managed_studio_context`。只信任明确活动工程；缺失、不可用、非受管或旧构建时失败关闭，禁止从列表偷选第一项。
3. 按 context 的 `nextAction` 读 dashboard/readiness、当前宫格、锁定资产与提示词。歧义候选必须让用户确认；已知资产不得降级为 text-only。
4. 写操作只走 `execute_command` 与 expected revision/idempotency key。先冻结，再以明确 `provider: codex | grok` 派发。
5. 只使用冻结包中已验收的权威引用、正负锁、连续性快照和允许参考。禁止静默丢弃超额参考。
6. 生成后用 `commit_agent_imagegen_result_bundle` 一次提交图片路径、context token、pack/run/provider 与执行回执。由软件完成安全导入、机械检查、本地 labeled 和 raw/labeled 成对登记。
7. 写回只表示待审片；不自动判定视觉通过。读 Review 状态，将通过/返工留给用户或明确的 Review 命令。

## 安全边界

- 不读写 SQLite、CAS 内部路径；不越过 command bus owner。
- 不保存、读取或重述 API 密钥；不把浏览器/Artlist 当正式供应链。
- provider 错配、跨工程 token、旧构建、过期 pack、输入漂移、重复 run 改绑均停止，不绕过。
- 图像可解码、比例、SHA 和 raw/labeled 成对属于机械验收，不等于人物/场景/道具视觉一致性已通过。

## 无生图条件

模型不可用、无额度或输出状态不明时，保持 dispatch/pending 真实状态并报告阻塞；不用占位图、夹具或虚构回执冒充真实结果。
