# 小说模式 V1：迁移与安全合同

状态：`normative`  
原则：默认只读、导入副本、失败关闭、可恢复、不触碰正式源目录  
最后核对：2026-07-31

## 1. 威胁模型

必须防御：路径穿越、symlink/硬链接逃逸、特殊文件、读取期间替换、压缩炸弹、超大文件、恶意 DOCX、编码混淆、并发覆盖、崩溃半写、SQLite 损坏/忙、磁盘满、旧构建误写新 schema、AI 越权、明文密钥、未授权正文外发和第三方许可证污染。

攻击输入可能来自外部小说目录、导入文件、项目内被外部编辑的文件、AI 响应、恢复包和旧版 sidecar。所有输入均不可信。

## 2. 外部来源只读预检

预检不得在源目录创建 `.aicanvas`、锁、临时文件、索引、缩略图或系统设置。流程：

1. 对用户选择的根执行 `lstat`，要求真实普通目录且不是 symlink。
2. 获取 root `realpath`；每个候选先 `lstat`，拒绝 symlink、socket、device、FIFO 和越根项。
3. 用 `O_NOFOLLOW` 打开普通文件；读取前后比较 dev、ino、size、mtime/ctime，检测 TOCTOU 替换。
4. 仅识别允许的 TXT/MD/DOCX；未知格式进入报告，不猜测解析。
5. 记录相对路径、类型、字节数、mtime、SHA、编码判断、重复 SHA、章节识别结果和警告。
6. 预检前后对源树生成 aggregate manifest；任何变化使预检证据无效。

P2 实现前必须冻结并测试文件数、单文件大小、总字节、DOCX 解压字节/成员数和解析超时上限。超过上限只报告，不部分导入。

## 3. 导入副本状态机

默认导入模式为 `external_snapshot -> managed_markdown`：

```text
preflighted
-> staging_created
-> source_objects_copied
-> markdown_materialized
-> chapters_reconciled
-> hashes_verified
-> atomically_published
-> registered
```

- staging 位于新受管项目内部或应用专用临时根，不位于源目录。
- 原始字节按 SHA 保存为只读来源对象；可写正文是显式生成的 UTF-8 Markdown。
- DOCX 永远只作为来源快照；转为 Markdown 后保存转换器版本和可追溯映射。
- 发布前对账文件数、章节数、字节/字符数、SHA 和稳定 ID。
- 最后一步才原子发布目录并注册项目；注册前崩溃不得出现半项目。
- 重复相同 receipt 必须幂等；不重复创建正文或事件。
- 状态不明时先对账 receipt 与落盘事实，禁止盲目重试。

## 4. story v1 到小说 schema v2

现有 `StorySource.originalPath/snapshotPath` 和 `StoryChapter.path` 可能包含绝对路径，且旧 chapter ID 可能随标题变化。迁移只在用户显式创建 novel/hybrid 工作区后运行：

1. 只读加载 v1，校验所有来源和快照身份。
2. 创建迁移前完整镜像与 receipt，不覆盖 v1 文件。
3. 把可验证来源复制到受管目录；内部引用转换为相对 locator。
4. 为卷章生成一次性稳定 UUID，并保存 `legacyId -> stableId` 映射。
5. 逐章校验 SHA、字符区间和事件引用；异常、越根或丢失项使整批停止。
6. 在 staging 构建 v2，执行 schema、路径和往返验证。
7. 原子切换新 manifest；保留 v1 只读镜像和迁移回执。

标题/路径相同但内容或来源不同的条目不得自动合并。旧构建遇到 `minimumWriterSchemaVersion: 2` 必须拒绝写。

## 5. 正式保存和并发

- UI 草稿与正式正文分离；草稿不能被索引或改编当作正典。
- 正式保存携带 `expectedRevision + expectedSha256`，并经过 command bus、稳定幂等键、项目写锁和原子写。
- 两窗口同章竞争时只允许一个成功；另一方显示 base/本地草稿/磁盘三方 Diff。
- 两进程同幂等键副作用恰好一次；不同键同 revision 恰好一成一败。
- `fsync`/rename/回执任一阶段崩溃时，重启根据磁盘 SHA 和账本对账，不猜测是否提交。
- `ENOSPC`、无权限和 `SQLITE_BUSY` 都返回明确失败类型；不得截断、伪成功或归类为普通校验错误。

