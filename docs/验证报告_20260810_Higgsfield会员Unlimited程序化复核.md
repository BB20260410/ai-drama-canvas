# Higgsfield 会员 Unlimited 程序化复核

时间：2026-08-10 06:58 CST  
结论：**会员已确认；官方 connector/CLI 仍没有可验证的免费图片与免费视频调用通道**

## 已排除的问题

- Connector 和 CLI 都识别为 Ultra 会员。
- 只有一个 Ultra private workspace，账户与工作区计划一致，没有选错工作区的证据。
- Connector 的 balance、workspace、模型目录与费用预检均能正常鉴权，没有授权过期证据。
- 本机官方 CLI 已从 1.1.20 升级到 npm 当前 1.1.23；不是旧版本造成。

## Connector 实测

- 全量目录 86 个模型，目录声称 11 个图片和 5 个视频模型 `supports_unlim=true`。
- 但精确费用后端与目录冲突：
  - `nano_banana_2` 仍返回 1.5 nominal credits。
  - `gpt_image_2` 仍返回 0.5 nominal credits。
  - `seedream_v4_5`、`flux_2` 明确拒绝 Unlimited。
  - `seedance_2_0`、`seedance_2_0_mini`、`kling3_0`、`gemini_omni`、`wan2_7` 五个视频模型全部明确拒绝 Unlimited。
  - Seedance 2.5 的 `supports_unlim` 字段缺失；20 秒/720P、`use_unlim=true` 明确返回 `INVALID_ARGUMENT`。
- 没有一个响应返回 `cost=0`、`billingMode=unlimited` 或 Unlimited receipt。

## 最新 CLI 实测

- 1.1.23 的 Seedance 2.5、Seedance 2.0 和 GPT Image 2 模型合同均不包含 `use_unlim`。
- 对 Seedance 2.5 与 GPT Image 2 传 `--use_unlim true`，均在客户端失败：`Unknown params: use_unlim`。
- 因此最新版 CLI 也无法把网页 Unlimited 权益带入生成请求。

## 裁决

用户“已开会员、有 Unlimited 权限”的陈述与账户事实一致；问题不在会员，而在网页权益没有投影到当前 connector/API/CLI 合同。

在“不允许扣普通 credits”的要求下，不能用一次真实生成来试探后端是否会忽略名义费用。视频侧更不存在可通过的 Unlimited 预检。因此本地 App 必须继续保持 Unlimited-only fail-closed，不能伪造免费成功。

Higgsfield 官方 CLI 目前仍公开记录“网页 Unlimited 无法通过 CLI 使用”的缺口：[Issue #16](https://github.com/higgsfield-ai/cli/issues/16)。

## 外部副作用

- 未生成图片或视频。
- 未上传任何素材。
- 未消耗 credits。
- 未使用网页自动化或私有 API。
- 未修改正式项目、CAS、Review 或生产账本。

结构化证据：`docs/evidence/higgsfield-unlimited-membership-programmatic-recheck-20260810.json`。
