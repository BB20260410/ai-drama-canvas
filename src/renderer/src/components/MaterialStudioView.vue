<template>
  <section
    class="material-studio"
    data-testid="material-studio-view"
    :data-theme="shellTheme"
    :aria-busy="loading || detailLoading || Boolean(pendingAction)"
    @keydown.esc="closeCreateDialog">
    <header class="studio-header">
      <div class="project-identity">
        <span class="product-mark">AI 漫剧画布</span>
        <h1>{{ overview?.projectName || projectName || "Codex AI 短剧素材中心" }}</h1>
        <p>受管项目 · 仅访问当前工程 · 原媒体安全存放</p>
        <nav class="studio-mode-switch production-steps" role="navigation" aria-label="AI 短剧生产流程" data-testid="studio-production-steps">
          <button id="studio-step-script" type="button" data-testid="studio-step-script" aria-controls="studio-library-pane" :class="{ active: activeMode === 'library' && (activeSection === 'script' || activeSection === 'prompt') }" :disabled="Boolean(pendingAction)" @click="selectProductionStep('script')">1 剧本</button>
          <button id="studio-step-assets" type="button" data-testid="studio-step-assets" aria-controls="studio-library-pane" :class="{ active: activeMode === 'library' && ['character','scene','prop','style','media'].includes(activeSection) }" :disabled="Boolean(pendingAction)" @click="selectProductionStep('assets')">2 资产</button>
          <button id="studio-step-binding" type="button" data-testid="studio-step-binding" aria-controls="studio-binding-pane" :class="{ active: activeMode === 'binding' }" :disabled="!bindingApi || Boolean(pendingAction)" @click="selectProductionStep('binding')">3 绑定</button>
          <button id="studio-step-generation" type="button" data-testid="studio-step-generation" aria-controls="studio-generation-pane" :class="{ active: activeMode === 'generation' }" :disabled="Boolean(pendingAction)" @click="selectProductionStep('generation')">4 生成</button>
          <button id="studio-step-review" type="button" data-testid="studio-step-review" aria-controls="studio-continuity-review-pane" :class="{ active: activeMode === 'continuity-review' }" :disabled="!continuityReviewApi || Boolean(pendingAction)" @click="selectProductionStep('review')">5 审片</button>
        </nav>
        <nav class="studio-utility-switch" aria-label="工程视图">
          <button id="studio-mode-canvas" type="button" data-testid="studio-mode-canvas" aria-controls="studio-canvas-pane" :class="{ active: activeMode === 'canvas' }" :disabled="!dashboardApi || Boolean(pendingAction)" @click="selectStudioMode('canvas')">无限画布</button>
          <button id="studio-mode-dashboard" type="button" data-testid="studio-mode-dashboard" aria-controls="studio-dashboard-pane" :class="{ active: activeMode === 'dashboard' }" :disabled="!dashboardApi || Boolean(pendingAction)" @click="selectStudioMode('dashboard')">驾驶舱</button>
          <button id="studio-mode-multimedia-timeline" type="button" data-testid="studio-mode-multimedia-timeline" aria-controls="studio-multimedia-timeline-pane" :class="{ active: activeMode === 'multimedia-timeline' }" :disabled="!multimediaTimelineApi || Boolean(pendingAction)" @click="selectStudioMode('multimedia-timeline')">媒体时间线</button>
          <button id="studio-mode-script-align" type="button" data-testid="studio-mode-script-align" aria-controls="studio-script-align-pane" :class="{ active: activeMode === 'script-align' }" :disabled="!scriptAlignApi || Boolean(pendingAction)" @click="selectStudioMode('script-align')">图文对照</button>
          <button id="studio-mode-agent" type="button" data-testid="studio-mode-agent" aria-controls="studio-support-pane" :class="{ active: activeMode === 'agent' }" :disabled="Boolean(pendingAction)" @click="selectStudioMode('agent')">Agent 连接</button>
          <button id="studio-mode-help" type="button" data-testid="studio-mode-help" aria-controls="studio-support-pane" :class="{ active: activeMode === 'help' }" :disabled="Boolean(pendingAction)" @click="selectStudioMode('help')">帮助 / 备份</button>
        </nav>
      </div>

      <div v-if="activeMode === 'library'" class="project-counts" aria-label="素材统计">
        <div><strong>{{ overview?.counts.total ?? 0 }}</strong><span>全部素材</span></div>
        <div><strong>{{ overview?.counts.textDocuments ?? 0 }}</strong><span>剧本 / 提示词</span></div>
        <div><strong>{{ overview?.counts.canonicalAssets ?? 0 }}</strong><span>规范资产</span></div>
        <div><strong>{{ overview?.counts.media ?? 0 }}</strong><span>媒体</span></div>
      </div>

      <div class="next-action" aria-live="polite">
        <span>唯一下一步</span>
        <p>{{ loading ? "正在读取下一步…" : friendlyMaterialText(overview?.nextAction || "当前下一步不可用，请刷新后重试。") }}</p>
      </div>

      <div class="header-actions">
        <label class="generation-provider-selector" data-testid="studio-generation-provider-selector">
          <span>生图 Agent</span>
          <select v-model="generationProvider" :disabled="Boolean(pendingAction)" aria-label="正式生图供应方">
            <option value="codex">Codex</option>
            <option value="grok">Grok</option>
          </select>
        </label>
        <button type="button" class="primary-action continue-action" data-testid="studio-continue-action" :disabled="loading || Boolean(pendingAction) || !overview?.nextActionControl" @click="continueFromCore">
          <ChevronRight :size="16" aria-hidden="true" /><span>继续</span>
        </button>
        <button v-if="api.openProjectCenter" type="button" class="quiet-action" data-testid="studio-open-project-center" :disabled="Boolean(pendingAction)" @click="api.openProjectCenter()">
          <FolderKanban :size="15" aria-hidden="true" />
          <span>项目</span>
        </button>
        <button v-if="activeMode === 'library'" type="button" class="quiet-action" :disabled="Boolean(pendingAction)" @click="refresh">
          <RefreshCw :size="15" :class="{ spinning: loading }" aria-hidden="true" />
          <span>刷新</span>
        </button>
        <button v-if="activeMode === 'library'" type="button" class="primary-action" :disabled="Boolean(pendingAction)" @click="importMedia">
          <FileInput :size="16" aria-hidden="true" />
          <span>导入媒体</span>
        </button>
      </div>
    </header>

    <div
      v-if="activeMode === 'canvas'"
      id="studio-canvas-pane"
      class="binding-mode"
      role="tabpanel"
      aria-labelledby="studio-mode-canvas">
      <Suspense v-if="dashboardApi">
        <AsyncManagedStudioCanvasView
          :project-root="projectRoot"
          :project-name="projectName"
          :api="dashboardApi"
          :generation-provider="generationProvider"
          :focus="canvasFocus"
          @failed="onDashboardFailed"
          @open-dashboard="onCanvasOpenDashboard"
          @open-binding="onCanvasOpenBinding"
          @open-review="onCanvasOpenReview"
          @request-generation="onCanvasRequestGeneration" />
        <template #fallback>
          <div class="binding-loading" role="status">
            <LoaderCircle :size="22" class="spinning" aria-hidden="true" />
            <span>正在加载受管 Studio 无限画布…</span>
          </div>
        </template>
      </Suspense>
      <div v-else class="binding-loading" role="alert">当前桌面适配层未接入受管画布投影。</div>
    </div>

    <div
      v-else-if="activeMode === 'script-align'"
      id="studio-script-align-pane"
      class="binding-mode"
      role="tabpanel"
      aria-labelledby="studio-mode-script-align"
      data-testid="studio-script-align-pane">
      <Suspense v-if="scriptAlignApi">
        <AsyncScriptMediaAlignView
          :project-root="projectRoot"
          :api="scriptAlignApi"
          @open-unit="onScriptOpenUnit"
          @failed="onDashboardFailed" />
        <template #fallback>
          <div class="binding-loading" role="status">
            <LoaderCircle :size="22" class="spinning" aria-hidden="true" />
            <span>正在加载图文对照…</span>
          </div>
        </template>
      </Suspense>
      <div v-else class="binding-loading" role="alert">当前桌面适配层未接入图文对照投影。</div>
    </div>

    <div
      v-else-if="activeMode === 'dashboard'"
      id="studio-dashboard-pane"
      class="binding-mode"
      role="tabpanel"
      aria-labelledby="studio-mode-dashboard">
      <Suspense v-if="dashboardApi">
        <AsyncStudioProductionDashboardView
          :project-root="projectRoot"
          :project-name="projectName"
          :api="dashboardApi"
          :generation-provider="generationProvider"
          :focus="dashboardFocus"
          @failed="onDashboardFailed"
          @open-canvas="onDashboardOpenCanvas"
          @open-review="onCanvasOpenReview" />
        <template #fallback>
          <div class="binding-loading" role="status">
            <LoaderCircle :size="22" class="spinning" aria-hidden="true" />
            <span>正在加载生产驾驶舱…</span>
          </div>
        </template>
      </Suspense>
      <div v-else class="binding-loading" role="alert">当前桌面适配层未接入生产驾驶舱投影。</div>
    </div>

    <div
      v-else-if="activeMode === 'multimedia-timeline'"
      id="studio-multimedia-timeline-pane"
      class="binding-mode"
      role="tabpanel"
      aria-labelledby="studio-mode-multimedia-timeline">
      <Suspense v-if="multimediaTimelineApi">
        <AsyncStudioMultimediaTimelineView
          :project-root="projectRoot"
          :api="multimediaTimelineApi" />
        <template #fallback>
          <div class="binding-loading" role="status">
            <LoaderCircle :size="22" class="spinning" aria-hidden="true" />
            <span>正在加载四媒体时间线…</span>
          </div>
        </template>
      </Suspense>
      <div v-else class="binding-loading" role="alert">当前桌面适配层未接入四媒体时间线投影。</div>
    </div>

    <div
      v-else-if="activeMode === 'library'"
      id="studio-library-pane"
      class="studio-body"
      :class="{ 'with-detail': detailLoading || detail }"
      role="tabpanel"
      aria-labelledby="studio-step-script">
      <nav class="section-rail" aria-label="素材分类">
        <div class="rail-heading">
          <span>工程素材</span>
          <small>本地受管</small>
        </div>
        <button
          v-for="section in sections"
          :key="section.id"
          type="button"
          class="rail-entry"
          :class="{ active: activeSection === section.id }"
          :aria-current="activeSection === section.id ? 'page' : undefined"
          :disabled="Boolean(pendingAction)"
          @click="selectSection(section.id)">
          <component :is="section.icon" :size="17" aria-hidden="true" />
          <span>{{ section.label }}</span>
          <b>{{ countFor(section.id) }}</b>
        </button>

        <div class="rail-create">
          <span>建立规范资产</span>
          <button type="button" :disabled="Boolean(pendingAction)" @click="openCreateDialog('character')"><UserRound :size="14" aria-hidden="true" />角色</button>
          <button type="button" :disabled="Boolean(pendingAction)" @click="openCreateDialog('scene')"><Mountain :size="14" aria-hidden="true" />场景</button>
          <button type="button" :disabled="Boolean(pendingAction)" @click="openCreateDialog('prop')"><Package :size="14" aria-hidden="true" />道具</button>
          <button type="button" :disabled="Boolean(pendingAction)" @click="openCreateDialog('style')"><Palette :size="14" aria-hidden="true" />风格</button>
        </div>

        <div class="isolation-note">
          <ShieldCheck :size="16" aria-hidden="true" />
          <p><b>已隔离旧工程</b><span>打开时不扫描其他项目或原媒体目录。</span></p>
        </div>
      </nav>

      <main class="material-browser">
        <div class="browser-toolbar">
          <label class="search-field">
            <Search :size="16" aria-hidden="true" />
            <span class="sr-only">搜索当前素材</span>
            <input
              v-model="searchInput"
              type="search"
              autocomplete="off"
              :placeholder="searchPlaceholder"
              aria-label="搜索当前素材" />
            <button v-if="searchInput" type="button" aria-label="清空搜索" @click="searchInput = ''">
              <X :size="14" aria-hidden="true" />
            </button>
          </label>

          <span class="result-scope">{{ sectionLabel(activeSection) }} · {{ visibleTotal }} 项</span>
          <div class="view-switch" aria-label="显示方式">
            <button type="button" :class="{ active: viewMode === 'grid' }" :aria-pressed="viewMode === 'grid'" aria-label="宫格显示" @click="viewMode = 'grid'">
              <Grid2X2 :size="15" aria-hidden="true" />
            </button>
            <button type="button" :class="{ active: viewMode === 'list' }" :aria-pressed="viewMode === 'list'" aria-label="列表显示" @click="viewMode = 'list'">
              <List :size="16" aria-hidden="true" />
            </button>
          </div>
        </div>

        <div v-if="error" class="error-banner" role="alert">
          <CircleAlert :size="16" aria-hidden="true" />
          <span>{{ error }}</span>
          <button type="button" @click="error = ''">关闭</button>
        </div>
        <p v-if="notice" class="operation-notice" role="status">{{ notice }}</p>

        <section class="entries-region" :aria-label="`${sectionLabel(activeSection)}素材`">
          <div v-if="loading && !entries.length" class="loading-state" role="status">
            <LoaderCircle :size="22" class="spinning" aria-hidden="true" />
            <span>正在读取当前工程的轻量索引…</span>
          </div>

          <div v-else-if="!entries.length" class="empty-state">
            <component :is="activeSectionIcon" :size="32" aria-hidden="true" />
            <h2>{{ searchQuery ? "没有匹配结果" : `${sectionLabel(activeSection)}还是空的` }}</h2>
            <p v-if="searchQuery">换一个名称、别名或用途关键词。</p>
            <p v-else-if="isAssetSection(activeSection)">先建立资产身份，再附加已审核的参考版本。</p>
            <p v-else-if="activeSection === 'script'">导入剧本后，正文会保存为历史版本（不可改）。</p>
            <p v-else-if="activeSection === 'prompt'">导入提示词后，可按名称检索并查看冻结正文与来源。</p>
            <p v-else>导入图片、视频或音频；列表只读缩略图和轻量元数据。</p>
            <button v-if="isAssetSection(activeSection)" type="button" class="primary-action" @click="openCreateDialog(activeSection)">
              <Plus :size="15" aria-hidden="true" />创建{{ sectionLabel(activeSection) }}
            </button>
            <button v-else-if="activeSection === 'script'" type="button" class="primary-action" :disabled="Boolean(pendingAction)" @click="importScript">
              <FileInput :size="15" aria-hidden="true" />导入剧本
            </button>
            <button v-else-if="activeSection === 'prompt'" type="button" class="primary-action" :disabled="Boolean(pendingAction)" @click="importPrompt">
              <FileInput :size="15" aria-hidden="true" />导入提示词
            </button>
            <button v-else type="button" class="primary-action" :disabled="Boolean(pendingAction)" @click="importMedia">
              <FileInput :size="15" aria-hidden="true" />导入媒体
            </button>
          </div>

          <div v-else class="entry-collection" :class="viewMode">
            <button
              v-for="entry in entries"
              :key="entry.id"
              type="button"
              class="material-entry"
              :class="{ selected: selectedId === entry.id, 'source-selected': selectedMedia?.entryId === entry.id }"
              :aria-pressed="selectedId === entry.id"
              :disabled="Boolean(pendingAction)"
              @click="selectEntry(entry)">
              <figure>
                <img
                  v-if="entry.thumbnailUrl"
                  :src="entry.thumbnailUrl"
                  :alt="`${entry.title}缩略图`"
                  loading="lazy"
                  decoding="async" />
                <span v-else><component :is="iconForEntry(entry)" :size="23" aria-hidden="true" /></span>
                <em v-if="entry.authorityState === 'locked'" class="authority-marker"><LockKeyhole :size="11" aria-hidden="true" />权威</em>
                <em v-if="selectedMedia?.entryId === entry.id" class="source-marker"><Check :size="11" aria-hidden="true" />已选版本源</em>
              </figure>
              <div class="entry-copy">
                <span>{{ kindLabel(entry.kind) }}<template v-if="entry.episode"> · EP{{ String(entry.episode).padStart(2, "0") }}</template></span>
                <strong>{{ entry.title }}</strong>
                <p>{{ entry.subtitle || entry.summary || "尚未填写说明" }}</p>
                <footer><small>{{ entry.meta || authorityLabel(entry.authorityState) }}</small><time v-if="entry.updatedAt">{{ formatDate(entry.updatedAt) }}</time></footer>
              </div>
              <ChevronRight v-if="viewMode === 'list'" :size="15" class="row-arrow" aria-hidden="true" />
            </button>
          </div>

          <div v-if="entries.length" class="page-navigation" aria-label="素材分页">
            <button
              type="button"
              data-testid="material-page-previous"
              :disabled="!canLoadPrevious || loadingMore"
              @click="loadPreviousPage">
              <ChevronLeft :size="14" aria-hidden="true" />
              <span>上一页</span>
            </button>
            <span data-testid="material-page-indicator">第 {{ currentPageNumber }} 页 · 本页 {{ entries.length }} / 共 {{ visibleTotal }} 项</span>
            <button
              type="button"
              data-testid="material-page-next"
              :disabled="!nextCursor || loadingMore"
              @click="loadNextPage">
              <LoaderCircle v-if="loadingMore" :size="14" class="spinning" aria-hidden="true" />
              <span>{{ loadingMore ? "正在换页" : "下一页" }}</span>
              <ChevronRight v-if="!loadingMore" :size="14" aria-hidden="true" />
            </button>
          </div>
        </section>
      </main>

      <aside v-if="detailLoading || detail" class="detail-inspector" aria-label="素材详情">
        <div v-if="detailLoading" class="detail-placeholder" role="status">
          <LoaderCircle :size="21" class="spinning" aria-hidden="true" />
          <span>按需读取详情…</span>
        </div>
        <div v-else-if="!detail" class="detail-placeholder">
          <PanelRight :size="28" aria-hidden="true" />
          <h2>选择一项素材</h2>
          <p>只在选中后读取版本、权威图、一致性锁和提示词。</p>
        </div>
        <template v-else>
          <header class="detail-header">
            <span>{{ kindLabel(detail.kind) }}</span>
            <h2>{{ detail.title }}</h2>
            <p>{{ detail.description || "尚未填写资产说明。" }}</p>
          </header>

          <section v-if="detail.textDocument" class="detail-section text-document-section">
            <div class="section-title">
              <span>{{ detail.textDocument.kind === 'script' ? '剧本正文' : '提示词正文' }}</span>
              <b>{{ formatBytes(detail.textDocument.bodySizeBytes) }}</b>
            </div>
            <pre>{{ compactTextPreview(detail.textDocument.bodyPreview, detail.textDocument.kind) }}</pre>
            <p v-if="detail.textDocument.truncated || compactTextPreview(detail.textDocument.bodyPreview, detail.textDocument.kind).length < detail.textDocument.bodyPreview.length">正文较长，普通界面仅显示摘要；完整内容可在诊断详情查看。</p>
            <details class="technical-diagnostics"><summary>诊断详情</summary><pre>{{ detail.textDocument.bodyPreview }}</pre><dl><dt>文档 ID</dt><dd>{{ detail.id }}</dd><dt>修订</dt><dd>r{{ detail.revision }}</dd><dt>SHA</dt><dd>{{ shortSha(detail.textDocument.bodySha256) }}</dd><dt>来源</dt><dd>{{ detail.textDocument.source }}</dd><dt>版本</dt><dd>{{ detail.textDocument.sourceVersion }}</dd></dl>
              <div class="text-revision-history" data-testid="studio-text-revision-history">
                <b>修订历史（最新在前，仅前 20 条）</b>
                <p v-if="textRevisionsLoading" role="status">正在读取修订历史…</p>
                <p v-else-if="textRevisionsError" class="error-text" role="alert">{{ textRevisionsError }}</p>
                <ol v-else-if="textRevisions.length">
                  <li v-for="revision in textRevisions" :key="revision.id" :class="{ head: revision.ordinal === detail.revision }">
                    r{{ revision.ordinal }} · <code>{{ revision.id }}</code> · {{ shortSha(revision.bodySha256) }}
                    <template v-if="revision.ordinal === detail.revision">（当前）</template>
                  </li>
                </ol>
              </div>
            </details>
          </section>

          <section v-if="isMediaKind(detail.kind) && selectedMedia" class="selected-media-detail">
            <div><Check :size="16" aria-hidden="true" /><span><b>{{ selectedMediaCanBecomeAuthority ? "已选为新版本来源" : "已选媒体（不可作权威版本）" }}</b></span></div>
            <button type="button" :disabled="Boolean(pendingAction)" @click="clearSelectedMedia">取消选择</button>
          </section>

          <section v-if="isMediaKind(detail.kind)" class="authority-visual media-preview-section">
            <div class="section-title"><span>按需媒体预览</span><b>{{ mediaPreviewStatusLabel(detail.mediaPreview?.status) }}</b></div>
            <figure>
              <img
                v-if="detail.authorityThumbnailUrl"
                :src="detail.authorityThumbnailUrl"
                :alt="`${detail.title}轻量预览`"
                loading="lazy"
                decoding="async" />
              <span v-else><Film :size="30" aria-hidden="true" />{{ detail.mediaPreview?.message || "尚无可用轻量预览" }}</span>
            </figure>
            <video
              v-if="detail.kind === 'video' && detail.mediaPreview?.playbackUrl"
              class="media-player"
              :src="detail.mediaPreview.playbackUrl"
              controls
              playsinline
              preload="metadata" />
            <audio
              v-else-if="detail.kind === 'audio' && detail.mediaPreview?.playbackUrl"
              class="media-player audio-player"
              :src="detail.mediaPreview.playbackUrl"
              controls
              preload="metadata" />
            <p class="media-preview-note">{{ detail.mediaPreview?.message }}</p>
          </section>

          <section v-else class="authority-visual">
            <div class="section-title"><span>当前权威图</span><b>{{ detail.primaryAuthority ? "已锁定" : "未锁定" }}</b></div>
            <figure>
              <img
                v-if="detail.authorityThumbnailUrl"
                :src="detail.authorityThumbnailUrl"
                :alt="`${detail.title}当前权威图缩略图`"
                loading="lazy"
                decoding="async" />
              <span v-else><ImageIcon :size="30" aria-hidden="true" />尚无已审定权威图</span>
            </figure>
            <details v-if="detail.primaryAuthority" class="technical-diagnostics"><summary>诊断详情</summary><dl><dt>版本 ID</dt><dd>{{ detail.primaryAuthority.versionId }}</dd><dt>SHA</dt><dd>{{ shortSha(detail.primaryAuthority.mediaSha256) }}</dd></dl></details>
          </section>

          <section v-if="isAssetKind(detail.kind)" class="detail-section cross-project-reuse" data-testid="cross-project-asset-reuse">
            <div class="section-title"><span>跨工程复用</span><b>目标项目重新审核</b></div>
            <p>导出为只读内容寻址快照；导入永远先成为目标工程 pending 候选，不会沿用源工程 Primary。</p>
            <div class="reuse-actions">
              <button
                type="button"
                data-testid="cross-project-asset-export"
                :disabled="Boolean(pendingAction) || !detail.primaryAuthority || !api.exportCrossProjectAssetPackage"
                @click="exportCurrentAssetPackage"
              >导出当前 Primary</button>
              <button
                type="button"
                data-testid="cross-project-asset-pick-package"
                :disabled="Boolean(pendingAction) || !api.pickCrossProjectAssetPackage"
                @click="pickCrossProjectAssetPackage"
              >选择复用包</button>
            </div>
            <div v-if="crossProjectPackage" class="reuse-package" data-testid="cross-project-asset-package">
              <b>来源项目 {{ crossProjectPackage.manifest.sourceProjectId }}</b>
              <code>{{ shortSha(crossProjectPackage.manifest.fingerprint) }}</code>
              <article v-for="item in crossProjectPackage.manifest.items" :key="`${item.assetId}:${item.versionId}`">
                <div>
                  <b>{{ item.definitionSnapshot.name }}</b>
                  <span>{{ kindLabel(item.assetCategory) }} · 源 Primary v{{ item.versionOrdinal }}</span>
                </div>
                <button
                  type="button"
                  :data-testid="`cross-project-asset-import-${item.assetId}`"
                  :disabled="Boolean(pendingAction) || !api.importCrossProjectAssetPackage"
                  @click="importCrossProjectAssetItem(item.assetId, item.versionId, item.assetCategory)"
                >导入为 pending</button>
              </article>
            </div>
          </section>

          <section v-if="isAssetKind(detail.kind)" class="detail-section version-intake">
            <div class="section-title"><span>追加参考版本</span><b>先存为待审核</b></div>
            <template v-if="selectedMedia && selectedMediaCanBecomeAuthority">
              <div class="selected-source">
                <figure>
                  <img v-if="selectedMedia.thumbnailUrl" :src="selectedMedia.thumbnailUrl" :alt="`${selectedMedia.title}缩略图`" loading="lazy" decoding="async" />
                  <span v-else><Film :size="20" aria-hidden="true" /></span>
                </figure>
                <div><b>{{ selectedMedia.title }}</b><span>{{ kindLabel(selectedMedia.kind) }}</span></div>
                <button type="button" :disabled="Boolean(pendingAction)" aria-label="取消选中的版本媒体" @click="clearSelectedMedia"><X :size="14" aria-hidden="true" /></button>
              </div>
              <label>
                <span>来源说明</span>
                <textarea v-model="versionSourceNote" rows="3" maxlength="4000" :disabled="Boolean(pendingAction)" placeholder="写明图片来源、角度、用途和为何属于该资产。" />
              </label>
              <button
                type="button"
                class="append-version-action"
                :disabled="Boolean(pendingAction) || !versionSourceNote.trim() || !api.appendPendingAssetVersion"
                @click="appendSelectedMediaVersion">
                <LoaderCircle v-if="pendingAction === 'append-version'" :size="14" class="spinning" aria-hidden="true" />
                <Plus v-else :size="14" aria-hidden="true" />
                追加为待审核版本
              </button>
              <small v-if="!api.appendPendingAssetVersion">当前接入层尚未启用版本写入。</small>
            </template>
            <div v-else class="source-empty">
              <p v-if="selectedMedia">当前选中的是{{ kindLabel(selectedMedia.kind) }}。视频和音频可存放、播放和进入时间线，但规范资产的权威版本只接受图片。</p>
              <p v-else>先从媒体库选择一张图片；画布仅使用轻量预览，不直接装载原图。</p>
              <button type="button" :disabled="Boolean(pendingAction)" @click="selectSection('media')">去选择媒体<ChevronRight :size="13" aria-hidden="true" /></button>
            </div>
          </section>

          <section v-if="detail.aliases?.length" class="detail-section">
            <h3>身份与别名</h3>
            <div class="token-line"><span v-for="alias in detail.aliases" :key="alias">{{ alias }}</span></div>
          </section>

          <section v-if="isAssetKind(detail.kind)" class="detail-section applicability-section">
            <h3>适用范围</h3>
            <div class="token-line"><span v-for="token in applicabilityTokens(detail.applicability)" :key="token">{{ token }}</span></div>
            <p>范围参与后续宫格生图门禁；标签只用于检索，不会绕过集、单元或秒段限制。</p>
          </section>

          <section v-if="detail.identityFeatures?.length" class="detail-section">
            <h3>身份特征</h3>
            <ul class="plain-list"><li v-for="feature in detail.identityFeatures" :key="feature">{{ feature }}</li></ul>
          </section>

          <section v-if="detail.positiveLocks?.length || detail.negativeLocks?.length" class="detail-section locks-section">
            <h3>一致性锁</h3>
            <div v-if="detail.positiveLocks?.length"><span>必须保持</span><ul><li v-for="rule in detail.positiveLocks" :key="rule">{{ rule }}</li></ul></div>
            <div v-if="detail.negativeLocks?.length" class="negative"><span>禁止出现</span><ul><li v-for="rule in detail.negativeLocks" :key="rule">{{ rule }}</li></ul></div>
          </section>

          <section v-if="detail.prompt" class="detail-section prompt-section">
            <h3>冻结提示词</h3><p>一致性提示词已锁定；普通界面不展开长提示词。</p>
            <details class="technical-diagnostics"><summary>诊断详情</summary><div v-if="detail.prompt.positive"><span>正向</span><p>{{ detail.prompt.positive }}</p></div><div v-if="detail.prompt.negative"><span>禁止</span><p>{{ detail.prompt.negative }}</p></div><footer v-if="detail.prompt.frozenPackId"><LockKeyhole :size="12" aria-hidden="true" />{{ detail.prompt.frozenPackId }}</footer></details>
          </section>

          <section v-if="isAssetKind(detail.kind)" class="detail-section relations-section">
            <div class="section-title"><span>派生与组合关系</span><b>{{ detail.relations?.length ?? 0 }} 条</b></div>
            <div v-if="detail.relations?.length" class="relation-list">
              <article v-for="relation in detail.relations" :key="relation.id">
                <header>
                  <b>{{ relationLabel(relation.kind) }}</b>
                  <span :class="`relation-status-${relation.status}`">{{ relationStatusLabel(relation.status) }}</span>
                </header>
                <small>{{ relationDirection(relation, detail.id) }}</small>
                <small v-if="relation.role || relation.note">{{ relation.role }}{{ relation.role && relation.note ? " · " : "" }}{{ relation.note }}</small>
                <details class="technical-diagnostics"><summary>诊断详情</summary><code>{{ relation.id }} · {{ relationOtherAsset(relation, detail.id) }} · r{{ relation.revision }}</code><small v-if="relation.supersedesRelationId">替代 {{ relation.supersedesRelationId }}</small><small v-if="relation.supersededByRelationId">已由 {{ relation.supersededByRelationId }} 替代</small></details>
                <button
                  v-if="relation.head && relation.status === 'stale' && api.rebaseAssetRelation"
                  type="button"
                  class="relation-rebase-action"
                  :disabled="Boolean(pendingAction)"
                  @click="rebaseRelation(relation)"
                >
                  <LoaderCircle v-if="pendingAction === `rebase-relation:${relation.id}`" :size="12" class="spinning" aria-hidden="true" />
                  <RefreshCw v-else :size="12" aria-hidden="true" />重建当前关系
                </button>
              </article>
            </div>
            <p v-else class="relation-empty">尚无派生或组合来源；普通独立资产可以保持为空。</p>
            <details class="asset-relation-editor" @toggle="onRelationEditorToggle"><summary>关联另一个资产</summary><div class="relation-intake">
              <label><span>关系类型</span><select v-model="relationDraft.kind" :disabled="Boolean(pendingAction)">
                <option value="derived_from">派生自</option>
                <option value="variant_of">变体自</option>
                <option value="reference_of">参考自</option>
                <option value="composite_member">添加组合成员</option>
              </select></label>
              <label><span>查找资产</span><input v-model="relationSearch" maxlength="256" :disabled="Boolean(pendingAction)" placeholder="输入角色、场景或道具名称" @input="scheduleRelationCandidateSearch" /></label>
              <label><span>关联资产</span><select v-model="relationDraft.relatedAssetId" data-testid="relation-asset-select" :disabled="Boolean(pendingAction) || relationCandidatesLoading">
                <option value="">{{ relationCandidatesLoading ? "正在查找…" : "请选择资产" }}</option>
                <option v-for="candidate in relationCandidates" :key="candidate.id" :value="candidate.id.replace(/^asset:/u, '')">{{ kindLabel(candidate.kind) }} · {{ candidate.title }}</option>
              </select></label>
              <label v-if="relationDraft.kind === 'composite_member'"><span>成员顺序</span><input v-model.number="relationDraft.ordinal" type="number" min="1" max="10000" :disabled="Boolean(pendingAction)" /></label>
              <label><span>关系角色</span><input v-model="relationDraft.role" maxlength="256" :disabled="Boolean(pendingAction)" placeholder="例：左侧角色、服装变体" /></label>
              <label class="relation-note"><span>关系说明</span><textarea v-model="relationDraft.note" rows="2" maxlength="4000" :disabled="Boolean(pendingAction)" placeholder="写明组合或派生依据。" /></label>
              <button type="button" class="append-version-action" :disabled="Boolean(pendingAction) || !relationDraft.relatedAssetId || !api.appendAssetRelation" @click="appendRelation">
                <LoaderCircle v-if="pendingAction === 'append-relation'" :size="14" class="spinning" aria-hidden="true" />
                <Plus v-else :size="14" aria-hidden="true" />追加关系
              </button>
            </div></details>
            <small v-if="!api.appendAssetRelation">当前接入层尚未启用关系写入。</small>
          </section>

          <section v-if="detail.versions?.length" class="detail-section versions-section">
            <h3>版本历史</h3>
            <p v-if="hasPendingVersions && !api.reviewPendingAssetVersion" class="workflow-disabled-note">当前接入层尚未启用版本审核。</p>
            <article v-for="version in detail.versions" :key="version.id" :class="[version.reviewStatus, { primary: version.isPrimary }]">
              <header>
                <div><b>v{{ version.ordinal }}</b><span :class="`review-${version.reviewStatus}`">{{ reviewLabel(version.reviewStatus) }}</span><em v-if="version.isPrimary">当前权威</em></div>
                <div class="version-meta"><time v-if="version.createdAt">{{ formatDate(version.createdAt) }}</time><details class="technical-diagnostics"><summary>诊断详情</summary><code>{{ version.id }} · {{ shortSha(version.mediaSha256) }}</code></details></div>
              </header>
              <button
                v-if="version.mediaUrl"
                type="button"
                class="version-visual"
                :aria-label="`按原图检查 ${detail.title} v${version.ordinal}`"
                :disabled="Boolean(pendingAction)"
                @click="openVersionPreview(version)">
                <img
                  v-if="version.thumbnailUrl"
                  :src="version.thumbnailUrl"
                  :alt="`${detail.title} v${version.ordinal} 待审缩略图`"
                  loading="lazy"
                  decoding="async" />
                <span v-else><ImageIcon :size="24" aria-hidden="true" />缩略图未就绪，点击按需检查受管原图</span>
                <em>原图检查</em>
              </button>
              <p v-if="version.sourceNote" class="source-note"><b>来源</b>{{ version.sourceNote }}</p>
              <p v-if="version.reviewNote" class="review-note"><b>审核</b>{{ version.reviewNote }}</p>
              <div v-if="version.reviewStatus === 'pending'" class="review-controls">
                <label>
                  <span>审核说明</span>
                  <textarea v-model="reviewDrafts[version.id]" rows="2" maxlength="4000" :disabled="Boolean(pendingAction)" placeholder="记录一致性核对依据，批准或拒绝时必填。" />
                </label>
                <div>
                  <button type="button" class="reject-action" :disabled="!canReviewVersion(version)" @click="reviewVersion(version, 'rejected')">拒绝</button>
                  <button type="button" class="approve-action" :disabled="!canReviewVersion(version)" @click="reviewVersion(version, 'approved')">批准</button>
                </div>
              </div>
              <button
                v-if="version.reviewStatus === 'approved' && !version.isPrimary && isAssetKind(detail.kind)"
                type="button"
                class="promote-action"
                :disabled="Boolean(pendingAction)"
                @click="promoteAuthority(version)">
                <LockKeyhole :size="12" aria-hidden="true" />提升为硬锁权威
              </button>
            </article>
          </section>

          <section class="codex-handoff">
            <Bot :size="18" aria-hidden="true" />
            <div><b>此界面不执行生图</b><span>后续由 Codex 根据已冻结的权威版本、正向锁和禁止项组装生图包，结果再回存当前工程。</span></div>
          </section>
        </template>
      </aside>
    </div>

    <div
      v-else-if="activeMode === 'binding'"
      id="studio-binding-pane"
      class="binding-mode"
      role="tabpanel"
      aria-labelledby="studio-step-binding">
      <Suspense v-if="bindingApi">
        <AsyncStudioBindingWorkbench
          :project-root="projectRoot"
          :api="bindingApi"
          :initial-unit-id="bindingFocus.unitId"
          :initial-panel-id="bindingFocus.panelId"
          @changed="onBindingChanged"
          @failed="onBindingFailed" />
        <template #fallback>
          <div class="binding-loading" role="status">
            <LoaderCircle :size="22" class="spinning" aria-hidden="true" />
            <span>正在加载剧本绑定工作台…</span>
          </div>
        </template>
      </Suspense>
      <div v-else class="binding-loading" role="alert">当前桌面适配层未接入剧本绑定投影。</div>
    </div>

    <div
      v-else-if="activeMode === 'continuity-review'"
      id="studio-continuity-review-pane"
      class="binding-mode"
      role="tabpanel"
      aria-labelledby="studio-step-review">
      <Suspense v-if="continuityReviewApi">
        <AsyncStudioContinuityReviewView
          :project-root="projectRoot"
          :api="continuityReviewApi"
          :focus="reviewFocus"
          @review-changed="onGenerationQueueChanged"
          @request-canvas="selectStudioMode('canvas')"
          @failed="onContinuityReviewFailed" />
        <template #fallback>
          <div class="binding-loading" role="status">
            <LoaderCircle :size="22" class="spinning" aria-hidden="true" />
            <span>正在按需加载连续性 / Review 控制面…</span>
          </div>
        </template>
      </Suspense>
      <div v-else class="binding-loading" role="alert">当前桌面适配层未接入连续性 / Review 只读投影。</div>
    </div>

    <div
      v-else-if="activeMode === 'generation'"
      id="studio-generation-pane"
      class="binding-mode generation-mode"
      role="tabpanel"
      aria-labelledby="studio-step-generation"
      data-testid="studio-generation-pane">
      <Suspense v-if="dashboardApi">
        <AsyncStudioGenerationControlView
          :project-root="projectRoot"
          :api="dashboardApi"
          :unit-id="bindingFocus.unitId || undefined"
          :panel-id="bindingFocus.panelId || undefined"
          @failed="onGenerationQueueFailed"
          @open-canvas="onDashboardOpenCanvas"
          @open-binding="onCanvasOpenBinding"
          @open-review="onCanvasOpenReview" />
        <template #fallback>
          <div class="binding-loading" role="status">
            <LoaderCircle :size="22" class="spinning" aria-hidden="true" />
            <span>正在加载受管 Studio 生图派发…</span>
          </div>
        </template>
      </Suspense>
      <div v-else class="binding-loading" role="alert">当前桌面适配层未接入受管 Studio 生图派发。</div>
    </div>

    <div id="studio-support-pane" v-else-if="activeMode === 'agent' || activeMode === 'help'" class="binding-mode support-mode" role="tabpanel" :aria-labelledby="activeMode === 'agent' ? 'studio-mode-agent' : 'studio-mode-help'" data-testid="studio-support-pane">
      <AsyncDesktopSupportView
        :project-root="projectRoot"
        :section="activeMode"
        @restored="$emit('projectRestored', $event)"
        @failed="$emit('failed', $event)" />
    </div>

    <footer v-if="activeMode === 'library'" class="timeline-dock">
      <div class="timeline-label">
        <Clock3 :size="18" aria-hidden="true" />
        <div><span>15 秒时间线</span><b>{{ friendlyMaterialText(overview?.timeline.currentLabel || "等待剧本分镜") }}</b></div>
      </div>
      <div class="timeline-track" :aria-label="friendlyMaterialText(overview?.timeline.currentLabel || '15 秒时间线概览')">
        <template v-if="overview?.timeline.segments?.length">
          <span
            v-for="segment in overview.timeline.segments"
            :key="segment.id"
            :class="{ complete: segment.status === 'complete', current: segment.status === 'current' }"
            :style="{ flexGrow: Math.max(segment.durationSeconds, 0.5) }">
            <i>{{ segment.label }}</i><small>{{ segment.durationSeconds }} 秒</small>
          </span>
        </template>
        <span v-else class="timeline-empty"><i>导入剧本后在此显示镜头节奏</i><small>0 / 15 秒</small></span>
      </div>
      <div class="timeline-summary">
        <span>{{ overview?.timeline.unitCount ?? 0 }} 个单元</span>
        <span>{{ overview?.timeline.completedUnitCount ?? 0 }} 个已审片槽位</span>
      </div>
      <button type="button" :disabled="Boolean(pendingAction) || !bindingApi" @click="openTimeline">
        进入剧本绑定<ChevronRight :size="15" aria-hidden="true" />
      </button>
    </footer>

    <div v-if="versionPreview" class="dialog-backdrop version-preview-backdrop" role="presentation" @mousedown.self="closeVersionPreview">
      <section class="version-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="version-preview-title">
        <header>
          <div>
            <span>MANAGED CAS ORIGINAL</span>
            <h2 id="version-preview-title">{{ detail?.title }} · v{{ versionPreview.ordinal }}</h2>
          </div>
          <button type="button" aria-label="关闭原图检查" @click="closeVersionPreview"><X :size="17" aria-hidden="true" /></button>
        </header>
        <figure>
          <img :src="versionPreview.mediaUrl" :alt="`${detail?.title || '资产'} v${versionPreview.ordinal} 受管原图`" />
        </figure>
        <footer>
          <span>{{ reviewLabel(versionPreview.reviewStatus) }}</span>
          <code>{{ versionPreview.mediaSha256 }}</code>
          <p>这里只查看已受管 CAS 原图；批准、拒绝和提升权威仍在版本卡片中分别执行。</p>
        </footer>
      </section>
    </div>

    <div v-if="createDialogOpen" class="dialog-backdrop" role="presentation" @mousedown.self="closeCreateDialog">
      <form class="create-dialog" role="dialog" aria-modal="true" aria-labelledby="create-asset-title" @submit.prevent="createAsset">
        <header>
          <div><span>CANONICAL ASSET</span><h2 id="create-asset-title">创建规范资产</h2></div>
          <button type="button" aria-label="关闭创建窗口" @click="closeCreateDialog"><X :size="17" aria-hidden="true" /></button>
        </header>
        <fieldset>
          <legend>资产类别</legend>
          <div class="category-choice">
            <button v-for="category in assetCategories" :key="category.id" type="button" :class="{ active: createDraft.category === category.id }" @click="createDraft.category = category.id">
              <component :is="category.icon" :size="16" aria-hidden="true" />{{ category.label }}
            </button>
          </div>
        </fieldset>
        <label><span>正式名称</span><input ref="createNameInput" v-model.trim="createDraft.name" required maxlength="256" autocomplete="off" placeholder="例：阿航（青年）" /></label>
        <label><span>确认别名</span><input v-model="createDraft.aliases" maxlength="600" autocomplete="off" placeholder="多个别名用逗号分隔" /></label>
        <label><span>身份说明</span><textarea v-model="createDraft.description" maxlength="20000" rows="3" placeholder="只写可追溯的身份、造型或空间信息。" /></label>
        <label><span>身份特征</span><textarea v-model="createDraft.identityFeatures" maxlength="10000" rows="3" placeholder="每行一项，例如：左侧银白挑染" /></label>
        <label><span>必须保持</span><textarea v-model="createDraft.positiveLocks" maxlength="10000" rows="3" placeholder="每行一项，例如：固定脸、黑衣、古蜀写实" /></label>
        <label><span>禁止出现</span><textarea v-model="createDraft.negativeLocks" maxlength="10000" rows="3" placeholder="每行一项，例如：禁止换脸、禁止现代服饰" /></label>
        <fieldset class="applicability-editor">
          <legend>适用范围（留空即当前工程全局）</legend>
          <div>
            <label><span>项目</span><input v-model="createDraft.applicabilityProjects" maxlength="1000" placeholder="多个 ID 用逗号分隔" /></label>
            <label><span>季</span><input v-model="createDraft.applicabilitySeasons" maxlength="1000" placeholder="例：S03" /></label>
            <label><span>集</span><input v-model="createDraft.applicabilityEpisodes" maxlength="2000" placeholder="例：EP01, EP02" /></label>
            <label><span>15 秒单元</span><input v-model="createDraft.applicabilityUnits" maxlength="4000" placeholder="例：unit-ep01-001" /></label>
          </div>
          <label><span>检索标签</span><input v-model="createDraft.applicabilityTags" maxlength="2000" placeholder="例：古蜀、石室、夜景" /></label>
        </fieldset>
        <label><span>默认提示词</span><textarea v-model="createDraft.defaultPrompt" maxlength="40000" rows="4" placeholder="Codex 后续冻结生图包时使用的资产级提示词。" /></label>
        <p>创建后只得到资产身份；尚未经 approved 的图片不会成为生图权威。</p>
        <footer>
          <button type="button" class="quiet-action" @click="closeCreateDialog">取消</button>
          <button type="submit" class="primary-action" :disabled="!createDraft.name || pendingAction === 'create-asset'">
            <LoaderCircle v-if="pendingAction === 'create-asset'" :size="14" class="spinning" aria-hidden="true" />
            <Plus v-else :size="14" aria-hidden="true" />
            创建资产
          </button>
        </footer>
      </form>
    </div>
  </section>
