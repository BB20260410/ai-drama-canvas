<template>
  <section class="editor-workbench">
    <header class="editor-header">
      <div>
        <span class="eyebrow">本地成片剪辑</span>
        <h2>导演剪辑台</h2>
        <p>真实素材进入侧车工程，预览与编排不改原文件；导出永远生成新的 MP4 版本。</p>
      </div>
      <div class="editor-actions">
        <span :class="['engine-state', { offline: !engine?.available }]">{{ engine?.available ? 'FFmpeg 就绪' : 'FFmpeg 未就绪' }}</span>
        <select v-model="activeProjectId" @change="selectEditProject(activeProjectId)">
          <option value="">选择剪辑工程</option>
          <option v-for="entry in projects" :key="entry.id" :value="entry.id">{{ entry.name }} · v{{ entry.revision }}</option>
        </select>
        <button class="ghost-button icon-history" type="button" title="撤销剪辑" :disabled="!active || !historyInfo.canUndo" @click="undoEditor"><Undo2 :size="14" /></button>
        <button class="ghost-button icon-history" type="button" title="重做剪辑" :disabled="!active || !historyInfo.canRedo" @click="redoEditor"><Redo2 :size="14" /></button>
        <button class="ghost-button" type="button" @click="showCreate = true"><Plus :size="14" /> 新建</button>
        <button class="ghost-button" type="button" :disabled="!active || saving" @click="save()"><Save :size="14" /> {{ saving ? '保存中' : '保存' }}</button>
        <button v-if="rendering" class="ghost-button render-cancel" type="button" @click="cancelRender"><Square :size="13" /> 取消导出</button>
        <button class="primary-button" type="button" :disabled="!active || !visualClips.length || rendering || !engine?.available" @click="render">
          <Download :size="14" /> {{ rendering ? '正在导出' : '导出 MP4' }}
        </button>
      </div>
    </header>

    <div v-if="loading" class="editor-empty"><LoaderCircle class="spinning" :size="26" /><span>正在载入剪辑工程与真实素材…</span></div>
    <div v-else-if="!active" class="editor-empty">
      <Clapperboard :size="34" /><h3>还没有剪辑工程</h3><p>新建工程后，可自动装入本集权威视频；也可以从左侧素材库逐个加入。</p>
      <button class="primary-button" type="button" @click="showCreate = true"><Plus :size="15" /> 新建第一个工程</button>
    </div>
    <div v-else class="editor-body">
      <aside class="media-bin">
        <header><div><span>素材库</span><b>{{ filteredMedia.length }} / {{ mediaTotal }}</b></div><input v-model="mediaSearch" aria-label="搜索剪辑素材" placeholder="搜索镜头或文件" /></header>
        <div class="media-filter"><button :class="{ active: mediaKind === 'all' }" @click="mediaKind = 'all'">全部</button><button :class="{ active: mediaKind === 'video' }" @click="mediaKind = 'video'">视频</button><button :class="{ active: mediaKind === 'image' }" @click="mediaKind = 'image'">图片</button><button :class="{ active: mediaKind === 'audio' }" @click="mediaKind = 'audio'">音频</button></div>
        <div class="media-list">
          <article v-for="item in filteredMedia" :key="item.id" @mouseenter="ensureMediaPreview(item)" @mouseleave="clearMediaPreviewDemand">
            <figure><img v-if="item.waveformPath || item.thumbnailPath" :src="assetUrl(item.waveformPath || item.thumbnailPath!)" :alt="`${item.name} ${item.kind === 'audio' ? '波形' : '缩略图'}`" loading="lazy" decoding="async" /><span v-else><LoaderCircle v-if="previewLoading.has(item.artifactId)" class="spinning" :size="16" /><Music2 v-else-if="item.kind === 'audio'" :size="18" /><Film v-else :size="18" /></span><em>{{ item.kind.toUpperCase() }}</em></figure>
            <div><b>{{ item.name }}</b><small>{{ mediaMeta(item) }}</small><code>{{ item.path }}</code></div>
            <div class="media-actions"><button v-if="item.kind==='video'" type="button" :class="{ready:item.proxyPath}" :title="item.proxyPath?'剪辑代理已就绪':'生成最长边 1280 的本地剪辑代理'" :disabled="proxyLoading.has(item.artifactId)" @click="prepareProxy(item)"><LoaderCircle v-if="proxyLoading.has(item.artifactId)" class="spinning" :size="12" /><span v-else>P</span></button><button type="button" title="追加到主画面" @click="addMedia(item)"><Plus :size="15" /></button></div>
          </article>
          <p v-if="!filteredMedia.length" class="bin-empty">没有匹配的可解码素材</p>
          <button v-if="mediaNextCursor" class="media-load-more" type="button" :disabled="mediaPageLoading" @click="loadMedia(false)">{{ mediaPageLoading ? "读取中…" : "加载更多" }}</button>
        </div>
      </aside>

      <main class="editor-center">
        <section class="preview-deck">
          <div class="preview-stage">
            <div class="preview-frame" :style="previewAspect">
              <video v-if="previewClip && ['video','timeline'].includes(previewClip.kind) && clipPreviewPath(previewClip)" :key="`${previewClip.id}-${clipPreviewPath(previewClip)}`" ref="videoElement" class="preview-main" data-testid="preview-main-video" :data-dissolve-role="activeDissolve ? 'outgoing' : undefined" :src="assetUrl(clipPreviewPath(previewClip))" playsinline preload="auto" :style="mainPreviewStyle(previewClip, activeDissolve ? 1 - activeDissolve.progress : 1)" @loadedmetadata="onPreviewMediaLoaded(previewClip)" @error="onPreviewMediaError(previewClip, $event)"></video>
              <img v-else-if="previewClip?.kind === 'image'" class="preview-main" data-testid="preview-main-image" :src="assetUrl(previewClip.sourcePath!)" :alt="`${previewClip.name} 主预览`" decoding="async" :style="mainPreviewStyle(previewClip)" />
              <div v-else class="preview-empty"><Clapperboard :size="30" /><span>播放头当前位置没有画面</span></div>
              <video v-if="activeDissolve && clipPreviewPath(activeDissolve.incoming)" :key="`dissolve-${activeDissolve.incoming.id}-${clipPreviewPath(activeDissolve.incoming)}`" ref="incomingVideoElement" class="preview-main preview-transition-incoming" data-testid="preview-transition-incoming" :src="assetUrl(clipPreviewPath(activeDissolve.incoming))" playsinline muted preload="auto" :style="mainPreviewStyle(activeDissolve.incoming, activeDissolve.progress)" @loadedmetadata="syncPreview" @error="onPreviewMediaError(activeDissolve.incoming, $event)"></video>
              <template v-for="clip in activeOverlayClips" :key="clip.id">
                <video v-if="['video','timeline'].includes(clip.kind) && clipPreviewPath(clip)" :ref="(element) => setOverlayVideoElement(clip.id, element)" class="preview-overlay" :src="assetUrl(clipPreviewPath(clip))" playsinline preload="auto" :style="overlayPreviewStyle(clip)" @loadedmetadata="onPreviewMediaLoaded(clip)" @error="onPreviewMediaError(clip, $event)"></video>
                <img v-else-if="clip.kind === 'image'" class="preview-overlay" :src="assetUrl(clip.sourcePath!)" :alt="`${clip.name} 叠加预览`" decoding="async" :style="overlayPreviewStyle(clip)" />
              </template>
              <div v-if="activeSubtitle" class="preview-subtitle" :style="{ color: activeSubtitle.fontColor || '#fff', fontSize: `${Math.max(12, (activeSubtitle.fontSize || 48) * previewScale)}px`, background: `${activeSubtitle.subtitleBackground || '#000'}b8` }">{{ activeSubtitle.text }}</div>
              <div class="preview-time">{{ timecode(playhead) }} / {{ timecode(totalDuration) }}</div>
            </div>
            <div class="preview-audio-host" aria-hidden="true">
              <audio v-for="clip in previewAudioClips" :key="clip.id" :ref="(element) => setAudioElement(clip.id, element)" :src="assetUrl(clipPreviewPath(clip))" preload="auto" @loadedmetadata="syncPreview"></audio>
            </div>
          </div>
          <div class="transport">
            <button type="button" title="回到开头" @click="seek(0)"><SkipBack :size="16" /></button>
            <button class="play" type="button" :aria-label="playing ? '暂停预览' : '播放预览'" @click="togglePlayback"><Pause v-if="playing" :size="18" /><Play v-else :size="18" /></button>
            <button type="button" title="跳到结尾" @click="seek(totalDuration)"><SkipForward :size="16" /></button>
            <input :value="playhead" type="range" min="0" :max="Math.max(totalDuration, frameDuration)" :step="frameDuration" @input="seek(Number(($event.target as HTMLInputElement).value))" />
            <span>{{ active.width }}×{{ active.height }} · {{ timebaseLabel }} · F{{ playheadFrame }}</span>
          </div>
        </section>

        <section class="timeline-deck">
          <header class="timeline-tools">
            <div><button type="button" @click="addOverlayTrack"><Layers3 :size="14" /> 画中画轨</button><button type="button" @click="addSubtitle"><Captions :size="14" /> 字幕</button><select v-model="selectedNestedProjectId" data-testid="nested-project-select" title="选择要冻结插入的子剪辑工程"><option value="">子时间线</option><option v-for="entry in availableNestedProjects" :key="entry.id" :value="entry.id">{{ entry.name }} · v{{ entry.revision }}</option></select><button type="button" data-testid="add-nested-timeline" :disabled="nestedAdding || !selectedNestedProjectId" @click="addNestedTimeline"><Layers3 :size="14" /> {{ nestedAdding ? '冻结中' : '插入子时间线' }}</button><button class="tool-emphasis" type="button" title="在播放头分割当前片段（⌘B）" :disabled="!canSplitSelected" @click="splitSelectedAtPlayhead"><Scissors :size="14" /> 分割</button><button class="danger" type="button" title="删除当前片段并收拢后续未锁定轨道（⇧⌫）" :disabled="!selectedClip" @click="rippleDeleteSelected"><Trash2 :size="14" /> Ripple 删除</button><button type="button" :disabled="extractingFrame" @click="extractCurrentFrame"><ImageDown :size="14" /> {{ extractingFrame ? '合成中' : '导出当前帧' }}</button><select v-model="continuationTargetId" title="选择要登记新首帧的下一个 15 秒单元"><option value="">续接目标</option><option v-for="item in continuationUnits" :key="item.id" :value="item.id">EP{{String(item.episode).padStart(2,'0')}}-{{String(item.unit).padStart(3,'0')}} {{item.title}}</option></select><button type="button" :disabled="preparingContinuation||!continuationTargetId" @click="prepareTimelineContinuation"><Link2 :size="14" /> {{preparingContinuation?'准备中':'末帧续视频'}}</button><button type="button" @click="importOtio"><FileUp :size="14" /> OTIO</button><button type="button" :disabled="!active" @click="exportOtio"><FileDown :size="14" /> OTIO</button><button type="button" :disabled="!selectedClip || selectedTrack?.kind !== 'visual' || selectedTrack?.order !== 0" @click="moveClip(-1)"><ChevronLeft :size="14" /> 前移</button><button type="button" :disabled="!selectedClip || selectedTrack?.kind !== 'visual' || selectedTrack?.order !== 0" @click="moveClip(1)">后移 <ChevronRight :size="14" /></button><button type="button" :disabled="!selectedClip" @click="removeClip"><X :size="14" /> 普通移除</button></div>
            <div class="timeline-scale"><span>拖动片段 · 边缘裁切 · 自动吸附</span><label>缩放 <input v-model.number="pixelsPerSecond" type="range" min="24" max="120" step="4" /></label></div>
          </header>
          <div ref="timelineScrollElement" class="timeline-scroll" @scroll.passive="onTimelineScroll">
            <div class="timeline-surface" :style="timelineWidth" @click="onTimelineClick">
              <div class="ruler">
                <span v-for="tick in rulerTicks" :key="tick" :style="{ left: `${tick * pixelsPerSecond}px` }">{{ tick }}s</span>
              </div>
              <div class="playhead" :style="{ left: `${playhead * pixelsPerSecond}px` }"><i></i></div>
              <div v-if="snapGuideTime !== null" class="snap-guide" :style="{ left: `${108 + snapGuideTime * pixelsPerSecond}px` }"><span>{{ timecode(snapGuideTime) }}</span></div>
              <div v-for="track in active.tracks" :key="track.id" class="track-row">
                <header :class="{ selected: track.id === selectedTrackId }" @click.stop="selectedTrackId = track.id"><span>{{ track.kind === 'visual' ? (track.order === 0 ? 'V' : 'P') : track.kind === 'audio' ? 'A' : 'T' }}</span><div><b>{{ track.name }}</b><small>{{ track.clips.length }} clips</small></div><button v-if="track.kind === 'visual' && track.order > 0 && !track.clips.length" type="button" title="删除空叠加轨" @click.stop="removeTrack(track.id)"><X :size="11" /></button></header>
                <div class="track-lane">
                  <button
                    v-for="clip in visibleTrackClips(track)"
                    :key="clip.id"
                    type="button"
                    :class="['timeline-clip', clip.kind, { selected: clip.id === selectedClipId, dragging: timelineGesture?.clipId === clip.id, locked: track.locked }]"
                    :data-testid="`timeline-clip-${clip.id}`"
                    :style="clipStyle(clip)"
                    :title="track.locked ? '轨道已锁定' : '拖动片段；拖动两侧边缘裁切'"
                    @click.stop="onClipClick(clip.id)"
                    @pointerdown="beginTimelineGesture($event, track.id, clip.id, 'move')">
                    <i v-if="track.id !== visualTrack?.id" class="trim-handle trim-start" role="separator" aria-label="裁切片段起点" :data-testid="`trim-start-${clip.id}`" @pointerdown.stop.prevent="beginTimelineGesture($event, track.id, clip.id, 'trim-start')"></i>
                    <span>{{ clip.kind === 'timeline' ? 'NESTED' : clip.kind.toUpperCase() }}</span><b>{{ clip.name }}</b><small>{{ clipDurationFrames(clip) }}f · {{ clip.durationSeconds.toFixed(3) }}s</small>
                    <i class="trim-handle trim-end" role="separator" aria-label="裁切片段终点" :data-testid="`trim-end-${clip.id}`" @pointerdown.stop.prevent="beginTimelineGesture($event, track.id, clip.id, 'trim-end')"></i>
                  </button>
                  <p v-if="!track.clips.length">{{ track.kind === 'visual' ? '从素材库追加画面' : track.kind === 'audio' ? '音频轨道已预留' : '字幕轨道已预留' }}</p>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <aside class="clip-inspector">
        <header><span>工程与片段</span><b>{{ active.name }}</b><small>修订 v{{ active.revision }} · {{ totalDurationFrames }} 帧 · {{ totalDuration.toFixed(3) }} 秒</small></header>
        <section class="project-fields">
          <label><span>工程名称</span><input v-model="active.name" maxlength="100" /></label>
          <div><label><span>宽</span><input v-model.number="active.width" type="number" min="256" max="7680" /></label><label><span>高</span><input v-model.number="active.height" type="number" min="256" max="7680" /></label></div>
          <label><span>帧率</span><select v-model.number="active.fps"><option :value="23.976">23.976 fps</option><option :value="24">24 fps</option><option :value="25">25 fps</option><option :value="29.97">29.97 fps</option><option :value="30">30 fps</option><option :value="50">50 fps</option><option :value="59.94">59.94 fps</option><option :value="60">60 fps</option></select></label>
        </section>
        <section v-if="selectedClip" class="selected-fields">
          <div class="inspector-label">当前片段</div><h3>{{ selectedClip.name }}</h3><code>{{ selectedClip.kind === 'timeline' ? `${selectedClip.nestedTimeline?.childEditProjectId} · 冻结 v${selectedClip.nestedTimeline?.childEditProjectRevision}` : selectedClip.sourcePath }}</code>
          <div v-if="selectedClip.kind === 'timeline'" class="nested-inspector" data-testid="nested-timeline-inspector"><small>快照 {{ selectedClip.nestedTimeline?.childSnapshotSha256.slice(0,12) }} · {{ selectedClip.nestedTimeline?.childTimebase.rateNumerator }}/{{ selectedClip.nestedTimeline?.childTimebase.rateDenominator }}</small><small v-if="nestedPreviewErrors.get(selectedClip.id)" role="alert">{{ nestedPreviewErrors.get(selectedClip.id) }}</small><button type="button" data-testid="refresh-nested-timeline" :disabled="nestedAdding" @click="refreshNestedTimeline">显式刷新到子工程当前修订</button></div>
          <label><span>成片时长 · {{ clipDurationFrames(selectedClip) }} 帧</span><input v-model.number="selectedClip.durationSeconds" type="number" :min="frameDuration" :max="MAX_EDIT_TIMELINE_SECONDS" :step="frameDuration" @change="normalizeSelectedClipTiming" /></label>
          <label v-if="['video','audio'].includes(selectedClip.kind)"><span>源片裁切起点 · F{{ clipTrimStartFrame(selectedClip) }}</span><input v-model.number="selectedClip.trimStartSeconds" type="number" min="0" :step="frameDuration" @change="normalizeSelectedClipTiming" /></label>
          <label v-if="['video','audio'].includes(selectedClip.kind)"><span>播放速率</span><input v-model.number="selectedClip.playbackRate" data-testid="edit-playback-rate" type="number" min="0.1" max="8" step="0.1" :disabled="clipParticipatesInDissolve(selectedClip)" /></label>
          <template v-if="selectedClip.kind === 'audio'">
            <label><span>音量（0–4）</span><input v-model.number="selectedClip.volume" type="number" min="0" max="4" step="0.05" /></label>
            <div class="inline-fields"><label><span>淡入</span><input v-model.number="selectedClip.fadeInSeconds" type="number" min="0" step="0.1" /></label><label><span>淡出</span><input v-model.number="selectedClip.fadeOutSeconds" type="number" min="0" step="0.1" /></label></div>
          </template>
          <template v-if="['video','image','timeline'].includes(selectedClip.kind)">
            <label><span>画面滤镜</span><select v-model="selectedClip.filter" data-testid="edit-filter-select"><option value="none">无</option><option value="grayscale">黑白</option><option value="sepia">复古棕</option><option value="warm">暖色</option><option value="cool">冷色</option><option value="vivid">鲜艳</option><option value="contrast">高对比</option><option value="blur">模糊</option></select></label>
            <label v-if="selectedClip.filter && selectedClip.filter !== 'none'"><span>滤镜强度（0–2）</span><input v-model.number="selectedClip.filterIntensity" type="number" min="0" max="2" step="0.1" /></label>
            <label v-if="selectedTrack?.id === visualTrack?.id"><span>片尾转场</span><select :value="selectedClip.transitionOut" data-testid="edit-transition-select" @change="changeSelectedTransition"><option value="cut">硬切</option><option value="fade">淡到背景（AI Canvas）</option><option v-if="selectedClip.kind === 'video'" value="smpte_dissolve" :disabled="Boolean(selectedDissolveEligibility.issue) && selectedClip.transitionOut !== 'smpte_dissolve'">SMPTE Dissolve（OTIO）</option></select></label>
            <label v-if="selectedTrack?.id === visualTrack?.id && selectedClip.transitionOut === 'fade'"><span>淡到背景时长</span><input v-model.number="selectedClip.transitionDurationSeconds" type="number" min="0.1" max="3" step="0.1" /></label>
            <div v-if="selectedTrack?.id === visualTrack?.id && selectedClip.transitionOut === 'smpte_dissolve' && selectedClip.transition" class="dissolve-fields" data-testid="edit-dissolve-fields">
              <div class="inline-fields"><label><span>切点前 in offset（帧）</span><input v-model.number="selectedClip.transition.inOffsetFrames" data-testid="edit-transition-in-offset" type="number" min="1" :max="Math.max(1, selectedDissolveEligibility.maxInFrames)" step="1" @change="normalizeSelectedDissolve" /></label><label><span>切点后 out offset（帧）</span><input v-model.number="selectedClip.transition.outOffsetFrames" data-testid="edit-transition-out-offset" type="number" min="1" :max="Math.max(1, selectedDissolveEligibility.maxOutFrames)" step="1" @change="normalizeSelectedDissolve" /></label></div>
              <small>目标：{{ selectedDissolveEligibility.target?.name }} · 上限 {{ selectedDissolveEligibility.maxInFrames }}/{{ selectedDissolveEligibility.maxOutFrames }} 帧 · 视觉转场不改变独立音轨时域</small>
            </div>
            <small v-else-if="selectedTrack?.id === visualTrack?.id && selectedClip.kind === 'video' && selectedDissolveEligibility.issue" class="dissolve-issue" data-testid="edit-transition-issue">{{ selectedDissolveEligibility.issue }}</small>
          </template>
          <template v-if="selectedTrack?.kind === 'visual' && ['video','image','timeline'].includes(selectedClip.kind)">
            <div class="inspector-label transform-label" data-testid="visual-transform-inspector">{{ selectedTrack.id === visualTrack?.id ? '主画面变换' : '画中画变换' }}</div>
            <div class="inline-fields"><label><span>水平 X</span><input v-model.number="selectedClip.positionX" data-testid="visual-transform-x" type="number" step="10" /></label><label><span>垂直 Y</span><input v-model.number="selectedClip.positionY" data-testid="visual-transform-y" type="number" step="10" /></label></div>
            <div class="inline-fields"><label><span>缩放</span><input v-model.number="selectedClip.scale" data-testid="visual-transform-scale" type="number" min="0.02" max="4" step="0.05" /></label><label><span>旋转</span><input v-model.number="selectedClip.rotation" data-testid="visual-transform-rotation" type="number" step="1" /></label></div>
            <label><span>透明度</span><input v-model.number="selectedClip.opacity" data-testid="visual-transform-opacity" type="number" min="0" max="1" step="0.05" /></label>
            <button class="keyframe-add" data-testid="visual-transform-add-keyframe" type="button" :disabled="clipParticipatesInDissolve(selectedClip)" @click="addKeyframe"><DiamondPlus :size="14" /> 在播放头添加关键帧</button>
            <div v-if="selectedClip.keyframes?.length" class="keyframe-list">
              <article v-for="keyframe in selectedClip.keyframes" :key="keyframe.id" :data-testid="`keyframe-row-${keyframe.id}`">
                <div class="keyframe-summary">
                  <button type="button" :aria-label="`跳转到关键帧 F${keyframeFrame(keyframe)}`" @click="seek(selectedClip.startSeconds + keyframe.timeSeconds)">F{{ keyframeFrame(keyframe) }}</button>
                  <span>{{ timecode(keyframe.timeSeconds) }} · X {{ keyframe.positionX }} · Y {{ keyframe.positionY }} · {{ keyframe.scale }}× · {{ keyframe.rotation }}°</span>
                  <select v-model="keyframe.easing" :aria-label="`关键帧 F${keyframeFrame(keyframe)} 缓动曲线`" title="目标关键帧控制进入它的区间" :disabled="isDerivedKeyframe(keyframe)" @change="changeKeyframeEasing(keyframe)"><option value="linear">线性</option><option value="ease_in">渐快</option><option value="ease_out">渐慢</option><option value="ease_in_out">平滑</option><option value="hold">保持</option><option value="cubic_bezier">自定义贝塞尔</option></select>
                  <button type="button" :aria-label="`删除关键帧 F${keyframeFrame(keyframe)}`" @click="removeKeyframe(keyframe.id)"><X :size="11" /></button>
                </div>
                <div v-if="keyframe.easing === 'cubic_bezier'" class="bezier-editor" :data-testid="`bezier-editor-${keyframe.id}`">
                  <svg viewBox="0 0 100 100" role="img" :aria-label="`关键帧 F${keyframeFrame(keyframe)} cubic-bezier 曲线`">
                    <path class="bezier-diagonal" d="M8 92 L92 8" />
                    <path v-if="!isDerivedKeyframe(keyframe)" class="bezier-handle" :d="keyframeBezierHandles(keyframe)" />
                    <path class="bezier-curve" :d="keyframeBezierPath(keyframe)" />
                    <circle class="bezier-anchor" cx="8" cy="92" r="2" /><circle class="bezier-anchor" cx="92" cy="8" r="2" />
                    <circle v-if="!isDerivedKeyframe(keyframe)" class="bezier-control" :cx="keyframeBezierPoint(keyframe, 'x1')" :cy="keyframeBezierPoint(keyframe, 'y1', true)" r="3" />
                    <circle v-if="!isDerivedKeyframe(keyframe)" class="bezier-control" :cx="keyframeBezierPoint(keyframe, 'x2')" :cy="keyframeBezierPoint(keyframe, 'y2', true)" r="3" />
                  </svg>
                  <div class="bezier-fields">
                    <label v-for="coordinate in bezierCoordinates" :key="coordinate"><span>{{ coordinate }}</span><input :aria-label="`关键帧 F${keyframeFrame(keyframe)} ${coordinate}`" :data-testid="`bezier-${keyframe.id}-${coordinate}`" :value="keyframe.bezier?.[coordinate]" type="number" :min="isDerivedKeyframe(keyframe) ? undefined : 0" :max="isDerivedKeyframe(keyframe) ? undefined : 1" :step="isDerivedKeyframe(keyframe) ? 0.000001 : 0.01" :disabled="isDerivedKeyframe(keyframe)" @input="updateKeyframeBezier(keyframe, coordinate, $event)" /></label>
                  </div>
                  <code>{{ keyframeBezierLabel(keyframe) }}</code>
                  <small v-if="keyframeCurveIssue(keyframe)" role="alert">{{ keyframeCurveIssue(keyframe) }}</small>
                  <small v-else-if="isDerivedKeyframe(keyframe)">分段保真派生曲线 · 原曲线帧窗口为求值事实 · 控制点只读</small>
                  <small v-else>目标关键帧控制入段 · 用户控制点限定 0–1 · 不允许 overshoot</small>
                </div>
              </article>
            </div>
          </template>
          <template v-if="selectedClip.kind === 'subtitle'">
            <label><span>字幕正文</span><textarea v-model="selectedClip.text" rows="5" maxlength="2000"></textarea></label>
            <label><span>导出字号</span><input v-model.number="selectedClip.fontSize" type="number" min="12" max="200" /></label>
          </template>
          <label><span>备注</span><textarea v-model="selectedClip.note" rows="4" maxlength="2000"></textarea></label>
          <button v-if="selectedClip.sourcePath" type="button" @click="reveal(selectedClip.sourcePath)"><FolderOpen :size="14" /> 在 Finder 中定位</button>
        </section>
        <section v-else class="no-selection"><MousePointer2 :size="24" /><span>选择时间线片段后调整裁切与时长</span></section>
        <section v-if="latestRender" class="render-card" :class="latestRender.status">
          <span>最近导出 · {{ latestRender.status }}<template v-if="latestRender.status === 'running'"> · {{ Math.round(latestRender.progress * 100) }}%</template></span><b>{{ latestRender.outputPath }}</b>
          <progress v-if="latestRender.status === 'running'" :value="latestRender.progress" max="1"></progress>
          <button v-if="latestRender.status === 'succeeded'" type="button" @click="reveal(latestRender.outputPath)"><FolderOpen :size="13" /> 定位成片</button>
          <small v-else-if="latestRender.error">{{ latestRender.error }}</small>
        </section>
      </aside>
    </div>

    <div v-if="editorRecovery" class="editor-modal recovery-modal">
      <section>
        <header><div><span class="eyebrow">异常退出恢复</span><h2>选择剪辑工程修订</h2></div><AlertTriangle :size="20" /></header>
        <div class="recovery-summary">
          <p>检测到上次导演剪辑台没有正常关闭。应用不会替你猜测，请明确选择要继续的修订。</p>
          <dl><div><dt>工程</dt><dd>{{ editorRecovery.projectName }}</dd></div><div><dt>最新修订</dt><dd>v{{ editorRecovery.latestRevision }}</dd></div><div><dt>稳定修订</dt><dd>{{ editorRecovery.stableRevision ? `v${editorRecovery.stableRevision}` : '无记录' }}</dd></div><div><dt>中断时间</dt><dd>{{ recoveryTime(editorRecovery.interruptedAt) }}</dd></div></dl>
          <div v-if="editorRecovery.incompleteRenderIds.length" class="recovery-renders"><span>上次未完成导出</span><code v-for="renderId in editorRecovery.incompleteRenderIds" :key="renderId">{{ renderId }}</code></div>
          <small>恢复稳定修订会从现有 editor history 创建一个新的更高修订，不覆盖最新文件。</small>
        </div>
        <footer><button class="ghost-button" type="button" :disabled="resolvingRecovery || !editorRecovery.stableAvailable" @click="resolveRecovery('stable')"><ShieldCheck :size="14" /> {{ editorRecovery.stableAvailable ? `恢复稳定修订 v${editorRecovery.stableRevision}` : '没有可用的更早稳定修订' }}</button><button class="primary-button" type="button" :disabled="resolvingRecovery" @click="resolveRecovery('latest')"><Clock3 :size="14" /> {{ resolvingRecovery ? '正在打开' : `打开最新修订 v${editorRecovery.latestRevision}` }}</button></footer>
      </section>
    </div>

    <div v-if="showCreate" class="editor-modal" @click.self="showCreate = false">
      <section>
        <header><div><span class="eyebrow">新建剪辑工程</span><h2>建立成片时间线</h2></div><button type="button" aria-label="关闭新建剪辑工程" @click="showCreate = false"><X :size="16" /></button></header>
        <label><span>工程名称</span><input v-model="draft.name" placeholder="例如：EP01 成片" /></label>
        <label><span>分集范围</span><select v-model="draft.episode"><option value="">全项目</option><option v-for="episode in episodes" :key="episode" :value="String(episode)">EP{{ String(episode).padStart(2, '0') }}</option></select></label>
        <div class="modal-grid"><label><span>宽</span><input v-model.number="draft.width" type="number" min="256" max="7680" /></label><label><span>高</span><input v-model.number="draft.height" type="number" min="256" max="7680" /></label><label><span>帧率</span><input v-model.number="draft.fps" type="number" min="12" max="120" step="0.001" /></label></div>
        <label class="check"><input v-model="draft.autoPopulate" type="checkbox" /><span>自动装入本范围内的权威视频；若没有视频则装入权威图片</span></label>
        <footer><button class="ghost-button" type="button" @click="showCreate = false">取消</button><button class="primary-button" type="button" :disabled="creating" @click="createProject"><Plus :size="14" /> {{ creating ? '创建中' : '创建工程' }}</button></footer>
      </section>
    </div>
  </section>
