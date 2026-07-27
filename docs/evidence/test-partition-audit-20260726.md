# 测试分层机械清点 · 2026-07-26（P0d 前置）

清点方式：node 脚本解析 package.json 的 test:fast excludes / test:integration / test:heavy 文件与 glob，对照 vitest include（tests/**/*.test.ts）实际文件展开做集合运算。

结果：
- all（vitest 实际收集）= 293 文件（全部位于 tests/ 顶层，src/scripts 无 *.test.ts）
- fast = 256
- integration = 33（p30-*.test.ts + mcp-*.test.ts 展开 + 8 个显式文件）
- heavy = 4（studio-video-package / -provider / -source-adapter / studio-unit-grid-continuation-source）
- union = 293 = all ✓；overlap = 0 ✓；missing = 0 ✓；无引用不存在的文件 ✓

对照：STATUS.md 旧记录 285 = fast 249 / integration 32 / heavy 4 已过期（其后新增 8 个测试文件）。