## 6. 路径和文件安全

- 内部 locator 先做语法校验，再 `path.resolve(root, locator)`，最后以 `realpath`/父目录真实路径确认 confinement。
- 读取现存文件必须 `lstat + O_NOFOLLOW` 并核对句柄身份；新建文件要求父目录逐级真实且非 symlink。
- 不信任 manifest 中的绝对根；恢复到新目录后重新绑定当前 root。
- 历史、change-set、draft 和 import receipt 也遵守相同限制。
- 正式写入使用现有 `writeTextAtomic`/同等级原子语义：独占临时文件、0600、文件 fsync、rename、目录 fsync、失败清理。
- 生产代码不得暴露故障注入开关。

## 7. DOCX 隔离

DOCX 解析必须在受限 worker/子进程中执行，并具备：输入只读、超时、内存/输出上限、压缩成员与展开体积上限、禁止外部关系和宏执行、禁止网络、结构错误失败关闭。解析器不得访问用户凭据或项目写接口。

输出先进入 staging；只有转换报告、章节对账和原始 SHA 全部通过后才可成为候选 Markdown。

## 8. AI、凭据与外发

- 远端模型默认关闭；无模型时导入、编辑、搜索、状态查询、连续性规则和重建必须完整可用。
- 凭据由主进程 `CredentialStore` 使用 Electron `safeStorage` 加密，密文文件权限 0600；项目只保存不敏感 `credentialRef`。
- renderer 只能设置凭据和读取 `configured: true/false`，不能读回明文。
- 每次远端调用前显示并记录：目标域名、provider/model、章节范围、字符数、内容 SHA 和本次授权。
- 公网只允许 HTTPS；本机 HTTP 需单独确认。禁止 URL/查询参数凭据、跨域重定向、正文日志和错误回显正文。
- 本地模式外网请求计数必须为 0；没有当次授权则正文外发计数必须为 0。
- AI 输出只接受严格 schema 校验后的 JSON；不得通过宽松 YAML、正则修补或默认值形成部分正式写入。

## 9. 派生库与恢复

- 专用 SQLite 开启 WAL、busy timeout、事务 schema migration、watermark 和 `quick_check`。
- 损坏时只隔离 `novel-derived.sqlite` 及 WAL/SHM，从权威文件重建；不得删除 `cache.sqlite`、制作/生成账本或命令账本。
- 重建期间读取旧一致快照或明确显示“重建中”；不能混合两个水位。
- 重建期间正文变化进入待重放队列，最终 watermark 必须等于最新 manifest/revision/SHA。
- 备份写屏障必须先 flush 草稿或阻止备份；恢复只落新目录，不覆盖原项目。
- 备份包括正文、故事圣经、历史、导入回执、change-set/审核和命令事实；派生库可随包保存，但恢复后必须校验水位，失效则重建。

## 10. 第三方来源门

复制第一行上游实现前必须同时满足：

1. `docs/third-party/novel-donors.json` 记录完整 commit、tree、上游文件 SHA、本地目标和修改计划。
2. 根 `THIRD_PARTY_NOTICES.md` 和对应 `licenses/` 全文存在并通过 SHA 审计。
3. 逐个本地文件标记是否包含上游代码；Apache 修改文件保留显著修改说明。
4. 不复制 Logo、品牌、截图、示例小说和无关依赖。
5. InkOS/其他 AGPL 实现只作行为规格参考，不复制、翻译、链接或引入依赖。
6. 打包前生成 SBOM 并验证 notices/licenses 已进入应用资源。

许可证裁决不明确、来源提交无法复现或本地修改无法追溯时，停止对应移植；其他独立阶段可继续。

## 11. 回滚与停止条件

- P1 UI/入口可由 feature flag 隐藏；旧 drama 行为保持。
- 导入失败不注册项目；staging 隔离保留诊断，不写源目录。
- 迁移失败保持 v1 和镜像；不切换 manifest。
- 索引失败隔离并重建；不影响正文读取/保存。
- AI provider 可完全禁用；候选留审计或隔离，不影响正典。
- 发现源目录变化、越根路径、正典损坏、不能对账的稳定 ID、许可证不明或需要新增外部服务时，立即停止对应写入并记录 blocker。