</template>

<script lang="ts">
export type VideoEditorLeaveReason = "edit_project_switch" | "history_navigation" | "module_switch" | "project_switch" | "window_close" | "workspace_switch";
export type VideoEditorLeaveResult = "proceed" | "cancelled";

export interface VideoEditorExpose {
  requestLeave: (reason: VideoEditorLeaveReason) => Promise<VideoEditorLeaveResult>;
}
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, toRaw, watch } from "vue";
import { AlertTriangle, Captions, ChevronLeft, ChevronRight, Clapperboard, Clock3, DiamondPlus, Download, FileDown, FileUp, Film, FolderOpen, ImageDown, Layers3, Link2, LoaderCircle, MousePointer2, Music2, Pause, Play, Plus, Redo2, Save, Scissors, ShieldCheck, SkipBack, SkipForward, Square, Trash2, Undo2, X } from "lucide-vue-next";
import type { EditClip, EditMediaItem, EditMediaPage, EditMediaQuery, EditNestedTimelinePreview, EditProject, EditRenderJob, EditorRecoveryInfo, ProjectIndex, VideoEngineInfo } from "@core/types";
import type { EditOperation } from "@core/editor";
import { MAX_EDIT_TIMELINE_SECONDS } from "@core/editor-limits";
import { DEFAULT_EDIT_CUBIC_BEZIER, editKeyframeCurveIssue, editKeyframeSourceTransformIssue, evaluateEditKeyframeEasing, evaluateEditKeyframeEasingAtFrame, evaluateEditTransformAtFrame } from "@core/keyframe-curve";
import { assetUrl } from "../utils";
import { calculateTimelineMove, calculateTimelineTrimEnd, calculateTimelineTrimStart, quantizeTimelineTime, timelineFrameForSeconds, timelineFrameRate, timelineReorderIndex, timelineSecondsForFrame } from "../timeline-interaction";
import { syncTimelineMedia } from "../timeline-preview";
import {
  captureVideoEditorDraftBaseline,
  createLatestVideoEditorMediaLoader,
  createVideoEditorLoadGate,
  hasUnsavedVideoEditorDraft,
  type VideoEditorLoadToken,
} from "../video-editor-dirty-state";
import { LatestBoundedTaskQueue } from "../bounded-task-queue";
import { collectVideoEditorNestedPreviewIds, KeyedPreviewCoordinator, ReferenceCountedPreviewSuspension } from "../video-editor-preview-coordinator";
import { createVideoEditorPreviewSyncScheduler } from "../video-editor-preview-sync";