</template>

<script lang="ts">
import { computed, defineAsyncComponent, defineComponent, nextTick, onBeforeUnmount, reactive, ref, watch, type Component, type PropType } from "vue";
import {
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  FileInput,
  FileText,
  Film,
  FolderKanban,
  Grid2X2,
  Image as ImageIcon,
  List,
  LoaderCircle,
  LockKeyhole,
  Mountain,
  Package,
  Palette,
  PanelRight,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-vue-next";
import {
  MATERIAL_STUDIO_PAGE_LIMIT,
  boundedMaterialStudioEntries,
  commitMaterialStudioFirstPage,
  commitMaterialStudioNextPage,
  commitMaterialStudioPreviousPage,
  createMaterialStudioCursorState,
  materialStudioNextCursor,
  materialStudioPreviousCursor,
  resetMaterialStudioCursorState,
} from "../material-studio-pagination";
import type { StudioBindingWorkbenchApi } from "../studio-binding-pagination";
import type { StudioContinuityReviewUiApi } from "../studio-continuity-review-store";
import type { StudioContinuityReviewFocus } from "../studio-continuity-review-store";
import type { StudioProductionDashboardUiApi } from "../studio-production-dashboard-store";
import type { StudioProductionUnitListQuery, StudioProductionUnitPage } from "@core/studio-production";
import type { ScriptLibraryIndex } from "@core/studio-script-library-projection";
import type { ScriptReaderView } from "@core/studio-script-library-reader";
import type {
  StudioStoryboardWizardSession,
  WizardEditablePanel,
} from "@core/studio-storyboard-wizard";
import type {
  CrossProjectAssetExportManifest,
  ExportStudioCrossProjectAssetPackageResult,
  ImportStudioCrossProjectAssetPackageResult,
} from "@core/studio-cross-project-asset-reuse";
import type {
  StudioMultimediaTimelineProjection,
  StudioMultimediaTimelineRole,
} from "@core/studio-multimedia-timeline";
import { toUserFacingErrorText } from "../user-facing-error";
import {
  MANAGED_CANVAS_THEME_CHANGED_EVENT,
  normalizeManagedCanvasTheme,
  readManagedCanvasTheme,
  type ManagedCanvasThemeId,
} from "../managed-canvas-theme";
import {
  intentOpenCanvasFromDashboard,
  intentOpenDashboardFromCanvas,
  type StudioCanvasFocusLocator,
} from "@core/studio-canvas-locator";
import {
  createProjectScopedActionGate,
  type ProjectScopedActionToken,
} from "../project-scoped-action-gate";
import {
  createEmptyMaterialStudioCreateDraft,
  resetMaterialStudioCreateDraft,
} from "../material-studio-create-draft";

const AsyncStudioBindingWorkbench = defineAsyncComponent(() => import("./StudioBindingWorkbench.vue"));
const AsyncStudioContinuityReviewView = defineAsyncComponent(() => import("./StudioContinuityReviewView.vue"));
const AsyncStudioProductionDashboardView = defineAsyncComponent(() => import("./StudioProductionDashboardView.vue"));
const AsyncManagedStudioCanvasView = defineAsyncComponent(() => import("./ManagedStudioCanvasView.vue"));
const AsyncStudioGenerationControlView = defineAsyncComponent(() => import("./StudioGenerationControlView.vue"));
const AsyncDesktopSupportView = defineAsyncComponent(() => import("./DesktopSupportView.vue"));
const AsyncScriptMediaAlignView = defineAsyncComponent(() => import("./ScriptMediaAlignView.vue"));
const AsyncStudioMultimediaTimelineView = defineAsyncComponent(() => import("./StudioMultimediaTimelineView.vue"));

export type MaterialStudioSection = "script" | "prompt" | "character" | "scene" | "prop" | "style" | "media";
export type MaterialStudioAssetCategory = "character" | "scene" | "prop" | "style";
export type MaterialStudioReviewStatus = "pending" | "approved" | "rejected";
export type MaterialStudioAuthorityState = "locked" | "candidate" | "missing";
export type MaterialStudioAssetRelationKind = "derived_from" | "variant_of" | "reference_of" | "composite_member";

export interface MaterialStudioApplicability {
  projects: string[];
  seasons: string[];
  episodes: string[];
  units: string[];
  timeRanges: Array<{
    scope: "episode" | "unit";
    scopeId: string;
    startSeconds: number;
    endSeconds: number;
    label?: string;
  }>;
  tags: string[];
}

export interface MaterialStudioUiRelation {
  id: string;
  seriesId: string;
  revision: number;
  supersedesRelationId?: string;
  supersededByRelationId?: string;
  head: boolean;
  status: "current" | "stale" | "superseded";
  kind: MaterialStudioAssetRelationKind;
  subjectAssetId: string;
  objectAssetId: string;
  subjectRevision: number;
  objectRevision: number;
  ordinal?: number;
  role: string;
  note: string;
  fingerprint: string;
}

export interface MaterialStudioUiCounts {
  total: number;
  textDocuments: number;
  scripts: number;
  prompts: number;
  character: number;
  scene: number;
  prop: number;
  style: number;
  media: number;
  canonicalAssets: number;
}

export interface MaterialStudioTimelineSegment {
  id: string;
  label: string;
  durationSeconds: number;
  status: "pending" | "current" | "complete";
}

export interface MaterialStudioProjectOverview {
  projectName: string;
  nextAction: string;
  nextActionControl?: {
    code: string;
    label: string;
    reason: string;
    requiresWrite: boolean;
    locator?: { kind: string; unitId?: string; panelId?: string; assetId?: string; queue?: string; itemId?: string };
  };
  counts: MaterialStudioUiCounts;
  timeline: {
    currentLabel?: string;
    unitCount: number;
    completedUnitCount: number;
    segments: MaterialStudioTimelineSegment[];
  };
}

export interface MaterialStudioUiEntry {
  id: string;
  kind: MaterialStudioSection | "image" | "video" | "audio";
  title: string;
  subtitle?: string;
  summary?: string;
  meta?: string;
  episode?: number;
  /** 列表层唯一允许的视觉 URL；不得传入原媒体 URL。 */
  thumbnailUrl?: string;
  /** 媒体条目的内容寻址 ID；只传递 SHA，不传递媒体内容。 */
  mediaSha256?: string;
  authorityState?: MaterialStudioAuthorityState;
  updatedAt?: string;
}

export interface MaterialStudioUiPage {
  items: MaterialStudioUiEntry[];
  nextCursor?: string;
  total?: number;
}

export interface MaterialStudioUiVersion {
  id: string;
  ordinal: number;
  mediaSha256: string;
  /** 列表/卡片只加载轻量缩略图；原图只在用户打开单图检查层时加载。 */
  thumbnailUrl?: string;
  mediaUrl?: string;
  reviewStatus: MaterialStudioReviewStatus;
  isPrimary: boolean;
  sourceNote?: string;
  reviewNote?: string;
  createdAt?: string;
}

export interface MaterialStudioUiDetail {
  id: string;
  kind: MaterialStudioSection | "image" | "video" | "audio";
  title: string;
  description?: string;
  revision: number;
  aliases?: string[];
  /** 详情层也只接受权威图的缩略 URL。 */
  authorityThumbnailUrl?: string;
  primaryAuthority?: { versionId: string; mediaSha256: string };
  mediaPreview?: {
    status: "ready" | "blocked" | "failed" | "not-required";
    message: string;
    previewUrl?: string;
    playbackUrl?: string;
    mimeType: string;
  };
  versions?: MaterialStudioUiVersion[];
  identityFeatures?: string[];
  positiveLocks?: string[];
  negativeLocks?: string[];
  applicability?: MaterialStudioApplicability;
  relations?: MaterialStudioUiRelation[];
  prompt?: {
    positive?: string;
    negative?: string;
    frozenPackId?: string;
  };
  textDocument?: {
    kind: "script" | "prompt";
    bodyPreview: string;
    bodySizeBytes: number;
    bodySha256: string;
    source: string;
    sourceVersion: string;
    truncated: boolean;
  };
}

export interface MaterialStudioUiListQuery {
  section: MaterialStudioSection;
  search?: string;
  cursor?: string;
  limit: number;
}

export interface MaterialStudioCreateAssetInput {
  category: MaterialStudioAssetCategory;
  name: string;
  description?: string;
  aliases?: string[];
  identityFeatures?: string[];
  positiveLocks?: string[];
  negativeLocks?: string[];
  defaultPrompt?: string;
  applicability?: Partial<MaterialStudioApplicability>;
  expectedRevision: 0;
}

export interface MaterialStudioAppendRelationInput {
  assetId: string;
  relatedAssetId: string;
  kind: MaterialStudioAssetRelationKind;
  ordinal?: number;
  role?: string;
  note?: string;
  expectedRevision: number;
}

export interface MaterialStudioRebaseRelationInput {
  assetId: string;
  relation: MaterialStudioUiRelation;
}

export interface MaterialStudioImportResult {
  imported: boolean;
  entryId?: string;
}

export interface MaterialStudioAppendPendingVersionInput {
  assetId: string;
  mediaSha256: string;
  expectedRevision: number;
  sourceNote: string;
}

export interface MaterialStudioReviewPendingVersionInput {
  assetId: string;
  versionId: string;
  decision: "approved" | "rejected";
  expectedRevision: number;
  note: string;
}

export interface MaterialStudioUiApi {
  openProjectCenter?(): void;
  getOverview(projectRoot: string): Promise<MaterialStudioProjectOverview>;
  listEntries(projectRoot: string, query: MaterialStudioUiListQuery): Promise<MaterialStudioUiPage>;
  getEntryDetail(projectRoot: string, entryId: string): Promise<MaterialStudioUiDetail | null>;
  /** P24 U4：文稿修订历史（只读，≤20 条）。 */
  listTextRevisions?(projectRoot: string, query: { documentId: string; limit?: number }): Promise<{ items: Array<{ id: string; ordinal: number; bodySha256: string }>; nextCursor?: string }>;
  chooseAndImportScript(projectRoot: string): Promise<MaterialStudioImportResult>;
  chooseAndImportPrompt(projectRoot: string): Promise<MaterialStudioImportResult>;
  chooseAndImportMedia(projectRoot: string): Promise<MaterialStudioImportResult>;
  createAsset(projectRoot: string, input: MaterialStudioCreateAssetInput): Promise<{ assetId: string }>;
  /** 新版本必须以 pending 状态追加，由后续审核单独决策。 */
  appendPendingAssetVersion?(projectRoot: string, input: MaterialStudioAppendPendingVersionInput): Promise<MaterialStudioUiDetail>;
  reviewPendingAssetVersion?(projectRoot: string, input: MaterialStudioReviewPendingVersionInput): Promise<MaterialStudioUiDetail>;
  promoteApprovedAuthority(projectRoot: string, input: { assetId: string; versionId: string; expectedRevision: number }): Promise<MaterialStudioUiDetail>;
  appendAssetRelation?(projectRoot: string, input: MaterialStudioAppendRelationInput): Promise<MaterialStudioUiDetail>;
  rebaseAssetRelation?(projectRoot: string, input: MaterialStudioRebaseRelationInput): Promise<MaterialStudioUiDetail>;
  exportCrossProjectAssetPackage?(
    projectRoot: string,
    input: { assetId: string; expectedRevision: number },
  ): Promise<ExportStudioCrossProjectAssetPackageResult | null>;
  pickCrossProjectAssetPackage?(): Promise<{
    packageRoot: string;
    manifest: CrossProjectAssetExportManifest;
  } | null>;
  importCrossProjectAssetPackage?(
    projectRoot: string,
    input: {
      packageRoot: string;
      expectedPackageFingerprint: string;
      expectedSourceProjectId: string;
      sourceAssetId: string;
      sourceVersionId: string;
      targetExpectedRevision: 0;
    },
  ): Promise<ImportStudioCrossProjectAssetPackageResult>;
  openTimeline(projectRoot: string): Promise<void>;
}

interface SectionDefinition {
  id: MaterialStudioSection;
  label: string;
  icon: Component;
}

interface SelectedMediaReference {
  entryId: string;
  mediaSha256: string;
  title: string;
  kind: "image" | "video" | "audio" | "media";
  thumbnailUrl?: string;
}

export interface StudioScriptProductUiApi {
  listUnits(
    projectRoot: string,
    query: StudioProductionUnitListQuery,
  ): Promise<StudioProductionUnitPage>;
  getLibraryIndex(
    projectRoot: string,
    query: { limit?: number; kind?: "script" | "prompt" },
  ): Promise<ScriptLibraryIndex>;
  getReaderView(
    projectRoot: string,
    query: {
      documentId?: string;
      revisionId?: string;
      season?: string;
      episode?: string;
      includeBody?: boolean;
      evidenceDir?: string;
    },
  ): Promise<ScriptReaderView>;
  getStudioScriptMediaAlignBoard(
    projectRoot: string,
    query: { season: string; episode: string },
  ): Promise<import("@core/studio-script-media-align").ScriptMediaAlignBoard>;
  openStoryboardWizard(
    projectRoot: string,
    input: {
      scriptRevisionId: string;
      panelCount?: number;
      sourceRange?: { startOffsetUtf16: number; endOffsetUtf16: number };
    },
  ): Promise<StudioStoryboardWizardSession>;
  getMediaPreview(
    projectRoot: string,
    sha256: string,
  ): Promise<{ mediaUrl: string; thumbnailUrl?: string; kind: string } | null>;
  importScript(
    projectRoot: string,
  ): Promise<{ imported: boolean; entryId?: string; unchanged?: boolean; revision?: unknown }>;
  materializeStoryboardWizard(
    projectRoot: string,
    input: {
      season: string;
      episode: string;
      sequence: number;
      unitTitle: string;
      scriptRevisionId: string;
      panels: WizardEditablePanel[];
    },
  ): Promise<{
    unitId: string;
    unitRevision: number;
    promptDocumentId: string;
    promptRevisionId: string;
    panelStatuses: Array<{ panelId: string; panelIndex: number; status: string }>;
  }>;
}

export default defineComponent({
  name: "MaterialStudioView",
  components: {
    Bot,
    Check,
    ChevronLeft,
    ChevronRight,
    CircleAlert,
    Clock3,
    FileInput,
    FolderKanban,
    Grid2X2,
    ImageIcon,
    List,
    LoaderCircle,
    LockKeyhole,
    Mountain,
    Package,
    PanelRight,
    Plus,
    RefreshCw,
    Search,
    ShieldCheck,
    UserRound,
    X,
    AsyncStudioBindingWorkbench,
    AsyncStudioContinuityReviewView,
    AsyncStudioProductionDashboardView,
    AsyncManagedStudioCanvasView,
    AsyncStudioGenerationControlView,
    AsyncDesktopSupportView,
    AsyncScriptMediaAlignView,
    AsyncStudioMultimediaTimelineView,
  },
  props: {
    projectRoot: { type: String, required: true },
    projectName: { type: String, default: "" },
    api: { type: Object as PropType<MaterialStudioUiApi>, required: true },
    bindingApi: { type: Object as PropType<StudioBindingWorkbenchApi>, default: undefined },
    continuityReviewApi: { type: Object as PropType<StudioContinuityReviewUiApi>, default: undefined },
    dashboardApi: { type: Object as PropType<StudioProductionDashboardUiApi>, default: undefined },
    multimediaTimelineApi: {
      type: Object as PropType<{
        listUnits: (
          projectRoot: string,
          query: StudioProductionUnitListQuery,
        ) => Promise<StudioProductionUnitPage>;
        getTimeline: (
          projectRoot: string,
          query: { unitId: string },
        ) => Promise<StudioMultimediaTimelineProjection | null>;
        pickAndImportMedia?: (
          projectRoot: string,
        ) => Promise<{
          imported: boolean;
          media?: {
            sha256: string;
            kind: "video" | "audio";
            mimeType: string;
            sizeBytes: number;
            sourceBasename: string;
          };
        }>;
        attachMedia?: (
          projectRoot: string,
          payload: {
            unitId: string;
            unitRevision: number;
            expectedUnitFingerprint: string;
            slotId: string;
            expectedHeadRevision: number;
            panelIndex?: number;
            startSeconds: number;
            endSeconds: number;
            role: StudioMultimediaTimelineRole;
            mediaSha256: string;
            note?: string;
          },
        ) => Promise<unknown>;
      }>,
      default: undefined,
    },
    scriptAlignApi: {
      type: Object as PropType<StudioScriptProductUiApi>,
      default: undefined,
    },
    /** App 外部请求切换模式（如生成队列 jump） */
    externalModeRequest: {
      type: Object as PropType<{
        mode: "canvas" | "dashboard" | "binding" | "generation";
        unitId?: string;
        panelId?: string;
        token: number;
      } | null>,
      default: null,
    },
  },
  emits: {
    failed: (_message: string) => true,
    selectionChanged: (_entryId: string) => true,
    bindingChanged: (_message: string) => true,
    projectRestored: (_projectRoot: string) => true,
    studioContextChanged: (_context: { mode: string; unitId?: string; panelId?: string; generationRunId?: string }) => true,
  },
  setup(props, { emit }) {
    // P25/P26：壳头跟随受管画布主题（同一主题键 + 变更事件；仅壳头换肤，子视图不动）。
    const shellTheme = ref<ManagedCanvasThemeId>(readManagedCanvasTheme());
    const onCanvasThemeChanged = (event: Event): void => {
      shellTheme.value = normalizeManagedCanvasTheme((event as CustomEvent).detail);
    };
    window.addEventListener(MANAGED_CANVAS_THEME_CHANGED_EVENT, onCanvasThemeChanged);
    onBeforeUnmount(() => window.removeEventListener(MANAGED_CANVAS_THEME_CHANGED_EVENT, onCanvasThemeChanged));
    const sections: SectionDefinition[] = [
      { id: "script", label: "剧本", icon: FileText },
      { id: "prompt", label: "提示词", icon: Bot },
      { id: "character", label: "角色", icon: UserRound },
      { id: "scene", label: "场景", icon: Mountain },
      { id: "prop", label: "道具", icon: Package },
      { id: "style", label: "风格", icon: Palette },
      { id: "media", label: "媒体", icon: Film },
    ];
    const assetCategories = sections.filter((section): section is SectionDefinition & { id: MaterialStudioAssetCategory } => isAssetSection(section.id));
    const activeSection = ref<MaterialStudioSection>("script");
    type StudioUiMode = "canvas" | "dashboard" | "multimedia-timeline" | "script-align" | "library" | "binding" | "continuity-review" | "generation" | "agent" | "help";
    const activeMode = ref<StudioUiMode>(
      props.dashboardApi ? "canvas" : "library",
    );
    /**
     * 正式派发供应方只是一项显式、会话内 UI 选择；Core/ledger 仍是最终事实源。
     * 切工程时恢复 Codex，避免隔离 canary 的 Grok 选择泄漏到其他受管工程。
     */
    const generationProvider = ref<"codex" | "grok">("codex");
    watch(() => props.projectRoot, () => {
      generationProvider.value = "codex";
    });
    /** 列表↔画布共享 focus（A3） */
    const canvasFocus = ref<StudioCanvasFocusLocator | null>(null);
    const dashboardFocus = ref<StudioCanvasFocusLocator | null>(null);
    const bindingFocus = reactive({ unitId: "", panelId: "" });
    const reviewFocus = ref<StudioContinuityReviewFocus | null>(null);

    function onDashboardOpenCanvas(focus: StudioCanvasFocusLocator): void {
      const intent = intentOpenCanvasFromDashboard(focus);
      canvasFocus.value = intent.focus;
      selectStudioMode("canvas", intent.focus);
    }

    function onCanvasOpenDashboard(focus: StudioCanvasFocusLocator): void {
      const intent = intentOpenDashboardFromCanvas(focus);
      dashboardFocus.value = intent.focus;
      selectStudioMode("dashboard", intent.focus);
    }

    function onCanvasOpenBinding(focus: { unitId?: string; panelId?: string }): void {
      bindingFocus.unitId = focus.unitId?.trim() || "";
      bindingFocus.panelId = focus.panelId?.trim() || "";
      if (props.bindingApi) selectStudioMode("binding", focus);
    }

    function onCanvasOpenReview(focus: StudioContinuityReviewFocus): void {
      reviewFocus.value = focus;
      selectStudioMode("continuity-review", focus);
    }

    function onCanvasRequestGeneration(focus: { unitId?: string; panelId?: string }): void {
      bindingFocus.unitId = focus.unitId?.trim() || "";
      bindingFocus.panelId = focus.panelId?.trim() || "";
      selectStudioMode("generation", focus);
      notice.value = "已打开受管 Studio 派发记录；Agent 将按冻结包领取，桌面端不会伪造远程提交。";
    }

    function onScriptOpenUnit(payload: {
      unitId: string;
      target?: "canvas" | "binding" | "review";
    }): void {
      const unitId = payload.unitId.trim();
      if (!unitId) return;
      if (payload.target === "binding" && props.bindingApi) {
        onCanvasOpenBinding({ unitId });
        return;
      }
      if (props.dashboardApi) {
        if (payload.target === "review") {
          dashboardFocus.value = { unitId };
          selectStudioMode("dashboard", { unitId });
        } else {
          canvasFocus.value = { unitId };
          selectStudioMode("canvas", { unitId });
        }
      }
    }

    function onGenerationQueueChanged(message: string): void {
      notice.value = message;
      emit("bindingChanged", message);
    }

    function onGenerationQueueFailed(message: string): void {
      error.value = message;
      emit("failed", message);
    }

    function onGenerationQueueJump(payload: {
      kind: string;
      targetId: string;
      jobId: string;
      unitId?: string;
      panelId?: string;
    }): void {
      const unitId = (payload.unitId || (payload.kind === "unit" ? payload.targetId : "") || "").trim();
      const panelId = (payload.panelId || (payload.kind === "panel" ? payload.targetId : "") || "").trim();

      if (payload.kind === "unit" || payload.kind === "panel" || unitId || panelId) {
        if (unitId) bindingFocus.unitId = unitId;
        if (panelId) bindingFocus.panelId = panelId;
        if (payload.kind === "unit" && !unitId) bindingFocus.unitId = payload.targetId;
        if (payload.kind === "panel" && !panelId) bindingFocus.panelId = payload.targetId;

        if (props.bindingApi && (bindingFocus.unitId || bindingFocus.panelId)) {
          selectStudioMode("binding", { unitId: bindingFocus.unitId, panelId: bindingFocus.panelId });
          notice.value = `队列已跳转绑定 ${bindingFocus.unitId || ""} ${bindingFocus.panelId || ""}`.trim();
          return;
        }
        if (props.dashboardApi) {
          dashboardFocus.value = {
            ...(bindingFocus.unitId || unitId || payload.kind === "unit" ? { unitId: bindingFocus.unitId || unitId || payload.targetId } : {}),
            ...(bindingFocus.panelId || panelId || payload.kind === "panel" ? { panelId: bindingFocus.panelId || panelId || payload.targetId } : {}),
          };
          selectStudioMode("dashboard", dashboardFocus.value);
          notice.value = `队列已跳转驾驶舱 ${payload.kind}:${payload.targetId}`;
          return;
        }
      }

      // item / job：仍尽量进驾驶舱总览，避免只 toast 不导航
      if (props.dashboardApi) {
        selectStudioMode("dashboard");
        notice.value = `队列已打开驾驶舱（任务 ${payload.jobId}）`;
        return;
      }
      notice.value = `队列任务 ${payload.jobId} 已记录跳转 ${payload.kind}:${payload.targetId}`;
    }

    watch(() => props.externalModeRequest as { mode?: string; unitId?: string; panelId?: string; token?: number } | null | undefined, (req) => {
      if (!req?.mode || !req.token) return;
      if (req.mode === "binding" && props.bindingApi) {
        bindingFocus.unitId = req.unitId?.trim() || "";
        bindingFocus.panelId = req.panelId?.trim() || "";
        selectStudioMode("binding", { unitId: bindingFocus.unitId, panelId: bindingFocus.panelId });
      } else if ((req.mode === "canvas" || req.mode === "dashboard") && props.dashboardApi) {
        selectStudioMode(req.mode, { unitId: req.unitId, panelId: req.panelId });
      } else if (req.mode === "generation") {
        selectStudioMode("generation", { unitId: req.unitId, panelId: req.panelId });
      }
    }, { deep: true });
    const viewMode = ref<"grid" | "list">("grid");
    const overview = ref<MaterialStudioProjectOverview | null>(null);
    const entries = ref<MaterialStudioUiEntry[]>([]);
    const pageCursors = reactive(createMaterialStudioCursorState());
    const nextCursor = ref<string>();
    const pageTotal = ref<number>();
    const selectedId = ref("");
    const selectedMedia = ref<SelectedMediaReference | null>(null);
    const detail = ref<MaterialStudioUiDetail | null>(null);
    const crossProjectPackage = ref<{
      packageRoot: string;
      manifest: CrossProjectAssetExportManifest;
    } | null>(null);
    watch(() => props.projectRoot, () => {
      crossProjectPackage.value = null;
    });
    const versionPreview = ref<MaterialStudioUiVersion | null>(null);
    function openVersionPreview(version: MaterialStudioUiVersion): void {
      if (!version.mediaUrl) return;
      versionPreview.value = version;
    }
    function closeVersionPreview(): void {
      versionPreview.value = null;
    }
    watch(() => props.projectRoot, closeVersionPreview);
    // P24 U4：文稿修订历史（≤20 条，最新在前；经 props.api.listTextRevisions）。
    const textRevisions = ref<Array<{ id: string; ordinal: number; bodySha256: string }>>([]);
    const textRevisionsLoading = ref(false);
    const textRevisionsError = ref("");
    let textRevisionsToken = 0;
    watch(() => (detail.value?.textDocument ? `${detail.value.id}#${detail.value.revision}` : ""), async () => {
      const documentId = detail.value?.textDocument ? detail.value.id : "";
      const token = ++textRevisionsToken;
      const root = props.projectRoot;
      textRevisions.value = [];
      textRevisionsError.value = "";
      if (!documentId || !props.api.listTextRevisions) {
        textRevisionsLoading.value = false;
        return;
      }
      textRevisionsLoading.value = true;
      try {
        const page = await props.api.listTextRevisions(root, { documentId, limit: 20 });
        if (token !== textRevisionsToken || root !== props.projectRoot) return;
        textRevisions.value = [...page.items].sort((left, right) => right.ordinal - left.ordinal);
      } catch (reason) {
        if (token !== textRevisionsToken || root !== props.projectRoot) return;
        textRevisionsError.value = reason instanceof Error ? reason.message : String(reason);
      } finally {
        if (token === textRevisionsToken && root === props.projectRoot) textRevisionsLoading.value = false;
      }
    });
    const loading = ref(false);
    const loadingMore = ref(false);
    const detailLoading = ref(false);
    const pendingAction = ref("");
    const error = ref("");
    const notice = ref("");
    const searchInput = ref("");
    const searchQuery = ref("");
    const versionSourceNote = ref("");
    const reviewDrafts = reactive<Record<string, string>>({});
    const createDialogOpen = ref(false);
    const createNameInput = ref<HTMLInputElement | null>(null);
    const createDraft = reactive(createEmptyMaterialStudioCreateDraft());
    const relationDraft = reactive({
      kind: "reference_of" as MaterialStudioAssetRelationKind,
      relatedAssetId: "",
      ordinal: 1,
      role: "",
      note: "",
    });
    const relationSearch = ref("");
    const relationCandidates = ref<MaterialStudioUiEntry[]>([]);
    const relationCandidatesLoading = ref(false);
    let searchTimer: ReturnType<typeof setTimeout> | undefined;
    let relationSearchTimer: ReturnType<typeof setTimeout> | undefined;
    let overviewRequest = 0;
    let listRequest = 0;
    let detailRequest = 0;
    let mutationRefreshRequest = 0;
    let actionRequest = 0;
    let relationCandidateRequest = 0;
    let disposed = false;
    const actionGate = createProjectScopedActionGate();

    interface FrozenMaterialActionScope {
      token: ProjectScopedActionToken;
      projectRoot: string;
      actionId: string;
    }

    function materialActionIsCurrent(scope: FrozenMaterialActionScope): boolean {
      return !disposed && actionGate.isCurrent(
        scope.token,
        props.projectRoot,
        scope.actionId,
      );
    }

    const visibleTotal = computed(() => pageTotal.value ?? (overview.value ? countFor(activeSection.value) : entries.value.length));
    const canLoadPrevious = computed(() => pageCursors.previousCursors.length > 0);
    const currentPageNumber = computed(() => pageCursors.previousCursors.length + 1);
    const hasPendingVersions = computed(() => detail.value?.versions?.some((version) => version.reviewStatus === "pending") ?? false);
    const selectedMediaCanBecomeAuthority = computed(() => selectedMedia.value?.kind === "image");
    const activeSectionIcon = computed(() => sections.find((section) => section.id === activeSection.value)?.icon ?? Film);
    const searchPlaceholder = computed(() => ({
      script: "搜索集数、单元、提示词",
      prompt: "搜索提示词名称、用途或版本",
      character: "搜索角色名、别名、身份",
      scene: "搜索场景名、空间特征",
      prop: "搜索道具名、别名、结构",
      style: "搜索风格名、色彩、材质或光影",
      media: "搜索媒体名或类型",
    } satisfies Record<MaterialStudioSection, string>)[activeSection.value]);

    watch([() => props.projectRoot, () => props.api], () => {
      resetWorkspace();
      void refresh();
    }, { immediate: true });

    watch(searchInput, (value) => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        searchQuery.value = value.trim();
        void loadFirstPage();
      }, 260);
    });

    onBeforeUnmount(() => {
      disposed = true;
      overviewRequest += 1;
      listRequest += 1;
      detailRequest += 1;
      mutationRefreshRequest += 1;
      actionRequest += 1;
      relationCandidateRequest += 1;
      textRevisionsToken += 1;
      actionGate.dispose();
      if (searchTimer) clearTimeout(searchTimer);
      if (relationSearchTimer) clearTimeout(relationSearchTimer);
      searchTimer = undefined;
      relationSearchTimer = undefined;
    });

    function resetWorkspace(): void {
      overviewRequest += 1;
      listRequest += 1;
      detailRequest += 1;
      mutationRefreshRequest += 1;
      actionRequest += 1;
      relationCandidateRequest += 1;
      textRevisionsToken += 1;
      actionGate.invalidate();
      if (searchTimer) clearTimeout(searchTimer);
      if (relationSearchTimer) clearTimeout(relationSearchTimer);
      searchTimer = undefined;
      relationSearchTimer = undefined;
      overview.value = null;
      canvasFocus.value = null;
      dashboardFocus.value = null;
      bindingFocus.unitId = "";
      bindingFocus.panelId = "";
      reviewFocus.value = null;
      entries.value = [];
      // 初次挂载与切工程都会走这里；有 dashboard owner 时必须回到受管无限画布，
      // 否则 setup 的 canvas 默认值会被 immediate watcher 静默覆盖。
      activeMode.value = props.dashboardApi ? "canvas" : "library";
      resetMaterialStudioCursorState(pageCursors);
      nextCursor.value = undefined;
      pageTotal.value = undefined;
      selectedId.value = "";
      selectedMedia.value = null;
      versionSourceNote.value = "";
      resetRelationDraft();
      resetCreateDraft();
      createDialogOpen.value = false;
      clearReviewDrafts();
      detail.value = null;
      textRevisions.value = [];
      textRevisionsError.value = "";
      textRevisionsLoading.value = false;
      loading.value = false;
      loadingMore.value = false;
      detailLoading.value = false;
      relationCandidatesLoading.value = false;
      pendingAction.value = "";
      searchInput.value = "";
      searchQuery.value = "";
      error.value = "";
      notice.value = "";
    }

    async function refresh(): Promise<void> {
      const request = ++overviewRequest;
      const root = props.projectRoot;
      loading.value = true;
      clearFeedback();
      try {
        const next = await props.api.getOverview(root);
        if (disposed || request !== overviewRequest || root !== props.projectRoot) return;
        overview.value = next;
        await loadFirstPage();
      } catch (reason) {
        if (request === overviewRequest && root === props.projectRoot) fail(reason);
      } finally {
        if (request === overviewRequest && root === props.projectRoot) loading.value = false;
      }
    }

    async function loadFirstPage(): Promise<boolean> {
      const request = ++listRequest;
      const root = props.projectRoot;
      resetMaterialStudioCursorState(pageCursors);
      nextCursor.value = undefined;
      loadingMore.value = false;
      loading.value = true;
      error.value = "";
      try {
        const page = await props.api.listEntries(root, {
          section: activeSection.value,
          search: searchQuery.value || undefined,
          limit: MATERIAL_STUDIO_PAGE_LIMIT,
        });
        if (disposed || request !== listRequest || root !== props.projectRoot) return false;
        entries.value = boundedMaterialStudioEntries(page.items);
        commitMaterialStudioFirstPage(pageCursors, page.nextCursor);
        nextCursor.value = materialStudioNextCursor(pageCursors);
        pageTotal.value = page.total;
        clearHiddenSelection();
        return true;
      } catch (reason) {
        if (request === listRequest && root === props.projectRoot) fail(reason);
        return false;
      } finally {
        if (request === listRequest && root === props.projectRoot) loading.value = false;
      }
    }

    async function loadNextPage(): Promise<void> {
      if (!nextCursor.value || loadingMore.value) return;
      const request = ++listRequest;
      const root = props.projectRoot;
      const cursor = nextCursor.value;
      loadingMore.value = true;
      error.value = "";
      try {
        const page = await props.api.listEntries(root, {
          section: activeSection.value,
          search: searchQuery.value || undefined,
          cursor,
          limit: MATERIAL_STUDIO_PAGE_LIMIT,
        });
        if (disposed || request !== listRequest || root !== props.projectRoot) return;
        entries.value = boundedMaterialStudioEntries(page.items);
        commitMaterialStudioNextPage(pageCursors, cursor, page.nextCursor);
        nextCursor.value = materialStudioNextCursor(pageCursors);
        pageTotal.value = page.total ?? pageTotal.value;
        clearHiddenSelection();
      } catch (reason) {
        if (request === listRequest && root === props.projectRoot) fail(reason);
      } finally {
        if (request === listRequest && root === props.projectRoot) loadingMore.value = false;
      }
    }

    async function loadPreviousPage(): Promise<void> {
      if (!pageCursors.previousCursors.length || loadingMore.value) return;
      const request = ++listRequest;
      const root = props.projectRoot;
      const cursor = materialStudioPreviousCursor(pageCursors);
      loadingMore.value = true;
      error.value = "";
      try {
        const page = await props.api.listEntries(root, {
          section: activeSection.value,
          search: searchQuery.value || undefined,
          ...(cursor ? { cursor } : {}),
          limit: MATERIAL_STUDIO_PAGE_LIMIT,
        });
        if (disposed || request !== listRequest || root !== props.projectRoot) return;
        entries.value = boundedMaterialStudioEntries(page.items);
        commitMaterialStudioPreviousPage(pageCursors, cursor, page.nextCursor);
        nextCursor.value = materialStudioNextCursor(pageCursors);
        pageTotal.value = page.total ?? pageTotal.value;
        clearHiddenSelection();
      } catch (reason) {
        if (request === listRequest && root === props.projectRoot) fail(reason);
      } finally {
        if (request === listRequest && root === props.projectRoot) loadingMore.value = false;
      }
    }

    function clearHiddenSelection(): void {
      if (!selectedId.value || entries.value.some((entry) => entry.id === selectedId.value)) return;
      selectedId.value = "";
      detail.value = null;
      detailRequest += 1;
    }

    function selectSection(section: MaterialStudioSection): void {
      if (activeSection.value === section) return;
      activeSection.value = section;
      selectedId.value = "";
      detail.value = null;
      versionSourceNote.value = "";
      resetRelationDraft();
      clearReviewDrafts();
      searchInput.value = "";
      searchQuery.value = "";
      entries.value = [];
      resetMaterialStudioCursorState(pageCursors);
      nextCursor.value = undefined;
      pageTotal.value = undefined;
      void loadFirstPage();
    }

    async function selectEntry(entry: MaterialStudioUiEntry, allowDuringAction = false): Promise<void> {
      if (pendingAction.value && !allowDuringAction) return;
      const request = ++detailRequest;
      const root = props.projectRoot;
      const previousId = selectedId.value;
      selectedId.value = entry.id;
      detail.value = null;
      if (isMediaKind(entry.kind)) {
        const mediaSha256 = mediaShaForEntry(entry);
        if (mediaSha256) {
          selectedMedia.value = {
            entryId: entry.id,
            mediaSha256,
            title: entry.title,
            kind: entry.kind,
            ...(entry.thumbnailUrl ? { thumbnailUrl: entry.thumbnailUrl } : {}),
          };
        }
      } else if (previousId !== entry.id) {
        versionSourceNote.value = "";
        resetRelationDraft();
      }
      clearReviewDrafts();
      detailLoading.value = true;
      error.value = "";
      emit("selectionChanged", entry.id);
      try {
        const next = await props.api.getEntryDetail(root, entry.id);
        if (disposed || request !== detailRequest || root !== props.projectRoot || selectedId.value !== entry.id) return;
        detail.value = next;
        if (!next) throw new Error("素材详情不存在或已被替换。");
        syncReviewDrafts(next);
      } catch (reason) {
        if (request === detailRequest && root === props.projectRoot) fail(reason);
      } finally {
        if (request === detailRequest && root === props.projectRoot) detailLoading.value = false;
      }
    }

    async function importScript(): Promise<void> {
      await runAction("import-script", "剧本已导入当前工程。", async () => {
        const root = props.projectRoot;
        const result = await props.api.chooseAndImportScript(root);
        if (!result.imported || root !== props.projectRoot) return false;
        activeSection.value = "script";
        await refreshAfterMutation(result.entryId);
        return true;
      });
    }

    async function importPrompt(): Promise<void> {
      await runAction("import-prompt", "提示词已导入当前工程。", async () => {
        const root = props.projectRoot;
        const result = await props.api.chooseAndImportPrompt(root);
        if (!result.imported || root !== props.projectRoot) return false;
        activeSection.value = "prompt";
        await refreshAfterMutation(result.entryId);
        return true;
      });
    }

    async function importMedia(): Promise<void> {
      await runAction("import-media", "媒体已进入当前工程 CAS。", async () => {
        const root = props.projectRoot;
        const result = await props.api.chooseAndImportMedia(root);
        if (!result.imported || root !== props.projectRoot) return false;
        activeSection.value = "media";
        await refreshAfterMutation(result.entryId);
        return true;
      });
    }

    async function refreshAfterMutation(entryId?: string, root = props.projectRoot): Promise<void> {
      const nextOverview = await props.api.getOverview(root);
      if (root !== props.projectRoot) return;
      overview.value = nextOverview;
      const firstPageLoaded = await loadFirstPage();
      if (!firstPageLoaded || root !== props.projectRoot) return;
      if (entryId) {
        const entry = entries.value.find((candidate) => candidate.id === entryId)
          ?? { id: entryId, kind: activeSection.value, title: entryId } satisfies MaterialStudioUiEntry;
        if (root !== props.projectRoot) return;
        await selectEntry(entry, true);
      }
    }

    function resetCreateDraft(category: MaterialStudioAssetCategory = "character"): void {
      resetMaterialStudioCreateDraft(createDraft, category);
    }

    function openCreateDialog(category: MaterialStudioAssetCategory): void {
      resetCreateDraft(category);
      createDialogOpen.value = true;
      void nextTick(() => createNameInput.value?.focus());
    }

    function closeCreateDialog(): void {
      if (pendingAction.value === "create-asset") return;
      createDialogOpen.value = false;
    }

    async function createAsset(): Promise<void> {
      const frozenDraft = {
        category: createDraft.category,
        name: createDraft.name.trim(),
        description: createDraft.description.trim() || undefined,
        aliases: createDraft.aliases.split(/[,，\n]/u).map((alias) => alias.trim()).filter(Boolean),
        identityFeatures: createDraft.identityFeatures.split(/\n/u).map((value) => value.trim()).filter(Boolean),
        positiveLocks: createDraft.positiveLocks.split(/\n/u).map((value) => value.trim()).filter(Boolean),
        negativeLocks: createDraft.negativeLocks.split(/\n/u).map((value) => value.trim()).filter(Boolean),
        defaultPrompt: createDraft.defaultPrompt.trim() || undefined,
        applicability: {
          projects: splitDraftList(createDraft.applicabilityProjects),
          seasons: splitDraftList(createDraft.applicabilitySeasons),
          episodes: splitDraftList(createDraft.applicabilityEpisodes),
          units: splitDraftList(createDraft.applicabilityUnits),
          tags: splitDraftList(createDraft.applicabilityTags),
          timeRanges: [],
        },
      };
      if (!frozenDraft.name) return;
      await runAction("create-asset", "规范资产已创建；等待附加 approved 参考版本。", async (scope) => {
        const result = await props.api.createAsset(scope.projectRoot, {
          ...frozenDraft,
          applicability: {
            ...frozenDraft.applicability,
            timeRanges: [],
          },
          expectedRevision: 0,
        });
        if (!materialActionIsCurrent(scope)) return false;
        createDialogOpen.value = false;
        activeSection.value = frozenDraft.category;
        await refreshAfterMutation(`asset:${result.assetId}`, scope.projectRoot);
        return materialActionIsCurrent(scope);
      });
    }

    async function exportCurrentAssetPackage(): Promise<void> {
      const asset = detail.value;
      if (!asset || !isAssetKind(asset.kind) || !asset.primaryAuthority
        || !props.api.exportCrossProjectAssetPackage) return;
      await runAction("cross-project-export", "", async (scope) => {
        const result = await props.api.exportCrossProjectAssetPackage!(scope.projectRoot, {
          assetId: asset.id,
          expectedRevision: asset.revision,
        });
        if (!result || !materialActionIsCurrent(scope)) return false;
        notice.value = `只读复用包已导出：${result.packageRoot}；源工程未写入。`;
        return false;
      });
    }

    async function pickCrossProjectAssetPackage(): Promise<void> {
      if (!props.api.pickCrossProjectAssetPackage || pendingAction.value) return;
      clearFeedback();
      try {
        const picked = await props.api.pickCrossProjectAssetPackage();
        if (!picked) return;
        crossProjectPackage.value = picked;
        notice.value = `复用包已通过 manifest 与逐对象 SHA 核验：${picked.manifest.items.length} 项。`;
      } catch (reason) {
        fail(reason);
      }
    }

    async function importCrossProjectAssetItem(
      sourceAssetId: string,
      sourceVersionId: string,
      category: MaterialStudioAssetCategory,
    ): Promise<void> {
      const selectedPackage = crossProjectPackage.value;
      if (!selectedPackage || !props.api.importCrossProjectAssetPackage) return;
      await runAction(`cross-project-import:${sourceAssetId}`, "", async (scope) => {
        const result = await props.api.importCrossProjectAssetPackage!(scope.projectRoot, {
          packageRoot: selectedPackage.packageRoot,
          expectedPackageFingerprint: selectedPackage.manifest.fingerprint,
          expectedSourceProjectId: selectedPackage.manifest.sourceProjectId,
          sourceAssetId,
          sourceVersionId,
          targetExpectedRevision: 0,
        });
        if (!materialActionIsCurrent(scope)) return false;
        activeSection.value = category;
        await refreshAfterMutation(`asset:${result.targetAssetId}`, scope.projectRoot);
        if (!materialActionIsCurrent(scope)) return false;
        notice.value = result.disposition === "already-imported"
          ? "该复用版本已存在；未重复追加。仍以目标工程当前 Review/Primary 为准。"
          : "已导入为 pending 候选；必须在目标工程独立批准后才能提升 Primary。";
        return false;
      });
    }

    function splitDraftList(value: string): string[] {
      return value.split(/[,，\n]/u).map((entry) => entry.trim()).filter(Boolean);
    }

    function resetRelationDraft(): void {
      relationCandidateRequest += 1;
      if (relationSearchTimer) clearTimeout(relationSearchTimer);
      relationDraft.kind = "reference_of";
      relationDraft.relatedAssetId = "";
      relationDraft.ordinal = 1;
      relationDraft.role = "";
      relationDraft.note = "";
      relationSearch.value = "";
      relationCandidates.value = [];
      relationCandidatesLoading.value = false;
    }

    function scheduleRelationCandidateSearch(): void {
      if (relationSearchTimer) clearTimeout(relationSearchTimer);
      relationSearchTimer = setTimeout(() => void loadRelationCandidates(), 220);
    }

    function onRelationEditorToggle(event: Event): void {
      if ((event.currentTarget as HTMLDetailsElement | null)?.open && !relationCandidates.value.length) {
        void loadRelationCandidates();
      }
    }

    async function loadRelationCandidates(): Promise<void> {
      const request = ++relationCandidateRequest;
      const root = props.projectRoot;
      relationCandidatesLoading.value = true;
      try {
        const search = relationSearch.value.trim() || undefined;
        const pages = await Promise.all((["character", "scene", "prop", "style"] as const).map((section) => props.api.listEntries(root, {
          section,
          ...(search ? { search } : {}),
          limit: 12,
        })));
        if (disposed || request !== relationCandidateRequest || root !== props.projectRoot) return;
        const currentEntryId = detail.value && isAssetKind(detail.value.kind) ? `asset:${detail.value.id}` : "";
        relationCandidates.value = [...new Map(pages.flatMap((page) => page.items)
          .filter((entry) => entry.id !== currentEntryId)
          .map((entry) => [entry.id, entry] as const)).values()].slice(0, MATERIAL_STUDIO_PAGE_LIMIT);
        if (!relationCandidates.value.some((entry) => entry.id === `asset:${relationDraft.relatedAssetId}`)) {
          relationDraft.relatedAssetId = "";
        }
      } catch (reason) {
        if (request === relationCandidateRequest && root === props.projectRoot) fail(reason);
      } finally {
        if (request === relationCandidateRequest && root === props.projectRoot) relationCandidatesLoading.value = false;
      }
    }

    async function appendRelation(): Promise<void> {
      const asset = detail.value;
      const append = props.api.appendAssetRelation;
      const relatedAssetId = relationDraft.relatedAssetId.trim();
      if (!asset || !isAssetKind(asset.kind) || !append || !relatedAssetId || pendingAction.value) return;
      const root = props.projectRoot;
      const assetEntryId = selectedId.value;
      detailRequest += 1;
      await runAction("append-relation", "资产关系已冻结并追加到当前工程。", async () => {
        await append(root, {
          assetId: asset.id,
          relatedAssetId,
          kind: relationDraft.kind,
          ...(relationDraft.kind === "composite_member" ? { ordinal: relationDraft.ordinal } : {}),
          role: relationDraft.role.trim() || undefined,
          note: relationDraft.note.trim() || undefined,
          expectedRevision: asset.revision,
        });
        if (root !== props.projectRoot) return false;
        const refreshed = await refreshVersionWorkflow(root, assetEntryId, asset.id);
        if (refreshed) resetRelationDraft();
        return refreshed;
      });
    }

    async function rebaseRelation(relation: MaterialStudioUiRelation): Promise<void> {
      const asset = detail.value;
      const rebase = props.api.rebaseAssetRelation;
      if (!asset || !isAssetKind(asset.kind) || !rebase || !relation.head || relation.status !== "stale" || pendingAction.value) return;
      const root = props.projectRoot;
      const assetEntryId = selectedId.value;
      detailRequest += 1;
      await runAction(`rebase-relation:${relation.id}`, "过期关系已追加新快照，旧修订保留为历史。", async () => {
        await rebase(root, { assetId: asset.id, relation });
        if (root !== props.projectRoot) return false;
        return refreshVersionWorkflow(root, assetEntryId, asset.id);
      });
    }

    function mediaShaForEntry(entry: MaterialStudioUiEntry): string | undefined {
      const candidate = entry.mediaSha256 ?? (entry.id.startsWith("media:") ? entry.id.slice("media:".length) : "");
      const normalized = candidate.trim().toLowerCase();
      return /^[a-f0-9]{64}$/u.test(normalized) ? normalized : undefined;
    }

    function clearSelectedMedia(): void {
      if (pendingAction.value) return;
      selectedMedia.value = null;
      versionSourceNote.value = "";
    }

    function clearReviewDrafts(): void {
      for (const versionId of Object.keys(reviewDrafts)) delete reviewDrafts[versionId];
    }

    function syncReviewDrafts(next: MaterialStudioUiDetail): void {
      const pendingVersions = new Map((next.versions ?? [])
        .filter((version) => version.reviewStatus === "pending")
        .map((version) => [version.id, version]));
      for (const versionId of Object.keys(reviewDrafts)) {
        if (!pendingVersions.has(versionId)) delete reviewDrafts[versionId];
      }
      for (const version of pendingVersions.values()) {
        reviewDrafts[version.id] ??= version.reviewNote ?? "";
      }
    }

    function canReviewVersion(version: MaterialStudioUiVersion): boolean {
      return version.reviewStatus === "pending"
        && Boolean(detail.value && isAssetKind(detail.value.kind))
        && Boolean(props.api.reviewPendingAssetVersion)
        && !pendingAction.value
        && Boolean(reviewDrafts[version.id]?.trim());
    }

    async function appendSelectedMediaVersion(): Promise<void> {
      const asset = detail.value;
      const media = selectedMedia.value;
      const append = props.api.appendPendingAssetVersion;
      const sourceNote = versionSourceNote.value.trim();
      if (!asset || !isAssetKind(asset.kind) || !media || !append || !sourceNote || pendingAction.value) return;
      const root = props.projectRoot;
      const assetEntryId = selectedId.value;
      detailRequest += 1;
      await runAction("append-version", "媒体已以 pending 状态追加；请完成一致性审核。", async () => {
        await append(root, {
          assetId: asset.id,
          mediaSha256: media.mediaSha256,
          expectedRevision: asset.revision,
          sourceNote,
        });
        if (root !== props.projectRoot) return false;
        const refreshed = await refreshVersionWorkflow(root, assetEntryId, asset.id);
        if (refreshed) versionSourceNote.value = "";
        return refreshed;
      });
    }

    async function reviewVersion(version: MaterialStudioUiVersion, decision: "approved" | "rejected"): Promise<void> {
      const asset = detail.value;
      const review = props.api.reviewPendingAssetVersion;
      const note = reviewDrafts[version.id]?.trim() ?? "";
      if (!asset || !isAssetKind(asset.kind) || version.reviewStatus !== "pending" || !review || !note || pendingAction.value) return;
      const root = props.projectRoot;
      const assetEntryId = selectedId.value;
      detailRequest += 1;
      await runAction(`review:${version.id}`, decision === "approved" ? "版本已批准，现可提升为硬锁权威。" : "版本已拒绝，将保留在历史中但不可作为权威。", async () => {
        await review(root, {
          assetId: asset.id,
          versionId: version.id,
          decision,
          expectedRevision: asset.revision,
          note,
        });
        if (root !== props.projectRoot) return false;
        return refreshVersionWorkflow(root, assetEntryId, asset.id);
      });
    }

    async function refreshVersionWorkflow(
      root: string,
      assetEntryId: string,
      assetId: string,
    ): Promise<boolean> {
      const request = ++mutationRefreshRequest;
      const source = selectedMedia.value;
      const detailRequestAtRefresh = ++detailRequest;
      const [freshDetail, freshOverview, freshMedia] = await Promise.all([
        props.api.getEntryDetail(root, assetEntryId),
        props.api.getOverview(root),
        source ? props.api.getEntryDetail(root, source.entryId) : Promise.resolve(null),
      ]);
      if (disposed
        || request !== mutationRefreshRequest
        || detailRequestAtRefresh !== detailRequest
        || root !== props.projectRoot) return false;

      overview.value = freshOverview;
      if (source && selectedMedia.value?.entryId === source.entryId) {
        if (freshMedia && isMediaKind(freshMedia.kind)) {
          selectedMedia.value = {
            ...source,
            title: freshMedia.title,
            kind: freshMedia.kind,
            ...(freshMedia.authorityThumbnailUrl ? { thumbnailUrl: freshMedia.authorityThumbnailUrl } : {}),
          };
        } else {
          selectedMedia.value = null;
          versionSourceNote.value = "";
        }
      }
      const listRefreshed = await loadFirstPage();
      if (disposed || request !== mutationRefreshRequest || root !== props.projectRoot) return false;
      if (!listRefreshed) return false;
      if (selectedId.value === assetEntryId) {
        if (!freshDetail) throw new Error("版本写入后无法重新读取资产详情。");
        if (freshDetail.id !== assetId || !isAssetKind(freshDetail.kind)) throw new Error("版本写入后的资产详情身份不匹配。");
        detail.value = freshDetail;
        syncReviewDrafts(freshDetail);
      }
      return true;
    }

    async function promoteAuthority(version: MaterialStudioUiVersion): Promise<void> {
      if (!detail.value || !isAssetKind(detail.value.kind) || version.reviewStatus !== "approved" || version.isPrimary) return;
      const asset = detail.value;
      const root = props.projectRoot;
      const assetEntryId = selectedId.value;
      detailRequest += 1;
      await runAction(`promote:${version.id}`, "approved 版本已提升为当前主权威。", async () => {
        await props.api.promoteApprovedAuthority(root, {
          assetId: asset.id,
          versionId: version.id,
          expectedRevision: asset.revision,
        });
        if (root !== props.projectRoot) return false;
        return refreshVersionWorkflow(root, assetEntryId, asset.id);
      });
    }

    async function openTimeline(): Promise<void> {
      selectStudioMode("binding");
    }

    function selectProductionStep(step: "script" | "assets" | "binding" | "generation" | "review"): void {
      if (step === "script") {
        selectStudioMode("library");
        selectSection("script");
      } else if (step === "assets") {
        selectStudioMode("library");
        selectSection("character");
      } else if (step === "binding") selectStudioMode("binding");
      else if (step === "generation") selectStudioMode("generation");
      else selectStudioMode("continuity-review");
    }

    async function continueFromCore(): Promise<void> {
      const action = overview.value?.nextActionControl;
      if (!action) {
        fail(new Error("Core 尚未返回可执行的下一步；请刷新当前工程后重试。"));
        return;
      }
      const code = action.code;
      const locator = action?.locator;
      if (locator?.unitId) bindingFocus.unitId = locator.unitId;
      if (locator?.panelId) bindingFocus.panelId = locator.panelId;
      if (code === "import-script") {
        selectStudioMode("library");
        selectSection("script");
        notice.value = "请点击“导入剧本”选择文件；继续按钮不会替你打开文件或直接写入。";
      } else if (code === "create-canonical-assets") {
        selectStudioMode("library");
        selectSection("character");
        openCreateDialog("character");
        notice.value = "已打开角色资产表单；确认内容后再创建。场景和道具可在左侧继续建立。";
      } else if (code === "promote-authority" || locator?.kind === "asset") {
        await openAssetLocator(locator?.assetId);
      } else if (code.includes("binding") || code.includes("unmatched") || code.includes("ambiguity")) {
        selectStudioMode("binding");
      } else if (code.includes("review") || code.includes("checkpoint") || code.includes("continuity")) {
        selectStudioMode("continuity-review");
      } else if (code.includes("generation") || code.includes("dispatch") || code.includes("freeze")) {
        selectStudioMode("generation");
      } else if (code === "create-production-units") {
        selectStudioMode("binding");
        notice.value = "当前工程尚无 15 秒单元。请先在剧本流程建立 2–6 宫格单元，再进入实体绑定。";
      } else if (locator?.unitId || locator?.panelId) {
        dashboardFocus.value = {
          ...(locator.unitId ? { unitId: locator.unitId } : {}),
          ...(locator.panelId ? { panelId: locator.panelId } : {}),
        };
        selectStudioMode("dashboard");
      } else {
        selectStudioMode("dashboard");
      }
      if (action.requiresWrite && !notice.value) {
        notice.value = `已定位“${action.label}”；请检查预填内容并明确确认后再写入。`;
      }
    }

    function selectStudioMode(
      mode: StudioUiMode,
      focus?: { unitId?: string; panelId?: string; generationRunId?: string } | null,
    ): void {
      if (pendingAction.value) return;
      if ((mode === "canvas" || mode === "dashboard") && !props.dashboardApi) return;
      if (mode === "multimedia-timeline" && !props.multimediaTimelineApi) return;
      if (mode === "binding" && !props.bindingApi) return;
      if (mode === "continuity-review" && !props.continuityReviewApi) return;
      activeMode.value = mode;
      clearFeedback();
      emit("studioContextChanged", {
        mode,
        ...((focus?.unitId || bindingFocus.unitId) ? { unitId: focus?.unitId || bindingFocus.unitId } : {}),
        ...((focus?.panelId || bindingFocus.panelId) ? { panelId: focus?.panelId || bindingFocus.panelId } : {}),
        ...(focus?.generationRunId ? { generationRunId: focus.generationRunId } : {}),
      });
    }

    async function openAssetLocator(assetId?: string): Promise<void> {
      selectStudioMode("library");
      if (!assetId?.trim()) {
        selectSection("character");
        notice.value = "请选择尚未锁定权威参考图的资产；通过审核后才能提升为主权威。";
        return;
      }
      const root = props.projectRoot;
      const entryId = `asset:${assetId.trim()}`;
      const request = ++detailRequest;
      detailLoading.value = true;
      selectedId.value = entryId;
      detail.value = null;
      try {
        const next = await props.api.getEntryDetail(root, entryId);
        if (disposed || request !== detailRequest || root !== props.projectRoot) return;
        if (!next || !isAssetKind(next.kind)) throw new Error(`Core 指向的资产不存在：${assetId}`);
        activeSection.value = next.kind;
        detail.value = next;
        syncReviewDrafts(next);
        emit("selectionChanged", entryId);
        notice.value = `已定位资产“${next.title}”；请选择已通过审核的参考版本并明确提升。`;
      } catch (reason) {
        if (request === detailRequest && root === props.projectRoot) fail(reason);
      } finally {
        if (request === detailRequest && root === props.projectRoot) detailLoading.value = false;
      }
    }

    function onBindingChanged(message: string): void {
      emit("bindingChanged", message);
    }

    function onBindingFailed(message: string): void {
      emit("failed", message);
    }

    function onContinuityReviewFailed(message: string): void {
      emit("failed", message);
    }

    function onDashboardFailed(message: string): void {
      emit("failed", message);
    }

    async function runAction(
      id: string,
      successNotice: string,
      operation: (scope: FrozenMaterialActionScope) => Promise<void | boolean>,
    ): Promise<void> {
      if (pendingAction.value) return;
      const request = ++actionRequest;
      const root = props.projectRoot;
      const scope: FrozenMaterialActionScope = {
        token: actionGate.begin(root, id),
        projectRoot: root,
        actionId: id,
      };
      pendingAction.value = id;
      clearFeedback();
      try {
        const completed = await operation(scope);
        if (request !== actionRequest || !materialActionIsCurrent(scope)) return;
        if (completed !== false) notice.value = successNotice;
      } catch (reason) {
        if (request === actionRequest && materialActionIsCurrent(scope)) fail(reason);
      } finally {
        if (request === actionRequest && materialActionIsCurrent(scope)) pendingAction.value = "";
      }
    }

    function clearFeedback(): void {
      error.value = "";
      notice.value = "";
    }

    function fail(reason: unknown): void {
      error.value = toUserFacingErrorText(reason);
      emit("failed", error.value);
    }

    function countFor(section: MaterialStudioSection): number {
      if (!overview.value) return 0;
      if (section === "script") return overview.value.counts.scripts;
      if (section === "prompt") return overview.value.counts.prompts;
      return overview.value.counts[section];
    }

    function sectionLabel(section: MaterialStudioSection): string {
      return sections.find((entry) => entry.id === section)?.label ?? section;
    }

    function iconForEntry(entry: MaterialStudioUiEntry): Component {
      if (entry.kind === "character") return UserRound;
      if (entry.kind === "scene") return Mountain;
      if (entry.kind === "prop") return Package;
      if (entry.kind === "style") return Palette;
      if (entry.kind === "script") return FileText;
      if (entry.kind === "prompt") return Bot;
      if (entry.kind === "image") return ImageIcon;
      return Film;
    }

    function kindLabel(kind: MaterialStudioUiEntry["kind"]): string {
      return ({
        script: "剧本",
        prompt: "提示词",
        character: "角色",
        scene: "场景",
        prop: "道具",
        style: "风格",
        media: "媒体",
        image: "图片",
        video: "视频",
        audio: "音频",
      } satisfies Record<MaterialStudioUiEntry["kind"], string>)[kind];
    }

    function authorityLabel(state?: MaterialStudioAuthorityState): string {
      return ({ locked: "主权威已锁定", candidate: "有待审核版本", missing: "等待权威图" } as const)[state ?? "missing"];
    }

    function reviewLabel(status: MaterialStudioReviewStatus): string {
      return ({ pending: "待审核", approved: "已通过", rejected: "已拒绝" } as const)[status];
    }

    function relationLabel(kind: MaterialStudioAssetRelationKind): string {
      return ({
        derived_from: "派生自",
        variant_of: "变体自",
        reference_of: "参考自",
        composite_member: "组合成员",
      } as const)[kind];
    }

    function relationOtherAsset(relation: MaterialStudioUiRelation, assetId: string): string {
      return relation.subjectAssetId === assetId ? relation.objectAssetId : relation.subjectAssetId;
    }

    function relationDirection(relation: MaterialStudioUiRelation, assetId: string): string {
      if (relation.kind === "composite_member") {
        return relation.objectAssetId === assetId ? "成员 → 当前组合" : "当前资产 → 组合";
      }
      return relation.subjectAssetId === assetId ? "当前资产 → 来源" : "派生资产 → 当前资产";
    }

    function relationStatusLabel(status: MaterialStudioUiRelation["status"]): string {
      return ({ current: "当前有效", stale: "当前已过期", superseded: "历史已替代" } as const)[status];
    }

    function applicabilityTokens(value?: MaterialStudioApplicability): string[] {
      if (!value) return [];
      const tokens = [
        ...value.projects.map((entry) => `项目 ${entry}`),
        ...value.seasons.map((entry) => `季 ${entry}`),
        ...value.episodes.map((entry) => `集 ${entry}`),
        ...value.units.map((entry) => `单元 ${entry}`),
        ...value.timeRanges.map((entry) => `${entry.scope === "unit" ? "单元" : "集"} ${entry.scopeId} · ${entry.startSeconds}-${entry.endSeconds}s`),
        ...value.tags.map((entry) => `标签 ${entry}`),
      ];
      return tokens.length ? tokens : ["当前工程全局适用"];
    }

    function mediaPreviewStatusLabel(status?: NonNullable<MaterialStudioUiDetail["mediaPreview"]>["status"]): string {
      if (status === "ready") return "轻量代理就绪";
      if (status === "blocked") return "媒体引擎不可用";
      if (status === "failed") return "派生失败";
      if (status === "not-required") return "冻结缩略图";
      return "等待选择";
    }

    function formatDate(value: string): string {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(date);
    }

    function formatBytes(value: number): string {
      if (value < 1_024) return `${value} B`;
      if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KiB`;
      return `${(value / 1_024 / 1_024).toFixed(1)} MiB`;
    }

    function shortSha(value: string): string {
      return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
    }

    function compactTextPreview(value: string, kind: "script" | "prompt"): string {
      const limit = kind === "prompt" ? 360 : 800;
      return value.length > limit ? `${value.slice(0, limit).trimEnd()}…` : value;
    }

    function friendlyMaterialText(value: string): string {
      return value
        .replaceAll("current AssetBindingSet", "当前有效的生成绑定")
        .replaceAll("AssetBindingSet", "生成绑定")
        .replaceAll("BindingSet", "生成绑定")
        .replaceAll("generation-ready", "可以生图")
        .replaceAll("Core", "系统")
        .replaceAll("Dashboard", "驾驶舱")
        .replaceAll("current", "当前有效");
    }

    return {
      shellTheme,
      activeSection,
      activeMode,
      generationProvider,
      canvasFocus,
      dashboardFocus,
      bindingFocus,
      onDashboardOpenCanvas,
      onCanvasOpenDashboard,
      onCanvasOpenBinding,
      activeSectionIcon,
      assetCategories,
      createDialogOpen,
      createDraft,
      createNameInput,
      crossProjectPackage,
      relationDraft,
      relationSearch,
      relationCandidates,
      relationCandidatesLoading,
      detail,
      textRevisions,
      textRevisionsLoading,
      textRevisionsError,
      detailLoading,
      entries,
      error,
      loading,
      loadingMore,
      canLoadPrevious,
      currentPageNumber,
      hasPendingVersions,
      selectedMediaCanBecomeAuthority,
      nextCursor,
      notice,
      overview,
      pageTotal,
      pendingAction,
      searchInput,
      searchPlaceholder,
      searchQuery,
      sections,
      selectedId,
      selectedMedia,
      versionPreview,
      versionSourceNote,
      reviewDrafts,
      viewMode,
      visibleTotal,
      authorityLabel,
      closeCreateDialog,
      closeVersionPreview,
      clearSelectedMedia,
      countFor,
      createAsset,
      exportCurrentAssetPackage,
      pickCrossProjectAssetPackage,
      importCrossProjectAssetItem,
      formatBytes,
      formatDate,
      friendlyMaterialText,
      iconForEntry,
      importMedia,
      importPrompt,
      importScript,
      isAssetKind,
      isAssetSection,
      isMediaKind,
      kindLabel,
      loadNextPage,
      loadPreviousPage,
      openCreateDialog,
      openVersionPreview,
      openTimeline,
      onBindingChanged,
      onBindingFailed,
      onContinuityReviewFailed,
      onDashboardFailed,
      onCanvasOpenReview,
      onCanvasRequestGeneration,
      onScriptOpenUnit,
      onGenerationQueueChanged,
      onGenerationQueueFailed,
      onGenerationQueueJump,
      appendSelectedMediaVersion,
      appendRelation,
      scheduleRelationCandidateSearch,
      onRelationEditorToggle,
      rebaseRelation,
      applicabilityTokens,
      canReviewVersion,
      promoteAuthority,
      refresh,
      reviewFocus,
      reviewLabel,
      relationDirection,
      relationLabel,
      relationOtherAsset,
      relationStatusLabel,
      mediaPreviewStatusLabel,
      reviewVersion,
      sectionLabel,
      selectEntry,
      selectProductionStep,
      continueFromCore,
      selectStudioMode,
      selectSection,
      shortSha,
      compactTextPreview,
    };
  },
});

function isAssetSection(section: MaterialStudioSection): section is MaterialStudioAssetCategory {
  return section === "character" || section === "scene" || section === "prop" || section === "style";
}

function isAssetKind(kind: MaterialStudioUiDetail["kind"]): kind is MaterialStudioAssetCategory {
  return kind === "character" || kind === "scene" || kind === "prop" || kind === "style";
}

function isMediaKind(kind: MaterialStudioUiEntry["kind"]): kind is "image" | "video" | "audio" | "media" {
  return kind === "image" || kind === "video" || kind === "audio" || kind === "media";
}
</script>

<style scoped>
.studio-mode-switch{display:inline-flex;margin-top:10px;border:1px solid var(--line);border-radius:3px;overflow:hidden;background:var(--ui-surface-2)}
.studio-mode-switch button{min-width:76px;height:29px;padding:0 10px;border:0;border-right:1px solid var(--line);background:transparent;color:var(--muted);font:600 9px/1 inherit;letter-spacing:.04em;cursor:pointer}
.studio-mode-switch button:last-child{border-right:0}
.studio-mode-switch button.active{background:var(--ui-accent-soft);color:var(--gold)}
.studio-mode-switch button:focus-visible{position:relative;z-index:1;outline:2px solid var(--gold);outline-offset:-2px}
.studio-utility-switch{display:flex;gap:4px;margin-top:6px}
.studio-utility-switch button{height:23px;padding:0 8px;border:1px solid var(--ui-line);background:transparent;color:var(--ui-text-2);font-size:8px;cursor:pointer}
.studio-utility-switch button.active{border-color:var(--ui-accent);color:var(--ui-accent-strong)}
.binding-mode{grid-row:2/-1;min-width:0;min-height:0;overflow:auto;padding:18px;background:var(--ui-bg)}
.binding-mode :deep(.binding-workbench){min-height:100%;box-sizing:border-box}
.binding-mode.generation-mode,.binding-mode.support-mode{padding:0;overflow:hidden}
.binding-mode.generation-mode :deep(.generation-view),.binding-mode.support-mode :deep(.desktop-support){height:100%;min-height:640px}
.binding-loading{min-height:360px;display:flex;align-items:center;justify-content:center;gap:9px;color:var(--muted);font-size:11px}
.managed-queue-hint{color:var(--ui-text-2);font-size:9px;margin-right:8px}
.material-studio{--ink-0:var(--ui-bg);--ink-1:var(--ui-surface);--ink-2:var(--ui-surface-2);--ink-3:var(--ui-surface-2);--line:var(--ui-line);--line-strong:var(--ui-text-3);--text:var(--ui-text);--muted:var(--ui-text-2);--dim:var(--ui-text-3);--gold:var(--ui-accent);--gold-soft:var(--ui-accent-strong);position:relative;height:100%;min-height:640px;display:grid;grid-template-rows:auto minmax(0,1fr) 72px;overflow:hidden;background:var(--ink-0);color:var(--text);font-family:var(--ui-font-sans)}
.studio-header{min-height:104px;display:grid;grid-template-columns:minmax(330px,1.2fr) auto minmax(310px,.9fr) auto;align-items:center;gap:28px;padding:16px 22px;border-bottom:1px solid var(--line);background:var(--ink-1)}
.product-mark{color:var(--gold);font:700 10px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em}
.project-identity h1{margin:6px 0 4px;font-size:21px;line-height:1.2;letter-spacing:-.02em}
.project-identity p{margin:0;color:var(--dim);font-size:11px}
.project-counts{display:flex;align-items:stretch;border-left:1px solid var(--line)}
.project-counts div{min-width:72px;padding:4px 14px;border-right:1px solid var(--line)}
.project-counts strong,.project-counts span{display:block}
.project-counts strong{font:600 18px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace}
.project-counts span{margin-top:4px;color:var(--dim);font-size:9px}
.next-action{min-width:0;padding-left:14px;border-left:2px solid var(--gold)}
.next-action span{color:var(--gold);font-size:9px;letter-spacing:.08em}
.next-action p{margin:5px 0 0;color:var(--ui-text);font-size:12px;line-height:1.5}
.header-actions{display:flex;gap:8px}
.generation-provider-selector{min-width:112px;display:grid;gap:4px;align-content:center}
.generation-provider-selector>span{color:var(--dim);font-size:8px;letter-spacing:.05em}
.generation-provider-selector select{height:34px;padding:0 24px 0 9px;border:1px solid var(--line-strong);border-radius:2px;background:var(--ui-surface);color:var(--ui-text);font:600 10px/1 inherit}
.primary-action,.quiet-action{min-height:34px;display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:0 12px;border:1px solid var(--line-strong);border-radius:2px;font:600 11px/1 inherit;cursor:pointer}
.primary-action{border-color:var(--gold-soft);background:var(--gold);color:var(--ui-accent-contrast)}
.quiet-action{background:transparent;color:var(--ui-text-2)}
.primary-action:hover:not(:disabled){background:var(--ui-accent-strong)}
.quiet-action:hover:not(:disabled){border-color:var(--gold-soft);color:var(--gold)}
.cross-project-reuse>p{margin:7px 0;color:var(--dim);font-size:9px;line-height:1.55}.reuse-actions{display:flex;gap:6px}.reuse-actions button,.reuse-package article button{min-height:28px;border:1px solid var(--line-strong);background:transparent;color:var(--text);font-size:9px;cursor:pointer}.reuse-package{display:grid;gap:6px;margin-top:9px;padding:8px;border:1px solid var(--line);background:var(--ink-2)}.reuse-package>code{color:var(--dim);font-size:8px}.reuse-package article{display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:6px;border-top:1px solid var(--line)}.reuse-package article span{display:block;margin-top:2px;color:var(--dim);font-size:8px}
button:disabled{cursor:not-allowed;opacity:.46}
.studio-body{min-height:0;display:grid;grid-template-columns:184px minmax(430px,1fr)}
.studio-body.with-detail{grid-template-columns:184px minmax(430px,1fr) 370px}
.section-rail{min-height:0;display:flex;flex-direction:column;border-right:1px solid var(--line);background:var(--ui-surface)}
.rail-heading{height:51px;display:flex;align-items:center;justify-content:space-between;padding:0 14px;border-bottom:1px solid var(--line)}
.rail-heading span{font-size:10px;font-weight:700}
.rail-heading small{color:var(--dim);font-size:8px}
.rail-entry{height:45px;display:grid;grid-template-columns:22px 1fr auto;align-items:center;gap:7px;padding:0 14px;border:0;border-left:2px solid transparent;background:transparent;color:var(--muted);text-align:left;cursor:pointer}
.rail-entry b{color:var(--dim);font:9px ui-monospace,SFMono-Regular,Menlo,monospace}
.rail-entry:hover{background:var(--ink-2);color:var(--text)}
.rail-entry.active{border-left-color:var(--gold);background:var(--ui-accent-soft);color:var(--gold)}
.rail-entry.active b{color:var(--gold)}
.rail-create{margin:14px 12px 0;padding-top:12px;border-top:1px solid var(--line)}
.rail-create>span{display:block;margin:0 2px 7px;color:var(--dim);font-size:8px}
.rail-create button{width:100%;height:31px;display:flex;align-items:center;gap:7px;padding:0 7px;border:0;background:transparent;color:var(--ui-text-2);font-size:10px;text-align:left;cursor:pointer}
.rail-create button:hover{color:var(--gold);background:var(--ink-2)}
.isolation-note{margin:auto 13px 14px;padding-top:12px;display:flex;gap:8px;border-top:1px solid var(--line);color:var(--gold-soft)}
.isolation-note p{margin:0}
.isolation-note b,.isolation-note span{display:block}
.isolation-note b{color:var(--ui-text-2);font-size:9px}
.isolation-note span{margin-top:4px;color:var(--dim);font-size:8px;line-height:1.45}
.material-browser{min-width:0;min-height:0;display:grid;grid-template-rows:52px auto auto minmax(0,1fr);background:var(--ink-1)}
.browser-toolbar{display:flex;align-items:center;gap:12px;padding:0 16px;border-bottom:1px solid var(--line)}
.search-field{width:min(420px,55%);height:31px;display:flex;align-items:center;gap:7px;padding:0 9px;border:1px solid var(--line);background:var(--ink-0);color:var(--dim)}
.search-field:focus-within{border-color:var(--gold-soft);color:var(--gold)}
.search-field input{min-width:0;flex:1;border:0;outline:0;background:transparent;color:var(--text);font:11px inherit}
.search-field input::placeholder{color:var(--ui-text-3)}
.search-field button{display:grid;place-items:center;padding:2px;border:0;background:transparent;color:var(--dim);cursor:pointer}
.result-scope{margin-left:auto;color:var(--dim);font-size:9px}
.view-switch{height:29px;display:flex;border:1px solid var(--line)}
.view-switch button{width:31px;display:grid;place-items:center;border:0;border-right:1px solid var(--line);background:transparent;color:var(--dim);cursor:pointer}
.view-switch button:last-child{border-right:0}
.view-switch button.active{background:var(--ui-accent-soft);color:var(--gold)}
.error-banner{display:flex;align-items:center;gap:8px;padding:8px 14px;border-bottom:1px solid var(--ui-danger);background:var(--ui-surface-2);color:var(--ui-danger);font-size:10px}
.error-banner span{flex:1}
.error-banner button{border:0;background:transparent;color:var(--ui-danger);font-size:9px;text-decoration:underline;cursor:pointer}
.operation-notice{margin:0;padding:7px 14px;border-bottom:1px solid var(--gold-soft);background:var(--ui-accent-soft);color:var(--ui-accent-strong);font-size:9px}
.entries-region{min-height:0;overflow:auto;scrollbar-color:var(--ui-line) var(--ui-bg);scrollbar-width:thin}
.loading-state,.empty-state{height:100%;min-height:300px;display:grid;place-content:center;justify-items:center;gap:10px;color:var(--dim);text-align:center}
.loading-state span{font-size:10px}
.empty-state h2{margin:3px 0 0;color:var(--ui-text);font-size:17px}
.empty-state p{max-width:390px;margin:0 0 8px;color:var(--dim);font-size:10px;line-height:1.6}
.entry-collection.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(174px,1fr));align-content:start}
.material-entry{position:relative;min-width:0;padding:0;border:0;border-right:1px solid var(--line);border-bottom:1px solid var(--line);background:var(--ui-surface);color:inherit;text-align:left;cursor:pointer}
.material-entry:hover,.material-entry.selected{background:var(--ui-surface-2);box-shadow:inset 0 0 0 1px var(--gold-soft)}
.material-entry:focus-visible{z-index:2;outline:2px solid var(--gold);outline-offset:-2px}
.material-entry figure{position:relative;height:148px;margin:0;display:grid;place-items:center;overflow:hidden;background:var(--ui-surface-2)}
.material-entry figure img{width:100%;height:100%;object-fit:cover}
.material-entry figure>span{color:var(--ui-text-3)}
.material-entry figure em{position:absolute;left:8px;bottom:8px;display:flex;align-items:center;gap:4px;padding:4px 6px;border:1px solid var(--gold-soft);border-radius:2px;background:var(--ui-surface);color:var(--gold);font-size:8px;font-style:normal}
.entry-copy{min-height:112px;padding:11px}
.entry-copy>span{display:block;color:var(--gold-soft);font-size:8px;letter-spacing:.05em}
.entry-copy>strong{display:block;margin-top:6px;overflow:hidden;color:var(--ui-text);font-size:12px;text-overflow:ellipsis;white-space:nowrap}
.entry-copy>p{height:30px;margin:6px 0 0;display:-webkit-box;overflow:hidden;color:var(--ui-text-3);font-size:9px;line-height:1.55;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.entry-copy footer{margin-top:9px;display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--ui-text-3)}
.entry-copy small,.entry-copy time{overflow:hidden;font-size:8px;text-overflow:ellipsis;white-space:nowrap}
.entry-collection.list{display:block}
.entry-collection.list .material-entry{width:100%;height:82px;display:grid;grid-template-columns:104px minmax(0,1fr) 24px;align-items:center;border-right:0}
.entry-collection.list .material-entry figure{height:81px}
.entry-collection.list .entry-copy{min-height:0;padding:10px 14px}
.entry-collection.list .entry-copy>p{height:auto;white-space:nowrap;text-overflow:ellipsis}
.row-arrow{color:var(--dim)}
.load-more{height:52px;display:flex;align-items:center;justify-content:center;gap:16px;border-top:1px solid var(--line);color:var(--dim);font-size:9px}
.load-more button{height:28px;display:flex;align-items:center;gap:6px;padding:0 10px;border:1px solid var(--line-strong);background:transparent;color:var(--gold);font-size:9px;cursor:pointer}
.detail-inspector{min-width:0;min-height:0;overflow:auto;border-left:1px solid var(--line);background:var(--ui-surface);scrollbar-color:var(--ui-line) var(--ui-bg);scrollbar-width:thin}
.detail-placeholder{height:100%;min-height:320px;display:grid;place-content:center;justify-items:center;gap:9px;padding:30px;color:var(--dim);text-align:center}
.detail-placeholder h2{margin:4px 0 0;color:var(--ui-text);font-size:15px}
.detail-placeholder p{max-width:270px;margin:0;font-size:9px;line-height:1.6}
.detail-header{padding:18px;border-bottom:1px solid var(--line)}
.detail-header>span{color:var(--gold);font:8px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.07em}
.detail-header h2{margin:6px 0;font-size:19px;line-height:1.25}
.detail-header p{margin:0;color:var(--muted);font-size:10px;line-height:1.55}
.authority-visual,.detail-section{padding:14px 18px;border-bottom:1px solid var(--line)}
.section-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:9px}
.section-title span,.detail-section h3{color:var(--ui-text-2);font-size:9px;font-weight:700}
.section-title b{color:var(--gold);font-size:8px}
.authority-visual figure{height:190px;margin:0;display:grid;place-items:center;overflow:hidden;background:var(--ui-surface-2)}
.authority-visual figure img{width:100%;height:100%;object-fit:contain}
.authority-visual figure span{display:grid;justify-items:center;gap:8px;color:var(--ui-text-3);font-size:9px}
.authority-visual dl{display:grid;grid-template-columns:48px minmax(0,1fr);gap:6px;margin:10px 0 0}
.authority-visual dt{color:var(--dim);font-size:8px}
.authority-visual dd{margin:0;overflow:hidden;color:var(--ui-text-2);font:8px ui-monospace,SFMono-Regular,Menlo,monospace;text-overflow:ellipsis;white-space:nowrap}
.detail-section h3{margin:0 0 10px}
.token-line{display:flex;flex-wrap:wrap;gap:5px}
.token-line span{padding:4px 6px;border:1px solid var(--line);color:var(--ui-text-2);font-size:8px}
.plain-list,.locks-section ul{margin:0;padding-left:17px;color:var(--ui-text-2);font-size:9px;line-height:1.65}
.plain-list li::marker,.locks-section li::marker{color:var(--gold-soft)}
.locks-section>div+div{margin-top:12px;padding-top:10px;border-top:1px solid var(--line)}
.locks-section>div>span,.prompt-section>div>span{display:block;margin-bottom:6px;color:var(--gold-soft);font-size:8px}
.locks-section .negative>span{color:var(--ui-danger)}
.locks-section .negative li::marker{color:var(--ui-danger)}
.prompt-section>div+div{margin-top:10px}
.prompt-section p{margin:0;padding-left:9px;border-left:1px solid var(--line-strong);color:var(--ui-text-2);font-size:9px;line-height:1.6;white-space:pre-wrap}
.prompt-section footer{margin-top:10px;display:flex;align-items:center;gap:6px;color:var(--gold);font:8px ui-monospace,SFMono-Regular,Menlo,monospace}
.versions-section article{display:grid;grid-template-columns:30px 1fr auto;align-items:center;gap:8px;padding:8px 0;border-top:1px solid var(--line)}
.versions-section article.primary{color:var(--gold)}
.versions-section article>div b,.versions-section article>div span{display:block}
.versions-section article>div b{font-size:9px}
.versions-section article>div span{margin-top:2px;color:var(--dim);font-size:7px}
.versions-section code{overflow:hidden;color:var(--ui-text-3);font:7px ui-monospace,SFMono-Regular,Menlo,monospace;text-overflow:ellipsis}
.versions-section article>button{padding:4px 6px;border:1px solid var(--gold-soft);background:transparent;color:var(--gold);font-size:7px;cursor:pointer}
.codex-handoff{margin:14px 18px 18px;padding:12px 0;display:flex;gap:10px;border-top:1px solid var(--gold-soft);border-bottom:1px solid var(--gold-soft);color:var(--gold)}
.codex-handoff b,.codex-handoff span{display:block}
.codex-handoff b{font-size:10px}
.codex-handoff span{margin-top:5px;color:var(--ui-text-2);font-size:8px;line-height:1.55}
.timeline-dock{min-width:0;display:grid;grid-template-columns:180px minmax(260px,1fr) auto auto;align-items:center;gap:18px;padding:0 18px;border-top:1px solid var(--line-strong);background:var(--ui-bg)}
.timeline-label{display:flex;align-items:center;gap:9px;color:var(--gold)}
.timeline-label span,.timeline-label b{display:block}
.timeline-label span{font-size:8px;letter-spacing:.08em}
.timeline-label b{margin-top:4px;overflow:hidden;max-width:150px;color:var(--ui-text-2);font-size:9px;text-overflow:ellipsis;white-space:nowrap}
.timeline-track{height:34px;display:flex;gap:2px;align-items:stretch}
.timeline-track>span{position:relative;min-width:36px;display:flex;align-items:center;justify-content:space-between;gap:5px;padding:0 7px;border-top:2px solid var(--ui-line);background:var(--ui-surface-2);color:var(--ui-text-2);overflow:hidden}
.timeline-track>span.current{border-top-color:var(--gold);background:var(--ui-accent-soft);color:var(--ui-accent-strong)}
.timeline-track>span.complete{border-top-color:var(--gold-soft);color:var(--ui-text-2)}
.timeline-track i{overflow:hidden;font-size:8px;font-style:normal;text-overflow:ellipsis;white-space:nowrap}
.timeline-track small{font:7px ui-monospace,SFMono-Regular,Menlo,monospace}
.timeline-track .timeline-empty{width:100%;border-top-style:dashed}
.timeline-summary{display:flex;gap:12px;color:var(--dim);font-size:8px}
.timeline-dock>button{height:32px;display:flex;align-items:center;gap:5px;padding:0 10px;border:1px solid var(--gold-soft);background:transparent;color:var(--gold);font-size:9px;cursor:pointer}
.dialog-backdrop{position:absolute;inset:0;z-index:30;display:grid;place-items:center;padding:24px;background:rgba(18,19,15,.48);backdrop-filter:blur(5px)}
.create-dialog{width:min(520px,calc(100% - 32px));padding:0;border:1px solid var(--line-strong);border-radius:2px;background:var(--ui-surface);color:var(--text);box-shadow:0 28px 80px rgba(0,0,0,.25)}
.create-dialog>header{height:66px;display:flex;align-items:center;justify-content:space-between;padding:0 18px;border-bottom:1px solid var(--line)}
.create-dialog>header span{color:var(--gold);font:8px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em}
.create-dialog>header h2{margin:4px 0 0;font-size:17px}
.create-dialog>header button{border:0;background:transparent;color:var(--muted);cursor:pointer}
.create-dialog fieldset,.create-dialog>label{margin:14px 18px 0;padding:0;border:0}
.create-dialog legend,.create-dialog>label>span{display:block;margin-bottom:7px;color:var(--ui-text-2);font-size:9px}
.category-choice{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--line)}
.category-choice button{height:35px;display:flex;align-items:center;justify-content:center;gap:6px;border:0;border-right:1px solid var(--line);background:transparent;color:var(--muted);cursor:pointer}
.category-choice button:last-child{border-right:0}
.category-choice button.active{background:var(--ui-accent-soft);color:var(--gold)}
.create-dialog input,.create-dialog textarea{width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:2px;outline:0;background:var(--ui-surface);color:var(--text);font:11px/1.5 inherit}
.create-dialog input{height:36px;padding:0 10px}
.create-dialog textarea{padding:8px 10px;resize:vertical}
.create-dialog input:focus,.create-dialog textarea:focus{border-color:var(--gold-soft)}
.create-dialog>p{margin:13px 18px 0;color:var(--dim);font-size:8px;line-height:1.5}
.create-dialog>footer{display:flex;justify-content:flex-end;gap:8px;margin-top:16px;padding:13px 18px;border-top:1px solid var(--line)}
.spinning{animation:studio-spin .8s linear infinite}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@keyframes studio-spin{to{transform:rotate(360deg)}}
@media(max-width:1280px){.studio-header{grid-template-columns:minmax(290px,1fr) auto minmax(250px,.8fr)}
.project-counts{display:none}
.studio-body{grid-template-columns:166px minmax(390px,1fr)}
.studio-body.with-detail{grid-template-columns:166px minmax(390px,1fr) 330px}
}
@media(max-width:980px){.material-studio{min-height:760px;overflow:auto;grid-template-rows:auto auto auto}
.studio-header{grid-template-columns:1fr auto}
.next-action{grid-column:1/-1}
.studio-body{min-height:640px;grid-template-columns:150px minmax(400px,1fr)}
.detail-inspector{display:none}
.timeline-dock{grid-template-columns:160px 1fr auto}
.timeline-summary{display:none}
}
@media(prefers-reduced-motion:reduce){.spinning{animation:none}
.material-entry,.rail-entry,.primary-action,.quiet-action{transition:none!important}
}
.create-dialog{max-height:calc(100vh - 48px);overflow:auto}
.material-entry.source-selected{box-shadow:inset 0 0 0 1px var(--ui-ok)}
.material-entry figure .source-marker{inset:8px 8px auto auto;border-color:var(--ui-ok);background:var(--ui-surface);color:var(--ui-ok)}
.selected-media-detail{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 18px;border-bottom:1px solid var(--ui-ok);background:var(--ui-surface-2)}
.selected-media-detail>div{min-width:0;display:flex;align-items:center;gap:8px;color:var(--ui-ok)}
.selected-media-detail span,.selected-media-detail b,.selected-media-detail small{display:block}
.selected-media-detail b{font-size:9px}
.selected-media-detail small{margin-top:3px;color:var(--ui-text-3);font:7px ui-monospace,SFMono-Regular,Menlo,monospace}
.selected-media-detail button{flex:0 0 auto;padding:4px 7px;border:1px solid var(--ui-ok);background:transparent;color:var(--ui-ok);font-size:8px;cursor:pointer}
.version-intake{background:var(--ui-surface)}
.version-intake label>span{display:block;margin:10px 0 6px;color:var(--ui-text-2);font-size:8px}
.version-intake textarea,.review-controls textarea{width:100%;box-sizing:border-box;padding:8px 9px;border:1px solid var(--line);border-radius:2px;outline:0;resize:vertical;background:var(--ui-surface);color:var(--text);font:9px/1.55 inherit}
.version-intake textarea:focus,.review-controls textarea:focus{border-color:var(--gold-soft)}
.version-intake>small,.workflow-disabled-note{display:block;margin:7px 0 0;color:var(--ui-danger);font-size:8px;line-height:1.45}
.selected-source{display:grid;grid-template-columns:52px minmax(0,1fr) 24px;align-items:center;gap:9px;padding:7px;border:1px solid var(--ui-ok);background:var(--ui-surface)}
.selected-source figure{width:52px;height:52px;margin:0;display:grid;place-items:center;overflow:hidden;background:var(--ui-surface-2);color:var(--ui-text-3)}
.selected-source figure img{width:100%;height:100%;object-fit:cover}
.selected-source div{min-width:0}
.selected-source b,.selected-source span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.selected-source b{color:var(--ui-text);font-size:9px}
.selected-source span{margin-top:5px;color:var(--ui-text-3);font:7px ui-monospace,SFMono-Regular,Menlo,monospace}
.selected-source button{display:grid;place-items:center;padding:4px;border:0;background:transparent;color:var(--ui-text-3);cursor:pointer}
.append-version-action{width:100%;min-height:31px;margin-top:8px;display:flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--ui-ok);background:var(--ui-surface-2);color:var(--ui-ok);font-size:9px;font-weight:700;cursor:pointer}
.append-version-action:hover:not(:disabled){background:var(--ui-surface-2)}
.source-empty{padding:12px;border:1px dashed var(--line-strong);background:var(--ui-surface)}
.source-empty p{margin:0;color:var(--ui-text-3);font-size:9px;line-height:1.55}
.source-empty button{margin-top:8px;display:flex;align-items:center;gap:4px;padding:0;border:0;background:transparent;color:var(--gold);font-size:8px;cursor:pointer}
.versions-section article{display:block;padding:10px 0 10px 9px;border-top:1px solid var(--line);border-left:2px solid var(--ui-text-3)}
.versions-section article.pending{border-left-color:var(--ui-accent)}
.versions-section article.approved{border-left-color:var(--ui-ok)}
.versions-section article.rejected{border-left-color:var(--ui-danger)}
.versions-section article.primary{background:linear-gradient(90deg,var(--ui-accent-soft) 0,transparent 75%)}
.versions-section article>header{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.versions-section article>header>div:first-child{min-width:0;display:flex;align-items:center;gap:6px}
.versions-section article>header b{color:var(--ui-text);font-size:9px}
.versions-section article>header span,.versions-section article>header em{display:inline-flex;align-items:center;min-height:17px;padding:0 5px;border:1px solid currentColor;border-radius:2px;font-size:7px;font-style:normal}
.versions-section .review-pending{color:var(--ui-accent-strong)}
.versions-section .review-approved{color:var(--ui-ok)}
.versions-section .review-rejected{color:var(--ui-danger)}
.versions-section article>header em{color:var(--gold)}
.version-meta{min-width:0;text-align:right}
.versions-section .version-meta code,.versions-section .version-meta time{display:block;overflow:hidden;color:var(--ui-text-3);font:7px ui-monospace,SFMono-Regular,Menlo,monospace;text-overflow:ellipsis;white-space:nowrap}
.versions-section .version-meta time{margin-top:3px;color:var(--ui-text-3)}
.version-visual{position:relative;width:100%;min-height:112px;margin-top:9px;padding:0;display:grid;place-items:center;overflow:hidden;border:1px solid var(--ui-line);background:var(--ui-surface-2);color:var(--ui-text-3);cursor:zoom-in}
.version-visual img{display:block;width:100%;height:156px;object-fit:contain;background:var(--ui-surface-2)}
.version-visual>span{display:flex;align-items:center;gap:7px;padding:18px;font-size:8px}
.version-visual>em{position:absolute;right:7px;bottom:7px;padding:4px 6px;border:1px solid var(--ui-accent);background:var(--ui-surface);color:var(--ui-accent-strong);font-size:7px;font-style:normal}
.source-note,.review-note{margin:8px 0 0;color:var(--ui-text-2);font-size:8px;line-height:1.55;white-space:pre-wrap}
.source-note b,.review-note b{display:inline-block;margin-right:7px;color:var(--ui-text-2);font-size:7px;letter-spacing:.08em}
.review-controls{margin-top:9px;padding:8px;border:1px solid var(--ui-line);background:var(--ui-surface)}
.review-controls label>span{display:block;margin-bottom:6px;color:var(--ui-text-2);font-size:8px}
.review-controls>div{display:flex;justify-content:flex-end;gap:6px;margin-top:7px}
.review-controls button,.versions-section article>.promote-action{min-height:26px;padding:0 10px;border:1px solid var(--line-strong);background:transparent;font-size:8px;cursor:pointer}
.review-controls .reject-action{border-color:var(--ui-danger);color:var(--ui-danger)}
.review-controls .approve-action{border-color:var(--ui-ok);color:var(--ui-ok)}
.versions-section article>.promote-action{margin-top:9px;display:flex;align-items:center;gap:5px;border-color:var(--gold-soft);color:var(--gold)}
.version-preview-backdrop{z-index:45;background:rgba(7,8,7,.82)}
.version-preview-dialog{width:min(1180px,calc(100vw - 56px));height:min(860px,calc(100vh - 56px));display:grid;grid-template-rows:auto minmax(0,1fr) auto;border:1px solid var(--line-strong);background:var(--ui-surface);box-shadow:0 28px 90px rgba(0,0,0,.5)}
.version-preview-dialog>header{min-height:62px;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:0 18px;border-bottom:1px solid var(--ui-line)}
.version-preview-dialog>header span{color:var(--ui-accent-strong);font:7px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em}
.version-preview-dialog>header h2{margin:4px 0 0;color:var(--ui-text);font-size:16px}
.version-preview-dialog>header button{display:grid;place-items:center;padding:7px;border:0;background:transparent;color:var(--ui-text-2);cursor:pointer}
.version-preview-dialog>figure{min-height:0;margin:0;padding:14px;display:grid;place-items:center;overflow:auto;background:#111}
.version-preview-dialog>figure img{display:block;max-width:100%;max-height:100%;object-fit:contain}
.version-preview-dialog>footer{display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 10px;padding:11px 18px;border-top:1px solid var(--ui-line)}
.version-preview-dialog>footer span{color:var(--ui-accent-strong);font-size:8px}
.version-preview-dialog>footer code{overflow:hidden;color:var(--ui-text-3);font:7px ui-monospace,SFMono-Regular,Menlo,monospace;text-overflow:ellipsis;white-space:nowrap}
.version-preview-dialog>footer p{grid-column:1/-1;margin:0;color:var(--ui-text-3);font-size:8px;line-height:1.5}
.media-preview-section .media-player{display:block;width:100%;max-height:210px;margin-top:9px;background:var(--ui-surface-2)}
.media-preview-section .audio-player{height:38px;background:transparent}
.media-preview-note{margin:9px 0 0;color:var(--ui-text-3);font-size:8px;line-height:1.55;white-space:pre-wrap}
.applicability-section>p{margin:9px 0 0;color:var(--ui-text-3);font-size:8px;line-height:1.55}
.relations-section{background:var(--ui-surface)}
.relation-list{display:grid;gap:7px}
.relation-list article{padding:8px;border:1px solid var(--ui-line);background:var(--ui-surface)}
.relation-list header{display:flex;align-items:center;justify-content:space-between;gap:8px}
.relation-list header b{color:var(--ui-text-2);font-size:8px}
.relation-list header span{color:var(--ui-text-3);font-size:7px}
.relation-list p{margin:6px 0 0;display:flex;align-items:center;gap:6px}
.relation-list code{overflow:hidden;color:var(--ui-text-2);font:8px ui-monospace,SFMono-Regular,Menlo,monospace;text-overflow:ellipsis;white-space:nowrap}
.relation-list em{padding:2px 4px;border:1px solid var(--ui-ok);color:var(--ui-ok);font-size:7px;font-style:normal}
.relation-list small{display:block;margin-top:6px;color:var(--ui-text-3);font-size:8px;line-height:1.45}
.relation-empty{margin:0;color:var(--ui-text-3);font-size:8px;line-height:1.5}
.asset-relation-editor{margin-top:10px;border:1px solid var(--ui-line);background:var(--ui-surface)}
.asset-relation-editor>summary{padding:9px;color:var(--ui-accent-strong);font-size:9px;cursor:pointer}
.asset-relation-editor[open]>summary{border-bottom:1px solid var(--ui-line)}
.relation-intake{padding:9px;background:var(--ui-surface)}
.relation-intake label{display:grid;grid-template-columns:82px minmax(0,1fr);align-items:center;gap:7px;margin-top:7px}
.relation-intake label:first-child{margin-top:0}
.relation-intake label>span{color:var(--ui-text-3);font-size:8px}
.relation-intake input,.relation-intake select,.relation-intake textarea{width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:2px;outline:0;background:var(--ui-surface);color:var(--text);font:9px/1.45 inherit}
.relation-intake input,.relation-intake select{height:29px;padding:0 7px}
.relation-intake textarea{padding:6px 7px;resize:vertical}
.relation-intake input:focus,.relation-intake select:focus,.relation-intake textarea:focus{border-color:var(--ui-ok)}
.relations-section>small{display:block;margin-top:7px;color:var(--ui-danger);font-size:8px}
.create-dialog .applicability-editor{margin:14px 18px 0;padding:10px;border:1px solid var(--ui-line);background:var(--ui-surface)}
.create-dialog .applicability-editor legend{padding:0 6px;color:var(--ui-text-2);font-size:9px}
.applicability-editor>div{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.applicability-editor label{display:block}
.applicability-editor label>span{display:block;margin-bottom:5px;color:var(--ui-text-3);font-size:8px}
.applicability-editor>label{margin-top:8px}
.create-dialog select{width:100%;height:36px;box-sizing:border-box;border:1px solid var(--line);border-radius:2px;outline:0;background:var(--ui-surface);color:var(--text);font:11px inherit}
.create-dialog input:focus,.create-dialog select:focus,.create-dialog textarea:focus{border-color:var(--gold-soft)}
.relation-list .relation-status-current{color:var(--ui-ok)}
.relation-list .relation-status-stale{color:var(--ui-accent-strong)}
.relation-list .relation-status-superseded{color:var(--ui-text-3)}
.relation-rebase-action{min-height:25px;margin-top:7px;display:flex;align-items:center;gap:5px;padding:0 8px;border:1px solid var(--ui-accent);background:var(--ui-accent-soft);color:var(--ui-accent-strong);font-size:8px;cursor:pointer}
.relation-rebase-action:hover:not(:disabled){background:var(--ui-accent-soft)}
.page-navigation{height:52px;display:flex;align-items:center;justify-content:center;gap:16px;border-top:1px solid var(--line);color:var(--dim);font-size:9px}
.page-navigation button{height:28px;display:flex;align-items:center;gap:6px;padding:0 10px;border:1px solid var(--line-strong);background:transparent;color:var(--gold);font-size:9px;cursor:pointer}
.page-navigation button:disabled{color:var(--dim)}
.text-document-section pre{max-height:320px;margin:0;overflow:auto;padding:11px;border:1px solid var(--line);background:var(--ui-surface-2);color:var(--ui-text-2);font:9px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.text-document-section>p{margin:8px 0 0;color:var(--dim);font-size:8px;line-height:1.55}
.text-document-section dl{display:grid;grid-template-columns:42px minmax(0,1fr);gap:5px;margin:10px 0 0}
.text-document-section dt{color:var(--dim);font-size:8px}
.text-document-section dd{margin:0;overflow:hidden;color:var(--ui-text-2);font:8px ui-monospace,SFMono-Regular,Menlo,monospace;text-overflow:ellipsis;white-space:nowrap}
.technical-diagnostics{margin-top:9px;border:1px solid var(--line);background:var(--ui-surface);color:var(--dim)}
.technical-diagnostics>summary{padding:8px;color:var(--dim);font-size:8px;cursor:pointer}
.technical-diagnostics[open]>summary{border-bottom:1px solid var(--line)}
.technical-diagnostics>dl,.technical-diagnostics>pre,.technical-diagnostics>div,.technical-diagnostics>code,.technical-diagnostics>footer,.technical-diagnostics>small{margin:0;padding:9px;display:block;overflow-wrap:anywhere}
.technical-diagnostics>pre{max-height:260px;overflow:auto;white-space:pre-wrap}
</style>
<style scoped>
/* P26：壳头浅色/米色联动（仅壳头；子视图保持原深色体系）。 */
.material-studio[data-theme="light"] .studio-header{background:#ffffff;color:#20241f;border-bottom-color:#e2e3de}
.material-studio[data-theme="light"] .studio-header{--line:#e2e3de;--muted:#5c635c;--dim:#8a9189;--gold:#8a6a0d;--gold-soft:#7c5f0a}
.material-studio[data-theme="light"] .studio-header .project-identity p{color:#8a9189}
.material-studio[data-theme="light"] .studio-header .next-action p{color:#5c635c}
.material-studio[data-theme="light"] .studio-header .studio-mode-switch{background:#f0f0ed}
.material-studio[data-theme="light"] .studio-header .studio-mode-switch button.active,
.material-studio[data-theme="light"] .studio-header .studio-utility-switch button.active{background:rgba(163,124,16,.14);border-color:#c9b47a;color:#7c5f0a}
.material-studio[data-theme="light"] .studio-header .studio-utility-switch button{border-color:#e2e3de;color:#5c635c}
.material-studio[data-theme="light"] .studio-header .quiet-action{color:#5c635c}
.material-studio[data-theme="paper"] .studio-header{background:#fdfaf1;color:#2e2a21;border-bottom-color:#e2d9c4}
.material-studio[data-theme="paper"] .studio-header{--line:#e2d9c4;--muted:#6e6759;--dim:#98907e;--gold:#8f6a1e;--gold-soft:#7a5a14}
.material-studio[data-theme="paper"] .studio-header .project-identity p{color:#98907e}
.material-studio[data-theme="paper"] .studio-header .next-action p{color:#6e6759}
.material-studio[data-theme="paper"] .studio-header .studio-mode-switch{background:#f0e8d5}
.material-studio[data-theme="paper"] .studio-header .studio-mode-switch button.active,
.material-studio[data-theme="paper"] .studio-header .studio-utility-switch button.active{background:rgba(143,106,30,.16);border-color:#d5c9a8;color:#7a5a14}
.material-studio[data-theme="paper"] .studio-header .studio-utility-switch button{border-color:#e2d9c4;color:#6e6759}
.material-studio[data-theme="paper"] .studio-header .quiet-action{color:#6e6759}
</style>
