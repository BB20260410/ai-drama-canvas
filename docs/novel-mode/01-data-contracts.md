# 小说模式 V1：数据合同

状态：`normative`  
目标实现：`src/core/novel-types.ts` 及对应 Zod/运行时校验  
最后核对：2026-07-31

## 1. 通用编码和标识规则

- 所有 JSON/JSONL/Markdown 正式文件使用 UTF-8；JSONL 每行一个完整 JSON 对象。
- 正文不得在保存时静默做 Unicode 或换行规范化；`sha256` 对磁盘实际字节计算。
- `charCount`、`startOffset`、`endOffset` 使用 JavaScript UTF-16 code unit，字段必须同时声明 `offsetEncoding: "utf16-code-unit"`。
- `endOffset` 为开区间；必须满足 `0 <= startOffset <= endOffset <= content.length`。
- 稳定 ID 使用生成后不变的 UUID；标题、文件名、顺序、卷归属变化不得改变 ID。
- 时间戳为 UTC ISO-8601；revision 是从 1 开始单调递增的安全整数。
- 项目内 locator 一律为 `/` 分隔的相对路径；不得含空段、`.`、`..`、NUL 或绝对路径。
- 内容哈希一律为 64 位小写十六进制 SHA-256。

## 2. 目录合同

```text
project-root/
  manuscript/
    chapters.json
    volumes/<volume-id>/<chapter-id>.md
  story-bible/
    entities.json
    facts.jsonl
    character-knowledge.jsonl
    relationships.jsonl
    timeline.jsonl
    foreshadowing.jsonl
    world-rules.jsonl
    continuity-issues.jsonl
    revision-queue.jsonl
  .aicanvas/
    managed-project.json
    story/
    novel/
      manifest.json
      import-receipts/
      change-sets/
      drafts/
      derived/summaries/
      novel-derived.sqlite
    history/story/chapters/
```

`manuscript/`、`story-bible/` 和已接受审核记录属于权威备份集合；`novel-derived.sqlite`、`-wal`、`-shm` 和可重建摘要投影不属于唯一权威。

## 3. 工作区 manifest

目标 managed project schema v2 增加：

```ts
type WorkspaceMode = "drama" | "novel" | "hybrid";

interface NovelWorkspaceDeclaration {
  workspaceMode: WorkspaceMode;
  minimumWriterSchemaVersion: 2;
  novelManifest?: ".aicanvas/novel/manifest.json";
}
```

- schema v1 缺少字段时读取投影为 `drama`，但不落盘迁移。
- 新 `novel`/`hybrid` 项目必须是 schema v2。
- 不理解 schema v2 或 `minimumWriterSchemaVersion` 的构建必须拒绝写。
- `novelManifest` 只允许上述固定相对路径。

## 4. 卷章 manifest

`manuscript/chapters.json` 的目标结构：

```ts
interface NovelChapterManifest {
  schemaVersion: 1;
  projectId: string;
  revision: number;
  volumes: Array<{
    volumeId: string;
    title: string;
    order: number;
    revision: number;
  }>;
  chapters: Array<{
    chapterId: string;
    volumeId: string;
    title: string;
    order: number;
    relativePath: string;
    sha256: string;
    byteLength: number;
    charCount: number;
    offsetEncoding: "utf16-code-unit";
    revision: number;
    sourceReceiptId?: string;
    createdAt: string;
    updatedAt: string;
  }>;
  updatedAt: string;
}
```

硬断言：

- ID、`relativePath` 和 `(volumeId, order)` 各自唯一。
- `relativePath` 必须位于 `manuscript/volumes/`，解析后仍在项目真实根内。
- 读取时实际 SHA、字节数、字符数与 manifest 不一致则状态为 `external_change`；禁止自动覆盖。
- 重命名、移动和重排只变 metadata/revision，不重建 chapterId。

## 5. 来源证据

所有事实、状态、关系、伏笔和 AI 候选引用统一使用：

```ts
interface NovelSourceSpan {
  chapterId: string;
  relativePath: string;
  startOffset: number;
  endOffset: number;
  offsetEncoding: "utf16-code-unit";
  sourceSha256: string;
  chapterRevision: number;
  excerptSha256: string;
}
```

验证顺序：限制路径 → 读取正文实际字节 → 校验 `sourceSha256` → 解码 UTF-8 → 检查 offset → 对切片再次校验 `excerptSha256`。任一步失败，证据为 stale，不得返回伪精确引用。

## 6. 正典与认识论双轴

```ts
type CanonStatus = "proposed" | "canon" | "conflicted" | "retconned" | "cut";
type EpistemicStatus = "confirmed" | "inferred" | "uncertain";
type CreatedBy = "user" | "import" | "accepted-editorial" | "model" | "migration";
```

