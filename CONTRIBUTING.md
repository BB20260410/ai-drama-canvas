# 贡献指南

感谢你对 AI 漫剧无限画布的关注。本项目按 **Apache License 2.0** 完全免费开源：没有商业双授权，也没有单独 CLA。提交 Pull Request 即表示你按 Apache-2.0 授权该贡献（inbound = outbound）。

## 参与方式

- **报告缺陷**：开 Issue，附复现步骤、预期与实际行为、操作系统与 Node 版本。
- **建议功能**：先说清要解决的问题，而不只给方案。
- **提交代码**：修缺陷、补测试、改进文档，通过 Pull Request。

## 开发环境

需要 **Node.js 22+**。媒体相关测试还需要本机 `ffmpeg` / `ffprobe`。

```bash
npm install
npm run typecheck:app
npm test
npm run dev
```

不要启动本机已安装的 `/Applications/AI 漫剧画布.app` 去跑 Playwright GUI，除非维护者明确要求。

## Pull Request

1. Fork 后从 `main` 拉分支，例如 `fix/readme-typo`。
2. 一个 PR 只做一件逻辑上的事。
3. 新行为要有测试；修缺陷要有回归测试。
4. 提交前本地跑通 `npm run typecheck:app` 与 `npm test`。
5. 跟随周边代码的命名、注释密度和 TypeScript / Vue 3 风格。
6. 不要提交密钥、凭据、本机工程目录（`projects/`、`productions/`、`output/`）或个人媒体。

## 不要做的事

- 不要把 AGPL / GPL 源码并入核心。第三方借鉴必须可追溯，见 `THIRD_PARTY_NOTICES.md`。
- 不要把 API 密钥写进仓库、`.env` 提交或 Issue 截图。
- 不要重建已经关账的 P0–P14 owner 合同，除非 Issue 里有可复现缺陷。

## 行为准则

参与本仓库即同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
