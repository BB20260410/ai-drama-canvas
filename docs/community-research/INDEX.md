# 社区研究索引（2026-07-18）

本目录是「AI 漫剧无限画布」的**社区技能 / 提示词 / 规范**调研与落盘处。  
**不执行 P8 代码**；供后续研发与内容生产 Agent 引用。

## 先读

| 文件 | 内容 |
|------|------|
| [全网社区技能与规范分析_20260718.md](./全网社区技能与规范分析_20260718.md) | 全面分析、取舍、映射到 P5–P10 |
| [GOAL_提示词_全量P0至P10_20260723.md](./GOAL_提示词_全量P0至P10_20260723.md) | **全量** /goal：P0–P10 全表深读融合验证 |
| [GOAL_提示词_竞品代码深读融合验证_20260723.md](./GOAL_提示词_竞品代码深读融合验证_20260723.md) | 可 /goal 执行：双边源码深读→融合→真实验证 |
| [可借鉴方面优先级P0至P10_20260723.md](./可借鉴方面优先级P0至P10_20260723.md) | 不限5款：有用方面 × P0–P10 执行优先级总表 |
| [竞品深度对比与迭代方向_20260723.md](./竞品深度对比与迭代方向_20260723.md) | 开源/闭源各 Top5 源码级对比与个人用迭代路线 |
| [Seedance2双仓选择性吸收与Studio映射_20260723.md](./Seedance2双仓选择性吸收与Studio映射_20260723.md) | Emily2040 / dexhunter 双仓取舍、续作状态合同与 Studio clean-room 映射 |
| [prompts/](./prompts/) | 可复制提示词摘录 |
| [vendors/](./vendors/) | 已克隆的开源 skill 快照（去 `.git`） |
| [local-mirrors/](./local-mirrors/) | 本机已有短剧/分镜 skill 快照 |
| 上级 [开源项目借鉴审计_2026-07-13.md](../开源项目借鉴审计_2026-07-13.md) | OpenAssetIO/Kitsu/OpenCut 等软件侧审计 |

## 项目内已安装 Agent 技能

路径：`.grok/skills/`（Grok 优先加载；`.claude/skills` 与 `.agents/skills` 有兼容副本）

| Skill | 何时用 |
|-------|--------|
| `ai-drama-canvas-agent` | 在本仓库写软件 / P8 驾驶舱 / MCP / 门禁 |
| `ai-drama-production-prompts` | 写短剧提示词、角色锁、15s 分镜 |
| `canvas-scale-performance` | 大规模画布性能 / 虚拟化 |

## vendors 清单

| 目录 | 源 | 价值 |
|------|----|------|
| `visual-skills` | github.com/smixs/visual-skills | 导演/剧作/剪辑 + Seedance/Kling/Veo 提示词体系 |
| `video-prompting-skill` | github.com/Square-Zero-Labs/video-prompting-skill | 多模型 video prompt + character sheet |
| `ai-video-generator-claude` | github.com/rediumvex/ai-video-generator-claude | 10 种营销/Seedance 风格 skill（内容向） |
| `higgsfield-claude-skills` | github.com/AKCodez/higgsfield-claude-skills | 浏览器自动化（**禁止接入正式链**） |
| `prompt-to-canvas` | github.com/Zimzheng/prompt-to-canvas | Excalidraw 可编辑画布 skill（示意/架构） |
| `claude-video` | github.com/bradautomates/claude-video | 视频看片/抽帧/转写（审片辅助思路） |

## 使用原则一句话

社区教你**怎么写和怎么审**；本软件保证**身份、版本、SHA、引用、门禁、证据**。二者拼接，不互相替代。
