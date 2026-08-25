<template>
  <section
    class="managed-studio-canvas"
    data-testid="managed-studio-canvas-view"
    :data-theme="canvasTheme"
    :aria-busy="loading"
    :data-runtime-write-gate-state="runtimeWriteGateState"
    :data-raw-projection-loading="rawReferenceProjectionLoading ? '1' : '0'"
    :data-unit-grid-raw-count="String([...unitGridRawPipeline.keys()].length)"
    :data-current-unit-bundle="currentProductionBundle?.fingerprint || ''"
  >
    <header class="canvas-header">
      <p class="canvas-context" data-testid="managed-canvas-context">{{ unitContextText }}</p>
      <details class="canvas-metrics technical-diagnostics" data-testid="managed-canvas-metrics" open>
        <summary data-testid="managed-canvas-metrics-summary">项目概览</summary>
        <div>
          <span><b>{{ overview?.counts.canonicalAssets ?? 0 }}</b> 资产</span>
          <span><b>{{ overview?.counts.units ?? 0 }}</b> 单元</span>
          <span><b>{{ overview?.counts.panels ?? 0 }}</b> 宫格</span>
          <span><b>{{ overview?.counts.media ?? 0 }}</b> 媒体</span>
          <span data-testid="managed-canvas-text-doc-count"><b>{{ overview ? overview.counts.scriptDocuments + overview.counts.promptDocuments : textDocumentCount }}</b> 文稿</span>
        </div>
        <div v-if="timelineProjection.summary.value" class="timeline-projection-summary" data-testid="managed-canvas-timeline-summary">
          <span class="tp-pass"><b>{{ timelineProjection.summary.value.pass }}</b> 通过</span>
          <span class="tp-pending"><b>{{ timelineProjection.summary.value.pendingReview }}</b> 待审</span>
          <span class="tp-progress"><b>{{ timelineProjection.summary.value.inProgress }}</b> 进行中</span>
          <span class="tp-failed"><b>{{ timelineProjection.summary.value.failed }}</b> 失败</span>
          <span class="tp-blocked"><b>{{ timelineProjection.summary.value.blocked }}</b> 阻塞</span>
          <small v-if="timelineProjection.lastUpdated.value">投影于 {{ timelineProjection.lastUpdated.value.slice(11, 19) }}</small>
        </div>
        <div
          v-if="runtimeBuildIdentity"
          class="build-identity"
          data-testid="build-identity"
          :title="`完整构建指纹 ${runtimeBuildIdentity.fingerprint}`"
        >
          构建身份 v{{ runtimeBuildIdentity.packageVersion }} · buildId:{{ runtimeBuildIdentity.buildId.slice(0, 12) }} · sourceDigest:{{ runtimeBuildIdentity.sourceDigest.slice(0, 12) }}
        </div>
        <details v-if="productionDiagnostics" class="diagnostics-detail" data-testid="managed-canvas-diagnostics-detail">
          <summary data-testid="managed-canvas-detailed-diagnostics">详细诊断</summary>
          <div class="diagnostics-grid">
            <span>派发 <b>{{ productionDiagnostics.counts.dispatches }}</b></span>
            <span>结果 <b>{{ productionDiagnostics.counts.results }}</b></span>
            <span>raw <b>{{ productionDiagnostics.counts.rawResults }}</b></span>
            <span>labeled <b>{{ productionDiagnostics.counts.labeledResults }}</b></span>
            <span>计划 <b>{{ productionDiagnostics.counts.plans }}</b></span>
            <span>Review: 通过<b>{{ productionDiagnostics.reviewDistribution.pass }}</b> 返工<b>{{ productionDiagnostics.reviewDistribution.rework }}</b> 拒<b>{{ productionDiagnostics.reviewDistribution.reject }}</b> 未审<b>{{ productionDiagnostics.reviewDistribution.unreviewed }}</b></span>
            <span>Run: 成功<b>{{ productionDiagnostics.runStateDistribution.succeeded }}</b> 失败<b>{{ productionDiagnostics.runStateDistribution.failed }}</b> 取消<b>{{ productionDiagnostics.runStateDistribution.cancelled }}</b> 飞行<b>{{ productionDiagnostics.runStateDistribution.inFlight }}</b></span>
            <small>诊断耗时 {{ productionDiagnostics.durationMs }}ms</small>
          </div>
        </details>
      </details>
      <div class="header-actions">
        <button
          type="button"
          data-testid="managed-canvas-director-toggle"
          :class="{ active: directorPanelOpen }"
          title="导演动作面板（⌘/）"
          @click="toggleDirectorPanel">
          导演
        </button>
        <button
          type="button"
          class="primary-start"
          data-testid="managed-canvas-primary-start"
          :disabled="loading || workflowBusy || !unitDetail || generationProjectionDegraded || runtimeWriteBlocked"
          :title="generationProjectionDegraded
            ? generationProjectionHint
            : runtimeWriteBlocked
              ? runtimeWriteGateHint
            : (!unitDetail ? '请先从素材库添加 15 秒分镜' : undefined)"
          @click="primaryStart">
          {{ generationProjectionDegraded ? "账本待恢复" : (workflowBusy ? "正在预检并记录派发…" : (unitDetail ? `准备并记录 ${unitDetail.panels.length} 格派发` : "准备派发")) }}
        </button>
      </div>
    </header>

    <div
      v-if="runtimeWriteGateState === 'blocked' || runtimeWriteGateState === 'unavailable'"
      class="runtime-restart-banner"
      data-testid="managed-canvas-runtime-restart-banner"
      role="alert">
      <strong>{{ runtimeWriteGateState === "blocked" ? "当前源码无限画布必须重启" : "运行时身份暂不可核验" }}</strong>
      <span v-if="runtimeWriteGateState === 'blocked'">
        已加载工件与源码身份不一致或启动后发生变化；所有写入与自动扫描均已关闭。
        boot {{ runtimeWriteGate?.bootSourceDigest?.slice(0, 12) || "unknown" }} /
        artifact {{ runtimeWriteGate?.artifactSourceDigest?.slice(0, 12) || "unbound" }} /
        current {{ runtimeWriteGate?.currentSourceDigest?.slice(0, 12) || "unknown" }}
      </span>
      <span v-else>运行时诊断没有返回可验证身份；画布保持只读，请检查诊断后再继续写入。</span>
    </div>

    <div v-if="unitLeaseDisplayHint" class="unit-lease-banner" data-testid="managed-canvas-unit-lease-banner" role="status">
      <span>🔒 {{ unitLeaseDisplayHint }}</span>
    </div>

    <div
      v-if="localProductionPreviewLoading || localProductionPreview?.applicability === 'eligible'"
      class="source-unit-preview-banner"
      data-testid="managed-canvas-source-unit-preview"
      role="status">
      <template v-if="localProductionPreviewLoading">
        正在从只读来源核对可物化的真实剧情单元…
      </template>
      <template v-else-if="localProductionPreview">
        来源证据可解析
        <b>{{ localProductionPreview.unitCount }}</b> 个单元 /
        <b>{{ localProductionPreview.panelCount }}</b> 格；
        当前受管库已有 <b>{{ overview?.counts.units ?? 0 }}</b> 个单元。
        <strong :class="{ blocked: !localSourceReadyForMaterialization }">
          {{ localSourceReadyForMaterialization
            ? "来源已同步，可显式选择最多 3 个单元经命令账本物化"
            : `来源未同步（${localSourceTruthLabel}），当前只允许查看预览` }}
        </strong>
        <span>资产权威未解析前禁止正式生图。</span>
      </template>
    </div>

    <div class="result-strip" data-testid="managed-canvas-result-status" role="status" aria-live="polite">
      <span class="status-dot" :class="workflowBusy ? 'busy' : ''"></span>
      <b>{{ simpleWorkflowStatus }}</b>
      <span>{{ simpleWorkflowHint }}</span>
      <span
        v-if="overview"
        :class="['generation-projection-status', { degraded: generationProjectionDegraded }]"
        data-testid="managed-canvas-generation-projection"
        :title="generationProjectionHint">
        {{ generationProjectionDegraded ? "生成账本待恢复" : "生成账本已同步" }}
      </span>
      <div class="timeline-progress-filter" data-testid="managed-canvas-timeline-progress-filter">
        <label>
          <span class="sr-only">进度搜索</span>
          <input
            ref="timelineProgressQueryEl"
            v-model.trim="timelineProgressQuery"
            type="search"
            data-testid="managed-canvas-timeline-progress-query"
            placeholder="搜集数/单元/角色/场景/SHA/审片状态"
            @input="scheduleFocusTimelineSearchResult"
            @keydown.enter.prevent="onTimelineSearchEnter" />
        </label>
        <select v-model="timelineProgressReview" data-testid="managed-canvas-timeline-progress-review" @change="focusTimelineSearchResult">
          <option value="">全部状态</option>
          <option value="any-pending">待处理</option>
          <option value="pass">通过</option>
          <option value="rework">返工</option>
          <option value="reject">拒绝</option>
          <option value="none">待生</option>
        </select>
        <span v-if="timelineProgressFilterResult" data-testid="managed-canvas-timeline-progress-count">
          命中 {{ timelineProgressFilterResult.unitCount }} 单元 / {{ timelineProgressFilterResult.panelCount }} 格
        </span>
      </div>
      <ol v-if="panelTimelineStrip.length" class="panel-timeline-strip" data-testid="managed-canvas-panel-timeline" role="toolbar" aria-label="当前单元宫格时间线">
        <li
          v-for="(row, index) in panelTimelineStrip"
          :key="row.panelId"
          :class="['timeline-chip', `review-${row.reviewDecision}`, { ready: row.hasRaw && row.hasLabeled, muted: timelineProgressDimmedPanelIds.has(row.panelId) }]"
          :title="`${row.startSeconds}s · 格${row.ordinal}`">
          <button type="button" :tabindex="panelTimelineActiveChipIndex === index ? 0 : -1" @click="focusPanelOnCanvas(row.panelId)" @focus="panelTimelineRovingIndex = index">
            <em>{{ row.startSeconds }}s</em>
            <span>P{{ row.ordinal }}</span>
            <small>{{ timelineChipLabel(row) }}</small>
          </button>
        </li>
      </ol>
      <details class="advanced-workflow">
        <summary data-testid="managed-canvas-advanced-workflow">高级操作</summary>
        <div class="workflow-toolbar" data-testid="managed-canvas-workflow-toolbar" aria-label="工作流组">
          <span data-testid="managed-canvas-selection-count">已选宫格 {{ selectedPanelIds.length }}</span>
          <button type="button" data-testid="managed-canvas-create-workflow" :disabled="loading || selectedPanelIds.length === 0 || workflowBusy" @click="createWorkflowFromSelection">保存所选</button>
          <button type="button" data-testid="managed-canvas-run-workflow" :disabled="loading || workflowBusy || workflowGroups.length === 0 || !unitDetail" @click="runLastWorkflowGroup">执行最近工作流组</button>
          <span v-if="workflowGroups.length" data-testid="managed-canvas-workflow-count">工作流 {{ workflowGroups.length }}</span>
          <span v-if="lastWorkflowTitle" data-testid="managed-canvas-last-workflow">最近：{{ lastWorkflowTitle }}</span>
          <span v-if="lastWorkflowRunSummary" data-testid="managed-canvas-workflow-run-summary">{{ lastWorkflowRunSummary }}</span>
        </div>
      </details>
    </div>

    <div v-if="errorMessage" class="canvas-error" role="alert">
      <span>{{ errorMessage }}</span>
      <button type="button" data-testid="managed-canvas-error-close" aria-label="关闭错误" @click="closeCanvasError">×</button>
    </div>

    <div
      class="canvas-layout"
      :class="{
        'library-open': libraryOpen,
        'global-resources-open': libraryOpen && libraryMode === 'global',
        'inspector-open': Boolean(selection),
      }">
      <aside
        v-if="libraryOpen && libraryMode === 'global'"
        id="managed-canvas-global-resource-library"
        class="canvas-library global-resource-library"
        aria-label="全部剧本版本图片"
        data-testid="managed-canvas-global-resource-library">
        <header>
          <div>
            <span class="eyebrow">剧本资源</span>
            <h3>全部剧本版本图片</h3>
            <small class="readonly-badge">只读 · 不写入当前工程</small>
          </div>
          <div class="global-resource-header-actions">
            <button
              type="button"
              data-testid="managed-canvas-open-resource-center"
              @click="emit('openResourceCenter')">
              打开总资源中心
            </button>
            <button type="button" data-testid="managed-canvas-global-library-close" aria-label="关闭剧本资源" @click="closeLibrary">×</button>
          </div>
        </header>

        <p
          v-if="globalResourcePage"
          class="global-resource-summary"
          data-testid="managed-canvas-global-resource-summary">
          共 <b>{{ globalResourceCounts.total }}</b> 张：
          人物 {{ globalResourceCounts.character }} ·
          场景 {{ globalResourceCounts.scene }} ·
          道具 {{ globalResourceCounts.prop }} ·
          风格 {{ globalResourceCounts.style }}。
          已读取 {{ globalResourcePage.readableProjectCount ?? 0 }} /
          {{ globalResourcePage.registeredProjectCount ?? 0 }} 个受管剧本。
          <template v-if="globalResourcePage.unavailableProjects?.length">
            {{ globalResourcePage.unavailableProjects.length }} 个剧本暂不可读取。
          </template>
        </p>
        <p v-else class="global-resource-summary">人物、场景、道具和风格按名称归类；每页最多显示 36 张。</p>

        <nav class="library-tabs global-resource-tabs" aria-label="剧本资源类型">
          <button
            v-for="(category, index) in globalResourceCategories"
            :key="category.kind"
            type="button"
            :data-testid="`managed-canvas-global-resource-${category.kind}`"
            :class="{ active: globalResourceCategory === category.kind }"
            :disabled="globalResourceLoading"
            :tabindex="!globalResourceLoading && globalResourceTabActiveIndex === index ? 0 : -1"
            @focus="globalResourceTabRovingIndex = index"
            @click="openGlobalResourcesFor(category.kind)">
            {{ category.label }}
            <small v-if="globalResourceCounts[category.kind]">{{ globalResourceCounts[category.kind] }}</small>
          </button>
        </nav>

        <section class="library-section global-resource-section">
          <label>
            <span>搜索图片对应的人物、场景、道具名称或 SHA</span>
            <input
              v-model.trim="globalResourceSearch"
              type="search"
              placeholder="输入名称或 SHA，按回车搜索"
              @input="invalidateGlobalResourceRequest"
              @keyup.enter="resetGlobalResources" />
          </label>
          <p v-if="!globalResourceApi" class="library-empty" role="alert">当前桌面适配层未接入全部剧本资源。</p>
          <p v-else-if="globalResourceLoading && !globalResourcePage" class="library-note" role="status">正在读取全部剧本版本图片…</p>
          <p v-else-if="globalResourceError" class="library-empty" role="alert">{{ globalResourceError }}</p>
          <p v-else-if="globalResourcePage && globalResourcePage.items.length === 0" class="library-empty">
            {{ globalResourceSearch ? `没有找到与「${globalResourceSearch}」匹配的${globalResourceCategoryLabel(globalResourceCategory)}` : `还没有已归类的${globalResourceCategoryLabel(globalResourceCategory)}图片` }}
          </p>

          <div
            v-if="globalResourcePage?.items.length"
            class="global-resource-list-viewport"
            data-testid="managed-canvas-global-resource-viewport">
            <ul class="global-resource-list" aria-label="全部剧本版本图片列表">
              <li
                v-for="(entry, index) in globalResourcePage.items"
                :key="entry.id"
                :data-resource-key="entry.id"
                class="global-resource-card"
                :tabindex="globalResourceListActiveIndex === index ? 0 : -1"
                data-testid="managed-canvas-global-resource-item"
                @focus="globalResourceListRovingIndex = index">
                <figure>
                  <img
                    v-if="entry.thumbnailUrl"
                    :src="entry.thumbnailUrl"
                    :alt="`${entry.title}缩略图`"
                    loading="lazy"
                    decoding="async" />
                  <span v-else>{{ globalResourceCategoryLabel(globalResourceCategory).slice(0, 1) }}</span>
                </figure>
                <article>
                  <div class="global-resource-card-heading">
                    <b>{{ entry.title }}</b>
                    <em>只读</em>
                  </div>
                  <small class="global-resource-source">来源剧本：{{ globalResourceSourceLabel(entry) }}</small>
                  <ul
                    v-if="entry.resourceImage?.associations.length"
                    class="global-resource-associations"
                    data-testid="managed-canvas-global-resource-associations">
                    <li
                      v-for="association in entry.resourceImage.associations"
                      :key="`${association.assetId}:${association.versionId}`">
                      <b>{{ association.name }}</b>
                      <span>
                        {{ globalResourceCategoryLabel(association.category) }} ·
                        v{{ association.versionOrdinal }} ·
                        {{ globalResourceReviewLabel(association.reviewStatus) }} ·
                        {{ association.isPrimary ? "Primary" : "非 Primary" }}
                      </span>
                    </li>
                  </ul>
                  <small v-else>{{ entry.subtitle || entry.mediaSha256?.slice(0, 12) || "未登记版本关系" }}</small>
                </article>
              </li>
            </ul>
          </div>

          <div v-if="globalResourcePage?.items.length" class="pager global-resource-pager">
            <button
              type="button"
              data-testid="managed-canvas-global-resources-prev"
              :disabled="!globalResourceCursorStack.length || globalResourceLoading"
              @click="globalResourcesPrevious">
              上一页
            </button>
            <span class="pager-position">
              第 {{ globalResourceCursorStack.length + 1 }} 页 ·
              本页 {{ globalResourcePage.items.length }} /
              共 {{ globalResourcePage.total ?? globalResourcePage.items.length }} 张
            </span>
            <button
              type="button"
              data-testid="managed-canvas-global-resources-next"
              :disabled="!globalResourcePage.nextCursor || globalResourceLoading"
              @click="globalResourcesNext">
              {{ globalResourceLoading ? "读取中…" : "下一页" }}
            </button>
          </div>
        </section>
      </aside>

      <aside v-else-if="libraryOpen" id="managed-canvas-library" class="canvas-library" aria-label="素材库">
        <header>
          <div><span class="eyebrow">素材库</span><h3>放到画布</h3></div>
          <button type="button" data-testid="managed-canvas-library-close" aria-label="关闭素材库" @click="closeLibrary">×</button>
        </header>
        <nav class="library-tabs" aria-label="素材类型">
          <button
            v-for="(tab, index) in libraryTabs"
            :key="tab.kind"
            type="button"
            :class="{ active: libraryTab === tab.kind }"
            :tabindex="libraryTabActiveIndex === index ? 0 : -1"
            @focus="libraryTabRovingIndex = index"
            @click="openLibraryFor(tab.kind)">{{ tab.label }}</button>
        </nav>

        <section v-if="libraryTab === 'character' || libraryTab === 'scene' || libraryTab === 'prop' || libraryTab === 'style'" class="library-section">
          <form
            v-if="libraryTab === 'character' || libraryTab === 'scene' || libraryTab === 'prop'"
            class="character-ingest"
            data-testid="managed-canvas-character-ingest"
            @submit.prevent="submitCharacterIngest">
            <label>
              <span>{{ assetCategoryLabel(libraryTab) }}名称</span>
              <input v-model.trim="characterIngestName" :disabled="characterIngestBusy" :placeholder="libraryTab === 'character' ? '例如：阿航' : libraryTab === 'scene' ? '例如：山洞内景' : '例如：黄金面具'" />
            </label>
            <label>
              <span>别名（可选，逗号分隔）</span>
              <input v-model.trim="characterIngestAliases" data-testid="managed-canvas-character-aliases-input" :disabled="characterIngestBusy" placeholder="例如：阿航，小航" />
            </label>
            <label>
              <span>说明（可选）</span>
              <textarea v-model.trim="characterIngestDescription" data-testid="managed-canvas-character-description-input" :disabled="characterIngestBusy" maxlength="20000" rows="2" placeholder="空则使用默认入库说明" />
            </label>
            <div class="character-ingest-files" :class="{ 'character-ingest-files-single': libraryTab !== 'character' }">
              <button type="button" data-testid="managed-canvas-character-pick-image" :disabled="characterIngestBusy || pickingCharacterMedia" :title="(characterIngestBusy || pickingCharacterMedia) ? (libraryTab === 'character' ? '正在处理，不能再选择角色参考图' : '正在处理，不能再选择参考图') : undefined" @click="pickCharacterImage">{{ characterImagePath ? "已选参考图" : "上传图片" }}</button>
              <button v-if="libraryTab === 'character'" type="button" data-testid="managed-canvas-character-pick-audio" :disabled="characterIngestBusy || pickingCharacterMedia" :title="(characterIngestBusy || pickingCharacterMedia) ? '正在处理，不能再选择角色音频' : undefined" @click="pickCharacterAudio">{{ characterAudioPath ? "已选音频" : "上传音频" }}</button>
              <button v-if="libraryTab === 'character'" type="button" data-testid="managed-canvas-character-pick-side" :disabled="characterIngestBusy || pickingCharacterMedia" :title="(characterIngestBusy || pickingCharacterMedia) ? '正在处理，不能再选择侧视图' : undefined" @click="pickCharacterView('side')">{{ characterSideImagePath ? "已选侧视图" : "上传侧视图" }}</button>
              <button v-if="libraryTab === 'character'" type="button" data-testid="managed-canvas-character-pick-back" :disabled="characterIngestBusy || pickingCharacterMedia" :title="(characterIngestBusy || pickingCharacterMedia) ? '正在处理，不能再选择背视图' : undefined" @click="pickCharacterView('back')">{{ characterBackImagePath ? "已选背视图" : "上传背视图" }}</button>
            </div>
            <p class="library-note">{{ characterIngestHint }}</p>
            <button
              class="character-ingest-save"
              type="submit"
              data-testid="managed-canvas-character-save"
              :disabled="characterIngestBusy || !characterIngestName || !characterImagePath"
              :title="characterIngestBusy ? '正在入库，不能再提交' : undefined">
              {{ characterIngestBusy ? "入库中" : `存入${assetCategoryLabel(libraryTab)}库并放到画布` }}
            </button>
          </form>
          <label><span>搜索名称、别名或权威 SHA</span><input v-model.trim="assetSearch" placeholder="输入名称、别名或 SHA，按回车搜索" @keyup.enter="resetAssets" /></label>
          <p v-if="loading && !assetsPage" class="library-note" role="status">正在加载…</p>
          <p v-else-if="assetsPage && assetsPage.page.items.length === 0" class="library-empty">{{ assetSearch ? `没有找到与「${assetSearch}」匹配的${assetCategoryLabel(libraryTab)}` : `还没有可用的${assetCategoryLabel(libraryTab)}，先去素材中心添加` }}</p>
          <div
            class="library-list-viewport"
            data-testid="managed-canvas-assets-virtual-viewport"
            @scroll="onAssetsLibraryScroll">
            <div class="library-list-spacer" :style="{ height: `${assetsVirtualWindow.totalHeight}px` }">
              <ul class="library-list" :style="{ transform: `translateY(${assetsVirtualWindow.offsetTop}px)` }">
                <li v-for="(asset, index) in visibleLibraryAssets" :key="asset.id">
                  <button type="button" class="library-item" draggable="true" data-testid="managed-canvas-library-drag" :tabindex="assetListActiveIndex === index ? 0 : -1" @focus="assetListRovingIndex = index" @click="selectAsset(asset)" @dragstart="onLibraryDragStart($event, `asset:${asset.id}`)">
                    <span class="item-thumb"><img v-if="authorityThumbUrl(asset.authorityThumbnailRecipeKey)" :src="authorityThumbUrl(asset.authorityThumbnailRecipeKey)" :alt="asset.name" loading="lazy" decoding="async" /><i v-else>{{ assetCategoryLabel(asset.category).slice(0, 1) }}</i></span>
                    <span><b>{{ asset.name }}</b><small data-testid="managed-canvas-library-alias">{{ characterLibrarySubtitle(asset) }}</small></span>
                  </button>
                  <button type="button" class="pin-button" :disabled="loading || pinActionBusy" @click="togglePinnedNode(`asset:${asset.id}`)">{{ isPinned(`asset:${asset.id}`) ? "移出画布" : "添加" }}</button>
                </li>
              </ul>
            </div>
          </div>
          <div class="pager">
            <button type="button" data-testid="managed-canvas-assets-prev" :disabled="!assetCursorStack.length || loading" @click="assetsPrevious">上一页</button>
            <span class="pager-position">第 {{ assetCursorStack.length + 1 }} 页</span>
            <button type="button" data-testid="managed-canvas-assets-next" :disabled="!assetsPage?.page.nextCursor || loading" @click="assetsNext">下一页</button>
          </div>
        </section>

        <section v-else-if="libraryTab === 'script' || libraryTab === 'prompt'" class="library-section">
          <p class="library-note">只显示已保存的{{ libraryTab === "script" ? "剧本" : "提示词" }}，画布不会复制正文。</p>
          <p v-if="loading && !textDocuments.length" class="library-note" role="status">正在加载…</p>
          <p v-else-if="!loading && filteredTextDocuments.length === 0" class="library-empty">还没有已保存的{{ libraryTab === "script" ? "剧本" : "提示词" }}</p>
          <ul class="library-list text-list">
            <li v-for="(doc, index) in filteredTextDocuments" :key="`${doc.kind}:${doc.id}`">
              <button type="button" class="library-item" draggable="true" data-testid="managed-canvas-library-drag" :tabindex="textListActiveIndex === index ? 0 : -1" @focus="textListRovingIndex = index" @click="selection = { kind: doc.kind, doc }" @dragstart="onLibraryDragStart($event, `${doc.kind}:${doc.id}`)"><span class="item-type">{{ doc.kind === "script" ? "剧" : "词" }}</span><span><b>{{ doc.title }}</b><small>第 {{ doc.revision }} 版</small></span></button>
              <button type="button" class="pin-button" :disabled="loading || pinActionBusy" @click="togglePinnedNode(`${doc.kind}:${doc.id}`)">{{ isPinned(`${doc.kind}:${doc.id}`) ? "移出画布" : "添加" }}</button>
            </li>
          </ul>
        </section>

        <section v-else-if="libraryTab === 'media'" class="library-section" data-testid="managed-canvas-media-library">
          <label>
            <span>搜索当前工程图片、视频或音频</span>
            <input
              v-model.trim="mediaSearch"
              type="search"
              placeholder="名称、类型或 SHA，按回车搜索"
              @keyup.enter="resetMedia" />
          </label>
          <div class="facet-row">
            <select v-model="mediaKindFilter" aria-label="媒体类型" @change="resetMedia">
              <option value="all">全部媒体</option>
              <option value="image">图片</option>
              <option value="video">视频</option>
              <option value="audio">音频</option>
            </select>
          </div>
          <p class="library-note">添加到画布后，使用节点上的“拖出”手柄复制到桌面或其他软件；画布原件不会删除。</p>
          <p v-if="loading && !mediaPage" class="library-note" role="status">正在加载媒体…</p>
          <p v-else-if="mediaPage && mediaPage.items.length === 0" class="library-empty">
            {{ mediaSearch ? `没有找到与「${mediaSearch}」匹配的媒体` : "当前工程还没有此类媒体" }}
          </p>
          <ul v-else class="library-list media-library-list">
            <li v-for="(media, index) in mediaPage?.items ?? []" :key="media.sha256">
              <div class="library-item media-library-item" draggable="true" data-testid="managed-canvas-library-drag" :tabindex="mediaListActiveIndex === index ? 0 : -1" @focus="mediaListRovingIndex = index" @dragstart="onLibraryDragStart($event, mediaNodeId(media.sha256))">
                <span class="item-thumb">
                  <img
                    v-if="media.kind === 'image' && media.thumbnail?.url"
                    :src="media.thumbnail.url"
                    :alt="media.sourceBasename"
                    loading="lazy"
                    decoding="async" />
                  <i v-else>{{ mediaKindMark(media.kind) }}</i>
                </span>
                <span>
                  <b>{{ media.sourceBasename }}</b>
                  <small>{{ mediaKindLabel(media.kind) }} · {{ formatCanvasMediaBytes(media.sizeBytes) }} · {{ media.sha256.slice(0, 12) }}</small>
                </span>
              </div>
              <button
                type="button"
                class="pin-button"
                :disabled="loading || pinActionBusy"
                :data-testid="`managed-canvas-pin-media-${media.kind}`"
                @click="togglePinnedNode(mediaNodeId(media.sha256))">
                {{ isPinned(mediaNodeId(media.sha256)) ? "移出画布" : "添加" }}
              </button>
            </li>
          </ul>
          <div class="pager">
            <button
              type="button"
              data-testid="managed-canvas-media-prev"
              :disabled="!mediaCursorStack.length || loading"
              @click="mediaPrevious">
              上一页
            </button>
            <span class="pager-position">第 {{ mediaCursorStack.length + 1 }} 页 · 每页最多 36 项</span>
            <button
              type="button"
              data-testid="managed-canvas-media-next"
              :disabled="!mediaPage?.nextCursor || loading"
              @click="mediaNext">
              下一页
            </button>
          </div>
        </section>

        <section v-else class="library-section">
          <div class="facet-row">
            <select v-model="seasonFilter" aria-label="季" @change="resetUnits"><option value="">全部季</option><option v-for="season in unitsPage?.seasons ?? []" :key="season.id" :value="season.id">{{ season.label }}</option></select>
            <select v-model="episodeFilter" aria-label="集" @change="resetUnits"><option value="">全部集</option><option v-for="episode in filteredEpisodes" :key="`${episode.seasonId}:${episode.id}`" :value="episode.id">{{ episode.label }}</option></select>
          </div>
          <p v-if="loading && !unitsPage" class="library-note" role="status">正在加载…</p>
          <p v-else-if="unitsPage && unitsPage.page.items.length === 0" class="library-empty">没有符合条件的 15 秒分镜</p>
          <ul class="library-list unit-list">
            <li v-for="(unit, index) in unitsPage?.page.items ?? []" :key="unit.id">
              <button type="button" class="library-item" :tabindex="unitListActiveIndex === index ? 0 : -1" @focus="unitListRovingIndex = index" @click="selectUnit(unit)"><span class="item-type">15s</span><span><b>{{ getUnitDualLabel(unit.id) || unit.label }}</b><small>{{ unit.panelCount }} 宫格 · {{ productionStatusLabel(unit.status) }}</small></span></button>
              <button type="button" class="pin-button" :disabled="isPinned(`unit:${unit.id}`) || loading || addUnitActionBusy" @click="addUnitToWorkspace(unit)">{{ isPinned(`unit:${unit.id}`) ? "已添加" : "添加" }}</button>
            </li>
          </ul>
          <div class="pager">
            <button type="button" data-testid="managed-canvas-units-prev" :disabled="!unitCursorStack.length || loading" @click="unitsPrevious">上一页</button>
            <span class="pager-position">第 {{ unitCursorStack.length + 1 }} 页</span>
            <button type="button" data-testid="managed-canvas-units-next" :disabled="!unitsPage?.page.nextCursor || loading" @click="unitsNext">下一页</button>
          </div>
        </section>
      </aside>

      <main
        class="flow-shell"
        :class="{ compact: zoom < 0.42, 'connect-assist': connectMode, 'external-drop-active': externalDropActive, 'space-pan': spacePanHeld }"
        data-testid="managed-canvas-flow-shell"
        @dragenter.prevent="onExternalDragEnter"
        @dragover.prevent="onExternalDragOver"
        @dragleave="onExternalDragLeave"
        @drop.prevent="onExternalDrop">
        <nav class="floating-tools" aria-label="画布工具">
          <div class="add-menu-wrap">
            <button ref="addTriggerEl" type="button" data-testid="managed-canvas-add-node" :aria-expanded="addMenuOpen" aria-controls="managed-canvas-add-menu" :tabindex="floatingToolbarActiveIndex === 0 ? 0 : -1" @focus="floatingToolbarRovingIndex = 0" @click="toggleAddMenu"><Plus :size="16" aria-hidden="true" /><span>添加</span></button>
            <div v-if="addMenuOpen" id="managed-canvas-add-menu" class="add-menu">
              <button
                v-for="(tab, index) in libraryTabs"
                :key="tab.kind"
                type="button"
                :tabindex="addMenuActiveIndex === index ? 0 : -1"
                @focus="addMenuRovingIndex = index"
                @click="chooseAddKind(tab.kind)"><i>{{ tab.mark }}</i>{{ tab.label }}</button>
            </div>
          </div>
          <button
            type="button"
            data-testid="managed-canvas-open-library"
            :class="{ active: libraryOpen && libraryMode === 'current' }"
            :aria-expanded="libraryOpen && libraryMode === 'current'"
            aria-controls="managed-canvas-library"
            :tabindex="floatingToolbarActiveIndex === 1 ? 0 : -1"
            @focus="floatingToolbarRovingIndex = 1"
            @click="toggleLibrary">
            <LibraryBig :size="16" aria-hidden="true" /><span>素材库</span>
          </button>
          <button
            type="button"
            data-testid="managed-canvas-open-global-resources"
            :class="{ active: libraryOpen && libraryMode === 'global' }"
            :aria-expanded="libraryOpen && libraryMode === 'global'"
            aria-controls="managed-canvas-global-resource-library"
            title="查看所有受管剧本中已归类的人物、场景、道具和风格版本图片"
            :tabindex="floatingToolbarActiveIndex === 2 ? 0 : -1"
            @focus="floatingToolbarRovingIndex = 2"
            @click="toggleGlobalResourceLibrary">
            <LibraryBig :size="16" aria-hidden="true" />
            <span>剧本资源</span>
            <small v-if="globalResourceCounts.total">{{ globalResourceCounts.total }}</small>
          </button>
          <button type="button" data-testid="managed-canvas-connect-mode" :class="{ active: connectMode }" :aria-pressed="connectMode" :tabindex="floatingToolbarActiveIndex === 3 ? 0 : -1" @focus="floatingToolbarRovingIndex = 3" @click="toggleConnectMode"><ArrowUpRight :size="16" aria-hidden="true" /><span>连线</span></button>
          <button ref="helpTriggerEl" type="button" data-testid="managed-canvas-help" :aria-expanded="helpOpen" aria-controls="managed-canvas-help-card" :tabindex="floatingToolbarActiveIndex === 4 ? 0 : -1" @focus="floatingToolbarRovingIndex = 4" @click="toggleHelp"><CircleHelp :size="16" aria-hidden="true" /><span>帮助</span></button>
        </nav>

        <div v-if="loading && !nodes.length" class="flow-loading" role="status">正在打开画布…</div>
        <VueFlow
          v-else
          id="managed-studio-flow"
          v-model:nodes="nodes"
          v-model:edges="edges"
          :node-types="nodeTypes"
          :min-zoom="0.14"
          :max-zoom="1.8"
          :default-viewport="defaultViewport"
          :only-render-visible-elements="true"
          :nodes-connectable="true"
          :connection-mode="ConnectionMode.Loose"
          :connect-on-click="false"
          :edges-updatable="false"
          :nodes-draggable="true"
          :fit-view-on-init="!hasPersistedLayout"
          :selection-key-code="true"
          :pan-on-drag="panOnDragButtons"
          :delete-key-code="() => false"
          @connect="onConnect"
          @edge-click="onDraftEdgeClick"
          @node-click="onNodeClick"
          @node-double-click="onNodeDoubleClick"
          @node-drag-start="onNodeDragStart"
          @node-drag="onNodeDrag"
          @node-drag-stop="onNodeDragStop"
          @nodes-change="onNodesChange"
          @move="onMove"
          @move-end="onMoveEnd">
          <Background :pattern-color="canvasThemeAssets.patternColor" :gap="24" :size="1" />
          <Controls position="bottom-left" @zoom-in="onControlViewportChanged" @zoom-out="onControlViewportChanged">
            <template #icon-zoom-in><Plus :size="14" aria-hidden="true" /><span class="sr-only">放大画布</span></template>
            <template #icon-zoom-out><Minus :size="14" aria-hidden="true" /><span class="sr-only">缩小画布</span></template>
            <template #control-fit-view>
              <ControlButton
                class="vue-flow__controls-fitview"
                title="适配全部节点"
                aria-label="适配全部节点"
                data-testid="managed-canvas-fit-view"
                @click="onFitViewControl">
                <Scan :size="14" aria-hidden="true" />
                <span class="sr-only">适配全部节点</span>
              </ControlButton>
            </template>
            <template #icon-unlock><LockOpen :size="14" aria-hidden="true" /><span class="sr-only">锁定画布交互</span></template>
            <template #icon-lock><Lock :size="14" aria-hidden="true" /><span class="sr-only">启用画布交互</span></template>
          </Controls>
          <MiniMap
            v-if="showMiniMap"
            data-testid="managed-canvas-minimap"
            tabindex="0"
            position="bottom-right"
            aria-label="画布节点小地图"
            :pannable="true"
            :zoomable="true"
            :mask-color="canvasThemeAssets.minimapMaskColor"
            :node-color="canvasThemeAssets.minimapNodeColor">
            <!-- Vue Flow 默认 MiniMapNode 会把业务节点 id 复制到 SVG rect，和主画布节点形成重复 DOM id。 -->
            <template #node-managedStudio="{ id, position, dimensions, color, selected, dragging }">
              <rect
                class="vue-flow__minimap-node"
                :class="{ selected, dragging }"
                :data-node-id="id"
                tabindex="-1"
                focusable="true"
                :x="position.x"
                :y="position.y"
                :rx="5"
                :ry="5"
                :width="dimensions.width"
                :height="dimensions.height"
                :fill="color"
                stroke="transparent"
                :stroke-width="2"
                shape-rendering="crispEdges" />
            </template>
          </MiniMap>
        </VueFlow>

        <div v-if="connectMode" class="connect-banner" role="status">
          <span>连线模式：点击一个节点的＋，再点击目标节点的＋完成连线</span>
          <button type="button" data-testid="managed-canvas-connect-exit" @click="toggleConnectMode">退出（Esc）</button>
        </div>

        <div v-if="snapLines.length" class="snap-guides" aria-hidden="true">
          <div v-for="line in snapLines" :key="`${line.axis}-${line.position}`" :class="['snap-guide', line.axis]" :style="snapGuideStyle(line)"></div>
        </div>

        <div class="bottom-tools" aria-label="视图工具">
          <button type="button" title="适配全部节点" :tabindex="bottomToolbarTabIndex('fit')" @focus="bottomToolbarFocusKey = 'fit'" @click="fitCanvas">适配</button>
          <button type="button" data-testid="managed-canvas-undo" :disabled="!canUndoLayout || isDragging" :tabindex="bottomToolbarTabIndex('undo', !canUndoLayout || isDragging)" title="撤销布局（⌘Z）" @focus="bottomToolbarFocusKey = 'undo'" @click="undoLayout"><Undo2 :size="13" aria-hidden="true" /><span>撤销</span></button>
          <button type="button" data-testid="managed-canvas-redo" :disabled="!canRedoLayout || isDragging" :tabindex="bottomToolbarTabIndex('redo', !canRedoLayout || isDragging)" title="重做布局（⌘⇧Z / Ctrl+Y）" @focus="bottomToolbarFocusKey = 'redo'" @click="redoLayout"><Redo2 :size="13" aria-hidden="true" /><span>重做</span></button>
          <span v-if="selectionCount >= 2" class="align-tools" data-testid="managed-canvas-align-tools">
            <button type="button" title="左对齐" aria-label="左对齐" :disabled="isDragging" :tabindex="bottomToolbarTabIndex('align-left', isDragging)" @focus="bottomToolbarFocusKey = 'align-left'" @click="applyAlign('left')"><AlignStartVertical :size="13" aria-hidden="true" /></button>
            <button type="button" title="水平居中对齐" aria-label="水平居中对齐" :disabled="isDragging" :tabindex="bottomToolbarTabIndex('align-centerX', isDragging)" @focus="bottomToolbarFocusKey = 'align-centerX'" @click="applyAlign('centerX')"><AlignCenterVertical :size="13" aria-hidden="true" /></button>
            <button type="button" title="右对齐" aria-label="右对齐" :disabled="isDragging" :tabindex="bottomToolbarTabIndex('align-right', isDragging)" @focus="bottomToolbarFocusKey = 'align-right'" @click="applyAlign('right')"><AlignEndVertical :size="13" aria-hidden="true" /></button>
            <button type="button" title="顶对齐" aria-label="顶对齐" :disabled="isDragging" :tabindex="bottomToolbarTabIndex('align-top', isDragging)" @focus="bottomToolbarFocusKey = 'align-top'" @click="applyAlign('top')"><AlignStartHorizontal :size="13" aria-hidden="true" /></button>
            <button type="button" title="垂直居中对齐" aria-label="垂直居中对齐" :disabled="isDragging" :tabindex="bottomToolbarTabIndex('align-centerY', isDragging)" @focus="bottomToolbarFocusKey = 'align-centerY'" @click="applyAlign('centerY')"><AlignCenterHorizontal :size="13" aria-hidden="true" /></button>
            <button type="button" title="底对齐" aria-label="底对齐" :disabled="isDragging" :tabindex="bottomToolbarTabIndex('align-bottom', isDragging)" @focus="bottomToolbarFocusKey = 'align-bottom'" @click="applyAlign('bottom')"><AlignEndHorizontal :size="13" aria-hidden="true" /></button>
            <button v-if="selectionCount >= 3" type="button" title="水平等距分布" :disabled="isDragging" :tabindex="bottomToolbarTabIndex('dist-x', isDragging)" @focus="bottomToolbarFocusKey = 'dist-x'" @click="applyDistribute('x')">水平均分</button>
            <button v-if="selectionCount >= 3" type="button" title="垂直等距分布" :disabled="isDragging" :tabindex="bottomToolbarTabIndex('dist-y', isDragging)" @focus="bottomToolbarFocusKey = 'dist-y'" @click="applyDistribute('y')">垂直均分</button>
          </span>
          <span v-if="selectionCount > 0" class="selection-count">已选 {{ selectionCount }} 节点</span>
          <button type="button" data-testid="managed-canvas-snap-to-grid" :aria-pressed="gridSnapEnabled" :disabled="isDragging" :tabindex="bottomToolbarTabIndex('snap', isDragging)" title="单节点拖拽后圆整到 24px 网格；成组拖不动" @focus="bottomToolbarFocusKey = 'snap'" @click="gridSnapEnabled = !gridSnapEnabled">{{ gridSnapEnabled ? "网格吸附开" : "网格吸附关" }}</button>
          <button type="button" data-testid="managed-canvas-toggle-edges" :aria-pressed="showEdges" :tabindex="bottomToolbarTabIndex('edges')" @focus="bottomToolbarFocusKey = 'edges'" @click="toggleEdges">{{ showEdges ? "隐藏连线" : "显示连线" }}</button>
          <button type="button" data-testid="managed-canvas-timeline-layout" :disabled="loading || isDragging || !nodes.length" :tabindex="bottomToolbarTabIndex('timeline', loading || isDragging || !nodes.length)" title="按剧情时间线重新排布（钉住的节点可选择是否强制）" @focus="bottomToolbarFocusKey = 'timeline'" @click="applyTimelineLayout(false)">按时间线排布</button>
          <button type="button" data-testid="managed-canvas-timeline-layout-force" :disabled="loading || isDragging || !nodes.length" :tabindex="bottomToolbarTabIndex('timelineForce', loading || isDragging || !nodes.length)" title="强制按时间线重排全部节点" @focus="bottomToolbarFocusKey = 'timelineForce'" @click="applyTimelineLayout(true)">强制时间线</button>
          <button v-if="selectedDraftEdgeId" type="button" data-testid="managed-canvas-delete-edge" :tabindex="bottomToolbarTabIndex('deleteEdge')" @focus="bottomToolbarFocusKey = 'deleteEdge'" @click="deleteSelectedDraftEdge">删除所选连线</button>
          <button v-if="workspaceMode === 'workflow'" type="button" class="danger-subtle" data-testid="managed-canvas-clear-view" :aria-pressed="clearConfirmationArmed" aria-live="polite" :tabindex="bottomToolbarTabIndex('clear')" @focus="bottomToolbarFocusKey = 'clear'" @click="clearWorkflowCanvas">{{ clearConfirmationArmed ? "再点一次确认清空" : "清空画布视图" }}</button>
          <details ref="viewMenuEl" class="view-menu" @toggle="onViewMenuToggle">
            <summary data-testid="managed-canvas-view-menu" aria-label="视图选项">视图</summary>
            <div class="view-menu-pop" role="menu">
              <button type="button" data-testid="managed-canvas-toggle-minimap" :aria-pressed="showMiniMap" :tabindex="viewMenuItemTabIndex(0)" @focus="viewMenuItemFocusSlot = 0" @click="toggleMiniMap">{{ showMiniMap ? "隐藏小地图" : "显示小地图" }}</button>
              <button type="button" data-testid="managed-canvas-toggle-workspace-mode" :tabindex="viewMenuItemTabIndex(1)" @focus="viewMenuItemFocusSlot = 1" @click="toggleWorkspaceMode">{{ workspaceMode === "workflow" ? "查看全部" : "只看工作流" }}</button>
              <button type="button" data-testid="managed-canvas-refresh" :disabled="loading" :tabindex="viewMenuItemTabIndex(2, loading)" @focus="viewMenuItemFocusSlot = 2" @click="refreshAll">刷新</button>
              <button
                type="button"
                data-testid="managed-canvas-verify-source"
                :disabled="loading || localProductionPreviewLoading"
                :tabindex="viewMenuItemTabIndex(3, loading || localProductionPreviewLoading)"
                title="显式读取并核对外部来源内容；大型项目可能需要较长时间"
                @focus="viewMenuItemFocusSlot = 3"
                @click="verifyLocalProductionSource">
                {{ localProductionPreviewLoading ? "正在核对来源…" : "核对外部来源" }}
              </button>
              <div class="view-menu-theme" role="radiogroup" aria-label="画布主题">
                <span>主题</span>
                <button
                  v-for="(theme, index) in MANAGED_CANVAS_THEMES"
                  :key="theme.id"
                  type="button"
                  role="radio"
                  :aria-checked="canvasTheme === theme.id"
                  :class="{ active: canvasTheme === theme.id }"
                  :tabindex="viewMenuThemeActiveIndex === index ? 0 : -1"
                  @focus="viewMenuThemeRovingIndex = index"
                  @click="setCanvasTheme(theme.id)">
                  {{ theme.label }}
                </button>
              </div>
            </div>
          </details>
        </div>

        <details class="flow-caption technical-diagnostics">
          <summary data-testid="managed-canvas-diagnostics">诊断详情</summary>
          <div data-testid="managed-canvas-dom-counts">
            <span>当前 DOM：{{ assetNodeCount }} 资产 · {{ unitNodeCount }} 单元 · {{ panelNodeCount }} 宫格 · {{ pipelineNodeCount }} 结果/审片 · {{ referenceNodeCount }} 参考 · {{ continuityNodeCount }} 连续性 · {{ edgeObjectCount }} 边 · {{ textDocumentCount }} 文稿</span>
            <span data-testid="managed-canvas-thumb-count">有图节点 {{ thumbnailNodeCount }}</span>
            <span>缩放 {{ Math.round(zoom * 100) }}%</span>
            <span data-testid="managed-canvas-layout-status">{{ layoutStatusLabel }}</span>
            <span v-if="rawReferenceProjectionIssue" data-testid="managed-canvas-raw-projection-issue">正式 raw 投影：{{ rawReferenceProjectionIssue }}</span>
          </div>
        </details>

        <div v-if="helpOpen" id="managed-canvas-help-card" class="help-card" role="dialog" aria-label="画布帮助">
          <button type="button" data-testid="managed-canvas-help-close" aria-label="关闭帮助" @click="closeHelp">×</button>
          <h3>三步准备一格</h3>
          <ol><li>从“添加”或“素材库”放入剧本、提示词、角色、场景、道具、风格、图片/视频/音频和 15 秒分镜。</li><li>媒体节点右上角“拖出”手柄会复制原文件到桌面或其他软件，画布与 CAS 原件始终保留。</li><li>点击任一节点左侧或右侧的“＋”，再点击另一节点的“＋”完成连线；如果使用连线，每个宫格必须连齐正式绑定中的全部人物、场景、道具、风格、当前剧本和提示词。</li><li>点击顶部“准备并记录派发”；后台重新核对锁定资产和正式绑定，写入冻结包、生成计划和派发记录。此步骤不会直接生成图片，需等待所选 Codex/Grok Agent 领取。</li></ol>
          <p>“剧本资源”按人物、场景、道具和风格分页展示全部受管剧本的版本图片；它是只读目录，不会把跨剧本图片静默写入当前工程，也不会一次把全部图片挂成画布节点。</p>
          <p>画布连线不会修改正式资产；错误会在派发记录写入前停止。Agent 回写 raw/labeled 后，结果节点才会出现在画布上。Review、音频和视频未接入本按钮工作流，需分别进入审片与媒体入口处理。双击单元或资产节点可打开驾驶舱详情；点击“原始图/标注图/审片”节点可直达审片。</p>
          <p>画布编辑：左键拖框选、Cmd/Ctrl+点击多选、选中后整组拖动；多选（≥2）可用底栏对齐、≥3 可用等距分布；拖动单个节点靠近其他节点时显示对齐参考线并吸附（整组拖动时不吸附，保持队形）；⌘Z 撤销、⌘⇧Z/Ctrl+Y 重做布局位置（仅当前会话、只含位置，不含正式数据）。</p>
        </div>
      </main>

      <CanvasInspectorPanel
        v-if="selection"
        ref="inspectorPanelEl"
        :selection="selection"
        :appearances-page="appearancesPage"
        :appearance-cursor-stack-length="appearanceCursorStack.length"
        :loading="loading"
        :node-action-panel="nodeActionPanel"
        :selected-node-busy="selectedNodeBusy"
        :authority-thumb-url="authorityThumbUrl"
        :asset-category-label="assetCategoryLabel"
        :production-status-label="productionStatusLabel"
        :currentness-label="currentnessLabel"
        :character-audio-count="selectedCharacterAudioCount"
        :character-audio-playback-url="selectedCharacterAudioPlaybackUrl"
        :character-audio-blocked="characterAudioBlocked"
        :character-view-slots="selectedCharacterViewSlots"
        @close="closeInspector"
        @focus-appearance="focusAppearance"
        @appearances-previous="appearancesPrevious"
        @appearances-next="appearancesNext"
        @run-node-action="runNodeAction"
      />

      <DirectorActionPanel
        :open="directorPanelOpen"
        :season="seasonFilter || undefined"
        :episode="episodeFilter || undefined"
        @close="closeDirectorPanel"
        @action="onDirectorAction"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import { Background } from "@vue-flow/background";
import { ControlButton, Controls } from "@vue-flow/controls";
import { ConnectionMode, useVueFlow, VueFlow, type Connection, type Edge, type Node, type NodeChange, type NodeMouseEvent, type NodeTypesObject } from "@vue-flow/core";

type CanvasFlowNode = Node & { selected?: boolean };
import { MiniMap } from "@vue-flow/minimap";
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import {
  createUnitGridProjectionFlightGate,
  readWithAbortTimeout,
  UnitGridRawProjectionAborted,
  UnitGridRawProjectionReadTimeout,
  UNIT_GRID_RAW_PROJECTION_READ_TIMEOUT_MS_DEFAULT,
} from "../unit-grid-projection-read-gate";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  ArrowUpRight,
  CircleHelp,
  LibraryBig,
  Lock,
  LockOpen,
  Minus,
  Plus,
  Redo2,
  Scan,
  Undo2,
} from "lucide-vue-next";
import ManagedStudioCanvasNode from "./ManagedStudioCanvasNode.vue";
import StudioSpatialGroupNode from "./StudioSpatialGroupNode.vue";
import CanvasInspectorPanel from "./CanvasInspectorPanel.vue";
import DirectorActionPanel from "./DirectorActionPanel.vue";
import type { DirectorAction } from "../director-action-panel.js";
import type {
  MaterialStudioAssetCategory,
  MaterialStudioReviewStatus,
  MaterialStudioUiEntry,
  MaterialStudioUiPage,
} from "../material-studio-ui-contract";
import { createBoundedKeyedCache } from "../use-bounded-keyed-cache.js";
import { createThumbnailLru } from "../use-thumbnail-lru.js";
import { computeVirtualListWindow, sliceVirtualWindow } from "../use-virtual-list.js";
import { LatestBoundedTaskQueue } from "../bounded-task-queue.js";
import {
  createGatedHotkeyRegistry,
  DEFAULT_DIRECTOR_HOTKEYS,
} from "../use-gated-hotkeys.js";
import { directorActionByHotkey } from "../director-action-panel.js";
import { markT23RendererStartup } from "../t23-renderer-startup-probe";
import { createT23RawReferenceSpanTracker } from "../t23-raw-reference-span";
import type {
  StudioDashboardAppearancesPage,
  StudioDashboardAssetSummary,
  StudioDashboardAssetsPage,
  StudioDashboardOverview,
  StudioDashboardPanelSummary,
  StudioDashboardUnitDetail,
  StudioDashboardUnitSummary,
  StudioDashboardUnitsPage,
} from "@core/studio-production-dashboard";
import type {
  StudioCanvasLayout,
  StudioCanvasDraftEdge,
  StudioCanvasNodePosition,
  StudioCanvasViewport,
  StudioCanvasWorkflowGroup,
  StudioCanvasSpatialGroup,
  StudioCanvasWorkspaceMode,
} from "@core/studio-canvas-layout-types";
import {
  alignCanvasNodes,
  CANVAS_GRID_SIZE,
  computeCanvasSnap,
  distributeCanvasNodes,
  roundToCanvasGrid,
  type CanvasAlignMode,
  type CanvasNodeGeometry,
} from "../studio-canvas-align";
import { createCanvasUndoStack, type CanvasPositionMap } from "../studio-canvas-undo";
import {
  collectStudioCanvasNodePositions,
  resolveStudioCanvasNodePosition,
} from "@core/studio-canvas-layout-geometry";
import {
  saveStudioCanvasLayoutWithCasMerge,
  type StudioCanvasLayoutSemanticSnapshot,
} from "../studio-canvas-layout-cas-merge";
import { createStudioCanvasLayoutSaveCoordinator } from "../studio-canvas-layout-save-coordinator";
import {
  applyStudioCanvasTimelinePositions,
  buildStudioCanvasTimelineLayout,
  filterStudioCanvasTimelineProgress,
  STUDIO_CANVAS_TIMELINE_MAX_REFERENCES_PER_UNIT,
  type StudioCanvasTimelineLayout,
} from "@core/studio-canvas-timeline-layout";
import {
  projectStudioCanvasFrozenReferences,
  type StudioCanvasFrozenReferenceProjection,
} from "@core/studio-canvas-frozen-references";
import {
  createStudioCanvasWorkflowGroup,
  extractStudioCanvasPanelIdsFromSelection,
} from "@core/studio-canvas-workflow-groups-core";
import {
  buildStudioCanvasNodeActionPanel,
  type StudioCanvasNodeActionCode,
} from "@core/studio-canvas-node-action-panel";
import { createStudioCanvasNodeStatusStore } from "@core/studio-canvas-node-status";
import {
  validateStudioCanvasWorkflowDraft,
  type StudioCanvasWorkflowDraftInput,
  type StudioCanvasWorkflowDraftNodeInput,
} from "@core/studio-canvas-workflow-draft";
import { describeStudioCanvasWorkflowMismatch } from "@core/studio-canvas-workflow-mismatch";
import { createDashboardLoadController, type StudioProductionDashboardUiApi } from "../studio-production-dashboard-store";
import type { StudioProductionProjectionBundle } from "@core/studio-production-projection-bundle";
import type { StudioPostResultObservationControl } from "@core/studio-post-result-observation";
import type { StudioContinuityReviewFocus } from "../studio-continuity-review-store";
import type { LocalCreativeProductionUnitPreview } from "@core/local-creative-production-unit-preview";
import type { LocalCreativeProjectIngestStatusProjection } from "@core/local-creative-project-ingest-status";
// T12/T13 批量时间线投影与双编号搜索（增量集成）
import {
  resolveTimelineProjectionScope,
  useStudioTimelineProjection,
  type TimelineUnitDisplay,
} from "../composables/useStudioTimelineProjection";
import {
  getManagedCanvasThemeAssets,
  MANAGED_CANVAS_THEMES,
  notifyManagedCanvasThemeChanged,
  readManagedCanvasTheme,
  writeManagedCanvasTheme,
  type ManagedCanvasThemeId,
} from "../managed-canvas-theme";
import { toUserFacingErrorText } from "../user-facing-error";
import { createStudioCommandEnvelope } from "../studio-command-envelope";
import {
  audioSha256sForCharacterAsset,
  ingestCharacterCanvasPack,
  isCharacterAudioPath,
  isCharacterImagePath,
  splitCanvasAssetAliases,
} from "../character-canvas-pack";
import type { VoiceIdentity } from "@core/types";
import {
  createProjectScopedActionGate,
  type ProjectScopedActionToken,
} from "../project-scoped-action-gate";
import { isCurrentApprovedUnitGridResultIdentity } from "../unit-grid-selected-result-identity";
import { runBoundedAsyncTasks } from "../bounded-async-runner";
import type { StudioMediaIpcItem, StudioMediaIpcPage } from "../../../preload/index";

const LAYOUT_SAVE_DEBOUNCE_MS = 450;
const UNIT_GRID_ENRICHMENT_CONCURRENCY = 4;
// 单元详情的聚合投影可能与当前页时间线投影并行；保留一个 IPC 槽给详情，
// 避免两条真实用户路径叠加后突破全局峰值 4。
const TIMELINE_PROJECTION_WORKER_CONCURRENCY = 3;
const EXTERNAL_MEDIA_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif", ".tif", ".tiff",
  ".mp4", ".mov", ".mkv", ".webm", ".m4v",
  ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg",
]);

export interface ManagedStudioCanvasLayoutApi {
  loadLayout(projectRoot: string): Promise<StudioCanvasLayout | null>;
  saveLayout(
    projectRoot: string,
    input: {
      patch?: {
        viewport?: Partial<StudioCanvasViewport>;
        nodes?: Record<string, StudioCanvasNodePosition>;
        workspaceMode?: StudioCanvasWorkspaceMode;
        pinnedNodeIds?: string[];
        draftCanvasEdges?: StudioCanvasDraftEdge[];
        workflowGroups?: StudioCanvasWorkflowGroup[];
        spatialGroups?: StudioCanvasSpatialGroup[];
        updatedAt?: string;
      };
      expectedFingerprint?: string;
    },
  ): Promise<{ layout: StudioCanvasLayout; created: boolean }>;
}

export interface ManagedStudioCanvasGlobalResourceApi {
  listEntries(
    projectRoot: string,
    query: {
      section: MaterialStudioAssetCategory;
      scope: "all";
      representation: "images";
      search?: string;
      cursor?: string;
      limit: number;
    },
  ): Promise<MaterialStudioUiPage>;
}

const props = defineProps<{
  projectRoot: string;
  projectName?: string;
  api: StudioProductionDashboardUiApi;
  /** 复用 Material Studio 的全部剧本逐图只读 owner；禁止据此写入当前工程。 */
  globalResourceApi?: ManagedStudioCanvasGlobalResourceApi;
  /** 由 Material Studio 显式选择；Core dispatch 会再次校验。 */
  generationProvider: "codex" | "grok";
  /** 可选注入；桌面端默认走 preload IPC */
  layoutApi?: ManagedStudioCanvasLayoutApi;
  /** A3：外部 focus（驾驶舱跳入） */
  focus?: import("@core/studio-canvas-locator").StudioCanvasFocusLocator | null;
}>();

const emit = defineEmits<{
  failed: [message: string];
  initialUnitCardsCommitted: [payload: {
    projectRoot: string;
    refreshSequence: number;
    unitCount: number;
    startupMutationChecks?: number;
  }];
  openDashboard: [focus: import("@core/studio-canvas-locator").StudioCanvasFocusLocator];
  /** 打开剧本绑定工作台（非驾驶舱） */
  openBinding: [focus: { unitId?: string; panelId?: string; fromMode: "canvas" }];
  openReview: [focus: StudioContinuityReviewFocus];
  /** 画布抽屉保持只读；跨项目调用统一进入独立总资源中心。 */
  openResourceCenter: [];
  requestGeneration: [focus: { unitId?: string; panelId?: string; fromMode: "canvas" }];
}>();
const controller = createDashboardLoadController();
const pinnedAssetController = createDashboardLoadController();
// T12/T13 批量时间线投影（fastMode <1s，前端不再自行裁决 PASS）
const timelineProjection = useStudioTimelineProjection(computed(() => props.projectRoot));
// T15: 单元级写租约显示（谁正在写哪个单元）
const unitLeaseDisplayHint = ref<string | null>(null);
// T14: 生产诊断（真实状态，禁止推算）
const productionDiagnostics = ref<any>(null);
/** 运行时构建身份（release-manifest / 源码 digest），供 UI 验收与排障。 */
const runtimeBuildIdentity = ref<{
  packageVersion: string;
  buildId: string;
  sourceDigest: string;
  fingerprint: string;
} | null>(null);
const runtimeWriteGate = ref<{
  allowed: boolean;
  restartRequired: boolean;
  bootSourceDigest?: string;
  artifactSourceDigest?: string;
  currentSourceDigest?: string;
  reasons?: string[];
} | null>(null);
type RuntimeWriteGateUiState = "checking" | "allowed" | "blocked" | "unavailable";
const runtimeWriteGateState = ref<RuntimeWriteGateUiState>("checking");
// 只有 Core 明确返回 allowed=true 才解锁；checking/缺失/诊断失败全部失败关闭，
// 但 checking 不能在视觉上误报为“必须重启”。
const runtimeWriteBlocked = computed(() => runtimeWriteGateState.value !== "allowed");
const runtimeWriteGateHint = computed(() => {
  if (runtimeWriteGateState.value === "checking") return "正在核对当前源码与运行工件，完成前保持只读";
  if (runtimeWriteGateState.value === "blocked") return "当前源码运行工件已过期，必须重新构建并重启后才能写入";
  if (runtimeWriteGateState.value === "unavailable") return "运行时身份无法确认，写入保持关闭";
  return "";
});
const overview = ref<StudioDashboardOverview | null>(null);
const localProductionPreview = ref<LocalCreativeProductionUnitPreview | null>(null);
const localCreativeIngestStatus = ref<LocalCreativeProjectIngestStatusProjection | null>(null);
const localProductionPreviewLoading = ref(false);
const localSourceReadyForMaterialization = computed(() => {
  const status = localCreativeIngestStatus.value?.contentImport;
  const previewFingerprint = localProductionPreview.value?.sourceFingerprint;
  const verifiedFingerprint = status?.sourceCheck.verificationInventoryFingerprint;
  const previewDerivedFingerprint = status?.sourceCheck.previewDerivedInventoryFingerprint;
  return status?.sourceSnapshot === "current"
    && status.failures.total === 0
    && (status.truthStatus === "CURRENT_COMPLETE" || status.truthStatus === "PARTIAL_BY_POLICY")
    && typeof previewFingerprint === "string"
    && previewFingerprint === verifiedFingerprint
    && previewFingerprint === previewDerivedFingerprint;
});
const localSourceTruthLabel = computed(() => {
  const status = localCreativeIngestStatus.value?.contentImport;
  if (!status) return "状态不可用";
  if (status.sourceSnapshot === "race") return "来源扫描期间仍在变化";
  if (status.sourceSnapshot === "stale") return "来源已变化";
  if (status.sourceSnapshot === "unknown") return "来源待核验";
  const previewFingerprint = localProductionPreview.value?.sourceFingerprint;
  if (previewFingerprint
    && (previewFingerprint !== status.sourceCheck.verificationInventoryFingerprint
      || previewFingerprint !== status.sourceCheck.previewDerivedInventoryFingerprint)) {
    return "来源在状态与预览两次读取之间变化";
  }
  if (status.failures.total > 0) return "内容导入有失败";
  return status.truthStatus;
});
/**
 * 账本投影降级绝不是“没有待办”。它意味着生成状态、队列和 raw 追溯尚未被
 * Core 证明；画布仍可读资产/剧本，且可在后台逐项严格验真既有 raw/参考链，
 * 但必须关闭派发，不能把尚未验真的历史结果显示为正式素材。
 */
const generationProjectionDegraded = computed(() => overview.value?.generationProjection?.status === "degraded");
const rawReferenceProjectionLoading = ref(false);
const rawReferenceProjectionIssue = ref<string | undefined>();
const generationProjectionHint = computed(() => {
  if (overview.value?.generationProjection?.status === "degraded") {
    const base = overview.value.generationProjection.reason || "生成账本投影暂不可用；禁止据此派发或重试。";
    if (rawReferenceProjectionIssue.value) return `${base} ${rawReferenceProjectionIssue.value}`;
    return rawReferenceProjectionLoading.value
      ? `${base} 正在逐项核验既有正式 raw 与冻结参考链。`
      : base;
  }
  return "生成账本已完成当前投影。";
});
const unitsPage = ref<StudioDashboardUnitsPage | null>(null);
const assetsPage = ref<StudioDashboardAssetsPage | null>(null);
const pinnedAssetsPage = ref<StudioDashboardAssetsPage | null>(null);
const unitDetail = ref<StudioDashboardUnitDetail | null>(null);
const appearancesPage = ref<StudioDashboardAppearancesPage | null>(null);
// VueFlow 的递归 Node 泛型不适合 Vue 深层响应式展开；画布整页替换，使用 shallowRef。
const nodes = shallowRef<CanvasFlowNode[]>([]);
// P23：布局编辑增量（对齐/分布/吸附/undo）会话态。
const undoStack = createCanvasUndoStack({ maxEntries: 80 });
const undoTick = ref(0);
const isDragging = ref(false);
const gridSnapEnabled = ref(false);
const spacePanHeld = ref(false);
const panOnDragButtons = computed(() => (spacePanHeld.value ? [0, 1, 2] : [1, 2]));
const snapLines = ref<Array<{ axis: "x" | "y"; position: number }>>([]);
const selectionCount = ref(0);
let dragStartSnapshot: CanvasPositionMap | null = null;
let snapRafId = 0;
// P23 R2-F2：rAF 合并为"最新事件胜出"——帧内只保留最后一个 drag 事件载荷。
// payload.nodes=库 dragItems（R5-F1 精确判据：比实时选区更准，覆盖 Cmd/Ctrl toggle 边缘手势）。
type CanvasNodeDragPayload = { node?: { id: string; position: { x: number; y: number }; dimensions?: { width?: number; height?: number } }; nodes?: unknown[] };
let pendingSnapEvent: CanvasNodeDragPayload | null = null;
const canUndoLayout = computed(() => { void undoTick.value; return undoStack.canUndo(); });
const canRedoLayout = computed(() => { void undoTick.value; return undoStack.canRedo(); });
const edges = shallowRef<Edge[]>([]);
const loading = ref(false);
const errorMessage = ref("");
const zoom = ref(0.72);
const layoutFingerprint = ref<string | undefined>();
const persistedLayoutNodes = ref<Record<string, StudioCanvasNodePosition>>({});
/** 本窗口最近一次成功读取/保存的完整基线；CAS 冲突时用于三方语义合并。 */
// CAS 基线必须保持普通对象。深响应式 ref 会把 layout 包成 Vue Proxy，
// 后续 structuredClone / Electron IPC 在真实拖拽保存时抛 DataCloneError。
const persistedLayoutBase = shallowRef<StudioCanvasLayout | null>(null);
/** 新工程首次打开时没有用户布局，先落一次可读的时间线默认布局；已有布局永不自动改写。 */
const initialTimelineLayoutAppliedRoot = ref("");
const layoutViewport = ref<StudioCanvasViewport>({ x: 30, y: 36, zoom: 0.72 });
const layoutSaveState = ref<"idle" | "pending" | "saving" | "saved" | "error">("idle");
const workflowGroups = ref<StudioCanvasWorkflowGroup[]>([]);
const spatialGroups = ref<StudioCanvasSpatialGroup[]>([]);
const workspaceMode = ref<StudioCanvasWorkspaceMode>("projection");
const pinnedNodeIds = ref<string[]>([]);
const draftCanvasEdges = ref<StudioCanvasDraftEdge[]>([]);
const selectedPanelIds = ref<string[]>([]);
const workflowBusy = ref(false);
const lastWorkflowTitle = ref("");
const lastWorkflowRunSummary = ref("");
const lastWorkflowFailed = ref(false);
const nodeStatusStore = createStudioCanvasNodeStatusStore();
const nodeStatusTick = ref(0);
let studioGenerationProgressUnsubscribe: (() => void) | undefined;
const actionPanelOpen = ref(true);
type StudioCanvasLibraryTab = "character" | "scene" | "prop" | "style" | "script" | "prompt" | "media" | "unit";
const libraryTabs: ReadonlyArray<{ kind: StudioCanvasLibraryTab; label: string; mark: string }> = [
  { kind: "character", label: "角色", mark: "人" },
  { kind: "scene", label: "场景", mark: "景" },
  { kind: "prop", label: "道具", mark: "物" },
  { kind: "style", label: "风格", mark: "风" },
  { kind: "script", label: "剧本", mark: "剧" },
  { kind: "prompt", label: "提示词", mark: "词" },
  { kind: "media", label: "媒体", mark: "媒" },
  { kind: "unit", label: "15 秒分镜", mark: "格" },
];
type CanvasLibraryMode = "current" | "global";
const libraryMode = ref<CanvasLibraryMode>("current");
const libraryOpen = ref(false);
const addMenuOpen = ref(false);
const characterIngestName = ref("");
const characterIngestAliases = ref("");
const characterIngestDescription = ref("");
const characterImagePath = ref("");
const characterAudioPath = ref("");
const characterSideImagePath = ref("");
const characterBackImagePath = ref("");
const characterViewSlots = ref(new Map<string, string[]>());
const characterIngestBusy = ref(false);
const pickingCharacterMedia = ref(false);
const characterVoices = ref<VoiceIdentity[]>([]);
const characterCompanionMedia = ref(new Map<string, string[]>());
const GLOBAL_RESOURCE_PAGE_LIMIT = 36;
const globalResourceCategories: ReadonlyArray<{ kind: MaterialStudioAssetCategory; label: string }> = [
  { kind: "character", label: "人物" },
  { kind: "scene", label: "场景" },
  { kind: "prop", label: "道具" },
  { kind: "style", label: "风格" },
];
const emptyGlobalResourceCounts = (): {
  total: number;
  character: number;
  scene: number;
  prop: number;
  style: number;
} => ({
  total: 0,
  character: 0,
  scene: 0,
  prop: 0,
  style: 0,
});
const globalResourceCategory = ref<MaterialStudioAssetCategory>("character");
const globalResourceSearch = ref("");
const globalResourcePage = shallowRef<MaterialStudioUiPage | null>(null);
const globalResourceCursor = ref<string | undefined>();
const globalResourceCursorStack = ref<string[]>([]);
const globalResourceLoading = ref(false);
const globalResourceError = ref("");
const globalResourceCounts = computed(() => (
  globalResourcePage.value?.resourceCounts
  ?? globalResourcePage.value?.counts
  ?? emptyGlobalResourceCounts()
));
let globalResourceLoadSequence = 0;
/** Qwen D5：导演动作面板（只读导航） */
const directorPanelOpen = ref(false);
const directorHotkeys = createGatedHotkeyRegistry(DEFAULT_DIRECTOR_HOTKEYS);
/** Qwen D3：侧栏素材虚拟窗口 + 缩略图 LRU */
const assetsLibraryScrollTop = ref(0);
const ASSET_ROW_HEIGHT = 56;
const ASSET_VIEWPORT_HEIGHT = 360;
const thumbnailLru = createThumbnailLru(96);
const libraryAssetItems = computed(() =>
  [...(assetsPage.value?.page.items ?? [])].sort((left, right) =>
    left.name.localeCompare(right.name, "zh-CN", { numeric: true }),
  ),
);
const assetsVirtualWindow = computed(() =>
  computeVirtualListWindow({
    itemCount: libraryAssetItems.value.length,
    itemHeight: ASSET_ROW_HEIGHT,
    viewportHeight: ASSET_VIEWPORT_HEIGHT,
    scrollTop: assetsLibraryScrollTop.value,
    overscan: 3,
  }),
);
const visibleLibraryAssets = computed(() =>
  sliceVirtualWindow(libraryAssetItems.value, assetsVirtualWindow.value),
);

function onAssetsLibraryScroll(event: Event): void {
  const el = event.target as HTMLElement | null;
  assetsLibraryScrollTop.value = el?.scrollTop ?? 0;
}
const helpOpen = ref(false);
const connectMode = ref(false);
const pendingConnectionSourceId = ref("");
const selectedDraftEdgeId = ref("");
const clearConfirmationArmed = ref(false);
const showEdges = ref(true);
/** smoke 典型页 ≤78；超过此数默认关 MiniMap，避免全 store SVG。用户仍可手动开。 */
const MINIMAP_AUTO_HIDE_AFTER_NODES = 80;
const miniMapUserOverride = ref<boolean | null>(null);
const showMiniMap = computed(() => {
  if (miniMapUserOverride.value !== null) return miniMapUserOverride.value;
  return nodes.value.length <= MINIMAP_AUTO_HIDE_AFTER_NODES;
});
// P25 主题皮肤：浅色（默认）/深色/米色，经主题模块持久化（组件内不出现存储字面量，合同红线）。
const canvasTheme = ref<ManagedCanvasThemeId>(readManagedCanvasTheme());
const canvasThemeAssets = computed(() => getManagedCanvasThemeAssets(canvasTheme.value));
function setCanvasTheme(themeId: ManagedCanvasThemeId): void {
  canvasTheme.value = themeId;
  writeManagedCanvasTheme(themeId);
  notifyManagedCanvasThemeChanged(themeId);
}

function cycleCanvasTheme(): void {
  const ids = MANAGED_CANVAS_THEMES.map((theme) => theme.id);
  const index = Math.max(0, ids.indexOf(canvasTheme.value));
  const nextId = ids[(index + 1) % ids.length]!;
  setCanvasTheme(nextId);
}
// P26：弹层统一交互（点击外部关闭 + Escape 统一 + 焦点归还）。
const addTriggerEl = ref<HTMLElement | null>(null);
const helpTriggerEl = ref<HTMLElement | null>(null);
const viewMenuEl = ref<HTMLDetailsElement | null>(null);
function restoreViewMenuSummaryFocus(): void {
  viewMenuEl.value?.querySelector<HTMLElement>("summary")?.focus();
}

function closeViewMenu(options?: { restore?: boolean }): void {
  const wasOpen = Boolean(viewMenuEl.value?.hasAttribute("open"));
  viewMenuEl.value?.removeAttribute("open");
  if (wasOpen && options?.restore !== false) restoreViewMenuSummaryFocus();
}
function onGlobalPointerDown(event: PointerEvent): void {
  const target = event.target as HTMLElement | null;
  if (!target) return;
  if (addMenuOpen.value && !target.closest(".add-menu-wrap")) addMenuOpen.value = false;
  if (helpOpen.value && !target.closest(".help-card") && !helpTriggerEl.value?.contains(target)) helpOpen.value = false;
  if (viewMenuEl.value?.hasAttribute("open") && !target.closest(".view-menu")) closeViewMenu();
}
const libraryTab = ref<StudioCanvasLibraryTab>("character");
type StudioCanvasMediaFilter = "all" | "image" | "video" | "audio";
const STUDIO_CANVAS_MEDIA_PAGE_LIMIT = 36;
const STUDIO_CANVAS_PINNED_MEDIA_LIMIT = 12;
const mediaPage = shallowRef<StudioMediaIpcPage | null>(null);
const pinnedMediaItems = shallowRef<Map<string, StudioMediaIpcItem>>(new Map());
const mediaKindFilter = ref<StudioCanvasMediaFilter>("all");
const mediaSearch = ref("");
const mediaCursor = ref<string | undefined>();
const mediaCursorStack = ref<string[]>([]);
type CanvasTextDocument = { id: string; kind: "script" | "prompt"; title: string; bodyPreview: string; revision: number };
const MAX_CANVAS_TEXT_DOCUMENTS = 12;
const pagedTextDocuments = ref<CanvasTextDocument[]>([]);
const pinnedTextDocuments = ref<CanvasTextDocument[]>([]);
const textDocuments = computed<CanvasTextDocument[]>(() => {
  const byId = new Map<string, CanvasTextDocument>();
  for (const doc of [...pagedTextDocuments.value, ...pinnedTextDocuments.value]) {
    byId.set(`${doc.kind}:${doc.id}`, doc);
  }
  return [...byId.values()];
});
interface PanelPipelineProjection {
  generationRunId?: string;
  packId?: string;
  raw?: { resultId?: string; mediaSha256: string };
  labeled?: { resultId?: string; mediaSha256: string };
  rawThumbnailUrl?: string;
  labeledThumbnailUrl?: string;
  reviewStatus: "unreviewed" | "pass" | "rework" | "reject" | "stale";
}
const panelPipeline = ref(new Map<string, PanelPipelineProjection>());
/** 当前选中单元的 Core 聚合快照；大对象只整体替换，不做深层响应式代理。 */
const currentProductionBundle = shallowRef<StudioProductionProjectionBundle | null>(null);
/**
 * 主时间线仅投影已成对、已 PASS 的最新 unit-grid raw。
 * rejected / rework / stale / generation_unknown 没有结果节点，不能被误作可用参考图。
 */
interface UnitGridRawProjection {
  provenance: "generated" | "historical-import" | "checkpoint-attested";
  /** 停检账本闭合不等于媒体/CAS/冻结参考已重新深核验。 */
  verification: "ledger-attested" | "reference-verified" | "deep-verified";
  generationRunId: string | null;
  provider?: "codex" | "grok";
  packId: string;
  packFingerprint?: string;
  reviewId?: string;
  continuityFingerprint?: string;
  postResultObservationHeadPresent?: boolean;
  rawMediaSha256: string;
  labeledMediaSha256: string;
  rawThumbnailUrl?: string;
}
const unitGridRawPipeline = ref(new Map<string, UnitGridRawProjection>());
interface UnitGridReferenceProjection extends StudioCanvasFrozenReferenceProjection {
  /** 缩略图未派生时缺省，节点回退既有灰色占位 div；绝不回退全尺寸原图 mediaUrl。 */
  thumbnailUrl?: string;
}
interface UnitGridContinuityAssetProjection {
  assetId: string;
  lockedFields: string[];
  readableFields: Array<{ label: string; value: string }>;
}
interface UnitGridContinuityProjection {
  fingerprint: string;
  lastPanelId: string;
  lastPanelTitle: string;
  visualAction: string;
  shotComposition: string;
  filmingMethod: string;
  sceneLighting: string;
  assetCount: number;
  fieldCount: number;
  readableFieldCount: number;
  opaqueFieldCount: number;
  handoffSummary: string;
  assetSummary: string;
  assets: UnitGridContinuityAssetProjection[];
}
interface UnitGridVideoPackageProjection {
  status: "not-prepared" | "resolved" | "conflict";
  subtitle: string;
}
interface UnitGridEnrichmentResult {
  unitId: string;
  videoPackage: UnitGridVideoPackageProjection;
  postResultObservation?: StudioPostResultObservationControl;
}
/** 非 PASS 整板只显示真实验收状态，不展示 raw 缩略图、参考边或导出入口。 */
interface UnitGridNonPassProjection {
  status: "unreviewed" | "rework" | "reject" | "stale";
  subtitle: string;
}
/** 每项都是对应正式 raw 的不可变 pack 实际 control reference，不从搜索结果或当前筛选猜测。 */
const unitGridReferencePipeline = ref(new Map<string, UnitGridReferenceProjection[]>());
/** 只从同一冻结整板的末格 continuity 快照派生，供下一单元开工直接读取。 */
const unitGridContinuityPipeline = ref(new Map<string, UnitGridContinuityProjection>());
/**
 * 只保存 Core 对 generation run 给出的实际末态 control。画布不从 raw、计划值或
 * Review 文案推导 current；只有 control 明示 current + continuationEligible 才可承接。
 */
const unitGridPostResultObservationPipeline = ref(new Map<string, StudioPostResultObservationControl>());
/** 视频包控制面只读投影；not-prepared 必须可见，不能伪装成已经提交。 */
const unitGridVideoPackagePipeline = ref(new Map<string, UnitGridVideoPackageProjection>());
const unitGridNonPassPipeline = ref(new Map<string, UnitGridNonPassProjection>());
/** 核心投影判 PASS 的可见单元集合（唯一裁决的落地缓存）：区分“已通过·投影恢复中”与“等待检查”。 */
const unitGridCorePassUnits = ref(new Set<string>());
const frozenReferenceThumbnailCache = createBoundedKeyedCache<Promise<FrozenReferenceThumbnailResult>>(96);
// 冻结参考闭包会同时复验多个本地 CAS 缩略图；generation-run 路径含 history+media+pack。
// 超时必须 AbortController.abort，并丢弃迟到 IPC 结果（见 unit-grid-projection-read-gate）。
const UNIT_GRID_RAW_PROJECTION_READ_TIMEOUT_MS = UNIT_GRID_RAW_PROJECTION_READ_TIMEOUT_MS_DEFAULT;
/** 当前深核验批次的取消控制器：新序列/切工程时 abort，停止后续协作读取。 */
let unitGridRawProjectionAbort: AbortController | null = null;
const unitGridRawProjectionFlight = createUnitGridProjectionFlightGate();
/** T23 专用：绑定 root + raw flight 的精确提交时刻；生产探针关闭时零数据积累。 */
const t23RawReferenceSpanTracker = createT23RawReferenceSpanTracker({
  mark: (milestone) => markT23RendererStartup(milestone),
});

/**
 * 有界可取消读取：start(signal) 在 abort 后不得再把结果写回投影。
 * 调用方应把 IPC 放进 start 内启动，并在 await 后检查 signal.aborted。
 */
async function readUnitGridProjectionWithin<T>(
  readName: string,
  unitId: string,
  start: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return readWithAbortTimeout(readName, unitId, start, {
    timeoutMs: UNIT_GRID_RAW_PROJECTION_READ_TIMEOUT_MS,
    // 永不结算的 Electron IPC 只能阻塞当前工程的同类读取；禁止污染其他工程。
    laneKey: `${props.projectRoot}\u0000${readName}`,
    ...(unitGridRawProjectionAbort ? { signal: unitGridRawProjectionAbort.signal } : {}),
  });
}

/** 包装无原生 cancel 的 IPC：abort 后丢弃结果，避免过期写回。 */
function ipcUnderSignal<T>(signal: AbortSignal, start: () => Promise<T>): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new UnitGridRawProjectionAborted());
  }
  return start().then((value) => {
    if (signal.aborted) {
      throw signal.reason ?? new UnitGridRawProjectionAborted();
    }
    return value;
  });
}
const selectedUnitRevision = ref(1);
const nodeTypes = {
  managedStudio: markRaw(ManagedStudioCanvasNode),
  studioSpatialGroup: markRaw(StudioSpatialGroupNode),
} as NodeTypesObject;
const studioFlow = useVueFlow("managed-studio-flow");

function authorityThumbUrl(recipeKey?: string): string | undefined {
  if (!recipeKey?.trim()) return undefined;
  const key = `${props.projectRoot}\u0000${recipeKey.trim()}`;
  const cached = thumbnailLru.get(key);
  if (cached) return cached;
  const url = `aicanvas-studio://thumbnail/${recipeKey.trim()}?projectRoot=${encodeURIComponent(props.projectRoot)}`;
  thumbnailLru.set(key, url);
  return url;
}

function onDirectorAction(action: DirectorAction): void {
  if (action.kind === "toggle-panel") {
    toggleDirectorPanel();
    return;
  }
  if (action.kind === "refresh") {
    void refreshAll();
    return;
  }
  if (action.kind === "navigate-earliest") {
    const unit = unitsPage.value?.page.items?.[0];
    if (unit) void selectUnit(unit);
    libraryOpen.value = true;
    return;
  }
  if (action.kind === "open-align-board" || action.kind === "open-reader" || action.kind === "open-wizard") {
    // 只读导航：打开素材库剧本页，供后续 SSL 面板扩展；不发起写命令
    libraryOpen.value = true;
    void openLibraryFor("script");
    directorPanelOpen.value = false;
    return;
  }
  if (action.kind === "open-trace" || action.kind === "open-consistency") {
    const panelId = unitDetail.value?.panels[0]?.id;
    if (panelId) openPanelReview(panelId);
    directorPanelOpen.value = false;
  }
}

type CanvasTextBridge = {
    listStudioTextDocuments?: (
      projectRoot: string,
      query?: { kind?: "script" | "prompt"; search?: string; cursor?: string; limit?: number },
    ) => Promise<{ items: Array<{ id: string; kind: "script" | "prompt"; title: string; revision: number }> }>;
    getStudioTextDocument?: (
      projectRoot: string,
      documentId: string,
    ) => Promise<{ id: string; kind: "script" | "prompt"; title: string; revision: number } | null>;
    getLatestStudioTextRevisionMetadata?: (
      projectRoot: string,
      documentId: string,
    ) => Promise<{ id: string; ordinal: number } | null>;
    getStudioTextRevision?: (
      projectRoot: string,
      revisionId: string,
    ) => Promise<{ body?: string } | null>;
};

function resolveTextBridge(): CanvasTextBridge | undefined {
  return (window as unknown as { canvasApi?: CanvasTextBridge }).canvasApi;
}

async function enrichTextDocument(
  bridge: CanvasTextBridge,
  projectRoot: string,
  doc: { id: string; kind: "script" | "prompt"; title: string; revision: number },
): Promise<CanvasTextDocument> {
  let bodyPreview = "";
  try {
    const meta = bridge.getLatestStudioTextRevisionMetadata
      ? await bridge.getLatestStudioTextRevisionMetadata(projectRoot, doc.id)
      : null;
    if (meta?.id && bridge.getStudioTextRevision) {
      const rev = await bridge.getStudioTextRevision(projectRoot, meta.id);
      bodyPreview = (rev?.body ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    }
  } catch {
    bodyPreview = "";
  }
  return { id: doc.id, kind: doc.kind, title: doc.title, bodyPreview, revision: doc.revision };
}

async function loadTextDocuments(): Promise<void> {
  const projectRoot = props.projectRoot;
  const requestSequence = ++textDocumentLoadSequence;
  const bridge = resolveTextBridge();
  if (!bridge?.listStudioTextDocuments) {
    if (projectRoot === props.projectRoot && requestSequence === textDocumentLoadSequence) pagedTextDocuments.value = [];
    return;
  }
  try {
    const page = await bridge.listStudioTextDocuments(projectRoot, { limit: MAX_CANVAS_TEXT_DOCUMENTS });
    const items = page.items ?? [];
    const loaded = await runBoundedAsyncTasks(
      items.slice(0, MAX_CANVAS_TEXT_DOCUMENTS).map((doc) => () => enrichTextDocument(bridge, projectRoot, doc)),
      4,
    );
    if (projectRoot === props.projectRoot && requestSequence === textDocumentLoadSequence) pagedTextDocuments.value = loaded;
  } catch {
    if (projectRoot === props.projectRoot && requestSequence === textDocumentLoadSequence) pagedTextDocuments.value = [];
  }
}

async function loadPinnedTextDocuments(): Promise<void> {
  const projectRoot = props.projectRoot;
  const requestSequence = ++pinnedTextDocumentLoadSequence;
  const bridge = resolveTextBridge();
  const requested = pinnedNodeIds.value
    .filter((nodeId) => nodeId.startsWith("script:") || nodeId.startsWith("prompt:"))
    .map((nodeId) => ({ nodeId, documentId: nodeId.slice(nodeId.indexOf(":") + 1) }));
  if (!requested.length) {
    if (projectRoot === props.projectRoot && requestSequence === pinnedTextDocumentLoadSequence) pinnedTextDocuments.value = [];
    return;
  }
  if (!bridge?.getStudioTextDocument) {
    if (projectRoot === props.projectRoot && requestSequence === pinnedTextDocumentLoadSequence) {
      pinnedTextDocuments.value = textDocuments.value.filter((doc) => requested.some((item) => item.nodeId === `${doc.kind}:${doc.id}`));
    }
    return;
  }
  const loaded = await runBoundedAsyncTasks(requested.map(({ nodeId, documentId }) => async () => {
    try {
      const doc = await bridge.getStudioTextDocument!(projectRoot, documentId);
      if (!doc || `${doc.kind}:${doc.id}` !== nodeId) return { nodeId, doc: null, unavailable: false };
      return { nodeId, doc: await enrichTextDocument(bridge, projectRoot, doc), unavailable: false };
    } catch {
      const existing = textDocuments.value.find((doc) => `${doc.kind}:${doc.id}` === nodeId);
      const kind: "script" | "prompt" = nodeId.startsWith("script:") ? "script" : "prompt";
      return {
        nodeId,
        doc: existing ?? { id: documentId, kind, title: "文稿暂时不可用", bodyPreview: "精确读取失败，固定关系已保留。", revision: 0 },
        unavailable: true,
      };
    }
  }), 4);
  if (projectRoot !== props.projectRoot || requestSequence !== pinnedTextDocumentLoadSequence) return;
  pinnedTextDocuments.value = loaded.map((item) => item.doc).filter((doc): doc is CanvasTextDocument => Boolean(doc));
  const missing = new Set(loaded.filter((item) => !item.doc && !item.unavailable).map((item) => item.nodeId));
  if (missing.size) {
    pinnedNodeIds.value = pinnedNodeIds.value.filter((nodeId) => !missing.has(nodeId));
    pruneDraftEdgesForRemovedNodes(missing);
    scheduleLayoutPersist();
  }
}

async function loadPinnedMedia(options: { rebuild?: boolean } = {}): Promise<void> {
  const projectRoot = props.projectRoot;
  const requestSequence = ++pinnedMediaLoadSequence;
  const requested = pinnedNodeIds.value
    .filter((nodeId) => nodeId.startsWith("library-media:"))
    .map((nodeId) => ({
      nodeId,
      mediaSha256: nodeId.slice("library-media:".length),
    }))
    .filter((item) => /^[a-f0-9]{64}$/u.test(item.mediaSha256))
    .slice(0, STUDIO_CANVAS_PINNED_MEDIA_LIMIT);
  if (!requested.length) {
    if (projectRoot === props.projectRoot && requestSequence === pinnedMediaLoadSequence) {
      pinnedMediaItems.value = new Map();
      if (options.rebuild !== false) rebuildGraph();
    }
    return;
  }
  const tasks = requested.map(({ nodeId, mediaSha256 }) => async () => {
    try {
      const media = await window.canvasApi.getStudioMedia(projectRoot, mediaSha256);
      return { nodeId, media };
    } catch {
      return { nodeId, media: null };
    }
  });
  const loaded = await runBoundedAsyncTasks(tasks, 4);
  if (projectRoot !== props.projectRoot || requestSequence !== pinnedMediaLoadSequence) return;
  pinnedMediaItems.value = new Map(
    loaded
      .filter((item): item is { nodeId: string; media: StudioMediaIpcItem } => Boolean(item.media))
      .map((item) => [item.media.sha256, item.media] as const),
  );
  const missing = new Set(loaded.filter((item) => !item.media).map((item) => item.nodeId));
  if (missing.size) {
    pinnedNodeIds.value = pinnedNodeIds.value.filter((nodeId) => !missing.has(nodeId));
    pruneDraftEdgesForRemovedNodes(missing);
    scheduleLayoutPersist();
  }
  if (options.rebuild !== false) rebuildGraph();
}

const hasPersistedLayout = computed(() => Object.keys(persistedLayoutNodes.value).length > 0 || layoutFingerprint.value !== undefined);
const defaultViewport = computed(() => ({
  x: layoutViewport.value.x,
  y: layoutViewport.value.y,
  zoom: layoutViewport.value.zoom,
}));
const layoutStatusLabel = computed(() => {
  if (layoutSaveState.value === "pending") return "布局待保存";
  if (layoutSaveState.value === "saving") return "布局保存中";
  if (layoutSaveState.value === "saved") return "布局已落盘";
  if (layoutSaveState.value === "error") return "布局保存失败";
  return hasPersistedLayout.value ? "布局已加载" : "默认布局";
});

let layoutSaveTimer: ReturnType<typeof setTimeout> | undefined;
let layoutSaveGeneration = 0;
let clearConfirmationTimer: number | undefined;
let layoutLoadSequence = 0;
let textDocumentLoadSequence = 0;
let pinnedTextDocumentLoadSequence = 0;
let pinnedMediaLoadSequence = 0;
let mediaLoadSequence = 0;
let unitDetailLoadSequence = 0;
let panelPipelineLoadSequence = 0;
interface QueuedUnitSelection {
  projectRoot: string;
  unit: StudioDashboardUnitSummary;
  panelId?: string;
  resolve: () => void;
}
let queuedUnitSelection: QueuedUnitSelection | null = null;
let unitSelectionDrain: Promise<void> | null = null;
let latestUnitSelectionKey: string | null = null;
let refreshSequence = 0;
let runtimeBuildIdentitySequence = 0;
let localSourceVerificationSequence = 0;
let planStatusLoadSequence = 0;
let controlViewportSequence = 0;
let controlViewportTimer: number | undefined;
let canvasDisposed = false;
let initialUnitCardObserver: MutationObserver | undefined;
let initialUnitCardObserverScope: {
  projectRoot: string;
  refreshSequence: number;
  expectedUnitIds: Set<string>;
  promise: Promise<boolean>;
  resolve: (observed: boolean) => void;
} | undefined;

const INITIAL_UNIT_CARD_SELECTOR = '[data-testid="managed-studio-canvas-node"][data-node-kind="unit"]';

function cancelInitialUnitCardObserver(): void {
  initialUnitCardObserver?.disconnect();
  initialUnitCardObserver = undefined;
  const scope = initialUnitCardObserverScope;
  initialUnitCardObserverScope = undefined;
  scope?.resolve(false);
}

function recordInitialUnitCardIfReady(): boolean {
  const scope = initialUnitCardObserverScope;
  if (!scope) return false;
  if (
    canvasDisposed
    || scope.projectRoot !== props.projectRoot
    || scope.refreshSequence !== refreshSequence
  ) {
    cancelInitialUnitCardObserver();
    return false;
  }
  if (!scope.expectedUnitIds.size) return false;
  const matchingNode = [...document.querySelectorAll<HTMLElement>(INITIAL_UNIT_CARD_SELECTOR)]
    .find((node) => scope.expectedUnitIds.has(node.dataset.unitId ?? ""));
  const unitId = matchingNode?.dataset.unitId;
  if (!unitId) return false;
  initialUnitCardObserver?.disconnect();
  initialUnitCardObserver = undefined;
  initialUnitCardObserverScope = undefined;
  markT23RendererStartup("canvas-first-card-dom-ready");
  markT23RendererStartup(`canvas-first-card-dom-unit:${unitId}`);
  scope.resolve(true);
  return true;
}

function armInitialUnitCardObserver(projectRoot: string, requestSequence: number): void {
  cancelInitialUnitCardObserver();
  let resolve!: (observed: boolean) => void;
  const promise = new Promise<boolean>((next) => {
    resolve = next;
  });
  initialUnitCardObserverScope = {
    projectRoot,
    refreshSequence: requestSequence,
    expectedUnitIds: new Set(),
    promise,
    resolve,
  };
  initialUnitCardObserver = new MutationObserver(() => {
    recordInitialUnitCardIfReady();
  });
  initialUnitCardObserver.observe(document.body, { childList: true, subtree: true });
}

async function waitForInitialUnitCardDom(
  projectRoot: string,
  requestSequence: number,
  unitIds: readonly string[],
): Promise<boolean> {
  if (!unitIds.length) {
    cancelInitialUnitCardObserver();
    return false;
  }
  const scope = initialUnitCardObserverScope;
  if (
    !scope
    || scope.projectRoot !== projectRoot
    || scope.refreshSequence !== requestSequence
  ) return false;
  scope.expectedUnitIds = new Set(unitIds);
  if (recordInitialUnitCardIfReady()) return true;

  // VueFlow 通常在当前微任务或下一帧挂载首卡。两帧后仍不可见时，Canvas overview
  // 可以继续，避免持久 viewport 无可见节点时卡住；Material 则延后到 overview 完成。
  const twoFrames = new Promise<boolean>((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve(false));
    });
  });
  return Promise.race([scope.promise, twoFrames]);
}
const layoutSaveCoordinator = createStudioCanvasLayoutSaveCoordinator({
  persist: async ({ projectRoot, base, local, expectedFingerprint }) => {
    const api = resolveLayoutApi();
    if (!api) throw new Error("布局 API 不可用。");
    return saveStudioCanvasLayoutWithCasMerge({
      api,
      projectRoot,
      base,
      local,
      ...(expectedFingerprint ? { expectedFingerprint } : {}),
    });
  },
  isRequestCurrent: (request) => (
    request.projectRoot === props.projectRoot
    && request.generation === layoutSaveGeneration
  ),
  isProjectCurrent: (projectRoot) => (
    !canvasDisposed && projectRoot === props.projectRoot
  ),
  onAutomaticAccepted: (request, result, context) => {
    // 即使 debounce generation 已推进，本窗口先前成功写入仍必须成为下一次 CAS
    // 的 base/fingerprint；只有最新请求才允许把 merge 后语义应用到可见画布。
    acceptPersistedLayout(result.layout, {
      applyMergedSemantic: result.merged && context.requestCurrent,
    });
    if (context.requestCurrent && !context.superseded) {
      layoutSaveState.value = "saved";
    }
  },
  onAutomaticError: (request, error) => {
    if (request.generation !== layoutSaveGeneration) return;
    layoutSaveState.value = "error";
    errorMessage.value = `布局保存失败：${message(error)}`;
  },
});
const workflowActionGate = createProjectScopedActionGate();
// 固定节点、添加单元和外部导入互不覆盖：同 lane 最新动作胜出，跨 lane 并行不互相失效。
const pinActionGate = createProjectScopedActionGate();
const addUnitActionGate = createProjectScopedActionGate();
const externalImportActionGate = createProjectScopedActionGate();
const guardedActionGate = createProjectScopedActionGate();
const pinActionBusy = ref(false);
const addUnitActionBusy = ref(false);

interface FrozenWorkflowActionScope {
  token: ProjectScopedActionToken;
  projectRoot: string;
  unitId: string;
  provider: "codex" | "grok";
}

function workflowActionIsCurrent(scope: FrozenWorkflowActionScope): boolean {
  return workflowActionGate.isCurrent(
    scope.token,
    props.projectRoot,
    unitDetail.value?.unit.id,
  ) && !canvasDisposed;
}

interface FrozenCanvasUiActionScope {
  token: ProjectScopedActionToken;
  projectRoot: string;
  actionId: string;
}

function canvasUiActionIsCurrent(
  gate: ReturnType<typeof createProjectScopedActionGate>,
  scope: FrozenCanvasUiActionScope,
): boolean {
  return gate.isCurrent(
    scope.token,
    props.projectRoot,
    scope.actionId,
  ) && !canvasDisposed;
}

function resolveLayoutApi(): ManagedStudioCanvasLayoutApi | null {
  if (props.layoutApi) return props.layoutApi;
  type Bridge = {
    loadLayout?: ManagedStudioCanvasLayoutApi["loadLayout"];
    saveLayout?: ManagedStudioCanvasLayoutApi["saveLayout"];
    loadStudioCanvasLayout?: ManagedStudioCanvasLayoutApi["loadLayout"];
    saveStudioCanvasLayout?: ManagedStudioCanvasLayoutApi["saveLayout"];
  };
  const bridge = (window as unknown as { canvasApi?: Bridge }).canvasApi;
  if (!bridge) return null;
  // 桌面 preload 同时存在旧 Scanner layout 与受管 Studio layout；必须优先专用 owner。
  if (typeof bridge.loadStudioCanvasLayout === "function" && typeof bridge.saveStudioCanvasLayout === "function") {
    return {
      loadLayout: (projectRoot) => bridge.loadStudioCanvasLayout!(projectRoot),
      saveLayout: (projectRoot, input) => bridge.saveStudioCanvasLayout!(projectRoot, input),
    };
  }
  if (typeof bridge.loadLayout === "function" && typeof bridge.saveLayout === "function") {
    return { loadLayout: bridge.loadLayout, saveLayout: bridge.saveLayout };
  }
  return null;
}
const seasonFilter = ref("");
const episodeFilter = ref("");
const assetCategory = ref<"" | "character" | "scene" | "prop" | "style">("");
const assetSearch = ref("");
const unitCursor = ref<string | undefined>();
const assetCursor = ref<string | undefined>();
const appearanceCursor = ref<string | undefined>();
const unitCursorStack = ref<string[]>([]);
const assetCursorStack = ref<string[]>([]);
const appearanceCursorStack = ref<string[]>([]);
const selection = ref<
  | { kind: "asset"; asset: StudioDashboardAssetSummary }
  | { kind: "unit"; unit: StudioDashboardUnitSummary }
  | { kind: "panel"; panel: StudioDashboardPanelSummary }
  | { kind: "script" | "prompt"; doc: { id: string; kind: "script" | "prompt"; title: string; bodyPreview: string; revision: number } }
  | null
>(null);
const inspectorPanelEl = ref<InstanceType<typeof CanvasInspectorPanel> | null>(null);
const selectedCharacterAudioCount = computed(() => {
  if (selection.value?.kind !== "asset") return 0;
  return audioSha256sForCharacterAsset(characterVoices.value, selection.value.asset.id).length;
});
const selectedCharacterAudioPlaybackUrl = computed(() => {
  if (selection.value?.kind !== "asset" || !props.projectRoot) return "";
  const sha = audioSha256sForCharacterAsset(characterVoices.value, selection.value.asset.id)[0];
  if (!sha) return "";
  return `aicanvas-studio://media/${sha}?projectRoot=${encodeURIComponent(props.projectRoot)}`;
});
const characterAudioBlocked = computed(() => loading.value || pinActionBusy.value);
const selectedCharacterViewSlots = computed(() => {
  if (selection.value?.kind !== "asset") return [];
  return characterViewSlots.value.get(selection.value.asset.id) ?? [];
});
const appearanceListElement = computed<HTMLElement | null>(() => inspectorPanelEl.value?.appearanceListElement ?? null);

const filteredEpisodes = computed(() => {
  const episodes = unitsPage.value?.episodes ?? [];
  return seasonFilter.value ? episodes.filter((entry) => entry.seasonId === seasonFilter.value) : episodes;
});

/** 只在当前页面可证明属于唯一季集时刷新；多季集混排绝不默认读取 S1E1。 */
async function refreshTimelineProjectionForUnits(
  units = unitsPage.value?.page.items ?? [],
): Promise<Map<string, TimelineUnitDisplay> | null> {
  const scope = resolveTimelineProjectionScope({
    season: seasonFilter.value,
    episode: episodeFilter.value,
    units,
  });
  if (!scope) {
    timelineProjection.reset();
    return null;
  }
  const visibleUnitIds = [...new Set(units.map((unit) => unit.id).filter(Boolean))].slice(0, 36);
  if (visibleUnitIds.length === 0) {
    timelineProjection.reset();
    return null;
  }
  await timelineProjection.refresh(scope.season, scope.episode, visibleUnitIds);
  return timelineProjection.projection.value
    ? new Map(timelineProjection.projection.value.map((unit) => [unit.unitId, unit]))
    : null;
}

const filteredTextDocuments = computed(() => textDocuments.value.filter((doc) => doc.kind === libraryTab.value));

function mediaNodeId(mediaSha256: string): string {
  return `library-media:${mediaSha256}`;
}

const LIBRARY_NODE_MIME = "application/x-aicanvas-library-node";

function onLibraryDragStart(event: DragEvent, nodeId: string): void {
  if (!event.dataTransfer || pinActionBusy.value || loading.value) {
    event.preventDefault();
    return;
  }
  event.dataTransfer.setData(LIBRARY_NODE_MIME, nodeId);
  event.dataTransfer.effectAllowed = "copy";
}

async function dropLibraryNodeAt(event: DragEvent, nodeId: string): Promise<void> {
  if (pinActionBusy.value || loading.value) return;
  const point = studioFlow.screenToFlowCoordinate({ x: event.clientX, y: event.clientY });
  if (!isPinned(nodeId)) await togglePinnedNode(nodeId);
  if (!isPinned(nodeId)) return;
  persistedLayoutNodes.value = {
    ...persistedLayoutNodes.value,
    [nodeId]: { x: Math.round(point.x), y: Math.round(point.y) },
  };
  rebuildGraph();
  scheduleLayoutPersist();
}

function characterLibrarySubtitle(asset: StudioDashboardAssetSummary): string {
  const audioCount = audioSha256sForCharacterAsset(characterVoices.value, asset.id).length;
  const image = asset.hasPrimaryAuthority ? "参考图已锁定" : "待补参考图";
  const alias = (asset.aliases ?? []).find((item) => item !== asset.name);
  const base = audioCount > 0 ? `${image} · 音频 ${audioCount}` : image;
  return alias ? `${base} · ${alias}` : base;
}

const characterIngestHint = computed(() => {
  const image = characterImagePath.value ? characterImagePath.value.replaceAll("\\", "/").split("/").at(-1) : "未选图片";
  if (libraryTab.value !== "character") return image;
  const audio = characterAudioPath.value ? characterAudioPath.value.replaceAll("\\", "/").split("/").at(-1) : "未选音频（可选）";
  return `${image} · ${audio}`;
});

async function refreshCharacterVoices(projectRoot = props.projectRoot): Promise<void> {
  try {
    characterVoices.value = await window.canvasApi.listVoiceIdentities(projectRoot);
  } catch {
    if (projectRoot === props.projectRoot) characterVoices.value = [];
  }
}

function detachCharacterCompanionAudio(assetId: string, current: Set<string>): void {
  const shas = characterCompanionMedia.value.get(assetId) ?? [];
  const nextMedia = new Map(pinnedMediaItems.value);
  for (const sha of shas) {
    current.delete(mediaNodeId(sha));
    nextMedia.delete(sha);
  }
  pinnedMediaItems.value = nextMedia;
  const nextCompanions = new Map(characterCompanionMedia.value);
  nextCompanions.delete(assetId);
  characterCompanionMedia.value = nextCompanions;
}

async function attachCharacterCompanionAudio(
  assetId: string,
  current: Set<string>,
  projectRoot: string,
): Promise<void> {
  await refreshCharacterVoices(projectRoot);
  const shas = audioSha256sForCharacterAsset(characterVoices.value, assetId);
  if (!shas.length) return;
  const nextMedia = new Map(pinnedMediaItems.value);
  const attached: string[] = [];
  for (const sha of shas) {
    const nodeId = mediaNodeId(sha);
    if (current.has(nodeId)) {
      attached.push(sha);
      continue;
    }
    if ([...current].filter((id) => id.startsWith("library-media:")).length >= STUDIO_CANVAS_PINNED_MEDIA_LIMIT) {
      break;
    }
    const media = mediaPage.value?.items.find((item) => item.sha256 === sha)
      ?? await window.canvasApi.getStudioMedia(projectRoot, sha);
    if (!media || media.kind !== "audio") continue;
    current.add(nodeId);
    nextMedia.set(sha, media);
    attached.push(sha);
  }
  pinnedMediaItems.value = nextMedia;
  if (attached.length) {
    const nextCompanions = new Map(characterCompanionMedia.value);
    nextCompanions.set(assetId, attached);
    characterCompanionMedia.value = nextCompanions;
  }
}

async function pickCharacterImage(): Promise<void> {
  if (characterIngestBusy.value || pickingCharacterMedia.value) return;
  pickingCharacterMedia.value = true;
  try {
    const paths = await window.canvasApi.pickStudioMediaFiles();
    const image = paths.find((candidate) => isCharacterImagePath(candidate));
    if (!image) {
      if (paths.length) errorMessage.value = "请选择 png/jpg/webp 等角色参考图。";
      return;
    }
    characterImagePath.value = image;
    errorMessage.value = "";
  } finally {
    pickingCharacterMedia.value = false;
  }
}

async function pickCharacterView(slot: "side" | "back"): Promise<void> {
  if (characterIngestBusy.value || pickingCharacterMedia.value) return;
  pickingCharacterMedia.value = true;
  try {
    const paths = await window.canvasApi.pickStudioMediaFiles();
    const image = paths.find((candidate) => isCharacterImagePath(candidate));
    if (!image) {
      if (paths.length) errorMessage.value = slot === "side" ? "请选择侧视图图片。" : "请选择背视图图片。";
      return;
    }
    if (slot === "side") characterSideImagePath.value = image;
    else characterBackImagePath.value = image;
    errorMessage.value = "";
  } finally {
    pickingCharacterMedia.value = false;
  }
}

async function pickCharacterAudio(): Promise<void> {
  if (characterIngestBusy.value || pickingCharacterMedia.value) return;
  pickingCharacterMedia.value = true;
  try {
    const paths = await window.canvasApi.pickStudioMediaFiles();
    const audio = paths.find((candidate) => isCharacterAudioPath(candidate));
    if (!audio) {
      if (paths.length) errorMessage.value = "请选择 mp3/wav/m4a 等角色音频。";
      return;
    }
    characterAudioPath.value = audio;
    errorMessage.value = "";
  } finally {
    pickingCharacterMedia.value = false;
  }
}

async function submitCharacterIngest(): Promise<void> {
  if (characterIngestBusy.value || !characterIngestName.value || !characterImagePath.value) return;
  const projectRoot = props.projectRoot;
  characterIngestBusy.value = true;
  errorMessage.value = "";
  try {
    const category = libraryTab.value === "scene" || libraryTab.value === "prop" ? libraryTab.value : "character";
    const aliases = splitCanvasAssetAliases(characterIngestAliases.value);
    const description = characterIngestDescription.value.trim();
    const pack = await ingestCharacterCanvasPack({
      executeStudioCommand: (root, envelope) => window.canvasApi.executeStudioCommand(root, envelope),
      upsertVoiceIdentity: (root, input) => window.canvasApi.upsertVoiceIdentity(root, input),
    }, projectRoot, {
      name: characterIngestName.value,
      imagePath: characterImagePath.value,
      category,
      ...(aliases.length ? { aliases } : {}),
      ...(description ? { description } : {}),
      ...(category === "character" && characterAudioPath.value ? { audioPath: characterAudioPath.value } : {}),
      ...(category === "character" && characterSideImagePath.value ? { sideImagePath: characterSideImagePath.value } : {}),
      ...(category === "character" && characterBackImagePath.value ? { backImagePath: characterBackImagePath.value } : {}),
    });
    if (projectRoot !== props.projectRoot) return;
    characterIngestName.value = "";
    characterIngestAliases.value = "";
    characterIngestDescription.value = "";
    characterImagePath.value = "";
    characterAudioPath.value = "";
    characterSideImagePath.value = "";
    characterBackImagePath.value = "";
    if (pack.viewSha256s) {
      const nextViews = new Map(characterViewSlots.value);
      nextViews.set(pack.assetId, Object.keys(pack.viewSha256s));
      characterViewSlots.value = nextViews;
    }
    await refreshCharacterVoices(projectRoot);
    await resetAssets();
    const nodeId = `asset:${pack.assetId}`;
    if (!pinnedNodeIds.value.includes(nodeId)) {
      await togglePinnedNode(nodeId);
    }
    for (const sha of Object.values(pack.viewSha256s ?? {})) {
      const mediaId = mediaNodeId(sha);
      if (!pinnedNodeIds.value.includes(mediaId)) await togglePinnedNode(mediaId);
    }
  } catch (error) {
    if (projectRoot !== props.projectRoot) return;
    errorMessage.value = message(error);
    emit("failed", errorMessage.value);
  } finally {
    if (projectRoot === props.projectRoot) characterIngestBusy.value = false;
  }
}

function mediaKindMark(kind: StudioMediaIpcItem["kind"]): string {
  if (kind === "image") return "图";
  if (kind === "video") return "视";
  return "音";
}

function mediaKindLabel(kind: StudioMediaIpcItem["kind"]): string {
  if (kind === "image") return "图片";
  if (kind === "video") return "视频";
  return "音频";
}

function formatCanvasMediaBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / 1_024 / 1_024).toFixed(1)} MiB`;
}
const simpleWorkflowStatus = computed(() => {
  if (workflowBusy.value) return "正在预检并记录派发";
  if (errorMessage.value) return "需要处理";
  if (lastWorkflowFailed.value) return "派发记录未完成";
  if (lastWorkflowRunSummary.value) return "派发已记录，等待 Agent 领取";
  if (unitDetail.value) return "可准备派发";
  return "请选择 15 秒分镜";
});
const simpleWorkflowHint = computed(() => {
  if (workflowBusy.value) return "后台正在核对锁定资产、剧本、提示词与正式绑定；通过后写入冻结、计划和派发记录";
  if (errorMessage.value) return "请按红色提示处理，系统没有继续派发";
  if (lastWorkflowRunSummary.value) return lastWorkflowRunSummary.value;
  if (unitDetail.value) {
    if (pendingConnectionSourceId.value) return "已选择输入节点；现在点击目标宫格即可连线";
    return connectMode.value ? "点击任一节点一侧的＋，再点击另一个节点的＋即可连线" : "节点两侧的＋可直接连线；记录派发前会按后台正式绑定重新核对";
  }
  return "从左侧“添加”放入角色、场景、道具、风格、文稿和分镜";
});
const assetNodeCount = computed(() => (
  workspaceMode.value === "workflow"
    ? pinnedAssetsPage.value?.page.items.length ?? 0
    : Math.min(assetsPage.value?.page.items.length ?? 0, 6)
));
const unitNodeCount = computed(() => unitsPage.value?.page.items.length ?? 0);
const panelNodeCount = computed(() => unitDetail.value?.panels.length ?? 0);
// 真实 DOM 统计：结果/审片节点按画布实际渲染计数，禁止“宫格数×3”推算。
const pipelineNodeCount = computed(() => nodes.value.filter((node) => {
  const kind = (node.data as { kind?: string } | undefined)?.kind;
  return kind === "raw" || kind === "labeled" || kind === "review";
}).length);
const referenceNodeCount = computed(() => nodes.value.filter((node) => (
  (node.data as { kind?: string } | undefined)?.kind === "reference"
)).length);
const continuityNodeCount = computed(() => nodes.value.filter((node) => (
  (node.data as { kind?: string } | undefined)?.kind === "continuity"
)).length);
const edgeObjectCount = computed(() => edges.value.length);
const textDocumentCount = computed(() => textDocuments.value.length);
const thumbnailNodeCount = computed(() => {
  const projectedAssets = workspaceMode.value === "workflow"
    ? (pinnedAssetsPage.value?.page.items ?? [])
    : (assetsPage.value?.page.items ?? []).slice(0, 6);
  const assetsWithThumb = projectedAssets.filter((a) => a.authorityThumbnailRecipeKey).length;
  // 宫格节点若能挂上控制资产权威图，计入「有图」
  const assetThumbIds = new Set(
    projectedAssets
      .filter((a) => a.authorityThumbnailRecipeKey)
      .map((a) => a.id),
  );
  const panelsWithThumb = (unitDetail.value?.panels ?? []).filter((p) =>
    p.assetIds.some((id) => assetThumbIds.has(id)),
  ).length;
  const visibleUnitIds = new Set(
    workspaceMode.value === "workflow"
      ? pinnedNodeIds.value.filter((id) => id.startsWith("unit:")).map((id) => id.slice("unit:".length))
      : (unitsPage.value?.page.items ?? []).map((unit) => unit.id),
  );
  const frozenReferenceThumbs = [...unitGridReferencePipeline.value.entries()]
    .filter(([unitId]) => visibleUnitIds.has(unitId))
    .reduce((count, [, references]) => count + references.filter((reference) => Boolean(reference.thumbnailUrl)).length, 0);
  return assetsWithThumb + panelsWithThumb + frozenReferenceThumbs;
});

const selectedNodeBusy = computed(() => {
  void nodeStatusTick.value;
  if (selection.value?.kind !== "panel") return null;
  return nodeStatusStore.get(`panel:${selection.value.panel.id}`);
});

const nodeActionPanel = computed(() => {
  if (!actionPanelOpen.value || !selection.value) return null;
  if (selection.value.kind === "script" || selection.value.kind === "prompt") return null;
  if (selection.value.kind === "panel") {
    const panel = selection.value.panel;
    const unitId = unitDetail.value?.unit.id;
    return buildStudioCanvasNodeActionPanel({
      kind: "panel",
      id: panel.id,
      panelId: panel.id,
      unitId,
      title: panel.label,
      status: panel.status,
      bindingCurrentness: panel.bindingCurrentness,
      visualAction: panel.visualAction,
      dialogue: panel.dialogue,
      assetCount: panel.assetIds.length,
      canFreezeDispatch: panel.status === "generation-ready" || panel.bindingCurrentness === "current",
      isBusy: Boolean(selectedNodeBusy.value),
    });
  }
  if (selection.value.kind === "unit") {
    return buildStudioCanvasNodeActionPanel({
      kind: "unit",
      id: selection.value.unit.id,
      unitId: selection.value.unit.id,
      title: selection.value.unit.label,
      status: selection.value.unit.status,
      subtitle: selection.value.unit.episodeId,
    });
  }
  if (selection.value.kind === "asset") {
    return buildStudioCanvasNodeActionPanel({
      kind: "asset",
      id: selection.value.asset.id,
      title: selection.value.asset.name,
      subtitle: selection.value.asset.description,
    });
  }
  return null;
});

function runNodeAction(code: StudioCanvasNodeActionCode): void {
  if (code === "close-panel") {
    actionPanelOpen.value = false;
    return;
  }
  if (code === "open-binding") {
    if (selection.value?.kind === "panel") {
      emit("openBinding", {
        ...(unitDetail.value?.unit.id ? { unitId: unitDetail.value.unit.id } : {}),
        panelId: selection.value.panel.id,
        fromMode: "canvas",
      });
    } else if (selection.value?.kind === "unit") {
      emit("openBinding", { unitId: selection.value.unit.id, fromMode: "canvas" });
    }
    return;
  }
  if (code === "open-dashboard") {
    if (selection.value?.kind === "panel") {
      emit("openDashboard", {
        ...(unitDetail.value?.unit.id ? { unitId: unitDetail.value.unit.id } : {}),
        panelId: selection.value.panel.id,
        fromMode: "canvas",
      });
    } else if (selection.value?.kind === "unit") {
      emit("openDashboard", { unitId: selection.value.unit.id, fromMode: "canvas" });
    } else if (selection.value?.kind === "asset") {
      actionPanelOpen.value = false;
      void nextTick(() => appearanceListElement.value?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
    }
    return;
  }
  if (code === "focus-unit" && selection.value?.kind === "unit") {
    void selectUnit(selection.value.unit);
    return;
  }
  if (code === "freeze-dispatch" && selection.value?.kind === "panel") {
    emit("requestGeneration", {
      ...(unitDetail.value?.unit.id ? { unitId: unitDetail.value.unit.id } : {}),
      panelId: selection.value.panel.id,
      fromMode: "canvas",
    });
  }
}

function message(error: unknown): string {
  return toUserFacingErrorText(error);
}

function workflowFailureMessage(error: unknown): string {
  // 匹配必须在翻译前的原文上进行（翻译层会把 BindingSet 润色为「生成绑定」，直接 includes 会失配死分支）。
  const raw = error instanceof Error ? error.message : String(error);
  const detail = message(error);
  if (raw.includes("剧本连接不是当前冻结修订")) {
    return "连线预检未通过：剧本缺少当前冻结修订，或多出了旧剧本连线。请移除旧剧本并连接当前剧本。";
  }
  if (raw.includes("提示词连接不是当前冻结修订")) {
    return "连线预检未通过：提示词缺少当前冻结修订，或多出了旧提示词连线。请移除旧提示词并连接当前提示词。";
  }
  if (raw.includes("画布资产连接与正式 BindingSet 不一致")) {
    return "连线预检未通过：人物、场景或道具连线存在缺少/多出，请按当前正式绑定补齐。";
  }
  return `执行工作流失败：${detail}`;
}

function assetCategoryLabel(category: string): string {
  return category === "character" ? "角色" : category === "scene" ? "场景" : category === "prop" ? "道具" : category === "style" ? "风格" : "资产";
}

function globalResourceCategoryLabel(category: MaterialStudioAssetCategory): string {
  return category === "character" ? "人物" : category === "scene" ? "场景" : category === "prop" ? "道具" : "风格";
}

function globalResourceReviewLabel(status: MaterialStudioReviewStatus): string {
  return status === "approved" ? "已通过" : status === "rejected" ? "已拒绝" : "待审";
}

function globalResourceSourceLabel(entry: MaterialStudioUiEntry): string {
  return entry.sourceProjectName?.trim() || entry.sourceProjectId?.trim() || "来源剧本未命名";
}

function currentnessLabel(currentness: string): string {
  if (currentness === "current") return "绑定有效";
  if (currentness === "stale") return "需要更新绑定";
  if (currentness === "blocked") return "需要人工处理";
  if (currentness === "missing") return "尚未绑定";
  if (currentness === "not-applicable") return "无需绑定";
  return currentness;
}

function productionStatusLabel(status: string): string {
  if (status === "generation-ready") return "可以生图";
  if (status === "current" || status === "bound") return "绑定有效";
  if (status === "stale") return "需要更新绑定";
  if (status === "ambiguous") return "需要确认资产";
  if (status === "unmatched") return "缺少匹配资产";
  if (status === "unchecked") return "等待检查";
  if (status === "missing") return "信息不完整";
  if (status === "blocked") return "暂时不能继续";
  return status;
}

function sessionPositions(): Map<string, StudioCanvasNodePosition> {
  return new Map(nodes.value.map((node) => [node.id, { x: node.position.x, y: node.position.y }]));
}

function positionFor(id: string, fallback: StudioCanvasNodePosition): StudioCanvasNodePosition {
  return resolveStudioCanvasNodePosition(id, {
    sessionPositions: sessionPositions(),
    layoutNodes: persistedLayoutNodes.value,
    fallback,
  });
}

type TimelineReviewDecision = NonNullable<
  import("@core/studio-canvas-timeline-layout").StudioCanvasTimelinePanelInput["reviewDecision"]
>;

function toTimelineReviewDecision(
  status: string | undefined,
): TimelineReviewDecision {
  switch (status) {
    case "pass":
    case "rework":
    case "reject":
    case "stale":
    case "unreviewed":
    case "none":
      return status;
    default:
      return "none";
  }
}

/** 当前可见单元/资产/选中单元宫格 → 剧情时间线默认坐标与系统边。 */
function computeTimelineLayout(): StudioCanvasTimelineLayout | null {
  const unitItems = unitsPage.value?.page.items ?? [];
  const assetItems = (assetsPage.value?.page.items ?? []).slice(0, 36);
  const active = unitDetail.value;
  if (!unitItems.length && !active) return null;
  const units = (unitItems.length ? unitItems : active ? [active.unit] : []).map((unit, index) => ({
    unitId: unit.id,
    label: unit.label,
    sequence: index + 1,
    hasApprovedUnitGridRaw: unitGridRawPipeline.value.get(unit.id)?.verification !== "ledger-attested",
    references: (unitGridReferencePipeline.value.get(unit.id) ?? []).map((reference) => ({
      referenceId: reference.referenceId,
      referenceType: reference.referenceType,
      label: reference.typeLabel,
    })),
    panels: active && active.unit.id === unit.id
      ? active.panels.map((panel) => {
        const pipeline = panelPipeline.value.get(panel.id);
        return {
          panelId: panel.id,
          ordinal: panel.ordinal,
          startSeconds: panel.startSeconds,
          endSeconds: panel.endSeconds,
          assetIds: panel.assetIds.slice(0, 6),
          hasRaw: Boolean(pipeline?.raw),
          hasLabeled: Boolean(pipeline?.labeled),
          reviewDecision: toTimelineReviewDecision(pipeline?.reviewStatus ?? "none"),
          label: panel.label,
        };
      })
      : [],
  }));
  // 若列表页未含当前选中单元，补上
  if (active && !units.some((unit) => unit.unitId === active.unit.id)) {
    units.push({
      unitId: active.unit.id,
      label: active.unit.label,
      sequence: units.length + 1,
      hasApprovedUnitGridRaw: unitGridRawPipeline.value.get(active.unit.id)?.verification !== "ledger-attested",
      references: (unitGridReferencePipeline.value.get(active.unit.id) ?? []).map((reference) => ({
        referenceId: reference.referenceId,
        referenceType: reference.referenceType,
        label: reference.typeLabel,
      })),
      panels: active.panels.map((panel) => {
        const pipeline = panelPipeline.value.get(panel.id);
        return {
          panelId: panel.id,
          ordinal: panel.ordinal,
          startSeconds: panel.startSeconds,
          endSeconds: panel.endSeconds,
          assetIds: panel.assetIds.slice(0, 6),
          hasRaw: Boolean(pipeline?.raw),
          hasLabeled: Boolean(pipeline?.labeled),
          reviewDecision: toTimelineReviewDecision(pipeline?.reviewStatus ?? "none"),
          label: panel.label,
        };
      }),
    });
  }
  try {
    return buildStudioCanvasTimelineLayout({
      units,
      assets: assetItems.map((asset) => ({
        assetId: asset.id,
        category: asset.category,
        label: asset.name,
      })),
    }, { activeUnitId: active?.unit.id });
  } catch {
    return null;
  }
}

const panelTimelineStrip = computed(() => {
  const timeline = computeTimelineLayout();
  return timeline?.panelTimeline ?? [];
});

const timelineProgressQuery = ref("");
const TIMELINE_PROGRESS_REVIEW_OPTIONS = ["", "any-pending", "pass", "rework", "reject", "none"] as const;
const timelineProgressReview = ref<(typeof TIMELINE_PROGRESS_REVIEW_OPTIONS)[number]>("");

function cycleTimelineProgressReview(direction: 1 | -1): void {
  const options = TIMELINE_PROGRESS_REVIEW_OPTIONS;
  const index = Math.max(0, options.indexOf(timelineProgressReview.value));
  timelineProgressReview.value = options[(index + direction + options.length) % options.length]!;
  void focusTimelineSearchResult();
}

function cyclePanelTimelineChip(direction: 1 | -1): void {
  const strip = panelTimelineStrip.value;
  if (!strip.length) return;
  const currentId = selection.value?.kind === "panel" ? selection.value.panel.id : "";
  const index = strip.findIndex((row) => row.panelId === currentId);
  const next = index < 0
    ? (direction > 0 ? 0 : strip.length - 1)
    : (index + direction + strip.length) % strip.length;
  panelTimelineRovingIndex.value = next;
  void focusPanelOnCanvas(strip[next]!.panelId);
}

const panelTimelineRovingIndex = ref(-1);

const panelTimelineActiveChipIndex = computed(() => {
  const strip = panelTimelineStrip.value;
  if (!strip.length) return 0;
  const roving = panelTimelineRovingIndex.value;
  if (roving >= 0 && roving < strip.length) return roving;
  const currentId = selection.value?.kind === "panel" ? selection.value.panel.id : "";
  const selected = strip.findIndex((row) => row.panelId === currentId);
  return selected >= 0 ? selected : 0;
});

function panelTimelineChipButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("[data-testid='managed-canvas-panel-timeline'] button"));
}

function movePanelTimelineChipFocus(key: string): void {
  const strip = panelTimelineStrip.value;
  if (!strip.length) return;
  const buttons = panelTimelineChipButtons();
  const active = document.activeElement;
  const index = buttons.findIndex((button) => button === active || button.contains(active));
  const current = index >= 0 ? index : panelTimelineActiveChipIndex.value;
  let next = current;
  if (key === "ArrowRight") next = (current + 1) % strip.length;
  else if (key === "ArrowLeft") next = (current - 1 + strip.length) % strip.length;
  else if (key === "Home") next = 0;
  else if (key === "End") next = strip.length - 1;
  else if (key === "PageUp") next = Math.max(0, current - 10);
  else if (key === "PageDown") next = Math.min(strip.length - 1, current + 10);
  else return;
  panelTimelineRovingIndex.value = next;
  buttons[next]?.focus();
}

function focusPanelTimelineChipEnd(which: "first" | "last"): void {
  const strip = panelTimelineStrip.value;
  if (!strip.length) return;
  const index = which === "first" ? 0 : strip.length - 1;
  panelTimelineRovingIndex.value = index;
  void focusPanelOnCanvas(strip[index]!.panelId);
}

function jumpPanelTimelineChipPage(direction: 1 | -1): void {
  const strip = panelTimelineStrip.value;
  if (!strip.length) return;
  const currentId = selection.value?.kind === "panel" ? selection.value.panel.id : "";
  const index = strip.findIndex((row) => row.panelId === currentId);
  const start = index < 0 ? (direction > 0 ? 0 : strip.length - 1) : index;
  const next = direction > 0
    ? Math.min(strip.length - 1, start + 10)
    : Math.max(0, start - 10);
  panelTimelineRovingIndex.value = next;
  void focusPanelOnCanvas(strip[next]!.panelId);
}

function jumpUnitListPage(direction: 1 | -1): void {
  const items = unitsPage.value?.page.items ?? [];
  if (!items.length) return;
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".unit-list .library-item"));
  const active = document.activeElement;
  const index = buttons.findIndex((button) => button === active || button.contains(active));
  const current = index >= 0 ? index : 0;
  const next = direction > 0
    ? Math.min(items.length - 1, current + 10)
    : Math.max(0, current - 10);
  const unit = items[next];
  if (!unit) return;
  unitListRovingIndex.value = next;
  buttons[next]?.focus();
  void selectUnit(unit);
}

async function pageUnitsByKeyboard(direction: 1 | -1): Promise<void> {
  if (loading.value) return;
  if (direction > 0) {
    if (!unitsPage.value?.page.nextCursor) return;
    await unitsNext();
  } else {
    if (!unitCursorStack.value.length) return;
    await unitsPrevious();
  }
  const first = document.querySelector<HTMLButtonElement>(".unit-list .library-item");
  if (first) {
    unitListRovingIndex.value = 0;
    first.focus();
    return;
  }
  const pager = document.querySelector<HTMLButtonElement>(
    direction > 0
      ? "[data-testid='managed-canvas-units-next']"
      : "[data-testid='managed-canvas-units-prev']",
  );
  pager?.focus();
}

const unitListRovingIndex = ref(-1);
const assetListRovingIndex = ref(-1);
const textListRovingIndex = ref(-1);
const mediaListRovingIndex = ref(-1);
const globalResourceListRovingIndex = ref(-1);

function listRovingActiveIndex(
  count: number,
  roving: number,
  selected: number,
): number {
  if (count <= 0) return 0;
  if (roving >= 0 && roving < count) return roving;
  return selected >= 0 ? selected : 0;
}

const unitListActiveIndex = computed(() => {
  const items = unitsPage.value?.page.items ?? [];
  const currentId = selection.value?.kind === "unit" ? selection.value.unit.id : unitDetail.value?.unit.id ?? "";
  const selected = items.findIndex((unit) => unit.id === currentId);
  return listRovingActiveIndex(items.length, unitListRovingIndex.value, selected);
});

const assetListActiveIndex = computed(() => {
  const items = visibleLibraryAssets.value;
  const currentId = selection.value?.kind === "asset" ? selection.value.asset.id : "";
  const selected = items.findIndex((asset) => asset.id === currentId);
  return listRovingActiveIndex(items.length, assetListRovingIndex.value, selected);
});

const textListActiveIndex = computed(() => {
  const items = filteredTextDocuments.value;
  const currentId = selection.value?.kind === "script" || selection.value?.kind === "prompt"
    ? selection.value.doc.id
    : "";
  const selected = items.findIndex((doc) => doc.id === currentId);
  return listRovingActiveIndex(items.length, textListRovingIndex.value, selected);
});

const mediaListActiveIndex = computed(() => {
  const items = mediaPage.value?.items ?? [];
  return listRovingActiveIndex(items.length, mediaListRovingIndex.value, -1);
});

const globalResourceListActiveIndex = computed(() => {
  const items = globalResourcePage.value?.items ?? [];
  return listRovingActiveIndex(items.length, globalResourceListRovingIndex.value, -1);
});

function nextRovingIndex(current: number, count: number, key: string): number | null {
  if (count <= 0) return null;
  if (key === "ArrowDown" || key === "ArrowRight") return (current + 1) % count;
  if (key === "ArrowUp" || key === "ArrowLeft") return (current - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

function moveListedItemFocus(selector: string, key: string, fallback: number): void {
  const items = Array.from(document.querySelectorAll<HTMLElement>(selector));
  if (!items.length) return;
  const active = document.activeElement;
  const index = items.findIndex((el) => el === active || el.contains(active));
  const current = index >= 0 ? index : Math.max(0, Math.min(fallback, items.length - 1));
  const next = nextRovingIndex(current, items.length, key);
  if (next == null) return;
  items[next]?.focus();
}

function moveUnitListFocus(key: string): void {
  moveListedItemFocus(".unit-list .library-item", key, unitListActiveIndex.value);
}

function moveAssetListFocus(key: string): void {
  moveListedItemFocus("[data-testid='managed-canvas-assets-virtual-viewport'] .library-item", key, assetListActiveIndex.value);
}

function moveTextListFocus(key: string): void {
  moveListedItemFocus(".text-list .library-item", key, textListActiveIndex.value);
}

function moveMediaListFocus(key: string): void {
  moveListedItemFocus(".media-library-item", key, mediaListActiveIndex.value);
}

function moveAppearanceListFocus(key: string): void {
  moveListedItemFocus(".appearance-list button", key, 0);
}

function moveGlobalResourceListFocus(key: string): void {
  moveListedItemFocus(".global-resource-card", key, globalResourceListActiveIndex.value);
}

function moveNodeActionFocus(key: string): void {
  const items = Array.from(document.querySelectorAll<HTMLButtonElement>(".node-action-buttons button"))
    .filter((el) => !el.disabled);
  if (!items.length) return;
  const active = document.activeElement;
  const index = items.findIndex((el) => el === active || el.contains(active));
  const current = index >= 0 ? index : 0;
  const next = nextRovingIndex(current, items.length, key);
  if (next == null) return;
  items[next]?.focus();
}

const libraryTabRovingIndex = ref(-1);
const globalResourceTabRovingIndex = ref(-1);
const addMenuRovingIndex = ref(-1);

const libraryTabActiveIndex = computed(() => {
  const selected = libraryTabs.findIndex((tab) => tab.kind === libraryTab.value);
  return listRovingActiveIndex(libraryTabs.length, libraryTabRovingIndex.value, selected);
});

const globalResourceTabActiveIndex = computed(() => {
  const selected = globalResourceCategories.findIndex((category) => category.kind === globalResourceCategory.value);
  return listRovingActiveIndex(globalResourceCategories.length, globalResourceTabRovingIndex.value, selected);
});

const addMenuActiveIndex = computed(() => {
  return listRovingActiveIndex(libraryTabs.length, addMenuRovingIndex.value, 0);
});

function moveLibraryTabFocus(key: string): void {
  moveListedItemFocus("#managed-canvas-library .library-tabs button", key, libraryTabActiveIndex.value);
}

function moveGlobalResourceTabFocus(key: string): void {
  const items = Array.from(document.querySelectorAll<HTMLButtonElement>(".global-resource-tabs button"))
    .filter((el) => !el.disabled);
  if (!items.length) return;
  const active = document.activeElement;
  const index = items.findIndex((el) => el === active || el.contains(active));
  const current = index >= 0 ? index : 0;
  const next = nextRovingIndex(current, items.length, key);
  if (next == null) return;
  items[next]?.focus();
}

function moveAddMenuFocus(key: string): void {
  moveListedItemFocus("#managed-canvas-add-menu button", key, addMenuActiveIndex.value);
}

const floatingToolbarRovingIndex = ref(-1);
const floatingToolbarActiveIndex = computed(() => listRovingActiveIndex(5, floatingToolbarRovingIndex.value, 0));

function moveFloatingToolbarFocus(key: string): void {
  const items = Array.from(document.querySelectorAll<HTMLButtonElement>(
    ".floating-tools > .add-menu-wrap > button, .floating-tools > button",
  ));
  if (!items.length) return;
  const active = document.activeElement;
  const index = items.findIndex((el) => el === active || el.contains(active));
  const current = index >= 0 ? index : floatingToolbarActiveIndex.value;
  const next = nextRovingIndex(current, items.length, key);
  if (next == null) return;
  items[next]?.focus();
}

const bottomToolbarFocusKey = ref("fit");
const viewMenuItemFocusSlot = ref(0);
const viewMenuThemeRovingIndex = ref(-1);

function bottomToolbarEnabledKeys(): string[] {
  const keys: string[] = ["fit"];
  if (canUndoLayout.value && !isDragging.value) keys.push("undo");
  if (canRedoLayout.value && !isDragging.value) keys.push("redo");
  if (selectionCount.value >= 2 && !isDragging.value) {
    keys.push("align-left", "align-centerX", "align-right", "align-top", "align-centerY", "align-bottom");
    if (selectionCount.value >= 3) keys.push("dist-x", "dist-y");
  }
  if (!isDragging.value) keys.push("snap");
  keys.push("edges");
  if (!loading.value && !isDragging.value && nodes.value.length) keys.push("timeline", "timelineForce");
  if (selectedDraftEdgeId.value) keys.push("deleteEdge");
  if (workspaceMode.value === "workflow") keys.push("clear");
  return keys;
}

function bottomToolbarTabIndex(key: string, disabled = false): number {
  if (disabled) return -1;
  const enabled = bottomToolbarEnabledKeys();
  if (!enabled.length) return -1;
  const current = enabled.includes(bottomToolbarFocusKey.value) ? bottomToolbarFocusKey.value : enabled[0];
  return current === key ? 0 : -1;
}

function moveBottomToolbarFocus(key: string): void {
  const items = Array.from(document.querySelectorAll<HTMLButtonElement>(
    ".bottom-tools > button, .bottom-tools .align-tools button",
  )).filter((el) => !el.disabled);
  if (!items.length) return;
  const active = document.activeElement;
  const index = items.findIndex((el) => el === active || el.contains(active));
  const current = index >= 0 ? index : 0;
  const next = nextRovingIndex(current, items.length, key);
  if (next == null) return;
  items[next]?.focus();
}

function viewMenuItemEnabledSlots(): number[] {
  const slots = [0, 1];
  if (!loading.value) slots.push(2);
  if (!loading.value && !localProductionPreviewLoading.value) slots.push(3);
  return slots;
}

function viewMenuItemTabIndex(slot: number, disabled = false): number {
  if (disabled) return -1;
  const enabled = viewMenuItemEnabledSlots();
  if (!enabled.length) return -1;
  const current = enabled.includes(viewMenuItemFocusSlot.value) ? viewMenuItemFocusSlot.value : enabled[0]!;
  return current === slot ? 0 : -1;
}

function moveViewMenuItemFocus(key: string): void {
  const items = Array.from(document.querySelectorAll<HTMLButtonElement>(".view-menu-pop > button"))
    .filter((el) => !el.disabled);
  if (!items.length) return;
  const active = document.activeElement;
  const index = items.findIndex((el) => el === active || el.contains(active));
  const current = index >= 0 ? index : 0;
  const next = nextRovingIndex(current, items.length, key);
  if (next == null) return;
  items[next]?.focus();
}

const viewMenuThemeActiveIndex = computed(() => {
  const selected = MANAGED_CANVAS_THEMES.findIndex((theme) => theme.id === canvasTheme.value);
  return listRovingActiveIndex(MANAGED_CANVAS_THEMES.length, viewMenuThemeRovingIndex.value, selected);
});

function moveViewMenuThemeFocus(key: string): void {
  moveListedItemFocus(".view-menu-theme > button[role='radio']", key, viewMenuThemeActiveIndex.value);
}

function onViewMenuToggle(event: Event): void {
  const details = event.currentTarget as HTMLDetailsElement;
  if (!details.open) return;
  viewMenuItemFocusSlot.value = 0;
  void nextTick(() => {
    const first = Array.from(document.querySelectorAll<HTMLButtonElement>(".view-menu-pop > button"))
      .find((el) => !el.disabled);
    first?.focus();
  });
}

function managedFlowControlsButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("#managed-studio-flow .vue-flow__controls-button"));
}

function syncManagedFlowControlsTabIndex(active?: Element | null): void {
  const items = managedFlowControlsButtons();
  if (!items.length) return;
  const index = items.findIndex((el) => el === active || el.contains(active ?? null));
  const current = index >= 0 ? index : 0;
  items.forEach((el, i) => {
    el.tabIndex = i === current ? 0 : -1;
  });
}

function moveManagedFlowControlsFocus(key: string): void {
  const items = managedFlowControlsButtons();
  if (!items.length) return;
  const active = document.activeElement;
  const index = items.findIndex((el) => el === active || el.contains(active));
  const current = index >= 0 ? index : 0;
  const next = nextRovingIndex(current, items.length, key);
  if (next == null) return;
  syncManagedFlowControlsTabIndex(items[next]);
  items[next]?.focus();
}

function onManagedFlowControlsFocusIn(event: FocusEvent): void {
  const target = event.target as HTMLElement | null;
  if (!target?.closest("#managed-studio-flow .vue-flow__controls-button")) return;
  syncManagedFlowControlsTabIndex(target);
}

function onMiniMapNodeFocusIn(event: FocusEvent): void {
  const target = event.target as HTMLElement | null;
  if (!target?.closest(".vue-flow__minimap-node")) return;
  syncMiniMapNodeTabIndex(target);
}

async function pageMediaByKeyboard(direction: 1 | -1): Promise<void> {
  if (loading.value) return;
  if (direction > 0) {
    if (!mediaPage.value?.nextCursor) return;
    await mediaNext();
  } else {
    if (!mediaCursorStack.value.length) return;
    await mediaPrevious();
  }
  const first = document.querySelector<HTMLElement>(".media-library-item");
  if (first) {
    mediaListRovingIndex.value = 0;
    first.focus();
    return;
  }
  const pager = document.querySelector<HTMLButtonElement>(
    direction > 0
      ? "[data-testid='managed-canvas-media-next']"
      : "[data-testid='managed-canvas-media-prev']",
  );
  pager?.focus();
}

async function pageAssetsByKeyboard(direction: 1 | -1): Promise<void> {
  if (loading.value) return;
  if (direction > 0) {
    if (!assetsPage.value?.page.nextCursor) return;
    await assetsNext();
  } else {
    if (!assetCursorStack.value.length) return;
    await assetsPrevious();
  }
  const first = document.querySelector<HTMLElement>("[data-testid='managed-canvas-assets-virtual-viewport'] .library-item");
  if (first) {
    assetListRovingIndex.value = 0;
    first.focus();
    return;
  }
  const pager = document.querySelector<HTMLButtonElement>(
    direction > 0
      ? "[data-testid='managed-canvas-assets-next']"
      : "[data-testid='managed-canvas-assets-prev']",
  );
  pager?.focus();
}

async function pageGlobalResourcesByKeyboard(direction: 1 | -1): Promise<void> {
  if (globalResourceLoading.value) return;
  if (direction > 0) {
    if (!globalResourcePage.value?.nextCursor) return;
    await globalResourcesNext();
  } else {
    if (!globalResourceCursorStack.value.length) return;
    await globalResourcesPrevious();
  }
  const first = document.querySelector<HTMLElement>(".global-resource-card");
  if (first) {
    globalResourceListRovingIndex.value = 0;
    first.focus();
    return;
  }
  const pager = document.querySelector<HTMLButtonElement>(
    direction > 0
      ? "[data-testid='managed-canvas-global-resources-next']"
      : "[data-testid='managed-canvas-global-resources-prev']",
  );
  pager?.focus();
}

async function pageAppearancesByKeyboard(direction: 1 | -1): Promise<void> {
  if (loading.value) return;
  if (selection.value?.kind !== "asset") return;
  if (direction > 0) {
    if (!appearancesPage.value?.page.nextCursor) return;
    await appearancesNext();
  } else {
    if (!appearanceCursorStack.value.length) return;
    await appearancesPrevious();
  }
  const first = document.querySelector<HTMLButtonElement>(".appearance-list button");
  if (first) {
    first.focus();
    return;
  }
  const pager = document.querySelector<HTMLButtonElement>(
    direction > 0
      ? "[data-testid='managed-canvas-appearances-next']"
      : "[data-testid='managed-canvas-appearances-prev']",
  );
  pager?.focus();
}

const timelineProgressFilterResult = computed(() => {
  const unitItems = unitsPage.value?.page.items ?? [];
  const assetItems = (assetsPage.value?.page.items ?? []).slice(0, 36);
  const active = unitDetail.value;
  if (!unitItems.length && !active) return null;
  const hasFilter = Boolean(timelineProgressQuery.value) || Boolean(timelineProgressReview.value);
  if (!hasFilter) return null;
  const units = (unitItems.length ? unitItems : active ? [active.unit] : []).map((unit, index) => ({
    unitId: unit.id,
    label: unit.label,
    sequence: index + 1,
    panels: active && active.unit.id === unit.id
      ? active.panels.map((panel) => {
        const pipeline = panelPipeline.value.get(panel.id);
        return {
          panelId: panel.id,
          ordinal: panel.ordinal,
          startSeconds: panel.startSeconds,
          assetIds: panel.assetIds.slice(0, 6),
          hasRaw: Boolean(pipeline?.raw),
          hasLabeled: Boolean(pipeline?.labeled),
          reviewDecision: toTimelineReviewDecision(pipeline?.reviewStatus ?? "none"),
        };
      })
      : [],
  }));
  const q = timelineProgressQuery.value.trim();
  const progress = filterStudioCanvasTimelineProgress(
    {
      units,
      assets: assetItems.map((asset) => ({
        assetId: asset.id,
        category: asset.category,
        // 仅用于搜索投影；不会进入时间线布局或持久化数据。
        label: `${asset.name} ${asset.authorityMediaSha256 ?? ""}`.trim(),
      })),
    },
    {
      ...(q.startsWith("S") || q.includes("-U") ? { unitQuery: q } : {}),
      ...(q && !(q.startsWith("S") || q.includes("-U")) ? { assetQuery: q } : {}),
      ...(timelineProgressReview.value
        ? { reviewStatus: timelineProgressReview.value }
        : {}),
    },
  );
  // 非当前单元的宫格不会全部展开到 DOM；按它们的 panel.assetIds 搜索会漏掉
  // 已通过 raw 的实际冻结参考。因此资产名 / assetId / 参考 SHA 必须直接检索 raw 的
  // 不可变参考闭包。该闭包只读且仅在内存中合并，绝不写入布局。
  const searchReferences = q && !(q.startsWith("S") || q.includes("-U"))
    && (!timelineProgressReview.value || timelineProgressReview.value === "pass");
  if (!searchReferences) return progress;
  const query = q.toLowerCase();
  const directlyMatchedUnitIds = units
    .filter((unit) => {
      const raw = unitGridRawPipeline.value.get(unit.unitId);
      if (raw?.rawMediaSha256.toLowerCase().includes(query)) return true;
      return (unitGridReferencePipeline.value.get(unit.unitId) ?? []).some((reference) => (
        reference.mediaSha256.toLowerCase().includes(query)
        || reference.referenceId.toLowerCase().includes(query)
        || reference.assetIds.some((assetId) => assetId.toLowerCase().includes(query))
        || reference.title.toLowerCase().includes(query)
        || reference.typeLabel.toLowerCase().includes(query)
      ));
    })
    .map((unit) => unit.unitId);
  if (directlyMatchedUnitIds.length === 0) return progress;
  const matched = new Set([...progress.matchedUnitIds, ...directlyMatchedUnitIds]);
  const matchedUnitIds = units.map((unit) => unit.unitId).filter((unitId) => matched.has(unitId));
  return {
    ...progress,
    matchedUnitIds,
    unitCount: matchedUnitIds.length,
  };
});

const timelineProgressDimmedPanelIds = computed(() => {
  const result = timelineProgressFilterResult.value;
  if (!result) return new Set<string>();
  const matched = new Set(result.matchedPanelIds);
  // 无宫格命中时不 dim 全部，避免空白误导
  if (matched.size === 0) return new Set<string>();
  const all = panelTimelineStrip.value.map((row) => row.panelId);
  return new Set(all.filter((id) => !matched.has(id)));
});

function timelineChipLabel(row: { hasRaw?: boolean; hasLabeled?: boolean; reviewDecision?: string }): string {
  if (row.reviewDecision === "pass") return "通过";
  if (row.reviewDecision === "rework") return "返工";
  if (row.reviewDecision === "reject") return "拒绝";
  if (row.hasRaw && row.hasLabeled) return "待审";
  if (row.hasRaw) return "有图";
  return "待生";
}

/**
 * T12/T13: 从批量时间线投影获取单元双编号标签（如 `029｜S1E01-U28`）。
 * 前端不自行计算编号，只消费核心层返回的 displayLabel。
 */
function getUnitDualLabel(unitId: string): string {
  const units = timelineProjection.projection.value;
  if (!units) return "";
  const unit = units.find((u) => u.unitId === unitId);
  return unit?.displayLabel ?? "";
}

/**
 * T21: 当前单元的生产状态后缀（显示在标题栏如“· 已通过”“· 待审”“· 生成中”）。
 */
const unitProductionStatusSuffix = computed(() => {
  if (!unitDetail.value) return "";
  const units = timelineProjection.projection.value;
  if (!units) return "";
  const unit = units.find((u) => u.unitId === unitDetail.value!.unit.id);
  if (!unit) return "";
  switch (unit.productionStatus) {
    case "pass": return " · ✅ 已通过";
    case "result_pending_review": return " · ⏳ 待审";
    case "ready_to_dispatch": case "dispatched_no_call": case "generation_unknown":
      return " · ⚡ 生成中";
    case "failed_retryable": return " · ❌ 失败可重试";
    case "cancelled": return " · ⛔ 已取消";
    case "binding_blocked": return " · 🚫 绑定阻塞";
    case "rework": return " · 🔄 返工";
    default: return " · • " + unit.productionStatus;
  }
});
const unitContextText = computed(() => {
  const selectedUnit = selection.value?.kind === "unit" ? selection.value.unit : undefined;
  if (selectedUnit && unitDetail.value?.unit.id !== selectedUnit.id) {
    return `${getUnitDualLabel(selectedUnit.id) || selectedUnit.label} · ${selectedUnit.panelCount} 宫格 · 正在载入`;
  }
  if (unitDetail.value) {
    return `${getUnitDualLabel(unitDetail.value.unit.id) || unitDetail.value.unit.label} · ${unitDetail.value.panels.length} 宫格${unitProductionStatusSuffix.value}`;
  }
  return "添加素材和 15 秒分镜，然后准备并记录派发";
});

/**
 * T12: 增强搜索——当输入匹配双编号时，优先用批量投影进行精确匹配。
 * 支持 029、U28、S1E01-U28、unitId 多种形式（统一搜索要求）。
 */
function searchUnitsFromProjection(query: string): string[] {
  const results = timelineProjection.searchUnits(query);
  return results.map((u) => u.unitId);
}

async function focusPanelOnCanvas(panelId: string): Promise<void> {
  const id = `panel:${panelId}`;
  const node = nodes.value.find((entry) => entry.id === id);
  if (!node) {
    if (unitDetail.value) await selectUnit(unitDetail.value.unit, panelId);
    return;
  }
  selection.value = { kind: "panel", panel: unitDetail.value?.panels.find((panel) => panel.id === panelId) ?? {
    id: panelId,
    ordinal: 0,
    label: panelId,
    startSeconds: 0,
    endSeconds: 0,
    durationSeconds: 0,
    status: "unchecked",
    bindingCurrentness: "missing",
    assetIds: [],
    locator: { kind: "panel", projectId: overview.value?.projectId ?? "", unitId: unitDetail.value?.unit.id ?? "", panelId },
  } as StudioDashboardPanelSummary };
  try {
    await studioFlow.setCenter(node.position.x + 86, node.position.y + 58, { duration: 280, zoom: Math.max(zoom.value, 0.7) });
  } catch {
    // VueFlow 未就绪时忽略
  }
}

async function applyTimelineLayout(force: boolean): Promise<void> {
  if (isDragging.value) return;
  const timeline = computeTimelineLayout();
  if (!timeline) {
    errorMessage.value = "当前没有可排布的时间线节点（请先添加 15 秒分镜）。";
    return;
  }
  const before = currentPositionMap();
  const nextPositions = applyStudioCanvasTimelinePositions(
    plainNodePositions(before),
    timeline,
    { pinnedNodeIds: force ? [] : pinnedNodeIds.value, force },
  );
  // 仅写回当前图上节点的变更；时间线缺省坐标仍写入 persisted 供新节点 fallback
  const changed: CanvasPositionMap = {};
  for (const node of nodes.value) {
    const hit = nextPositions[node.id];
    if (!hit) continue;
    const prev = before[node.id];
    if (!prev || Math.abs(prev.x - hit.x) > 0.5 || Math.abs(prev.y - hit.y) > 0.5) {
      changed[node.id] = { x: hit.x, y: hit.y };
    }
  }
  persistedLayoutNodes.value = {
    ...persistedLayoutNodes.value,
    ...nextPositions,
  };
  if (Object.keys(changed).length === 0) {
    scheduleLayoutPersist();
    await nextTick();
    await focusTimelineAnchor(timeline);
    return;
  }
  undoStack.push(before);
  bumpUndoTick();
  applyPositionMap(changed);
  await nextTick();
  await focusTimelineAnchor(timeline);
}

/**
 * 首次打开不可把 fallback 坐标当成用户布局：那会让整板、冻结参考和连续性节点
 * 叠在一起。只在磁盘尚无任何布局记录时写入时间线默认值；用户移动过一次后，
 * 后续刷新与重启都严格复用其布局。
 */
async function applyInitialTimelineLayoutIfNeeded(projectRoot = props.projectRoot): Promise<void> {
  if (projectRoot !== props.projectRoot
    || initialTimelineLayoutAppliedRoot.value === projectRoot
    || layoutFingerprint.value
    || Object.keys(persistedLayoutNodes.value).length > 0
    || workspaceMode.value !== "projection"
    || !nodes.value.length) return;
  initialTimelineLayoutAppliedRoot.value = projectRoot;
  await applyTimelineLayout(false);
}

/**
 * 大型时间线排布后不能立即“适配全部”：每个单元下方都有实际冻结参考，
 * 全景缩放会把正式 raw 和参考链压成无法审阅的缩略图。优先聚焦当前单元，
 * 未选中时从时间线首个单元开始；全局鸟瞰仍由“适配”按钮显式触发。
 */
async function focusTimelineAnchor(timeline: StudioCanvasTimelineLayout): Promise<void> {
  const firstUnitId = timeline.activeUnitId
    ?? Object.entries(timeline.nodes)
      .filter(([id]) => id.startsWith("unit:"))
      .sort(([, left], [, right]) => left.x - right.x || left.y - right.y)[0]?.[0]
      ?.slice("unit:".length);
  const rawId = firstUnitId ? `media:unit-grid-raw:${firstUnitId}` : "";
  const anchor = (rawId && nodes.value.find((node) => node.id === rawId))
    ?? (firstUnitId ? nodes.value.find((node) => node.id === `unit:${firstUnitId}`) : undefined);
  if (!anchor) {
    await fitCanvas();
    return;
  }
  try {
    await studioFlow.setCenter(anchor.position.x + 94, anchor.position.y + 100, {
      duration: 220,
      zoom: Math.max(zoom.value, 0.72),
    });
  } catch {
    await fitCanvas();
  }
}

/** 进度搜索逐键触发会全量过滤数百单元；150ms 防抖合并连续输入，卸载时清理定时器。 */
let timelineSearchFocusTimer = 0;
const timelineProgressQueryEl = ref<HTMLInputElement | null>(null);

function focusTimelineProgressQuery(): void {
  const el = timelineProgressQueryEl.value;
  if (!el) return;
  el.focus();
  el.select();
}

function onTimelineSearchEnter(event: KeyboardEvent): void {
  if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
  void focusTimelineSearchResult();
}

function scheduleFocusTimelineSearchResult(): void {
  if (timelineSearchFocusTimer) window.clearTimeout(timelineSearchFocusTimer);
  timelineSearchFocusTimer = window.setTimeout(() => {
    timelineSearchFocusTimer = 0;
    void focusTimelineSearchResult();
  }, 150);
}

/** 搜索只有一个单元命中时直接定位，避免“找到了但还要在大画布里找”。 */
function collectTimelineSearchUnitIds(): string[] {
  const q = timelineProgressQuery.value.trim();
  if (q) {
    const projectionMatches = searchUnitsFromProjection(q);
    if (projectionMatches.length > 0) return projectionMatches;
  }
  return timelineProgressFilterResult.value?.matchedUnitIds ?? [];
}

async function centerOnTimelineSearchUnit(unitId: string): Promise<void> {
  const anchor = nodes.value.find((node) => node.id === `media:unit-grid-raw:${unitId}`)
    ?? nodes.value.find((node) => node.id === `generation-state:${unitId}`)
    ?? nodes.value.find((node) => node.id === `unit:${unitId}`);
  if (!anchor) return;
  try {
    await studioFlow.setCenter(anchor.position.x + 94, anchor.position.y + 100, {
      duration: 180,
      zoom: Math.max(zoom.value, 0.72),
    });
  } catch {
    // 搜索不应破坏当前视图；Vue Flow 未就绪时保持原位置。
  }
}

async function focusTimelineSearchResult(): Promise<void> {
  await nextTick();
  const unitIds = collectTimelineSearchUnitIds();
  if (unitIds.length !== 1) return;
  await centerOnTimelineSearchUnit(unitIds[0]!);
}

let timelineSearchCursor = -1;

async function cycleTimelineSearchHit(direction: 1 | -1): Promise<void> {
  await nextTick();
  const unitIds = collectTimelineSearchUnitIds();
  if (!unitIds.length) return;
  const next = timelineSearchCursor < 0
    ? (direction > 0 ? 0 : unitIds.length - 1)
    : (timelineSearchCursor + direction + unitIds.length) % unitIds.length;
  timelineSearchCursor = next;
  await centerOnTimelineSearchUnit(unitIds[next]!);
}

watch([timelineProgressQuery, timelineProgressReview], () => {
  timelineSearchCursor = -1;
});

/** IPC 只接收纯对象；Vue ref 内的深层 Proxy 不能直接穿过 structured clone。 */
function plainNodePositions(input: Record<string, StudioCanvasNodePosition>): Record<string, StudioCanvasNodePosition> {
  return Object.fromEntries(Object.entries(input).map(([id, position]) => [id, { x: position.x, y: position.y }]));
}

/** 流水线节点只保留当前可见单元，防止逐集浏览把 4×宫格坐标无限累积。 */
function boundedLayoutNodes(input: Record<string, StudioCanvasNodePosition>): Record<string, StudioCanvasNodePosition> {
  const visible = new Set(nodes.value.map((node) => node.id));
  return Object.fromEntries(Object.entries(input).filter(([nodeId]) => (
    (!nodeId.startsWith("panel:")
      && !nodeId.startsWith("media:")
      && !nodeId.startsWith("reference:")
      && !nodeId.startsWith("library-media:"))
    || visible.has(nodeId)
  )));
}

function plainDraftEdges(): StudioCanvasDraftEdge[] {
  return draftCanvasEdges.value.map((edge) => ({
    sourceId: edge.sourceId,
    targetId: edge.targetId,
    sourceKind: String(edge.sourceKind),
    targetKind: String(edge.targetKind),
  }));
}

function plainWorkflowGroups(groups: readonly StudioCanvasWorkflowGroup[]): StudioCanvasWorkflowGroup[] {
  return groups.map((group) => ({
    id: group.id,
    title: group.title,
    panelIds: [...group.panelIds],
    pipeline: [...group.pipeline],
    createdAt: group.createdAt,
  }));
}

function plainSpatialGroups(groups: readonly StudioCanvasSpatialGroup[]): StudioCanvasSpatialGroup[] {
  return groups.map((group) => {
    const node = nodes.value.find((candidate) => candidate.id === group.id);
    return {
      id: group.id,
      title: group.title,
      memberIds: [...group.memberIds],
      x: node?.position.x ?? group.x,
      y: node?.position.y ?? group.y,
      width: group.width,
      height: group.height,
    };
  });
}

function collectAbsoluteNodePositions(): Record<string, StudioCanvasNodePosition> {
  const byId = new Map(nodes.value.map((node) => [node.id, node]));
  const collected: Record<string, StudioCanvasNodePosition> = {};
  for (const node of nodes.value) {
    if (node.type === "studioSpatialGroup") continue;
    let x = node.position.x;
    let y = node.position.y;
    const parentId = (node as Node & { parentNode?: string }).parentNode;
    if (parentId) {
      const parent = byId.get(parentId);
      if (parent) {
        x += parent.position.x;
        y += parent.position.y;
      }
    }
    collected[node.id] = { x, y };
  }
  return collectStudioCanvasNodePositions(
    Object.entries(collected).map(([id, position]) => ({ id, position })),
  );
}

function isPinned(nodeId: string): boolean {
  return pinnedNodeIds.value.includes(nodeId);
}

function applySpatialGrouping(source: Node[]): Node[] {
  const groups = spatialGroups.value;
  if (!groups.length) return source;
  const byId = new Map(source.map((node) => [node.id, node]));
  const groupNodes: Node[] = groups.map((group) => ({
    id: group.id,
    type: "studioSpatialGroup",
    position: { x: group.x, y: group.y },
    style: { width: `${group.width}px`, height: `${group.height}px` },
    data: {
      title: group.title,
      memberIds: [...group.memberIds],
      width: group.width,
      height: group.height,
    },
    selectable: true,
    draggable: true,
    zIndex: -1,
  }));
  for (const group of groups) {
    for (const memberId of group.memberIds) {
      const node = byId.get(memberId);
      if (!node) continue;
      const abs = node.position;
      (node as Node & { parentNode?: string; extent?: string }).parentNode = group.id;
      (node as Node & { parentNode?: string; extent?: string }).extent = "parent";
      node.position = { x: abs.x - group.x, y: abs.y - group.y };
    }
  }
  return [...groupNodes, ...source];
}

function groupSelectedCanvasNodes(): void {
  if (loading.value || pinActionBusy.value || isDragging.value) return;
  const selected = nodes.value.filter((node) => (
    (node as CanvasFlowNodeLike).selected
    && node.type !== "studioSpatialGroup"
    && !(node as Node & { parentNode?: string }).parentNode
  ));
  if (selected.length < 2) {
    errorMessage.value = "至少选中两个未分组节点才能创建命名组。";
    return;
  }
  const abs = selected.map((node) => ({
    id: node.id,
    ...node.position,
    width: Number((node as Node & { dimensions?: { width?: number } }).dimensions?.width ?? 220),
    height: Number((node as Node & { dimensions?: { height?: number } }).dimensions?.height ?? 140),
  }));
  const minX = Math.min(...abs.map((item) => item.x)) - 24;
  const minY = Math.min(...abs.map((item) => item.y)) - 36;
  const maxX = Math.max(...abs.map((item) => item.x + item.width)) + 24;
  const maxY = Math.max(...abs.map((item) => item.y + item.height)) + 24;
  const group: StudioCanvasSpatialGroup = {
    id: `group:${crypto.randomUUID()}`,
    title: `组 ${spatialGroups.value.length + 1}`,
    memberIds: abs.map((item) => item.id),
    x: Math.round(minX),
    y: Math.round(minY),
    width: Math.max(80, Math.round(maxX - minX)),
    height: Math.max(60, Math.round(maxY - minY)),
  };
  spatialGroups.value = [...spatialGroups.value, group];
  rebuildGraph();
  scheduleLayoutPersist();
}

function ungroupSelectedCanvasNodes(): void {
  if (loading.value || pinActionBusy.value || isDragging.value) return;
  const selectedIds = new Set(nodes.value.filter((node) => (node as CanvasFlowNodeLike).selected).map((node) => node.id));
  if (!selectedIds.size) return;
  const next = spatialGroups.value.filter((group) => !selectedIds.has(group.id) && !group.memberIds.some((id) => selectedIds.has(id)));
  if (next.length === spatialGroups.value.length) return;
  spatialGroups.value = next;
  rebuildGraph();
  scheduleLayoutPersist();
}

function pruneDraftEdgesForRemovedNodes(removed: ReadonlySet<string>): void {
  if (!removed.size) return;
  draftCanvasEdges.value = draftCanvasEdges.value.filter((edge) => !removed.has(edge.sourceId) && !removed.has(edge.targetId));
  if (selectedDraftEdgeId.value && !draftCanvasEdges.value.some((edge) => `draft:${edge.sourceId}:${edge.targetId}` === selectedDraftEdgeId.value)) {
    selectedDraftEdgeId.value = "";
  }
}

async function togglePinnedNode(nodeId: string): Promise<void> {
  const normalized = nodeId.trim();
  if (!normalized || pinActionBusy.value) return;
  const current = new Set(pinnedNodeIds.value);
  const wasPinned = current.has(normalized);
  if (!wasPinned) {
    const prefix = normalized.split(":", 1)[0];
    if (prefix === "asset" && [...current].filter((id) => id.startsWith("asset:")).length >= 36) {
      errorMessage.value = "一个 15 秒单元最多可固定 36 项素材（每格仍严格最多 6 项）；请先移除不再使用的素材。";
      return;
    }
    if (prefix === "script" || prefix === "prompt") {
      const sameKind = [...current].filter((id) => id.startsWith(`${prefix}:`));
      if (sameKind.length >= 6) {
        errorMessage.value = `一个 15 秒单元最多固定 6 个${prefix === "script" ? "剧本" : "提示词"}版本；请先移除旧版本。`;
        return;
      }
    }
    if (prefix === "library-media"
      && [...current].filter((id) => id.startsWith("library-media:")).length >= STUDIO_CANVAS_PINNED_MEDIA_LIMIT) {
      errorMessage.value = `画布最多固定 ${STUDIO_CANVAS_PINNED_MEDIA_LIMIT} 个独立媒体节点；请先移出不再使用的媒体。`;
      return;
    }
  }
  const projectRoot = props.projectRoot;
  const scope = {
    token: pinActionGate.begin(projectRoot, `pin:${normalized}`),
    projectRoot,
    actionId: `pin:${normalized}`,
  };
  const previousPinnedNodeIds = [...pinnedNodeIds.value];
  const previousPinnedMediaItems = new Map(pinnedMediaItems.value);
  const enteringWorkflow = workspaceMode.value !== "workflow";
  pinActionBusy.value = true;
  try {
    if (wasPinned) {
      current.delete(normalized);
      pruneDraftEdgesForRemovedNodes(new Set([normalized]));
    } else {
      current.add(normalized);
    }
    pinnedNodeIds.value = [...current];
    if (normalized.startsWith("asset:")) {
      errorMessage.value = "";
      try {
      // 首次从“查看全部”进入工作流时，先保留旧投影并完成精确资产读取；若先切
      // workflow，任何并发状态刷新都会短暂重建空图，Vue Flow 的延迟 remove
      // 事件随后可能反向删除已加载节点。
        if (wasPinned) {
          detachCharacterCompanionAudio(normalized.slice("asset:".length), current);
        } else {
          await attachCharacterCompanionAudio(normalized.slice("asset:".length), current, projectRoot);
          if (!canvasUiActionIsCurrent(pinActionGate, scope)) return;
        }
        pinnedNodeIds.value = [...current];
        await loadPinnedAssets({ rebuild: !enteringWorkflow });
        if (!canvasUiActionIsCurrent(pinActionGate, scope)) return;
      } catch (error) {
        if (!canvasUiActionIsCurrent(pinActionGate, scope)) return;
        pinnedNodeIds.value = previousPinnedNodeIds;
        errorMessage.value = `固定素材读取失败：${message(error)}`;
        emit("failed", errorMessage.value);
        rebuildGraph();
        return;
      }
    } else if (normalized.startsWith("script:") || normalized.startsWith("prompt:")) {
      await loadPinnedTextDocuments();
      if (!canvasUiActionIsCurrent(pinActionGate, scope)) return;
      if (!enteringWorkflow) rebuildGraph();
    } else if (normalized.startsWith("library-media:")) {
      try {
        const sha256 = normalized.slice("library-media:".length);
        const nextMedia = new Map(pinnedMediaItems.value);
        if (wasPinned) {
          nextMedia.delete(sha256);
        } else {
          const media = mediaPage.value?.items.find((item) => item.sha256 === sha256)
            ?? await window.canvasApi.getStudioMedia(projectRoot, sha256);
          if (!media) throw new Error("媒体已不存在。");
          nextMedia.set(sha256, media);
        }
        if (!canvasUiActionIsCurrent(pinActionGate, scope)) return;
        pinnedMediaItems.value = nextMedia;
        if (!enteringWorkflow) rebuildGraph();
      } catch (error) {
        if (!canvasUiActionIsCurrent(pinActionGate, scope)) return;
        pinnedNodeIds.value = previousPinnedNodeIds;
        pinnedMediaItems.value = previousPinnedMediaItems;
        errorMessage.value = `固定媒体读取失败：${message(error)}`;
        emit("failed", errorMessage.value);
        rebuildGraph();
        return;
      }
    } else if (!enteringWorkflow) {
      rebuildGraph();
    }
    if (enteringWorkflow) {
      workspaceMode.value = "workflow";
      rebuildGraph();
      // “查看全部”与首次工作流通常使用不同的空间范围；继续沿用旧视口会把新固定
      // 节点留在屏幕外，并被 only-render-visible-elements 剔除，用户看起来像添加失败。
      await nextTick();
      if (!canvasUiActionIsCurrent(pinActionGate, scope)) return;
      // 适配视口是纯视觉动画；Vue Flow 在部分 Electron 窗口中可能长期不
      // resolve 动画 Promise。它不得占住固定节点的唯一 busy owner，否则
      // 第一项已经进画布后，后续图片/视频/音频会永久保持“添加”禁用。
      void fitCanvas().catch((error) => {
        if (!canvasUiActionIsCurrent(pinActionGate, scope)) return;
        errorMessage.value = `节点已添加，但画布自动适配失败：${message(error)}`;
        emit("failed", errorMessage.value);
      });
    }
    if (!canvasUiActionIsCurrent(pinActionGate, scope)) return;
    scheduleLayoutPersist();
  } finally {
    // root 切换会同步清 busy；旧 root 的 finally 不得清掉新 root 的 owner。
    if (canvasUiActionIsCurrent(pinActionGate, scope)) pinActionBusy.value = false;
  }
}

async function addUnitToWorkspace(unit: StudioDashboardUnitSummary): Promise<void> {
  if (addUnitActionBusy.value) return;
  const projectRoot = props.projectRoot;
  const scope = {
    token: addUnitActionGate.begin(projectRoot, `add-unit:${unit.id}`),
    projectRoot,
    actionId: `add-unit:${unit.id}`,
  };
  addUnitActionBusy.value = true;
  try {
    workspaceMode.value = "workflow";
    const removed = pinnedNodeIds.value.filter((id) => id.startsWith("unit:") && id !== `unit:${unit.id}`);
    pinnedNodeIds.value = [
      ...pinnedNodeIds.value.filter((id) => !id.startsWith("unit:")),
      `unit:${unit.id}`,
    ];
    if (removed.length) {
      // 宫格属于旧单元；切换目标时禁止保留可能串单元的草稿输入。
      draftCanvasEdges.value = [];
      selectedDraftEdgeId.value = "";
    }
    selection.value = { kind: "unit", unit };
    const result = await loadUnitDetailById(unit.id);
    if (!canvasUiActionIsCurrent(addUnitActionGate, scope) || !result) return;
    // “添加 15 秒分镜”是进入生产画布的最后一步：自动收起两侧抽屉，
    // 让普通用户直接看到完整工作流，不必再手动整理界面。
    libraryOpen.value = false;
    selection.value = null;
    rebuildGraph();
    scheduleLayoutPersist();
    await nextTick();
    if (!canvasUiActionIsCurrent(addUnitActionGate, scope)) return;
    await fitCanvas();
  } catch (error) {
    if (!canvasUiActionIsCurrent(addUnitActionGate, scope)) return;
    errorMessage.value = message(error);
    emit("failed", errorMessage.value);
  } finally {
    if (canvasUiActionIsCurrent(addUnitActionGate, scope)) addUnitActionBusy.value = false;
  }
}

function globalResourceQueryFingerprint(input: {
  projectRoot: string;
  category: MaterialStudioAssetCategory;
  search: string;
  cursor?: string;
}): string {
  return JSON.stringify([
    input.projectRoot,
    "global",
    input.category,
    input.search,
    input.cursor ?? "",
    GLOBAL_RESOURCE_PAGE_LIMIT,
  ]);
}

let globalResourcePendingFingerprint = "";

function invalidateGlobalResourceRequest(): void {
  globalResourceLoadSequence += 1;
  globalResourcePendingFingerprint = "";
  globalResourceLoading.value = false;
  globalResourceError.value = "";
  globalResourcePage.value = null;
  globalResourceCursor.value = undefined;
  globalResourceCursorStack.value = [];
}

function releaseGlobalResourceState(): void {
  invalidateGlobalResourceRequest();
  globalResourceSearch.value = "";
}

function closeLibrary(): void {
  const restoreTestId = libraryMode.value === "global"
    ? "managed-canvas-open-global-resources"
    : "managed-canvas-open-library";
  if (libraryMode.value === "global") releaseGlobalResourceState();
  libraryOpen.value = false;
  document.querySelector<HTMLButtonElement>(`[data-testid="${restoreTestId}"]`)?.focus();
}

async function loadGlobalResources(cursor?: string): Promise<boolean> {
  const resourceApi = props.globalResourceApi;
  if (!resourceApi) {
    invalidateGlobalResourceRequest();
    globalResourceError.value = "当前桌面适配层未接入全部剧本资源。";
    return false;
  }
  const projectRoot = props.projectRoot;
  const category = globalResourceCategory.value;
  const search = globalResourceSearch.value.trim();
  const fingerprint = globalResourceQueryFingerprint({
    projectRoot,
    category,
    search,
    cursor,
  });
  const requestSequence = ++globalResourceLoadSequence;
  globalResourcePendingFingerprint = fingerprint;
  globalResourceLoading.value = true;
  globalResourceError.value = "";
  const isCurrent = (): boolean => (
    !canvasDisposed
    && requestSequence === globalResourceLoadSequence
    && globalResourcePendingFingerprint === fingerprint
    && projectRoot === props.projectRoot
    && libraryOpen.value
    && libraryMode.value === "global"
    && category === globalResourceCategory.value
    && search === globalResourceSearch.value.trim()
  );
  try {
    const page = await resourceApi.listEntries(projectRoot, {
      section: category,
      scope: "all",
      representation: "images",
      ...(search ? { search } : {}),
      ...(cursor ? { cursor } : {}),
      limit: GLOBAL_RESOURCE_PAGE_LIMIT,
    });
    if (!isCurrent()) return false;
    globalResourcePage.value = {
      ...page,
      // Core 已限 36；renderer 再做边界保护，禁止异常适配层把 549 项一次挂入 DOM。
      items: page.items.slice(0, GLOBAL_RESOURCE_PAGE_LIMIT),
    };
    globalResourceCursor.value = cursor;
    return true;
  } catch (error) {
    if (!isCurrent()) return false;
    const detail = message(error);
    globalResourceError.value = detail.includes("cursor")
      ? `剧本资源目录已变化，请重新从第一页读取。${detail}`
      : `剧本资源读取失败：${detail}`;
    return false;
  } finally {
    if (isCurrent()) globalResourceLoading.value = false;
  }
}

async function resetGlobalResources(): Promise<void> {
  globalResourceCursor.value = undefined;
  globalResourceCursorStack.value = [];
  globalResourcePage.value = null;
  await loadGlobalResources();
}

async function openGlobalResourcesFor(category: MaterialStudioAssetCategory): Promise<void> {
  if (globalResourceLoading.value) return;
  globalResourceCategory.value = category;
  await resetGlobalResources();
}

async function globalResourcesNext(): Promise<void> {
  if (globalResourceLoading.value) return;
  const next = globalResourcePage.value?.nextCursor;
  if (!next) return;
  const previousCursor = globalResourceCursor.value ?? "";
  if (await loadGlobalResources(next)) {
    globalResourceCursorStack.value = [...globalResourceCursorStack.value, previousCursor];
  }
}

async function globalResourcesPrevious(): Promise<void> {
  if (globalResourceLoading.value) return;
  const previous = globalResourceCursorStack.value.at(-1);
  if (previous === undefined) return;
  if (await loadGlobalResources(previous || undefined)) {
    globalResourceCursorStack.value = globalResourceCursorStack.value.slice(0, -1);
  }
}

async function openLibraryFor(kind: StudioCanvasLibraryTab): Promise<void> {
  if (libraryMode.value === "global") releaseGlobalResourceState();
  libraryMode.value = "current";
  libraryTab.value = kind;
  libraryOpen.value = true;
  addMenuOpen.value = false;
  if (kind === "character" || kind === "scene" || kind === "prop" || kind === "style") {
    assetCategory.value = kind;
    if (kind === "character") await refreshCharacterVoices();
    await resetAssets();
  } else if (kind === "media") {
    await resetMedia();
  }
}

async function toggleLibrary(): Promise<void> {
  if (libraryOpen.value && libraryMode.value === "current") {
    closeLibrary();
    return;
  }
  await openLibraryFor(libraryTab.value);
}

async function toggleGlobalResourceLibrary(): Promise<void> {
  if (libraryOpen.value && libraryMode.value === "global") {
    closeLibrary();
    return;
  }
  if (globalResourceLoading.value) invalidateGlobalResourceRequest();
  libraryMode.value = "global";
  libraryOpen.value = true;
  addMenuOpen.value = false;
  selection.value = null;
  await resetGlobalResources();
}

function chooseAddKind(kind: StudioCanvasLibraryTab): void {
  void openLibraryFor(kind);
}

/** 外科式清除 connection-pending 描边：只改写受影响节点的 class，不做全量重建（P15 合同：连线切换不重建节点）。 */
function stripPendingOutline(nodeId: string): void {
  if (!nodeId) return;
  nodes.value = nodes.value.map((node) => {
    if (node.id !== nodeId) return node;
    const classes = Array.isArray(node.class)
      ? node.class.map(String).join(" ")
      : typeof node.class === "string" ? node.class : "";
    const stripped = classes.replace(/\bconnection-pending\b/g, "").replace(/\s{2,}/g, " ").trim();
    return stripped === classes ? node : { ...node, class: stripped };
  });
}

function helpCloseButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('#managed-canvas-help-card button[aria-label="关闭帮助"]');
}

function closeHelp(): void {
  if (!helpOpen.value) return;
  helpOpen.value = false;
  helpTriggerEl.value?.focus();
}

function toggleHelp(): void {
  helpOpen.value = !helpOpen.value;
  if (helpOpen.value) {
    void nextTick(() => {
      helpCloseButton()?.focus();
    });
    return;
  }
  helpTriggerEl.value?.focus();
}

function toggleAddMenu(): void {
  addMenuOpen.value = !addMenuOpen.value;
  if (addMenuOpen.value) {
    addMenuRovingIndex.value = 0;
    void nextTick(() => {
      document.querySelector<HTMLButtonElement>("#managed-canvas-add-menu button")?.focus();
    });
  }
}

function restoreConnectTriggerFocus(): void {
  document.querySelector<HTMLButtonElement>('[data-testid="managed-canvas-connect-mode"]')?.focus();
}

function restoreDirectorToggleFocus(): void {
  document.querySelector<HTMLButtonElement>('[data-testid="managed-canvas-director-toggle"]')?.focus();
}

watch(directorPanelOpen, (open) => {
  if (!open) return;
  void nextTick(() => {
    document.querySelector<HTMLInputElement>('[data-testid="director-panel-filter"]')?.focus();
  });
});

function toggleDirectorPanel(): void {
  directorPanelOpen.value = !directorPanelOpen.value;
  if (directorPanelOpen.value) return;
  restoreDirectorToggleFocus();
}

function closeDirectorPanel(): void {
  if (!directorPanelOpen.value) return;
  directorPanelOpen.value = false;
  restoreDirectorToggleFocus();
}

function directorPanelFocusables(): HTMLElement[] {
  const root = document.querySelector("[data-testid='director-action-panel']");
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(
    "[data-testid='director-panel-close'], [data-testid='director-panel-filter'], .director-action:not(:disabled)",
  ));
}

function moveDirectorPanelFocus(shiftKey: boolean): void {
  const items = directorPanelFocusables();
  if (!items.length) return;
  const active = document.activeElement;
  const index = items.findIndex((el) => el === active || el.contains(active));
  const current = index >= 0 ? index : 0;
  const next = shiftKey
    ? (current - 1 + items.length) % items.length
    : (current + 1) % items.length;
  items[next]?.focus();
}

function closeInspector(): void {
  const selectedNode = nodes.value.find((node) => node.selected);
  const nodeId = selectedNode?.id;
  selection.value = null;
  void nextTick(() => restoreInspectorFlowFocus(nodeId));
}

function closeCanvasError(): void {
  errorMessage.value = "";
  restoreInspectorFlowFocus();
}

function restoreInspectorFlowFocus(nodeId?: string): void {
  if (nodeId) {
    const nodeEl = document.querySelector<HTMLElement>(`#managed-studio-flow .vue-flow__node[data-id="${CSS.escape(nodeId)}"]`);
    if (nodeEl) {
      if (nodeEl.tabIndex < 0) nodeEl.tabIndex = -1;
      nodeEl.focus();
      return;
    }
  }
  const flow = document.querySelector<HTMLElement>("#managed-studio-flow");
  if (!flow) return;
  if (flow.tabIndex < 0) flow.tabIndex = -1;
  flow.focus();
}

function toggleConnectMode(): void {
  const previousPendingId = pendingConnectionSourceId.value;
  connectMode.value = !connectMode.value;
  pendingConnectionSourceId.value = "";
  addMenuOpen.value = false;
  // 取消连线后清除烘进节点 class 的 connection-pending 描边（F-02；外科清除，不触发全量重建）。
  stripPendingOutline(previousPendingId);
  if (!connectMode.value) restoreConnectTriggerFocus();
}

/**
 * 可见＋号使用本组件自己的两次点击状态机；Vue Flow 的 handle 只负责锚点和拖线。
 * 这样重复边、panel→panel、自环等业务错误都一定进入 onConnect，不能被库静默吞掉。
 */
function onConnectPoint(nodeId: string): void {
  errorMessage.value = "";
  connectMode.value = true;
  const first = pendingConnectionSourceId.value;
  if (!first) {
    pendingConnectionSourceId.value = nodeId;
    rebuildGraph();
    return;
  }
  pendingConnectionSourceId.value = "";
  if (first === nodeId) {
    errorMessage.value = "同一个节点不能连接到自己；请选择另一个节点的＋。";
    rebuildGraph();
    return;
  }
  onConnect({ source: first, target: nodeId, sourceHandle: null, targetHandle: null });
}

function onDraftEdgeClick(event: { edge?: { id?: string } }): void {
  const id = event.edge?.id?.trim() ?? "";
  if (!id.startsWith("draft:")) return;
  selectedDraftEdgeId.value = selectedDraftEdgeId.value === id ? "" : id;
  rebuildGraph();
}

function deleteSelectedDraftEdge(): void {
  const selected = selectedDraftEdgeId.value;
  if (!selected) return;
  const before = draftCanvasEdges.value.length;
  draftCanvasEdges.value = draftCanvasEdges.value.filter((edge) => `draft:${edge.sourceId}:${edge.targetId}` !== selected);
  selectedDraftEdgeId.value = "";
  if (draftCanvasEdges.value.length === before) return;
  errorMessage.value = "";
  rebuildGraph();
  scheduleLayoutPersist();
}

function draftNodeFromCanvas(node: Node): StudioCanvasWorkflowDraftNodeInput | null {
  const kind = String(node.data?.kind ?? "");
  const id = String(node.data?.id ?? "").trim();
  if (!id) return null;
  if (kind === "asset") return { id: node.id, kind, assetId: id };
  if (kind === "script" || kind === "prompt") return { id: node.id, kind, documentId: id };
  if (kind === "panel") return { id: node.id, kind, panelId: id };
  return null;
}

function buildWorkflowDraftInput(edgeCandidates: readonly StudioCanvasDraftEdge[]): StudioCanvasWorkflowDraftInput {
  const endpointIds = new Set(edgeCandidates.flatMap((edge) => [edge.sourceId, edge.targetId]));
  const draftNodes = nodes.value
    .filter((node) => endpointIds.has(node.id))
    .map(draftNodeFromCanvas)
    .filter((node): node is StudioCanvasWorkflowDraftNodeInput => Boolean(node));
  return {
    nodes: draftNodes,
    edges: edgeCandidates.map((edge) => ({ sourceId: edge.sourceId, targetId: edge.targetId })),
  };
}

function onConnect(connection: Connection): void {
  if (!connection.source || !connection.target) return;
  const sourceNode = nodes.value.find((node) => node.id === connection.source);
  const targetNode = nodes.value.find((node) => node.id === connection.target);
  if (!sourceNode || !targetNode) {
    errorMessage.value = "连线端点已经变化，请刷新后重试。";
    pendingConnectionSourceId.value = "";
    rebuildGraph();
    return;
  }
  let source = sourceNode;
  let target = targetNode;
  if (source.data?.kind === "panel" && ["asset", "script", "prompt"].includes(String(target.data?.kind))) {
    [source, target] = [target, source];
  }
  const sourceKind = String(source.data?.kind ?? "");
  const targetKind = String(target.data?.kind ?? "");
  if (!["asset", "script", "prompt"].includes(sourceKind) || targetKind !== "panel") {
    errorMessage.value = "只需把角色、场景、道具、风格、剧本或提示词连接到宫格。";
    rebuildGraph();
    return;
  }
  const candidate: StudioCanvasDraftEdge = {
    sourceId: source.id,
    targetId: target.id,
    sourceKind,
    targetKind,
  };
  const nextEdges = [...draftCanvasEdges.value, candidate];
  const validation = validateStudioCanvasWorkflowDraft(buildWorkflowDraftInput(nextEdges));
  if (!validation.ok) {
    errorMessage.value = validation.error.message;
    rebuildGraph();
    return;
  }
  const nodeById = new Map(nodes.value.map((node) => [node.id, node] as const));
  draftCanvasEdges.value = validation.draft.edges.map((edge) => ({
    sourceId: edge.sourceId,
    targetId: edge.targetId,
    sourceKind: String(nodeById.get(edge.sourceId)?.data?.kind ?? "unknown"),
    targetKind: String(nodeById.get(edge.targetId)?.data?.kind ?? "unknown"),
  }));
  pendingConnectionSourceId.value = "";
  errorMessage.value = "";
  rebuildGraph();
  scheduleLayoutPersist();
}

async function fitCanvasToNodes(source: Node[]): Promise<void> {
  if (!source.length) return;
  // only-render-visible-elements 会让离屏节点暂时没有 dimensions；fitView 会因此遗漏它们。
  // 画布本身已有严格 DOM 上限，直接按所有有界节点的坐标计算包围盒，确保素材与整条
  // 宫格生产链都能被“一键适配”看到。
  const minX = Math.min(...source.map((node) => node.position.x));
  const minY = Math.min(...source.map((node) => node.position.y));
  const maxX = Math.max(...source.map((node) => node.position.x + 188));
  const maxY = Math.max(...source.map((node) => node.position.y + 200));
  await studioFlow.fitBounds({
    x: minX,
    y: minY,
    width: Math.max(188, maxX - minX),
    height: Math.max(200, maxY - minY),
  }, {
    // 左侧给浮动工具栏留出固定安全区，其余空间尽量给节点，避免“一键适配”后文字过小。
    padding: { left: "110px", right: "34px", top: "34px", bottom: "72px" },
    duration: 180,
  });
}

async function fitCanvas(): Promise<void> {
  await fitCanvasToNodes(nodes.value);
}

async function fitSelectedCanvasNodes(): Promise<void> {
  const selected = nodes.value.filter((node) => node.selected);
  if (!selected.length) return;
  await fitCanvasToNodes(selected);
}

function onFitViewControl(): void {
  void fitCanvas().then(() => onControlViewportChanged());
}

function onZoomTo100(): void {
  void studioFlow.zoomTo(1, { duration: 180 }).then(() => onControlViewportChanged());
}

function isShiftDigit(event: KeyboardEvent, digit: "0" | "1" | "2"): boolean {
  return Boolean(
    event.shiftKey
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && (event.key === digit || event.code === `Digit${digit}`),
  );
}

function toggleEdges(): void {
  showEdges.value = !showEdges.value;
  rebuildGraph();
}

function toggleMiniMap(): void {
  miniMapUserOverride.value = !showMiniMap.value;
}

function toggleWorkspaceMode(): void {
  if (workspaceMode.value === "projection" && pinnedNodeIds.value.length === 0) {
    errorMessage.value = "请先从“添加”或“素材库”把节点放到工作区。";
    return;
  }
  workspaceMode.value = workspaceMode.value === "workflow" ? "projection" : "workflow";
  if (workspaceMode.value === "projection") connectMode.value = false;
  pendingConnectionSourceId.value = "";
  rebuildGraph();
  scheduleLayoutPersist();
}

function resetClearConfirmation(): void {
  clearConfirmationArmed.value = false;
  if (clearConfirmationTimer) window.clearTimeout(clearConfirmationTimer);
  clearConfirmationTimer = undefined;
}

function clearWorkflowCanvas(): void {
  if (!clearConfirmationArmed.value) {
    clearConfirmationArmed.value = true;
    if (clearConfirmationTimer) window.clearTimeout(clearConfirmationTimer);
    clearConfirmationTimer = window.setTimeout(resetClearConfirmation, 4_000);
    return;
  }
  resetClearConfirmation();
  pinnedNodeIds.value = [];
  pinnedAssetsPage.value = null;
  pinnedTextDocuments.value = [];
  pinnedMediaItems.value = new Map();
  draftCanvasEdges.value = [];
  workflowGroups.value = [];
  spatialGroups.value = [];
  selectedPanelIds.value = [];
  connectMode.value = false;
  pendingConnectionSourceId.value = "";
  selectedDraftEdgeId.value = "";
  selection.value = null;
  workspaceMode.value = "projection";
  rebuildGraph();
  scheduleLayoutPersist();
  void nextTick(() => restoreInspectorFlowFocus());
}

async function loadPanelPipeline(
  projectRoot: string,
  unitId: string,
  panels: StudioDashboardPanelSummary[],
  unitRequestSequence: number,
): Promise<boolean> {
  const pipelineRequestSequence = ++panelPipelineLoadSequence;
  const isCurrent = () => (
    projectRoot === props.projectRoot
    && unitRequestSequence === unitDetailLoadSequence
    && pipelineRequestSequence === panelPipelineLoadSequence
    && unitDetail.value?.unit.id === unitId
  );
  if (props.api.getProductionProjectionBundle) {
    const bundle = await props.api.getProductionProjectionBundle(projectRoot, {
      unitId,
      ...(unitDetail.value?.selectedPanelId ? { panelId: unitDetail.value.selectedPanelId } : {}),
    });
    if (!isCurrent()) return false;
    if (bundle.currentUnit.unitId !== unitId || bundle.currentUnit.panels.length > 6) {
      throw new Error(`当前单元聚合投影身份不匹配：${bundle.currentUnit.unitId}`);
    }
    const raw = bundle.currentUnit.approvedRaw
      ? { mediaSha256: bundle.currentUnit.approvedRaw.mediaSha256 }
      : undefined;
    const labeled = bundle.currentUnit.approvedLabeled
      ? { mediaSha256: bundle.currentUnit.approvedLabeled.mediaSha256 }
      : undefined;
    const rawThumbnailUrl = authorityThumbUrl(bundle.currentUnit.approvedRaw?.thumbnailRecipeKey);
    const labeledThumbnailUrl = authorityThumbUrl(bundle.currentUnit.approvedLabeled?.thumbnailRecipeKey);
    const rows = bundle.currentUnit.panels.map((panel): readonly [string, PanelPipelineProjection] => [
      panel.panelId,
      {
        ...(bundle.currentUnit.selectedGenerationRunId
          ? { generationRunId: bundle.currentUnit.selectedGenerationRunId }
          : {}),
        ...(bundle.currentUnit.frozenPackIdentity?.id
          ? { packId: bundle.currentUnit.frozenPackIdentity.id }
          : {}),
        ...(raw ? { raw } : {}),
        ...(labeled ? { labeled } : {}),
        ...(rawThumbnailUrl ? { rawThumbnailUrl } : {}),
        ...(labeledThumbnailUrl ? { labeledThumbnailUrl } : {}),
        reviewStatus: panel.review?.status ?? "unreviewed",
      },
    ]);
    selectedUnitRevision.value = bundle.currentUnit.revision;
    currentProductionBundle.value = bundle;
    panelPipeline.value = new Map(rows);
    const packId = bundle.currentUnit.frozenPackIdentity?.id;
    if (raw && labeled && packId) {
      unitGridRawPipeline.value = new Map(unitGridRawPipeline.value).set(unitId, {
        provenance: bundle.currentUnit.selectedResultSource === "historical-import"
          ? "historical-import"
          : "generated",
        verification: bundle.currentUnit.frozenReferences.length > 0
          ? "reference-verified"
          : "ledger-attested",
        generationRunId: bundle.currentUnit.selectedGenerationRunId ?? null,
        packId,
        packFingerprint: bundle.currentUnit.selectedPackFingerprint,
        rawMediaSha256: raw.mediaSha256,
        labeledMediaSha256: labeled.mediaSha256,
        rawThumbnailUrl,
      });
    }
    return true;
  }

  // 兼容注入旧测试/外壳；正式桌面端始终提供上面的聚合 IPC。
  currentProductionBundle.value = null;
  const snapshot = await window.canvasApi.getStudioProductionUnit(projectRoot, unitId);
  const rows: Array<readonly [string, PanelPipelineProjection]> = await Promise.all(panels.slice(0, 6).map(async (panel): Promise<readonly [string, PanelPipelineProjection]> => {
    const history = await window.canvasApi.listStudioGenerationPanelHistory(projectRoot, {
      unitId,
      panelId: panel.id,
      limit: 24,
      order: "newest-first",
    });
    const latest = history.items[0];
    if (!latest) return [panel.id, { reviewStatus: "unreviewed" }];
    const runItems = history.items.filter((item) => item.generationRunId === latest.generationRunId);
    const raw = [...runItems].reverse().find((item) => item.variant === "raw");
    const labeled = [...runItems].reverse().find((item) => item.variant === "labeled");
    const [review, rawMedia, labeledMedia] = await Promise.all([
      window.canvasApi.getStudioGenerationReviewControl(projectRoot, latest.generationRunId),
      raw ? window.canvasApi.getStudioMedia(projectRoot, raw.mediaSha256) : Promise.resolve(null),
      labeled ? window.canvasApi.getStudioMedia(projectRoot, labeled.mediaSha256) : Promise.resolve(null),
    ]);
    return [panel.id, {
      generationRunId: latest.generationRunId,
      packId: latest.packId,
      ...(raw ? { raw } : {}),
      ...(labeled ? { labeled } : {}),
      ...(rawMedia?.thumbnail?.url ? { rawThumbnailUrl: rawMedia.thumbnail.url } : {}),
      ...(labeledMedia?.thumbnail?.url ? { labeledThumbnailUrl: labeledMedia.thumbnail.url } : {}),
      reviewStatus: review.status,
    }];
  }));
  if (!isCurrent()) return false;
  selectedUnitRevision.value = snapshot?.unit.revision ?? 1;
  panelPipeline.value = new Map(rows);
  return true;
}

/**
 * 冻结参考缩略图解析结果：ready=缩略图可用；deriving=媒体可读但缩略图派生中
 * （节点以既有占位显示）；missing=媒体不可读（引用闭包不闭合，调用方失败关闭）。
 */
type FrozenReferenceThumbnailResult =
  | { status: "ready"; url: string }
  | { status: "deriving" }
  | { status: "missing" };

/** 正在后台派生缩略图的媒体（root + sha 去重），避免每次刷新重复触发同一派生。 */
const studioThumbnailDerivationInFlight = new Set<string>();
const studioThumbnailDerivationFailed = new Set<string>();
const studioThumbnailDerivationQueue = new LatestBoundedTaskQueue(2);

/**
 * 后台触发缩略图派生（prepare-studio-media-derivatives，preload 已暴露）。派生完成后
 * 走既有账本投影失效机制刷新受影响节点；全程不把全尺寸原图喂给缩略图 <img>。
 */
function scheduleStudioThumbnailDerivation(
  projectRoot: string,
  mediaSha256: string,
  mediaKind: "image" | "video" | "audio",
): void {
  const key = `${projectRoot}|${mediaSha256}`;
  if (studioThumbnailDerivationInFlight.has(key) || studioThumbnailDerivationFailed.has(key)) return;
  studioThumbnailDerivationInFlight.add(key);
  void studioThumbnailDerivationQueue.schedule<unknown>(async () => {
    if (mediaKind === "image") return window.canvasApi.ensureStudioImageThumbnail(projectRoot, mediaSha256);
    return window.canvasApi.prepareStudioMediaDerivatives(projectRoot, mediaSha256);
  }).then((result) => {
      studioThumbnailDerivationFailed.delete(key);
      studioThumbnailDerivationInFlight.delete(key);
      if (result.status === "rejected") {
        studioThumbnailDerivationFailed.add(key);
        return;
      }
      if (result.status !== "fulfilled" || projectRoot !== props.projectRoot || canvasDisposed) return;
      scheduleGenerationProjectionRefresh();
    }).catch(() => {
      // scheduler 本身不应 reject；保守清理 key，允许后续显式刷新再试。
      studioThumbnailDerivationInFlight.delete(key);
      studioThumbnailDerivationFailed.add(key);
    });
}

/**
 * 只读汇总当前可见单元的正式整板结果。结果必须 raw/labeled 成对且 review=pass；
 * reject/rework/stale/unreviewed/unknown 绝不投影为主时间线上的可用 raw。
 */
function exactFrozenReferenceThumbnail(
  projectRoot: string,
  mediaSha256: string,
): Promise<FrozenReferenceThumbnailResult> {
  const cacheKey = `${projectRoot}\u0000${mediaSha256}`;
  const existing = frozenReferenceThumbnailCache.get(cacheKey);
  if (existing) return existing;
  const pending = window.canvasApi.getStudioMedia(projectRoot, mediaSha256)
    .then((media): FrozenReferenceThumbnailResult => {
      // 缩略图缺失时绝不回退 mediaUrl（aicanvas-studio://media/<sha> 全尺寸原图）；
      // 媒体可读但缩略图未派生 → 先占位，后台派生完成后按既有失效机制刷新。
      const url = media?.thumbnail?.url;
      if (url) return { status: "ready", url };
      // 只缓存成功解析；瞬时 IPC/派生读取失败后，下一次刷新必须能重新尝试。
      frozenReferenceThumbnailCache.delete(cacheKey);
      if (media) {
        scheduleStudioThumbnailDerivation(projectRoot, mediaSha256, media.kind);
        return { status: "deriving" };
      }
      return { status: "missing" };
    }, (error: unknown) => {
      frozenReferenceThumbnailCache.delete(cacheKey);
      throw error;
    });
  frozenReferenceThumbnailCache.set(cacheKey, pending);
  return pending;
}

async function loadFrozenReferencesForApprovedRaw(
  projectRoot: string,
  unitId: string,
  packId: string,
  expectedPackFingerprint?: string,
): Promise<{ references: UnitGridReferenceProjection[]; continuity: UnitGridContinuityProjection }> {
  const pack = await window.canvasApi.getStudioFrozenPack(projectRoot, packId);
  if (!pack || pack.id !== packId || pack.target.unitId !== unitId
    || (expectedPackFingerprint && pack.fingerprint !== expectedPackFingerprint)) {
    throw new Error(`正式整板 ${unitId} 缺少同单元冻结参考闭包。`);
  }
  const references = projectStudioCanvasFrozenReferences(pack);
  if (references.length > STUDIO_CANVAS_TIMELINE_MAX_REFERENCES_PER_UNIT) {
    throw new Error(`正式整板 ${unitId} 冻结参考超过画布有界上限。`);
  }
  if (Number(pack.schemaVersion) !== 5 || !("panels" in pack)) {
    throw new Error(`正式整板 ${unitId} 的冻结包不是可追溯 unit-grid v5。`);
  }
  const lastPanel = pack.panels.at(-1);
  const continuity = lastPanel?.panelPack?.continuity;
  if (!lastPanel || !continuity || continuity.scope.unitId !== unitId) {
    throw new Error(`正式整板 ${unitId} 缺少末格连续性闭包。`);
  }
  const projectedReferences = await Promise.all(references.map(async (reference) => {
    const thumbnail = await exactFrozenReferenceThumbnail(projectRoot, reference.mediaSha256);
    // 媒体不可读仍失败关闭；缩略图派生中则以节点既有占位显示，绝不回退全尺寸原图。
    if (thumbnail.status === "missing") throw new Error(`正式整板 ${unitId} 的冻结参考 ${reference.referenceId} 缺少可读媒体。`);
    return { ...reference, ...(thumbnail.status === "ready" ? { thumbnailUrl: thumbnail.url } : {}) };
  }));
  const fieldLabels: Record<string, string> = {
    costume: "服装",
    injury: "伤势",
    heldObject: "持物",
    position: "站位",
    facing: "朝向",
    emotion: "情绪",
    layout: "空间布局",
    lighting: "光线",
    referenceSha256: "参考 SHA",
  };
  // 旧 Dudu 导入中一部分连续性 value 是 `s1e2:S1E2-U01:...` 形式的
  // 内部定位标识。它证明字段有冻结 head，却不是可以指导下一镜的语义状态；
  // 画布必须显式区分，不能把它伪装成“站位已可读”。
  const isOpaqueContinuityLocator = (value: string | undefined): boolean =>
    Boolean(value && /^[a-z0-9._-]+:S\d+E\d+-U\d+:/iu.test(value));
  const continuityAssets: UnitGridContinuityAssetProjection[] = continuity.assets.map((asset) => {
    const lockedFields = asset.heads.map((head) => fieldLabels[head.field] ?? head.field);
    const readableFields = asset.heads.flatMap((head) => {
      if (head.state.status !== "resolved" || !head.state.value || isOpaqueContinuityLocator(head.state.value)) return [];
      return [{ label: fieldLabels[head.field] ?? head.field, value: head.state.value }];
    });
    return { assetId: asset.assetId, lockedFields, readableFields };
  });
  const readableFieldCount = continuityAssets.reduce((total, asset) => total + asset.readableFields.length, 0);
  const fieldCount = continuityAssets.reduce((total, asset) => total + asset.lockedFields.length, 0);
  // 只有字段值本身是人可读语义时，才准许进入下一镜交接摘要；reference SHA
  // 已由正式参考边展示，不能冒充角色的站位/朝向/持物状态。
  const handoffFields = new Set(["position", "facing", "heldObject", "layout", "lighting"]);
  const handoffSummary = continuity.assets.flatMap((asset) => asset.heads.flatMap((head) => {
    if (!handoffFields.has(head.field) || head.state.status !== "resolved" || !head.state.value
      || isOpaqueContinuityLocator(head.state.value)) return [];
    return [`${asset.assetId} ${fieldLabels[head.field] ?? head.field}=${head.state.value}`];
  })).slice(0, 8).join(" · ");
  const assetSummary = continuityAssets
    .map((asset) => `${asset.assetId}〔${asset.lockedFields.join("、")}〕`)
    .join(" · ");
  return {
    references: projectedReferences,
    continuity: {
      fingerprint: continuity.fingerprint,
      lastPanelId: lastPanel.panelId,
      lastPanelTitle: lastPanel.instruction.title,
      visualAction: lastPanel.instruction.visualAction,
      shotComposition: lastPanel.instruction.shotComposition,
      filmingMethod: lastPanel.instruction.filmingMethod,
      sceneLighting: lastPanel.instruction.sceneLighting,
      assetCount: continuity.assets.length,
      fieldCount,
      readableFieldCount,
      opaqueFieldCount: fieldCount - readableFieldCount,
      handoffSummary,
      assetSummary,
      assets: continuityAssets,
    },
  };
}

async function loadVideoPackageProjection(
  projectRoot: string,
  reviewId: string,
): Promise<UnitGridVideoPackageProjection> {
  const lookup = await window.canvasApi.getStudioVideoPackageControl(projectRoot, {
    by: "authority-latest",
    authority: { kind: "studio-review", reviewId },
  });
  if (lookup.status === "not-prepared") {
    return { status: "not-prepared", subtitle: "未建立图生视频提交包" };
  }
  if (lookup.status === "conflict") {
    return { status: "conflict", subtitle: "视频包账本冲突，禁止继续使用" };
  }
  const control = lookup.control;
  return {
    status: "resolved",
    subtitle: control?.mechanicalStatus === "verified"
      ? `机械验收通过 · ${control.i2vStaticStatus}`
      : `已准备 · ${control?.mechanicalStatus ?? "待验收"}`,
  };
}

/** 核心选中正式结果的执行层身份：只描述“去哪读媒体与冻结闭包”，不含任何 PASS/候选裁决。 */
interface UnitGridSelectedResultIdentity {
  provenance: "generated" | "historical-import" | "checkpoint-attested";
  generationRunId: string | null;
  provider?: "codex" | "grok";
  packId: string;
  packFingerprint?: string;
  reviewId?: string;
  continuityFingerprint?: string;
  postResultObservationHeadPresent?: boolean;
  labeledMediaSha256: string;
  /** 停检账本存证路径沿用旧语义：raw/labeled 媒体本体都必须可读。 */
  requireLabeledReadable: boolean;
}

/**
 * 为核心选中的正式 raw 解析执行层身份（pack/媒体对/Review head）。
 * PASS 裁决与 SHA 选择已在核心投影完成；这里仅按 SHA 确定性定位生成包。
 * 停检账本只可作为首屏 placeholder，不能作为 execution identity；正式身份必须
 * 从核心选中的 run/历史来源重新闭合，避免同 SHA 被新 run/pack 复用时串包。
 */
async function resolveUnitGridSelectedResultIdentity(
  projectRoot: string,
  unitId: string,
  core: TimelineUnitDisplay,
): Promise<UnitGridSelectedResultIdentity | null> {
  const selectedRawSha256 = core.selectedRawSha256;
  if (!selectedRawSha256) return null;
  const tryRun = async (): Promise<UnitGridSelectedResultIdentity | null> => {
    // 优先用核心选中 runId（与 selectedRawSha256 同源）；latestRunId 仅回退。
    const runId = core.selectedGenerationRunId ?? core.latestRunId;
    if (!runId) return null;
    const attested = core.selectedRunExecutionIdentity;
    if (
      attested
      && attested.generationRunId === runId
      && attested.rawMediaSha256 === selectedRawSha256
      && attested.labeledMediaSha256 === core.selectedLabeledSha256
      && attested.packFingerprint === core.selectedPackFingerprint
    ) {
      return {
        provenance: "generated",
        generationRunId: attested.generationRunId,
        provider: attested.provider,
        packId: attested.packId,
        packFingerprint: attested.packFingerprint,
        reviewId: attested.reviewId,
        continuityFingerprint: attested.continuityFingerprint,
        postResultObservationHeadPresent: attested.postResultObservationHeadPresent,
        labeledMediaSha256: attested.labeledMediaSha256,
        requireLabeledReadable: false,
      };
    }
    const history = await readUnitGridProjectionWithin(
      "正式整板结果历史",
      unitId,
      (signal) => ipcUnderSignal(signal, () => window.canvasApi.listStudioGenerationUnitGridHistory(projectRoot, {
        unitId,
        limit: 12,
        order: "newest-first",
      })),
    );
    const runItems = history.items.filter((item) => item.generationRunId === runId);
    // 只接受与核心选中 run 且 SHA 一致的 raw 项；找不到即交给下一来源，绝不另选候选。
    const raw = [...runItems].reverse().find((item) => item.variant === "raw" && item.mediaSha256 === selectedRawSha256);
    if (!raw) return null;
    const expectedLabeledSha256 = core.selectedLabeledSha256;
    const labeled = [...runItems].reverse().find((item) => (
      item.variant === "labeled"
      && (!expectedLabeledSha256 || item.mediaSha256 === expectedLabeledSha256)
    ));
    const labeledMediaSha256 = expectedLabeledSha256 ?? labeled?.mediaSha256;
    if (!labeled || !labeledMediaSha256
      || !raw.pairComplete || !labeled.pairComplete
      || !raw.inputCurrent || !labeled.inputCurrent
      || !raw.promotionEligible || !labeled.promotionEligible) return null;
    // 核心 PASS 快照之后 Review 仍可能被撤销；执行层必须重新读取 current head，
    // 并把 run/result/SHA/pack 全部交叉验证后才允许旧 worker提交 raw。
    try {
      const review = await readUnitGridProjectionWithin(
        "正式验收记录",
        unitId,
        (signal) => ipcUnderSignal(signal, () => window.canvasApi.getStudioGenerationReviewControl(projectRoot, runId)),
      );
      if (!isCurrentApprovedUnitGridResultIdentity({
        review,
        generationRunId: runId,
        raw,
        labeled,
        selectedRawSha256,
        selectedLabeledSha256: labeledMediaSha256,
        selectedPackFingerprint: core.selectedPackFingerprint,
      })) {
        return null;
      }
      const head = review.head!;
      return {
        provenance: "generated",
        generationRunId: runId,
        provider: raw.provider,
        packId: head.packId,
        packFingerprint: head.packFingerprint,
        reviewId: head.reviewId,
        continuityFingerprint: head.continuityFingerprint,
        labeledMediaSha256,
        requireLabeledReadable: false,
      };
    } catch (error) {
      if (!(error instanceof UnitGridRawProjectionReadTimeout)) throw error;
      return null;
    }
  };
  const tryHistorical = async (): Promise<UnitGridSelectedResultIdentity | null> => {
    const historical = await readUnitGridProjectionWithin(
      "历史导入验收记录",
      unitId,
      (signal) => ipcUnderSignal(signal, () => window.canvasApi.getStudioHistoricalGenerationEvidenceByUnit(projectRoot, unitId)),
    );
    if (!historical || historical.raw.mediaSha256 !== selectedRawSha256) return null;
    // 历史 raw 保留 packFingerprint：冻结参考闭包按原指纹核验，身份检查不放宽。
    return {
      provenance: "historical-import",
      generationRunId: null,
      packId: historical.packId,
      packFingerprint: historical.packFingerprint,
      labeledMediaSha256: historical.labeled.mediaSha256,
      requireLabeledReadable: false,
    };
  };
  // 核心增强字段 selectedResultSource 存在时按其提示排序；单路读取超时不拖垮
  // 整单元，继续另一来源（核心 PASS 的历史链仍可能闭合）。
  const attempts = core.selectedResultSource === "historical-import"
    ? [tryHistorical]
    : core.selectedResultSource === "generation-run"
      ? [tryRun]
      : [tryRun, tryHistorical];
  for (const attempt of attempts) {
    try {
      const identity = await attempt();
      if (identity) return identity;
    } catch (error) {
      if (!(error instanceof UnitGridRawProjectionReadTimeout)) throw error;
    }
  }
  return null;
}

/** 非 PASS 单元状态只翻译核心投影（验收裁决在核心，前端不读取 Review 自行判定）。 */
function projectCoreNonPassProjection(core: TimelineUnitDisplay | undefined): UnitGridNonPassProjection | undefined {
  if (!core) return undefined;
  const status = core.productionStatus === "result_pending_review"
    ? "unreviewed"
    : core.productionStatus === "rework" || core.reviewStatus === "rework"
      ? "rework"
      : core.reviewStatus === "reject"
        ? "reject"
        : core.reviewStatus === "stale"
          ? "stale"
          : core.reviewStatus === "unreviewed"
            ? "unreviewed"
            : null;
  if (!status) return undefined;
  const label = status === "unreviewed"
    ? "正式整板待人工验收"
    : status === "rework"
      ? "正式整板要求返工"
      : status === "reject"
        ? "正式整板已拒绝"
        : "正式整板验收已过期";
  return { status, subtitle: `${label}；核心投影未选中正式 raw，该候选不进入画布。` };
}

function clearUnitGridFormalProjectionState(): void {
  unitGridRawPipeline.value = new Map();
  unitGridReferencePipeline.value = new Map();
  unitGridContinuityPipeline.value = new Map();
  unitGridPostResultObservationPipeline.value = new Map();
  unitGridVideoPackagePipeline.value = new Map();
  unitGridNonPassPipeline.value = new Map();
  unitGridCorePassUnits.value = new Set();
}

let unitGridGraphRebuildRafId = 0;
function scheduleUnitGridGraphRebuild(): void {
  if (unitGridGraphRebuildRafId || canvasDisposed) return;
  unitGridGraphRebuildRafId = window.requestAnimationFrame(() => {
    unitGridGraphRebuildRafId = 0;
    if (!canvasDisposed) rebuildGraph();
  });
}

function flushUnitGridGraphRebuild(): void {
  if (unitGridGraphRebuildRafId) {
    window.cancelAnimationFrame(unitGridGraphRebuildRafId);
    unitGridGraphRebuildRafId = 0;
  }
  if (!canvasDisposed) rebuildGraph();
}

async function loadApprovedUnitGridRawProjection(
  projectRoot: string,
  units: readonly StudioDashboardUnitSummary[],
  requestSequence: number,
  preloadedCoreByUnit?: ReadonlyMap<string, TimelineUnitDisplay> | null,
): Promise<void> {
  // 正式 raw 的唯一裁决来源是核心投影（getApprovedTimelineProjection）：PASS 与否、
  // 选哪张 raw 都由核心决定，前端不再自行判定。本函数只是投影的执行层：按核心选中
  // 的 SHA 读取媒体、核验冻结参考闭包并逐单元增量提交。工程切换/卸载/更新的请求
  // （seq 失效）后旧读取一律不写回，禁止旧/新请求并发写同一投影状态。
  const isCurrent = () => projectRoot === props.projectRoot && !canvasDisposed
    && unitGridRawProjectionFlight.isCurrent(requestSequence);
  const t23RawReferenceSpan = t23RawReferenceSpanTracker.begin({
    projectRoot,
    flightSequence: requestSequence,
    isCurrent,
  });
  if (isCurrent()) {
    rawReferenceProjectionLoading.value = true;
    rawReferenceProjectionIssue.value = undefined;
    // 实际末态的 currentness 必须每轮重新由 Core 证明；核验期间先撤掉旧承接边，
    // 绝不让上轮 current control 在 Review/结果刚变化时短暂冒充仍可承接。
    unitGridPostResultObservationPipeline.value = new Map();
  }
  const rows: Array<readonly [string, UnitGridRawProjection | undefined]> = [];
  const referenceRows: Array<readonly [string, UnitGridReferenceProjection[]]> = [];
  const continuityRows: Array<readonly [string, UnitGridContinuityProjection]> = [];
  const nonPassRows: Array<readonly [string, UnitGridNonPassProjection]> = [];
  const enrichmentTasks: Array<() => Promise<UnitGridEnrichmentResult | undefined>> = [];
  const ledgerAttested = new Map<string, UnitGridRawProjection>();
  // 核心判 PASS 的可见单元集合：rebuildGraph 据此把“核心已通过但投影未落”与
  // “等待检查”严格分开，UI 不出现核心 PASS 却显示等待验收的分裂状态。
  const corePassUnitIds = new Set<string>();
  try {
    // 核心裁决：可见单元按（季, 集）分组逐组读取正式时间线投影（fastMode <1s）。
    // 读取失败绝不回退前端自行裁决，只挂诊断横幅等待下一次账本刷新。
    const coreByUnitId = new Map<string, TimelineUnitDisplay>(preloadedCoreByUnit ?? []);
    const episodeGroups = new Map<string, { season: string; episode: string }>();
    for (const unit of units.slice(0, 36)) {
      if (coreByUnitId.has(unit.id)) continue;
      episodeGroups.set(`${unit.seasonId} ${unit.episodeId}`, { season: unit.seasonId, episode: unit.episodeId });
    }
    try {
      for (const group of episodeGroups.values()) {
        const adjudication = await readUnitGridProjectionWithin(
          "核心正式时间线投影",
          "时间线",
          (signal) => ipcUnderSignal(signal, () => {
            const unitIds = units.slice(0, 36)
              .filter((unit) => unit.seasonId === group.season && unit.episodeId === group.episode)
              .map((unit) => unit.id)
              .filter(Boolean);
            if (unitIds.length === 0) {
              throw new Error("可见页没有可投影的 unitIds，禁止回退整集。");
            }
            return window.canvasApi.getApprovedTimelineProjection(projectRoot, {
              season: group.season,
              episode: group.episode,
              fastMode: true,
              unitIds,
            });
          }),
        );
        for (const coreUnit of adjudication.units) {
          coreByUnitId.set(coreUnit.unitId, coreUnit);
        }
      }
    } catch (error) {
      if (isCurrent()) {
        rawReferenceProjectionIssue.value = `核心正式时间线投影读取失败：${message(error)}；已暂停 raw 投影，等待下次账本刷新。`;
        // 核心裁决不可读时旧 PASS raw/参考/连续性不能继续冒充 current。
        clearUnitGridFormalProjectionState();
        rebuildGraph();
      }
      return;
    }
    if (!isCurrent()) return;
    for (const unit of units.slice(0, 36)) {
      if (coreByUnitId.get(unit.id)?.productionStatus === "pass") corePassUnitIds.add(unit.id);
    }
    t23RawReferenceSpan.setExpectedPassUnitIds([...corePassUnitIds]);
    unitGridCorePassUnits.value = corePassUnitIds;
    // 核心快照一到即先裁掉已消失、已非 PASS 或 selected SHA 已变化的旧正式链，
    // 深核验随后增量补回；不能让旧 raw 在 36 单元核验完成前继续可引用。
    const retainedRaw = new Map(
      [...unitGridRawPipeline.value.entries()].filter(([unitId, projection]) => {
        const core = coreByUnitId.get(unitId);
        return core?.productionStatus === "pass"
          && Boolean(core.selectedRawSha256)
          && core.selectedRawSha256 === projection.rawMediaSha256;
      }),
    );
    const retainedUnitIds = new Set(retainedRaw.keys());
    const retainForCurrentRaw = <T>(source: Map<string, T>): Map<string, T> => new Map(
      [...source.entries()].filter(([unitId]) => retainedUnitIds.has(unitId)),
    );
    unitGridRawPipeline.value = retainedRaw;
    unitGridReferencePipeline.value = retainForCurrentRaw(unitGridReferencePipeline.value);
    unitGridContinuityPipeline.value = retainForCurrentRaw(unitGridContinuityPipeline.value);
    unitGridPostResultObservationPipeline.value = retainForCurrentRaw(
      unitGridPostResultObservationPipeline.value,
    );
    unitGridVideoPackagePipeline.value = retainForCurrentRaw(unitGridVideoPackagePipeline.value);
    unitGridNonPassPipeline.value = new Map(
      units.slice(0, 36)
        .map((unit) => [unit.id, projectCoreNonPassProjection(coreByUnitId.get(unit.id))] as const)
        .filter((entry): entry is readonly [string, UnitGridNonPassProjection] => Boolean(entry[1])),
    );
    rebuildGraph();
    // 停检账本存证只作执行层身份来源与“深核验中”占位：仅核心判 PASS 且选中 SHA
    // 与存证一致的单元落占位；核心未判 PASS 的单元绝不因存证单独出现 raw 节点。
    const checkpointNeeded = units.slice(0, 36).some((unit) => {
      const core = coreByUnitId.get(unit.id);
      return core?.productionStatus === "pass"
        && core.selectedResultSource === "generation-run"
        && !core.selectedRunExecutionIdentity;
    });
    if (checkpointNeeded) {
      try {
        const checkpoint = await readUnitGridProjectionWithin(
          "停检账本存证",
          "时间线",
          (signal) => ipcUnderSignal(signal, () => window.canvasApi.getStudioGenerationCheckpointCanvasProjection(projectRoot)),
        );
        if (!checkpoint.ledgerCurrent) {
          if (isCurrent()) rawReferenceProjectionIssue.value = "停检账本存证未闭合；未显示任何未核验 formal raw。";
        } else {
          const visibleUnitIds = new Set(units.map((unit) => unit.id));
          for (const item of checkpoint.attestedUnitGrid) {
            if (!visibleUnitIds.has(item.unitId)) continue;
            const core = coreByUnitId.get(item.unitId);
            if (core?.productionStatus !== "pass" || core.selectedRawSha256 !== item.rawMediaSha256) continue;
            ledgerAttested.set(item.unitId, {
              provenance: "checkpoint-attested",
              verification: "ledger-attested",
              generationRunId: item.generationRunId,
              provider: item.provider,
              packId: item.packId,
              packFingerprint: item.packFingerprint,
              rawMediaSha256: item.rawMediaSha256,
              labeledMediaSha256: item.labeledMediaSha256,
              reviewId: item.reviewId,
              continuityFingerprint: item.continuityFingerprint,
            });
          }
          if (isCurrent() && ledgerAttested.size > 0) {
            unitGridRawPipeline.value = new Map(ledgerAttested);
            scheduleUnitGridGraphRebuild();
          }
        }
      } catch (error) {
        if (isCurrent()) rawReferenceProjectionIssue.value = error instanceof Error
          ? `停检账本存证读取失败：${error.message}`
          : "停检账本存证读取失败。";
      }
    }
    // ledger 的只读快照带漂移检测；单元之间 4 路有界并发（曾逐单元串行，36 单元首屏
    // 过慢），既不制造 36 路全并发快照竞争，也不再让单个慢单元堵住后续已验收单元。
    // 单元内部按“核心裁决 → 身份解析 → 媒体/闭包读取”顺序执行；单飞、逐单元失败
    // 隔离与 seq/root 失效语义不变。共享计数器在 JS 单线程下同步递增，无竞争。
    const projectionUnits = units.slice(0, 36);
    let nextProjectionUnitIndex = 0;
    const rawProjectionWorker = async (): Promise<void> => {
      while (nextProjectionUnitIndex < projectionUnits.length) {
        // 工程切换/卸载/更新请求后所有 worker 在下一单元领取边界一并退出。
        if (!isCurrent()) return;
        const unit = projectionUnits[nextProjectionUnitIndex]!;
        nextProjectionUnitIndex += 1;
        try {
          const core = coreByUnitId.get(unit.id);
          if (core?.productionStatus === "pass" && !core.selectedRawSha256) {
            // 核心判 PASS 但未返回正式 SHA（fastMode 缺口）：不伪造节点，等核心补齐。
            if (isCurrent()) {
              rawReferenceProjectionIssue.value = `${unit.id} 核心已判 PASS 但未返回正式 raw SHA；等待核心投影补齐。`;
            }
            rows.push([unit.id, undefined]);
            referenceRows.push([unit.id, []]);
            continue;
          }
          if (core?.productionStatus === "pass" && core.selectedRawSha256) {
            // 执行层：核心已完成 PASS 裁决与 raw 选择（节点 SHA 恒等于核心
            // selectedRawSha256）；这里只解析该结果的生成包身份并读取媒体/冻结
            // 参考闭包，不作任何 PASS/候选裁决。
            const selectedRawSha256 = core.selectedRawSha256;
            let identity: UnitGridSelectedResultIdentity | null = null;
            try {
              identity = await resolveUnitGridSelectedResultIdentity(
                projectRoot,
                unit.id,
                core,
              );
            } catch (identityError) {
              if (!(identityError instanceof UnitGridRawProjectionReadTimeout)) throw identityError;
            }
            if (!identity) {
              throw new Error(`正式整板 ${unit.id} 的 current Review/结果/冻结包身份未闭合。`);
            }
            // 安全优先：核心 selected SHA 还必须与 current Review、结果对和冻结包闭合；
            // 任一身份失配都撤下旧 PASS，等待 dataEpoch 触发的最新投影重读。
            const labeledSha = identity.labeledMediaSha256;
            const rawMedia = await readUnitGridProjectionWithin(
              "raw 媒体对象",
              unit.id,
              (signal) => ipcUnderSignal(signal, () => window.canvasApi.getStudioMedia(projectRoot, selectedRawSha256)),
            );
            if (!rawMedia) {
              throw new Error(`正式整板 ${unit.id} 的 raw 媒体不可读。`);
            }
            if (!rawMedia.thumbnail?.url) {
              scheduleStudioThumbnailDerivation(projectRoot, selectedRawSha256, rawMedia.kind);
            }
            const packId = identity.packId;
            const packFingerprint = identity.packFingerprint ?? core.selectedPackFingerprint ?? undefined;
            let closureReferences: UnitGridReferenceProjection[] = [];
            let continuity: UnitGridContinuityProjection | undefined;
            let closureVerified = false;
            if (identity.packId) {
              try {
                const closure = await readUnitGridProjectionWithin(
                  "冻结参考闭包",
                  unit.id,
                  (signal) => ipcUnderSignal(
                    signal,
                    () => loadFrozenReferencesForApprovedRaw(projectRoot, unit.id, identity.packId, packFingerprint),
                  ),
                );
                closureReferences = closure.references;
                continuity = closure.continuity;
                closureVerified = true;
              } catch (closureError) {
                if (isCurrent()) {
                  rawReferenceProjectionIssue.value = `${unit.id} 冻结参考闭包未完全还原：${message(closureError)}；正式 raw 仍显示。`;
                }
              }
            } else if (isCurrent()) {
              rawReferenceProjectionIssue.value = `${unit.id} 生成包身份未定位；已按核心 selectedRawSha256 显示正式 raw。`;
            }
            const approvedRaw: UnitGridRawProjection = {
              provenance: identity.provenance,
              verification: closureVerified ? "deep-verified" : "ledger-attested",
              generationRunId: identity.generationRunId,
              ...(identity.provider ? { provider: identity.provider } : {}),
              packId,
              ...(packFingerprint ? { packFingerprint } : {}),
              ...(identity.reviewId ? { reviewId: identity.reviewId } : {}),
              ...(identity.continuityFingerprint ? { continuityFingerprint: identity.continuityFingerprint } : {}),
              ...(identity.postResultObservationHeadPresent !== undefined
                ? { postResultObservationHeadPresent: identity.postResultObservationHeadPresent }
                : {}),
              rawMediaSha256: selectedRawSha256,
              labeledMediaSha256: labeledSha,
              ...(rawMedia.thumbnail?.url ? { rawThumbnailUrl: rawMedia.thumbnail.url } : {}),
            };
            rows.push([unit.id, approvedRaw]);
            referenceRows.push([unit.id, closureReferences]);
            if (continuity) continuityRows.push([unit.id, continuity]);
            if (isCurrent()) {
              unitGridRawPipeline.value = new Map(unitGridRawPipeline.value).set(unit.id, approvedRaw);
              if (closureReferences.length > 0) {
                unitGridReferencePipeline.value = new Map(unitGridReferencePipeline.value).set(unit.id, closureReferences);
              }
              if (continuity) {
                unitGridContinuityPipeline.value = new Map(unitGridContinuityPipeline.value).set(unit.id, continuity);
              }
              scheduleUnitGridGraphRebuild();
              // T23 首 raw 只记录已提交进响应式 Map、已安排图重建的 deep-verified
              // 缩略图；不能用 worker 返回、IPC 完成或轮询观察替代。
              if (approvedRaw.verification === "deep-verified" && approvedRaw.rawThumbnailUrl) {
                t23RawReferenceSpan.markFirstRaw(unit.id);
              }
            }
            // 已验真的 raw/冻结参考先增量显示；实际末态是其后的有界只读后台核对，
            // 不得延迟正式 raw 上画布。观察只跟随核心选中的 run，不用 latestRunId 猜归属。
            const observationRunId = identity.generationRunId;
            const reviewIdForVideo = identity.reviewId;
            enrichmentTasks.push(async () => {
              // 有界 worker 领取任务时再次核对 generation/root；旧批次不再启动新 IPC。
              if (!isCurrent()) return undefined;
              const [videoPackage, postResultObservation] = await Promise.all([
                reviewIdForVideo
                  ? readUnitGridProjectionWithin(
                    "图生视频包状态",
                    unit.id,
                    (signal) => ipcUnderSignal(signal, () => loadVideoPackageProjection(projectRoot, reviewIdForVideo)),
                  ).catch(() => ({
                    status: "not-prepared" as const,
                    subtitle: "图生视频提交包状态读取失败",
                  }))
                  : Promise.resolve({
                    status: "not-prepared" as const,
                    subtitle: core.selectedResultSource === "historical-import"
                      ? "历史导入正式 raw 未建立图生视频提交包"
                      : "正式 raw 未建立图生视频提交包",
                  }),
                observationRunId && identity.postResultObservationHeadPresent !== false
                  ? readUnitGridProjectionWithin(
                    "实际末态观察控制",
                    unit.id,
                    (signal) => ipcUnderSignal(
                      signal,
                      () => window.canvasApi.getStudioPostResultObservationControl(projectRoot, observationRunId),
                    ),
                  ).catch((observationError) => {
                    if (isCurrent()) {
                      rawReferenceProjectionIssue.value = `${unit.id} 实际末态观察控制不可读：${message(observationError)}；计划终态仍禁止作为下一镜实际起态。`;
                    }
                    return undefined;
                  })
                  : Promise.resolve(undefined),
              ]);
              if (!isCurrent()) return undefined;
              return {
                unitId: unit.id,
                videoPackage,
                ...(postResultObservation ? { postResultObservation } : {}),
              };
            });
            continue;
          }
          // 核心未判 PASS：不展示任何 raw；非 PASS 状态只翻译核心投影结果，
          // 不再读取 Review/历史记录自行裁决。
          const nonPass = projectCoreNonPassProjection(core);
          if (nonPass) nonPassRows.push([unit.id, nonPass]);
          rows.push([unit.id, undefined]);
          referenceRows.push([unit.id, []]);
        } catch (error) {
          if (error instanceof UnitGridRawProjectionReadTimeout) {
            // 单元之间虽有 4 路有界并发，失败仍按单元隔离；一个候选/闭包慢读取只关闭
            // 本单元，不能让 U28/U29 等已验收历史 raw 永远排在它后面不可见。
            if (isCurrent()) rawReferenceProjectionIssue.value = `${error.message}；仅跳过该单元，继续核验后续正式链。`;
            rows.push([unit.id, undefined]);
            referenceRows.push([unit.id, []]);
            continue;
          }
          // 引用闭包也属于正式图的可读证据；无法完整还原时该单元失败关闭，不展示无来源 raw。
          if (isCurrent()) {
            rawReferenceProjectionIssue.value = `${unit.id} 的正式 raw 投影未闭合：${message(error)}；已安全隐藏该单元 raw。`;
          }
          rows.push([unit.id, undefined]);
          referenceRows.push([unit.id, []]);
        }
      }
    };
    // 有界并发：worker 数不超过单元数；给当前单元详情的聚合投影保留一个 IPC 槽。
    await Promise.all(Array.from({
      length: Math.min(TIMELINE_PROJECTION_WORKER_CONCURRENCY, projectionUnits.length),
    }, () => rawProjectionWorker()));
    if (!isCurrent()) return;
    const resolved = new Map(ledgerAttested);
    for (const [unitId, projection] of rows) {
      if (projection) resolved.set(unitId, projection);
      // 无法完成深核验时保留已经闭合的停检账本节点，但不会补任何冻结参考边。
      else if (!ledgerAttested.has(unitId)) resolved.delete(unitId);
    }
    unitGridRawPipeline.value = resolved;
    unitGridReferencePipeline.value = new Map(referenceRows.filter(([, references]) => references.length > 0));
    unitGridContinuityPipeline.value = new Map(continuityRows);
    unitGridNonPassPipeline.value = new Map(nonPassRows);
    // raw/冻结参考热路径至此已经闭合；图生视频状态与实际末态是后置增强，
    // 继续核对但不再让它们把“参考仍在加载”虚报数秒。
    rawReferenceProjectionLoading.value = false;
    flushUnitGridGraphRebuild();
    // 三个有界 worker 已全部结束，最终 Map 已一次性提交、loading 已关闭且图已 flush。
    // 只有每个核心 PASS 都同时具备 deep raw 缩略图与至少一张冻结参考缩略图，才可
    // 形成完整 span；否则不写 ready/complete，性能验收失败关闭。
    for (const unitId of corePassUnitIds) {
      const raw = resolved.get(unitId);
      const references = unitGridReferencePipeline.value.get(unitId) ?? [];
      if (raw?.verification === "deep-verified"
        && Boolean(raw.rawThumbnailUrl)
        && references.some((reference) => Boolean(reference.thumbnailUrl))) {
        t23RawReferenceSpan.recordPassReference(unitId);
      }
    }
    t23RawReferenceSpan.complete();
    const enrichmentResults = await runBoundedAsyncTasks(
      enrichmentTasks,
      UNIT_GRID_ENRICHMENT_CONCURRENCY,
    );
    if (!isCurrent()) return;
    // 后台增强结果整批提交：最多替换两张 Map、安排一次整图重建，避免每个单元
    // 返回时各自触发一次 Vue 响应式更新和 rAF rebuild。
    const nextVideoPackages = new Map(unitGridVideoPackagePipeline.value);
    const nextPostResultObservations = new Map(unitGridPostResultObservationPipeline.value);
    let hasEnrichmentResult = false;
    for (const enrichment of enrichmentResults) {
      if (!enrichment) continue;
      hasEnrichmentResult = true;
      nextVideoPackages.set(enrichment.unitId, enrichment.videoPackage);
      if (enrichment.postResultObservation) {
        nextPostResultObservations.set(
          enrichment.unitId,
          enrichment.postResultObservation,
        );
      }
    }
    if (hasEnrichmentResult) {
      unitGridVideoPackagePipeline.value = nextVideoPackages;
      unitGridPostResultObservationPipeline.value = nextPostResultObservations;
      scheduleUnitGridGraphRebuild();
    }
  } finally {
    if (isCurrent()) rawReferenceProjectionLoading.value = false;
    else t23RawReferenceSpan.invalidate();
  }
}

/**
 * 宫格 raw 的验真可能读取历史 review/pack，绝不能堵住首屏时间线。
 * 单元和锁图先落画布；后台单飞、严格验真通过后才补入 raw→冻结参考边。
 * 单飞/序号/abort 状态机见 createUnitGridProjectionFlightGate。
 */
let unitGridRawProjectionInFlight: Promise<void> | undefined;
function scheduleApprovedUnitGridRawProjection(
  projectRoot: string,
  units: readonly StudioDashboardUnitSummary[],
  preloadedCoreByUnit?: ReadonlyMap<string, TimelineUnitDisplay> | null,
): void {
  // 账本事件和 overview 刷新会连续触发这里。相同单元集的深核验必须单飞，
  // 不能每次刷新都递增 sequence 把一条尚未跑到 U28/U29 的读取链取消。
  const begun = unitGridRawProjectionFlight.begin(projectRoot, units.map((unit) => unit.id));
  if (!begun) return;
  // 新 flight 先使旧 T23 scope 失效；迟到 IPC 即使随后 resolve 也无法写出 current
  // raw/reference 里程碑。
  t23RawReferenceSpanTracker.invalidateCurrent();
  // 一旦开始新一轮核心核对，上一轮正式链立即失效；同 SHA 也可能来自不同
  // run/pack/review，不能在新身份尚未证明时继续显示为 current。
  if (projectRoot === props.projectRoot) {
    clearUnitGridFormalProjectionState();
    rawReferenceProjectionLoading.value = true;
    rawReferenceProjectionIssue.value = undefined;
    rebuildGraph();
  }
  // 新序列：abort 上一批 in-flight IPC 采用路径（迟到结果丢弃）。
  unitGridRawProjectionAbort?.abort(new UnitGridRawProjectionAborted("新的投影读取序列已开始"));
  unitGridRawProjectionAbort = new AbortController();
  const requestSequence = begun.sequence;
  const projection = loadApprovedUnitGridRawProjection(
    projectRoot,
    units,
    requestSequence,
    preloadedCoreByUnit,
  );
  unitGridRawProjectionInFlight = projection;
  void projection.finally(() => {
    if (unitGridRawProjectionInFlight === projection) unitGridRawProjectionInFlight = undefined;
    if (projectRoot === props.projectRoot
      && unitGridRawProjectionFlight.isCurrent(requestSequence)) {
      flushUnitGridGraphRebuild();
    }
    // 读取期间若账本确有新写入，只补一次后续刷新。
    const shouldRerun = unitGridRawProjectionFlight.end(begun.requestKey, requestSequence);
    if (shouldRerun && projectRoot === props.projectRoot) {
      scheduleApprovedUnitGridRawProjection(projectRoot, units);
    }
  });
}

function rebuildGraph(): void {
  // 节点对象整体替换会丢失 selected 标记——按 id 保留当前选区（检查器出场加载/账本投影等重建路径不清用户选区）。
  const selectedNodeIds = new Set(nodes.value.filter((node) => (node as CanvasFlowNodeLike).selected).map((node) => node.id));
  const nextNodes: Node[] = [];
  const nextEdges: Edge[] = [];
  const workflowView = workspaceMode.value === "workflow";
  const pinned = new Set(pinnedNodeIds.value);
  const assets = workflowView
    ? (pinnedAssetsPage.value?.page.items ?? []).filter((asset) => pinned.has(`asset:${asset.id}`))
    : (assetsPage.value?.page.items ?? []).slice(0, 6);
  const mediaItems = workflowView
    ? pinnedNodeIds.value
      .filter((nodeId) => nodeId.startsWith("library-media:"))
      .map((nodeId) => pinnedMediaItems.value.get(nodeId.slice("library-media:".length)))
      .filter((media): media is StudioMediaIpcItem => Boolean(media))
      .slice(0, STUDIO_CANVAS_PINNED_MEDIA_LIMIT)
    : [];
  const pinnedUnitId = pinnedNodeIds.value.find((nodeId) => nodeId.startsWith("unit:"))?.slice("unit:".length);
  const pinnedUnit = pinnedUnitId
    ? (unitDetail.value?.unit.id === pinnedUnitId
      ? unitDetail.value.unit
      : unitsPage.value?.page.items.find((unit) => unit.id === pinnedUnitId))
    : undefined;
  const pagedUnits = unitsPage.value?.page.items ?? [];
  const projectedUnits = unitDetail.value && !pagedUnits.some((unit) => unit.id === unitDetail.value!.unit.id)
    ? [unitDetail.value.unit, ...pagedUnits.slice(0, 35)]
    : pagedUnits;
  const units = workflowView
    ? (pinnedUnit ? [pinnedUnit] : [])
    : projectedUnits;
  const visibleTextDocuments = textDocuments.value
    .filter((doc) => !workflowView || pinned.has(`${doc.kind}:${doc.id}`))
    .slice(0, MAX_CANVAS_TEXT_DOCUMENTS);
  const assetThumbById = new Map(
    assets
      .map((asset) => [asset.id, authorityThumbUrl(asset.authorityThumbnailRecipeKey)] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
  );
  const timeline = computeTimelineLayout();
  const timelinePos = timeline?.nodes ?? {};
  const fallbackPos = (id: string, legacy: StudioCanvasNodePosition): StudioCanvasNodePosition =>
    positionFor(id, timelinePos[id] ?? legacy);

  // 剧本/提示词：独立画布节点（有界 ≤8）
  visibleTextDocuments.forEach((doc, index) => {
    const id = `${doc.kind}:${doc.id}`;
    nextNodes.push({
      id,
      type: "managedStudio",
      position: fallbackPos(id, { x: -280, y: 80 + index * 150 }),
      class: ["managed-node", `${doc.kind}-node`],
      data: {
        kind: doc.kind,
        kindLabel: doc.kind === "script" ? "剧本" : "提示词",
        title: doc.title || "未命名文稿",
        subtitle: doc.kind === "script" ? "剧本正文" : "冻结提示词",
        excerpt: doc.bodyPreview || "（正文预览待加载）",
        connectable: true,
        onConnectPoint: () => onConnectPoint(id),
        id: doc.id,
      },
      draggable: true,
    });
  });
  assets.forEach((asset, index) => {
    const id = `asset:${asset.id}`;
    const thumb = authorityThumbUrl(asset.authorityThumbnailRecipeKey);
    nextNodes.push({
      id,
      type: "managedStudio",
      position: fallbackPos(id, { x: 40 + (index % 2) * 210, y: 80 + Math.floor(index / 2) * 150 }),
      class: [`managed-node`, `asset-node`, `asset-${asset.category}`, asset.hasPrimaryAuthority ? "locked" : "missing"],
      data: {
        kind: "asset",
        kindLabel: assetCategoryLabel(asset.category),
        title: asset.name,
        subtitle: characterLibrarySubtitle(asset),
        excerpt: (asset.description || "").slice(0, 100),
        thumbnailUrl: thumb,
        locked: asset.hasPrimaryAuthority,
        missing: !asset.hasPrimaryAuthority,
        connectable: true,
        onConnectPoint: () => onConnectPoint(id),
        id: asset.id,
        projectRoot: props.projectRoot,
        ...(asset.authorityMediaSha256
          ? {
            mediaSha256: asset.authorityMediaSha256,
            exportMediaSha256: asset.authorityMediaSha256,
            exportFileName: `${asset.name || asset.id}-authority`,
          }
          : {}),
      },
      draggable: true,
    });
  });
  const mediaBaseY = 80 + Math.ceil(assets.length / 2) * 150;
  mediaItems.forEach((media, index) => {
    const id = mediaNodeId(media.sha256);
    const mediaKind = media.kind;
    nextNodes.push({
      id,
      type: "managedStudio",
      position: fallbackPos(id, {
        x: 40 + (index % 2) * 210,
        y: mediaBaseY + Math.floor(index / 2) * 150,
      }),
      class: ["managed-node", "library-media-node", `media-${mediaKind}`],
      data: {
        kind: mediaKind,
        kindLabel: mediaKindLabel(mediaKind),
        title: media.sourceBasename,
        subtitle: `${formatCanvasMediaBytes(media.sizeBytes)} · ${media.mimeType} · 拖出为复制体`,
        thumbnailUrl: mediaKind === "image" ? media.thumbnail?.url : undefined,
        id: media.sha256,
        projectRoot: props.projectRoot,
        mediaSha256: media.sha256,
        exportMediaSha256: media.sha256,
        exportFileName: media.sourceBasename,
      },
      draggable: true,
    });
  });
  units.forEach((unit, index) => {
    const id = `unit:${unit.id}`;
    const unitX = 540 + (index % 4) * 520;
    const unitY = 80 + Math.floor(index / 4) * 780;
    const busy = nodeStatusStore.get(id);
    const rawProjection = unitGridRawPipeline.value.get(unit.id);
    // 停检账本只能证明 raw/labeled/Review/pack 当时闭合；冻结参考未恢复前，
    // 它不能作为可复用的正式 raw，更不能被下一镜当作参考源。
    const ledgerPending = rawProjection?.verification === "ledger-attested" ? rawProjection : undefined;
    const approvedRaw = rawProjection?.verification === "ledger-attested" ? undefined : rawProjection;
    const nonPass = unitGridNonPassPipeline.value.get(unit.id);
    // 单元源状态来自剧本/绑定检查，不能覆盖已经通过人工审片的正式整板事实。
    // 否则时间线会同时显示“等待检查”和可用 raw，误导下一镜生产判断。
    // 核心判 PASS 但投影未落（闭包/媒体恢复中）同样绝不回退成“等待检查”。
    const canvasStatus = approvedRaw
      ? "正式整板已通过"
      : ledgerPending
        ? "正式整板待恢复参考链"
      : unitGridCorePassUnits.value.has(unit.id)
        ? "正式整板已通过 · 投影恢复中"
      : nonPass?.status === "unreviewed"
        ? "正式整板待人工验收"
        : nonPass
          ? "正式整板不可用"
          : productionStatusLabel(unit.status);
    nextNodes.push({
      id,
      type: "managedStudio",
      position: fallbackPos(id, { x: unitX, y: unitY }),
      class: ["managed-node", "unit-node", ...(busy ? ["node-status-busy"] : [])],
      data: {
        kind: "unit",
        kindLabel: "生产单元",
        // T13/T8: 单元节点显示双编号（如 029｜S1E01-U28）
        title: getUnitDualLabel(unit.id) || unit.label,
        subtitle: `${unit.durationSeconds} 秒 · ${unit.panelCount} 格 · ${canvasStatus}`,
        id: unit.id,
        // 首卡作用域探针与节点 DOM 只读取显式 unitId；不能把任意节点的通用 id
        // 冒充当前 fixture 单元。该字段也让测试/辅助功能可稳定识别真实单元卡。
        unitId: unit.id,
        busy: Boolean(busy),
        busyMessage: busy?.message,
      },
      draggable: true,
    });
    if (!approvedRaw && ledgerPending) {
      const pendingId = `generation-state:${unit.id}`;
      nextNodes.push({
        id: pendingId,
        type: "managedStudio",
        position: fallbackPos(pendingId, { x: unitX, y: unitY + 156 }),
        class: ["managed-node", "generation-state-node", "missing", "generation-ledger-pending"],
        data: {
          kind: "review",
          kindLabel: "账本存证",
          title: "正式整板待恢复冻结参考",
          subtitle: "账本存证已闭合；冻结参考未恢复。raw 不展示、不导出、不作为后续参考。",
          missing: true,
          id: unit.id,
          unitId: unit.id,
        },
        draggable: true,
      });
      nextEdges.push({
        id: `system:unit-generation-state:${unit.id}`,
        source: id,
        target: pendingId,
        label: "待恢复参考链",
        class: "system-timeline-edge",
        hidden: !showEdges.value,
      });
    } else if (!approvedRaw && nonPass) {
      // T13: REJECTED/stale 仅在隔离视图显示，默认正式画布屏蔽。
      // unreviewed/rework 需要用户行动，保留显示。
      const showNonPassNode = nonPass.status === "unreviewed" || nonPass.status === "rework" || workflowView;
      if (showNonPassNode) {
        const pendingId = `generation-state:${unit.id}`;
        nextNodes.push({
          id: pendingId,
          type: "managedStudio",
          position: fallbackPos(pendingId, { x: unitX, y: unitY + 156 }),
          class: ["managed-node", "generation-state-node", "missing", `generation-${nonPass.status}`],
          data: {
            kind: "review",
            kindLabel: nonPass.status === "unreviewed" ? "待验收" : nonPass.status === "rework" ? "返工" : "验收状态",
            title: nonPass.status === "unreviewed" ? "正式整板待人工验收" : nonPass.status === "rework" ? "正式整板需返工" : "正式整板不可用",
            subtitle: nonPass.subtitle,
            missing: true,
            id: unit.id,
            unitId: unit.id,
          },
          draggable: true,
        });
        nextEdges.push({
          id: `system:unit-generation-state:${unit.id}`,
          source: id,
          target: pendingId,
          label: nonPass.status === "unreviewed" ? "待验收" : nonPass.status === "rework" ? "返工" : "不可用",
          class: "system-timeline-edge",
          hidden: !showEdges.value,
        });
      }
    }
    if (approvedRaw) {
      const rawId = `media:unit-grid-raw:${unit.id}`;
      const rawVerificationSubtitle = approvedRaw.verification === "deep-verified"
        ? `raw+labeled 成对 · 人工审片通过 · 参考已核验 · ${approvedRaw.provider === "grok" ? "Grok" : "Codex"}`
        : approvedRaw.verification === "reference-verified"
          ? `停检账本通过 · 冻结参考闭包已核验 · ${approvedRaw.provider === "grok" ? "Grok" : "Codex"}`
          : `停检账本通过 · raw/labeled 成对 · 冻结参考核验中 · ${approvedRaw.provider === "grok" ? "Grok" : "Codex"}`;
      nextNodes.push({
        id: rawId,
        type: "managedStudio",
        position: fallbackPos(rawId, { x: unitX, y: unitY + 156 }),
        class: ["managed-node", "raw-node", "ready", "unit-grid-raw-node"],
        data: {
          kind: "raw",
          kindLabel: "正式整板",
          title: `${unit.label} · 宫格 raw`,
          // 媒体本体已核验但缩略图未派生：节点立即显示并标注派生中，不隐藏、不降级。
          subtitle: approvedRaw.rawThumbnailUrl
            ? rawVerificationSubtitle
            : `${rawVerificationSubtitle} · 缩略图生成中`,
          thumbnailUrl: approvedRaw.rawThumbnailUrl,
          id: unit.id,
          unitId: unit.id,
          projectRoot: props.projectRoot,
          mediaSha256: approvedRaw.rawMediaSha256,
          exportMediaSha256: approvedRaw.rawMediaSha256,
          exportFileName: `${unit.label}-unit-grid-raw`,
        },
        draggable: true,
      });
      nextEdges.push({
        id: `system:unit-raw:${unit.id}`,
        source: id,
        target: rawId,
        label: "正式整板",
        class: "system-timeline-edge edge-approved",
        hidden: !showEdges.value,
      });
      const videoPackage = unitGridVideoPackagePipeline.value.get(unit.id);
      if (videoPackage) {
        const videoNodeId = `video-package:${unit.id}`;
        nextNodes.push({
          id: videoNodeId,
          type: "managedStudio",
          position: fallbackPos(videoNodeId, { x: unitX + 190, y: unitY + 156 }),
          class: ["managed-node", "video-package-node", videoPackage.status === "resolved" ? "ready" : "missing"],
          data: {
            kind: "video",
            kindLabel: "图生视频包",
            title: videoPackage.status === "resolved" ? "图生视频提交包已建立" : "图生视频提交包待建立",
            subtitle: videoPackage.subtitle,
            missing: videoPackage.status !== "resolved",
            id: unit.id,
            unitId: unit.id,
          },
          draggable: true,
        });
        nextEdges.push({
          id: `system:raw-video-package:${unit.id}`,
          source: rawId,
          target: videoNodeId,
          label: "图生视频包",
          class: "system-timeline-edge edge-video",
          hidden: !showEdges.value,
        });
      }
      const continuity = unitGridContinuityPipeline.value.get(unit.id);
      const observationControl = unitGridPostResultObservationPipeline.value.get(unit.id);
      const currentObservedEndState = observationControl?.status === "current"
        && observationControl.head?.current === true
        && observationControl.head.continuationEligible === true
        ? observationControl.head
        : undefined;
      if (continuity) {
        const continuityReadable = continuity.opaqueFieldCount === 0;
        const continuityNodeId = `continuity:out:${unit.id}`;
        const observationStatus = currentObservedEndState
          ? "实际末态已由独立节点确认；本节点仍只是冻结计划值"
          : observationControl?.status === "stale"
            ? `实际末态观察已过期（${observationControl.blockers.join("、") || "currentness 已失效"}）`
            : observationControl?.status === "missing"
                || approvedRaw.postResultObservationHeadPresent === false
              ? "缺少实际末态观察"
              : "实际末态控制不可用";
        nextNodes.push({
          id: continuityNodeId,
          type: "managedStudio",
          position: fallbackPos(continuityNodeId, { x: unitX + 380, y: unitY + 156 }),
          class: ["managed-node", "continuity-node", continuityReadable ? "locked" : "continuity-unknown"],
          data: {
            kind: "continuity",
            kindLabel: continuityReadable ? "冻结计划终态" : "冻结计划终态 · UNKNOWN",
            title: continuityReadable
              ? `末格计划状态 · ${observationStatus}`
              : `末格计划状态待人工补全 · ${observationStatus}`,
            subtitle: continuityReadable
              ? `计划动作终点：${continuity.visualAction || "已冻结"} · ${continuity.readableFieldCount} 个字段仅供审片核对；planned 不能作为 actual，禁止直接作为下一镜实际起态`
              : `UNKNOWN：${continuity.fieldCount} 个字段已锁，${continuity.opaqueFieldCount} 个仅内部定位；禁止作为下一镜站位/朝向输入；双击打开连续性复核`,
            excerpt: continuityReadable && continuity.handoffSummary
              ? `计划值：${continuity.handoffSummary} · ${continuity.shotComposition || "镜头构图已冻结"} · 须由 PASS 结果观察回执确认`
              : `末格：${continuity.lastPanelTitle || "末格"} · ${continuity.visualAction || "动作未记录"} · ${continuity.shotComposition || "构图未记录"}${continuity.sceneLighting ? ` · ${continuity.sceneLighting}` : ""} · ${continuity.assetSummary}`,
            locked: false,
            missing: true,
            id: continuity.lastPanelId,
            unitId: unit.id,
            assetIds: continuity.assets.map((asset) => asset.assetId).slice(0, 6),
          },
          draggable: true,
        });
        nextEdges.push({
          id: `system:raw-continuity:${unit.id}`,
          source: rawId,
          target: continuityNodeId,
          label: "冻结计划终态",
          class: "system-reference-edge",
          hidden: !showEdges.value,
        });
      }
      if (currentObservedEndState) {
        const observedNodeId = `continuity:observed:${unit.id}`;
        const canonicalSuccessorUnitId = unit.canonicalSuccessorUnitId;
        nextNodes.push({
          id: observedNodeId,
          type: "managedStudio",
          position: fallbackPos(observedNodeId, { x: unitX + 570, y: unitY + 156 }),
          class: ["managed-node", "continuity-node", "observed-continuity-node", "ready", "locked"],
          data: {
            kind: "continuity",
            kindLabel: "实际末态",
            title: "PASS 成片实际末态 · current",
            subtitle: `人工观察回执有效 · 可作为下一镜连续性来源 · raw ${currentObservedEndState.rawSha256.slice(0, 12)}`,
            excerpt: [
              `站位：${currentObservedEndState.observedState.position}`,
              `朝向：${currentObservedEndState.observedState.facing}`,
              `持物：${currentObservedEndState.observedState.heldObject}`,
              `情绪：${currentObservedEndState.observedState.emotion}`,
              `光线：${currentObservedEndState.observedState.lighting}`,
            ].join(" · "),
            locked: true,
            missing: false,
            id: currentObservedEndState.observationId,
            unitId: unit.id,
            projectRoot: props.projectRoot,
            mediaSha256: currentObservedEndState.observedState.referenceSha256,
          },
          draggable: true,
        });
        nextEdges.push({
          id: `system:raw-observed-continuity:${unit.id}`,
          source: rawId,
          target: observedNodeId,
          label: "人工观察实际末态",
          class: "system-reference-edge edge-approved",
          hidden: !showEdges.value,
        });
        if (canonicalSuccessorUnitId && units.some((candidate) => candidate.id === canonicalSuccessorUnitId)) {
          nextEdges.push({
            id: `system:observed-continuity-next-unit:${unit.id}:${canonicalSuccessorUnitId}`,
            source: observedNodeId,
            target: `unit:${canonicalSuccessorUnitId}`,
            label: "下一镜实际起态",
            class: "system-timeline-edge system-observed-continuity-edge edge-approved",
            hidden: !showEdges.value,
          });
        }
      }
      for (const [referenceIndex, reference] of (unitGridReferencePipeline.value.get(unit.id) ?? []).entries()) {
        const referenceNodeId = `reference:${unit.id}:${reference.referenceId}`;
        nextNodes.push({
          id: referenceNodeId,
          type: "managedStudio",
          position: fallbackPos(referenceNodeId, {
            x: unitX + (referenceIndex % 3) * 165,
            y: unitY + 330 + Math.floor(referenceIndex / 3) * 155,
          }),
          class: [
            "managed-node",
            "unit-grid-reference-node",
            `reference-${reference.referenceType}`,
            "locked",
          ],
          data: {
            kind: "reference",
            kindLabel: reference.typeLabel,
            title: reference.title,
            subtitle: "本整板实际冻结输入 · approved 权威图",
            excerpt: reference.assetIds.join(" · "),
            thumbnailUrl: reference.thumbnailUrl,
            locked: true,
            id: reference.referenceId,
            unitId: unit.id,
            assetIds: reference.assetIds,
            referenceType: reference.referenceType,
            projectRoot: props.projectRoot,
            mediaSha256: reference.mediaSha256,
            exportMediaSha256: reference.mediaSha256,
            exportFileName: `${reference.title || reference.referenceId}-ref`,
          },
          draggable: true,
        });
        nextEdges.push({
          id: `system:reference-raw:${unit.id}:${reference.referenceId}`,
          source: referenceNodeId,
          target: rawId,
          label: reference.typeLabel,
          class: `system-reference-edge reference-${reference.referenceType}-edge`,
          hidden: !showEdges.value,
        });
      }
    }
  });
  // 单元时间线系统边（U_n → U_n+1）
  for (let index = 1; index < units.length; index += 1) {
    const prev = units[index - 1]!;
    const unit = units[index]!;
    nextEdges.push({
      id: `system:unit-next:${prev.id}:${unit.id}`,
      source: `unit:${prev.id}`,
      target: `unit:${unit.id}`,
      label: "下一单元",
      class: "system-timeline-edge",
      hidden: !showEdges.value,
    });
  }
  const activeUnitPinned = unitDetail.value ? pinned.has(`unit:${unitDetail.value.unit.id}`) : false;
  const panels = !workflowView || activeUnitPinned ? (unitDetail.value?.panels ?? []) : [];
  const panelsByTime = [...panels].sort((a, b) => a.startSeconds - b.startSeconds || a.ordinal - b.ordinal);
  void nodeStatusTick.value;
  panelsByTime.forEach((panel, index) => {
    const id = `panel:${panel.id}`;
    const busy = nodeStatusStore.get(id);
    const panelThumb = panel.assetIds.map((assetId) => assetThumbById.get(assetId)).find(Boolean);
    nextNodes.push({
      id,
      type: "managedStudio",
      position: fallbackPos(id, { x: 1_500, y: 100 + index * 160 }),
      class: ["managed-node", "panel-node", ...(busy ? ["node-status-busy"] : [])],
      data: {
        kind: "panel",
        kindLabel: `宫格 ${panel.ordinal}`,
        title: panel.label,
        subtitle: `${panel.startSeconds}–${panel.endSeconds} 秒 · ${currentnessLabel(panel.bindingCurrentness)}`,
        excerpt: panel.visualAction || panel.dialogue || panel.statusReason || "",
        thumbnailUrl: panelThumb,
        busy: Boolean(busy),
        busyMessage: busy?.message,
        connectable: true,
        onConnectPoint: () => onConnectPoint(id),
        id: panel.id,
        statusOverlay: busy,
      },
      draggable: true,
    });
    if (unitDetail.value) {
      nextEdges.push({ id: `unit-panel:${unitDetail.value.unit.id}:${panel.id}`, source: `unit:${unitDetail.value.unit.id}`, target: id, label: `${panel.ordinal}`, class: "system-timeline-edge", hidden: !showEdges.value });
    }
    if (index > 0) {
      const prev = panelsByTime[index - 1]!;
      nextEdges.push({
        id: `system:panel-next:${prev.id}:${panel.id}`,
        source: `panel:${prev.id}`,
        target: id,
        label: "下一格",
        class: "system-timeline-edge",
        hidden: !showEdges.value,
      });
    }
    // 系统出场边：画布上已有资产节点且在本格 binding 中
    for (const assetId of panel.assetIds.slice(0, 6)) {
      const source = `asset:${assetId}`;
      if (!nextNodes.some((node) => node.id === source)) continue;
      nextEdges.push({
        id: `system:asset-panel:${assetId}:${panel.id}`,
        source,
        target: id,
        label: "出场",
        class: "system-timeline-edge appearance-edge",
        animated: true,
        hidden: !showEdges.value,
      });
    }
    const pipeline = panelPipeline.value.get(panel.id);
    const rawId = `media:raw:${panel.id}`;
    const labeledId = `media:labeled:${panel.id}`;
    const reviewId = `media:review:${panel.id}`;
    nextNodes.push({
      id: rawId,
      type: "managedStudio",
      position: fallbackPos(rawId, { x: 1_720, y: 100 + index * 160 }),
      class: ["managed-node", "raw-node", pipeline?.raw ? "ready" : "missing"],
      data: {
        kind: "raw",
        kindLabel: "原始图",
        title: pipeline?.raw ? "原始生成图" : "等待原始图",
        subtitle: pipeline?.raw ? "已生成·待人工审片" : "尚未生成完成",
        thumbnailUrl: pipeline?.rawThumbnailUrl,
        missing: !pipeline?.raw,
        id: panel.id,
        panelId: panel.id,
        projectRoot: props.projectRoot,
        ...(pipeline?.raw?.mediaSha256
          ? {
            exportMediaSha256: pipeline.raw.mediaSha256,
            exportFileName: `${panel.label || panel.id}-raw`,
          }
          : {}),
      },
      draggable: true,
    });
    nextNodes.push({
      id: labeledId,
      type: "managedStudio",
      position: fallbackPos(labeledId, { x: 1_940, y: 100 + index * 160 }),
      class: ["managed-node", "labeled-node", pipeline?.labeled ? "ready" : "missing"],
      data: {
        kind: "labeled",
        kindLabel: "标注图",
        title: pipeline?.labeled ? "中文标注图" : "等待标注图",
        subtitle: pipeline?.labeled ? "与原始图成对" : "本地排版尚未完成",
        thumbnailUrl: pipeline?.labeledThumbnailUrl,
        missing: !pipeline?.labeled,
        id: panel.id,
        panelId: panel.id,
        projectRoot: props.projectRoot,
        ...(pipeline?.labeled?.mediaSha256
          ? {
            exportMediaSha256: pipeline.labeled.mediaSha256,
            exportFileName: `${panel.label || panel.id}-labeled`,
          }
          : {}),
      },
      draggable: true,
    });
    nextNodes.push({
      id: reviewId,
      type: "managedStudio",
      position: fallbackPos(reviewId, { x: 2_160, y: 100 + index * 160 }),
      class: ["managed-node", "review-node", `review-${pipeline?.reviewStatus ?? "unreviewed"}`],
      data: {
        kind: "review",
        kindLabel: "审片",
        title: ({ pass: "已通过", rework: "需返工", reject: "已拒绝", stale: "审片已过期", unreviewed: "待审片" } as const)[pipeline?.reviewStatus ?? "unreviewed"],
        subtitle: pipeline?.raw && pipeline?.labeled ? "点击对比原始图 / 标注图" : "结果成对后可审片",
        missing: !pipeline?.raw || !pipeline?.labeled,
        id: panel.id,
        panelId: panel.id,
      },
      draggable: true,
    });
    nextEdges.push({ id: `panel-raw:${panel.id}`, source: id, target: rawId, label: "原始图", class: "system-timeline-edge", hidden: !showEdges.value });
    nextEdges.push({ id: `raw-labeled:${panel.id}`, source: rawId, target: labeledId, label: "标注图", class: "system-timeline-edge", hidden: !showEdges.value });
    nextEdges.push({ id: `labeled-review:${panel.id}`, source: labeledId, target: reviewId, label: "审片", class: "system-timeline-edge", hidden: !showEdges.value });
  });
  // 选中资产时额外高亮 appearances（与系统出场边并存，不替代）
  const visibleUnits = new Set(units.map((unit) => unit.id));
  for (const appearance of appearancesPage.value?.page.items ?? []) {
    if (!selection.value || selection.value.kind !== "asset") continue;
    const source = `asset:${selection.value.asset.id}`;
    const panelVisible = panels.some((panel) => panel.id === appearance.panelId);
    const target = panelVisible ? `panel:${appearance.panelId}` : visibleUnits.has(appearance.unitId) ? `unit:${appearance.unitId}` : undefined;
    if (!target || !nextNodes.some((node) => node.id === source)) continue;
    if (nextEdges.some((edge) => edge.id === `system:asset-panel:${appearance.assetId}:${appearance.panelId}`)) continue;
    nextEdges.push({
      id: `appearance:${appearance.assetId}:${appearance.unitId}:${appearance.panelId}`,
      source,
      target,
      label: appearance.role || "出场",
      animated: true,
      class: "appearance-edge",
      hidden: !showEdges.value,
    });
  }
  const visibleNodeIds = new Set(nextNodes.map((node) => node.id));
  for (const edge of draftCanvasEdges.value) {
    if (!visibleNodeIds.has(edge.sourceId) || !visibleNodeIds.has(edge.targetId)) continue;
    nextEdges.push({
      id: `draft:${edge.sourceId}:${edge.targetId}`,
      source: edge.sourceId,
      target: edge.targetId,
      label: "生成输入",
      animated: true,
      class: selectedDraftEdgeId.value === `draft:${edge.sourceId}:${edge.targetId}` ? "draft-input-edge selected-draft-edge" : "draft-input-edge",
      hidden: !showEdges.value,
    });
  }
  const pendingNode = nextNodes.find((node) => node.id === pendingConnectionSourceId.value);
  if (pendingNode) {
    const classes = Array.isArray(pendingNode.class)
      ? pendingNode.class.map(String).join(" ")
      : typeof pendingNode.class === "string" ? pendingNode.class : "";
    pendingNode.class = `${classes} connection-pending`.trim();
  }
  for (const node of nextNodes) {
    if (selectedNodeIds.has(node.id)) (node as CanvasFlowNodeLike).selected = true;
  }
  nodes.value = applySpatialGrouping(nextNodes);
  edges.value = nextEdges;
  syncSelectionSnapshot(nextNodes);
}

async function hydrateLayoutFromDisk(projectRoot = props.projectRoot): Promise<boolean> {
  const api = resolveLayoutApi();
  if (!api) return true;
  const requestSequence = ++layoutLoadSequence;
  const isCurrent = () => projectRoot === props.projectRoot && requestSequence === layoutLoadSequence;
  try {
    const layout = await api.loadLayout(projectRoot);
    if (!isCurrent()) return false;
    if (!layout) {
      layoutSaveCoordinator.setBaseline(projectRoot, null);
      layoutFingerprint.value = undefined;
      persistedLayoutNodes.value = {};
      persistedLayoutBase.value = null;
      workspaceMode.value = "projection";
      pinnedNodeIds.value = [];
      pinnedAssetsPage.value = null;
      pinnedMediaItems.value = new Map();
      draftCanvasEdges.value = [];
      workflowGroups.value = [];
      spatialGroups.value = [];
      return true;
    }
    layoutSaveCoordinator.setBaseline(projectRoot, layout);
    layoutFingerprint.value = layout.fingerprint;
    persistedLayoutNodes.value = { ...layout.nodes };
    persistedLayoutBase.value = structuredClone(layout);
    layoutViewport.value = { ...layout.viewport };
    zoom.value = layout.viewport.zoom;
    const restoredPinnedNodeIds = [...(layout.pinnedNodeIds ?? [])];
    pinnedNodeIds.value = restoredPinnedNodeIds;
    workspaceMode.value = (layout.workspaceMode ?? "projection") === "workflow" && restoredPinnedNodeIds.length === 0
      ? "projection"
      : (layout.workspaceMode ?? "projection");
    draftCanvasEdges.value = [...(layout.draftCanvasEdges ?? [])];
    workflowGroups.value = [...(layout.workflowGroups ?? [])];
    spatialGroups.value = [...(layout.spatialGroups ?? [])];
    return true;
  } catch (error) {
    // 布局是视图层：失败不阻断生产投影
    if (isCurrent()) errorMessage.value = `布局加载失败：${message(error)}`;
    return false;
  }
}

function acceptPersistedLayout(
  layout: StudioCanvasLayout,
  options: { applyMergedSemantic?: boolean } = {},
): void {
  layoutFingerprint.value = layout.fingerprint;
  persistedLayoutNodes.value = { ...layout.nodes };
  persistedLayoutBase.value = structuredClone(layout);
  if (!options.applyMergedSemantic) return;

  layoutViewport.value = { ...layout.viewport };
  zoom.value = layout.viewport.zoom;
  workspaceMode.value = layout.workspaceMode;
  pinnedNodeIds.value = [...layout.pinnedNodeIds];
  draftCanvasEdges.value = layout.draftCanvasEdges.map((edge) => ({ ...edge }));
  workflowGroups.value = layout.workflowGroups.map((group) => ({
    ...group,
    panelIds: [...group.panelIds],
    pipeline: [...group.pipeline],
  }));
  spatialGroups.value = (layout.spatialGroups ?? []).map((group) => ({
    ...group,
    memberIds: [...group.memberIds],
  }));
  nodes.value = nodes.value.map((node) => {
    const position = layout.nodes[node.id];
    return position ? { ...node, position: { ...position } } : node;
  });
  rebuildGraph();
}

function onNodesChange(changes: NodeChange[]): void {
  // Vue Flow 1.48 没有 selection-change 事件：选区变化经 nodesChange(type="select") 下发。
  if (!changes.some((change) => change.type === "select")) return;
  // nodesChange 在部分 Vue Flow 版本早于 v-model 写回；微任务读取最终 nodes，避免计数停在上一次选区。
  queueMicrotask(() => syncSelectionSnapshot(nodes.value));
}

function syncSelectionSnapshot(source: readonly Node[]): void {
  const selected = source.filter((node) => (node as CanvasFlowNodeLike).selected);
  selectionCount.value = selected.length;
  selectedPanelIds.value = extractStudioCanvasPanelIdsFromSelection(
    selected.map((node) => ({
      id: node.id,
      kind: (node.data as { kind?: string } | undefined)?.kind,
      data: node.data,
    })),
  );
}

async function persistWorkflow(
  panelIds: readonly string[],
  title: string,
  options: { reuseExisting?: boolean; scope?: FrozenWorkflowActionScope } = {},
): Promise<StudioCanvasWorkflowGroup> {
  const api = resolveLayoutApi();
  if (!api) {
    throw new Error("布局 API 不可用。");
  }
  const unitId = options.scope?.unitId ?? unitDetail.value?.unit.id;
  if (!unitId) throw new Error("工作流缺少冻结单元身份。");
  const scope = options.scope ?? {
    token: workflowActionGate.begin(props.projectRoot, unitId),
    projectRoot: props.projectRoot,
    unitId,
    provider: props.generationProvider,
  };
  await flushPendingLayout(scope.projectRoot);
  if (!workflowActionIsCurrent(scope)) {
    throw new Error("工程或单元已切换；旧工作流保存已取消。");
  }
  // 只有旧布局 flush 完成且作用域仍 current 后，才读取本工程的响应式布局快照。
  // 此后所有持久化都使用冻结 root；切换期间绝不把旧 panelIds 写进新工程。
  const currentGroups = plainWorkflowGroups(workflowGroups.value);
  if (options.reuseExisting) {
    const existing = [...currentGroups].reverse().find((group) => (
      group.title === title
      && group.pipeline.length === 1
      && group.pipeline[0] === "image"
      && group.panelIds.length === panelIds.length
      && group.panelIds.every((panelId, index) => panelId === panelIds[index])
    ));
    if (existing) {
      lastWorkflowTitle.value = existing.title;
      // workflowGroups 存在 Vue reactive ref 中；重复“准备派发”会取到 Proxy。
      // Electron IPC 无法 structured-clone Proxy，必须在跨进程前恢复为纯对象。
      return plainWorkflowGroups([existing])[0]!;
    }
  }
  const nextGroups = createStudioCanvasWorkflowGroup(currentGroups, {
    title,
    panelIds,
    pipeline: ["image"],
  });
  const created = nextGroups[nextGroups.length - 1]!;
  const collected = collectAbsoluteNodePositions();
  const local: StudioCanvasLayoutSemanticSnapshot = {
    viewport: { ...layoutViewport.value, zoom: zoom.value },
    nodes: plainNodePositions(boundedLayoutNodes({ ...persistedLayoutNodes.value, ...collected })),
    workspaceMode: workspaceMode.value,
    pinnedNodeIds: [...pinnedNodeIds.value],
    draftCanvasEdges: plainDraftEdges(),
    workflowGroups: plainWorkflowGroups(nextGroups),
    spatialGroups: plainSpatialGroups(spatialGroups.value),
  };
  const workflowLayoutGeneration = layoutSaveGeneration;
  const result = await layoutSaveCoordinator.saveExclusive({
    projectRoot: scope.projectRoot,
    generation: workflowLayoutGeneration,
    local,
    force: true,
  });
  if (!workflowActionIsCurrent(scope)) {
    throw new Error("工程或单元已切换；旧工作流结果未写入当前界面。");
  }
  acceptPersistedLayout(result.layout, {
    applyMergedSemantic: result.merged
      && workflowLayoutGeneration === layoutSaveGeneration,
  });
  workflowGroups.value = [...result.layout.workflowGroups];
  const reflectedNodes = collectAbsoluteNodePositions();
  layoutSaveCoordinator.setReflectedSemantic(scope.projectRoot, {
    viewport: { ...layoutViewport.value, zoom: zoom.value },
    nodes: plainNodePositions(boundedLayoutNodes({
      ...persistedLayoutNodes.value,
      ...reflectedNodes,
    })),
    workspaceMode: workspaceMode.value,
    pinnedNodeIds: [...pinnedNodeIds.value],
    draftCanvasEdges: plainDraftEdges(),
    workflowGroups: plainWorkflowGroups(workflowGroups.value),
    spatialGroups: plainSpatialGroups(spatialGroups.value),
  });
  lastWorkflowTitle.value = created.title;
  layoutSaveState.value = "saved";
  return created;
}

async function createWorkflowFromSelection(): Promise<void> {
  const unitId = unitDetail.value?.unit.id;
  if (!selectedPanelIds.value.length || workflowBusy.value || !unitId) return;
  const panelIds = [...selectedPanelIds.value];
  const scope: FrozenWorkflowActionScope = {
    token: workflowActionGate.begin(props.projectRoot, unitId),
    projectRoot: props.projectRoot,
    unitId,
    provider: props.generationProvider,
  };
  const title = `工作流 ${workflowGroups.value.length + 1}`;
  workflowBusy.value = true;
  try {
    await persistWorkflow(panelIds, title, { scope });
  } catch (error) {
    if (workflowActionIsCurrent(scope)) {
      errorMessage.value = `创建工作流失败：${message(error)}`;
      emit("failed", errorMessage.value);
    }
  } finally {
    if (workflowActionIsCurrent(scope)) workflowBusy.value = false;
  }
}

function draftForPanels(panelIds: readonly string[]): StudioCanvasWorkflowDraftInput | undefined {
  const panelNodeIds = new Set(panelIds.map((panelId) => `panel:${panelId}`));
  const relevantEdges = draftCanvasEdges.value.filter((edge) => panelNodeIds.has(edge.targetId));
  return relevantEdges.length ? buildWorkflowDraftInput(relevantEdges) : undefined;
}

async function preflightDraftMismatch(
  panelIds: readonly string[],
  projectRoot = props.projectRoot,
  frozenDraft?: StudioCanvasWorkflowDraftInput | null,
): Promise<string | null> {
  const draft = frozenDraft === undefined ? draftForPanels(panelIds) : frozenDraft ?? undefined;
  if (!draft) return null;
  const validation = validateStudioCanvasWorkflowDraft(draft);
  if (!validation.ok) return validation.error.message;
  const targetSet = new Set(panelIds);
  const panels = (unitDetail.value?.panels ?? [])
    .filter((panel) => targetSet.has(panel.id))
    .map((panel) => ({ panelId: panel.id, label: panel.label, expectedAssetIds: panel.assetIds.slice(0, 6) }));
  const allAssetIds = [...new Set([
    ...panels.flatMap((panel) => panel.expectedAssetIds),
    ...validation.draft.panels.flatMap((panel) => panel.assetIds),
  ])];
  const knownAssets = new Map<string, StudioDashboardAssetSummary>();
  for (const asset of [
    ...(assetsPage.value?.page.items ?? []),
    ...(pinnedAssetsPage.value?.page.items ?? []),
  ]) knownAssets.set(asset.id, asset);
  const missingIds = allAssetIds.filter((assetId) => !knownAssets.has(assetId));
  for (let offset = 0; offset < missingIds.length; offset += 6) {
    const assetIds = missingIds.slice(offset, offset + 6);
    const result = await props.api.getDashboard(projectRoot, {
      operation: "assets",
      assetIds,
      limit: assetIds.length,
    });
    if (result.operation !== "assets") continue;
    for (const asset of result.page.items) knownAssets.set(asset.id, asset);
  }
  return describeStudioCanvasWorkflowMismatch({
    panels,
    connections: validation.draft.panels,
    assets: [...knownAssets.values()].map((asset) => ({ id: asset.id, category: asset.category, name: asset.name })),
  })?.message ?? null;
}

async function executeWorkflowGroup(
  group: StudioCanvasWorkflowGroup,
  draft?: StudioCanvasWorkflowDraftInput,
  alreadyBusy = false,
  frozenScope?: FrozenWorkflowActionScope,
): Promise<void> {
  if (workflowBusy.value && !alreadyBusy) return;
  const unitId = frozenScope?.unitId ?? unitDetail.value?.unit.id;
  if (!unitId) {
    errorMessage.value = "请先选中 15 秒单元，以便解析宫格归属后再执行工作流。";
    workflowBusy.value = false;
    return;
  }
  const scope = frozenScope ?? {
    token: workflowActionGate.begin(props.projectRoot, unitId),
    projectRoot: props.projectRoot,
    unitId,
    provider: props.generationProvider,
  };
  if (!workflowActionIsCurrent(scope)) return;
  const projectRoot = scope.projectRoot;
  // 捕获本次点击时的显式选择；后续异步预检期间 UI 切换不得改写本次派发身份。
  const provider = scope.provider;
  const knownPanels = new Set((unitDetail.value?.panels ?? []).map((panel) => panel.id));
  const matchingPanelIds = group.panelIds
    .filter((panelId) => knownPanels.has(panelId))
  if (!matchingPanelIds.length) {
    if (workflowActionIsCurrent(scope)) {
      errorMessage.value = "最近工作流组与当前单元宫格无交集，无法执行。";
      workflowBusy.value = false;
    }
    return;
  }
  type Bridge = {
    runStudioCanvasWorkflowGroup?: (
      projectRoot: string,
      workflowGroup: {
        id: string;
        title: string;
        panelIds: string[];
        pipeline: string[];
      },
      options: {
        provider: "codex" | "grok";
        targets: Array<
          | { targetKind?: "panel"; panelId: string; unitId: string }
          | { targetKind: "unit-grid"; unitId: string }
        >;
        imageMode?: "freeze-dispatch-only" | "freeze-dispatch-register";
        draft?: StudioCanvasWorkflowDraftInput;
      },
    ) => Promise<{ outcomes: Array<{ ok: boolean }>; stoppedEarly: boolean; groupId: string }>;
  };
  const bridge = (window as unknown as { canvasApi?: Bridge }).canvasApi;
  if (!bridge?.runStudioCanvasWorkflowGroup) {
    if (workflowActionIsCurrent(scope)) {
      errorMessage.value = "工作流执行 API 不可用（请使用完整桌面壳）。";
      workflowBusy.value = false;
    }
    return;
  }
  workflowBusy.value = true;
  lastWorkflowFailed.value = false;
  lastWorkflowRunSummary.value = "正在核对锁定资产与正式绑定…";
  try {
    let useUnitGrid = false;
    try {
      const control = await window.canvasApi.getDuduReadonlyImportControl(projectRoot);
      useUnitGrid = control.kind === "dudu-readonly-import-control";
    } catch {
      // 普通受管工程没有 Dudu import control。如果 Dudu control 本身损坏，
      // Core runner 仍会按 bootstrap claim 拒绝 panel fallback，不会静默逐格派发。
    }
    if (!workflowActionIsCurrent(scope)) return;
    const targets = useUnitGrid
      ? [{ targetKind: "unit-grid" as const, unitId }]
      : matchingPanelIds.map((panelId) => ({ targetKind: "panel" as const, panelId, unitId }));
    const result = await bridge.runStudioCanvasWorkflowGroup(projectRoot, group, {
      provider,
      targets,
      imageMode: "freeze-dispatch-only",
      ...(draft ? { draft } : {}),
    });
    if (!workflowActionIsCurrent(scope)) return;
    const ok = result.outcomes.filter((entry) => entry.ok).length;
    const fail = result.outcomes.length - ok;
    const providerLabel = provider === "grok" ? "Grok" : "Codex";
    lastWorkflowFailed.value = fail > 0 || result.stoppedEarly;
    lastWorkflowRunSummary.value = `组 ${group.title}：冻结/计划/派发记录 ${ok} · 未记录 ${fail}${result.stoppedEarly ? " · 提前停止" : ""}${ok > 0 ? ` · 等待 ${providerLabel} Agent 领取` : ""}`;
    lastWorkflowTitle.value = group.title;
    // P21：宫格状态不再用 1.6s setTimeout 装饰，改由生成计划账本投影驱动。
    await syncPlanNodeStatuses();
    if (!workflowActionIsCurrent(scope)) return;
    rebuildGraph();
  } catch (error) {
    if (workflowActionIsCurrent(scope)) {
      errorMessage.value = workflowFailureMessage(error);
      lastWorkflowFailed.value = true;
      lastWorkflowRunSummary.value = "执行失败";
      emit("failed", errorMessage.value);
    }
  } finally {
    if (workflowActionIsCurrent(scope)) workflowBusy.value = false;
  }
}

/** P21：宫格节点状态只来自生成计划账本投影（无投影时清空会话态，不自猜）。 */
async function syncPlanNodeStatuses(): Promise<void> {
  const projectRoot = props.projectRoot;
  const requestSequence = ++planStatusLoadSequence;
  try {
    const progress = await window.canvasApi.getStudioGenerationPlanProgress(projectRoot);
    if (canvasDisposed || projectRoot !== props.projectRoot || requestSequence !== planStatusLoadSequence) return;
    for (const key of Object.keys(nodeStatusStore.snapshot())) {
      if (key.startsWith("panel:") || key.startsWith("unit:")) nodeStatusStore.clear(key);
    }
    for (const node of progress.nodes) {
      let message = "";
      if (node.status === "dispatched") message = "已派发，等待 Agent";
      else if (node.status === "planned") message = "计划待派发";
      else if (node.status === "failed") message = `失败：${node.errorClass ?? "未知"}`;
      else if (node.status === "cancelled") message = "已取消";
      if (message) {
        const nodeId = node.targetKind === "unit-grid" ? `unit:${node.unitId}` : `panel:${node.panelId}`;
        nodeStatusStore.set(nodeId, { step: "workflow", message });
      }
    }
    nodeStatusTick.value += 1;
    // 投影须驱动画布节点徽标（busy 在 rebuildGraph 内烘焙）；账本事件风暴去抖 200ms 批量重建，拖拽中顺延。
    schedulePlanStatusRebuild();
  } catch {
    // 投影失败不影响画布既有状态；下次账本变化会再次触发。
  }
}

let syncRebuildTimer = 0;
let planStatusRebuildDirty = false;
let generationProjectionRefreshTimer = 0;
let generationProjectionRefreshQueued = false;
let generationProjectionRefreshInFlight: Promise<void> | undefined;
function schedulePlanStatusRebuild(): void {
  if (syncRebuildTimer) return;
  syncRebuildTimer = window.setTimeout(() => {
    syncRebuildTimer = 0;
    // 拖拽中不重建但置脏，拖拽收尾时补一次（防徽标滞留）。
    if (isDragging.value) {
      planStatusRebuildDirty = true;
      return;
    }
    scheduleUnitGridGraphRebuild();
  }, 200);
}

async function refreshGenerationProjectionFromLedger(): Promise<void> {
  const projectRoot = props.projectRoot;
  await syncPlanNodeStatuses();
  if (canvasDisposed || projectRoot !== props.projectRoot) return;
  const units = unitsPage.value?.page.items;
  if (!units) {
    await loadUnits();
    return;
  }
  // T12: 账本变更时同步刷新批量投影（双编号/搜索/状态归约）
  const coreByUnit = await refreshTimelineProjectionForUnits(units);
  if (canvasDisposed || projectRoot !== props.projectRoot) return;
  scheduleApprovedUnitGridRawProjection(projectRoot, units, coreByUnit);
  if (canvasDisposed || projectRoot !== props.projectRoot) return;
  // raw 投影收尾已 scheduleUnitGridGraphRebuild；此处再并入同一 rAF，避免同帧双整图。
  scheduleUnitGridGraphRebuild();
}

/**
 * Review/结果写入可能在短时间内产生多次 WAL 事件。单一 debounce + 单飞刷新
 * 保证只读投影不并发重拉；若刷新期间又收到事件，收尾后再补一次。
 */
function scheduleGenerationProjectionRefresh(): void {
  generationProjectionRefreshQueued = true;
  if (generationProjectionRefreshTimer || generationProjectionRefreshInFlight) return;
  generationProjectionRefreshTimer = window.setTimeout(() => {
    generationProjectionRefreshTimer = 0;
    generationProjectionRefreshQueued = false;
    const refresh = refreshGenerationProjectionFromLedger();
    generationProjectionRefreshInFlight = refresh;
    void refresh.finally(() => {
      if (generationProjectionRefreshInFlight === refresh) generationProjectionRefreshInFlight = undefined;
      if (generationProjectionRefreshQueued && !canvasDisposed) scheduleGenerationProjectionRefresh();
    });
  }, 200);
}

/** 高级入口：执行已经保存的最近工作流组。 */
async function runLastWorkflowGroup(): Promise<void> {
  const detail = unitDetail.value;
  const latestGroup = workflowGroups.value[workflowGroups.value.length - 1];
  if (workflowBusy.value || !detail || !latestGroup) return;
  const group = plainWorkflowGroups([latestGroup])[0]!;
  const frozenDraft = draftForPanels(group.panelIds);
  const scope: FrozenWorkflowActionScope = {
    token: workflowActionGate.begin(props.projectRoot, detail.unit.id),
    projectRoot: props.projectRoot,
    unitId: detail.unit.id,
    provider: props.generationProvider,
  };
  workflowBusy.value = true;
  try {
    await refreshRuntimeWriteGate();
    if (!workflowActionIsCurrent(scope)) return;
    if (runtimeWriteBlocked.value) {
      errorMessage.value = "运行工件或源码身份不可确认；已停止工作流派发，请重启源码无限画布。";
      return;
    }
    await executeWorkflowGroup(group, frozenDraft, true, scope);
  } finally {
    if (workflowActionIsCurrent(scope)) workflowBusy.value = false;
  }
}

/** 主入口：收集当前宫格，后台 freeze→plan→记录显式 provider dispatch；不冒充 Agent 已领取或已经生图。 */
async function primaryStart(): Promise<void> {
  const detail = unitDetail.value;
  if (workflowBusy.value || !detail) return;
  const projectRoot = props.projectRoot;
  const unitId = detail.unit.id;
  const unitLabel = detail.unit.label;
  const provider = props.generationProvider;
  const panelIds = detail.panels.map((panel) => panel.id);
  const frozenDraft = draftForPanels(panelIds) ?? null;
  const scope: FrozenWorkflowActionScope = {
    token: workflowActionGate.begin(projectRoot, unitId),
    projectRoot,
    unitId,
    provider,
  };
  // 点击入口同步置 busy 并冻结 root/unit/panels/provider；首次 await 前不再留切换窗口。
  workflowBusy.value = true;
  lastWorkflowRunSummary.value = "正在预检…";
  lastWorkflowFailed.value = false;
  errorMessage.value = "";
  // 顶部“准备并记录派发”永远处理当前 15 秒单元的全部宫格；框选只服务高级工作流，
  // 不允许因查看/连过其中一格而静默漏派其余宫格。
  if (!panelIds.length) {
    errorMessage.value = "当前 15 秒分镜没有可执行宫格。";
    workflowBusy.value = false;
    return;
  }
  try {
    await refreshRuntimeWriteGate();
    if (!workflowActionIsCurrent(scope)) return;
    if (runtimeWriteBlocked.value) {
      errorMessage.value = "运行工件或源码身份不可确认；已停止正式派发，请重启源码无限画布。";
      lastWorkflowRunSummary.value = "运行时身份未通过，未派发";
      lastWorkflowFailed.value = true;
      return;
    }
    if (generationProjectionDegraded.value) {
      errorMessage.value = generationProjectionHint.value;
      lastWorkflowRunSummary.value = "生成账本待恢复，未派发";
      lastWorkflowFailed.value = true;
      return;
    }
    const mismatch = await preflightDraftMismatch(panelIds, projectRoot, frozenDraft);
    if (!workflowActionIsCurrent(scope)) return;
    if (mismatch) {
      errorMessage.value = mismatch;
      lastWorkflowRunSummary.value = "连线预检未通过";
      lastWorkflowFailed.value = true;
      return;
    }
    const providerLabel = provider === "grok" ? "Grok" : "Codex";
    const group = await persistWorkflow(panelIds, `${unitLabel} · ${providerLabel} 派发准备`, {
      reuseExisting: true,
      scope,
    });
    if (!workflowActionIsCurrent(scope)) return;
    await executeWorkflowGroup(group, frozenDraft ?? undefined, true, scope);
  } catch (error) {
    if (workflowActionIsCurrent(scope)) {
      errorMessage.value = `派发准备失败：${message(error)}`;
      lastWorkflowRunSummary.value = "执行失败";
      lastWorkflowFailed.value = true;
      emit("failed", errorMessage.value);
    }
  } finally {
    if (workflowActionIsCurrent(scope)) workflowBusy.value = false;
  }
}

function scheduleLayoutPersist(): void {
  const api = resolveLayoutApi();
  if (!api) return;
  layoutSaveState.value = "pending";
  if (layoutSaveTimer) clearTimeout(layoutSaveTimer);
  const generation = ++layoutSaveGeneration;
  const projectRoot = props.projectRoot;
  layoutSaveTimer = setTimeout(() => {
    layoutSaveTimer = undefined;
    void persistLayoutNow(generation, projectRoot);
  }, LAYOUT_SAVE_DEBOUNCE_MS);
}

async function persistLayoutNow(
  generation: number,
  projectRoot = props.projectRoot,
  options: { force?: boolean } = {},
): Promise<void> {
  const api = resolveLayoutApi();
  if (!api) return;
  if (generation !== layoutSaveGeneration) return;
  const isCurrentProject = () => projectRoot === props.projectRoot && generation === layoutSaveGeneration;
  if (isCurrentProject()) layoutSaveState.value = "saving";
  const collected = collectAbsoluteNodePositions();
  // 在首次 CAS 前冻结本窗口语义；冲突重试不得被远端 hydrate 反向覆盖。
  const local: StudioCanvasLayoutSemanticSnapshot = {
    viewport: { ...layoutViewport.value, zoom: zoom.value },
    nodes: plainNodePositions(boundedLayoutNodes({ ...persistedLayoutNodes.value, ...collected })),
    workspaceMode: workspaceMode.value,
    pinnedNodeIds: [...pinnedNodeIds.value],
    draftCanvasEdges: plainDraftEdges(),
    workflowGroups: plainWorkflowGroups(workflowGroups.value),
    spatialGroups: plainSpatialGroups(spatialGroups.value),
  };
  layoutSaveCoordinator.saveLatest({
    projectRoot,
    generation,
    local,
    ...(options.force ? { force: true } : {}),
  });
  await layoutSaveCoordinator.flush();
}

async function flushPendingLayout(projectRoot = props.projectRoot): Promise<void> {
  if (layoutSaveTimer) {
    clearTimeout(layoutSaveTimer);
    layoutSaveTimer = undefined;
    await persistLayoutNow(layoutSaveGeneration, projectRoot, { force: true });
    return;
  }
  await layoutSaveCoordinator.flush({
    projectRoot,
    force: true,
  });
}

async function loadOverview(): Promise<void> {
  const query = { operation: "overview" as const };
  const token = controller.begin(props.projectRoot, query);
  const result = await props.api.getDashboard(props.projectRoot, query);
  if (controller.isCurrent(token, query) && result.operation === "overview") overview.value = result;
}

async function captureT23FirstCardMutationChecks(): Promise<number | undefined> {
  if (window.canvasApi.t23PerformanceProbeEnabled !== true) return undefined;
  const gate = await window.canvasApi.getRuntimeWriteGate();
  const value = "runtimeGateMetrics" in gate
    ? gate.runtimeGateMetrics?.mutationChecks
    : undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

async function activateUnitTimelineProjections(units: StudioDashboardUnitSummary[]): Promise<void> {
  const projectRoot = props.projectRoot;
  const coreByUnit = await refreshTimelineProjectionForUnits(units);
  if (canvasDisposed || projectRoot !== props.projectRoot) return;
  // 不能因 overview 的账本状态降级而把正式 raw 链清空。单元先显示，
  // raw/冻结参考在后台逐项严格验真；未验真不会生成节点，也不会被当作“无 raw”。
  scheduleApprovedUnitGridRawProjection(projectRoot, units, coreByUnit);
}

async function loadUnitsPage(
  options: { deferTimelineProjections?: boolean } = {},
  projectRoot = props.projectRoot,
): Promise<StudioDashboardUnitSummary[]> {
  const query = {
    operation: "units" as const,
    ...(seasonFilter.value ? { season: seasonFilter.value } : {}),
    ...(episodeFilter.value ? { episode: episodeFilter.value } : {}),
    ...(unitCursor.value ? { cursor: unitCursor.value } : {}),
    limit: 36,
  };
  const token = controller.begin(projectRoot, query);
  const result = await props.api.getDashboard(projectRoot, query);
  if (projectRoot === props.projectRoot && controller.isCurrent(token, query) && result.operation === "units") {
    unitsPage.value = result;
    if (!options.deferTimelineProjections) void activateUnitTimelineProjections(result.page.items);
    const selectedUnitId = selection.value?.kind === "unit" ? selection.value.unit.id : undefined;
    const activeUnitPinned = Boolean(unitDetail.value && pinnedNodeIds.value.includes(`unit:${unitDetail.value.unit.id}`));
    if (!activeUnitPinned && selectedUnitId && !result.page.items.some((unit) => unit.id === selectedUnitId)) {
      selection.value = null;
      unitDetail.value = null;
    }
    rebuildGraph();
    return result.page.items;
  }
  return [];
}

async function loadUnits(): Promise<void> {
  await loadUnitsPage({}, props.projectRoot);
}

async function loadAssets(): Promise<void> {
  const projectRoot = props.projectRoot;
  const query = {
    operation: "assets" as const,
    ...(assetCategory.value ? { category: assetCategory.value } : {}),
    ...(assetSearch.value ? { search: assetSearch.value } : {}),
    ...(assetCursor.value ? { cursor: assetCursor.value } : {}),
    // 素材库独立 36 项分页；投影到画布时在 rebuildGraph 严格截为 6 项。
    limit: 36,
  };
  const token = controller.begin(projectRoot, query);
  const result = await props.api.getDashboard(projectRoot, query);
  if (projectRoot === props.projectRoot && controller.isCurrent(token, query) && result.operation === "assets") {
    assetsPage.value = result;
    const selectedAssetId = selection.value?.kind === "asset" ? selection.value.asset.id : undefined;
    if (selectedAssetId && !result.page.items.some((asset) => asset.id === selectedAssetId)) {
      selection.value = null;
      appearancesPage.value = null;
    }
    // 素材库分页只驱动“查看全部”投影。工作流画布由 pinnedAssetsPage 独占；若分类
    // 请求与固定节点请求交错，先重建空图再重建固定图会被 Vue Flow 的延迟 remove
    // 事件反向覆盖，表现为“已添加但节点消失”。
    if (workspaceMode.value !== "workflow") rebuildGraph();
  }
}

async function loadMediaPage(projectRoot = props.projectRoot): Promise<void> {
  const requestSequence = ++mediaLoadSequence;
  const result = await window.canvasApi.listStudioMedia(projectRoot, {
    ...(mediaKindFilter.value !== "all" ? { kind: mediaKindFilter.value } : {}),
    ...(mediaSearch.value ? { search: mediaSearch.value } : {}),
    ...(mediaCursor.value ? { cursor: mediaCursor.value } : {}),
    limit: STUDIO_CANVAS_MEDIA_PAGE_LIMIT,
  });
  if (projectRoot !== props.projectRoot || requestSequence !== mediaLoadSequence) return;
  mediaPage.value = result;
}

async function loadPinnedAssets(options: { rebuild?: boolean } = {}): Promise<void> {
  const shouldRebuild = options.rebuild !== false;
  const projectRoot = props.projectRoot;
  const assetIds = pinnedNodeIds.value
    .filter((nodeId) => nodeId.startsWith("asset:"))
    .map((nodeId) => nodeId.slice("asset:".length));
  if (!assetIds.length) {
    pinnedAssetsPage.value = null;
    if (shouldRebuild) rebuildGraph();
    return;
  }
  const requestKey = { operation: "assets" as const, assetIds, limit: 6 };
  const token = pinnedAssetController.begin(projectRoot, requestKey);
  const chunks = Array.from({ length: Math.ceil(assetIds.length / 6) }, (_, index) => assetIds.slice(index * 6, index * 6 + 6));
  const results = await Promise.all(chunks.map((chunk) => props.api.getDashboard(projectRoot, {
    operation: "assets" as const,
    assetIds: chunk,
    limit: 6,
  })));
  if (!pinnedAssetController.isCurrent(token, requestKey) || projectRoot !== props.projectRoot) return;
  const pages = results.filter((result): result is StudioDashboardAssetsPage => result.operation === "assets");
  const first = pages[0];
  if (!first) return;
  const itemsById = new Map(pages.flatMap((page) => page.page.items).map((asset) => [asset.id, asset] as const));
  const missingAssetIds = assetIds.filter((assetId) => !itemsById.has(assetId));
  pinnedAssetsPage.value = {
    ...first,
    page: { items: assetIds.map((assetId) => itemsById.get(assetId)).filter((asset): asset is StudioDashboardAssetSummary => Boolean(asset)), limit: assetIds.length },
    requestedAssetIds: [...assetIds],
    missingAssetIds,
  };
  if (missingAssetIds.length) {
    const removed = new Set(missingAssetIds.map((assetId) => `asset:${assetId}`));
    pinnedNodeIds.value = pinnedNodeIds.value.filter((nodeId) => !removed.has(nodeId));
    pruneDraftEdgesForRemovedNodes(removed);
    scheduleLayoutPersist();
  }
  if (shouldRebuild) rebuildGraph();
}

async function loadPinnedUnit(): Promise<void> {
  const nodeId = pinnedNodeIds.value.find((candidate) => candidate.startsWith("unit:"));
  if (!nodeId) return;
  const unitId = nodeId.slice("unit:".length);
  const result = await loadUnitDetailById(unitId, undefined, { focus: false, select: false });
  // 请求被更新的 unit stream 取消时不得把固定 ID 当成“已删除”。
  if (!result) rebuildGraph();
}

const externalDropActive = ref(false);
const externalDropDepth = ref(0);
const externalImportBusy = ref(false);

function isExternalMediaFilePath(filePath: string): boolean {
  const ext = filePath.includes(".") ? `.${filePath.split(".").pop()!.toLowerCase()}` : "";
  return EXTERNAL_MEDIA_EXTENSIONS.has(ext);
}

function onExternalDragEnter(event: DragEvent): void {
  if (!event.dataTransfer?.types?.includes("Files")) return;
  externalDropDepth.value += 1;
  externalDropActive.value = true;
  event.dataTransfer.dropEffect = "copy";
}

function onExternalDragOver(event: DragEvent): void {
  const types = event.dataTransfer?.types ?? [];
  const fromLibrary = Array.from(types).includes(LIBRARY_NODE_MIME);
  const fromFiles = Array.from(types).includes("Files");
  if (!fromLibrary && !fromFiles) return;
  externalDropActive.value = true;
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
}

function onExternalDragLeave(event: DragEvent): void {
  // relatedTarget 在离开 shell 时为 null 或 shell 外；用 depth 抗闪烁
  externalDropDepth.value = Math.max(0, externalDropDepth.value - 1);
  if (externalDropDepth.value === 0) externalDropActive.value = false;
  void event;
}

async function onExternalDrop(event: DragEvent): Promise<void> {
  externalDropDepth.value = 0;
  externalDropActive.value = false;
  const libraryNodeId = event.dataTransfer?.getData(LIBRARY_NODE_MIME)?.trim();
  if (libraryNodeId) {
    await dropLibraryNodeAt(event, libraryNodeId);
    return;
  }
  if (externalImportBusy.value) return;
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (!files.length) return;
  const paths: string[] = [];
  for (const file of files) {
    try {
      const absolute = window.canvasApi.getPathForFile(file);
      if (absolute && isExternalMediaFilePath(absolute)) paths.push(absolute);
    } catch {
      /* 非本机路径忽略 */
    }
  }
  if (!paths.length) {
    errorMessage.value = "只能拖入图片、视频或音频文件（png/jpg/mp4/mov/mp3/wav 等）。";
    return;
  }
  externalImportBusy.value = true;
  errorMessage.value = "";
  const projectRoot = props.projectRoot;
  const scope = {
    token: externalImportActionGate.begin(projectRoot, "external-media-import"),
    projectRoot,
    actionId: "external-media-import",
  };
  try {
    let imported = 0;
    for (const sourcePath of paths) {
      const envelope = await createStudioCommandEnvelope({
        command: "import_studio_media",
        payload: { sourcePath },
      });
      if (!canvasUiActionIsCurrent(externalImportActionGate, scope)) return;
      await window.canvasApi.executeStudioCommand(
        projectRoot,
        envelope,
      );
      if (!canvasUiActionIsCurrent(externalImportActionGate, scope)) return;
      imported += 1;
    }
    await refreshAll();
    if (!canvasUiActionIsCurrent(externalImportActionGate, scope)) return;
    void imported;
  } catch (error) {
    if (!canvasUiActionIsCurrent(externalImportActionGate, scope)) return;
    errorMessage.value = message(error);
    emit("failed", errorMessage.value);
  } finally {
    if (canvasUiActionIsCurrent(externalImportActionGate, scope)) {
      externalImportBusy.value = false;
    }
  }
}

/** T15: 刷新单元级写租约显示（画布顶部显示谁在写哪个单元）。 */
async function refreshUnitLeaseDisplay(): Promise<void> {
  const projectRoot = props.projectRoot;
  const requestSequence = refreshSequence;
  const isCurrent = () => projectRoot === props.projectRoot && requestSequence === refreshSequence;
  try {
    const api = (window as any).canvasApi;
    if (!api?.getStudioUnitWriteLeases) {
      if (isCurrent()) unitLeaseDisplayHint.value = null;
      return;
    }
    const projection = await api.getStudioUnitWriteLeases(projectRoot);
    if (projectRoot !== props.projectRoot || requestSequence !== refreshSequence) return;
    unitLeaseDisplayHint.value = projection.displayHint;
  } catch {
    if (isCurrent()) unitLeaseDisplayHint.value = null;
  }
}

/** T14: 加载生产诊断（真实状态，禁止“宫格数×3”推算）。 */
async function refreshProductionDiagnostics(): Promise<void> {
  const projectRoot = props.projectRoot;
  const requestSequence = refreshSequence;
  const isCurrent = () => projectRoot === props.projectRoot && requestSequence === refreshSequence;
  try {
    const api = (window as any).canvasApi;
    if (!api?.getStudioProductionDiagnostics) {
      if (isCurrent()) productionDiagnostics.value = null;
      return;
    }
    const diagnostics = await api.getStudioProductionDiagnostics(projectRoot);
    if (projectRoot !== props.projectRoot || requestSequence !== refreshSequence) return;
    productionDiagnostics.value = diagnostics;
  } catch {
    if (isCurrent()) productionDiagnostics.value = null;
  }
}

/** 写门禁决定业务是否可读写；完整 build identity 只用于界面诊断，不得阻塞首卡。 */
async function refreshRuntimeWriteGate(): Promise<void> {
  const api = (window as any).canvasApi;
  runtimeWriteGateState.value = "checking";
  if (!api?.getRuntimeBuildIdentity || typeof api.getRuntimeWriteGate !== "function") {
    runtimeBuildIdentity.value = null;
    runtimeWriteGate.value = null;
    runtimeWriteGateState.value = "unavailable";
    return;
  }
  try {
    const gate = await api.getRuntimeWriteGate();
    runtimeWriteGate.value = gate
      ? {
        allowed: gate.allowed === true,
        restartRequired: gate.restartRequired === true,
        ...(typeof gate.bootSourceDigest === "string" ? { bootSourceDigest: gate.bootSourceDigest } : {}),
        ...(typeof gate.artifactSourceDigest === "string" ? { artifactSourceDigest: gate.artifactSourceDigest } : {}),
        ...(typeof gate.currentSourceDigest === "string" ? { currentSourceDigest: gate.currentSourceDigest } : {}),
        ...(Array.isArray(gate.reasons) ? { reasons: gate.reasons.map(String) } : {}),
      }
      : null;
    runtimeWriteGateState.value = runtimeWriteGate.value?.allowed === true ? "allowed" : "blocked";
  } catch {
    runtimeWriteGate.value = null;
    runtimeWriteGateState.value = "unavailable";
  }
}

/** 首屏链收敛后再补完整构建身份；迟到结果不得回填到已切换的工程。 */
async function refreshRuntimeBuildIdentityDisplay(
  projectRoot = props.projectRoot,
  requestSequence = refreshSequence,
): Promise<void> {
  const api = (window as any).canvasApi;
  const identitySequence = ++runtimeBuildIdentitySequence;
  const isCurrent = () => (
    !canvasDisposed
    && projectRoot === props.projectRoot
    && requestSequence === refreshSequence
    && identitySequence === runtimeBuildIdentitySequence
  );
  if (typeof api?.getRuntimeBuildIdentity !== "function") {
    if (isCurrent()) runtimeBuildIdentity.value = null;
    return;
  }
  try {
    markT23RendererStartup("canvas-build-identity-start");
    const identity = await api.getRuntimeBuildIdentity();
    if (!isCurrent()) return;
    runtimeBuildIdentity.value = identity
      ? {
        packageVersion: String(identity.packageVersion ?? ""),
        buildId: String(identity.buildId ?? ""),
        sourceDigest: String(identity.sourceDigest ?? ""),
        fingerprint: String(identity.fingerprint ?? ""),
      }
      : null;
    markT23RendererStartup("canvas-build-identity-ready");
  } catch {
    if (isCurrent()) runtimeBuildIdentity.value = null;
  }
}

async function refreshLocalProductionPreview(
  projectRoot = props.projectRoot,
  requestSequence = refreshSequence,
): Promise<void> {
  const api = window.canvasApi;
  if (typeof api.getLocalCreativeProjectIngestStatus !== "function") {
    if (projectRoot === props.projectRoot && requestSequence === refreshSequence) {
      localProductionPreview.value = null;
      localCreativeIngestStatus.value = null;
      localProductionPreviewLoading.value = false;
    }
    return;
  }
  try {
    const statusResult = await api.getLocalCreativeProjectIngestStatus(
      projectRoot,
      { refreshSource: false, limit: 1 },
    );
    if (projectRoot !== props.projectRoot || requestSequence !== refreshSequence) return;
    localCreativeIngestStatus.value = statusResult;
    // 普通刷新只读受管侧车，不遍历/哈希外部来源。旧的完整预览不能跨刷新继续解锁物化。
    localProductionPreview.value = null;
  } catch {
    // 普通受管工程没有本机来源清单是正常状态，不把“不适用”升级成整页错误。
    if (projectRoot === props.projectRoot && requestSequence === refreshSequence) {
      localProductionPreview.value = null;
      localCreativeIngestStatus.value = null;
    }
  }
}

async function verifyLocalProductionSource(): Promise<void> {
  const api = window.canvasApi;
  if (typeof api.previewLocalCreativeProductionUnits !== "function"
    || typeof api.getLocalCreativeProjectIngestStatus !== "function") return;
  const projectRoot = props.projectRoot;
  const requestSequence = refreshSequence;
  const verificationSequence = ++localSourceVerificationSequence;
  const isCurrent = () => (
    projectRoot === props.projectRoot
    && requestSequence === refreshSequence
    && verificationSequence === localSourceVerificationSequence
  );
  localProductionPreviewLoading.value = true;
  try {
    const [statusResult, previewResult] = await Promise.allSettled([
      api.getLocalCreativeProjectIngestStatus(projectRoot, { refreshSource: true, limit: 1 }),
      api.previewLocalCreativeProductionUnits(projectRoot),
    ]);
    if (projectRoot !== props.projectRoot || requestSequence !== refreshSequence || !isCurrent()) return;
    localCreativeIngestStatus.value = statusResult.status === "fulfilled" ? statusResult.value : null;
    localProductionPreview.value = previewResult.status === "fulfilled" ? previewResult.value : null;
  } catch {
    if (isCurrent()) {
      localProductionPreview.value = null;
      localCreativeIngestStatus.value = null;
    }
  } finally {
    if (isCurrent()) localProductionPreviewLoading.value = false;
  }
}

async function refreshAll(): Promise<void> {
  if (canvasDisposed) return;
  const projectRoot = props.projectRoot;
  const requestSequence = ++refreshSequence;
  const isCurrent = () => !canvasDisposed
    && projectRoot === props.projectRoot
    && requestSequence === refreshSequence;
  cancelInitialUnitCardObserver();
  loading.value = true;
  errorMessage.value = "";
  markT23RendererStartup("canvas-refresh-start");
  try {
    // 运行时身份诊断是唯一允许绕过写闸门的只读通道，必须先于 overview、资产、
    // 文稿、单元和布局 IPC。若源码/工件已经漂移，先请求业务 IPC 会被 Core 拒绝，
    // 并让 UI 永久停在 checking，用户反而看不到真正的重启/不可用诊断。
    markT23RendererStartup("canvas-runtime-gate-start");
    await refreshRuntimeWriteGate();
    if (!isCurrent() || runtimeWriteGateState.value !== "allowed") return;
    markT23RendererStartup("canvas-runtime-gate-ready");
    // 布局视图读取与只读生产清单互不依赖；并行后单元卡可先落首屏，布局完成时
    // 再按持久坐标重建。写闸仍已在二者之前明确 allowed，未放宽业务入口门禁。
    const layoutHydration = (async () => {
      markT23RendererStartup("canvas-layout-start");
      // 先把拖拽、连线和固定节点的 debounce 状态写完，再从磁盘重新读取。
      await flushPendingLayout(projectRoot);
      if (!isCurrent()) return false;
      const hydrated = await hydrateLayoutFromDisk(projectRoot);
      if (hydrated && isCurrent() && unitsPage.value) rebuildGraph();
      if (isCurrent()) markT23RendererStartup("canvas-layout-ready");
      return hydrated;
    })();
    // Main/Core 的 SQLite 读取包含同步区段：即使 Renderer Promise.all，较早发起的
    // overview/资产/文稿仍会让首张单元卡排队。先发单元列表、再发 overview，既让
    // 首卡最早落地，也保留“overview/checkpoint 完成后才启动 raw 深核验”的安全顺序。
    const waitForInitialCard = unitsPage.value === null;
    if (waitForInitialCard) armInitialUnitCardObserver(projectRoot, requestSequence);
    const unitsRead = (async () => {
      markT23RendererStartup("canvas-units-start");
      const units = await loadUnitsPage({ deferTimelineProjections: true });
      if (!isCurrent()) return units;
      markT23RendererStartup("canvas-units-ready");
      return units;
    })();
    const initialUnits = await unitsRead;
    if (!isCurrent()) return;
    const initialUnitCardObserved = waitForInitialCard
      ? await waitForInitialUnitCardDom(
        projectRoot,
        requestSequence,
        initialUnits.map((unit) => unit.id),
      )
      : false;
    if (!isCurrent()) return;

    // first-card 已进 DOM 后、任何 overview IPC 之前冻结 mutation 指标；该值逐层
    // 传到 App，T23 不再在事后读取被 overview 污染的摘要。
    const startupMutationChecks = initialUnitCardObserved
      ? await captureT23FirstCardMutationChecks()
      : undefined;
    if (!isCurrent()) return;
    if (initialUnitCardObserved) {
      emit("initialUnitCardsCommitted", {
        projectRoot,
        refreshSequence: requestSequence,
        unitCount: initialUnits.length,
        ...(startupMutationChecks === undefined ? {} : { startupMutationChecks }),
      });
    }
    markT23RendererStartup("canvas-dashboard-overview-start");
    const overviewRead = loadOverview();
    await overviewRead;
    if (!isCurrent()) return;
    markT23RendererStartup("canvas-dashboard-overview-ready");
    if (waitForInitialCard && !initialUnitCardObserved) {
      cancelInitialUnitCardObserver();
      emit("initialUnitCardsCommitted", {
        projectRoot,
        refreshSequence: requestSequence,
        unitCount: initialUnits.length,
      });
    }
    markT23RendererStartup("canvas-units-overview-ready");
    markT23RendererStartup("canvas-raw-activation-start");
    void activateUnitTimelineProjections(initialUnits);
    // 资产、文稿与布局不是首卡/raw 的输入，移到深核验启动之后并行补齐；它们仍在
    // refreshAll 结束前收敛，失败/切工程 gate 与原来一致。
    const [layoutHydrated] = await Promise.all([
      layoutHydration,
      loadAssets(),
      loadTextDocuments(),
    ]);
    if (!isCurrent()) return;
    // 布局属于视图层；读取失败保留默认坐标并继续生产投影，不把视图故障冒充业务阻塞。
    if (!layoutHydrated && !errorMessage.value) errorMessage.value = "布局读取未完成，当前使用默认坐标。";
    await loadPinnedAssets();
    if (!isCurrent()) return;
    await loadPinnedTextDocuments();
    if (!isCurrent()) return;
    await loadPinnedMedia({ rebuild: false });
    if (!isCurrent()) return;
    await loadPinnedUnit();
    if (!isCurrent()) return;
    // T12: loadUnits 已按当前页面唯一季集刷新批量投影；多季集混排不猜测。
    // T15: 刷新单元级写租约显示
    void refreshUnitLeaseDisplay();
    // T14: 加载生产诊断（真实计数）
    void refreshProductionDiagnostics();
    // 来源预览只读但可能遍历较大目录，首屏完成后后台核对，不阻塞画布可用性。
    void refreshLocalProductionPreview(projectRoot, requestSequence);
    rebuildGraph();
    await nextTick();
    await applyInitialTimelineLayoutIfNeeded(projectRoot);
  } catch (error) {
    if (isCurrent()) {
      cancelInitialUnitCardObserver();
      errorMessage.value = message(error);
      emit("failed", errorMessage.value);
    }
  } finally {
    if (isCurrent()) {
      loading.value = false;
      // 完整源码 digest 仅用于展示。等首屏、raw 启动及必要只读补齐后再计算，
      // 避免与 units/冻结包在 Main/Core 上争用；写门禁已经在入口前单独通过。
      void refreshRuntimeBuildIdentityDisplay(projectRoot, requestSequence);
    }
  }
}

async function resetUnits(): Promise<void> {
  unitCursor.value = undefined;
  unitCursorStack.value = [];
  if (seasonFilter.value && episodeFilter.value && !filteredEpisodes.value.some((episode) => episode.id === episodeFilter.value)) episodeFilter.value = "";
  await guarded("units", () => loadUnits());
}

async function resetAssets(): Promise<void> {
  assetCursor.value = undefined;
  assetCursorStack.value = [];
  await guarded("assets", () => loadAssets());
}

async function resetMedia(): Promise<void> {
  mediaCursor.value = undefined;
  mediaCursorStack.value = [];
  await guarded("media", ({ projectRoot }) => loadMediaPage(projectRoot));
}

async function guarded(
  lane: string,
  operation: (scope: FrozenCanvasUiActionScope) => Promise<void>,
): Promise<void> {
  const projectRoot = props.projectRoot;
  const scope: FrozenCanvasUiActionScope = {
    token: guardedActionGate.begin(projectRoot, lane),
    projectRoot,
    actionId: lane,
  };
  loading.value = true;
  errorMessage.value = "";
  try {
    await operation(scope);
  } catch (error) {
    if (!canvasUiActionIsCurrent(guardedActionGate, scope)) return;
    errorMessage.value = message(error);
    emit("failed", errorMessage.value);
  } finally {
    if (canvasUiActionIsCurrent(guardedActionGate, scope)) loading.value = false;
  }
}

async function unitsNext(): Promise<void> {
  const next = unitsPage.value?.page.nextCursor;
  if (!next) return;
  unitCursorStack.value.push(unitCursor.value ?? "");
  unitCursor.value = next;
  await guarded("units", () => loadUnits());
}
async function unitsPrevious(): Promise<void> {
  const previous = unitCursorStack.value.pop();
  if (previous === undefined) return;
  unitCursor.value = previous || undefined;
  await guarded("units", () => loadUnits());
}
async function assetsNext(): Promise<void> {
  const next = assetsPage.value?.page.nextCursor;
  if (!next) return;
  assetCursorStack.value.push(assetCursor.value ?? "");
  assetCursor.value = next;
  await guarded("assets", () => loadAssets());
}
async function assetsPrevious(): Promise<void> {
  const previous = assetCursorStack.value.pop();
  if (previous === undefined) return;
  assetCursor.value = previous || undefined;
  await guarded("assets", () => loadAssets());
}

async function mediaNext(): Promise<void> {
  const next = mediaPage.value?.nextCursor;
  if (!next) return;
  mediaCursorStack.value.push(mediaCursor.value ?? "");
  mediaCursor.value = next;
  await guarded("media", ({ projectRoot }) => loadMediaPage(projectRoot));
}

async function mediaPrevious(): Promise<void> {
  const previous = mediaCursorStack.value.pop();
  if (previous === undefined) return;
  mediaCursor.value = previous || undefined;
  await guarded("media", ({ projectRoot }) => loadMediaPage(projectRoot));
}

async function loadAppearances(assetId: string, projectRoot = props.projectRoot): Promise<void> {
  const query = {
    operation: "appearances" as const,
    assetId,
    ...(appearanceCursor.value ? { cursor: appearanceCursor.value } : {}),
    limit: 36,
  };
  const token = controller.begin(projectRoot, query);
  const result = await props.api.getDashboard(projectRoot, query);
  if (projectRoot !== props.projectRoot || !controller.isCurrent(token, query)) return;
  if (result.operation === "appearances") appearancesPage.value = result;
  rebuildGraph();
}

async function appearancesNext(): Promise<void> {
  const assetId = selection.value?.kind === "asset" ? selection.value.asset.id : undefined;
  const next = appearancesPage.value?.page.nextCursor;
  if (!assetId || !next) return;
  appearanceCursorStack.value.push(appearanceCursor.value ?? "");
  appearanceCursor.value = next;
  await guarded(`appearances:${assetId}`, ({ projectRoot }) => loadAppearances(assetId, projectRoot));
}

async function appearancesPrevious(): Promise<void> {
  const assetId = selection.value?.kind === "asset" ? selection.value.asset.id : undefined;
  const previous = appearanceCursorStack.value.pop();
  if (!assetId || previous === undefined) return;
  appearanceCursor.value = previous || undefined;
  await guarded(`appearances:${assetId}`, ({ projectRoot }) => loadAppearances(assetId, projectRoot));
}

async function selectAsset(asset: StudioDashboardAssetSummary): Promise<void> {
  selection.value = { kind: "asset", asset };
  appearanceCursor.value = undefined;
  appearanceCursorStack.value = [];
  await guarded(`appearances:${asset.id}`, ({ projectRoot }) => loadAppearances(asset.id, projectRoot));
}

async function selectAssetById(assetId: string): Promise<void> {
  const known = pinnedAssetsPage.value?.page.items.find((entry) => entry.id === assetId)
    ?? assetsPage.value?.page.items.find((entry) => entry.id === assetId);
  if (known) {
    await selectAsset(known);
    return;
  }
  await guarded(`asset-detail:${assetId}`, async (scope) => {
    const result = await props.api.getDashboard(scope.projectRoot, {
      operation: "assets",
      assetIds: [assetId],
      limit: 1,
    });
    if (!canvasUiActionIsCurrent(guardedActionGate, scope)) return;
    if (result.operation !== "assets" || !result.page.items[0]) throw new Error(`资产已不存在：${assetId}`);
    selection.value = { kind: "asset", asset: result.page.items[0] };
    appearanceCursor.value = undefined;
    appearanceCursorStack.value = [];
    await loadAppearances(assetId, scope.projectRoot);
  });
}

async function applyUnitDetail(
  result: StudioDashboardUnitDetail,
  panelId?: string,
  options: { focus?: boolean; select?: boolean } = {},
  request: { projectRoot: string; sequence: number } = { projectRoot: props.projectRoot, sequence: unitDetailLoadSequence },
): Promise<boolean> {
  if (request.projectRoot !== props.projectRoot || request.sequence !== unitDetailLoadSequence) return false;
  unitDetail.value = result;
  panelPipeline.value = new Map();
  if (!await loadPanelPipeline(request.projectRoot, result.unit.id, result.panels, request.sequence)) return false;
  if (request.projectRoot !== props.projectRoot || request.sequence !== unitDetailLoadSequence || unitDetail.value?.unit.id !== result.unit.id) return false;
  if (options.select !== false) {
    const panel = panelId ? result.panels.find((entry) => entry.id === panelId) : undefined;
    selection.value = panel ? { kind: "panel", panel } : { kind: "unit", unit: result.unit };
  }
  // 只为从未布局的节点填充默认几何；已持久化或当前会话的拖拽坐标永不覆盖。
  try {
    const { buildStudioCanvasPipelineGraph } = await import("@core/studio-canvas-pipeline-graph");
    const graph = buildStudioCanvasPipelineGraph({
      unitId: result.unit.id,
      label: result.unit.label,
      panels: result.panels.map((panel) => ({
        panelId: panel.id,
        ordinal: panel.ordinal,
        label: panel.label,
        startSeconds: panel.startSeconds,
        endSeconds: panel.endSeconds,
        status: panel.status,
      })),
    }, {
      originX: 680,
      originY: 80,
      rowGap: 220,
      colGap: 220,
    });
    const sessionNodeIds = new Set(nodes.value.map((node) => node.id));
    const layoutPatch: Record<string, { x: number; y: number }> = {};
    for (const node of graph.nodes) {
      if (persistedLayoutNodes.value[node.id] || sessionNodeIds.has(node.id)) continue;
      layoutPatch[node.id] = node.position;
    }
    if (Object.keys(layoutPatch).length) {
      persistedLayoutNodes.value = { ...persistedLayoutNodes.value, ...layoutPatch };
    }
  } catch {
    /* 非法宫格数时保持默认构图 */
  }
  rebuildGraph();
  if (options.focus === false) return true;
  const focusPanelId = panelId ?? result.panels[0]?.id;
  const focusNode = focusPanelId
    ? nodes.value.find((node) => node.id === `media:labeled:${focusPanelId}`)
    : undefined;
  if (focusNode) {
    await nextTick();
    await studioFlow.setCenter(focusNode.position.x + 86, focusNode.position.y + 58, {
      zoom: Math.max(zoom.value, 0.62),
      duration: 180,
    });
  }
  return true;
}

async function loadUnitDetailById(
  unitId: string,
  panelId?: string,
  options: { focus?: boolean; select?: boolean } = {},
): Promise<StudioDashboardUnitDetail | null> {
  const projectRoot = props.projectRoot;
  const requestSequence = ++unitDetailLoadSequence;
  const query = { operation: "unit" as const, unitId, ...(panelId ? { panelId } : {}) };
  const token = controller.begin(projectRoot, query);
  const result = await props.api.getDashboard(projectRoot, query);
  if (!controller.isCurrent(token, query)
    || result.operation !== "unit"
    || projectRoot !== props.projectRoot
    || requestSequence !== unitDetailLoadSequence) return null;
  if (!await applyUnitDetail(result, panelId, options, { projectRoot, sequence: requestSequence })) return null;
  return result;
}

function invalidateQueuedUnitSelection(): void {
  queuedUnitSelection?.resolve();
  queuedUnitSelection = null;
  latestUnitSelectionKey = null;
}

async function drainLatestUnitSelection(): Promise<void> {
  while (queuedUnitSelection && !canvasDisposed) {
    const current = queuedUnitSelection;
    queuedUnitSelection = null;
    if (current.projectRoot !== props.projectRoot) {
      current.resolve();
      continue;
    }
    try {
      await guarded("unit-detail", async () => {
        await loadUnitDetailById(current.unit.id, current.panelId);
      });
    } finally {
      current.resolve();
    }
  }
}

/**
 * 单元点击只允许“当前在途 + 最新待处理”两项。
 *
 * 旧实现把 unitId 拼进 guarded lane，快速点十个单元会并发十组 Dashboard /
 * ProjectionBundle IPC；虽能丢弃迟到结果，却会把主进程峰值推到 9。这里在点击
 * 当帧更新上下文，同时串行读取并覆盖尚未启动的中间选择。
 */
function enqueueLatestUnitSelection(
  unit: StudioDashboardUnitSummary,
  panelId?: string,
): Promise<void> {
  const requestKey = `${props.projectRoot}\u0000${unit.id}\u0000${panelId ?? ""}`;
  // 节点点击会立即打开动作面板；用户紧接着点“展开宫格”时，两个动作可能
  // 在同一次详情请求完成前重叠。同根、同单元、同宫格直接共用当前 drain，
  // 避免串行重复 Dashboard + ProjectionBundle。
  if (unitSelectionDrain && latestUnitSelectionKey === requestKey) return unitSelectionDrain;
  latestUnitSelectionKey = requestKey;
  selection.value = { kind: "unit", unit };
  unitDetailLoadSequence += 1;
  panelPipelineLoadSequence += 1;
  controller.invalidateStream("unit");
  guardedActionGate.begin(props.projectRoot, "unit-detail");
  currentProductionBundle.value = null;
  unitDetail.value = null;
  panelPipeline.value = new Map();
  rebuildGraph();
  return new Promise<void>((resolve) => {
    queuedUnitSelection?.resolve();
    queuedUnitSelection = {
      projectRoot: props.projectRoot,
      unit,
      ...(panelId ? { panelId } : {}),
      resolve,
    };
    if (!unitSelectionDrain) {
      unitSelectionDrain = drainLatestUnitSelection().finally(() => {
        unitSelectionDrain = null;
        latestUnitSelectionKey = null;
      });
    }
  });
}

async function selectUnit(unit: StudioDashboardUnitSummary, panelId?: string): Promise<void> {
  await enqueueLatestUnitSelection(unit, panelId);
}

async function selectUnitById(unitId: string, panelId?: string): Promise<void> {
  const known = unitDetail.value?.unit.id === unitId
    ? unitDetail.value.unit
    : unitsPage.value?.page.items.find((entry) => entry.id === unitId);
  if (known) {
    await selectUnit(known, panelId);
    return;
  }
  await guarded("unit-detail", async () => {
    const result = await loadUnitDetailById(unitId, panelId);
    if (!result) throw new Error(`15 秒单元已不存在：${unitId}`);
  });
}

async function focusAppearance(unitId: string, panelId: string): Promise<void> {
  if (workspaceMode.value === "workflow") {
    const previousUnitIds = pinnedNodeIds.value.filter((nodeId) => nodeId.startsWith("unit:"));
    if (!previousUnitIds.includes(`unit:${unitId}`)) {
      draftCanvasEdges.value = [];
      selectedDraftEdgeId.value = "";
    }
    pinnedNodeIds.value = [
      ...pinnedNodeIds.value.filter((nodeId) => !nodeId.startsWith("unit:")),
      `unit:${unitId}`,
    ];
    scheduleLayoutPersist();
  }
  await guarded("unit-detail", async () => {
    const result = await loadUnitDetailById(unitId, panelId);
    if (!result) throw new Error(`15 秒单元已不存在：${unitId}`);
  });
}

function openPanelReview(panelId: string): void {
  const unitId = unitDetail.value?.unit.id;
  const panel = unitDetail.value?.panels.find((entry) => entry.id === panelId);
  if (!unitId || !panel) return;
  const pipeline = panelPipeline.value.get(panelId);
  emit("openReview", {
    token: Date.now(),
    unitId,
    unitRevision: selectedUnitRevision.value,
    panelId,
    startMilliseconds: Math.round(panel.startSeconds * 1000),
    endMilliseconds: Math.round(panel.endSeconds * 1000),
    assetIds: panel.assetIds.slice(0, 6),
    ...(pipeline?.generationRunId ? { generationRunId: pipeline.generationRunId } : {}),
    ...(pipeline?.packId ? { packId: pipeline.packId } : {}),
    ...(pipeline?.raw?.resultId ? { rawResultId: pipeline.raw.resultId } : {}),
    ...(pipeline?.raw ? { rawSha256: pipeline.raw.mediaSha256 } : {}),
    ...(pipeline?.labeled?.resultId ? { labeledResultId: pipeline.labeled.resultId } : {}),
    ...(pipeline?.labeled ? { labeledSha256: pipeline.labeled.mediaSha256 } : {}),
  });
}

/**
 * 整板末格的连续性节点不是另一套数据源：它只把画布已经投影的冻结资产和
 * 最后一格时间范围送回既有连续性复核 owner。UNKNOWN 仍须在那里由人工补全，
 * 不能在画布里猜测角色站位、朝向或道具状态。
 */
async function openUnitGridContinuityReview(
  unitId: string,
  panelId: string,
  assetIds: readonly string[],
): Promise<void> {
  await guarded(`unit-continuity:${unitId}`, async () => {
    const detail = await loadUnitDetailById(unitId, panelId);
    if (!detail) throw new Error(`15 秒单元已不存在：${unitId}`);
    const panel = detail.panels.find((entry) => entry.id === panelId) ?? detail.panels.at(-1);
    if (!panel) throw new Error(`${unitId} 缺少末格，无法进入连续性复核。`);
    const raw = unitGridRawPipeline.value.get(unitId);
    emit("openReview", {
      token: Date.now(),
      unitId,
      unitRevision: selectedUnitRevision.value,
      panelId: panel.id,
      startMilliseconds: Math.round(panel.startSeconds * 1000),
      endMilliseconds: Math.round(panel.endSeconds * 1000),
      assetIds: [...new Set(assetIds.length ? assetIds : panel.assetIds)].slice(0, 6),
      ...(raw?.generationRunId ? { generationRunId: raw.generationRunId } : {}),
      ...(raw?.packId ? { packId: raw.packId } : {}),
      generationTarget: { targetKind: "unit-grid", targetKey: `unit-grid:${unitId}` },
    });
  });
}

function onNodeClick(event: NodeMouseEvent): void {
  const kind = event.node.data?.kind;
  const id = String(event.node.data?.id ?? "");
  if (kind === "asset" || kind === "unit" || kind === "panel") actionPanelOpen.value = true;
  if (connectMode.value && (kind === "asset" || kind === "script" || kind === "prompt")) {
    pendingConnectionSourceId.value = event.node.id;
    errorMessage.value = "";
    rebuildGraph();
  } else if (connectMode.value && kind === "panel" && pendingConnectionSourceId.value) {
    onConnect({
      source: pendingConnectionSourceId.value,
      target: event.node.id,
      sourceHandle: null,
      targetHandle: null,
    });
  }
  if (kind === "asset") {
    void selectAssetById(id);
  } else if (kind === "reference") {
    const unitId = String(event.node.data?.unitId ?? "");
    if (unitId) void selectUnitById(unitId);
  } else if (kind === "continuity") {
    const unitId = String(event.node.data?.unitId ?? "");
    if (unitId) void selectUnitById(unitId, id);
  } else if (kind === "unit") {
    void selectUnitById(id);
  } else if (kind === "panel") {
    const panel = unitDetail.value?.panels.find((entry) => entry.id === id);
    if (panel) {
      selection.value = { kind: "panel", panel };
      actionPanelOpen.value = true;
    }
  } else if (kind === "script" || kind === "prompt") {
    const doc = textDocuments.value.find((entry) => entry.id === id && entry.kind === kind);
    if (doc) selection.value = { kind, doc };
  } else if (kind === "raw" || kind === "labeled" || kind === "review") {
    const unitId = String(event.node.data?.unitId ?? "");
    if (unitId) void selectUnitById(unitId);
    else openPanelReview(id);
  }
}

function onNodeDoubleClick(event: NodeMouseEvent): void {
  const kind = event.node.data?.kind;
  const id = String(event.node.data?.id ?? "");
  if (kind === "unit") {
    emit("openDashboard", { unitId: id, fromMode: "canvas" });
  } else if (kind === "reference") {
    const unitId = String(event.node.data?.unitId ?? "");
    if (unitId) emit("openDashboard", { unitId, fromMode: "canvas" });
  } else if (kind === "continuity") {
    const unitId = String(event.node.data?.unitId ?? "");
    const candidateAssetIds: unknown[] = Array.isArray(event.node.data?.assetIds)
      ? [...event.node.data.assetIds]
      : [];
    const assetIds = candidateAssetIds.filter((entry): entry is string => typeof entry === "string");
    if (unitId) void openUnitGridContinuityReview(unitId, id, assetIds);
  } else if (kind === "panel") {
    const unitId = unitDetail.value?.unit.id;
    emit("openDashboard", {
      ...(unitId ? { unitId } : {}),
      panelId: id,
      fromMode: "canvas",
    });
  } else if (kind === "raw" || kind === "labeled" || kind === "review") {
    const unitId = String(event.node.data?.unitId ?? "");
    if (unitId) void selectUnitById(unitId);
    else openPanelReview(id);
  }
}

async function applyExternalFocus(): Promise<void> {
  const focus = props.focus;
  if (!focus?.unitId) return;
  const unit = unitsPage.value?.page.items.find((entry) => entry.id === focus.unitId)
    ?? {
      id: focus.unitId,
      label: focus.unitId,
      seasonId: "",
      episodeId: "",
      panelCount: 0,
      status: "unknown",
      durationSeconds: 15,
      locator: { unitId: focus.unitId },
      currentness: "unknown",
    } as unknown as StudioDashboardUnitSummary;
  await selectUnit(unit, focus.panelId);
}

function onMove(event: { flowTransform?: { x?: number; y?: number; zoom?: number }; zoom?: number }): void {
  const transform = event.flowTransform;
  if (transform?.zoom !== undefined) zoom.value = transform.zoom;
  else if (event.zoom !== undefined) zoom.value = event.zoom;
  if (transform?.x !== undefined && transform?.y !== undefined) {
    layoutViewport.value = {
      x: transform.x,
      y: transform.y,
      zoom: transform.zoom ?? zoom.value,
    };
  }
}

function onMoveEnd(event: { flowTransform?: { x?: number; y?: number; zoom?: number } }): void {
  onMove(event);
  scheduleLayoutPersist();
}

const MINIMAP_PAN_STEP = 48;

function panCanvasFromMiniMap(key: string): void {
  const viewport = studioFlow.getViewport();
  let { x, y } = viewport;
  if (key === "ArrowLeft") x += MINIMAP_PAN_STEP;
  else if (key === "ArrowRight") x -= MINIMAP_PAN_STEP;
  else if (key === "ArrowUp") y += MINIMAP_PAN_STEP;
  else if (key === "ArrowDown") y -= MINIMAP_PAN_STEP;
  else return;
  void studioFlow.setViewport({ x, y, zoom: viewport.zoom });
}

function miniMapNodeRects(): SVGRectElement[] {
  return Array.from(document.querySelectorAll<SVGRectElement>("[data-testid='managed-canvas-minimap'] .vue-flow__minimap-node"));
}

function syncMiniMapNodeTabIndex(active?: Element | null): void {
  const items = miniMapNodeRects();
  if (!items.length) return;
  const index = items.findIndex((el) => el === active || el.contains(active ?? null));
  const current = index >= 0 ? index : 0;
  items.forEach((el, i) => {
    el.tabIndex = i === current ? 0 : -1;
  });
}

function moveMiniMapNodeFocus(key: string): void {
  const items = miniMapNodeRects();
  if (!items.length) return;
  const active = document.activeElement;
  const index = items.findIndex((el) => el === active || el.contains(active));
  const current = index >= 0 ? index : 0;
  const next = nextRovingIndex(current, items.length, key);
  if (next == null) return;
  syncMiniMapNodeTabIndex(items[next]);
  items[next]?.focus();
}

function selectCanvasNodeFromMiniMap(target: EventTarget | null): void {
  const el = (target as Element | null)?.closest?.(".vue-flow__minimap-node");
  const nodeId = el?.getAttribute("data-node-id") ?? "";
  if (!nodeId) return;
  const node = nodes.value.find((entry) => entry.id === nodeId);
  if (!node) return;
  nodes.value = nodes.value.map((entry) => {
    const selected = entry.id === nodeId;
    return entry.selected === selected ? entry : { ...entry, selected };
  });
  selectionCount.value = 1;
  void studioFlow.setCenter(node.position.x + 86, node.position.y + 58, {
    zoom: Math.max(zoom.value, 0.7),
    duration: 180,
  });
}

function onControlViewportChanged(): void {
  // Controls 直接调用 store.zoomIn/zoomOut，部分版本不会向 VueFlow 转发 moveEnd。
  // 等内置过渡结束后从 store 读取真实视口并持久化，避免重启后缩放跳回旧值。
  if (controlViewportTimer !== undefined) window.clearTimeout(controlViewportTimer);
  const projectRoot = props.projectRoot;
  const sequence = ++controlViewportSequence;
  controlViewportTimer = window.setTimeout(() => {
    controlViewportTimer = undefined;
    if (canvasDisposed || projectRoot !== props.projectRoot || sequence !== controlViewportSequence) return;
    const viewport = studioFlow.getViewport();
    onMoveEnd({ flowTransform: viewport });
  }, 260);
}

const CANVAS_NODE_WIDTH = 188;
const ESTIMATED_NODE_HEIGHT = 200;

interface CanvasFlowNodeLike {
  id: string;
  position: { x: number; y: number };
  selected?: boolean;
  dimensions?: { width?: number; height?: number };
}

function geometryOf(node: CanvasFlowNodeLike): CanvasNodeGeometry {
  return {
    id: node.id,
    x: node.position.x,
    y: node.position.y,
    width: CANVAS_NODE_WIDTH,
    height: node.dimensions?.height && node.dimensions.height > 0 ? node.dimensions.height : ESTIMATED_NODE_HEIGHT,
  };
}

function selectedGeometries(): CanvasNodeGeometry[] {
  return nodes.value
    .filter((node) => (node as CanvasFlowNodeLike).selected)
    .map((node) => geometryOf(node as unknown as CanvasFlowNodeLike));
}

function currentPositionMap(): CanvasPositionMap {
  return Object.fromEntries(nodes.value.map((node) => [node.id, { x: node.position.x, y: node.position.y }]));
}

/** P23 写回钉死：shallowRef 数组整体替换（Vue Flow model watch 只看 identity+length，in-place 不重渲染）。 */
function applyPositionMap(changed: CanvasPositionMap): void {
  nodes.value = nodes.value.map((node) => changed[node.id]
    ? { ...node, position: { x: changed[node.id]!.x, y: changed[node.id]!.y } }
    : node);
  persistedLayoutNodes.value = { ...persistedLayoutNodes.value, ...changed };
  scheduleLayoutPersist();
}

function bumpUndoTick(): void {
  undoTick.value += 1;
}

function applyAlign(mode: CanvasAlignMode): void {
  if (isDragging.value) return;
  const selected = selectedGeometries();
  if (selected.length < 2) return;
  const before = Object.fromEntries(selected.map((item) => [item.id, { x: item.x, y: item.y }]));
  const changed = alignCanvasNodes(selected, mode);
  const anyAligned = Object.entries(changed).some(([id, position]) => {
    const origin = before[id];
    return !origin || Math.abs(origin.x - position.x) > 1e-6 || Math.abs(origin.y - position.y) > 1e-6;
  });
  if (!anyAligned) return;
  undoStack.push(before);
  bumpUndoTick();
  applyPositionMap(changed);
}

function selectAllCanvasNodes(): void {
  if (!nodes.value.length) return;
  if (nodes.value.every((node) => node.selected)) return;
  nodes.value = nodes.value.map((node) => (node.selected ? node : { ...node, selected: true }));
  selectionCount.value = nodes.value.length;
}

function invertCanvasSelection(): void {
  if (!nodes.value.length) return;
  nodes.value = nodes.value.map((node) => ({ ...node, selected: !node.selected }));
  selectionCount.value = nodes.value.filter((node) => node.selected).length;
}

function clearCanvasSelection(): void {
  if (!nodes.value.some((node) => node.selected)) return;
  nodes.value = nodes.value.map((node) => (node.selected ? { ...node, selected: false } : node));
  selectionCount.value = 0;
}

function nudgeSelectedCanvasNodes(dx: number, dy: number): void {
  if (isDragging.value || pinActionBusy.value) return;
  const selected = selectedGeometries();
  if (!selected.length) return;
  const before = Object.fromEntries(selected.map((item) => [item.id, { x: item.x, y: item.y }]));
  const changed: CanvasPositionMap = Object.fromEntries(
    selected.map((item) => [item.id, { x: item.x + dx, y: item.y + dy }]),
  );
  undoStack.push(before);
  bumpUndoTick();
  applyPositionMap(changed);
}

function applyDistribute(axis: "x" | "y"): void {
  if (isDragging.value) return;
  const selected = selectedGeometries();
  if (selected.length < 3) return;
  const before = Object.fromEntries(selected.map((item) => [item.id, { x: item.x, y: item.y }]));
  const changed = distributeCanvasNodes(selected, axis);
  const anyDistributed = Object.entries(changed).some(([id, position]) => {
    const origin = before[id];
    return !origin || Math.abs(origin.x - position.x) > 1e-6 || Math.abs(origin.y - position.y) > 1e-6;
  });
  if (!anyDistributed) return;
  undoStack.push(before);
  bumpUndoTick();
  applyPositionMap(changed);
}

function undoLayout(): void {
  const before = undoStack.undo(currentPositionMap());
  if (!before) return;
  bumpUndoTick();
  applyPositionMap(before);
}

function redoLayout(): void {
  const after = undoStack.redo(currentPositionMap());
  if (!after) return;
  bumpUndoTick();
  applyPositionMap(after);
}

function onNodeDragStart(event?: CanvasNodeDragPayload): void {
  isDragging.value = true;
  // R3 N1：快照以载荷 dragItems 精确集为准（Cmd/Ctrl toggle 手势下被拖节点不在实时选区内，
  // 按选区抓快照会漏掉它，undo 无法回退）；载荷缺省时回退实时选区。
  const draggedItemIds = event?.nodes?.length
    ? new Set(event.nodes.map((item) => (item as { id?: unknown }).id).filter((id): id is string => typeof id === "string"))
    : null;
  dragStartSnapshot = Object.fromEntries(nodes.value
    .filter((node) => draggedItemIds ? draggedItemIds.has(node.id) : (node as CanvasFlowNodeLike).selected)
    .map((node) => [node.id, { x: node.position.x, y: node.position.y }]));
}

function onNodeDrag(event: CanvasNodeDragPayload): void {
  pendingSnapEvent = event;
  if (snapRafId) return;
  snapRafId = window.requestAnimationFrame(() => {
    snapRafId = 0;
    const latest = pendingSnapEvent;
    pendingSnapEvent = null;
    if (latest) applySnap(latest);
  });
}

// P23 R3-F2/R2-F1：drag-stop/切工程/卸载必须取消挂起 rAF，否则迟到回调会复活参考线并在落盘后改写位置。
function cancelPendingSnap(): void {
  if (snapRafId) {
    cancelAnimationFrame(snapRafId);
    snapRafId = 0;
  }
  pendingSnapEvent = null;
}

/** 吸附：只改写事件载荷节点 position（禁改 dragItem.distance）；drag-end 不覆盖末帧吸附值。 */
function applySnap(event: CanvasNodeDragPayload): void {
  // 迟到 rAF 防线：拖拽已结束（stop/切工程/卸载）时不得复活参考线或改写位置。
  if (!isDragging.value) {
    snapLines.value = [];
    return;
  }
  const draggedNode = event.node;
  if (!draggedNode) {
    snapLines.value = [];
    return;
  }
  const selectedIds = new Set(nodes.value.filter((node) => (node as CanvasFlowNodeLike).selected).map((node) => node.id));
  // P23 R3-F1：成组拖动禁吸附——Vue Flow 每帧用拖拽开始时冻结的 distance 重算全部组员，
  // 吸附只改主节点会被下一帧覆盖，松手时错位还可能被落盘；组拖直接不出参考线。
  // R5-F1：判据以载荷 dragItems 计数为准——恰好 2 选中时 Cmd/Ctrl 拖已选节点会被库 toggle 取消选中，
  // 实时选区 size===1 但实际是 2 成员组拖，单靠 selectedIds 会被绕过。
  if ((event.nodes?.length ?? 0) > 1 || selectedIds.size > 1) {
    snapLines.value = [];
    return;
  }
  const dragged = geometryOf(draggedNode);
  // 候选=会话内已渲染（dimensions 存在；视口剔除只 unobserve 不重置 dimensions，规范 v2.2 附录口径）且未选中的节点；
  // 显式剔除被拖节点自身（Cmd/Ctrl toggle 手势下被拖节点可能不在选区内，防自候选零偏移伪命中）。
  const candidates = nodes.value
    .filter((node) => node.id !== draggedNode.id && !selectedIds.has(node.id) && (node as CanvasFlowNodeLike).dimensions?.height)
    .map((node) => geometryOf(node as unknown as CanvasFlowNodeLike));
  const zoom = Math.max(studioFlow.getViewport().zoom, 0.01);
  const result = computeCanvasSnap(dragged, candidates, 8 / zoom);
  if (result.dx !== 0 || result.dy !== 0) {
    draggedNode.position = { x: draggedNode.position.x + result.dx, y: draggedNode.position.y + result.dy };
  }
  if (gridSnapEnabled.value) {
    draggedNode.position = roundToCanvasGrid(draggedNode.position.x, draggedNode.position.y, CANVAS_GRID_SIZE);
  }
  snapLines.value = result.lines;
}

function snapGuideStyle(line: { axis: "x" | "y"; position: number }): Record<string, string> {
  const viewport = studioFlow.getViewport();
  const offset = line.position * viewport.zoom;
  return line.axis === "x"
    ? { left: `${offset + viewport.x}px`, top: "0", bottom: "0", width: "1px", position: "absolute" }
    : { top: `${offset + viewport.y}px`, left: "0", right: "0", height: "1px", position: "absolute" };
}

/** 拖拽会话收尾（dragStop 与 window blur 共用；F-01：窗外松手 d3-drag 收不到 mouseup 时防会话卡死）。 */
function finalizeDragSession(): void {
  isDragging.value = false;
  cancelPendingSnap();
  snapLines.value = [];
  // 仅当拖拽产生真实位移才把 drag-start 快照入 undo 栈（一次拖动一条记录）。
  if (dragStartSnapshot) {
    const moved = Object.entries(dragStartSnapshot).some(([id, position]) => {
      const node = nodes.value.find((item) => item.id === id);
      return node && (Math.abs(node.position.x - position.x) > 0.5 || Math.abs(node.position.y - position.y) > 0.5);
    });
    if (moved) {
      undoStack.push(dragStartSnapshot);
      bumpUndoTick();
    }
    dragStartSnapshot = null;
  }
  // 会话坐标已在 v-model:nodes 中；合并进持久化 map 并 debounce 写盘
  const collected = collectAbsoluteNodePositions();
  persistedLayoutNodes.value = { ...persistedLayoutNodes.value, ...collected };
  scheduleLayoutPersist();
  // 拖拽窗口内被顺延的投影重建（F-04：拖拽中置脏，收尾时补齐）。
  if (planStatusRebuildDirty) {
    planStatusRebuildDirty = false;
    rebuildGraph();
  }
}

function onNodeDragStop(): void {
  // F-02：先 flush 末帧吸附——末帧 pointermove 的 rAF 未执行就快速松手时，落点仍能吸附到参考线。
  if (pendingSnapEvent) {
    const finalEvent = pendingSnapEvent;
    pendingSnapEvent = null;
    applySnap(finalEvent);
  }
  finalizeDragSession();
}

function onWindowBlur(): void {
  spacePanHeld.value = false;
  if (!isDragging.value) return;
  finalizeDragSession();
}

function isSpaceKey(event: KeyboardEvent): boolean {
  return event.code === "Space" || event.key === " ";
}

function onCanvasKeyup(event: KeyboardEvent): void {
  if (!isSpaceKey(event)) return;
  spacePanHeld.value = false;
}

function onCanvasKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  const editable = target?.matches("input,textarea,select,[contenteditable='true']");
  if (
    target?.closest(".vue-flow__minimap-node")
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && !event.shiftKey
    && (event.key === "Enter" || isSpaceKey(event))
  ) {
    event.preventDefault();
    selectCanvasNodeFromMiniMap(target);
    return;
  }
  if (isSpaceKey(event)) {
    if (!editable) {
      event.preventDefault();
      spacePanHeld.value = true;
    }
    return;
  }
  // P23：⌘Z/⌘⇧Z/Ctrl+Y 布局 undo/redo；拖拽中（isDragging）忽略防快照时序缠绕。
  if ((event.metaKey || event.ctrlKey) && !editable && event.shiftKey && event.key.toLowerCase() === "a") {
    event.preventDefault();
    if (!isDragging.value) invertCanvasSelection();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && !editable && !event.shiftKey && event.key.toLowerCase() === "a") {
    event.preventDefault();
    if (!isDragging.value) selectAllCanvasNodes();
    return;
  }
  if (
    (event.metaKey || event.ctrlKey)
    && !event.altKey
    && !event.shiftKey
    && event.key.toLowerCase() === "f"
  ) {
    const inQuery = Boolean(target?.closest?.("[data-testid='managed-canvas-timeline-progress-query']"));
    if (editable && !inQuery) return;
    event.preventDefault();
    if (!isDragging.value) focusTimelineProgressQuery();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && !editable && event.key.toLowerCase() === "g") {
    event.preventDefault();
    if (event.shiftKey) ungroupSelectedCanvasNodes();
    else groupSelectedCanvasNodes();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && !editable && event.key.toLowerCase() === "z") {
    event.preventDefault();
    if (!isDragging.value) {
      if (event.shiftKey) redoLayout();
      else undoLayout();
    }
    return;
  }
  if (event.ctrlKey && !editable && event.key.toLowerCase() === "y") {
    event.preventDefault();
    if (!isDragging.value) redoLayout();
    return;
  }
  if (!editable && !isDragging.value && isShiftDigit(event, "1")) {
    event.preventDefault();
    void fitCanvas();
    return;
  }
  if (!editable && !isDragging.value && isShiftDigit(event, "0")) {
    event.preventDefault();
    onZoomTo100();
    return;
  }
  if (!editable && !isDragging.value && isShiftDigit(event, "2")) {
    event.preventDefault();
    void fitSelectedCanvasNodes();
    return;
  }
  const inTimelineQuery = Boolean(target?.closest("[data-testid='managed-canvas-timeline-progress-query']"));
  if (
    inTimelineQuery
    && event.altKey
    && !event.metaKey
    && !event.ctrlKey
    && (event.key === "ArrowDown" || event.key === "ArrowUp")
  ) {
    event.preventDefault();
    if (!isDragging.value) cycleTimelineProgressReview(event.key === "ArrowDown" ? 1 : -1);
    return;
  }
  if (!editable && !isDragging.value && (event.key === "Delete" || event.key === "Backspace")) {
    event.preventDefault();
    if (pinActionBusy.value || loading.value) return;
    if (selectedDraftEdgeId.value) {
      deleteSelectedDraftEdge();
      return;
    }
    const selected = nodes.value.filter((node) => node.selected && node.type !== "studioSpatialGroup" && isPinned(node.id));
    for (const node of selected) void togglePinnedNode(node.id);
    return;
  }
  if (
    !editable
    && !isDragging.value
    && event.altKey
    && !event.metaKey
    && !event.ctrlKey
    && !event.shiftKey
    && (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "ArrowLeft" || event.key === "ArrowRight")
  ) {
    event.preventDefault();
    if (event.key === "ArrowLeft") applyAlign("left");
    else if (event.key === "ArrowRight") applyAlign("right");
    else if (event.key === "ArrowUp") applyAlign("top");
    else applyAlign("bottom");
    return;
  }
  if (
    !editable
    && !isDragging.value
    && event.altKey
    && !event.metaKey
    && !event.ctrlKey
    && (event.key.toLowerCase() === "h" || event.key.toLowerCase() === "v")
  ) {
    event.preventDefault();
    if (event.shiftKey) applyDistribute(event.key.toLowerCase() === "h" ? "x" : "y");
    else applyAlign(event.key.toLowerCase() === "h" ? "centerX" : "centerY");
    return;
  }
  const panelTimelineChip = Boolean(target?.closest("[data-testid='managed-canvas-panel-timeline'] button"));
  const unitListItem = Boolean(target?.closest(".unit-list .library-item"));
  const unitListOrPager = Boolean(
    unitListItem
    || target?.closest("[data-testid='managed-canvas-units-prev']")
    || target?.closest("[data-testid='managed-canvas-units-next']"),
  );
  if (
    panelTimelineChip
    && !isDragging.value
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && !event.shiftKey
    && (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End")
  ) {
    event.preventDefault();
    movePanelTimelineChipFocus(event.key);
    return;
  }
  const assetListItem = Boolean(target?.closest("[data-testid='managed-canvas-assets-virtual-viewport'] .library-item"));
  const textListItem = Boolean(target?.closest(".text-list .library-item"));
  const mediaListItem = Boolean(target?.closest(".media-library-item"));
  const mediaListOrPager = Boolean(
    mediaListItem
    || target?.closest("[data-testid='managed-canvas-media-prev']")
    || target?.closest("[data-testid='managed-canvas-media-next']"),
  );
  const assetListOrPager = Boolean(
    assetListItem
    || target?.closest("[data-testid='managed-canvas-assets-prev']")
    || target?.closest("[data-testid='managed-canvas-assets-next']"),
  );
  const globalResourceListItem = Boolean(target?.closest(".global-resource-card"));
  const globalResourceListOrPager = Boolean(
    globalResourceListItem
    || target?.closest("[data-testid='managed-canvas-global-resources-prev']")
    || target?.closest("[data-testid='managed-canvas-global-resources-next']"),
  );
  const appearanceListItem = Boolean(target?.closest(".appearance-list button"));
  const appearanceListOrPager = Boolean(
    appearanceListItem
    || target?.closest("[data-testid='managed-canvas-appearances-prev']")
    || target?.closest("[data-testid='managed-canvas-appearances-next']"),
  );
  const nodeActionItem = Boolean(target?.closest(".node-action-buttons button"));
  const libraryTabItem = Boolean(target?.closest("#managed-canvas-library .library-tabs button"));
  const globalResourceTabItem = Boolean(target?.closest(".global-resource-tabs button"));
  const addMenuItem = Boolean(target?.closest("#managed-canvas-add-menu button"));
  const floatingToolbarButton = Boolean(
    target?.closest(".floating-tools > .add-menu-wrap > button")
    || target?.closest(".floating-tools > button"),
  );
  const bottomToolbarButton = Boolean(
    target?.closest(".bottom-tools > button")
    || target?.closest(".bottom-tools .align-tools button"),
  );
  const viewMenuPopItem = Boolean(target?.closest(".view-menu-pop > button"));
  const viewMenuThemeItem = Boolean(target?.closest(".view-menu-theme > button[role='radio']"));
  const managedFlowControlsButton = Boolean(target?.closest("#managed-studio-flow .vue-flow__controls-button"));
  const miniMapNode = Boolean(target?.closest(".vue-flow__minimap-node"));
  const miniMapSurface = Boolean(target?.closest("[data-testid='managed-canvas-minimap']"));
  if (
    unitListItem
    && !isDragging.value
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && !event.shiftKey
    && (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Home" || event.key === "End")
  ) {
    event.preventDefault();
    moveUnitListFocus(event.key);
    return;
  }
  if (
    assetListItem
    && !isDragging.value
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && !event.shiftKey
    && (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Home" || event.key === "End")
  ) {
    event.preventDefault();
    moveAssetListFocus(event.key);
    return;
  }
  if (
    textListItem
    && !isDragging.value
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && !event.shiftKey
    && (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Home" || event.key === "End")
  ) {
    event.preventDefault();
    moveTextListFocus(event.key);
    return;
  }
  if (
    mediaListItem
    && !isDragging.value
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && !event.shiftKey
    && (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Home" || event.key === "End")
  ) {
    event.preventDefault();
    moveMediaListFocus(event.key);
    return;
  }
  if (
    appearanceListItem
    && !isDragging.value
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && !event.shiftKey
    && (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Home" || event.key === "End")
  ) {
    event.preventDefault();
    moveAppearanceListFocus(event.key);
    return;
  }
  if (
    globalResourceListItem
    && !isDragging.value
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && !event.shiftKey
    && (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Home" || event.key === "End")
  ) {
    event.preventDefault();
    moveGlobalResourceListFocus(event.key);
    return;
  }
  if (
    nodeActionItem
    && !isDragging.value
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && !event.shiftKey
    && (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Home" || event.key === "End")
  ) {
    event.preventDefault();
    moveNodeActionFocus(event.key);
    return;
  }
  if (
    libraryTabItem
    && !isDragging.value
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && !event.shiftKey
    && (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End")
  ) {
    event.preventDefault();
    moveLibraryTabFocus(event.key);
    return;
  }
  if (
    globalResourceTabItem
    && !isDragging.value
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && !event.shiftKey
    && (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End")
  ) {
    event.preventDefault();
    moveGlobalResourceTabFocus(event.key);
    return;
  }
  if (
    addMenuItem
    && !isDragging.value
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && !event.shiftKey
    && (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End")
  ) {
    event.preventDefault();
    moveAddMenuFocus(event.key);
    return;
  }
  if (
    floatingToolbarButton
    && !isDragging.value
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && !event.shiftKey
    && (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Home" || event.key === "End")
  ) {
    event.preventDefault();
    moveFloatingToolbarFocus(event.key);
    return;
  }
  if (
    bottomToolbarButton
    && !isDragging.value
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && !event.shiftKey
    && (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End")
  ) {
    event.preventDefault();
    moveBottomToolbarFocus(event.key);
    return;
  }
  if (
    viewMenuPopItem
    && !isDragging.value
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && !event.shiftKey
    && (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Home" || event.key === "End")
  ) {
    event.preventDefault();
    moveViewMenuItemFocus(event.key);
    return;
  }
  if (
    viewMenuThemeItem
    && !isDragging.value
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && !event.shiftKey
    && (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End")
  ) {
    event.preventDefault();
    moveViewMenuThemeFocus(event.key);
    return;
  }
  if (
    managedFlowControlsButton
    && !isDragging.value
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && !event.shiftKey
    && (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Home" || event.key === "End")
  ) {
    event.preventDefault();
    moveManagedFlowControlsFocus(event.key);
    return;
  }
  if (
    miniMapNode
    && !isDragging.value
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && !event.shiftKey
    && (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End")
  ) {
    event.preventDefault();
    moveMiniMapNodeFocus(event.key);
    return;
  }
  if (
    miniMapSurface
    && !isDragging.value
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && !event.shiftKey
    && (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "ArrowLeft" || event.key === "ArrowRight")
  ) {
    event.preventDefault();
    panCanvasFromMiniMap(event.key);
    return;
  }
  if (
    helpOpen.value
    && event.key === "Tab"
    && target?.closest("#managed-canvas-help-card")
  ) {
    event.preventDefault();
    helpCloseButton()?.focus();
    return;
  }
  if (
    directorPanelOpen.value
    && event.key === "Tab"
    && target?.closest("[data-testid='director-action-panel']")
  ) {
    event.preventDefault();
    moveDirectorPanelFocus(event.shiftKey);
    return;
  }
  if (
    panelTimelineChip
    && !isDragging.value
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && !event.shiftKey
    && (event.key === "PageUp" || event.key === "PageDown")
  ) {
    event.preventDefault();
    movePanelTimelineChipFocus(event.key);
    return;
  }
  if (
    !editable
    && !isDragging.value
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "ArrowLeft" || event.key === "ArrowRight")
  ) {
    if (target?.closest?.("[data-testid='managed-canvas-minimap']")) return;
    if (target?.closest?.("#managed-studio-flow .vue-flow__controls-button")) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    const step = event.shiftKey ? CANVAS_GRID_SIZE : 1;
    if (event.key === "ArrowLeft") nudgeSelectedCanvasNodes(-step, 0);
    else if (event.key === "ArrowRight") nudgeSelectedCanvasNodes(step, 0);
    else if (event.key === "ArrowUp") nudgeSelectedCanvasNodes(0, -step);
    else nudgeSelectedCanvasNodes(0, step);
    return;
  }
  if (
    !editable
    && !isDragging.value
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && !event.shiftKey
    && (event.key === "[" || event.key === "]")
  ) {
    event.preventDefault();
    cyclePanelTimelineChip(event.key === "]" ? 1 : -1);
    return;
  }
  if (
    !editable
    && !isDragging.value
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && !event.shiftKey
    && (event.key === "Home" || event.key === "End")
  ) {
    event.preventDefault();
    focusPanelTimelineChipEnd(event.key === "Home" ? "first" : "last");
    return;
  }
  if (
    unitListOrPager
    && event.altKey
    && !event.metaKey
    && !event.ctrlKey
    && !event.shiftKey
    && (event.key === "PageUp" || event.key === "PageDown")
  ) {
    event.preventDefault();
    if (!isDragging.value) void pageUnitsByKeyboard(event.key === "PageDown" ? 1 : -1);
    return;
  }
  if (
    mediaListOrPager
    && event.altKey
    && !event.metaKey
    && !event.ctrlKey
    && !event.shiftKey
    && (event.key === "PageUp" || event.key === "PageDown")
  ) {
    event.preventDefault();
    if (!isDragging.value) void pageMediaByKeyboard(event.key === "PageDown" ? 1 : -1);
    return;
  }
  if (
    assetListOrPager
    && event.altKey
    && !event.metaKey
    && !event.ctrlKey
    && !event.shiftKey
    && (event.key === "PageUp" || event.key === "PageDown")
  ) {
    event.preventDefault();
    if (!isDragging.value) void pageAssetsByKeyboard(event.key === "PageDown" ? 1 : -1);
    return;
  }
  if (
    globalResourceListOrPager
    && event.altKey
    && !event.metaKey
    && !event.ctrlKey
    && !event.shiftKey
    && (event.key === "PageUp" || event.key === "PageDown")
  ) {
    event.preventDefault();
    if (!isDragging.value) void pageGlobalResourcesByKeyboard(event.key === "PageDown" ? 1 : -1);
    return;
  }
  if (
    appearanceListOrPager
    && event.altKey
    && !event.metaKey
    && !event.ctrlKey
    && !event.shiftKey
    && (event.key === "PageUp" || event.key === "PageDown")
  ) {
    event.preventDefault();
    if (!isDragging.value) void pageAppearancesByKeyboard(event.key === "PageDown" ? 1 : -1);
    return;
  }
  if (
    unitListItem
    && !isDragging.value
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && !event.shiftKey
    && (event.key === "PageUp" || event.key === "PageDown")
  ) {
    event.preventDefault();
    jumpUnitListPage(event.key === "PageDown" ? 1 : -1);
    return;
  }
  if (
    !editable
    && !panelTimelineChip
    && !unitListItem
    && !isDragging.value
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && !event.shiftKey
    && (event.key === "PageUp" || event.key === "PageDown")
  ) {
    event.preventDefault();
    jumpPanelTimelineChipPage(event.key === "PageDown" ? 1 : -1);
    return;
  }
  if (
    !editable
    && !isDragging.value
    && event.shiftKey
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && event.key.toLowerCase() === "e"
  ) {
    event.preventDefault();
    toggleEdges();
    return;
  }
  if (
    !editable
    && !isDragging.value
    && event.shiftKey
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && event.key.toLowerCase() === "d"
  ) {
    event.preventDefault();
    cycleCanvasTheme();
    return;
  }
  if (
    !editable
    && !isDragging.value
    && event.shiftKey
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && event.key.toLowerCase() === "m"
  ) {
    event.preventDefault();
    toggleMiniMap();
    return;
  }
  if (
    !editable
    && !isDragging.value
    && event.shiftKey
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && event.key.toLowerCase() === "w"
  ) {
    event.preventDefault();
    toggleWorkspaceMode();
    return;
  }
  if (
    !editable
    && !isDragging.value
    && !loading.value
    && event.shiftKey
    && !event.altKey
    && !event.metaKey
    && !event.ctrlKey
    && event.key.toLowerCase() === "t"
  ) {
    event.preventDefault();
    void applyTimelineLayout(false);
    return;
  }
  if (
    !editable
    && !isDragging.value
    && !loading.value
    && event.shiftKey
    && event.altKey
    && !event.metaKey
    && !event.ctrlKey
    && event.key.toLowerCase() === "t"
  ) {
    event.preventDefault();
    void applyTimelineLayout(true);
    return;
  }
  if (!editable && !isDragging.value && !loading.value && event.key === "F5") {
    event.preventDefault();
    void refreshAll();
    return;
  }
  if (
    !editable
    && !isDragging.value
    && !loading.value
    && !localProductionPreviewLoading.value
    && event.key === "F6"
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && !event.shiftKey
  ) {
    event.preventDefault();
    void verifyLocalProductionSource();
    return;
  }
  if (event.key === "F3" && !event.metaKey && !event.ctrlKey && !event.altKey) {
    const inQuery = Boolean(target?.closest("[data-testid='managed-canvas-timeline-progress-query']"));
    if (editable && !inQuery) return;
    event.preventDefault();
    if (!isDragging.value && timelineProgressQuery.value.trim()) {
      void cycleTimelineSearchHit(event.shiftKey ? -1 : 1);
    }
    return;
  }
  if (
    !editable
    && !isDragging.value
    && !event.shiftKey
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && event.key.toLowerCase() === "c"
  ) {
    event.preventDefault();
    toggleConnectMode();
    return;
  }
  if (!editable && !isDragging.value && !event.metaKey && !event.ctrlKey && !event.altKey && event.key === "F1") {
    event.preventDefault();
    toggleHelp();
    return;
  }
  if (
    !editable
    && !isDragging.value
    && !event.shiftKey
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && event.key.toLowerCase() === "a"
  ) {
    event.preventDefault();
    toggleAddMenu();
    return;
  }
  if (
    !editable
    && !isDragging.value
    && event.shiftKey
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && event.key.toLowerCase() === "l"
  ) {
    event.preventDefault();
    void toggleGlobalResourceLibrary();
    return;
  }
  if (
    !editable
    && !isDragging.value
    && !event.shiftKey
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && event.key.toLowerCase() === "l"
  ) {
    event.preventDefault();
    void toggleLibrary();
    return;
  }
  // Qwen D4：受闸导演快捷键（白名单；禁任意写命令）
  if (!editable && !isDragging.value) {
    const gated = directorHotkeys.match(event);
    if (gated) {
      event.preventDefault();
      if (gated === "toggle-director-panel") {
        toggleDirectorPanel();
        return;
      }
      const action = directorActionByHotkey(gated);
      if (action) onDirectorAction(action);
      return;
    }
  }
  if (event.key === "Escape") {
    const inQuery = Boolean(target?.closest("[data-testid='managed-canvas-timeline-progress-query']"));
    if (inQuery) {
      if (timelineProgressQuery.value.trim() || timelineProgressReview.value) {
        event.preventDefault();
        timelineProgressQuery.value = "";
        timelineProgressReview.value = "";
        timelineSearchCursor = -1;
        return;
      }
      event.preventDefault();
      timelineProgressQueryEl.value?.blur();
      return;
    }
    if (target?.closest("[data-testid='managed-canvas-timeline-progress-review']")) {
      event.preventDefault();
      timelineProgressQueryEl.value?.focus();
      return;
    }
  }
  if (event.key !== "Escape") return;
  const escapePendingId = pendingConnectionSourceId.value;
  const helpWasOpen = helpOpen.value;
  const addWasOpen = addMenuOpen.value;
  const viewMenuWasOpen = Boolean(viewMenuEl.value?.hasAttribute("open"));
  const directorWasOpen = directorPanelOpen.value;
  const connectWasOpen = connectMode.value;
  connectMode.value = false;
  pendingConnectionSourceId.value = "";
  selectedDraftEdgeId.value = "";
  addMenuOpen.value = false;
  helpOpen.value = false;
  directorPanelOpen.value = false;
  closeViewMenu({ restore: false });
  resetClearConfirmation();
  stripPendingOutline(escapePendingId);
  // 焦点归还触发按钮（a11y）。
  if (helpWasOpen) helpTriggerEl.value?.focus();
  else if (addWasOpen) addTriggerEl.value?.focus();
  else if (viewMenuWasOpen) restoreViewMenuSummaryFocus();
  else if (directorWasOpen) restoreDirectorToggleFocus();
  else if (connectWasOpen) restoreConnectTriggerFocus();
  // R5-F2：Escape 重建前取消挂起吸附 rAF 并清线（不改 isDragging——d3-drag 会话仍存活，stop 时复位）。
  cancelPendingSnap();
  snapLines.value = [];
  if (!isDragging.value) clearCanvasSelection();
  rebuildGraph();
}

function invalidateCanvasRequests(): void {
  cancelInitialUnitCardObserver();
  workflowActionGate.invalidate();
  pinActionGate.invalidate();
  addUnitActionGate.invalidate();
  externalImportActionGate.invalidate();
  refreshSequence += 1;
  localSourceVerificationSequence += 1;
  layoutLoadSequence += 1;
  textDocumentLoadSequence += 1;
  pinnedTextDocumentLoadSequence += 1;
  pinnedMediaLoadSequence += 1;
  mediaLoadSequence += 1;
  unitDetailLoadSequence += 1;
  panelPipelineLoadSequence += 1;
  invalidateQueuedUnitSelection();
  currentProductionBundle.value = null;
  unitGridRawProjectionFlight.invalidate();
  t23RawReferenceSpanTracker.invalidateCurrent();
  unitGridRawProjectionAbort?.abort(new UnitGridRawProjectionAborted("画布请求已失效"));
  unitGridRawProjectionAbort = null;
  if (unitGridGraphRebuildRafId) {
    window.cancelAnimationFrame(unitGridGraphRebuildRafId);
    unitGridGraphRebuildRafId = 0;
  }
  planStatusLoadSequence += 1;
  controlViewportSequence += 1;
  if (controlViewportTimer !== undefined) {
    window.clearTimeout(controlViewportTimer);
    controlViewportTimer = undefined;
  }
  controller.invalidate();
  pinnedAssetController.invalidate();
  guardedActionGate.invalidate();
  invalidateGlobalResourceRequest();
  miniMapUserOverride.value = null;
}

watch(() => unitDetail.value?.unit.id, (unitId, previousUnitId) => {
  if (unitId !== previousUnitId) workflowActionGate.invalidate();
});

watch(() => props.projectRoot, async (_projectRoot, previousProjectRoot) => {
  studioThumbnailDerivationQueue.invalidate();
  studioThumbnailDerivationInFlight.clear();
  invalidateCanvasRequests();
  // flush 调用会在首个 await 前同步冻结旧工程布局；随后立即撤下旧工程可见状态，
  // 不让慢 CAS 保存把旧 raw/节点滞留在已经切换的新 projectRoot 下。
  const previousLayoutFlush = flushPendingLayout(previousProjectRoot);
  layoutSaveGeneration += 1;
  overview.value = null;
  unitLeaseDisplayHint.value = null;
  productionDiagnostics.value = null;
  localProductionPreview.value = null;
  localCreativeIngestStatus.value = null;
  localProductionPreviewLoading.value = false;
  unitsPage.value = null;
  assetsPage.value = null;
  mediaPage.value = null;
  globalResourceSearch.value = "";
  globalResourceCategory.value = "character";
  mediaSearch.value = "";
  mediaKindFilter.value = "all";
  libraryMode.value = "current";
  // P30：切工程时清空旧工程宫格/整板会话状态并以新工程账本投影重建。
  for (const key of Object.keys(nodeStatusStore.snapshot())) {
    if (key.startsWith("panel:") || key.startsWith("unit:")) nodeStatusStore.clear(key);
  }
  nodeStatusTick.value += 1;
  // P23：undo 栈不跨工程；isDragging 滞留边界复位（R-pre-2 N1）。
  undoStack.clear();
  bumpUndoTick();
  isDragging.value = false;
  spacePanHeld.value = false;
  cancelPendingSnap();
  snapLines.value = [];
  dragStartSnapshot = null;
  selectionCount.value = 0;
  void syncPlanNodeStatuses();
  pinnedAssetsPage.value = null;
  pagedTextDocuments.value = [];
  pinnedTextDocuments.value = [];
  pinnedMediaItems.value = new Map();
  unitDetail.value = null;
  unitGridRawPipeline.value = new Map();
  unitGridReferencePipeline.value = new Map();
  unitGridContinuityPipeline.value = new Map();
  unitGridPostResultObservationPipeline.value = new Map();
  unitGridVideoPackagePipeline.value = new Map();
  unitGridNonPassPipeline.value = new Map();
  unitGridCorePassUnits.value = new Set();
  frozenReferenceThumbnailCache.clear();
  thumbnailLru.clear();
  studioThumbnailDerivationFailed.clear();
  // T12/T13：切工程时失效在途投影请求并清空旧工程的投影/summary，不跨工程残留。
  timelineProjection.reset();
  appearancesPage.value = null;
  selection.value = null;
  unitCursor.value = undefined;
  assetCursor.value = undefined;
  appearanceCursor.value = undefined;
  mediaCursor.value = undefined;
  unitCursorStack.value = [];
  assetCursorStack.value = [];
  appearanceCursorStack.value = [];
  mediaCursorStack.value = [];
  nodes.value = [];
  edges.value = [];
  layoutFingerprint.value = undefined;
  persistedLayoutNodes.value = {};
  persistedLayoutBase.value = null;
  initialTimelineLayoutAppliedRoot.value = "";
  workspaceMode.value = "projection";
  pinnedNodeIds.value = [];
  draftCanvasEdges.value = [];
  workflowGroups.value = [];
  spatialGroups.value = [];
  selectedPanelIds.value = [];
  lastWorkflowTitle.value = "";
  lastWorkflowRunSummary.value = "";
  lastWorkflowFailed.value = false;
  libraryOpen.value = false;
  addMenuOpen.value = false;
  helpOpen.value = false;
  connectMode.value = false;
  pendingConnectionSourceId.value = "";
  selectedDraftEdgeId.value = "";
  errorMessage.value = "";
  loading.value = false;
  workflowBusy.value = false;
  pinActionBusy.value = false;
  addUnitActionBusy.value = false;
  externalImportBusy.value = false;
  externalDropActive.value = false;
  externalDropDepth.value = 0;
  planStatusRebuildDirty = false;
  if (syncRebuildTimer) {
    clearTimeout(syncRebuildTimer);
    syncRebuildTimer = 0;
  }
  if (generationProjectionRefreshTimer) {
    clearTimeout(generationProjectionRefreshTimer);
    generationProjectionRefreshTimer = 0;
  }
  generationProjectionRefreshQueued = false;
  resetClearConfirmation();
  layoutViewport.value = { x: 30, y: 36, zoom: 0.72 };
  zoom.value = 0.72;
  layoutSaveState.value = "idle";
  // 先清掉旧工程各 lane 的 busy，再在同一同步任务内进入切换 busy。
  // 这里必须早于布局 flush 的首个 await，避免画布以 aria-busy=false 暴露
  // 已清空但尚未读取新工程的瞬态 0/0/0 投影。
  loading.value = true;
  await previousLayoutFlush;
  if (canvasDisposed) return;
  await refreshAll();
});

onMounted(async () => {
  markT23RendererStartup("canvas-mounted");
  window.addEventListener("keydown", onCanvasKeydown);
  window.addEventListener("keyup", onCanvasKeyup);
  window.addEventListener("blur", onWindowBlur);
  window.addEventListener("focusin", onManagedFlowControlsFocusIn);
  window.addEventListener("focusin", onMiniMapNodeFocusIn);
  document.addEventListener("pointerdown", onGlobalPointerDown, true);
  // 只读 UI 核对钩子：暴露 unit-grid raw 管道快照（含 only-render-visible 剔除的 off-screen 节点），
  // 不写盘、不平移视口；verify:project-ui / t23-s1e1-raw-sha 用其核对 selectedRawSha256。
  (window as unknown as {
    __aiCanvasManagedStudioVerify?: {
      getUnitGridRawSnapshot: () => {
        loading: boolean;
        /** 当前 VueFlow nodes store 中实际存在的单元节点；不读取后端 overview metrics。 */
        unitNodeIds: string[];
        /** 画布内只读剧本资源验收：抽屉操作不得改变节点、边、固定关系或布局身份。 */
        allNodeIds: string[];
        edgeIds: string[];
        pinnedNodeIds: string[];
        layoutFingerprint?: string;
        corePassUnitIds: string[];
        referenceCount: number;
        /** 正式 raw 的后置视频包/实际末态增强也已闭合；用于只读 UI 验收等待稳定图。 */
        formalProjectionInFlight: boolean;
        referenceUnitIds: string[];
        raws: Array<{
          unitId: string;
          rawMediaSha256: string;
          thumbnailUrl?: string;
          verification: string;
          provenance: string;
        }>;
        references: Array<{
          unitId: string;
          referenceId: string;
          mediaSha256: string;
          referenceType: string;
          thumbnailUrl?: string;
        }>;
      };
    };
  }).__aiCanvasManagedStudioVerify = {
    getUnitGridRawSnapshot: () => ({
      loading: rawReferenceProjectionLoading.value,
      unitNodeIds: nodes.value
        .filter((node) => node.id.startsWith("unit:"))
        .map((node) => node.id.slice("unit:".length)),
      allNodeIds: nodes.value.map((node) => node.id),
      edgeIds: edges.value.map((edge) => edge.id),
      pinnedNodeIds: [...pinnedNodeIds.value],
      ...(layoutFingerprint.value ? { layoutFingerprint: layoutFingerprint.value } : {}),
      corePassUnitIds: [...unitGridCorePassUnits.value],
      referenceCount: [...unitGridReferencePipeline.value.values()]
        .reduce((total, references) => total + references.length, 0),
      formalProjectionInFlight: Boolean(unitGridRawProjectionInFlight),
      referenceUnitIds: [...unitGridReferencePipeline.value.keys()],
      raws: [...unitGridRawPipeline.value.entries()].map(([unitId, raw]) => ({
        unitId,
        rawMediaSha256: raw.rawMediaSha256,
        ...(raw.rawThumbnailUrl ? { thumbnailUrl: raw.rawThumbnailUrl } : {}),
        verification: raw.verification,
        provenance: raw.provenance,
      })),
      references: [...unitGridReferencePipeline.value.entries()]
        .flatMap(([unitId, references]) => references.map((reference) => ({
          unitId,
          referenceId: reference.referenceId,
          mediaSha256: reference.mediaSha256,
          referenceType: reference.referenceType,
          ...(reference.thumbnailUrl ? { thumbnailUrl: reference.thumbnailUrl } : {}),
        }))),
    }),
  };
  await refreshAll();
  await applyExternalFocus();
  await syncPlanNodeStatuses();
  // P21：账本变化（含 MCP 进程写入）触发宫格状态投影刷新。
  studioGenerationProgressUnsubscribe = window.canvasApi.onStudioGenerationProgress((payload) => {
    if (payload.projectId !== overview.value?.projectId) return;
    scheduleGenerationProjectionRefresh();
  });
});

watch(() => props.focus, async () => {
  if (!props.focus) return;
  if (!unitsPage.value) await refreshAll();
  await applyExternalFocus();
}, { deep: true });

onBeforeUnmount(() => {
  canvasDisposed = true;
  cancelInitialUnitCardObserver();
  studioThumbnailDerivationQueue.dispose();
  studioThumbnailDerivationInFlight.clear();
  workflowActionGate.dispose();
  pinActionGate.dispose();
  addUnitActionGate.dispose();
  externalImportActionGate.dispose();
  guardedActionGate.dispose();
  try {
    delete (window as unknown as { __aiCanvasManagedStudioVerify?: unknown }).__aiCanvasManagedStudioVerify;
  } catch {
    // ignore
  }
  const finalLayoutFlush = flushPendingLayout(props.projectRoot);
  invalidateCanvasRequests();
  cancelPendingSnap();
  if (timelineSearchFocusTimer) {
    clearTimeout(timelineSearchFocusTimer);
    timelineSearchFocusTimer = 0;
  }
  if (syncRebuildTimer) {
    clearTimeout(syncRebuildTimer);
    syncRebuildTimer = 0;
  }
  if (generationProjectionRefreshTimer) {
    clearTimeout(generationProjectionRefreshTimer);
    generationProjectionRefreshTimer = 0;
  }
  generationProjectionRefreshQueued = false;
  resetClearConfirmation();
  window.removeEventListener("keydown", onCanvasKeydown);
  window.removeEventListener("keyup", onCanvasKeyup);
  window.removeEventListener("blur", onWindowBlur);
  window.removeEventListener("focusin", onManagedFlowControlsFocusIn);
  window.removeEventListener("focusin", onMiniMapNodeFocusIn);
  document.removeEventListener("pointerdown", onGlobalPointerDown, true);
  studioGenerationProgressUnsubscribe?.();
  void finalLayoutFlush.finally(() => { layoutSaveGeneration += 1; });
});
</script>

<style scoped>
/* P25 主题 token：light 为默认值（不写 data-theme 也有 token）；dark/paper 覆盖。 */
.managed-studio-canvas {
  --msc-bg: #f7f7f5;
  --msc-surface: #ffffff;
  --msc-surface-2: #efefeb;
  --msc-text: #20241f;
  --msc-text-2: #5c635c;
  --msc-text-3: #8a9189;
  --msc-line: #e2e3de;
  --msc-accent: #8a6a0d;
  --msc-accent-strong: #7c5f0a;
  --msc-accent-soft: rgba(163, 124, 16, 0.14);
  --msc-accent-ink: #ffffff;
  --msc-ok: #3f7d4e;
  --msc-danger: #b44434;
  --msc-shadow-pop: 0 8px 28px rgba(30, 32, 28, 0.14);
  --msc-kind-asset: #3f7d4e;
  --msc-kind-unit: #4a6f9e;
  --msc-kind-panel: #6d4f86;
  --msc-kind-script: #4a7c55;
  --msc-kind-prompt: #8a6d1e;
  --msc-kind-raw: #3f6f8c;
  --msc-kind-labeled: #7c611f;
  --msc-kind-review: #4f7440;
}
.managed-studio-canvas[data-theme="dark"] {
  --msc-bg: #0f1110;
  --msc-surface: #161817;
  --msc-surface-2: #242825;
  --msc-text: #f4f2ed;
  --msc-text-2: #8f9591;
  --msc-text-3: #6b716c;
  --msc-line: #2b2e2c;
  --msc-accent: #d7b85c;
  --msc-accent-strong: #e3c567;
  --msc-accent-soft: rgba(215, 184, 92, 0.16);
  --msc-accent-ink: #17140b;
  --msc-ok: #6f9d78;
  --msc-danger: #d99182;
  --msc-shadow-pop: 0 12px 34px rgba(0, 0, 0, 0.35);
  --msc-kind-asset: #79a86c;
  --msc-kind-unit: #7c9cbd;
  --msc-kind-panel: #9a7fb0;
  --msc-kind-script: #6b8f71;
  --msc-kind-prompt: #c7a352;
  --msc-kind-raw: #7ba3b8;
  --msc-kind-labeled: #b89a5f;
  --msc-kind-review: #8fa87c;
}
.managed-studio-canvas[data-theme="paper"] {
  --msc-bg: #f5f0e4;
  --msc-surface: #fdfaf1;
  --msc-surface-2: #f0e8d5;
  --msc-text: #2e2a21;
  --msc-text-2: #6e6759;
  --msc-text-3: #98907e;
  --msc-line: #e2d9c4;
  --msc-accent: #8f6a1e;
  --msc-accent-strong: #7a5a14;
  --msc-accent-soft: rgba(143, 106, 30, 0.16);
  --msc-accent-ink: #ffffff;
  --msc-ok: #4f7a3d;
  --msc-danger: #a6482f;
  --msc-shadow-pop: 0 8px 26px rgba(80, 66, 40, 0.16);
  --msc-kind-asset: #5c7a3f;
  --msc-kind-unit: #5d7194;
  --msc-kind-panel: #7a5c80;
  --msc-kind-script: #5f7a4a;
  --msc-kind-prompt: #8a6a28;
  --msc-kind-raw: #5d7186;
  --msc-kind-labeled: #84682c;
  --msc-kind-review: #647144;
}
.managed-studio-canvas {
  height: 100%;
  min-height: 680px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--msc-text);
  background: var(--msc-bg);
}
button, input, select { font: inherit; }
button { color: inherit; }
.canvas-header {
  min-height: 52px;
  display: grid;
  grid-template-columns: minmax(200px, 1fr) auto auto;
  gap: 16px;
  align-items: center;
  padding: 8px 18px;
  border-bottom: 1px solid var(--msc-line);
  background: var(--msc-surface);
}
.canvas-context { margin: 0; color: var(--msc-text-2); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.canvas-metrics { border: 0; }
.canvas-metrics summary { cursor: pointer; color: var(--msc-text-3); font-size: 10px; text-align: right; list-style: none; }
.canvas-metrics > div { display: flex; gap: 8px; margin-top: 2px; }
.canvas-metrics span { display: grid; min-width: 42px; color: var(--msc-text-3); font-size: 10px; text-align: center; }
.canvas-metrics b { color: var(--msc-accent); font-size: 14px; }
.header-actions { display: flex; gap: 8px; }
.header-actions button, .pager button, .workflow-toolbar button, .pin-button {
  border: 0;
  border-radius: 8px;
  background: var(--msc-surface-2);
  padding: 7px 10px;
  cursor: pointer;
}
.header-actions button:disabled, .pager button:disabled, .workflow-toolbar button:disabled { opacity: .35; cursor: default; }
.header-actions .primary-start {
  min-width: 98px;
  background: linear-gradient(135deg, var(--msc-accent), var(--msc-accent-strong));
  color: var(--msc-accent-ink);
  font-weight: 700;
  box-shadow: var(--msc-shadow-pop);
}
.panel-timeline-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  list-style: none;
  margin: 0;
  padding: 0;
  max-width: min(720px, 52vw);
}
.panel-timeline-strip .timeline-chip button {
  display: grid;
  gap: 1px;
  min-width: 56px;
  padding: 4px 7px;
  border: 1px solid var(--msc-line);
  border-radius: 8px;
  background: var(--msc-surface-2);
  color: var(--msc-text-2);
  cursor: pointer;
  text-align: left;
}
.panel-timeline-strip .timeline-chip button em {
  font-style: normal;
  color: var(--msc-text-3);
  font: 9px Menlo, monospace;
}
.panel-timeline-strip .timeline-chip button span { font-size: 11px; font-weight: 650; color: var(--msc-text); }
.panel-timeline-strip .timeline-chip button small { color: var(--msc-text-3); font-size: 10px; }
.panel-timeline-strip .timeline-chip.ready button { border-color: var(--msc-accent); }
.panel-timeline-strip .timeline-chip.muted { opacity: 0.35; }
.panel-timeline-strip .timeline-chip.review-pass button { background: color-mix(in srgb, #3d8b5a 18%, var(--msc-surface-2)); }
.panel-timeline-strip .timeline-chip.review-rework button,
.panel-timeline-strip .timeline-chip.review-reject button { background: color-mix(in srgb, #b45309 16%, var(--msc-surface-2)); }
.timeline-progress-filter {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin: 4px 0 8px;
}
.timeline-progress-filter input[type="search"] {
  min-width: 160px;
  padding: 4px 8px;
  border-radius: 6px;
  border: 1px solid var(--msc-border, #333);
  background: var(--msc-surface-2, #1a1a1a);
  color: var(--msc-text, #eee);
  font-size: 12px;
}
.timeline-progress-filter select {
  padding: 4px 6px;
  border-radius: 6px;
  border: 1px solid var(--msc-border, #333);
  background: var(--msc-surface-2, #1a1a1a);
  color: var(--msc-text, #eee);
  font-size: 12px;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.flow-shell :deep(.system-timeline-edge path) { stroke: var(--msc-text-3); stroke-width: 1.5; }
.flow-shell :deep(.system-timeline-edge text) { fill: var(--msc-text-3); font-size: 9px; }
/* T13: 连线分色 */
.flow-shell :deep(.edge-approved path) { stroke: var(--msc-success, #4caf50); stroke-width: 2; }
.flow-shell :deep(.edge-approved text) { fill: var(--msc-success, #4caf50); }
.flow-shell :deep(.edge-video path) { stroke: var(--msc-info, #2196f3); }
.flow-shell :deep(.edge-video text) { fill: var(--msc-info, #2196f3); }
.flow-shell :deep(.appearance-edge path) { stroke: var(--msc-muted, #9e9e9e); stroke-dasharray: 4 3; }
.flow-shell :deep(.system-reference-edge path) { stroke: var(--msc-kind-asset); stroke-width: 2; }
.flow-shell :deep(.system-reference-edge text) { fill: var(--msc-text-2); font-size: 9px; font-weight: 650; }
.flow-shell :deep(.reference-scene-edge path) { stroke: var(--msc-kind-unit); }
.flow-shell :deep(.reference-prop-edge path) { stroke: var(--msc-kind-panel); }
.flow-shell :deep(.reference-style-edge path) { stroke: var(--msc-kind-prompt); stroke-dasharray: 5 4; }
.flow-shell :deep(.reference-vfx-edge path) { stroke: var(--msc-kind-raw); stroke-dasharray: 3 3; }
.flow-shell :deep(.continuity-unknown-edge path) { stroke: var(--msc-danger); stroke-dasharray: 5 4; }
.flow-shell :deep(.continuity-unknown-edge text) { fill: var(--msc-danger); }
.result-strip {
  min-height: 32px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 18px;
  color: var(--msc-text-2);
  font-size: 11px;
}
.result-strip b { color: var(--msc-text); }
.status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--msc-ok); }
.status-dot.busy { background: var(--msc-accent); box-shadow: 0 0 0 4px var(--msc-accent-soft); }
.generation-projection-status {
  max-width: min(360px, 34vw);
  overflow: hidden;
  padding: 3px 7px;
  border-radius: 999px;
  background: var(--msc-accent-soft);
  color: var(--msc-accent-strong);
  font-size: 10px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.generation-projection-status.degraded {
  background: color-mix(in srgb, var(--msc-danger) 16%, var(--msc-surface));
  color: var(--msc-danger);
}
.advanced-workflow { margin-left: auto; position: relative; }
.advanced-workflow > summary { cursor: pointer; color: var(--msc-text-3); }
.workflow-toolbar {
  position: absolute;
  z-index: 30;
  right: 0;
  top: calc(100% + 6px);
  max-width: 520px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
  padding: 9px;
  border-radius: 10px;
  background: var(--msc-surface);
  box-shadow: var(--msc-shadow-pop);
}
.canvas-error { display: flex; justify-content: space-between; gap: 12px; padding: 8px 16px; background: color-mix(in srgb, var(--msc-danger) 18%, var(--msc-surface)); color: var(--msc-danger); font-size: 12px; }
.canvas-error button { border: 0; background: transparent; cursor: pointer; }
.canvas-layout { min-height: 0; flex: 1; display: grid; grid-template-columns: minmax(0, 1fr); }
.canvas-layout.library-open { grid-template-columns: 292px minmax(0, 1fr); }
.canvas-layout.library-open.global-resources-open { grid-template-columns: 390px minmax(0, 1fr); }
.canvas-layout.inspector-open { grid-template-columns: minmax(0, 1fr) 286px; }
.canvas-layout.library-open.inspector-open { grid-template-columns: 292px minmax(0, 1fr) 286px; }
.canvas-layout.library-open.global-resources-open.inspector-open { grid-template-columns: 390px minmax(0, 1fr) 286px; }
.canvas-library, .canvas-inspector { min-width: 0; overflow: auto; background: var(--msc-surface); }
.canvas-library { border-right: 1px solid var(--msc-line); padding: 14px; }
.canvas-library > header { display: flex; justify-content: space-between; align-items: center; }
.canvas-library h3 { margin: 3px 0 10px; font-size: 15px; }
.eyebrow { color: var(--msc-accent); font-size: 10px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
.canvas-library > header button, .inspector-close, .help-card > button {
  width: 28px; height: 28px; border: 0; border-radius: 8px; background: var(--msc-surface-2); cursor: pointer;
}
.library-tabs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; margin: 5px 0 13px; }
.library-tabs button { border: 0; border-radius: 7px; background: var(--msc-surface-2); padding: 7px 4px; color: var(--msc-text-2); cursor: pointer; font-size: 11px; }
.library-tabs button.active { background: var(--msc-accent-soft); color: var(--msc-accent-strong); font-weight: 650; }
.character-ingest { display: grid; gap: 8px; margin: 0 0 12px; padding: 10px; border: 1px solid var(--msc-line); border-radius: 8px; background: var(--msc-bg); }
.character-ingest-files { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.character-ingest-files-single { grid-template-columns: 1fr; }
.character-ingest-files button, .character-ingest-save {
  min-height: 32px; border: 1px solid var(--msc-line); border-radius: 7px; background: var(--msc-surface-2); color: var(--msc-text); cursor: pointer; font-size: 11px;
}
.character-ingest-save { border-color: var(--msc-accent); background: var(--msc-accent-soft); color: var(--msc-accent-strong); font-weight: 650; }
.character-ingest-save:disabled, .character-ingest-files button:disabled { opacity: .55; cursor: not-allowed; }
.library-section label span, .library-note { display: block; margin: 0 0 6px; color: var(--msc-text-3); font-size: 11px; }
.library-section input, .library-section select, .library-section textarea { width: 100%; box-sizing: border-box; border: 1px solid var(--msc-line); border-radius: 7px; background: var(--msc-bg); color: var(--msc-text); padding: 8px; }
.library-section textarea { resize: vertical; min-height: 48px; font: inherit; }
.library-list { list-style: none; margin: 10px 0; padding: 0; display: grid; gap: 6px; }
.library-list li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 5px; content-visibility: auto; contain-intrinsic-size: auto 56px; }
.library-list-viewport {
  height: 360px;
  overflow: auto;
  border: 1px solid var(--msc-line);
  border-radius: 8px;
  background: var(--msc-bg);
}
.library-list-spacer { position: relative; width: 100%; }
.library-list-viewport .library-list { will-change: transform; }
.library-item { min-width: 0; display: flex; align-items: center; gap: 8px; border: 1px solid var(--msc-line); border-radius: 8px; background: var(--msc-bg); padding: 6px; text-align: left; cursor: pointer; }
.header-actions button.active { outline: 1px solid var(--msc-accent, #d7af55); }
.library-item:hover { background: var(--msc-surface-2); }
.library-item > span:last-child { min-width: 0; display: grid; gap: 2px; }
.library-item b { overflow: hidden; color: var(--msc-text); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.library-item small { color: var(--msc-text-3); font-size: 10px; }
.media-library-list { max-height: 360px; overflow: auto; padding-right: 2px; }
.media-library-item { cursor: default; }
.item-thumb { width: 38px; height: 38px; flex: 0 0 38px; display: grid; place-items: center; overflow: hidden; border-radius: 6px; background: var(--msc-surface-2); color: var(--msc-accent); }
.item-thumb img { width: 100%; height: 100%; object-fit: cover; }
.item-type { width: 34px; height: 34px; flex: 0 0 34px; display: grid; place-items: center; border-radius: 6px; background: var(--msc-surface-2); color: var(--msc-accent); font-size: 11px; }
.pin-button { align-self: stretch; padding: 5px 8px; color: var(--msc-accent-strong); font-size: 10px; }
.facet-row, .pager { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
.pager { grid-template-columns: 1fr auto 1fr; align-items: center; }
.pager-position { color: var(--msc-text-3); font-size: 10px; text-align: center; white-space: nowrap; }
.library-empty { margin: 18px 4px; color: var(--msc-text-3); font-size: 11px; line-height: 1.6; text-align: center; }
.global-resource-library { overflow: hidden; }
.global-resource-library > header { gap: 12px; }
.global-resource-library > header > div { min-width: 0; }
.global-resource-library h3 { margin-bottom: 4px; }
.global-resource-header-actions { display: flex; align-items: center; gap: 6px; }
.global-resource-header-actions button:first-child {
  width: auto;
  min-width: 0;
  padding: 5px 7px;
  border: 1px solid var(--msc-accent);
  color: var(--msc-text);
  background: var(--msc-accent-soft);
  font-size: 8px;
  white-space: nowrap;
}
.readonly-badge {
  display: inline-flex;
  padding: 3px 7px;
  border-radius: 999px;
  background: var(--msc-accent-soft);
  color: var(--msc-accent-strong);
  font-size: 9px;
  font-weight: 650;
}
.global-resource-summary {
  margin: 12px 0 10px;
  padding: 9px 10px;
  border: 1px solid var(--msc-line);
  border-radius: 9px;
  background: var(--msc-bg);
  color: var(--msc-text-2);
  font-size: 10px;
  line-height: 1.6;
}
.global-resource-summary b { color: var(--msc-text); }
.global-resource-tabs { grid-template-columns: repeat(4, 1fr); }
.global-resource-tabs button { display: grid; gap: 1px; }
.global-resource-tabs button small { color: inherit; font-size: 8px; font-weight: 500; }
.global-resource-list-viewport {
  min-height: 260px;
  max-height: calc(100vh - 385px);
  margin: 10px 0;
  overflow: auto;
  border: 1px solid var(--msc-line);
  border-radius: 9px;
  background: var(--msc-bg);
}
.global-resource-list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 8px;
  list-style: none;
}
.global-resource-card {
  min-width: 0;
  display: grid;
  grid-template-columns: 84px minmax(0, 1fr);
  gap: 10px;
  padding: 8px;
  border: 1px solid var(--msc-line);
  border-radius: 9px;
  background: var(--msc-surface);
  content-visibility: auto;
  contain-intrinsic-size: auto 128px;
}
.global-resource-card > figure {
  width: 84px;
  height: 112px;
  display: grid;
  place-items: center;
  margin: 0;
  overflow: hidden;
  border-radius: 7px;
  background: var(--msc-surface-2);
  color: var(--msc-accent-strong);
  font-weight: 700;
}
.global-resource-card > figure img { width: 100%; height: 100%; object-fit: cover; }
.global-resource-card > article { min-width: 0; display: grid; align-content: start; gap: 4px; }
.global-resource-card-heading { min-width: 0; display: flex; align-items: start; gap: 6px; }
.global-resource-card-heading > b {
  min-width: 0;
  flex: 1;
  overflow-wrap: anywhere;
  color: var(--msc-text);
  font-size: 12px;
  line-height: 1.35;
}
.global-resource-card-heading > em {
  flex: 0 0 auto;
  padding: 2px 4px;
  border-radius: 4px;
  background: var(--msc-surface-2);
  color: var(--msc-text-3);
  font-size: 8px;
  font-style: normal;
}
.global-resource-source { color: var(--msc-text-3); font-size: 9px; line-height: 1.35; }
.global-resource-associations { display: grid; gap: 4px; margin: 2px 0 0; padding: 0; list-style: none; }
.global-resource-associations li {
  min-width: 0;
  display: grid;
  gap: 1px;
  padding-top: 4px;
  border-top: 1px dashed var(--msc-line);
}
.global-resource-associations b { overflow-wrap: anywhere; color: var(--msc-text-2); font-size: 10px; }
.global-resource-associations span { color: var(--msc-text-3); font-size: 8px; line-height: 1.4; }
.global-resource-pager { margin-top: 8px; }
.flow-shell { position: relative; min-width: 0; overflow: hidden; isolation: isolate; background: var(--msc-bg); }
.flow-shell.space-pan,
.flow-shell.space-pan :deep(.vue-flow__pane) { cursor: grab; }
.flow-shell.space-pan :deep(.vue-flow__pane):active { cursor: grabbing; }
.flow-shell.external-drop-active {
  outline: 2px dashed var(--msc-accent);
  outline-offset: -6px;
  background: color-mix(in srgb, var(--msc-accent) 8%, var(--msc-bg));
}
.flow-shell.external-drop-active::after {
  content: "松开以导入图片/视频/音频";
  position: absolute;
  z-index: 30;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  padding: 10px 16px;
  border: 1px solid var(--msc-accent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--msc-surface) 92%, transparent);
  color: var(--msc-accent-strong);
  font-size: 13px;
  font-weight: 650;
  pointer-events: none;
}
.flow-shell :deep(.vue-flow) { height: 100%; }
/* P29：选中节点以主色描边+柔光圈表达（替换 Vue Flow 默认蓝），与三主题 token 联动。 */
.flow-shell :deep(.vue-flow__node.selected) .msc-node { border-color: var(--msc-accent); box-shadow: 0 0 0 3px var(--msc-accent-soft); }
.flow-shell :deep(.vue-flow__node.selected) .msc-node.kind-asset.locked { border-color: var(--msc-accent); }
.flow-loading { display: grid; height: 100%; place-items: center; color: var(--msc-text-2); }
.floating-tools {
  position: absolute;
  z-index: 20;
  top: 18px;
  left: 16px;
  display: grid;
  gap: 7px;
}
.floating-tools > button, .add-menu-wrap > button {
  width: 50px;
  min-height: 46px;
  display: grid;
  place-items: center;
  gap: 2px;
  border: 1px solid var(--msc-line);
  border-radius: 10px;
  background: var(--msc-surface);
  color: var(--msc-text);
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}
.floating-tools button.active { background: var(--msc-accent-soft); color: var(--msc-accent-strong); border-color: var(--msc-accent); }
.floating-tools button span { color: inherit; font-size: 10px; }
.floating-tools > button > small { color: var(--msc-text-3); font-size: 8px; line-height: 1; }
.add-menu-wrap { position: relative; }
.add-menu {
  position: absolute;
  top: 0;
  left: 68px;
  width: 188px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  padding: 8px;
  border-radius: 12px;
  background: var(--msc-surface);
  box-shadow: var(--msc-shadow-pop);
}
.add-menu button { display: flex; align-items: center; gap: 7px; border: 0; border-radius: 7px; background: var(--msc-surface-2); padding: 7px; cursor: pointer; font-size: 11px; }
.add-menu i { width: 24px; height: 24px; display: grid; place-items: center; border-radius: 6px; background: var(--msc-accent-soft); color: var(--msc-accent-strong); font-style: normal; }
.bottom-tools {
  position: absolute;
  z-index: 18;
  left: 50%;
  bottom: 15px;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  max-width: calc(100% - 220px);
  gap: 4px;
  transform: translateX(-50%);
  padding: 5px;
  border-radius: 12px;
  background: var(--msc-surface);
  box-shadow: var(--msc-shadow-pop);
}
.bottom-tools button { padding: 6px 9px; color: var(--msc-text-2); font-size: 11px; border-radius: 7px; }
.bottom-tools button:hover:not(:disabled) { background: var(--msc-surface-2); }
.bottom-tools button:disabled { opacity: .4; cursor: default; }
.bottom-tools .danger-subtle { color: var(--msc-danger); }
.view-menu { position: relative; }
.view-menu > summary { padding: 6px 9px; border-radius: 7px; color: var(--msc-text-2); font-size: 11px; cursor: pointer; list-style: none; user-select: none; }
.view-menu > summary:hover { background: var(--msc-surface-2); }
.view-menu-pop {
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  display: grid;
  gap: 4px;
  min-width: 148px;
  padding: 6px;
  border-radius: 10px;
  background: var(--msc-surface);
  box-shadow: var(--msc-shadow-pop);
}
.view-menu-pop > button { display: block; width: 100%; padding: 7px 9px; border: 0; border-radius: 7px; background: transparent; color: var(--msc-text-2); font-size: 11px; text-align: left; cursor: pointer; }
.view-menu-pop > button:hover:not(:disabled) { background: var(--msc-surface-2); }
.view-menu-theme { display: flex; align-items: center; gap: 4px; padding: 6px 4px 2px; border-top: 1px solid var(--msc-line); }
.view-menu-theme > span { color: var(--msc-text-3); font-size: 10px; padding: 0 4px; }
.view-menu-theme > button { padding: 4px 8px; border: 0; border-radius: 6px; background: transparent; color: var(--msc-text-2); font-size: 11px; cursor: pointer; }
.view-menu-theme > button.active { background: var(--msc-accent-soft); color: var(--msc-accent-strong); font-weight: 650; }
.help-card {
  position: absolute;
  z-index: 24;
  top: 18px;
  left: 88px;
  width: min(360px, calc(100% - 120px));
  padding: 16px;
  border-radius: 12px;
  background: var(--msc-surface);
  box-shadow: var(--msc-shadow-pop);
}
.help-card > button { float: right; }
.help-card h3 { margin: 2px 0 12px; }
.help-card ol { padding-left: 19px; color: var(--msc-text-2); font-size: 12px; line-height: 1.7; }
.help-card p { margin: 8px 0 0; color: var(--msc-accent-strong); font-size: 11px; }
.flow-caption { position: absolute; z-index: 15; right: 12px; bottom: 10px; max-width: calc(100% - 24px); border-radius: 7px; background: var(--msc-surface); color: var(--msc-text-3); font: 9px Menlo, monospace; box-shadow: var(--msc-shadow-pop); }
.flow-caption > summary { padding: 6px 8px; cursor: pointer; }
.flow-caption > div { display: flex; flex-wrap: wrap; gap: 10px; padding: 0 8px 7px; }
.flow-shell :deep(.vue-flow__node-managedStudio) { width: auto; padding: 0; border: 0; background: transparent; box-shadow: none; white-space: normal; }
.flow-shell :deep(.vue-flow__node.selected) { filter: drop-shadow(0 0 5px var(--msc-accent)); }
.flow-shell :deep(.appearance-edge path) { stroke: var(--msc-text-3); }
.flow-shell :deep(.draft-input-edge path) { stroke: var(--msc-accent-strong); stroke-width: 2; }
.flow-shell :deep(.draft-input-edge text) { fill: var(--msc-accent); font-size: 9px; }
.flow-shell :deep(.selected-draft-edge path) { stroke: var(--msc-accent); stroke-width: 4; }
.flow-shell :deep(.vue-flow__node.connection-pending .msc-node) { outline: 3px solid var(--msc-accent); outline-offset: 4px; }
.flow-shell.connect-assist :deep(.connection-handle) {
  box-shadow: 0 0 0 6px var(--msc-accent-soft), var(--msc-shadow-pop);
}
/* Vue Flow Controls / MiniMap：全局 styles.css 为深色硬编码，这里按主题 token 覆写（仅本组件子树生效）。 */
.flow-shell :deep(.vue-flow__controls) { border: 0; box-shadow: var(--msc-shadow-pop); border-radius: 8px; overflow: hidden; }
.flow-shell :deep(.vue-flow__controls-button) { background: var(--msc-surface); border-bottom: 1px solid var(--msc-line); fill: var(--msc-text-2); }
.flow-shell :deep(.vue-flow__controls-button:hover) { background: var(--msc-surface-2); }
.flow-shell :deep(.vue-flow__minimap) { background-color: var(--msc-surface-2); border-radius: 8px; box-shadow: var(--msc-shadow-pop); }
.compact :deep(.vue-flow__node-managedStudio) { width: auto; height: auto; padding: 0; font-size: inherit; }
.connect-banner {
  position: absolute;
  z-index: 19;
  top: 14px;
  left: 50%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  border-radius: 999px;
  transform: translateX(-50%);
  background: var(--msc-accent-soft);
  color: var(--msc-accent-strong);
  font-size: 12px;
  box-shadow: var(--msc-shadow-pop);
}
.connect-banner button { border: 0; background: transparent; color: inherit; font-size: 11px; font-weight: 650; cursor: pointer; text-decoration: underline; }
.snap-guides { position: absolute; inset: 0; pointer-events: none; z-index: 5; }
.snap-guide { position: absolute; background: var(--msc-accent); opacity: .85; }
@media (prefers-reduced-motion: no-preference) {
  .connect-banner, .help-card, .add-menu, .view-menu-pop { transition: opacity .16s ease, transform .16s ease; }
  .bottom-tools button, .floating-tools > button, .add-menu-wrap > button, .library-item, .library-tabs button { transition: background-color .12s ease, color .12s ease; }
}
.align-tools { display: inline-flex; gap: 4px; align-items: center; }
.align-tools button { height: 28px; padding: 0 8px; border: 0; background: transparent; color: var(--msc-accent-strong); font-size: 11px; cursor: pointer; }
.selection-count { color: var(--msc-text-3); font-size: 10px; align-self: center; }
@media (max-width: 1180px) {
  .canvas-layout.inspector-open { grid-template-columns: minmax(0, 1fr); }
  .canvas-layout.library-open.inspector-open { grid-template-columns: 270px minmax(0, 1fr); }
  .canvas-layout.library-open.global-resources-open.inspector-open { grid-template-columns: 360px minmax(0, 1fr); }
  .canvas-inspector { position: absolute; z-index: 26; top: 85px; right: 0; bottom: 0; width: 270px; box-sizing: border-box; box-shadow: var(--msc-shadow-pop); }
}
@media (max-width: 860px) {
  .canvas-header { grid-template-columns: 1fr auto; }
  .canvas-metrics { display: none; }
  .canvas-layout.library-open { grid-template-columns: minmax(0, 1fr); }
  .canvas-library { position: absolute; z-index: 25; top: 85px; left: 0; bottom: 0; width: 280px; box-sizing: border-box; box-shadow: var(--msc-shadow-pop); }
  .canvas-library.global-resource-library { width: min(360px, calc(100% - 24px)); }
}

/* T12/T15/T21: 时间线投影摘要 + 单元租约 banner */
.timeline-projection-summary {
  display: flex; gap: 0.8em; align-items: center; flex-wrap: wrap;
  font-size: 0.82em; margin-top: 0.3em;
}
.timeline-projection-summary .tp-pass b { color: var(--msc-success, #4caf50); }
.timeline-projection-summary .tp-pending b { color: var(--msc-warning, #ff9800); }
.timeline-projection-summary .tp-progress b { color: var(--msc-info, #2196f3); }
.timeline-projection-summary .tp-failed b { color: var(--msc-danger, #f44336); }
.timeline-projection-summary .tp-blocked b { color: var(--msc-muted, #9e9e9e); }
.timeline-projection-summary small { opacity: 0.65; margin-left: 0.5em; }
.unit-lease-banner {
  background: var(--msc-surface-accent, #fff3cd); color: var(--msc-text-accent, #856404);
  padding: 0.35em 1em; font-size: 0.82em; border-bottom: 1px solid var(--msc-border, #eee);
}
.runtime-restart-banner {
  display: flex;
  gap: 0.7em;
  align-items: center;
  padding: 0.55em 1.2em;
  border-bottom: 1px solid color-mix(in srgb, var(--msc-danger) 45%, var(--msc-line));
  background: color-mix(in srgb, var(--msc-danger) 12%, var(--msc-surface));
  color: var(--msc-danger);
  font-size: 0.8em;
}
.runtime-restart-banner span { color: var(--msc-text-2); }
.source-unit-preview-banner {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35em;
  align-items: center;
  padding: 0.45em 1.4em;
  border-bottom: 1px solid var(--msc-line);
  background: color-mix(in srgb, var(--msc-kind-script) 9%, var(--msc-surface));
  color: var(--msc-text-2);
  font-size: 0.78em;
}
.source-unit-preview-banner b { color: var(--msc-text); }
.source-unit-preview-banner strong { color: var(--msc-ok); }
.source-unit-preview-banner strong.blocked { color: var(--msc-danger); }
.source-unit-preview-banner span { color: var(--msc-text-3); }
.diagnostics-detail { margin-top: 0.4em; font-size: 0.78em; }
.diagnostics-detail summary { cursor: pointer; opacity: 0.6; }
.diagnostics-grid { display: flex; flex-wrap: wrap; gap: 0.5em 1em; margin-top: 0.3em; }
.diagnostics-grid b { margin-left: 0.2em; }
.diagnostics-grid small { width: 100%; opacity: 0.5; }
</style>
