# 官方身份与 clean-room 映射

观察时间：`2026-08-03T02:07:38Z`。所有身份来自官方 GitHub API、npm registry 或固定 commit 的官方文件；本轮没有下载 release asset、npm tarball 或仓库代码。

## 可复现身份

### InkOS

- 官方仓库：[Narcooo/inkos](https://github.com/Narcooo/inkos)
- 默认分支：`master`
- 观察时 HEAD：`0da8637099369f59c12377267ec2e5bdc8c4985f`
- 仓库许可：`AGPL-3.0`；npm 声明：`AGPL-3.0-only`
- latest release：`v1.7.2`（发布于 `2026-07-28T09:30:49Z`）
- npm：`@actalk/inkos@1.7.2`
- npm shasum：`ca3bcf7e157268d4369891866413deced7c8939c`
- npm integrity：`sha512-WaR5n8AReCs4od4aSgQ8K7wGfTrzxLpnkBjnW6w51Nqo9UCrYrESH+r7Xsok0XInLdBiRQyO1gnqWQWGDdOczQ==`
- README blob：`0898548c591c39bda268cc64bee6087e2160bf3c`
- 本轮处置：`METADATA_ONLY_NO_INSTALL`

### AI-Novel-Writer

- 官方仓库：[EthanYoQ/AI-Novel-Writer](https://github.com/EthanYoQ/AI-Novel-Writer)
- 默认分支：`master`
- 观察时 HEAD：`2dc3d45ba4f1953c11b132dae584b62d8089f934`
- 许可：`GPL-3.0`
- latest release：`v0.5.2`（发布于 `2026-08-02T09:35:30Z`）
- macOS ARM64 asset：`ai-novel-writer-mac-arm64-0.5.2-installer.dmg`
- asset size：`277144837` bytes
- GitHub digest：`sha256:caf797a65c659283f09917748d2b216b5dd65ba4bbf68ee70915be75224fcdf4`
- README blob：`32b81b9f13c44dcc4401d9f3764f1217a16423ab`
- 风险事实：官方文档说明 macOS 包未签名/未公证，运行数据进入 `~/.vela`
- 本轮处置：`METADATA_ONLY_NO_DOWNLOAD_NO_RUN`

### NovWr

- 官方仓库：[Hurricane0698/novelwriter](https://github.com/Hurricane0698/novelwriter)
- 默认分支：`main`
- 观察时 HEAD：`d7c53073a8e7a6544465d9781b51f247adb37f54`
- 许可：`AGPL-3.0`
- latest release：`v0.4.2`（发布于 `2026-07-28T12:24:13Z`）
- release 仅有 Windows x64 asset：`NovWr_0.4.2_x64-setup.exe`
- asset digest：`sha256:232e2af18c3fb8da485b176cae4d6ce429d2fcbd75dd0012a2d6bf64226461fe`
- `install.sh` blob：`f481980fe4e6f47db4e49e8b8a987e442a8176d7`，`3688` bytes
- README blob：`4fe9156324fd4a2f2f15c6538f0d6d4ea55d4b03`
- 风险事实：官方脚本初始化 `~/.novwr`，安装 uv/CLI 并依赖 Docker；本机 Docker CLI 存在但 daemon 不可用
- 本轮处置：`METADATA_ONLY_NO_SCRIPT_NO_DOCKER`

### OCNovel（身份未完全固定）

- Grok 输入缺少 owner/repository/commit，故不能称为已确认官方映射。
- GitHub 名称搜索的唯一 probable match：[wenjiazhu1980/OCNovel](https://github.com/wenjiazhu1980/OCNovel)
- 身份状态：`PROBABLE_MATCH_NOT_OWNER_PINNED`
- 默认分支：`main`
- 观察时 HEAD：`50ec3679291504784cda2f3c5d0cd96a13934390`
- 许可：`MIT`
- latest release：`v1.0.32`（发布于 `2026-07-28T04:00:31Z`）
- macOS ARM64 asset：`OCNovel-macOS-arm64.zip`
- asset size：`118900073` bytes
- GitHub digest：`sha256:d9530b834e23163009edc85bdd08b580ad842391d6f379950831a0e4f5efbd15`
- README blob：`c5aa80b7602f247c31c19f457ed4bab15af674dc`
- 本轮处置：`RESEARCH_ONLY_IDENTITY_UNCONFIRMED_NO_DOWNLOAD`

## Clean-room 能力映射

| 可观察的外部产品概念 | Canvas 现有能力 | 真正差异 | 允许动作 |
|---|---|---|---|
| InkOS 的 plan/compose trace、current focus | doctor、prepare、Context Pack、Writing OS dashboard | Owner 尚不能在一个只读面板完整看到本章包的纳入/省略及原因 | 只记录为 `KERNEL-PACK-TRACE-SURFACE` 候选；独立实现，不复制代码 |
| AI-Novel-Writer 的分阶段写作控制面 | 章节 rail、候选 diff、probe、人工结算 | 主流程已经存在 | 复用，不新增平行阶段状态 |
| NovWr 的世界模型与草稿审批 | Story Bible/cutoff 投影、候选状态、人工 accept/reject | 主合同已经存在 | 复用，不新建 Atlas/World DB |
| probable OCNovel 的 RAG/审计概念 | FTS/locator、Context Pack receipts、probe | 身份未完全确认，且没有证明需新增检索内核 | 只作术语级研究，不进入依赖或实现 |

## 禁止吸收项

- 外部源代码、组件、Schema、prompt 模板的复制、逐行翻译或衍生移植；
- GPL/AGPL 包链接到 Canvas runtime；
- 外部工具的隐藏用户目录、数据库或状态文件成为 Canvas 的第二事实来源；
- 用外部 UI 的“完成”状态替代 Canvas pack/preflight/CAS/state/probe 证据；
- 把 probable OCNovel 身份写成已确认官方来源。

