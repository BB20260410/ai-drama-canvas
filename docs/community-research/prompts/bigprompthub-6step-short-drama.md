# Big Prompt Hub · AI 真人短剧六步工作流提示词（摘录 2026-05）

来源：https://www.bigprompthub.com/ai-short-drama-prompt-workflow-2026/  
用途：内容生产链（概念→分集→角色圣经→静帧包→分镜连续性→短片段渲染）  
与本仓库对齐：映射到 P5 CanonicalAsset / P6 BindingSet / P7 九字段连续性 / 本地 15 秒 2–6 宫格；**不**作为正式 Artlist/网页供应商流水线。

---

## Prompt 1 · Story Engine（短剧概念压缩）

```
ROLE: Act as a short-form live-action drama showrunner.
CORE TASK: turn one rough idea into a bingeable vertical short-drama concept.
FORMAT GOAL: optimize for **[episode count]** episodes of **[episode duration]** each.
AUDIENCE TARGET: write for **[target audience]** on **[platform type]**.
NEGATIVE PROMPT: avoid vague genre labels, expensive worldbuilding that cannot be visualized consistently, filler side plots, and hooks that do not create a next-episode reason.
OUTPUT FORMAT: return one production-ready concept sheet that can guide a high-resolution vertical series package.

Build an AI live-action short drama concept from this seed:
**[core idea]**

Include:
1. Series title options
2. Core genre and emotional promise
3. Protagonist, antagonist, and reversal mechanic
4. The opening hook viewers should understand within 3 seconds
5. The repeating conflict escalator that keeps episodes addictive
6. The production constraint strategy so scenes remain filmable with AI tools
7. A one-paragraph season arc for **[episode count]** episodes

Keep the result practical for AI live-action short drama production, not a broad TV bible.
```

## Prompt 2 · Episode Beat Map

```
ROLE: Act as a vertical short-drama head writer.
CORE TASK: break the concept into episode-level beats with retention logic.
RUNTIME LOCK: each episode should fit **[episode duration]**.
DELIVERY FORMAT: one row per episode, export-ready for a vertical episode board.
NEGATIVE PROMPT: avoid duplicate turning points, soft endings, exposition-only episodes, and twists that do not change the next scene.

Use this series concept:
**[series concept]**

Create a beat map for **[episode count]** episodes.

For each episode, include:
1. Opening hook
2. Immediate conflict
3. Mid-episode turn
4. Emotional push or reveal
5. End cliffhanger
6. Production note if the episode should stay in one core location

Keep the beats short, direct, and practical for later shot breakdown.
```

## Prompt 3 · Character and Casting Bible

```
ROLE: Act as a casting director and continuity supervisor for an AI short drama.
CORE TASK: create a character bible that can guide still-image and video prompts.
IDENTITY LOCK: keep age read, face shape, hair, wardrobe, and class signals stable across episodes.
OUTPUT FORMAT: return a continuity-safe casting bible with fixed fields for high-resolution reference generation.

Using this series concept and beat map:
**[series concept]**
**[episode beat map]**

Create character sheets for:
**[main cast list]**

For each character, include:
1. Role in story
2. Age read and class signal
3. Face and body identifiers
4. Wardrobe anchors
5. Signature prop or gesture
6. Emotional baseline
7. What must stay consistent in image and video generation

Return the output as a production bible, not as novel prose.
```

## Prompt 4 · Reference Still Pack

```
ROLE: Act as a cinematic still photographer building a reference pack for an AI short drama.
CORE TASK: generate character and location stills that later guide video generation.
FORMAT RULE: produce clean, continuity-safe stills for a vertical live-action short drama.
NEGATIVE PROMPT: avoid duplicate faces, shifting wardrobe, inconsistent age read, extra fingers, warped hands, unreadable props, and random lighting changes.
OUTPUT FORMAT: return a high-resolution still-image pack with one labeled purpose per frame and a fixed aspect ratio.

Create a reference pack for:
**[project title]**

Use this character bible:
**[character bible]**

Generate:
1. Main-character three-quarter portrait
2. Full-body wardrobe reference
3. Antagonist reference
4. Hero location wide shot
5. One emotional close-up frame
6. One conflict setup frame

Visual direction:
**[lighting style]**
**[camera realism]**
**[color grade]**

Keep the stills realistic, cinematic, and reusable as continuity anchors.
```

## Prompt 5 · Shot Breakdown and Continuity Lock

```
ROLE: Act as a short-drama storyboard supervisor.
CORE TASK: turn one episode beat map into shot prompts while preserving continuity.
TIMING RULE: keep each clip segment short enough for AI video generation.
OUTPUT FORMAT: scene > shot list > continuity lock, ready for aspect ratio and render planning.
NEGATIVE PROMPT: avoid random shot inflation, directionless close-ups, continuity drift, and dialogue chunks too long for one short clip.

Use:
**[episode beat]**
**[dialogue lines]**
**[reference still pack]**

For each scene, return:
1. Shot number
2. Duration target
3. Camera framing
4. Character action
5. Dialogue or silence cue
6. Continuity lock note
7. Transition into the next shot

Append a final continuity sheet covering:
- fixed wardrobe details
- prop positions
- location lighting
- emotional state carried across the sequence

Keep the plan practical for AI video rendering, not traditional film coverage.
```

## Prompt 6 · Clip Builder and Assembly Notes

```
ROLE: Act as an AI short-drama video director and editor.
CORE TASK: generate one clip prompt at a time, then return assembly notes.
REFERENCE LOCK: preserve the attached still and continuity sheet.
NEGATIVE PROMPT: avoid face swaps, random wardrobe changes, broken hands, floating props, wrong subtitles, camera jumps, and mood shifts that ignore the scene.

Build a clip prompt for this shot:
**[shot description]**

Reference still:
**[reference still note]**

Continuity rules:
**[continuity sheet]**

Return:
1. A short clip prompt
2. Motion direction
3. Lighting and emotional tone
4. Subtitle or dialogue handling note
5. End-frame requirement if this clip must feed a cliffhanger
6. Assembly instruction for where this clip belongs in the episode timeline

Generate one clip job only. Do not try to render the entire episode in one prompt.
```

## 与本项目字段映射（实现时用）

| 社区概念 | 本项目权威结构 |
|---------|----------------|
| Casting bible | `CanonicalAsset` + Authority version + 正负硬锁 |
| Reference pack | CAS 媒体 SHA + AssetVersion + labeled/raw |
| Shot continuity lock | P7 九字段 + previous-panel raw |
| Drift / accept | ReviewRecord + checkpoint（每 6 槽停检） |
| Binding before gen | P6 `AssetBindingSet`（禁止静默消歧） |
| 15s unit | Studio unit 2–6 宫格，合计严格 15 秒 |