type TimelineGestureMode = "move" | "trim-start" | "trim-end";
type EditorKeyframe = NonNullable<EditClip["keyframes"]>[number];
type BezierCoordinate = "x1" | "y1" | "x2" | "y2";
const bezierCoordinates: readonly BezierCoordinate[] = ["x1", "y1", "x2", "y2"];
interface TimelineGesture {
  mode: TimelineGestureMode;
  pointerId: number;
  trackId: string;
  clipId: string;
  startClientX: number;
  initialStart: number;
  initialDuration: number;
  initialTrimStart: number;
  playbackRate: number;
  baseTrack: boolean;
  initialTrackClips: EditClip[];
  moved: boolean;
  previewDeltaPx: number;
}
interface ActiveDissolvePreview {
  outgoing: EditClip;
  incoming: EditClip;
  startFrame: number;
  endFrame: number;
  progress: number;
}
interface DissolveEligibility {
  target?: EditClip;
  maxInFrames: number;
  maxOutFrames: number;
  issue?: string;
}
interface NestedPreviewScope {
  projectRoot: string;
  projectId: string;
  revision: number;
}
interface MediaPreviewScope {
  projectRoot: string;
  scanId: string;
  scannedAt: string;
  pageGeneration: number;
  queryFingerprint: string;
  artifactIds: Set<string>;
}

const props = defineProps<{ projectRoot: string; index: ProjectIndex }>();
const emit = defineEmits<{ changed: [message: string]; failed: [message: string] }>();
const projects = ref<EditProject[]>([]);
const active = ref<EditProject | null>(null);
const persistedProjectBaseline = ref("");
const activeProjectId = ref("");
const editorSessionId = ref("");
const editorRecovery = ref<EditorRecoveryInfo | null>(null);
const resolvingRecovery = ref(false);
const media = ref<EditMediaItem[]>([]);
const mediaTotal = ref(0);
const mediaNextCursor = ref<string | undefined>();
const mediaPageLoading = ref(false);
const engine = ref<VideoEngineInfo | null>(null);
const renders = ref<EditRenderJob[]>([]);
const selectedClipId = ref("");
const selectedTrackId = ref("");
const playhead = ref(0);
const playing = ref(false);
const pixelsPerSecond = ref(48);
const timelineGesture = ref<TimelineGesture | null>(null);
const snapGuideTime = ref<number | null>(null);
const mediaSearch = ref("");
const mediaKind = ref<"all" | "video" | "image" | "audio">("all");
const loading = ref(true);
const saving = ref(false);
const rendering = ref(false);
const activeRenderId = ref("");
const extractingFrame = ref(false);
const preparingContinuation = ref(false);
const nestedAdding = ref(false);
const selectedNestedProjectId = ref("");
const continuationTargetId = ref("");
const creating = ref(false);
const showCreate = ref(false);
const videoElement = ref<HTMLVideoElement | null>(null);
const incomingVideoElement = ref<HTMLVideoElement | null>(null);
const timelineScrollElement = ref<HTMLDivElement | null>(null);
const timelineScrollLeft = ref(0);
const timelineViewportWidth = ref(900);
const overlayVideoElements = new Map<string, HTMLVideoElement>();
const audioElements = new Map<string, HTMLAudioElement>();
const previewLoading = reactive(new Set<string>());
const proxyLoading = reactive(new Set<string>());
const nestedPreviews = reactive(new Map<string, EditNestedTimelinePreview>());
const nestedPreviewErrors = reactive(new Map<string, string>());
const draft = reactive({ name: "", episode: "", width: 1080, height: 1920, fps: 24, autoPopulate: true });
const historyInfo = reactive({ canUndo: false, canRedo: false, pastCount: 0, futureCount: 0 });
let playbackTimer: ReturnType<typeof setInterval> | null = null;
let suppressClipClick = false;
const editorLoadGate = createVideoEditorLoadGate();
interface MediaPageLoadInput {
  projectRoot: string;
  query: EditMediaQuery;
  append: boolean;
}
const mediaLoader = createLatestVideoEditorMediaLoader<EditMediaPage, MediaPageLoadInput>(
  (input) => window.canvasApi.listEditMediaPage(input.projectRoot, input.query),
  (page, input) => {
    if (props.projectRoot !== input.projectRoot) return;
    media.value = input.append
      ? [...new Map([...media.value, ...page.items].map((item) => [item.artifactId, item])).values()]
      : page.items;
    mediaTotal.value = page.total;
    mediaNextCursor.value = page.nextCursor;
    if (!previewWorkSuspended) activateMediaPreviewScope();
  },
);
let mediaPreviewScope: MediaPreviewScope | null = null;
let mediaPreviewPageGeneration = 0;
let previewWorkSuspended = false;
const sharedPreviewExecutionQueue = new LatestBoundedTaskQueue(2);
const nestedPreviewCoordinator = new KeyedPreviewCoordinator<string, EditNestedTimelinePreview, NestedPreviewScope>({
  execute: (clipId, scope) => window.canvasApi.prepareNestedTimelinePreview(scope.projectRoot, scope.projectId, scope.revision, clipId),
  onSuccess: (clipId, preview) => {
    nestedPreviews.set(clipId, preview);
    nestedPreviewErrors.delete(clipId);
    void nextTick(syncPreview);
  },
  onError: (clipId, error) => nestedPreviewErrors.set(clipId, message(error)),
  isEligible: (clipId, scope) => props.projectRoot === scope.projectRoot
    && active.value?.id === scope.projectId
    && active.value.revision === scope.revision
    && nestedPreviewWantedKeys().includes(clipId),
}, 2, sharedPreviewExecutionQueue);
const mediaPreviewCoordinator = new KeyedPreviewCoordinator<string, Partial<EditMediaItem>, MediaPreviewScope>({
  execute: (artifactId, scope) => window.canvasApi.prepareEditMediaPreview(scope.projectRoot, artifactId),
  onStart: (artifactId) => previewLoading.add(artifactId),
  onSuccess: (artifactId, preview) => {
    const current = media.value.find((entry) => entry.artifactId === artifactId);
    if (current) Object.assign(current, preview);
  },
  onError: (_artifactId, error) => emit("failed", message(error)),
  onSettled: (artifactId) => previewLoading.delete(artifactId),
  isEligible: (artifactId, scope) => mediaPreviewScope === scope
    && mediaPreviewScope.pageGeneration === scope.pageGeneration
    && props.projectRoot === scope.projectRoot
    && props.index.scanId === scope.scanId
    && props.index.scannedAt === scope.scannedAt
    && scope.queryFingerprint === mediaPreviewQueryFingerprint()
    && scope.artifactIds.has(artifactId)
    && media.value.some((entry) => entry.artifactId === artifactId),
}, 2, sharedPreviewExecutionQueue);
const previewWorkLease = new ReferenceCountedPreviewSuspension(
  async () => {
    previewWorkSuspended = true;
    invalidateNestedPreviews();
    mediaPreviewCoordinator.invalidate();
    mediaPreviewScope = null;
    previewLoading.clear();
    // 两个 coordinator 共用该物理队列：queued work 立即取消，至多等待两个 in-flight 自然收敛。
    sharedPreviewExecutionQueue.invalidate();
    await sharedPreviewExecutionQueue.whenIdle();
  },
  () => {
    previewWorkSuspended = false;
    if (media.value.length) activateMediaPreviewScope();
    activateNestedPreviews();
  },
);
let mountedProjectRoot = "";
let timelineResizeObserver: ResizeObserver | null = null;
let mediaSearchTimer: ReturnType<typeof setTimeout> | null = null;
let mediaLoadingSequence = 0;

