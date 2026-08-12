# 小说模式 V1：范围与权威合同

状态：`normative`  
计划基线：`.planning/2026-07-31-novel-memory-library-v1/task_plan.md` v1.0  
适用阶段：P1–P8  
最后核对：2026-07-31

## 1. 产品结论

小说模式是现有受管“AI 漫剧无限画布”项目的增量工作区，不是第二套应用或第二套项目真相源。受管项目新增：

```text
workspaceMode = drama | novel | hybrid
```

- `drama`：保持当前 `MaterialStudioView`、P0–P14 owner 和生产行为。
- `novel`：进入 `NovelStudioView`，启用正文、故事圣经、时态记忆和小说检索。
- `hybrid`：显式切换小说与短剧工作区；两边共享同一项目根和锁定版本证据。
- 旧 manifest 没有 `workspaceMode` 时只按 `drama` 读取；不得后台升级、创建小说目录或改变现有行为。

任何实现若需要重建 `material-studio.sqlite`、`studio-production.sqlite`、现有 command bus、备份 owner 或 P0–P14 页面，均超出 V1 授权，应停止并重新裁决。

## 2. V1 必须交付

1. macOS Electron 单人、本地优先小说工作区。
2. 新建小说项目，或只读预检 TXT、Markdown、DOCX 和目录后导入受管副本。
3. 稳定卷章 ID、Markdown 编辑、卷章树、历史、CAS 保存和崩溃草稿恢复。
4. 人物、地点、道具、势力、世界规则、关系、知识、时间线、伏笔和连续性问题。
5. 中文 FTS5、分层上下文、目标章状态查询和逐条来源证据。
6. AI 只产生候选 change-set；人工逐项 Diff 后接受或拒绝。
7. 删除专用派生库后可从权威文件完整重建。
8. 备份、恢复到新目录、无损归档和锁定小说版本交给现有短剧改编。

## 3. V1 非目标

- 云同步、账号、多人实时协作、移动端和 Web SaaS。
- 原地接管或直接写用户外部小说目录。
- 把 SQLite、向量、摘要、模型推断或聊天记录升级为正典。
- 默认引入 Python/FastAPI/LanceDB/LangGraph 或第二种数据库运行栈。
- 自动合并同名实体、自动批准事实、自动改正文、自动发布、上传或付费。
- 未经单独授权替换 `/Applications/AI 漫剧画布.app`。
- 用“测试通过”替代文学质量、真实模型质量或人工 UI 验收。

## 4. 权威层级与唯一 owner

从高到低的内容裁决顺序固定为：

```text
正文原文
> 作者明确决定
> 已接受的编辑决定
> 外部研究
> 模型推断
> 聊天记录
```

| 数据 | 唯一权威 | 唯一写 owner | 派生/消费者 |
|---|---|---|---|
| 工作区模式 | `.aicanvas/managed-project.json` | managed project owner | renderer 路由 |
| 卷章身份与顺序 | `manuscript/chapters.json` | `NovelRepository` | 卷章树、索引 |
| 正文 | `manuscript/volumes/**/*.md` | `NovelRepository` | FTS、摘要、AI 上下文 |
| 实体 | `story-bible/entities.json` | `NovelRepository` | 状态、关系、检索 |
| 正典事实与状态变化 | `story-bible/*.jsonl` | `NovelRepository` | 时态投影、连续性规则 |
| AI 候选及审核 | `.aicanvas/novel/change-sets/*.json` | novel command runtime | Diff UI、审计 |
| 原始导入证据 | `.aicanvas/novel/import-receipts/` 与 `.aicanvas/story/` | import owner | 来源核对、改编兼容 |
| 全文/状态/摘要索引 | `.aicanvas/novel/novel-derived.sqlite` | derived index owner | 查询；可删除重建 |
| 命令结果 | 既有 command bus/ledger | `executeIdempotentCommand` | 幂等与恢复 |

约束：

- `.aicanvas/story/` 保留既有导入证据和改编兼容数据，不复制或反向覆盖新小说正典。
- UI、IPC、MCP、AI、索引器都不得直接写 `manuscript/` 或 `story-bible/`；只能调用 `NovelRepository` 的命令入口。
- SQLite 中不存在任何“只此一份”的用户正文、正典、审核决定或历史。
- 每个 owner 只有一个 schema 和一个写入口；出现平行 JSON、平行 DB 或 renderer 自行推导状态即判失败。

## 5. 写入协议

所有正式写入必须依次执行：

1. 解析并限制到受管项目真实根；拒绝 symlink、特殊文件和越根路径。
2. 通过 command bus 注册稳定 `requestId`、`idempotencyKey` 和请求哈希。
3. 获取项目/实体写锁。
4. 重读当前 `revision` 与正文实际字节 SHA-256。
5. 校验调用方携带的 `expectedRevision` 与 `expectedSha256`。
6. 保存前一修订的内容寻址历史。
7. 临时文件独占创建、写入、`fsync`、原子 `rename`、父目录 `fsync`。
8. 追加不可变事件/回执；推进 revision。
9. 将相关派生索引和摘要标记 stale，后台增量重建。
10. 命令账本写入成功终态。

任一步骤无法证明提交与否时返回待对账状态，不得重放未知副作用。撤销通过新修订表达，不得改写历史。

## 6. AI 与人工批准边界

- AI 只有读取、检索和创建候选权限。
- 候选必须绑定 base revision、base SHA、来源范围、provider、model、request hash 和生成时间。
- 正文按段、事实按字段审核；正文候选禁止“一键全部接受”。
- 拒绝候选不得改变任何权威文件的 aggregate SHA。
- 接受前必须重新校验 base；发生漂移时标记 `stale` 并停止。
- 未接受、冲突、已撤回或失效候选不能进入正典查询、下一章上下文或短剧锁定版本。
- `whole_book_review` 只能由用户显式启动，不能由 AI 或 UI 默认打开。

## 7. 完成定义

只有 `03-acceptance-spec.md` 的所有必选门同时通过，才可报告“小说本地软件和记忆库已落地”。代码存在、页面可打开、单测通过或索引能查到内容，均不能单独构成完成。

真实外部模型验证属于单独可选门；没有用户对外发、域名、模型、字符数和可能费用的当次授权，不得执行，也不得阻塞无模型本地核心关账。
