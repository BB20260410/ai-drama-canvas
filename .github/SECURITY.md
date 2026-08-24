# 安全政策

## 支持范围

本仓库的 `main` 分支是当前安全修复入口。本应用是本地优先桌面工作台：不把 API 密钥写入项目目录，MCP 输出会脱敏 URL 凭据。

## 报告漏洞

请不要在公开 Issue 里贴密钥、令牌或可利用细节。

优先使用 GitHub 的 **Private vulnerability reporting**（仓库 Security 标签 → Report a vulnerability）。若该入口不可用，可开一个不含利用细节的 Issue，标题加 `[security]`，维护者会改成私密沟通。

我们会确认影响范围、修复，并在发布说明中致谢（除非你要求匿名）。

## 已知边界

- 密钥只应出现在本机环境变量中；UI 里填写的是环境变量名，不是密钥本身。
- `tests/fixtures/novel-provider-tls-key.fixture` 是本地自签测试夹具，不是生产私钥。
- `projects/`、`productions/`、`output/` 是本机事实源，已被 `.gitignore` 排除，发布源码时不得纳入。