const episodes = computed(() => [...new Set(props.index.items.map((item) => item.episode).filter((value): value is number => Boolean(value)))].sort((a, b) => a - b));
const continuationUnits = computed(() => props.index.items.filter((item) => item.type === "unit" && item.status !== "弃用").sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0) || (a.unit ?? 0) - (b.unit ?? 0)));
const availableNestedProjects = computed(() => projects.value.filter((entry) => entry.id !== active.value?.id));
const visualTracks = computed(() => active.value?.tracks.filter((track) => track.kind === "visual").sort((a, b) => a.order - b.order) ?? []);
const visualTrack = computed(() => visualTracks.value[0] ?? null);
const overlayVisualTracks = computed(() => visualTracks.value.slice(1).filter((track) => !track.hidden && !track.muted));
const visualClips = computed(() => visualTrack.value?.clips.slice().sort((a, b) => a.startSeconds - b.startSeconds) ?? []);
const visualClipById = computed(() => new Map(visualClips.value.map((clip) => [clip.id, clip])));
const mediaByArtifactId = computed(() => new Map(media.value.map((item) => [item.artifactId, item])));
const selectedClip = computed(() => active.value?.tracks.flatMap((track) => track.clips).find((clip) => clip.id === selectedClipId.value) ?? null);
const selectedTrack = computed(() => active.value?.tracks.find((track) => track.id === (selectedClip.value?.trackId ?? selectedTrackId.value)) ?? null);
const activeFrameRate = computed(() => active.value ? timelineFrameRate(active.value) : 24);
const frameDuration = computed(() => 1 / activeFrameRate.value);
const playheadFrame = computed(() => timelineFrameForSeconds(playhead.value, activeFrameRate.value));
const canSplitSelected = computed(() => Boolean(selectedClip.value && playheadFrame.value > clipStartFrame(selectedClip.value) && playheadFrame.value < clipEndFrame(selectedClip.value)));
const totalDurationFrames = computed(() => Math.min(
  Math.ceil(MAX_EDIT_TIMELINE_SECONDS * activeFrameRate.value),
  Math.max(0, ...visualClips.value.map(clipEndFrame)),
));
const totalDuration = computed(() => timelineSecondsForFrame(totalDurationFrames.value, activeFrameRate.value));
const timebaseLabel = computed(() => active.value?.timebase ? `${active.value.timebase.rateNumerator}/${active.value.timebase.rateDenominator}` : `${active.value?.fps ?? 24}fps`);
const activeDissolve = computed<ActiveDissolvePreview | null>(() => {
  if (!visualTrack.value || visualTrack.value.hidden || visualTrack.value.muted) return null;
  for (const outgoing of visualClips.value) {
    const transition = outgoing.transitionOut === "smpte_dissolve" ? outgoing.transition : undefined;
    if (!transition || outgoing.muted) continue;
    const incoming = visualClipById.value.get(transition.targetClipId);
    if (!incoming || incoming.muted) continue;
    const cutFrame = clipEndFrame(outgoing);
    const startFrame = cutFrame - transition.inOffsetFrames;
    const endFrame = cutFrame + transition.outOffsetFrames;
    if (playheadFrame.value < startFrame || playheadFrame.value >= endFrame) continue;
    const progress = Math.max(0, Math.min(1, (playheadFrame.value - startFrame) / Math.max(1, endFrame - startFrame)));
    return { outgoing, incoming, startFrame, endFrame, progress };
  }
  return null;
});
const previewClip = computed(() => {
  if (!visualTrack.value || visualTrack.value.hidden || visualTrack.value.muted) return null;
  return activeDissolve.value?.outgoing ?? visualClips.value.find((clip) => !clip.muted && clipActiveAtPlayhead(clip)) ?? null;
});
const selectedDissolveEligibility = computed<DissolveEligibility>(() => dissolveEligibility(selectedClip.value));
const activeSubtitle = computed(() => active.value?.tracks.filter((track) => track.kind === "subtitle" && !track.hidden && !track.muted).flatMap((track) => track.clips).find((clip) => !clip.muted && clipActiveAtPlayhead(clip)) ?? null);
const activeOverlayClips = computed(() => overlayVisualTracks.value.flatMap((track) => track.clips).filter((clip) => !clip.muted && clipActiveAtPlayhead(clip)));
const previewAudioClips = computed(() => active.value ? [
  ...active.value.tracks.filter((track) => track.kind === "audio" && !track.hidden && !track.muted).flatMap((track) => track.clips).filter((clip) => clip.kind === "audio" && Boolean(clip.sourcePath) && !clip.muted && clipActiveAtPlayhead(clip)),
] : []);
const previewScale = computed(() => Math.min(1, 360 * ((active.value?.width ?? 1080) / (active.value?.height ?? 1920)) / (active.value?.width ?? 1080)));
const previewAspect = computed(() => ({ aspectRatio: `${active.value?.width ?? 16} / ${active.value?.height ?? 9}`, backgroundColor: active.value?.backgroundColor ?? "#000000" }));
const filteredMedia = computed(() => media.value);
const timelineWidth = computed(() => ({ width: `${Math.max(900, totalDuration.value * pixelsPerSecond.value + 180)}px` }));
const visibleTimelineRange = computed(() => {
  const start = Math.max(0, (timelineScrollLeft.value - 108) / pixelsPerSecond.value - 5);
  const end = Math.min(MAX_EDIT_TIMELINE_SECONDS, (timelineScrollLeft.value + timelineViewportWidth.value) / pixelsPerSecond.value + 5);
  return { start, end };
});
const rulerTicks = computed(() => {
  const first = Math.max(0, Math.floor(visibleTimelineRange.value.start / 5) * 5);
  const last = Math.min(MAX_EDIT_TIMELINE_SECONDS, Math.ceil(visibleTimelineRange.value.end / 5) * 5);
  return Array.from({ length: Math.max(1, Math.floor((last - first) / 5) + 1) }, (_, index) => first + index * 5);
});
const timelineSnapPointCounts = computed(() => {
  const counts = new Map<number, number>();
  for (const track of active.value?.tracks ?? []) {
    if (track.hidden) continue;
    for (const clip of track.clips) {
      for (const point of [clip.startSeconds, clip.startSeconds + clip.durationSeconds]) {
        const value = quantizeTimelineTime(point, activeFrameRate.value);
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }
  }
  return counts;
});
const timelineSnapPoints = computed(() => [...timelineSnapPointCounts.value.keys()].sort((left, right) => left - right));
const latestRender = computed(() => renders.value.find((job) => job.editProjectId === active.value?.id) ?? null);
const hasUnsavedDraft = computed(() => hasUnsavedVideoEditorDraft(active.value, persistedProjectBaseline.value));

// 播放 tick 的 seek 与 post-flush watcher 共用同一调度 owner：同一刷新批次只执行一次 syncPreview。
const previewSyncScheduler = createVideoEditorPreviewSyncScheduler(syncPreview);
watch([previewClip, activeDissolve, activeOverlayClips], () => { void previewSyncScheduler.request(); }, { flush: "post" });
watch(() => active.value?.tracks.flatMap((track) => track.clips.map((clip) => [
  clip.id, clip.startSeconds, clip.durationSeconds, clip.trimStartSeconds, clip.playbackRate,
  clip.muted, clip.volume, clip.opacity, clip.positionX, clip.positionY, clip.scale, clip.rotation,
])).flat().join("|"), () => { void previewSyncScheduler.request(); }, { flush: "post" });
watch(
  () => [props.projectRoot, props.index.scanId, props.index.scannedAt] as const,
  () => {
    invalidateNestedPreviews();
    invalidateMediaPaging();
    void loadMedia(true).catch((error: unknown) => emit("failed", error instanceof Error ? error.message : String(error)));
  },
);
watch(mediaKind, () => {
  invalidateMediaPaging();
  void loadMedia(true).catch((error: unknown) => emit("failed", message(error)));
});
watch(mediaSearch, () => {
  invalidateMediaPaging();
  if (mediaSearchTimer) clearTimeout(mediaSearchTimer);
  mediaSearchTimer = setTimeout(() => {
    mediaSearchTimer = null;
    void loadMedia(true).catch((error: unknown) => emit("failed", message(error)));
  }, 250);
});
watch(() => nestedPreviewWantedKeys().join("|"), () => reconcileNestedPreviews(), { flush: "post" });
onMounted(() => {
  const token = editorLoadGate.begin(props.projectRoot);
  mountedProjectRoot = token.projectRoot;
  void load(token);
  window.addEventListener("keydown", onEditorShortcut);
  void nextTick(() => {
    syncTimelineViewport();
    if (timelineScrollElement.value && typeof ResizeObserver !== "undefined") {
      timelineResizeObserver = new ResizeObserver(syncTimelineViewport);
      timelineResizeObserver.observe(timelineScrollElement.value);
    }
  });
});
onBeforeUnmount(() => {
  editorLoadGate.invalidate();
  previewSyncScheduler.invalidate();
  mediaLoader.invalidate();
  if (mediaSearchTimer) clearTimeout(mediaSearchTimer);
  mediaSearchTimer = null;
  openProjectSequence += 1;
  renderPollActive = false;
  stopPlayback();
  cancelTimelineGesture();
  overlayVideoElements.clear();
  audioElements.clear();
  nestedPreviewCoordinator.dispose();
  mediaPreviewCoordinator.dispose();
  sharedPreviewExecutionQueue.dispose();
  previewLoading.clear();
  timelineResizeObserver?.disconnect();
  timelineResizeObserver = null;
  window.removeEventListener("keydown", onEditorShortcut);
  const sessionId = editorSessionId.value;
  editorSessionId.value = "";
  if (sessionId) {
    void window.canvasApi.closeEditorSession(mountedProjectRoot || props.projectRoot, sessionId)
      .catch((error: unknown) => console.warn("[video-editor] 卸载时关闭 session 失败：", message(error)));
  }
});

function acceptPersistedProject(project: EditProject): void {
  hydrateVisualClips(project);
  active.value = project;
  persistedProjectBaseline.value = captureVideoEditorDraftBaseline(project);
}

async function requestLeave(reason: VideoEditorLeaveReason): Promise<VideoEditorLeaveResult> {
  if (!hasUnsavedDraft.value) return "proceed";
  if (saving.value || nestedAdding.value || timelineGesture.value) {
    emit("failed", "剪辑工程仍在保存或处理操作，已取消离开；请稍候重试。");
    return "cancelled";
  }
  const action = reason === "window_close"
    ? "关闭应用"
    : reason === "module_switch"
      ? "离开导演剪辑台"
      : reason === "edit_project_switch"
        ? "切换剪辑工程"
        : reason === "history_navigation"
          ? "切换持久历史版本"
          : reason === "workspace_switch"
            ? "切换工作区"
            : "切换项目";
  return window.confirm(`当前剪辑工程有未保存修改。\n\n确定放弃这些修改并${action}吗？`)
    ? "proceed"
    : "cancelled";
}

defineExpose<VideoEditorExpose>({ requestLeave });

async function load(token: VideoEditorLoadToken) {
  loading.value = true;
  try {
    const session = await window.canvasApi.beginEditorSession(token.projectRoot);
    if (!editorLoadGate.isCurrent(token)) {
      await window.canvasApi.closeEditorSession(token.projectRoot, session.state.sessionId);
      return;
    }
    editorSessionId.value = session.state.sessionId;
    editorRecovery.value = session.recovery ?? null;
    const [nextProjects, nextEngine, nextRenders] = await Promise.all([
      window.canvasApi.listEditProjects(token.projectRoot),
      window.canvasApi.probeVideoEngine(),
      window.canvasApi.listEditRenderJobs(token.projectRoot),
      loadMedia(true, token.projectRoot),
    ]);
    if (!editorLoadGate.isCurrent(token)) return;
    projects.value = nextProjects;
    engine.value = nextEngine;
    renders.value = nextRenders;
    if (!editorRecovery.value && projects.value[0]) await openProject(projects.value[0].id);
  } catch (error) { if (editorLoadGate.isCurrent(token)) emit("failed", message(error)); }
  finally { if (editorLoadGate.isCurrent(token)) loading.value = false; }
}
async function loadMedia(reset = true, projectRoot = props.projectRoot): Promise<void> {
  if (!reset && (mediaPageLoading.value || !mediaNextCursor.value)) return;
  const cursor = reset ? undefined : mediaNextCursor.value;
  if (reset) mediaNextCursor.value = undefined;
  const sequence = ++mediaLoadingSequence;
  mediaPageLoading.value = true;
  try {
    await mediaLoader.load({
      projectRoot,
      append: !reset,
      query: {
        kind: mediaKind.value,
        search: mediaSearch.value,
        limit: 60,
        ...(cursor ? { cursor } : {}),
      },
    });
  } finally {
    if (sequence === mediaLoadingSequence) mediaPageLoading.value = false;
  }
}

function invalidateMediaPaging(): void {
  mediaLoader.invalidate();
  mediaPreviewCoordinator.invalidate();
  mediaPreviewScope = null;
  previewLoading.clear();
  mediaNextCursor.value = undefined;
  mediaLoadingSequence += 1;
  mediaPageLoading.value = false;
}
function mediaPreviewQueryFingerprint(): string {
  return `${mediaKind.value}\u0000${mediaSearch.value.trim().toLocaleLowerCase()}`;
}
function activateMediaPreviewScope(): void {
  const scope: MediaPreviewScope = {
    projectRoot: props.projectRoot,
    scanId: props.index.scanId,
    scannedAt: props.index.scannedAt,
    pageGeneration: ++mediaPreviewPageGeneration,
    queryFingerprint: mediaPreviewQueryFingerprint(),
    artifactIds: new Set(media.value.map((item) => item.artifactId)),
  };
  mediaPreviewScope = scope;
  previewLoading.clear();
  mediaPreviewCoordinator.activate(scope);
}
function invalidateNestedPreviews(): void {
  nestedPreviewCoordinator.invalidate();
  nestedPreviews.clear();
  nestedPreviewErrors.clear();
}
function activateNestedPreviews(): void {
  if (previewWorkSuspended) return;
  if (!active.value) { invalidateNestedPreviews(); return; }
  const scope: NestedPreviewScope = {
    projectRoot: props.projectRoot,
    projectId: active.value.id,
    revision: active.value.revision,
  };
  nestedPreviews.clear();
  nestedPreviewErrors.clear();
  nestedPreviewCoordinator.activate(scope);
  reconcileNestedPreviews();
}
function nestedPreviewWantedKeys(): string[] {
  if (!active.value) return [];
  return collectVideoEditorNestedPreviewIds({
    priorityClips: [
      selectedClip.value,
      previewClip.value,
      activeDissolve.value?.outgoing,
      activeDissolve.value?.incoming,
      ...activeOverlayClips.value,
    ],
    tracks: active.value.tracks,
    gestureClipId: timelineGesture.value?.clipId ?? "",
    visibleStart: visibleTimelineRange.value.start,
    visibleEnd: visibleTimelineRange.value.end,
  });
}
function reconcileNestedPreviews(): void {
  if (!active.value) return;
  nestedPreviewCoordinator.reconcile(nestedPreviewWantedKeys());
}

function syncTimelineViewport(): void {
  const element = timelineScrollElement.value;
  if (!element) return;
  timelineScrollLeft.value = element.scrollLeft;
  timelineViewportWidth.value = Math.max(1, element.clientWidth);
}

function onTimelineScroll(): void {
  syncTimelineViewport();
}

function visibleTrackClips(track: EditProject["tracks"][number]): EditClip[] {
  const { start, end } = visibleTimelineRange.value;
  const selectedId = selectedClipId.value;
  const gestureId = timelineGesture.value?.clipId;
  return track.clips.filter((clip) => clip.id === selectedId || clip.id === gestureId
    || (clip.startSeconds < end && clip.startSeconds + clip.durationSeconds > start));
}
function ensureMediaPreview(item: EditMediaItem): void {
  if (previewWorkSuspended) return;
  if ((item.kind === "audio" ? item.waveformPath : item.kind === "video" ? item.filmstripPath : item.thumbnailPath)) return;
  // hover 是 latest-demand：快速扫过一页时，只保留最后一个未启动需求。
  mediaPreviewCoordinator.reconcile([item.artifactId]);
}
function clearMediaPreviewDemand(): void {
  mediaPreviewCoordinator.reconcile([]);
}
async function suspendPreviewWork(): Promise<void> {
  await previewWorkLease.acquire();
}
function resumePreviewWork(): void {
  previewWorkLease.release();
}
async function prepareProxy(item: EditMediaItem) {
  if (item.kind !== "video" || proxyLoading.has(item.artifactId)) return;
  proxyLoading.add(item.artifactId);
  try {
    const preview = await window.canvasApi.prepareEditMediaProxy(props.projectRoot, item.artifactId);
    Object.assign(item, preview);
    await nextTick(syncPreview);
    emit("changed", `剪辑代理已就绪：${item.name}`);
  } catch (error) { emit("failed", message(error)); }
  finally { proxyLoading.delete(item.artifactId); }
}
let openProjectSequence = 0;
async function openProject(id: string): Promise<boolean> {
  // FE-02：代际守卫——快速连切工程时旧响应不得覆盖新工程（A→B 竞态）。
  const sequence = ++openProjectSequence;
  const isCurrent = () => sequence === openProjectSequence;
  invalidateNestedPreviews();
  if (!id) { active.value = null; persistedProjectBaseline.value = ""; return true; }
  try {
    const project = await window.canvasApi.getEditProject(props.projectRoot, id);
    if (!isCurrent()) return false;
    acceptPersistedProject(project);
    if (editorSessionId.value) await window.canvasApi.setEditorSessionProject(props.projectRoot, editorSessionId.value, id);
    if (!isCurrent()) return false;
    activeProjectId.value = id;
    selectedClipId.value = project.tracks.flatMap((track) => track.clips)[0]?.id ?? "";
    selectedTrackId.value = project.tracks[0]?.id ?? "";
    selectedNestedProjectId.value = projects.value.find((entry) => entry.id !== project.id)?.id ?? "";
    const sourceIds = new Set(project.tracks.flatMap((track) => track.clips).map((clip) => clip.itemId).filter(Boolean));
    const lastSourceIndex = Math.max(-1, ...continuationUnits.value.map((item, index) => sourceIds.has(item.id) ? index : -1));
    continuationTargetId.value = continuationUnits.value[lastSourceIndex + 1]?.id ?? continuationUnits.value.find((item) => !sourceIds.has(item.id))?.id ?? "";
    seek(0);
    const history = await window.canvasApi.getEditHistoryInfo(props.projectRoot, id);
    if (!isCurrent()) return false;
    Object.assign(historyInfo, history);
    activateNestedPreviews();
    return isCurrent();
  } catch (error) { if (isCurrent()) emit("failed", message(error)); return false; }
}
async function selectEditProject(id: string): Promise<void> {
  const currentId = active.value?.id ?? "";
  if (id === currentId) return;
  if (await requestLeave("edit_project_switch") !== "proceed") {
    activeProjectId.value = currentId;
    return;
  }
  const opened = await openProject(id);
  if (!opened && activeProjectId.value === id) activeProjectId.value = active.value?.id ?? currentId;
}
async function resolveRecovery(choice: "stable" | "latest") {
  if (!editorRecovery.value || !editorSessionId.value) return;
  resolvingRecovery.value = true;
  try {
    const result = await window.canvasApi.resolveEditorSessionRecovery(props.projectRoot, editorSessionId.value, choice);
    editorRecovery.value = null;
    projects.value = await window.canvasApi.listEditProjects(props.projectRoot);
    await openProject(result.project.id);
    emit("changed", choice === "stable" ? `已从稳定快照恢复为新修订 v${result.project.revision}` : `已打开最新修订 v${result.project.revision}`);
  } catch (error) { emit("failed", message(error)); }
  finally { resolvingRecovery.value = false; }
}
async function createProject() {
  if (await requestLeave("edit_project_switch") !== "proceed") return;
  creating.value = true;
  try {
    const project = await window.canvasApi.createEditProject(props.projectRoot, {
      name: draft.name || undefined,
      episode: draft.episode ? Number(draft.episode) : undefined,
      width: draft.width,
      height: draft.height,
      fps: draft.fps,
      autoPopulate: draft.autoPopulate,
    });
    projects.value = await window.canvasApi.listEditProjects(props.projectRoot);
    showCreate.value = false;
    await openProject(project.id);
    emit("changed", `已创建剪辑工程：${project.name}`);
  } catch (error) { emit("failed", message(error)); }
  finally { creating.value = false; }
}
function addMedia(item: EditMediaItem) {
  if (!active.value) return;
  const selected = active.value.tracks.find((entry) => entry.id === selectedTrackId.value);
  const track = item.kind === "audio"
    ? active.value.tracks.find((entry) => entry.kind === "audio")
    : selected?.kind === "visual" ? selected : active.value.tracks.find((entry) => entry.kind === "visual");
  if (!track) return;
  const requestedStart = track.kind === "visual" && track.order > 0
    ? Math.min(playhead.value, Math.max(0, totalDuration.value - .1))
    : track.clips.reduce((end, clip) => Math.max(end, clip.startSeconds + clip.durationSeconds), 0);
  const start = quantizeTimelineTime(requestedStart, activeFrameRate.value);
  const duration = quantizeTimelineTime(item.kind === "image" ? 5 : Math.max(frameDuration.value, item.durationSeconds ?? 5), activeFrameRate.value, frameDuration.value);
  const clip: EditClip = {
    id: `clip-${crypto.randomUUID()}`,
    trackId: track.id,
    kind: item.kind,
    name: item.name,
    sourcePath: item.path,
    artifactId: item.artifactId,
    itemId: item.itemId,
    sourceAvailableRange: ["video", "audio"].includes(item.kind) && item.durationSeconds
      ? { startFrame: 0, durationFrames: Math.max(1, Math.floor(item.durationSeconds * activeFrameRate.value + 1e-6)) }
      : undefined,
    startSeconds: start,
    durationSeconds: duration,
    trimStartSeconds: 0,
    playbackRate: 1,
    volume: 1,
    opacity: 1,
    muted: false,
    positionX: 0,
    positionY: 0,
    scale: track.kind === "visual" && track.order > 0 ? .35 : 1,
    rotation: 0,
    filter: "none",
    filterIntensity: 1,
    keyframes: [],
    transitionOut: item.kind === "audio" ? undefined : "cut",
    transitionDurationSeconds: item.kind === "audio" ? undefined : 0.5,
    fadeInSeconds: item.kind === "audio" ? 0 : undefined,
    fadeOutSeconds: item.kind === "audio" ? 0 : undefined,
  };
  track.clips.push(clip);
  track.clips.sort((a, b) => a.startSeconds - b.startSeconds);
  selectedTrackId.value = track.id;
  selectedClipId.value = clip.id;
  seek(clip.startSeconds);
}
function addSubtitle() {
  if (!active.value) return;
  const track = active.value.tracks.find((entry) => entry.kind === "subtitle");
  if (!track) return;
  const latestEnd = track.clips.reduce((end, clip) => Math.max(end, clip.startSeconds + clip.durationSeconds), 0);
  const start = quantizeTimelineTime(Math.max(playhead.value, latestEnd), activeFrameRate.value);
  const clip: EditClip = {
    id: `clip-${crypto.randomUUID()}`,
    trackId: track.id,
    kind: "subtitle",
    name: `字幕 ${track.clips.length + 1}`,
    startSeconds: start,
    durationSeconds: quantizeTimelineTime(Math.min(3, Math.max(.5, totalDuration.value - start || 3)), activeFrameRate.value, frameDuration.value),
    trimStartSeconds: 0,
    playbackRate: 1,
    volume: 1,
    opacity: 1,
    muted: false,
    text: "在这里输入字幕",
    fontSize: Math.max(28, Math.round(active.value.width * .046)),
    fontColor: "#ffffff",
    subtitleBackground: "#000000",
  };
  track.clips.push(clip);
  selectedClipId.value = clip.id;
  seek(clip.startSeconds);
}
async function addNestedTimeline() {
  if (!active.value || !selectedNestedProjectId.value || nestedAdding.value) return;
  const selectedChildId = selectedNestedProjectId.value;
  const selected = active.value.tracks.find((entry) => entry.id === selectedTrackId.value);
  const track = selected?.kind === "visual" ? selected : visualTrack.value;
  if (!track) return;
  const startFrame = track.order === 0 ? Math.max(0, ...track.clips.map(clipEndFrame)) : playheadFrame.value;
  nestedAdding.value = true;
  try {
    projects.value = await window.canvasApi.listEditProjects(props.projectRoot);
    const child = projects.value.find((entry) => entry.id === selectedChildId);
    if (!child) throw new Error("选择的子剪辑工程已缺失，请重新选择。");
    const result = await runAtomicEditOperation({ type: "add_nested_timeline", trackId: track.id, childEditProjectId: child.id, childExpectedRevision: child.revision, startFrame }, `已冻结插入子时间线 ${child.name}`);
    const createdId = result?.affectedClipIds[0];
    if (createdId) { selectedClipId.value = createdId; selectClip(createdId); }
  } finally { nestedAdding.value = false; }
}
async function refreshNestedTimeline() {
  const clip = selectedClip.value;
  if (!active.value || clip?.kind !== "timeline" || !clip.nestedTimeline || nestedAdding.value) return;
  const childId = clip.nestedTimeline.childEditProjectId;
  nestedAdding.value = true;
  try {
    const [freshProjects, persisted] = await Promise.all([
      window.canvasApi.listEditProjects(props.projectRoot),
      window.canvasApi.getEditProject(props.projectRoot, active.value.id),
    ]);
    projects.value = freshProjects;
    const child = freshProjects.find((entry) => entry.id === childId);
    if (!child) throw new Error("子剪辑工程已缺失，无法刷新嵌套时间线。");
    if (persisted.revision !== active.value.revision) throw new Error(`父剪辑工程已被其他窗口更新到 v${persisted.revision}；为避免覆盖，请重新载入后刷新。`);
    hydrateVisualClips(persisted);
    const draft = structuredClone(toRaw(active.value));
    if (JSON.stringify(draft) !== JSON.stringify(persisted)) throw new Error("父剪辑工程存在未保存改动；为避免丢失，已拒绝刷新。请先保存或重新载入后再试。");
    const result = await window.canvasApi.applyEditOperation(props.projectRoot, persisted.id, persisted.revision, { type: "refresh_nested_timeline", clipId: clip.id, childExpectedRevision: child.revision });
    acceptPersistedProject(result.project);
    projects.value = await window.canvasApi.listEditProjects(props.projectRoot);
    Object.assign(historyInfo, await window.canvasApi.getEditHistoryInfo(props.projectRoot, active.value.id));
    if (editorSessionId.value) await window.canvasApi.setEditorSessionProject(props.projectRoot, editorSessionId.value, active.value.id);
    activateNestedPreviews();
    emit("changed", `已显式刷新嵌套时间线到 ${child.name} v${child.revision}`);
  } catch (error) { emit("failed", message(error)); }
  finally { nestedAdding.value = false; }
}
function addOverlayTrack() {
  if (!active.value) return;
  const count = active.value.tracks.filter((track) => track.kind === "visual").length;
  const track = { id: `track-${crypto.randomUUID()}`, kind: "visual" as const, name: `画中画 ${count}`, order: count, locked: false, muted: false, hidden: false, clips: [] };
  const firstNonVisual = active.value.tracks.findIndex((entry) => entry.kind !== "visual");
  if (firstNonVisual < 0) active.value.tracks.push(track); else active.value.tracks.splice(firstNonVisual, 0, track);
  active.value.tracks.forEach((entry, order) => entry.order = order);
  selectedTrackId.value = track.id;
  selectedClipId.value = "";
}
function removeTrack(trackId: string) {
  if (!active.value) return;
  const track = active.value.tracks.find((entry) => entry.id === trackId);
  if (!track || track.kind !== "visual" || track.order === 0 || track.clips.length) return;
  active.value.tracks = active.value.tracks.filter((entry) => entry.id !== trackId);
  active.value.tracks.forEach((entry, order) => entry.order = order);
  selectedTrackId.value = active.value.tracks[0]?.id ?? "";
}
async function save(options: { scheduleNestedPreviews?: boolean } = {}) {
  if (!active.value) return false;
  await suspendPreviewWork();
  let previewLeaseHeld = true;
  let persisted = false;
  saving.value = true;
  try {
    reflowVisual();
    const revision = active.value.revision;
    const snapshot = structuredClone(toRaw(active.value));
    acceptPersistedProject(await window.canvasApi.saveEditProject(props.projectRoot, snapshot, revision));
    projects.value = await window.canvasApi.listEditProjects(props.projectRoot);
    activeProjectId.value = active.value.id;
    emit("changed", `剪辑工程已保存为修订 v${active.value.revision}`);
    Object.assign(historyInfo, await window.canvasApi.getEditHistoryInfo(props.projectRoot, active.value.id));
    if (editorSessionId.value) await window.canvasApi.setEditorSessionProject(props.projectRoot, editorSessionId.value, active.value.id);
    persisted = true;
    if (options.scheduleNestedPreviews !== false) {
      resumePreviewWork();
      previewLeaseHeld = false;
    }
    return true;
  } catch (error) { emit("failed", message(error)); return false; }
  finally {
    saving.value = false;
    // 前台操作的 false 由调用方 finally 恢复；保存失败不能把编辑器永久暂停。
    if (!persisted && previewLeaseHeld) resumePreviewWork();
  }
}
async function undoEditor() {
  if (!active.value || !historyInfo.canUndo) return;
  if (await requestLeave("history_navigation") !== "proceed") return;
  try { acceptPersistedProject(await window.canvasApi.undoEditProject(props.projectRoot, active.value.id, active.value.revision)); Object.assign(historyInfo, await window.canvasApi.getEditHistoryInfo(props.projectRoot, active.value.id)); if (editorSessionId.value) await window.canvasApi.setEditorSessionProject(props.projectRoot, editorSessionId.value, active.value.id); projects.value = await window.canvasApi.listEditProjects(props.projectRoot); activateNestedPreviews(); emit("changed", `已撤销到新修订 v${active.value.revision}`); }
  catch (error) { emit("failed", message(error)); }
}
async function redoEditor() {
  if (!active.value || !historyInfo.canRedo) return;
  if (await requestLeave("history_navigation") !== "proceed") return;
  try { acceptPersistedProject(await window.canvasApi.redoEditProject(props.projectRoot, active.value.id, active.value.revision)); Object.assign(historyInfo, await window.canvasApi.getEditHistoryInfo(props.projectRoot, active.value.id)); if (editorSessionId.value) await window.canvasApi.setEditorSessionProject(props.projectRoot, editorSessionId.value, active.value.id); projects.value = await window.canvasApi.listEditProjects(props.projectRoot); activateNestedPreviews(); emit("changed", `已重做到新修订 v${active.value.revision}`); }
  catch (error) { emit("failed", message(error)); }
}
async function exportOtio() {
  if (!active.value || !await save({ scheduleNestedPreviews: false })) return;
  try { const result = await window.canvasApi.exportEditOtio(props.projectRoot, active.value.id, active.value.revision); emit("changed", `OTIO 已导出：${result.path}`); await window.canvasApi.showInFolder(result.path); }
  catch (error) { emit("failed", message(error)); }
  finally { resumePreviewWork(); }
}
async function importOtio() {
  if (await requestLeave("edit_project_switch") !== "proceed") return;
  const filePath = await window.canvasApi.pickOtio();
  if (!filePath) return;
  try { const project = await window.canvasApi.importEditOtio(props.projectRoot, filePath); projects.value = await window.canvasApi.listEditProjects(props.projectRoot); await openProject(project.id); emit("changed", `OTIO 已导入为新工程：${project.name}`); }
  catch (error) { emit("failed", message(error)); }
}
function onEditorShortcut(event: KeyboardEvent) {
  if (["INPUT", "TEXTAREA", "SELECT"].includes((event.target as HTMLElement | null)?.tagName ?? "")) return;
  if (event.metaKey && event.key.toLowerCase() === "b") { event.preventDefault(); void splitSelectedAtPlayhead(); return; }
  if (event.shiftKey && event.key === "Backspace") { event.preventDefault(); void rippleDeleteSelected(); return; }
  if (event.metaKey && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) void redoEditor(); else void undoEditor(); }
}
async function render() {
  if (!active.value || !await save({ scheduleNestedPreviews: false })) return;
  rendering.value = true;
  renderPollActive = true;
  stopPlayback();
  const pollDeadline = Date.now() + 2 * 60 * 60 * 1_000;
  try {
    let result = await window.canvasApi.startEditRender(props.projectRoot, active.value.id, { expectedRevision: active.value.revision });
    activeRenderId.value = result.id;
    // FE-01：卸载/超时守卫——视图卸载即停轮询；job 异常滞留 running 时 2h 上限兜底，不形成死循环。
    while (result.status === "running" && renderPollActive && Date.now() < pollDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      result = await window.canvasApi.getEditRenderJob(props.projectRoot, result.id);
      renders.value = [result, ...renders.value.filter((job) => job.id !== result.id)];
    }
    if (result.status === "running") {
      if (!renderPollActive) return;
      throw new Error("导出超时：任务长时间未完成，请到任务列表核对状态后重试。");
    }
    if (result.status === "failed") throw new Error(result.error || "FFmpeg 导出失败");
    if (result.status === "cancelled") emit("changed", "成片导出已取消");
    else emit("changed", `成片已导出：${result.outputPath}`);
  } catch (error) { emit("failed", message(error)); }
  finally { rendering.value = false; activeRenderId.value = ""; resumePreviewWork(); }
}
let renderPollActive = false;
async function cancelRender() {
  if (!activeRenderId.value) return;
  try { await window.canvasApi.cancelEditRender(props.projectRoot, activeRenderId.value); }
  catch (error) { emit("failed", message(error)); }
}
async function extractCurrentFrame() {
  if (!active.value || !totalDuration.value || !await save({ scheduleNestedPreviews: false })) return;
  extractingFrame.value = true;
  try {
    const timeSeconds = Math.min(playhead.value, Math.max(0, totalDuration.value - frameDuration.value));
    const frame = await window.canvasApi.extractTimelineFrame(props.projectRoot, { editProjectId: active.value.id, expectedRevision: active.value.revision, timeSeconds });
    emit("changed", `已导出时间线合成帧：${frame.framePath}`);
    await window.canvasApi.showInFolder(frame.framePath);
  } catch (error) { emit("failed", message(error)); }
  finally { extractingFrame.value = false; resumePreviewWork(); }
}
async function prepareTimelineContinuation() {
  if (!active.value || !continuationTargetId.value || !await save({ scheduleNestedPreviews: false })) return;
  preparingContinuation.value = true;
  try {
    const result = await window.canvasApi.prepareTimelineContinuation(props.projectRoot, { editProjectId: active.value.id, targetItemId: continuationTargetId.value, expectedRevision: active.value.revision, enqueue: true });
    emit("changed", `时间线末帧已登记为续接首帧，视频任务已入队：${result.pack.id}`);
  } catch (error) { emit("failed", message(error)); }
  finally { preparingContinuation.value = false; resumePreviewWork(); }
}
function beginTimelineGesture(event: PointerEvent, trackId: string, clipId: string, mode: TimelineGestureMode) {
  if (event.button !== 0 || !active.value) return;
  const track = active.value.tracks.find((entry) => entry.id === trackId);
  const clip = track?.clips.find((entry) => entry.id === clipId);
  if (!track || !clip || track.locked || (mode === "trim-start" && track.id === visualTrack.value?.id)) return;
  event.preventDefault();
  event.stopPropagation();
  stopPlayback();
  selectedTrackId.value = trackId;
  selectedClipId.value = clipId;
  timelineGesture.value = {
    mode,
    pointerId: event.pointerId,
    trackId,
    clipId,
    startClientX: event.clientX,
    initialStart: clip.startSeconds,
    initialDuration: clip.durationSeconds,
    initialTrimStart: clip.trimStartSeconds,
    playbackRate: Math.max(.1, clip.playbackRate || 1),
    baseTrack: track.id === visualTrack.value?.id,
    initialTrackClips: structuredClone(toRaw(track.clips)),
    moved: false,
    previewDeltaPx: 0,
  };
  try { (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); } catch { /* Window 监听仍可完成拖动。 */ }
  window.addEventListener("pointermove", updateTimelineGesture);
  window.addEventListener("pointerup", finishTimelineGesture);
  window.addEventListener("pointercancel", restoreTimelineGesture);
}
function updateTimelineGesture(event: PointerEvent) {
  const gesture = timelineGesture.value;
  if (!gesture || event.pointerId !== gesture.pointerId || !active.value) return;
  const track = active.value.tracks.find((entry) => entry.id === gesture.trackId);
  const clip = track?.clips.find((entry) => entry.id === gesture.clipId);
  if (!track || !clip) { restoreTimelineGesture(); return; }
  const deltaPixels = event.clientX - gesture.startClientX;
  if (!gesture.moved && Math.abs(deltaPixels) < 2) return;
  event.preventDefault();
  gesture.moved = true;
  gesture.previewDeltaPx = deltaPixels;
  const deltaSeconds = deltaPixels / pixelsPerSecond.value;
  const threshold = Math.max(frameDuration.value, 7 / pixelsPerSecond.value);

  if (gesture.mode === "move") {
    if (gesture.baseTrack) { snapGuideTime.value = null; return; }
    const candidate = gesture.initialStart + deltaSeconds;
    const result = calculateTimelineMove({
      initialStart: gesture.initialStart,
      deltaSeconds,
      durationSeconds: gesture.initialDuration,
      totalDuration: totalDuration.value,
      snapTargets: timelineSnapTargets(gesture.clipId, candidate),
      snapThresholdSeconds: threshold,
      frameRate: activeFrameRate.value,
    });
    clip.startSeconds = result.value;
    snapGuideTime.value = result.snappedTo ?? null;
    return;
  }

  if (gesture.mode === "trim-start") {
    const trimDeltaSeconds = (clip.keyframes?.length ?? 0) > 0 ? Math.max(0, deltaSeconds) : deltaSeconds;
    const candidate = gesture.initialStart + trimDeltaSeconds;
    const patch = calculateTimelineTrimStart({
      initialStart: gesture.initialStart,
      initialDuration: gesture.initialDuration,
      initialTrimStart: gesture.initialTrimStart,
      playbackRate: gesture.playbackRate,
      deltaSeconds: trimDeltaSeconds,
      mediaCanTrim: ["video", "audio", "timeline"].includes(clip.kind),
      snapTargets: timelineSnapTargets(gesture.clipId, candidate),
      snapThresholdSeconds: threshold,
      frameRate: activeFrameRate.value,
    });
    clip.startSeconds = patch.startSeconds;
    clip.durationSeconds = patch.durationSeconds;
    clip.trimStartSeconds = patch.trimStartSeconds;
    snapGuideTime.value = patch.snappedTo ?? null;
    return;
  }

  const trimDeltaSeconds = (clip.keyframes?.length ?? 0) > 0 ? Math.min(0, deltaSeconds) : deltaSeconds;
  const candidateEnd = gesture.initialStart + gesture.initialDuration + trimDeltaSeconds;
  const sourceMaximumEnd = gesture.initialStart + maximumOutputDuration(clip, gesture.initialTrimStart, gesture.playbackRate);
  const maximumEnd = gesture.baseTrack ? sourceMaximumEnd : Math.min(totalDuration.value, sourceMaximumEnd);
  const patch = calculateTimelineTrimEnd({
    initialStart: gesture.initialStart,
    initialDuration: gesture.initialDuration,
    deltaSeconds: trimDeltaSeconds,
    maximumEnd,
    snapTargets: timelineSnapTargets(gesture.clipId, candidateEnd),
    snapThresholdSeconds: threshold,
    frameRate: activeFrameRate.value,
  });
  clip.durationSeconds = patch.durationSeconds;
  snapGuideTime.value = patch.snappedTo ?? null;
  if (gesture.baseTrack) reflowVisual();
}
function finishTimelineGesture(event?: PointerEvent) {
  const gesture = timelineGesture.value;
  if (!gesture || (event && event.pointerId !== gesture.pointerId)) return;
  const track = active.value?.tracks.find((entry) => entry.id === gesture.trackId);
  const clip = track?.clips.find((entry) => entry.id === gesture.clipId);
  if (gesture.moved && track && clip) {
    if (gesture.mode !== "move" && (clip.kind === "timeline" || (clip.keyframes?.length ?? 0) > 0)) {
      const side = gesture.mode === "trim-start" ? "start" : "end";
      const targetTime = quantizeTimelineTime(side === "start" ? clip.startSeconds : clip.startSeconds + clip.durationSeconds, activeFrameRate.value);
      const clipLabel = clip.kind === "timeline" ? "嵌套" : "关键帧";
      track.clips = structuredClone(toRaw(gesture.initialTrackClips));
      suppressClipClick = true;
      setTimeout(() => { suppressClipClick = false; }, 0);
      cancelTimelineGesture();
      void runAtomicEditOperation({ type: "trim_to_playhead", clipId: gesture.clipId, timeSeconds: targetTime, side }, `已将${clipLabel}片段${side === "start" ? "起点" : "终点"}裁切到 ${timecode(targetTime)}`).then((result) => {
        if (result) { selectedClipId.value = gesture.clipId; seek(targetTime); }
      });
      return;
    }
    if (gesture.mode === "move" && gesture.baseTrack) {
      const ordered = track.clips.slice().sort((a, b) => a.startSeconds - b.startSeconds);
      const dragged = ordered.find((entry) => entry.id === clip.id);
      const peers = ordered.filter((entry) => entry.id !== clip.id);
      if (dragged) {
        const center = gesture.initialStart + gesture.initialDuration / 2 + gesture.previewDeltaPx / pixelsPerSecond.value;
        const targetIndex = timelineReorderIndex(peers, center);
        peers.splice(targetIndex, 0, dragged);
        track.clips = peers;
        reflowVisual();
      }
    } else {
      track.clips.sort((a, b) => a.startSeconds - b.startSeconds);
    }
    suppressClipClick = true;
    setTimeout(() => { suppressClipClick = false; }, 0);
    void nextTick(syncPreview);
  }
  cancelTimelineGesture();
}
function cancelTimelineGesture() {
  window.removeEventListener("pointermove", updateTimelineGesture);
  window.removeEventListener("pointerup", finishTimelineGesture);
  window.removeEventListener("pointercancel", restoreTimelineGesture);
  timelineGesture.value = null;
  snapGuideTime.value = null;
}
function restoreTimelineGesture(event?: PointerEvent) {
  const gesture = timelineGesture.value;
  if (!gesture || (event && event.pointerId !== gesture.pointerId)) return;
  const track = active.value?.tracks.find((entry) => entry.id === gesture.trackId);
  if (track) track.clips = structuredClone(toRaw(gesture.initialTrackClips));
  cancelTimelineGesture();
  void nextTick(syncPreview);
}
function timelineSnapTargets(excludedClipId: string, candidate: number): number[] {
  const gesture = timelineGesture.value?.clipId === excludedClipId ? timelineGesture.value : null;
  const excludedPoints = gesture
    ? [gesture.initialStart, gesture.initialStart + gesture.initialDuration].map((point) => quantizeTimelineTime(point, activeFrameRate.value))
    : [];
  const points = timelineSnapPoints.value;
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (points[middle]! < candidate) low = middle + 1;
    else high = middle;
  }
  const nearby = points.slice(Math.max(0, low - 3), Math.min(points.length, low + 4)).filter((point) => {
    const removed = excludedPoints.filter((excludedPoint) => excludedPoint === point).length;
    return (timelineSnapPointCounts.value.get(point) ?? 0) > removed;
  });
  return [...new Set([...nearby, Math.round(candidate), 0, totalDuration.value, playhead.value]
    .map((value) => quantizeTimelineTime(value, activeFrameRate.value)))];
}
function maximumOutputDuration(clip: EditClip, trimStart: number, playbackRate: number): number {
  if (clip.kind === "timeline") {
    const reference = clip.nestedTimeline;
    if (!reference) return clip.durationSeconds;
    try {
      const offsetNumerator = BigInt(reference.sourceOffset.numerator) * BigInt(reference.sourceStep.denominator);
      const offsetDenominator = BigInt(reference.sourceOffset.denominator) * BigInt(reference.sourceStep.numerator);
      if (offsetDenominator <= 0n || offsetNumerator < 0n || offsetNumerator % offsetDenominator !== 0n) return clip.durationSeconds;
      const remainingFrames = reference.mappedDurationFrames - Number(offsetNumerator / offsetDenominator);
      return remainingFrames > 0 ? timelineSecondsForFrame(remainingFrames, activeFrameRate.value) : clip.durationSeconds;
    } catch { return clip.durationSeconds; }
  }
  if (!["video", "audio"].includes(clip.kind)) return Math.max(3_600, clip.durationSeconds);
  const sourceDuration = clip.artifactId ? mediaByArtifactId.value.get(clip.artifactId)?.durationSeconds : undefined;
  if (!sourceDuration) return Math.max(3_600, clip.durationSeconds);
  return Math.max(.1, (sourceDuration - trimStart) / Math.max(.1, playbackRate));
}
function onClipClick(id: string) {
  if (suppressClipClick) { suppressClipClick = false; return; }
  selectClip(id);
}
function selectClip(id: string) {
  selectedClipId.value = id;
  const clip = active.value?.tracks.flatMap((track) => track.clips).find((entry) => entry.id === id);
  if (clip) seek(clip.startSeconds);
}
function moveClip(offset: number) {
  if (!selectedTrack.value || !selectedClip.value) return;
  const index = selectedTrack.value.clips.findIndex((clip) => clip.id === selectedClip.value!.id);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= selectedTrack.value.clips.length) return;
  const [clip] = selectedTrack.value.clips.splice(index, 1);
  if (clip) selectedTrack.value.clips.splice(target, 0, clip);
  if (selectedTrack.value.kind === "visual" && selectedTrack.value.order === 0) reflowVisual();
}
function removeClip() {
  if (!active.value || !selectedClip.value) return;
  const track = active.value.tracks.find((entry) => entry.id === selectedClip.value!.trackId);
  if (!track) return;
  track.clips = track.clips.filter((clip) => clip.id !== selectedClip.value!.id);
  selectedClipId.value = track.clips[0]?.id ?? "";
  if (track.kind === "visual" && track.order === 0) reflowVisual();
}
async function runAtomicEditOperation(operation: EditOperation, successMessage: string): Promise<{ affectedClipIds: string[] } | null> {
  if (!active.value || !await save({ scheduleNestedPreviews: false })) return null;
  try {
    const result = await window.canvasApi.applyEditOperation(props.projectRoot, active.value.id, active.value.revision, operation);
    acceptPersistedProject(result.project);
    projects.value = await window.canvasApi.listEditProjects(props.projectRoot);
    Object.assign(historyInfo, await window.canvasApi.getEditHistoryInfo(props.projectRoot, active.value.id));
    if (editorSessionId.value) await window.canvasApi.setEditorSessionProject(props.projectRoot, editorSessionId.value, active.value.id);
    emit("changed", `${successMessage} · 修订 v${active.value.revision}`);
    resumePreviewWork();
    await nextTick(syncPreview);
    return { affectedClipIds: result.affectedClipIds };
  } catch (error) { resumePreviewWork(); emit("failed", message(error)); return null; }
}
async function splitSelectedAtPlayhead() {
  const clip = selectedClip.value;
  if (!clip || !canSplitSelected.value) return;
  const splitTime = playhead.value;
  const result = await runAtomicEditOperation({ type: "split_clip", clipId: clip.id, timeSeconds: splitTime }, `已在 ${timecode(splitTime)} 分割片段`);
  const createdId = result?.affectedClipIds.find((id) => id !== clip.id);
  if (createdId) selectedClipId.value = createdId;
  seek(splitTime);
}
async function rippleDeleteSelected() {
  const clip = selectedClip.value;
  if (!clip || !window.confirm(`Ripple 删除“${clip.name}”？\n\n该片段会被移除，结束点之后的所有未锁定轨道将向前收拢 ${clip.durationSeconds.toFixed(2)} 秒。`)) return;
  const start = clip.startSeconds;
  const result = await runAtomicEditOperation({ type: "ripple_delete", clipId: clip.id, allUnlockedTracks: true }, `已 Ripple 删除 ${clip.name}`);
  if (!result) return;
  selectedClipId.value = "";
  seek(Math.min(start, totalDuration.value));
}
function addKeyframe() {
  const clip = selectedClip.value;
  if (!clip || !selectedTrack.value || selectedTrack.value.kind !== "visual") return;
  if (clipParticipatesInDissolve(clip)) { emit("failed", "首版 SMPTE Dissolve 参与片段不能添加变换关键帧。"); return; }
  clip.keyframes ??= [];
  const frame = Math.max(0, Math.min(clipDurationFrames(clip), playheadFrame.value - clipStartFrame(clip)));
  const timeSeconds = timelineSecondsForFrame(frame, activeFrameRate.value);
  const existing = clip.keyframes.find((keyframe) => keyframeFrame(keyframe) === frame);
  const values = { timeSeconds, frame, positionX: Number(clip.positionX ?? 0), positionY: Number(clip.positionY ?? 0), scale: Number(clip.scale ?? 1), rotation: Number(clip.rotation ?? 0) };
  if (existing) Object.assign(existing, values);
  else clip.keyframes.push({ id: `kf-${crypto.randomUUID()}`, easing: "ease_in_out", ...values });
  clip.keyframes.sort((a, b) => a.timeSeconds - b.timeSeconds);
}
function removeKeyframe(id: string) {
  if (!selectedClip.value?.keyframes) return;
  selectedClip.value.keyframes = selectedClip.value.keyframes.filter((keyframe) => keyframe.id !== id);
}
function changeKeyframeEasing(keyframe: EditorKeyframe) {
  if (keyframe.easing === "cubic_bezier") keyframe.bezier ??= { ...DEFAULT_EDIT_CUBIC_BEZIER };
  else delete keyframe.bezier;
  void nextTick(syncPreview);
}
function updateKeyframeBezier(keyframe: EditorKeyframe, coordinate: BezierCoordinate, event: Event) {
  if (isDerivedKeyframe(keyframe)) return;
  keyframe.bezier ??= { ...DEFAULT_EDIT_CUBIC_BEZIER };
  const raw = (event.target as HTMLInputElement).value.trim();
  keyframe.bezier[coordinate] = raw ? Number(raw) : Number.NaN;
  void nextTick(syncPreview);
}
function keyframeCurveIssue(keyframe: EditorKeyframe): string | undefined {
  return editKeyframeCurveIssue(keyframe.easing, keyframe.bezier) ?? editKeyframeSourceTransformIssue(keyframe.easing, keyframe.bezier, keyframe.sourceTransform);
}
function isDerivedKeyframe(keyframe: EditorKeyframe): boolean {
  return keyframe.bezier?.mode === "derived_monotone";
}
function keyframeBezierValue(keyframe: EditorKeyframe, coordinate: BezierCoordinate): number {
  const value = Number(keyframe.bezier?.[coordinate]);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : DEFAULT_EDIT_CUBIC_BEZIER[coordinate];
}
function keyframeBezierPoint(keyframe: EditorKeyframe, coordinate: BezierCoordinate, invert = false): number {
  const value = keyframeBezierValue(keyframe, coordinate);
  return 8 + (invert ? 1 - value : value) * 84;
}
function keyframeBezierPath(keyframe: EditorKeyframe): string {
  if (isDerivedKeyframe(keyframe) && keyframe.bezier) {
    const source = keyframe.bezier.sourceWindow;
    const segmentFrames = source?.startFrame !== undefined && source.endFrame !== undefined ? source.endFrame - source.startFrame : undefined;
    const sampleCount = segmentFrames ? Math.max(1, Math.min(64, segmentFrames)) : 48;
    const samples: string[] = [];
    for (let index = 0; index <= sampleCount; index += 1) {
      const ratio = index / sampleCount;
      const frame = segmentFrames ? Math.round(ratio * segmentFrames) : undefined;
      const eased = frame === undefined
        ? evaluateEditKeyframeEasing("cubic_bezier", ratio, keyframe.bezier)
        : evaluateEditKeyframeEasingAtFrame("cubic_bezier", frame, segmentFrames!, keyframe.bezier);
      samples.push(`${index === 0 ? "M" : "L"}${8 + ratio * 84} ${92 - eased * 84}`);
    }
    return samples.join(" ");
  }
  return `M8 92 C${keyframeBezierPoint(keyframe, "x1")} ${keyframeBezierPoint(keyframe, "y1", true)},${keyframeBezierPoint(keyframe, "x2")} ${keyframeBezierPoint(keyframe, "y2", true)},92 8`;
}
function keyframeBezierHandles(keyframe: EditorKeyframe): string {
  return `M8 92 L${keyframeBezierPoint(keyframe, "x1")} ${keyframeBezierPoint(keyframe, "y1", true)} M92 8 L${keyframeBezierPoint(keyframe, "x2")} ${keyframeBezierPoint(keyframe, "y2", true)}`;
}
function keyframeBezierLabel(keyframe: EditorKeyframe): string {
  const digits = isDerivedKeyframe(keyframe) ? 6 : 2;
  return `${isDerivedKeyframe(keyframe) ? "derived " : ""}cubic-bezier(${bezierCoordinates.map((coordinate) => Number.isFinite(Number(keyframe.bezier?.[coordinate])) ? Number(keyframe.bezier?.[coordinate]).toFixed(digits) : "—").join(", ")})`;
}
function reflowVisual() {
  if (!visualTrack.value) return;
  let cursorFrame = 0;
  for (const clip of visualTrack.value.clips) {
    const durationFrames = Math.max(1, timelineFrameForSeconds(Math.max(frameDuration.value, Number(clip.durationSeconds) || frameDuration.value), activeFrameRate.value));
    clip.startFrame = cursorFrame;
    clip.durationFrames = durationFrames;
    clip.startSeconds = timelineSecondsForFrame(cursorFrame, activeFrameRate.value);
    clip.durationSeconds = timelineSecondsForFrame(durationFrames, activeFrameRate.value);
    cursorFrame += durationFrames;
  }
  if (playheadFrame.value > cursorFrame) seek(timelineSecondsForFrame(cursorFrame, activeFrameRate.value));
}
function togglePlayback() {
  if (playing.value) { stopPlayback(); return; }
  if (!totalDuration.value) return;
  if (playhead.value >= totalDuration.value - .01) seek(0);
  playing.value = true;
  syncPreview();
  void nextTick(syncPreview);
  let previous = performance.now();
  playbackTimer = setInterval(() => {
    const now = performance.now();
    seek(playhead.value + (now - previous) / 1000, false);
    previous = now;
    if (playhead.value >= totalDuration.value) stopPlayback();
  }, 80);
}
function stopPlayback() {
  playing.value = false;
  if (playbackTimer) clearInterval(playbackTimer);
  playbackTimer = null;
  pausePreviewMedia();
}
function clipStartFrame(clip: EditClip): number {
  return timelineFrameForSeconds(Number(clip.startSeconds) || 0, activeFrameRate.value);
}
function clipDurationFrames(clip: EditClip): number {
  return Math.max(1, timelineFrameForSeconds(Math.max(frameDuration.value, Number(clip.durationSeconds) || frameDuration.value), activeFrameRate.value));
}
function clipEndFrame(clip: EditClip): number {
  return clipStartFrame(clip) + clipDurationFrames(clip);
}
function clipTrimStartFrame(clip: EditClip): number {
  return timelineFrameForSeconds(Number(clip.trimStartSeconds) || 0, activeFrameRate.value);
}
function clipParticipatesInDissolve(clip: EditClip): boolean {
  return clip.transitionOut === "smpte_dissolve" || visualClips.value.some((entry) => entry.transitionOut === "smpte_dissolve" && entry.transition?.targetClipId === clip.id);
}
function dissolveEligibility(clip: EditClip | null): DissolveEligibility {
  const unavailable = (issue: string): DissolveEligibility => ({ maxInFrames: 0, maxOutFrames: 0, issue });
  if (!clip || !visualTrack.value || clip.trackId !== visualTrack.value.id) return unavailable("SMPTE Dissolve 只支持主视觉轨。");
  if (clip.kind !== "video" || clip.muted) return unavailable("转场前项必须是启用的普通视频。");
  const clips = visualClips.value;
  const index = clips.findIndex((entry) => entry.id === clip.id);
  const target = index >= 0 ? clips[index + 1] : undefined;
  if (!target || target.kind !== "video" || target.muted || clipEndFrame(clip) !== clipStartFrame(target)) return unavailable("需要同轨紧邻、共享整数帧切点的后继视频。");
  if (clip.playbackRate !== 1 || target.playbackRate !== 1) return unavailable("首版 SMPTE Dissolve 不能与 LinearTimeWarp 组合。");
  if ((clip.keyframes?.length ?? 0) || (target.keyframes?.length ?? 0)) return unavailable("首版 SMPTE Dissolve 不能与变换关键帧组合。");
  if ((clip.fadeInSeconds ?? 0) || (clip.fadeOutSeconds ?? 0) || (target.fadeInSeconds ?? 0) || (target.fadeOutSeconds ?? 0)) return unavailable("首版 SMPTE Dissolve 不能与淡入淡出包络组合。");
  const outgoingAvailable = clip.sourceAvailableRange;
  const incomingAvailable = target.sourceAvailableRange;
  if (!outgoingAvailable || !incomingAvailable || outgoingAvailable.startFrame !== 0 || incomingAvailable.startFrame !== 0) return unavailable("两个视频都必须带有可证明、从媒体起点开始的 available_range。");
  const previous = clips[index - 1];
  const previousOutFrames = previous?.transitionOut === "smpte_dissolve" && previous.transition?.targetClipId === clip.id ? previous.transition.outOffsetFrames : 0;
  const targetNextInFrames = target.transitionOut === "smpte_dissolve" && target.transition ? target.transition.inOffsetFrames : 0;
  const incomingPreRoll = clipTrimStartFrame(target) - incomingAvailable.startFrame;
  const outgoingPostRoll = outgoingAvailable.startFrame + outgoingAvailable.durationFrames - (clipTrimStartFrame(clip) + clipDurationFrames(clip));
  const maxInFrames = Math.max(0, Math.min(clipDurationFrames(clip) - previousOutFrames, incomingPreRoll));
  const maxOutFrames = Math.max(0, Math.min(clipDurationFrames(target) - targetNextInFrames, outgoingPostRoll));
  if (maxInFrames < 1 || maxOutFrames < 1) return { target, maxInFrames, maxOutFrames, issue: "媒体 pre-roll 或 post-roll handle 不足 1 帧。" };
  return { target, maxInFrames, maxOutFrames };
}
function changeSelectedTransition(event: Event) {
  const clip = selectedClip.value;
  if (!clip) return;
  const selection = (event.currentTarget as HTMLSelectElement).value as "cut" | "fade" | "smpte_dissolve";
  if (selection === "cut") {
    clip.transitionOut = "cut";
    clip.transition = undefined;
    clip.transitionDurationSeconds = undefined;
    return;
  }
  if (selection === "fade") {
    clip.transitionOut = "fade";
    clip.transition = undefined;
    clip.transitionDurationSeconds = Math.max(.1, Number(clip.transitionDurationSeconds) || .5);
    return;
  }
  const eligibility = dissolveEligibility(clip);
  if (eligibility.issue || !eligibility.target) {
    emit("failed", eligibility.issue ?? "当前片段不能创建 SMPTE Dissolve。");
    (event.currentTarget as HTMLSelectElement).value = clip.transitionOut ?? "cut";
    return;
  }
  clip.transitionOut = "smpte_dissolve";
  clip.transitionDurationSeconds = undefined;
  clip.transition = {
    contract: "aicanvas.otio-transition.v1",
    kind: "smpte_dissolve",
    targetClipId: eligibility.target.id,
    inOffsetFrames: Math.min(6, eligibility.maxInFrames),
    outOffsetFrames: Math.min(6, eligibility.maxOutFrames),
  };
}
function normalizeSelectedDissolve() {
  const clip = selectedClip.value;
  if (!clip?.transition || clip.transitionOut !== "smpte_dissolve") return;
  const eligibility = dissolveEligibility(clip);
  if (eligibility.issue || !eligibility.target) return;
  clip.transition.targetClipId = eligibility.target.id;
  clip.transition.inOffsetFrames = Math.max(1, Math.min(eligibility.maxInFrames, Math.round(Number(clip.transition.inOffsetFrames) || 1)));
  clip.transition.outOffsetFrames = Math.max(1, Math.min(eligibility.maxOutFrames, Math.round(Number(clip.transition.outOffsetFrames) || 1)));
}
function keyframeFrame(keyframe: NonNullable<EditClip["keyframes"]>[number]): number {
  return Number.isInteger(keyframe.frame) ? keyframe.frame! : timelineFrameForSeconds(Number(keyframe.timeSeconds) || 0, activeFrameRate.value);
}
function clipActiveAtPlayhead(clip: EditClip): boolean {
  return playheadFrame.value >= clipStartFrame(clip) && playheadFrame.value < clipEndFrame(clip);
}
function normalizeSelectedClipTiming() {
  const clip = selectedClip.value;
  if (!clip) return;
  clip.startSeconds = Math.max(0, Math.min(MAX_EDIT_TIMELINE_SECONDS - frameDuration.value, Number(clip.startSeconds) || 0));
  clip.durationSeconds = Math.max(frameDuration.value, Math.min(
    MAX_EDIT_TIMELINE_SECONDS - clip.startSeconds,
    Number(clip.durationSeconds) || frameDuration.value,
  ));
  clip.trimStartSeconds = Math.max(0, Math.min(MAX_EDIT_TIMELINE_SECONDS, Number(clip.trimStartSeconds) || 0));
  clip.durationFrames = clipDurationFrames(clip);
  clip.durationSeconds = timelineSecondsForFrame(clip.durationFrames, activeFrameRate.value);
  clip.trimStartFrame = clipTrimStartFrame(clip);
  clip.trimStartSeconds = timelineSecondsForFrame(clip.trimStartFrame, activeFrameRate.value);
  for (const keyframe of clip.keyframes ?? []) {
    keyframe.frame = Math.min(clip.durationFrames, keyframeFrame(keyframe));
    keyframe.timeSeconds = timelineSecondsForFrame(keyframe.frame, activeFrameRate.value);
  }
  if (selectedTrack.value?.id === visualTrack.value?.id) reflowVisual();
}
function seek(value: number, pause = true) {
  if (pause) stopPlayback();
  playhead.value = quantizeTimelineTime(Number(value) || 0, activeFrameRate.value, 0, totalDuration.value);
  void previewSyncScheduler.request();
}
function syncPreview() {
  const dissolve = activeDissolve.value;
  const clip = previewClip.value;
  if (clip && ["video", "timeline"].includes(clip.kind) && videoElement.value) syncTimelineMedia({ clip: dissolve ? dissolveOutgoingSyncClip(dissolve) : previewSyncClip(clip), media: videoElement.value, playhead: playhead.value, playing: playing.value, trackMuted: Boolean(visualTrack.value?.muted || dissolve) });
  else videoElement.value?.pause();
  if (dissolve && incomingVideoElement.value) syncTimelineMedia({ clip: dissolveIncomingSyncClip(dissolve), media: incomingVideoElement.value, playhead: playhead.value, playing: playing.value, trackMuted: true });
  else incomingVideoElement.value?.pause();

  const overlayById = new Map(activeOverlayClips.value.map((entry) => [entry.id, entry]));
  for (const [clipId, element] of overlayVideoElements) {
    const overlay = overlayById.get(clipId);
    if (!overlay) { element.pause(); continue; }
    const track = active.value?.tracks.find((entry) => entry.id === overlay.trackId);
    syncTimelineMedia({ clip: previewSyncClip(overlay), media: element, playhead: playhead.value, playing: playing.value, trackMuted: track?.muted });
  }

  const audioById = new Map(previewAudioClips.value.map((entry) => [entry.id, entry]));
  for (const [clipId, element] of audioElements) {
    const audio = audioById.get(clipId);
    if (!audio) { element.pause(); continue; }
    const track = active.value?.tracks.find((entry) => entry.id === audio.trackId);
    syncTimelineMedia({ clip: previewSyncClip(audio), media: element, playhead: playhead.value, playing: playing.value, trackMuted: track?.muted });
  }
}
function previewSyncClip(clip: EditClip): EditClip {
  const preview = clip.kind === "timeline" ? nestedPreviews.get(clip.id) : undefined;
  return preview ? { ...clip, trimStartSeconds: preview.trimStartSeconds, trimStartFrame: preview.trimStartFrame } : clip;
}
function dissolveOutgoingSyncClip(dissolve: ActiveDissolvePreview): EditClip {
  const clip = previewSyncClip(dissolve.outgoing);
  const durationFrames = clipDurationFrames(clip) + (clip.transition?.outOffsetFrames ?? 0);
  return { ...clip, durationFrames, durationSeconds: timelineSecondsForFrame(durationFrames, activeFrameRate.value) };
}
function dissolveIncomingSyncClip(dissolve: ActiveDissolvePreview): EditClip {
  const clip = previewSyncClip(dissolve.incoming);
  const preRollFrames = dissolve.outgoing.transition?.inOffsetFrames ?? 0;
  const startFrame = clipStartFrame(clip) - preRollFrames;
  const trimStartFrame = clipTrimStartFrame(clip) - preRollFrames;
  const durationFrames = clipDurationFrames(clip) + preRollFrames;
  return {
    ...clip,
    startFrame,
    startSeconds: timelineSecondsForFrame(startFrame, activeFrameRate.value),
    trimStartFrame,
    trimStartSeconds: timelineSecondsForFrame(trimStartFrame, activeFrameRate.value),
    durationFrames,
    durationSeconds: timelineSecondsForFrame(durationFrames, activeFrameRate.value),
  };
}
function setOverlayVideoElement(clipId: string, element: unknown) {
  if (element instanceof HTMLVideoElement) overlayVideoElements.set(clipId, element);
  else overlayVideoElements.delete(clipId);
}
function setAudioElement(clipId: string, element: unknown) {
  if (element instanceof HTMLAudioElement) audioElements.set(clipId, element);
  else audioElements.delete(clipId);
}
function onPreviewMediaLoaded(clip: EditClip) {
  if (clip.kind === "timeline" && nestedPreviews.has(clip.id)) nestedPreviewErrors.delete(clip.id);
  syncPreview();
}
function onPreviewMediaError(clip: EditClip, event: Event) {
  if (clip.kind !== "timeline") return;
  const media = event.currentTarget as HTMLMediaElement | null;
  const code = media?.error?.code;
  nestedPreviewErrors.set(clip.id, `嵌套预览媒体解码失败${code ? `（MediaError ${code}）` : ""}；请重新生成预览或检查 FFmpeg。`);
}
function pausePreviewMedia() {
  videoElement.value?.pause();
  incomingVideoElement.value?.pause();
  for (const element of overlayVideoElements.values()) element.pause();
  for (const element of audioElements.values()) element.pause();
}
function onTimelineClick(event: MouseEvent) {
  const target = event.currentTarget as HTMLElement;
  const rect = target.getBoundingClientRect();
  seek((event.clientX - rect.left - 108) / pixelsPerSecond.value);
}
function clipStyle(clip: EditClip) {
  const source = clip.artifactId ? mediaByArtifactId.value.get(clip.artifactId) : undefined;
  const preview = clip.kind === "audio" ? source?.waveformPath : source?.filmstripPath ?? source?.thumbnailPath;
  const gesture = timelineGesture.value?.clipId === clip.id ? timelineGesture.value : null;
  return {
    left: `${clip.startSeconds * pixelsPerSecond.value}px`,
    width: `${Math.max(46, clip.durationSeconds * pixelsPerSecond.value)}px`,
    backgroundImage: preview ? `linear-gradient(90deg,#1119,#1115),url('${assetUrl(preview)}')` : undefined,
    backgroundSize: "cover",
    backgroundPosition: "center",
    transform: gesture?.mode === "move" && gesture.baseTrack ? `translateX(${gesture.previewDeltaPx}px)` : undefined,
    zIndex: gesture ? "12" : undefined,
  };
}
function hydrateVisualClips(project: EditProject) {
  for (const track of project.tracks.filter((entry) => entry.kind === "visual")) for (const clip of track.clips) {
    clip.positionX ??= 0;
    clip.positionY ??= 0;
    clip.scale ??= track.order > 0 ? .35 : 1;
    clip.rotation ??= 0;
    clip.filter ??= "none";
    clip.filterIntensity ??= 1;
    clip.keyframes ??= [];
    clip.transitionOut ??= "cut";
    if (clip.transitionOut === "smpte_dissolve") clip.transitionDurationSeconds = undefined;
    else clip.transitionDurationSeconds ??= .5;
  }
}
function visualTransformAt(clip: EditClip) {
  if ((clip.keyframes ?? []).some((keyframe) => keyframeCurveIssue(keyframe))) return { positionX: Number(clip.positionX ?? 0), positionY: Number(clip.positionY ?? 0), scale: Number(clip.scale ?? 1), rotation: Number(clip.rotation ?? 0) };
  const localFrame = Math.max(0, Math.min(clipDurationFrames(clip), playheadFrame.value - clipStartFrame(clip)));
  return evaluateEditTransformAtFrame(clip, localFrame, activeFrameRate.value);
}
function cssFilter(clip: EditClip) {
  const value = Math.max(0, Math.min(2, clip.filterIntensity ?? 1));
  if (clip.filter === "grayscale") return `grayscale(${Math.min(1, value)})`;
  if (clip.filter === "sepia") return `sepia(${Math.min(1, value)})`;
  if (clip.filter === "warm") return `sepia(${.22 * value}) saturate(${1 + .25 * value})`;
  if (clip.filter === "cool") return `hue-rotate(${18 * value}deg) saturate(${1 + .12 * value})`;
  if (clip.filter === "vivid") return `saturate(${1 + .8 * value})`;
  if (clip.filter === "contrast") return `contrast(${1 + .45 * value})`;
  if (clip.filter === "blur") return `blur(${1.8 * value}px)`;
  return "none";
}
function mainPreviewStyle(clip: EditClip, opacityMultiplier = 1) {
  const transform = visualTransformAt(clip);
  return {
    opacity: String(Math.max(0, Math.min(1, clip.opacity * opacityMultiplier))),
    filter: cssFilter(clip),
    transform: `translate(${transform.positionX * previewScale.value}px, ${transform.positionY * previewScale.value}px) scale(${transform.scale}) rotate(${transform.rotation}deg)`,
  };
}
function overlayPreviewStyle(clip: EditClip) {
  const transform = visualTransformAt(clip);
  const trackOrder = active.value?.tracks.find((track) => track.id === clip.trackId)?.order ?? 1;
  return {
    opacity: String(clip.opacity),
    filter: cssFilter(clip),
    zIndex: String(10 + trackOrder),
    transform: `translate(${transform.positionX * previewScale.value}px, ${transform.positionY * previewScale.value}px) scale(${transform.scale}) rotate(${transform.rotation}deg)`,
  };
}
function mediaMeta(item: EditMediaItem) { return `${item.episode ? `EP${String(item.episode).padStart(2, '0')} · ` : ''}${item.durationSeconds ? `${item.durationSeconds.toFixed(2)}s · ` : ''}${item.width && item.height ? `${item.width}×${item.height}` : item.authoritative ? '权威版本' : '可用版本'}`; }
function clipPreviewPath(clip: EditClip): string { return clip.kind === "timeline" ? nestedPreviews.get(clip.id)?.path ?? "" : (clip.artifactId ? mediaByArtifactId.value.get(clip.artifactId) : undefined)?.proxyPath ?? clip.sourcePath ?? ""; }
function timecode(seconds: number) {
  const nominalRate = Math.max(1, Math.round(activeFrameRate.value));
  const frames = timelineFrameForSeconds(Math.max(0, seconds), activeFrameRate.value);
  const hours = Math.floor(frames / (nominalRate * 3_600));
  const minutes = Math.floor(frames / (nominalRate * 60)) % 60;
  const wholeSeconds = Math.floor(frames / nominalRate) % 60;
  const frame = frames % nominalRate;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}+${String(frame).padStart(2, '0')}`;
}
function recoveryTime(value: string) { return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
function reveal(filePath: string) { void window.canvasApi.showInFolder(filePath); }
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
</script>

<style scoped>
.editor-workbench{height:100%;display:grid;grid-template-rows:94px minmax(0,1fr);background:#0e0f0d;color:#e8e6df}.editor-header{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:0 25px;border-bottom:1px solid #30322c;background:#151613}.editor-header h2{margin:6px 0 3px;font-size:19px}.editor-header p{margin:0;color:#777a70;font-size:9px}.editor-actions{display:flex;align-items:center;gap:8px}.editor-actions select{width:210px;height:34px;border:1px solid #383a33;background:#1a1b18;color:#ddd}.engine-state{padding:7px 9px;border:1px solid #3d4938;color:#86aa75;font:8px Menlo,monospace;white-space:nowrap}.engine-state.offline{border-color:#5a342e;color:#d27361}.editor-body{min-height:0;display:grid;grid-template-columns:270px minmax(620px,1fr) 278px}.media-bin,.clip-inspector{min-height:0;background:#141512}.media-bin{border-right:1px solid #2f312b}.media-bin>header{height:76px;padding:12px;border-bottom:1px solid #2b2d27}.media-bin>header>div{display:flex;justify-content:space-between;color:#aaa;font-size:9px}.media-bin>header b{color:#d7af55}.media-bin>header input{width:100%;height:29px;margin-top:9px;border:1px solid #34362f;background:#1b1c18;color:#ddd;padding:0 8px;font-size:8px}.media-filter{height:38px;display:flex;border-bottom:1px solid #292b25}.media-filter button{flex:1;border:0;border-bottom:2px solid transparent;background:transparent;color:#696c63;font-size:8px}.media-filter button.active{border-bottom-color:#d7af55;color:#d7af55}.media-list{height:calc(100% - 114px);overflow:auto}.media-list article{min-height:70px;display:grid;grid-template-columns:68px minmax(0,1fr) 28px;align-items:center;gap:9px;padding:8px;border-bottom:1px solid #282a24}.media-list figure{position:relative;width:68px;height:51px;margin:0;overflow:hidden;background:#090a08}.media-list figure img{width:100%;height:100%;object-fit:cover}.media-list figure>span{height:100%;display:grid;place-items:center;color:#55584f}.media-list figure em{position:absolute;bottom:3px;left:3px;padding:2px 4px;background:#0b0c09d9;color:#d7af55;font:6px Menlo,monospace;font-style:normal}.media-list article>div{min-width:0}.media-list b,.media-list small,.media-list code{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.media-list b{font-size:8px}.media-list small{margin-top:5px;color:#6f7269;font-size:7px}.media-list code{margin-top:4px;color:#4e5149;font:6px Menlo,monospace}.media-list article>button{width:26px;height:26px;border:1px solid #3d4037;background:transparent;color:#d7af55}.bin-empty{padding:30px 12px;text-align:center;color:#575a52;font-size:8px}.editor-center{min-width:0;display:grid;grid-template-rows:minmax(310px,55%) minmax(260px,45%);background:#0d0e0c}.preview-deck{min-height:0;display:grid;grid-template-rows:minmax(0,1fr) 44px;place-items:center;padding:18px 22px 0;background:radial-gradient(circle at 50% 15%,#25231b 0,#10110f 58%)}.preview-frame{position:relative;max-width:100%;max-height:100%;min-width:150px;overflow:hidden;border:1px solid #35372f;background:#000;box-shadow:0 14px 50px #000}.preview-frame video,.preview-frame img{width:100%;height:100%;display:block;object-fit:contain}.preview-empty{width:100%;height:100%;min-height:180px;display:grid;place-content:center;justify-items:center;gap:8px;color:#55584f;font-size:8px}.preview-time{position:absolute;right:8px;bottom:7px;padding:4px 6px;background:#050604c9;color:#d7af55;font:7px Menlo,monospace}.transport{width:100%;height:44px;display:flex;align-items:center;justify-content:center;gap:7px}.transport button{width:31px;height:29px;display:grid;place-items:center;border:0;background:transparent;color:#9a9d93}.transport button.play{border:1px solid #d7af55;color:#d7af55}.transport input{width:min(420px,50%)}.transport span{color:#676a61;font:7px Menlo,monospace}.timeline-deck{min-height:0;border-top:1px solid #30322c;background:#11120f}.timeline-tools{height:40px;display:flex;align-items:center;justify-content:space-between;padding:0 12px;border-bottom:1px solid #292b25}.timeline-tools>div{display:flex;gap:4px}.timeline-tools button{height:27px;display:flex;align-items:center;gap:4px;border:1px solid #34362f;background:transparent;color:#92958a;font-size:7px}.timeline-tools button.danger{color:#bd6a5a}.timeline-tools button:disabled{opacity:.3}.timeline-tools label{display:flex;align-items:center;gap:8px;color:#696c63;font-size:7px}.timeline-scroll{height:calc(100% - 40px);overflow:auto}.timeline-surface{position:relative;min-height:100%;padding-top:29px}.ruler{position:absolute;top:0;left:108px;right:0;height:29px;border-bottom:1px solid #30322c;background:repeating-linear-gradient(90deg,#3a3c34 0 1px,transparent 1px 12px)}.ruler span{position:absolute;top:7px;color:#5f6259;font:6px Menlo,monospace}.track-row{height:68px;display:grid;grid-template-columns:108px minmax(0,1fr);border-bottom:1px solid #292b25}.track-row>header{display:flex;align-items:center;gap:8px;padding:0 9px;border-right:1px solid #30322c;background:#151613}.track-row>header>span{width:20px;height:20px;display:grid;place-items:center;border:1px solid #4a4c43;color:#d7af55;font:7px Menlo,monospace}.track-row header b,.track-row header small{display:block}.track-row header b{font-size:7px}.track-row header small{margin-top:4px;color:#55584f;font-size:6px}.track-lane{position:relative;background:repeating-linear-gradient(90deg,#181916 0 1px,transparent 1px 48px)}.track-lane>p{margin:23px 12px;color:#4e5149;font-size:7px}.timeline-clip{position:absolute;top:7px;height:53px;min-width:46px;overflow:hidden;border:1px solid #4d4f46;background:#22241f;color:#ddd;text-align:left;padding:6px 7px}.timeline-clip.video{border-color:#57634c;background:#232a20}.timeline-clip.image{border-color:#5b5137;background:#2a271d}.timeline-clip.audio{border-color:#3c5860;background:#1f2a2d}.timeline-clip.subtitle{border-color:#5b455d;background:#29212a}.timeline-clip.selected{border-color:#d7af55;box-shadow:inset 0 0 0 1px #d7af55}.timeline-clip span,.timeline-clip b,.timeline-clip small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.timeline-clip span{color:#d7af55;font:6px Menlo,monospace}.timeline-clip b{margin-top:5px;font-size:7px}.timeline-clip small{margin-top:4px;color:#777a70;font-size:6px}.playhead{position:absolute;top:0;bottom:0;z-index:8;width:1px;margin-left:108px;background:#d7af55;pointer-events:none}.playhead i{position:absolute;top:0;left:-4px;width:9px;height:9px;background:#d7af55;clip-path:polygon(0 0,100% 0,50% 100%)}.clip-inspector{overflow:auto;border-left:1px solid #2f312b}.clip-inspector>header{padding:17px 15px;border-bottom:1px solid #2b2d27}.clip-inspector>header span,.clip-inspector>header b,.clip-inspector>header small{display:block}.clip-inspector>header span{color:#d7af55;font-size:7px}.clip-inspector>header b{margin-top:7px;font-size:11px}.clip-inspector>header small{margin-top:6px;color:#64675e;font-size:7px}.project-fields,.selected-fields{padding:14px 15px;border-bottom:1px solid #2b2d27}.project-fields label,.selected-fields label{display:block;margin-bottom:11px}.project-fields label>span,.selected-fields label>span{display:block;margin-bottom:6px;color:#777a70;font-size:7px}.project-fields input,.project-fields select,.selected-fields input,.selected-fields textarea{width:100%;border:1px solid #35372f;background:#1b1c18;color:#ddd;padding:7px;font-size:8px}.project-fields>div{display:grid;grid-template-columns:1fr 1fr;gap:8px}.inspector-label{color:#d7af55;font-size:7px}.selected-fields h3{margin:7px 0;font-size:11px}.selected-fields code{display:block;margin-bottom:14px;overflow:hidden;color:#55584f;font:6px Menlo,monospace;text-overflow:ellipsis;white-space:nowrap}.selected-fields>button,.render-card button{height:29px;display:flex;align-items:center;gap:6px;border:1px solid #3a3c34;background:transparent;color:#aaa;font-size:7px}.no-selection{height:150px;display:grid;place-content:center;justify-items:center;gap:8px;color:#565950;font-size:7px}.render-card{margin:14px;padding:11px;border-left:2px solid #d7af55;background:#191a16}.render-card.succeeded{border-left-color:#799b69}.render-card.failed{border-left-color:#c16554}.render-card span,.render-card b,.render-card small{display:block}.render-card span{color:#8c8f85;font-size:7px}.render-card b{margin:7px 0;overflow:hidden;color:#686b63;font:6px Menlo,monospace;text-overflow:ellipsis;white-space:nowrap}.render-card small{margin-top:6px;color:#c16b5a;font-size:7px;line-height:1.5}.editor-empty{height:100%;display:grid;place-content:center;justify-items:center;gap:10px;color:#676a61;text-align:center}.editor-empty h3{margin:4px 0 0;color:#ddd}.editor-empty p{max-width:440px;margin:0 0 6px;font-size:9px;line-height:1.6}.editor-modal{position:fixed;inset:0;z-index:300;display:grid;place-items:center;background:#050604dc;backdrop-filter:blur(10px)}.editor-modal>section{width:520px;border:1px solid #3b3d35;background:#151613;box-shadow:0 30px 90px #000;padding:0 22px 22px}.editor-modal header{height:78px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #30322c}.editor-modal header h2{margin:6px 0 0;font-size:17px}.editor-modal header button{border:0;background:transparent;color:#888}.editor-modal>section>label{display:block;margin-top:17px}.editor-modal label>span{display:block;margin-bottom:7px;color:#83867b;font-size:8px}.editor-modal input,.editor-modal select{width:100%;height:34px;border:1px solid #373931;background:#1b1c18;color:#ddd;padding:0 9px}.editor-modal .modal-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:17px}.editor-modal .check{display:flex;align-items:center;gap:8px}.editor-modal .check input{width:auto;height:auto}.editor-modal .check span{margin:0}.editor-modal footer{display:flex;justify-content:flex-end;gap:8px;margin-top:24px;padding-top:16px;border-top:1px solid #30322c}.spinning{animation:spin .8s linear infinite}@media(max-width:1350px){.editor-header p{display:none}.editor-body{grid-template-columns:230px minmax(590px,1fr) 250px}.editor-actions .engine-state{display:none}}
.preview-stage{min-height:0;width:100%;height:100%;display:grid;place-items:center;overflow:hidden}.preview-stage .preview-frame{width:auto!important;height:360px!important;max-height:calc(100% - 10px)!important;min-width:0;justify-self:center;align-self:center}.preview-main,.preview-overlay{transform-origin:center;background:transparent}.preview-overlay{position:absolute!important;inset:0;width:100%!important;height:100%!important;object-fit:contain;pointer-events:none}.preview-subtitle{position:absolute;left:8%;right:8%;bottom:7.5%;z-index:30;padding:.45em .65em;border-radius:.35em;text-align:center;font-weight:650;line-height:1.35;text-shadow:0 1px 3px #000;white-space:pre-line}.selected-fields select{width:100%;border:1px solid #35372f;background:#1b1c18;color:#ddd;padding:7px;font-size:8px}.selected-fields .inline-fields{display:grid;grid-template-columns:1fr 1fr;gap:8px}.track-row>header.selected{background:#22231e;box-shadow:inset 2px 0 #d7af55}.track-row>header>button{margin-left:auto;width:20px;height:20px;display:grid;place-items:center;border:0;background:transparent;color:#8b5c52}.transform-label{margin:17px 0 10px;padding-top:13px;border-top:1px solid #30322c}.selected-fields .keyframe-add{width:100%;justify-content:center;border-color:#66572f;color:#d7af55}.keyframe-list{margin:9px 0 13px;border-top:1px solid #30322c}.keyframe-list article{display:block;border-bottom:1px solid #292b25}.keyframe-summary{display:grid;grid-template-columns:44px minmax(0,1fr) 76px 22px;align-items:center;gap:6px;min-height:34px}.keyframe-list article button{height:22px;border:0;background:transparent;color:#d7af55;font:6px Menlo,monospace}.keyframe-list article span{overflow:hidden;color:#666960;font:6px Menlo,monospace;text-overflow:ellipsis;white-space:nowrap}.keyframe-list article select{height:23px;padding:0 3px;font-size:6px}.bezier-editor{display:grid;grid-template-columns:76px minmax(0,1fr);gap:7px;padding:7px 0 10px;border-top:1px solid #24261f}.bezier-editor svg{grid-row:1/4;width:76px;height:76px;border:1px solid #30322c;background:#11120f}.bezier-diagonal{fill:none;stroke:#2e302a;stroke-width:1;stroke-dasharray:3 3}.bezier-handle{fill:none;stroke:#6d603c;stroke-width:1}.bezier-curve{fill:none;stroke:#d7af55;stroke-width:2}.bezier-anchor{fill:#72756b}.bezier-control{fill:#11120f;stroke:#f0cf76;stroke-width:2}.bezier-fields{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:3px}.bezier-fields label{margin:0}.bezier-fields label span{margin-bottom:3px;color:#6f7268;font:6px Menlo,monospace}.bezier-fields input{height:24px;padding:3px;text-align:center;font:7px Menlo,monospace}.bezier-editor code{margin:0;color:#a48d51;font:6px Menlo,monospace;white-space:nowrap}.bezier-editor small{color:#65685f;font-size:6px;line-height:1.4}.bezier-editor small[role=alert]{color:#d36b59}
.render-card progress{width:100%;height:4px;margin:7px 0;accent-color:#d7af55}.editor-actions .render-cancel{border-color:#6b3b32;color:#d47a68}
.editor-actions .icon-history{width:32px;padding:0;justify-content:center}
.timeline-tools>div:first-child{min-width:0;flex:1;overflow-x:auto;scrollbar-width:thin;scrollbar-color:#3b3d35 transparent}.timeline-tools>div:first-child button,.timeline-tools>div:first-child select{flex:0 0 auto}.timeline-tools button.tool-emphasis{border-color:#66572f;color:#d7af55}.timeline-scale{flex:0 0 auto;margin-left:8px}
.preview-audio-host{display:none}
.timeline-scale{align-items:center!important;gap:12px!important}.timeline-scale>span{color:#55584f;font:6px Menlo,monospace;white-space:nowrap}.timeline-scale label{margin:0}
.timeline-clip{padding-left:9px;padding-right:9px;cursor:grab;touch-action:none;user-select:none}.timeline-clip.dragging{cursor:grabbing;box-shadow:0 7px 18px #000b,inset 0 0 0 1px #d7af55}.timeline-clip.locked{cursor:not-allowed;opacity:.58}.trim-handle{position:absolute;top:0;bottom:0;z-index:2;width:6px;background:#d7af55;opacity:0;cursor:ew-resize;transition:opacity .12s ease}.trim-handle::after{content:"";position:absolute;top:19px;width:1px;height:13px;background:#181916}.trim-start{left:0}.trim-start::after{left:2px}.trim-end{right:0}.trim-end::after{right:2px}.timeline-clip:hover .trim-handle,.timeline-clip.selected .trim-handle,.timeline-clip.dragging .trim-handle{opacity:.9}.snap-guide{position:absolute;top:0;bottom:0;z-index:9;width:1px;background:#f0cf76;box-shadow:0 0 9px #d7af5580;pointer-events:none}.snap-guide span{position:absolute;top:4px;left:5px;padding:3px 5px;background:#292315;color:#f0cf76;font:6px Menlo,monospace;white-space:nowrap}
.timeline-tools select{max-width:160px;height:27px;border:1px solid #34362f;background:#151613;color:#96998e;font-size:7px}
.timeline-clip.timeline{border-color:#7b6230;background:linear-gradient(135deg,#302817,#201f19);box-shadow:inset 3px 0 #d7af55}.timeline-clip.timeline span{color:#f0cf76}.nested-inspector{display:grid;gap:8px;margin:0 0 14px;padding:10px;border:1px solid #51472d;background:#1d1b14}.nested-inspector small{display:block;color:#a99b73;font:6px Menlo,monospace;line-height:1.55;overflow-wrap:anywhere}.nested-inspector small[role=alert]{color:#dc765f}.nested-inspector button{min-height:28px;border:1px solid #66572f;background:#262116;color:#d7af55;font-size:7px}.nested-inspector button:disabled{opacity:.4}
.media-list article{grid-template-columns:68px minmax(0,1fr) 58px}.media-list article>.media-actions{display:flex;gap:3px}.media-actions button{width:26px;height:26px;display:grid;place-items:center;border:1px solid #3d4037;background:transparent;color:#d7af55;font:7px Menlo,monospace}.media-actions button.ready{border-color:#53684a;color:#83aa72}.media-actions button:disabled{opacity:.45}
.recovery-modal>section{width:min(680px,calc(100vw - 70px));padding:0 24px 22px}.recovery-modal>section>header>svg{color:#d7af55}.recovery-summary{padding:20px 0 4px}.recovery-summary>p{max-width:580px;margin:0;color:#b9bbb2;font-size:10px;line-height:1.7}.recovery-summary dl{display:grid;grid-template-columns:1fr 1fr;margin:18px 0;border-top:1px solid #30322c;border-bottom:1px solid #30322c}.recovery-summary dl>div{display:grid;grid-template-columns:76px 1fr;gap:8px;padding:10px 0}.recovery-summary dl>div:nth-child(odd){border-right:1px solid #30322c}.recovery-summary dt{color:#666960;font-size:7px}.recovery-summary dd{margin:0;color:#d5d6ce;font:8px Menlo,monospace}.recovery-renders{display:grid;grid-template-columns:130px 1fr;gap:5px 10px;margin:12px 0;padding:10px;border-left:2px solid #d7af55;background:#1c1b16}.recovery-renders span{grid-row:1/-1;color:#8e9187;font-size:8px}.recovery-renders code{overflow:hidden;color:#d7af55;font:7px Menlo,monospace;text-overflow:ellipsis;white-space:nowrap}.recovery-summary>small{display:block;margin-top:13px;color:#62655c;font-size:7px;line-height:1.5}.recovery-modal footer{justify-content:space-between}.recovery-modal footer button{min-width:220px;justify-content:center}.recovery-modal footer button:disabled{opacity:.35}
.preview-frame .preview-main{position:absolute!important;inset:0;z-index:1;width:100%!important;height:100%!important;object-fit:contain;pointer-events:none}.preview-frame .preview-transition-incoming{z-index:2}.preview-time{z-index:40}.dissolve-fields{margin:0 0 11px;padding:9px;border:1px solid #66572f;background:#1d1b14}.dissolve-fields small,.dissolve-issue{display:block;color:#9f9169;font:6px Menlo,monospace;line-height:1.55}.dissolve-issue{margin:-4px 0 11px;color:#d08370}.selected-fields input:disabled{opacity:.48;cursor:not-allowed}
.media-list article{content-visibility:auto;contain-intrinsic-size:auto 70px}
</style>