`canonStatus` 表示是否属于作品权威；`epistemicStatus` 表示信息确定程度。两者不得压缩成单一 status。默认查询仅纳入 `canon`；`proposed` 只进候选视图，`conflicted` 只进冲突提示，`retconned/cut` 仅用于历史追溯。

## 7. 实体、事实和时态记录

实体文件 `entities.json` 至少包含稳定 ID、类型、主名称、别名、人工合并记录和 revision。同名、别名、年龄态合并必须由人确认。

事实 JSONL 的公共合同：

```ts
interface NovelFactRecord {
  schemaVersion: 1;
  id: string;
  kind: "event" | "character" | "location" | "prop" | "rule" |
    "dialogue" | "relationship" | "time" | "weather" | "costume" |
    "narration" | "psychology" | "environment";
  subjectEntityId: string;
  predicate: string;
  object: unknown;
  validFromChapterId: string;
  validUntilChapterId?: string;
  disclosedAtChapterId: string;
  sources: NovelSourceSpan[];
  canonStatus: CanonStatus;
  epistemicStatus: EpistemicStatus;
  revision: number;
  supersedesId?: string;
  createdBy: CreatedBy;
  createdAt: string;
  updatedAt: string;
}
```

- chapter order 只能从当前 `chapters.json` 解析，调用方提供的 order 不可信。
- `validUntil` 早于 `validFrom` 必须拒绝。
- 修改通过追加同 ID 新 revision 或新 ID + `supersedesId` 表达；不得删改旧 JSONL 行。
- 角色知识另存 `character-knowledge.jsonl`，必须同时记录 `knowerEntityId` 和 `learnedAtChapterId`；世界事实成立不等于角色已经知道。
- 关系同时记录双方、方向、关系类型、有效期和来源；不得只保存“当前关系”。
- 时间线分别记录 `storyTime` 与 `disclosureChapterId`，实际发生顺序和读者获知顺序不得混用。
- 伏笔必须表达 `setup | progression | payoff | abandoned`、预期/实际回收、来源和修订动作。

## 8. 目标章查询合同

状态和上下文查询必须携带：

```ts
interface NovelTemporalQuery {
  targetChapterId: string;
  cutoff: "before" | "through";
  visibility: "past_only" | "whole_book_review";
}
```

- `targetChapterId` 必填且必须属于当前 manifest；Core 从 manifest 解析 order。
- 写第 N 章默认 `before + past_only`：只允许披露章 order `< N` 的记录。
- 复核第 N 章结尾可用 `through + past_only`：只允许披露章 order `<= N`。
- `whole_book_review` 只有显式用户动作可设置；Core/IPC 记录该意图，AI 不能自行升级。
- 时态有效条件为 `validFrom <= cutoffOrder` 且 `validUntil` 不早于 cutoff；披露/知识条件仍需单独通过。
- 所有 SQL 和 Core 查询都必须带 cutoff；不得依靠 prompt 中的“不要看后文”。
- 返回项必须包含记录 ID、revision、双轴状态和至少一条已验证 `NovelSourceSpan`。

## 9. change-set 合同

```ts
interface NovelChangeSet {
  schemaVersion: 1;
  changeSetId: string;
  status: "staged" | "partially_accepted" | "accepted" | "rejected" | "stale";
  targetChapterId: string;
  visibility: "past_only" | "whole_book_review";
  baseFiles: Array<{ relativePath: string; revision: number; sha256: string }>;
  requestHash: string;
  provider: string;
  model: string;
  sourceScope: NovelSourceSpan[];
  operations: Array<{
    operationId: string;
    kind: "replace_text" | "append_fact" | "append_state" | "append_issue";
    target: string;
    before: unknown;
    after: unknown;
    decision: "pending" | "accepted" | "rejected";
  }>;
  createdAt: string;
  reviewedAt?: string;
}
```

候选文件本身是审核/审计事实，不是正文正典。接受时重新校验所有 base 文件；任何一个漂移则整个应用事务失败关闭。正文必须允许逐段接受，事实允许逐字段接受；接受后只生成一次命令副作用。

## 10. 派生索引合同

`.aicanvas/novel/novel-derived.sqlite` 只允许包含文档、chunk、FTS、状态/关系区间投影、伏笔、摘要索引和 checkpoint。数据库必须：

- 使用现有 `node:sqlite`、事务迁移、busy 策略和 `PRAGMA quick_check`；不引入第二套 DB owner。
- 每行记录来源 ID、revision、SHA 和 index watermark。
- FTS chunk 保留 chapterId、相对路径、UTF-16 offset 和原文，用确定性中文单字/双字规范化建立检索词。
- 来源 SHA 变化使真实依赖项 stale；不能以小改动为由复用旧摘要。
- 数据库、WAL、SHM 全部删除后可仅凭权威文件重建；页级字节哈希不要求一致，逻辑结果必须一致。
