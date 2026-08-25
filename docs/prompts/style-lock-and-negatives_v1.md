# 风格锁 + 负向库 v1

按剧 fork。本仓默认电影写实短剧。

## 风格锁

```
id: style-r-cine-v1
look: photoreal cinematic, controlled contrast, natural skin
aspect: 9:16
forbidden_in_raw:
  - 画面内字幕/标题
  - 把多格画进同一格
  - 水印/标志
  - 相对 controlRefs 换脸
```

正式硬锁（本机资产，不进 git）：黄金面具 SHA-256 `02e9438ecee038f7d14860da37cb315bf358db4a26fa224e342eee5b592b55a9`。禁止半面具变体。

## 负向（HARD_NEGS）

来自冻结 `forbidden`：titles / panel-numbers / durations / dialogue-text / subtitles / watermarks / ui / pseudo-text。  
格级 `negativePrompt` 去重并入。不得用长负向清单顶替权威图。
