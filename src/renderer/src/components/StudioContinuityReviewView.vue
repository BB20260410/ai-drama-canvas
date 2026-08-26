<template>
  <section class="continuity-review" data-testid="studio-continuity-review-view" :aria-busy="loadState.loading">
    <header class="control-header">
      <div>
        <span>连续性与审片</span>
        <h2>一致性检查与画面验收</h2>
        <p>系统自动汇总每格的人物、场景、道具、风格状态和每六图停检；这里只显示当前结果与唯一下一步。</p>
      </div>
      <div v-if="loadState.control" class="next-action" :class="loadState.control.nextAction.requiresWrite ? 'pending' : 'ready'" data-testid="continuity-next-action">
        <span>唯一下一动作</span>
        <strong>{{ loadState.control.nextAction.label }}</strong>
        <p>{{ nextActionReasonText(loadState.control.nextAction.reason) }}</p>
        <details class="technical-diagnostics next-action-diagnostics">
          <summary data-testid="studio-continuity-next-action-diagnostics">诊断详情</summary>
          <code v-if="loadState.control.nextAction.command">{{ loadState.control.nextAction.command }}</code>
          <code v-if="nextActionHasTechnicalReason(loadState.control.nextAction.reason)">{{ loadState.control.nextAction.reason }}</code>
        </details>
      </div>
    </header>

    <div v-if="focus" class="focused-scope" data-testid="continuity-focused-scope">
      <div>
        <span>当前审片</span>
        <strong>{{ focus.generationTarget?.targetKind === "unit-grid" ? "整板生成结果" : "当前宫格结果" }}</strong>
        <small>{{ focus.startMilliseconds / 1000 }}–{{ focus.endMilliseconds / 1000 }}s 连续性辅助范围 · {{ focus.assetIds.length }} 项锁定资产</small>
      </div>
      <button type="button" :disabled="loadState.loading" @click="applyFocus">重新读取</button>
    </div>
    <div v-else class="review-entry-empty" data-testid="continuity-business-empty">
      <ShieldCheck :size="30" aria-hidden="true" />
      <h3>请从宫格或结果节点打开审片</h3>
      <p>画布会自动带入当前单元、宫格、锁定资产与原始图/标注图结果，无需填写技术编号。</p>
      <button type="button" class="empty-goto-canvas" @click="$emit('requestCanvas')">去画布选择宫格</button>
      <details class="diagnostic-details">
        <summary data-testid="studio-continuity-empty-diagnostics">诊断详情</summary>
        <form class="scope-form diagnostic-query" data-testid="continuity-query-form" @submit.prevent="loadControl(true)">
          <label><span>15 秒单元 ID</span><input v-model.trim="draft.unitId" required autocomplete="off" placeholder="unit-ep01-001" /></label>
          <label><span>单元 revision</span><input v-model="draft.unitRevision" required inputmode="numeric" /></label>
          <label><span>宫格 ID</span><input v-model.trim="draft.panelId" required autocomplete="off" placeholder="panel-01" /></label>
          <label><span>起始毫秒</span><input v-model="draft.startMilliseconds" required inputmode="numeric" /></label>
          <label><span>结束毫秒</span><input v-model="draft.endMilliseconds" required inputmode="numeric" /></label>
          <label class="wide"><span>资产 ID（最多 6 项）</span><input v-model="draft.assetIds" autocomplete="off" placeholder="character-ahang, scene-stone-room" /></label>
          <label class="wide"><span>generation run ID（有结果图时填写）</span><input v-model.trim="draft.generationRunId" autocomplete="off" placeholder="留空则只查连续性与 checkpoint" /></label>
          <button type="submit" :disabled="loadState.loading">
            <LoaderCircle v-if="loadState.loading" :size="14" class="spinning" aria-hidden="true" />
            <Search v-else :size="14" aria-hidden="true" />
            {{ loadState.loading ? "读取中" : "读取控制面" }}
          </button>
        </form>
      </details>
    </div>

    <p v-if="loadState.error" class="error-banner" role="alert">{{ loadState.error }}</p>
    <div v-if="focus && !loadState.control && !loadState.loading" class="empty-control">
      <ShieldCheck :size="30" aria-hidden="true" />
      <h3>当前宫格尚无可审结果</h3>
      <p>界面不会扫描旧工程或读取全量 Review 历史；请先在生成队列完成当前宫格。</p>
    </div>

    <div
      v-if="consistencyBanner"
      class="consistency-banner"
      data-testid="consistency-banner"
      :class="consistencyStateClass(consistencyBanner.state)">
      <strong>{{ consistencyBanner.headline }}</strong>
      <p v-if="consistencyBanner.detail">{{ consistencyBanner.detail }}</p>
      <p v-if="consistencyBanner.staleCount">有 {{ consistencyBanner.staleCount }} 项资产的权威版本已更新，结论按冻结时版本给出（陈旧）。</p>
      <ul v-if="consistencyBanner.assets.length">
        <li v-for="asset in consistencyBanner.assets" :key="asset.assetId">
          <b>{{ asset.assetName }}</b>
          <span :class="consistencyStateClass(asset.verdict)">{{ asset.verdictLabel }}</span>
          <em v-if="asset.stale">陈旧</em>
          <small v-for="note in asset.checklist" :key="note">人工核对：{{ note }}</small>
        </li>
      </ul>
    </div>

    <template v-if="loadState.control">
      <section class="summary-strip" aria-label="控制面摘要">
        <div><strong>{{ loadState.control.assets.filter((asset) => asset.ready).length }}/{{ loadState.control.assets.length }}</strong><span>资产就绪</span></div>
        <div><strong>{{ loadState.control.conflicts.total }}</strong><span>开放冲突</span></div>
        <div><strong>{{ reviewStatusLabel(loadState.control.review?.control.status) }}</strong><span>Review</span></div>
        <div :title="loadState.control.generation.status === 'blocked' ? loadState.control.generation.message : '生成输入已就绪'"><strong>{{ loadState.control.generation.status === 'ready' ? '就绪' : '阻断' }}</strong><span>生成输入</span></div>
        <div><strong>{{ loadState.control.checkpoint.completedSlotCount }}</strong><span>已完成生产槽</span></div>
        <div><strong>{{ loadState.control.checkpoint.collectingSlotCount }}/6</strong><span>当前停检批</span></div>
      </section>

      <section v-if="continuityHandoff" class="control-section handoff-section" data-testid="continuity-next-shot-handoff">
        <header>
          <div><span>下一镜交接</span><h3>末格可复用状态</h3></div>
          <small>{{ continuityHandoff.usableCount }}/{{ continuityHandoff.rows.length }} 项可直接引用</small>
        </header>
        <p class="handoff-note" :class="continuityHandoff.usableCount === continuityHandoff.rows.length ? 'ready' : 'blocked'">
          {{ continuityHandoff.usableCount === continuityHandoff.rows.length
            ? '以下状态来自当前冻结末格，可作为下一镜起态。'
            : '含内部定位或未解析字段：这些字段不能直接写入下一镜提示词，须先人工补全。' }}
        </p>
        <div v-if="continuityHandoff.rows.length" class="handoff-grid">
          <div v-for="row in continuityHandoff.rows" :key="`${row.assetId}:${row.field}`" :class="row.usable ? 'usable' : 'blocked'">
            <span>{{ row.assetName }} · {{ fieldLabel(row.field) }}</span>
            <b>{{ row.value }}</b>
          </div>
        </div>
        <div v-else class="inline-empty">当前末格没有可供交接的站位、朝向、持物、布局或光线字段。</div>
      </section>

      <section
        v-if="frozenPreviousStandingLine"
        class="control-section previous-standing-section"
        data-testid="studio-review-previous-standing">
        <header>
          <div><span>前镜交接</span><h3>冻结提示词约束</h3></div>
          <small>不是 BindingSet</small>
        </header>
        <p class="handoff-note ready">{{ frozenPreviousStandingLine }} 历史身份经冻结包还原，不读 head。</p>
      </section>
      <section
        v-if="frozenLightingLine || frozenCostumeLine"
        class="control-section previous-standing-section"
        data-testid="studio-review-lighting-costume">
        <header>
          <div><span>光线 / 服装</span><h3>冻结宫格覆盖</h3></div>
          <small>不是 BindingSet</small>
        </header>
        <p v-if="frozenLightingLine" class="handoff-note ready" data-testid="studio-review-lighting">{{ frozenLightingLine }} 历史身份经冻结包还原，不读 head。</p>
        <p v-if="frozenCostumeLine" class="handoff-note ready" data-testid="studio-review-costume">{{ frozenCostumeLine }} 历史身份经冻结包还原，不读 head。</p>
      </section>
      <section
        v-if="frozenShotTypeLine"
        class="control-section previous-standing-section"
        data-testid="studio-review-shot-type">
        <header>
          <div><span>镜头类型</span><h3>冻结提示词约束</h3></div>
          <small>不是 BindingSet</small>
        </header>
        <p class="handoff-note ready">{{ frozenShotTypeLine }} 历史身份经冻结包还原，不读 head。</p>
      </section>
      <section
        v-if="frozenBeatLine"
        class="control-section previous-standing-section"
        data-testid="studio-review-beat">
        <header>
          <div><span>15s 节拍</span><h3>冻结宫格起止秒</h3></div>
          <small>不是 BindingSet</small>
        </header>
        <p class="handoff-note ready">{{ frozenBeatLine }} 历史身份经冻结包还原，不读 head。</p>
      </section>

      <section
        v-if="continuityCorrectionRows.length && canAppendContinuityCorrection"
        class="control-section opaque-correction-section"
        data-testid="continuity-opaque-correction">
        <header>
          <div><span>连续性校正</span><h3>补齐可执行的真实画面状态</h3></div>
          <small>{{ continuityCorrectionRows.length }} 项待补全</small>
        </header>
        <p class="opaque-correction-note">仅填写当前原图中可见、可复述的事实；若字段对该对象确实不适用，选择“不适用”并说明原因。不得填资产 ID、文件路径、面板编号或内部定位。每次提交会追加校正记录，不会覆盖历史。</p>
        <p v-if="continuityCorrectionError" class="error-banner opaque-correction-error" role="alert">{{ continuityCorrectionError }}</p>
        <div class="opaque-correction-list">
          <article v-for="row in continuityCorrectionRows" :key="row.key">
            <header>
              <b>{{ row.assetName }} · {{ fieldLabel(row.field) }}</b>
              <small>当前：内部定位，不能用于下一镜</small>
            </header>
            <label>
              <span>校正类型</span>
              <select v-model="continuityCorrectionModes[row.key]" :disabled="Boolean(continuityCorrectionSavingKey)">
                <option value="resolved">真实可见状态</option>
                <option value="not-applicable">该字段不适用</option>
              </select>
            </label>
            <label>
              <span>{{ continuityCorrectionModes[row.key] === "not-applicable" ? "不适用原因" : "真实可见状态" }}</span>
              <textarea
                v-model="continuityCorrectionDrafts[row.key]"
                rows="2"
                :placeholder="continuityCorrectionModes[row.key] === 'not-applicable' ? row.notApplicablePlaceholder : row.placeholder"
                :disabled="Boolean(continuityCorrectionSavingKey)" />
            </label>
            <button
              type="button"
              :disabled="Boolean(continuityCorrectionSavingKey) || !continuityCorrectionDrafts[row.key]?.trim()"
              @click="appendOpaqueCorrection(row)">
              {{ continuityCorrectionSavingKey === row.key ? "追加中…" : "追加人工校正" }}
            </button>
          </article>
        </div>
      </section>

      <section class="control-section asset-section" data-testid="continuity-assets">
        <header><div><span>一致性检查</span><h3>人物、场景与道具状态</h3></div><small>{{ loadState.control.scope.startMilliseconds / 1000 }}–{{ loadState.control.scope.endMilliseconds / 1000 }}s</small></header>
        <div v-if="!loadState.control.assets.length" class="inline-empty">当前宫格没有传入必需资产；空镜仍由 BindingSet 与生成门禁单独确认。</div>
        <article v-for="(asset, assetIndex) in loadState.control.assets" :key="asset.assetId" class="asset-control" :class="asset.ready ? 'ready' : 'blocked'">
          <header>
            <div><b>{{ categoryLabel(asset.category) }} {{ assetIndex + 1 }} · {{ asset.assetName }}</b><strong>{{ assetDisplayReady(asset) ? "就绪" : assetHasOpaqueState(asset) ? "需补全" : "阻断" }}</strong></div>
            <span>{{ assetResolvedVisualFieldCount(asset) }}/9</span>
          </header>
          <details class="technical-diagnostics"><summary data-testid="studio-continuity-asset-diagnostics">诊断详情</summary><code>{{ asset.assetId }}</code></details>
          <div class="field-grid">
            <div v-for="field in asset.fields" :key="field.field" :class="[`field-${field.status}`, { 'field-opaque': assetFieldHasOpaqueState(asset, field.field) }]">
              <span>{{ fieldLabel(field.field) }}</span>
              <b>{{ assetFieldHasOpaqueState(asset, field.field) ? "需补全" : fieldStatusLabel(field.status) }}</b>
              <small>{{ field.spanCount }} 段</small>
            </div>
          </div>
          <ul v-if="asset.blockers.length" class="blocker-list">
            <li v-for="blocker in asset.blockers.slice(0, 9)" :key="`${blocker.field}:${blocker.code}:${blocker.startMilliseconds ?? ''}`">
              <b>{{ fieldLabel(blocker.field) }}</b>{{ blocker.message }}
            </li>
          </ul>
          <div class="timeline-list">
            <div v-for="item in asset.timeline.items" :key="item.entryId">
              <span>{{ item.startMilliseconds / 1000 }}–{{ item.endMilliseconds / 1000 }}s</span>
              <b>{{ fieldLabel(item.field) }}</b>
              <p>{{ stateText(item.state) }}</p>
              <em v-if="item.openConflictIds.length">{{ item.openConflictIds.length }} 冲突</em>
            </div>
            <small v-if="asset.timeline.total > asset.timeline.items.length">仅显示 {{ asset.timeline.offset + 1 }}–{{ asset.timeline.offset + asset.timeline.items.length }} / {{ asset.timeline.total }} 段</small>
          </div>
        </article>
        <footer v-if="timelinePageTotal > 0" class="page-actions">
          <button type="button" :disabled="timelineOffset === 0 || loadState.loading" @click="previousTimeline">上一页</button>
          <span>共 {{ timelinePageTotal }} 段</span>
          <button type="button" :disabled="timelineNextOffset === undefined || loadState.loading" @click="nextTimeline">下一页</button>
        </footer>
      </section>

      <section class="control-section conflict-section" data-testid="continuity-conflicts">
        <header><div><span>冲突检查</span><h3>未解决冲突</h3></div><small>{{ loadState.control.conflicts.total }} 项</small></header>
        <div v-if="!loadState.control.conflicts.items.length" class="inline-empty">当前查询跨度没有开放冲突。</div>
        <article v-for="(conflict, conflictIndex) in loadState.control.conflicts.items" :key="conflict.conflictId">
          <div><b>冲突 {{ conflictIndex + 1 }}</b><span>{{ fieldLabel(conflict.field) }}</span></div>
          <p>{{ conflict.overlapStartMilliseconds / 1000 }}–{{ conflict.overlapEndMilliseconds / 1000 }}s</p>
          <details class="technical-diagnostics"><summary data-testid="studio-continuity-conflict-diagnostics">诊断详情</summary><code>{{ conflict.subjectId }} · {{ conflict.conflictId }} · r{{ conflict.revision }}</code></details>
        </article>
      </section>

      <section class="control-section review-section" data-testid="generation-review-control">
        <header><div><span>画面审片</span><h3>画面验收写回</h3></div><small>{{ reviewStatusLabel(loadState.control.review?.control.status) }}</small></header>
        <!-- 只读证据不能进入 Studio Review 写回；但它仍是填写真实连续性状态所需的画面事实。 -->
        <div
          v-if="reviewMediaAvailable && !reviewPairAvailable"
          class="continuity-reference-workbench"
          data-testid="continuity-reference-workbench"
          :aria-busy="reviewMedia.status === 'loading'">
          <p class="continuity-reference-note">{{ readOnlyEvidenceNote }}</p>
          <div class="review-comparison">
            <figure v-for="source in (['raw', 'labeled'] as const)" :key="`continuity-reference-${source}`">
              <figcaption><span>{{ source === 'raw' ? '原始宫格图（只读）' : '中文标注图（只读）' }}</span><button type="button" :disabled="!originalUrlOf(source)" @click="openOriginalPreview(source)">原尺寸查看</button></figcaption>
              <div class="annotation-stage">
                <img
                  v-if="imageUrlOf(source)"
                  :key="`${reviewMedia.requestSequence}:continuity-reference:${source}`"
                  :src="imageUrlOf(source)"
                  :data-review-request="reviewMedia.requestSequence"
                  :alt="source === 'raw' ? '只读原始宫格图' : '只读中文标注图'"
                  decoding="async"
                  @load="onReviewImageLoad(source, $event)"
                  @error="onReviewImageError(source, $event)" />
                <div v-else class="media-placeholder">{{ reviewMedia.status === 'error' ? `${source.toUpperCase()} 加载失败` : `正在读取 ${source.toUpperCase()}…` }}</div>
              </div>
            </figure>
          </div>
          <p v-if="reviewMedia.status === 'loading'" class="media-state" role="status">正在加载审片缩略图；两张图都成功后才能填写状态。需要看原图请点原尺寸查看。</p>
          <p v-else-if="reviewMedia.error" class="media-state error" role="alert">{{ reviewMedia.error }}</p>
          <p v-else-if="reviewMedia.rawDecoded && reviewMedia.labeledDecoded" class="media-state ready" role="status">审片缩略图已加载；请只填写画面中真实可见的语义状态。原图仅在点原尺寸查看后打开。</p>
          <p v-else-if="reviewMediaAvailable" class="media-state" role="status">当前没有完整审片缩略图。并排不加载原图；请点原尺寸查看后再填写状态。</p>
        </div>
        <div v-if="!loadState.control.review && !reviewMediaAvailable" class="inline-empty">当前宫格尚无可读取的审片结果或历史。</div>
        <template v-if="loadState.control.review">
          <div v-if="reviewPairAvailable" class="review-workbench" data-testid="studio-review-workbench" :aria-busy="reviewMedia.status === 'loading'">
            <!-- 解码生命周期独立于当前对比模式；切换 A/B、擦除或差分不会卸载唯一 load/error 监听器。 -->
            <div class="review-decode-loaders" aria-hidden="true">
              <img
                v-if="rawImageUrl"
                :key="`${reviewMedia.requestSequence}:loader:raw`"
                :src="rawImageUrl"
                :data-review-request="reviewMedia.requestSequence"
                alt=""
                decoding="async"
                @load="onReviewImageLoad('raw', $event)"
                @error="onReviewImageError('raw', $event)" />
              <img
                v-if="labeledImageUrl"
                :key="`${reviewMedia.requestSequence}:loader:labeled`"
                :src="labeledImageUrl"
                :data-review-request="reviewMedia.requestSequence"
                alt=""
                decoding="async"
                @load="onReviewImageLoad('labeled', $event)"
                @error="onReviewImageError('labeled', $event)" />
            </div>
            <div class="compare-modes" data-testid="review-compare-modes" role="tablist" aria-label="对比模式">
              <button v-for="mode in compareModeOptions" :key="mode.value" type="button" role="tab" :aria-selected="compareMode === mode.value" :class="{ active: compareMode === mode.value }" @click="compareMode = mode.value">{{ mode.label }}</button>
            </div>

            <div v-if="compareMode === 'off'" class="review-comparison">
              <figure v-for="source in (['raw', 'labeled'] as const)" :key="source">
                <figcaption><span>{{ source === 'raw' ? '原始图' : '标注图' }}</span><button type="button" :disabled="!originalUrlOf(source)" @click="openOriginalPreview(source)">原尺寸查看</button></figcaption>
                <div
                  class="annotation-stage"
                  :data-stage="source"
                  @pointerdown="onStagePointerDown(source, $event)">
                  <img
                    v-if="imageUrlOf(source)"
                    :key="`${reviewMedia.requestSequence}:${source}`"
                    :src="imageUrlOf(source)"
                    :alt="source === 'raw' ? '原始生成图' : '中文标注图'"
                    decoding="async" />
                  <div v-else class="media-placeholder">{{ reviewMedia.status === 'error' ? `${source.toUpperCase()} 加载失败` : `正在读取 ${source.toUpperCase()}…` }}</div>
                  <svg
                    v-if="decodedOf(source)"
                    class="annotation-overlay"
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                    aria-hidden="true">
                    <template v-for="ann in overlayAnnotations(source)" :key="ann.key">
                      <rect
                        v-if="ann.kind !== 'point'"
                        :x="ann.x * 100" :y="ann.y * 100"
                        :width="ann.width * 100" :height="ann.height * 100"
                        :class="['ann-rect', ann.tone]" />
                      <circle
                        v-else
                        :cx="ann.x * 100" :cy="ann.y * 100" r="1.2"
                        :class="['ann-point', ann.tone]" />
                    </template>
                    <rect
                      v-if="dragState.active && dragState.source === source"
                      :x="Math.min(dragState.startX, dragState.currentX) * 100"
                      :y="Math.min(dragState.startY, dragState.currentY) * 100"
                      :width="Math.abs(dragState.currentX - dragState.startX) * 100"
                      :height="Math.abs(dragState.currentY - dragState.startY) * 100"
                      class="ann-rect draft-preview" />
                  </svg>
                </div>
              </figure>
            </div>

            <div v-else-if="compareMode === 'ab'" class="review-single">
              <div class="ab-switch">
                <button type="button" :class="{ active: abSource === 'raw' }" @click="abSource = 'raw'">原始图</button>
                <button type="button" :class="{ active: abSource === 'labeled' }" @click="abSource = 'labeled'">标注图</button>
                <button type="button" @click="abSource = abSource === 'raw' ? 'labeled' : 'raw'">交换</button>
              </div>
              <div class="annotation-stage" :data-stage="abSource" @pointerdown="onStagePointerDown(abSource, $event)">
                <img
                  v-if="imageUrlOf(abSource)"
                  :key="`${reviewMedia.requestSequence}:ab:${abSource}`"
                  :src="imageUrlOf(abSource)"
                  :alt="abSource === 'raw' ? '原始生成图' : '中文标注图'"
                  decoding="async" />
                <svg v-if="decodedOf(abSource)" class="annotation-overlay" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                  <template v-for="ann in overlayAnnotations(abSource)" :key="ann.key">
                    <rect v-if="ann.kind !== 'point'" :x="ann.x * 100" :y="ann.y * 100" :width="ann.width * 100" :height="ann.height * 100" :class="['ann-rect', ann.tone]" />
                    <circle v-else :cx="ann.x * 100" :cy="ann.y * 100" r="1.2" :class="['ann-point', ann.tone]" />
                  </template>
                  <rect
                    v-if="dragState.active && dragState.source === abSource"
                    :x="Math.min(dragState.startX, dragState.currentX) * 100"
                    :y="Math.min(dragState.startY, dragState.currentY) * 100"
                    :width="Math.abs(dragState.currentX - dragState.startX) * 100"
                    :height="Math.abs(dragState.currentY - dragState.startY) * 100"
                    class="ann-rect draft-preview" />
                </svg>
              </div>
            </div>

            <div v-else-if="compareMode === 'wipe'" class="review-single">
              <div class="wipe-stage" @pointerdown="onWipePointerDown">
                <img v-if="rawImageUrl" :src="rawImageUrl" alt="raw 原始生成图" decoding="async" class="wipe-base" />
                <img v-if="labeledImageUrl" :src="labeledImageUrl" alt="中文标注图" decoding="async" class="wipe-top" :style="{ clipPath: `inset(0 ${100 - wipePercent}% 0 0)` }" />
                <div
                  class="wipe-divider"
                  :style="{ left: `${wipePercent}%` }"
                  role="separator"
                  tabindex="0"
                  :aria-valuenow="Math.round(wipePercent)"
                  aria-valuemin="0"
                  aria-valuemax="100"
                  aria-label="擦除分割线"
                  @keydown="onWipeDividerKeydown"><span>{{ wipePercent.toFixed(0) }}%</span></div>
              </div>
            </div>

            <div v-else class="review-single">
              <div v-if="differenceState.status === 'error'" class="media-placeholder" role="alert">{{ differenceState.error }}</div>
              <div v-else-if="differenceState.status !== 'ready'" class="media-placeholder">正在生成差分预检…</div>
              <canvas v-show="differenceState.status === 'ready'" ref="differenceCanvas" class="difference-canvas" aria-label="原始图与标注图的差分"></canvas>
            </div>

            <p v-if="reviewMedia.status === 'loading'" class="media-state" role="status">正在加载审片缩略图；两张图片都成功前不能提交审片。需要看原图请点原尺寸查看。</p>
            <p v-else-if="reviewMedia.error" class="media-state error" role="alert">{{ reviewMedia.error }}</p>
            <p v-else-if="reviewPairReady" class="media-state ready" role="status">审片缩略图已加载并可圈选提交。原图仅在点原尺寸查看后打开。</p>
            <p v-else-if="reviewPairAvailable" class="media-state" role="status">当前没有完整审片缩略图。并排不加载原图；请点原尺寸查看后再圈选提交。</p>

            <div class="annotation-tools" data-testid="review-annotation-tools">
              <div class="tool-row">
                <span>批注工具</span>
                <button type="button" :class="{ active: annotationTool === 'rect' }" @click="annotationTool = annotationTool === 'rect' ? null : 'rect'">矩形圈选</button>
                <button type="button" :class="{ active: annotationTool === 'point' }" @click="annotationTool = annotationTool === 'point' ? null : 'point'">点位标记</button>
                <small v-if="annotationTool">在图上{{ annotationTool === 'rect' ? '按住拖出矩形' : '单击放置点位' }}；再次点击工具取消。</small>
                <small v-else>选择工具后在图上圈选问题区域（坐标按图像归一化保存，显示尺寸变化不漂）。</small>
              </div>
              <article v-for="(draft, index) in draftAnnotations" :key="index" class="draft-annotation">
                <select v-model="draft.category" aria-label="问题分类">
                  <option value="" disabled>选择分类</option>
                  <option v-for="(label, value) in categoryLabels" :key="value" :value="value">{{ label }}</option>
                </select>
                <input v-model.trim="draft.note" type="text" maxlength="4000" placeholder="该区域的批注（必填）" />
                <button type="button" aria-label="删除该草稿批注" @click="draftAnnotations.splice(index, 1)">删除</button>
              </article>
            </div>

            <label class="review-note"><span>画面批注（与圈选一起写回；分类摘要将自动前缀）</span><textarea v-model="reviewNote" rows="3" placeholder="例：阿航脸型与权威图不一致，左侧挑染丢失。"></textarea></label>
            <p v-if="incompleteDraftCount > 0" class="draft-incomplete-hint" role="alert">还有 {{ incompleteDraftCount }} 条圈选未选择分类或未填写批注；补全后才能提交（不会静默丢弃）。</p>
            <div class="review-actions">
              <button type="button" class="rework" data-testid="continuity-review-rework" :disabled="reviewSubmitting || !reviewPairReady || !reviewNote.trim() || incompleteDraftCount > 0" :title="reviewSubmitting ? '正在处理，不能再返工' : undefined" @click="submitVisualReview('rework')">{{ reviewSubmitting ? "提交中" : "返工" }}</button>
              <button type="button" class="reject" data-testid="continuity-review-reject" :disabled="reviewSubmitting || !reviewPairReady || !reviewNote.trim() || incompleteDraftCount > 0" :title="reviewSubmitting ? '正在处理，不能再拒绝' : undefined" @click="submitVisualReview('reject')">{{ reviewSubmitting ? "提交中" : "拒绝" }}</button>
              <button type="button" class="pass" data-testid="continuity-review-pass" :disabled="reviewSubmitting || !reviewPairReady || !reviewNote.trim() || incompleteDraftCount > 0" :title="reviewSubmitting ? '正在处理，不能再通过' : undefined" @click="submitVisualReview('pass')">{{ reviewSubmitting ? "提交中" : "通过" }}</button>
            </div>
            <p v-if="reworkGuidance" class="rework-guidance" role="status" data-testid="review-rework-guidance">{{ reworkGuidance }}</p>
          </div>
          <div v-else class="inline-empty" role="alert">当前 Review 缺少可核验的 raw/labeled 成对身份，已禁止提交。</div>
          <div class="review-head" :class="loadState.control.review.control.status">
            <strong>{{ reviewStatusLabel(loadState.control.review.control.status) }}</strong>
            <p v-if="loadState.control.review.control.blockers.length">{{ loadState.control.review.control.blockers.join("；") }}</p>
            <p v-else>当前 Review 与 raw/labeled、冻结包及连续性指纹一致。</p>
            <details class="technical-diagnostics"><summary data-testid="studio-continuity-review-head-diagnostics">诊断详情</summary><code>Head revision {{ loadState.control.review.control.headRevision }}</code></details>
          </div>
          <div class="history-list">
            <article v-for="review in loadState.control.review.history.items" :key="review.reviewId">
              <span>#{{ review.sequence }} · {{ review.kind }}</span>
              <b>{{ review.decision }}</b>
              <em :class="review.current ? 'current' : 'stale'">{{ review.current ? "当前有效" : "历史记录" }}</em>
              <p>{{ review.note }}</p>
              <div v-if="review.annotations?.length" class="history-annotations" :class="{ stale: !review.current || review.currentStaleReasons.length }">
                <span v-for="ann in review.annotations" :key="ann.id ?? `${ann.x}-${ann.y}`" class="history-annotation-chip" :title="ann.note">
                  {{ ann.category ? categoryLabels[ann.category] : (ann.kind === 'point' ? '点位' : '矩形') }}<template v-if="ann.id"> · {{ ann.id.slice(0, 10) }}</template>
                  <button
                    v-if="review.current && ann.id && review.reviewId === loadState.control?.review?.control?.head?.reviewId"
                    type="button"
                    :disabled="reviewSubmitting"
                    :title="reviewSubmitting ? '正在处理，不能再移除批注' : undefined"
                    :aria-label="`移除批注 ${ann.id}`"
                    @click="removeHeadAnnotation(review, ann.id!)">移除</button>
                </span>
              </div>
              <small v-if="review.currentStaleReasons.length">已漂移：{{ review.currentStaleReasons.join("；") }}</small>
              <details class="technical-diagnostics review-identity" :data-testid="`studio-review-identity-${review.reviewId}`">
                <summary data-testid="studio-review-identity-summary">提交时身份（生成时版本）</summary>
                <p>pack <code>{{ review.packId }}</code> · 包指纹 {{ review.packFingerprint.slice(0, 12) }}…</p>
                <p>raw {{ review.rawSha256.slice(0, 12) }}… · labeled {{ review.labeledSha256.slice(0, 12) }}…</p>
              </details>
            </article>
          </div>
          <button v-if="loadState.control.review.history.nextCursor" type="button" class="page-more" :disabled="loadState.loading" @click="nextReviewHistory">加载下一页 Review 历史</button>
        </template>
      </section>

      <section class="control-section checkpoint-section" data-testid="generation-checkpoint-control">
        <header>
          <div><span>六图停检</span><h3>每六图一致性停检</h3></div>
          <small :class="loadState.control.checkpoint.newSlotDispatchAllowed ? 'ready-text' : 'blocked-text'">
            {{ loadState.control.checkpoint.newSlotDispatchAllowed ? "允许新增生产槽" : "阻断新增生产槽" }}
          </small>
        </header>
        <div class="checkpoint-summary">
          <span>完整批次 {{ loadState.control.checkpoint.fullBatchCount }}</span>
          <span>当前收集 {{ loadState.control.checkpoint.collectingSlotCount }}/6</span>
          <span v-if="loadState.control.checkpoint.blockingBatchNumber">阻断批次 #{{ loadState.control.checkpoint.blockingBatchNumber }}</span>
        </div>
        <article v-if="loadState.control.checkpoint.blockingBatch" class="blocking-batch">
          <strong>当前阻断：第 {{ loadState.control.checkpoint.blockingBatch.batchNumber }} 批</strong>
          <span>{{ checkpointStatusLabel(loadState.control.checkpoint.blockingBatch.status) }}</span>
          <p>{{ loadState.control.checkpoint.blockingBatch.blockers.join("；") || "等待当前步骤完成。" }}</p>
        </article>
        <div class="batch-grid">
          <article v-for="batch in loadState.control.checkpoint.batches.items" :key="batch.batchNumber">
            <header><b>批次 {{ batch.batchNumber }}</b><span>{{ checkpointStatusLabel(batch.status) }}</span></header>
            <p>{{ batch.slotCount }}/6 个生产槽</p>
            <small v-if="batch.blockers.length">{{ batch.blockers.join("；") }}</small>
            <details class="technical-diagnostics"><summary data-testid="studio-continuity-batch-diagnostics">诊断详情</summary><code>checkpoint r{{ batch.checkpointHeadRevision }} · attestation r{{ batch.attestationHeadRevision }}</code></details>
          </article>
        </div>
        <footer v-if="loadState.control.checkpoint.batches.total > 0" class="page-actions">
          <button type="button" :disabled="checkpointOffset === 0 || loadState.loading" @click="previousCheckpoint">上一页</button>
          <span>批次 {{ checkpointOffset + 1 }}–{{ checkpointOffset + loadState.control.checkpoint.batches.items.length }} / {{ loadState.control.checkpoint.batches.total }}</span>
          <button type="button" :disabled="loadState.control.checkpoint.batches.nextOffset === undefined || loadState.loading" @click="nextCheckpoint">下一页</button>
        </footer>
      </section>

      <footer class="read-only-note">
        <ShieldCheck :size="15" aria-hidden="true" />
        <span>通过或返工会经安全写入通道追加保存，不直接修改底层工程数据。</span>
      </footer>
    </template>

    <div v-if="originalPreview" class="original-preview" role="dialog" aria-modal="true" aria-label="原尺寸图片查看">
      <header><strong>{{ originalPreview === 'raw' ? '原始图' : '标注图' }} · 原尺寸</strong><button type="button" @click="originalPreview = null">关闭</button></header>
      <div>
        <img
          v-if="originalUrlOf(originalPreview)"
          :src="originalUrlOf(originalPreview)"
          :data-review-request="reviewMedia.requestSequence"
          :alt="originalPreview === 'raw' ? '原始图原尺寸' : '标注图原尺寸'"
          decoding="async"
          @load="onOriginalPreviewLoad(originalPreview, $event)"
          @error="onOriginalPreviewError(originalPreview, $event)" />
      </div>
    </div>
  </section>
</template>

<script lang="ts">
import { computed, defineComponent, onBeforeUnmount, reactive, ref, watch, type PropType } from "vue";
import { LoaderCircle, Search, ShieldCheck } from "lucide-vue-next";
import type { StudioContinuityField, StudioContinuityFieldState } from "@core/studio-continuity";
import type { StudioContinuityReviewAssetControl, StudioContinuityReviewFieldStatus } from "@core/studio-continuity-review-control";
import type { StudioGenerationReviewProjection } from "@core/studio-generation-review";
import {
  formatFrozenPanelBeatReadonlyLine,
  formatFrozenPanelCostumeReadonlyLine,
  formatFrozenPanelLightingReadonlyLine,
  formatFrozenPanelShotTypeReadonlyLine,
  formatPreviousStandingReadonlyLine,
  frozenPanelBeatFromAnyFrozenPack,
  frozenPanelCostumeFromAnyFrozenPack,
  frozenPanelLightingFromAnyFrozenPack,
  frozenPanelShotTypeFromAnyFrozenPack,
  previousStandingFromAnyFrozenPack,
  type StudioPanelStandingHandoff,
} from "@core/studio-panel-standing";
import {
  assignUniqueAnnotationIds,
  annotationCategorySummary,
  buildReviewCriteria,
  composeAbsDifference,
  wipeDividerPercent,
  STUDIO_REVIEW_ANNOTATION_CATEGORY_LABELS,
  type AnnotationDraftGeometry,
  type StudioReviewAnnotationCategory,
} from "../studio-review-compare";
import { reviewMediaDisplayUrls } from "../studio-list-preview-url";
import {
  STUDIO_CONTINUITY_REVIEW_UI_CHECKPOINT_LIMIT,
  STUDIO_CONTINUITY_REVIEW_UI_TIMELINE_LIMIT,
  beginStudioContinuityReviewLoad,
  buildStudioContinuityReviewQuery,
  commitStudioContinuityReviewLoad,
  createStudioContinuityReviewLoadState,
  failStudioContinuityReviewLoad,
  invalidateStudioContinuityReviewLoad,
  type StudioContinuityReviewQueryDraft,
  type StudioContinuityReviewFocus,
  type StudioContinuityReviewUiApi,
} from "../studio-continuity-review-store";

const FIELD_LABELS: Record<StudioContinuityField, string> = {
  costume: "服装",
  injury: "伤势",
  heldObject: "持物",
  position: "位置",
  facing: "朝向",
  emotion: "情绪",
  layout: "布局",
  lighting: "光线",
  referenceSha256: "参考图",
};

export default defineComponent({
  name: "StudioContinuityReviewView",
  components: { LoaderCircle, Search, ShieldCheck },
  props: {
    projectRoot: { type: String, required: true },
    api: { type: Object as PropType<StudioContinuityReviewUiApi>, required: true },
    focus: { type: Object as PropType<StudioContinuityReviewFocus | null>, default: null },
  },
  emits: { failed: (_message: string) => true, reviewChanged: (_message: string) => true, requestCanvas: () => true },
  setup(props, { emit }) {
    const draft = reactive<StudioContinuityReviewQueryDraft>({
      unitId: "",
      unitRevision: "1",
      panelId: "",
      startMilliseconds: "0",
      endMilliseconds: "15000",
      assetIds: "",
      generationRunId: "",
    });
    const loadState = reactive(createStudioContinuityReviewLoadState());
    const rawImageUrl = ref("");
    const labeledImageUrl = ref("");
    const rawOriginalUrl = ref("");
    const labeledOriginalUrl = ref("");
    const originalPreview = ref<"raw" | "labeled" | null>(null);
    const reviewMedia = reactive({
      requestSequence: 0,
      projectRoot: "",
      generationRunId: "",
      focusToken: 0,
      status: "idle" as "idle" | "loading" | "ready" | "error",
      rawDecoded: false,
      labeledDecoded: false,
      error: "",
    });
    const reviewNote = ref("");
    const reviewSubmitting = ref(false);
    const continuityCorrectionDrafts = reactive<Record<string, string>>({});
    const continuityCorrectionModes = reactive<Record<string, "resolved" | "not-applicable">>({});
    const continuityCorrectionSavingKey = ref("");
    const continuityCorrectionError = ref("");
    // P22：对比模式/批注草稿/差分预检状态（全部会话态，不进账本）。
    const compareMode = ref<"off" | "ab" | "wipe" | "difference">("off");
    const compareModeOptions = [
      { value: "off" as const, label: "并排" },
      { value: "ab" as const, label: "A/B 切换" },
      { value: "wipe" as const, label: "擦除" },
      { value: "difference" as const, label: "差分" },
    ];
    const abSource = ref<"raw" | "labeled">("raw");
    const wipePercent = ref(50);
    const differenceCanvas = ref<HTMLCanvasElement | null>(null);
    const differenceState = reactive({
      status: "idle" as "idle" | "loading" | "ready" | "error",
      error: "",
      requestKey: "",
    });
    const draftAnnotations = ref<AnnotationDraftGeometry[]>([]);
    const annotationTool = ref<"rect" | "point" | null>(null);
    const categoryLabels = STUDIO_REVIEW_ANNOTATION_CATEGORY_LABELS;
    const dragState = reactive({
      active: false,
      source: "" as "" | "raw" | "labeled",
      startX: 0,
      startY: 0,
      currentX: 0,
      currentY: 0,
    });
    const reworkGuidance = ref("");
    const incompleteDraftCount = computed(() => draftAnnotations.value.filter((draft) => !draft.category || !draft.note.trim()).length);
    const activePointerCleanups: Array<() => void> = [];
    function registerPointerCleanup(cleanup: () => void): void {
      activePointerCleanups.push(cleanup);
    }
    function releasePointerCleanups(): void {
      for (const cleanup of activePointerCleanups.splice(0)) cleanup();
      dragState.active = false;
      dragState.source = "";
    }
    let mediaRequestSequence = 0;
    let reviewSubmissionSequence = 0;
    let timelineOffset = 0;
    let conflictOffset = 0;
    let reviewCursor: string | undefined;
    let checkpointOffset = 0;

    const timelinePageTotal = computed(() => loadState.control?.assets
      .reduce((maximum, asset) => Math.max(maximum, asset.timeline.total), 0) ?? 0);
    const timelineNextOffset = computed(() => loadState.control?.assets
      .map((asset) => asset.timeline.nextOffset)
      .find((value): value is number => value !== undefined));
    const continuityHandoff = computed(() => {
      if (props.focus?.generationTarget?.targetKind !== "unit-grid" || !loadState.control) return null;
      const handoffFields = new Set<StudioContinuityField>(["position", "facing", "heldObject", "layout", "lighting"]);
      const rows = loadState.control.assets.flatMap((asset) => {
        const newestByField = new Map<StudioContinuityField, typeof asset.timeline.items[number]>();
        for (const item of asset.timeline.items) {
          if (!handoffFields.has(item.field)) continue;
          const previous = newestByField.get(item.field);
          if (!previous || item.endMilliseconds > previous.endMilliseconds
            || (item.endMilliseconds === previous.endMilliseconds && item.entryId > previous.entryId)) {
            newestByField.set(item.field, item);
          }
        }
        return [...newestByField.values()].map((item) => ({
          assetId: asset.assetId,
          assetName: asset.assetName,
          field: item.field,
          value: stateText(item.state),
          usable: item.state.status === "resolved" && !isOpaqueContinuityLocator(item.state.value),
        }));
      });
      return {
        rows,
        usableCount: rows.filter((row) => row.usable).length,
      };
    });
    const continuityCorrectionRows = computed(() => {
      const control = loadState.control;
      if (!control) return [] as Array<{
        key: string;
        assetId: string;
        assetName: string;
        field: Exclude<StudioContinuityField, "referenceSha256">;
        entryId: string;
        headRevision: number;
        placeholder: string;
        notApplicablePlaceholder: string;
      }>;
      const rows: Array<{
        key: string;
        assetId: string;
        assetName: string;
        field: Exclude<StudioContinuityField, "referenceSha256">;
        entryId: string;
        headRevision: number;
        placeholder: string;
        notApplicablePlaceholder: string;
      }> = [];
      for (const asset of control.assets) {
        const latestByField = new Map<StudioContinuityField, typeof asset.timeline.items[number]>();
        for (const item of asset.timeline.items) {
          if (item.field === "referenceSha256" || item.state.status !== "resolved" || !isOpaqueContinuityLocator(item.state.value)) continue;
          const previous = latestByField.get(item.field);
          if (!previous || item.endMilliseconds > previous.endMilliseconds
            || (item.endMilliseconds === previous.endMilliseconds && item.entryId > previous.entryId)) {
            latestByField.set(item.field, item);
          }
        }
        for (const item of latestByField.values()) {
          rows.push({
            key: `${asset.assetId}:${item.field}:${item.entryId}`,
            assetId: asset.assetId,
            assetName: asset.assetName,
            field: item.field as Exclude<StudioContinuityField, "referenceSha256">,
            entryId: item.entryId,
            headRevision: item.headRevision,
            placeholder: `例如：${asset.assetName}在画面左侧，面向右侧，未持物。`,
            notApplicablePlaceholder: `例如：${asset.assetName}为道具，本镜不存在${fieldLabel(item.field)}状态。`,
          });
        }
      }
      return rows;
    });
    const canAppendContinuityCorrection = computed(() => Boolean(props.api.appendContinuityCorrection));
    /** 校正必须可看正式 raw/labeled；它不等同于可提交 Studio Review。 */
    const reviewMediaAvailable = computed(() => Boolean(
      props.focus?.rawSha256
      && props.focus.labeledSha256
      && props.api.getMedia,
    ));
    const reviewPairAvailable = computed(() => Boolean(
      props.focus?.reviewWriteAllowed !== false
      && props.focus?.generationRunId
      && props.focus.rawResultId
      && props.focus.rawSha256
      && props.focus.labeledResultId
      && props.focus.labeledSha256
      && props.focus.packId
      && props.api.submitReview
      && props.api.getReviewIdentity,
    ));
    const readOnlyEvidenceNote = computed(() => props.focus?.evidenceSource === "checkpoint-attested"
      ? "停检账本已闭合的 raw/labeled 仅供核对并追加真实连续性状态；不得据此再次提交 Studio Review。"
      : "历史 PASS 图仅供核对并追加真实连续性状态；该记录没有受管生成 run，不能提交 Studio Review。");
    const reviewPairReady = computed(() => Boolean(
      reviewPairAvailable.value
      && reviewMedia.status === "ready"
      && reviewMedia.rawDecoded
      && reviewMedia.labeledDecoded,
    ));
    const focus = computed(() => props.focus);
    const frozenPreviousStanding = ref<StudioPanelStandingHandoff | null>(null);
    const frozenPreviousStandingLine = computed(() => formatPreviousStandingReadonlyLine(frozenPreviousStanding.value));
    const frozenLightingLine = ref<string | null>(null);
    const frozenCostumeLine = ref<string | null>(null);
    const frozenShotTypeLine = ref<string | null>(null);
    const frozenBeatLine = ref<string | null>(null);
    const reviewStandingPackId = computed(() =>
      props.focus?.packId
      ?? loadState.control?.review?.control.head?.packId
      ?? loadState.control?.review?.history.items[0]?.packId
      ?? "",
    );
    const reviewStandingPanelId = computed(() => {
      const target = props.focus?.generationTarget;
      if (target?.targetKind === "panel") return target.panelId;
      return props.focus?.panelId || draft.panelId;
    });
    let reviewStandingToken = 0;

    watch(() => props.projectRoot, (root) => {
      invalidateStudioContinuityReviewLoad(loadState, root);
      invalidateReviewMedia();
      reviewSubmissionSequence += 1;
      reviewSubmitting.value = false;
      continuityCorrectionSavingKey.value = "";
      continuityCorrectionError.value = "";
      originalPreview.value = null;
      frozenPreviousStanding.value = null;
      frozenLightingLine.value = null;
      frozenCostumeLine.value = null;
      frozenShotTypeLine.value = null;
      frozenBeatLine.value = null;
      reviewStandingToken += 1;
      timelineOffset = 0;
      conflictOffset = 0;
      reviewCursor = undefined;
      checkpointOffset = 0;
    });

    watch([reviewStandingPackId, reviewStandingPanelId, () => props.projectRoot], async () => {
      const packId = reviewStandingPackId.value;
      const token = ++reviewStandingToken;
      frozenPreviousStanding.value = null;
      frozenLightingLine.value = null;
      frozenCostumeLine.value = null;
      frozenShotTypeLine.value = null;
      frozenBeatLine.value = null;
      if (!packId) return;
      try {
        const pack = await window.canvasApi.getStudioFrozenPack(props.projectRoot, packId);
        if (token !== reviewStandingToken) return;
        frozenPreviousStanding.value = previousStandingFromAnyFrozenPack(pack, reviewStandingPanelId.value);
        frozenLightingLine.value = formatFrozenPanelLightingReadonlyLine(
          frozenPanelLightingFromAnyFrozenPack(pack, reviewStandingPanelId.value),
        );
        frozenCostumeLine.value = formatFrozenPanelCostumeReadonlyLine(
          frozenPanelCostumeFromAnyFrozenPack(pack, reviewStandingPanelId.value),
        );
        frozenShotTypeLine.value = formatFrozenPanelShotTypeReadonlyLine(
          frozenPanelShotTypeFromAnyFrozenPack(pack, reviewStandingPanelId.value),
        );
        frozenBeatLine.value = formatFrozenPanelBeatReadonlyLine(
          frozenPanelBeatFromAnyFrozenPack(pack, reviewStandingPanelId.value),
        );
      } catch {
        if (token !== reviewStandingToken) return;
        frozenPreviousStanding.value = null;
        frozenLightingLine.value = null;
        frozenCostumeLine.value = null;
        frozenShotTypeLine.value = null;
        frozenBeatLine.value = null;
      }
    }, { immediate: true });

    onBeforeUnmount(() => {
      invalidateStudioContinuityReviewLoad(loadState);
      invalidateReviewMedia();
      reviewSubmissionSequence += 1;
      reviewStandingToken += 1;
      frozenPreviousStanding.value = null;
      frozenLightingLine.value = null;
      frozenCostumeLine.value = null;
      frozenShotTypeLine.value = null;
      frozenBeatLine.value = null;
      releasePointerCleanups();
    });
    if (typeof window !== "undefined") {
      window.addEventListener("pointercancel", releasePointerCleanups);
      onBeforeUnmount(() => window.removeEventListener("pointercancel", releasePointerCleanups));
    }

    async function loadControl(reset: boolean): Promise<void> {
      if (reset) {
        timelineOffset = 0;
        conflictOffset = 0;
        reviewCursor = undefined;
        checkpointOffset = 0;
      }
      const projectRoot = props.projectRoot;
      const token = beginStudioContinuityReviewLoad(loadState, projectRoot);
      try {
        const query = buildStudioContinuityReviewQuery(draft, {
          timelineOffset,
          conflictOffset,
          ...(reviewCursor ? { reviewCursor } : {}),
          checkpointOffset,
        });
        const control = await props.api.getControl(projectRoot, query);
        commitStudioContinuityReviewLoad(loadState, token, control);
      } catch (reason) {
        if (failStudioContinuityReviewLoad(loadState, token, reason)) {
          emit("failed", loadState.error);
        }
      }
    }

    async function applyFocus(): Promise<void> {
      const focus = props.focus;
      if (!focus) return;
      const projectRoot = props.projectRoot;
      const generationRunId = focus.generationRunId ?? "";
      const focusToken = focus.token;
      draft.unitId = focus.unitId;
      draft.unitRevision = String(focus.unitRevision);
      draft.panelId = focus.panelId;
      draft.startMilliseconds = String(focus.startMilliseconds);
      draft.endMilliseconds = String(focus.endMilliseconds);
      draft.assetIds = focus.assetIds.join(", ");
      draft.generationRunId = focus.generationRunId ?? "";
      reviewNote.value = "";
      continuityCorrectionSavingKey.value = "";
      continuityCorrectionError.value = "";
      // P22 R3-F1：切换审片对象后会话态草稿随图像失效（防错写到新宫格）。
      draftAnnotations.value = [];
      annotationTool.value = null;
      reworkGuidance.value = "";
      dragState.active = false;
      dragState.source = "";
      originalPreview.value = null;
      const requestSequence = beginReviewMedia(projectRoot, generationRunId, focusToken);
      const controlPromise = loadControl(true);
      try {
        if (!reviewMediaAvailable.value) throw new Error("当前校正缺少已核验 raw/labeled 身份，无法按原图填写视觉状态。");
        if (!props.api.getMedia) throw new Error("当前桌面构建没有提供受管媒体读取能力。");
        const [raw, labeled] = await Promise.all([
          props.api.getMedia(projectRoot, focus.rawSha256!),
          props.api.getMedia(projectRoot, focus.labeledSha256!),
        ]);
        if (!isCurrentMediaRequest(requestSequence, projectRoot, generationRunId, focusToken)) return;
        const rawUrls = reviewMediaDisplayUrls(raw);
        const labeledUrls = reviewMediaDisplayUrls(labeled);
        if (!rawUrls.thumbnailUrl && !rawUrls.originalUrl) throw new Error("raw 媒体记录不存在或没有可读取地址。");
        if (!labeledUrls.thumbnailUrl && !labeledUrls.originalUrl) throw new Error("labeled 媒体记录不存在或没有可读取地址。");
        rawImageUrl.value = rawUrls.thumbnailUrl;
        labeledImageUrl.value = labeledUrls.thumbnailUrl;
        rawOriginalUrl.value = rawUrls.originalUrl;
        labeledOriginalUrl.value = labeledUrls.originalUrl;
        if (!rawUrls.thumbnailUrl && !labeledUrls.thumbnailUrl) {
          reviewMedia.status = "idle";
        }
      } catch (reason) {
        if (isCurrentMediaRequest(requestSequence, projectRoot, generationRunId, focusToken)) failReviewMedia(reason);
      } finally {
        await controlPromise;
      }
    }

    function correctionScope() {
      const scope = loadState.control?.scope;
      if (!scope) throw new Error("连续性控制面尚未加载，不能写回校正。");
      return {
        kind: scope.kind,
        scopeId: scope.scopeId,
        unitId: scope.unitId,
        unitRevision: scope.unitRevision,
        startMilliseconds: scope.startMilliseconds,
        endMilliseconds: scope.endMilliseconds,
      };
    }

    async function appendOpaqueCorrection(row: typeof continuityCorrectionRows.value[number]): Promise<void> {
      const value = (continuityCorrectionDrafts[row.key] ?? "").trim();
      const mode = continuityCorrectionModes[row.key] ?? "resolved";
      if (!value || isOpaqueContinuityLocator(value)) {
        continuityCorrectionError.value = mode === "not-applicable"
          ? "请说明为何该字段不适用，不能使用内部定位或技术编号。"
          : "请填写真实可见状态，不能使用内部定位或技术编号。";
        return;
      }
      if (!props.api.appendContinuityCorrection || continuityCorrectionSavingKey.value) return;
      continuityCorrectionSavingKey.value = row.key;
      continuityCorrectionError.value = "";
      try {
        await props.api.appendContinuityCorrection(props.projectRoot, {
          expectedHeadRevision: row.headRevision,
          scope: correctionScope(),
          subjectId: row.assetId,
          field: row.field,
          supersedesEntryId: row.entryId,
          state: mode === "not-applicable"
            ? { status: "not-applicable", reason: value }
            : { status: "resolved", value },
        });
        delete continuityCorrectionDrafts[row.key];
        delete continuityCorrectionModes[row.key];
        emit("reviewChanged", `已追加${row.assetName}的${fieldLabel(row.field)}人工校正。`);
        await loadControl(true);
      } catch (reason) {
        continuityCorrectionError.value = reason instanceof Error ? reason.message : String(reason);
        emit("failed", continuityCorrectionError.value);
      } finally {
        continuityCorrectionSavingKey.value = "";
      }
    }

    async function submitVisualReview(decision: "pass" | "rework" | "reject"): Promise<void> {
      if (reviewSubmitting.value) return;
      const focus = props.focus;
      const control = loadState.control?.review?.control;
      if (focus?.reviewWriteAllowed === false || !focus?.generationRunId || !focus.packId || !focus.rawResultId || !focus.rawSha256
        || !focus.labeledResultId || !focus.labeledSha256 || !control
        || !props.api.submitReview || !props.api.getReviewIdentity) return;
      const note = reviewNote.value.trim();
      if (!reviewPairReady.value || !note) return;
      const projectRoot = props.projectRoot;
      const generationRunId = focus.generationRunId;
      const focusToken = focus.token;
      const submissionSequence = ++reviewSubmissionSequence;
      reviewSubmitting.value = true;
      try {
        const identity = await props.api.getReviewIdentity(projectRoot, focus.packId);
        if (!isCurrentReviewSubmission(submissionSequence, projectRoot, generationRunId, focusToken)) return;
        const correction = Boolean(control.head);
        // P22：草稿批注经确定性 id 派生后随提交写回（无草稿时 annotations 为空，行为同旧版）；
        // criteria 与 annotations 判据统一为"完整草稿"（分类+note 齐备），不完整草稿提交前已拦。
        const validDrafts = draftAnnotations.value.filter((draft) => draft.category && draft.note.trim());
        const annotations = assignUniqueAnnotationIds(validDrafts.map((draft) => ({ ...draft, note: draft.note.trim() })));
        const summary = annotationCategorySummary(annotations.map((ann) => ann.category!));
        const fullNote = summary ? `${summary}。${note}` : note;
        await props.api.submitReview(projectRoot, {
          generationRunId,
          kind: correction ? "correction" : "observation",
          expectedHeadRevision: control.headRevision,
          ...(correction && control.head ? { supersedesReviewId: control.head.reviewId } : {}),
          rawResultId: focus.rawResultId,
          rawSha256: focus.rawSha256,
          labeledResultId: focus.labeledResultId,
          labeledSha256: focus.labeledSha256,
          expectedPackFingerprint: identity.packFingerprint,
          continuityFingerprint: identity.continuityFingerprint,
          decision,
          criteria: buildReviewCriteria(decision, validDrafts.map((draft) => ({ category: draft.category!, note: draft.note.trim() })), note),
          annotations,
          reviewer: "user",
          note: fullNote,
        });
        if (!isCurrentReviewSubmission(submissionSequence, projectRoot, generationRunId, focusToken)) return;
        draftAnnotations.value = [];
        reworkGuidance.value = decision === "rework"
          ? `已记录返工：${summary || "未分类"}。下一步：可在历史区追加修正，或回画布对该宫格重新派发（plan 节点走重试命令，旧结果保留不动）。`
          : "";
        emit("reviewChanged", ({
          pass: "审片已通过并追加写回。",
          rework: "返工意见已追加写回。",
          reject: "拒绝意见已追加写回。",
        } as const)[decision]);
        await loadControl(true);
      } catch (reason) {
        if (isCurrentReviewSubmission(submissionSequence, projectRoot, generationRunId, focusToken)) {
          emit("failed", reason instanceof Error ? reason.message : String(reason));
        }
      } finally {
        if (submissionSequence === reviewSubmissionSequence) reviewSubmitting.value = false;
      }
    }

    /** 删除已提交批注 = 追加 correction（同 decision，annotations 集合移除该项），复用既有 CAS。 */
    async function removeHeadAnnotation(review: StudioGenerationReviewProjection, annotationId: string): Promise<void> {
      if (reviewSubmitting.value) return;
      const focus = props.focus;
      const control = loadState.control?.review?.control;
      if (!focus?.generationRunId || !focus.packId || !control?.head || !props.api.submitReview || !props.api.getReviewIdentity) return;
      const removed = review.annotations.find((ann) => ann.id === annotationId);
      if (!removed) return;
      if (!window.confirm(`移除批注 ${annotationId.slice(0, 10)}…？将追加一条修正记录（原批注不再生效，历史仍可追溯）。`)) return;
      const projectRoot = props.projectRoot;
      const generationRunId = focus.generationRunId;
      const focusToken = focus.token;
      const submissionSequence = ++reviewSubmissionSequence;
      reviewSubmitting.value = true;
      try {
        const identity = await props.api.getReviewIdentity(projectRoot, focus.packId);
        if (!isCurrentReviewSubmission(submissionSequence, projectRoot, generationRunId, focusToken)) return;
        const remaining = review.annotations
          .filter((ann) => ann.id !== annotationId)
          .map((ann) => ({
            id: ann.id!,
            kind: ann.kind ?? "rect" as const,
            ...(ann.category ? { category: ann.category } : {}),
            x: ann.x,
            y: ann.y,
            width: ann.width,
            height: ann.height,
            note: ann.note,
          }));
        const categorizedRemaining = remaining
          .filter((annotation): annotation is typeof annotation & { category: StudioReviewAnnotationCategory } => Boolean(annotation.category))
          .map((annotation) => ({ category: annotation.category, note: annotation.note }));
        await props.api.submitReview(projectRoot, {
          generationRunId,
          kind: "correction",
          expectedHeadRevision: control.headRevision,
          supersedesReviewId: control.head.reviewId,
          rawResultId: review.rawResultId,
          rawSha256: review.rawSha256,
          labeledResultId: review.labeledResultId,
          labeledSha256: review.labeledSha256,
          expectedPackFingerprint: identity.packFingerprint,
          continuityFingerprint: identity.continuityFingerprint,
          decision: review.decision,
          criteria: buildReviewCriteria(review.decision, categorizedRemaining, review.note),
          annotations: remaining,
          reviewer: "user",
          note: `移除批注 ${annotationId}：${removed.note.slice(0, 200)}`,
        });
        if (!isCurrentReviewSubmission(submissionSequence, projectRoot, generationRunId, focusToken)) return;
        emit("reviewChanged", "批注已移除并追加修正记录。");
        await loadControl(true);
      } catch (reason) {
        if (isCurrentReviewSubmission(submissionSequence, projectRoot, generationRunId, focusToken)) {
          emit("failed", reason instanceof Error ? reason.message : String(reason));
        }
      } finally {
        if (submissionSequence === reviewSubmissionSequence) reviewSubmitting.value = false;
      }
    }

    function decodedOf(source: "raw" | "labeled"): boolean {
      return source === "raw" ? reviewMedia.rawDecoded : reviewMedia.labeledDecoded;
    }

    function imageUrlOf(source: "raw" | "labeled"): string {
      return source === "raw" ? rawImageUrl.value : labeledImageUrl.value;
    }

    function originalUrlOf(source: "raw" | "labeled"): string {
      return source === "raw" ? rawOriginalUrl.value : labeledOriginalUrl.value;
    }

    interface OverlayAnnotation {
      key: string;
      kind: "rect" | "point";
      tone: "head" | "stale" | "draft";
      x: number;
      y: number;
      width: number;
      height: number;
    }

    /** 图上叠加集合：当前 Head 批注（head 色）+ 历史批注（置灰）+ 草稿（高亮）。坐标原样 0..1，SVG 以 *100 渲染（显示尺寸变化不漂）。
     * computed 缓存（R3-F4）：拖框逐帧渲染不重建历史集合。双图同坐标系，不区分左右图。 */
    const overlayComputed = computed<OverlayAnnotation[]>(() => {
      const items: OverlayAnnotation[] = [];
      const history = loadState.control?.review?.history.items ?? [];
      for (const review of history) {
        const tone = review.current && review.currentStaleReasons.length === 0 ? "head" : "stale";
        for (const ann of review.annotations ?? []) {
          items.push({
            key: `${review.reviewId}:${ann.id ?? `${ann.x}-${ann.y}`}`,
            kind: ann.kind === "point" ? "point" : "rect",
            tone,
            x: ann.x,
            y: ann.y,
            width: ann.width,
            height: ann.height,
          });
        }
      }
      for (const [index, draft] of draftAnnotations.value.entries()) {
        items.push({
          key: `draft:${index}`,
          kind: draft.kind,
          tone: "draft",
          x: draft.x,
          y: draft.y,
          width: draft.width,
          height: draft.height,
        });
      }
      return items;
    });
    function overlayAnnotations(source: "raw" | "labeled"): OverlayAnnotation[] {
      void source;
      return overlayComputed.value;
    }

    function normalizedStagePoint(event: PointerEvent, stage: HTMLElement): { x: number; y: number } {
      const rect = stage.getBoundingClientRect();
      return {
        x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
        y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
      };
    }

    function onStagePointerDown(source: "raw" | "labeled", event: PointerEvent): void {
      if (!annotationTool.value || !decodedOf(source)) return;
      const stage = event.currentTarget as HTMLElement;
      const point = normalizedStagePoint(event, stage);
      if (annotationTool.value === "point") {
        draftAnnotations.value = [...draftAnnotations.value, {
          kind: "point",
          category: undefined,
          x: Math.round(point.x * 10_000) / 10_000,
          y: Math.round(point.y * 10_000) / 10_000,
          width: 0,
          height: 0,
          note: "",
        }];
        return;
      }
      dragState.active = true;
      dragState.source = source;
      dragState.startX = point.x;
      dragState.startY = point.y;
      dragState.currentX = point.x;
      dragState.currentY = point.y;
      const onMove = (moveEvent: PointerEvent): void => {
        const next = normalizedStagePoint(moveEvent, stage);
        dragState.currentX = next.x;
        dragState.currentY = next.y;
      };
      const onUp = (upEvent: PointerEvent): void => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        const cleanupIndex = activePointerCleanups.indexOf(cleanup);
        if (cleanupIndex >= 0) activePointerCleanups.splice(cleanupIndex, 1);
        const end = normalizedStagePoint(upEvent, stage);
        dragState.active = false;
        dragState.source = "";
        const x = Math.min(dragState.startX, end.x);
        const y = Math.min(dragState.startY, end.y);
        const width = Math.abs(end.x - dragState.startX);
        const height = Math.abs(end.y - dragState.startY);
        if (width < 0.005 || height < 0.005) return;
        draftAnnotations.value = [...draftAnnotations.value, {
          kind: "rect",
          category: undefined,
          x: Math.round(x * 10_000) / 10_000,
          y: Math.round(y * 10_000) / 10_000,
          width: Math.round(width * 10_000) / 10_000,
          height: Math.round(height * 10_000) / 10_000,
          note: "",
        }];
      };
      const cleanup = (): void => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp, { once: true });
      registerPointerCleanup(cleanup);
      event.preventDefault();
    }

    function onWipeDividerKeydown(event: KeyboardEvent): void {
      if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
        wipePercent.value = Math.max(0, wipePercent.value - 5);
        event.preventDefault();
      } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
        wipePercent.value = Math.min(100, wipePercent.value + 5);
        event.preventDefault();
      } else if (event.key === "Home") {
        wipePercent.value = 0;
        event.preventDefault();
      } else if (event.key === "End") {
        wipePercent.value = 100;
        event.preventDefault();
      }
    }

    function onWipePointerDown(event: PointerEvent): void {
      const stage = event.currentTarget as HTMLElement;
      const update = (moveEvent: PointerEvent): void => {
        const rect = stage.getBoundingClientRect();
        wipePercent.value = wipeDividerPercent(moveEvent.clientX - rect.left, rect.width);
      };
      update(event);
      const onMove = (moveEvent: PointerEvent): void => update(moveEvent);
      const onUp = (): void => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        const cleanupIndex = activePointerCleanups.indexOf(cleanup);
        if (cleanupIndex >= 0) activePointerCleanups.splice(cleanupIndex, 1);
      };
      const cleanup = (): void => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp, { once: true });
      registerPointerCleanup(cleanup);
      event.preventDefault();
    }

    let differenceRequestSequence = 0;

    function invalidateDifference(): void {
      differenceRequestSequence += 1;
      differenceState.status = "idle";
      differenceState.error = "";
      differenceState.requestKey = "";
      const canvas = differenceCanvas.value;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    }

    async function loadDifference(): Promise<void> {
      const focus = props.focus;
      if (!focus?.rawSha256 || !focus.labeledSha256 || !reviewPairReady.value) return;
      const sequence = ++differenceRequestSequence;
      const requestKey = `${props.projectRoot}:${focus.rawSha256}:${focus.labeledSha256}:${reviewMedia.requestSequence}`;
      differenceState.status = "loading";
      differenceState.error = "";
      differenceState.requestKey = requestKey;
      let rawBitmap: ImageBitmap | undefined;
      let labeledBitmap: ImageBitmap | undefined;
      try {
        const [rawBytes, labeledBytes] = await Promise.all([
          window.canvasApi.readStudioMediaBytes(props.projectRoot, focus.rawSha256),
          window.canvasApi.readStudioMediaBytes(props.projectRoot, focus.labeledSha256),
        ]);
        if (sequence !== differenceRequestSequence || differenceState.requestKey !== requestKey) return;
        rawBitmap = await createImageBitmap(new Blob([new Uint8Array(rawBytes)]));
        if (sequence !== differenceRequestSequence || differenceState.requestKey !== requestKey) return;
        labeledBitmap = await createImageBitmap(new Blob([new Uint8Array(labeledBytes)]));
        if (sequence !== differenceRequestSequence || differenceState.requestKey !== requestKey) return;
        if (rawBitmap.width !== labeledBitmap.width || rawBitmap.height !== labeledBitmap.height) {
          throw new Error(`差分预检要求两图同尺寸，当前 ${rawBitmap.width}×${rawBitmap.height} vs ${labeledBitmap.width}×${labeledBitmap.height}。`);
        }
        // 差分只作人工辅助预检；将最长边缩到 2048，避免 4K 图同时展开多份 RGBA 导致内存尖峰。
        const MAX_DIFFERENCE_LONG_EDGE = 2048;
        const scale = Math.min(1, MAX_DIFFERENCE_LONG_EDGE / Math.max(rawBitmap.width, rawBitmap.height));
        const targetWidth = Math.max(1, Math.round(rawBitmap.width * scale));
        const targetHeight = Math.max(1, Math.round(rawBitmap.height * scale));
        const readPixels = (bitmap: ImageBitmap): { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> } => {
          const canvas = document.createElement("canvas");
          canvas.width = targetWidth;
          canvas.height = targetHeight;
          const context = canvas.getContext("2d");
          if (!context) throw new Error("当前环境不支持差分预检（无法创建画布上下文）。");
          context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
          return { width: targetWidth, height: targetHeight, data: context.getImageData(0, 0, targetWidth, targetHeight).data as Uint8ClampedArray<ArrayBuffer> };
        };
        const composed = composeAbsDifference(readPixels(rawBitmap), readPixels(labeledBitmap));
        if (sequence !== differenceRequestSequence || differenceState.requestKey !== requestKey) return;
        const canvas = differenceCanvas.value;
        const context = canvas?.getContext("2d");
        if (!canvas || !context) throw new Error("当前环境不支持差分预检（无法创建画布上下文）。");
        canvas.width = composed.width;
        canvas.height = composed.height;
        context.putImageData(new ImageData(composed.data, composed.width, composed.height), 0, 0);
        differenceState.status = "ready";
      } catch (reason) {
        if (sequence !== differenceRequestSequence || differenceState.requestKey !== requestKey) return;
        differenceState.status = "error";
        differenceState.error = `当前环境不支持差分预检：${reason instanceof Error ? reason.message : String(reason)}`;
      } finally {
        rawBitmap?.close();
        labeledBitmap?.close();
      }
    }

    watch(compareMode, (mode) => {
      if (mode === "difference") void loadDifference();
      else invalidateDifference();
    });
    watch(() => reviewMedia.status, (status) => {
      if (status !== "ready") invalidateDifference();
      else if (compareMode.value === "difference") void loadDifference();
    });

    function beginReviewMedia(projectRoot: string, generationRunId: string, focusToken: number): number {
      invalidateDifference();
      const requestSequence = ++mediaRequestSequence;
      rawImageUrl.value = "";
      labeledImageUrl.value = "";
      rawOriginalUrl.value = "";
      labeledOriginalUrl.value = "";
      Object.assign(reviewMedia, {
        requestSequence,
        projectRoot,
        generationRunId,
        focusToken,
        status: "loading",
        rawDecoded: false,
        labeledDecoded: false,
        error: "",
      });
      return requestSequence;
    }

    function invalidateReviewMedia(): void {
      invalidateDifference();
      const requestSequence = ++mediaRequestSequence;
      rawImageUrl.value = "";
      labeledImageUrl.value = "";
      rawOriginalUrl.value = "";
      labeledOriginalUrl.value = "";
      Object.assign(reviewMedia, {
        requestSequence,
        projectRoot: "",
        generationRunId: "",
        focusToken: 0,
        status: "idle",
        rawDecoded: false,
        labeledDecoded: false,
        error: "",
      });
    }

    function isCurrentMediaRequest(requestSequence: number, projectRoot: string, generationRunId: string, focusToken: number): boolean {
      return reviewMedia.requestSequence === requestSequence
        && reviewMedia.projectRoot === projectRoot
        && reviewMedia.generationRunId === generationRunId
        && reviewMedia.focusToken === focusToken
        && props.projectRoot === projectRoot
        // 已停检的只读证据可没有 generationRunId；UI 内部以空串归一化，不能因 undefined/"" 把有效媒体响应丢弃。
        && (props.focus?.generationRunId ?? "") === generationRunId
        && props.focus?.token === focusToken;
    }

    function failReviewMedia(reason: unknown): void {
      reviewMedia.status = "error";
      reviewMedia.rawDecoded = false;
      reviewMedia.labeledDecoded = false;
      reviewMedia.error = reason instanceof Error ? reason.message : String(reason);
    }

    async function onReviewImageLoad(kind: "raw" | "labeled", event: Event): Promise<void> {
      const image = event.currentTarget as HTMLImageElement | null;
      const requestSequence = Number(image?.dataset.reviewRequest);
      if (!image || !Number.isSafeInteger(requestSequence)
        || !isCurrentMediaRequest(requestSequence, reviewMedia.projectRoot, reviewMedia.generationRunId, reviewMedia.focusToken)) return;
      try {
        await image.decode();
        if (!isCurrentMediaRequest(requestSequence, reviewMedia.projectRoot, reviewMedia.generationRunId, reviewMedia.focusToken)) return;
        if (!image.complete || image.naturalWidth < 1 || image.naturalHeight < 1) throw new Error(`${kind.toUpperCase()} 图片无法解码。`);
        if (kind === "raw") reviewMedia.rawDecoded = true;
        else reviewMedia.labeledDecoded = true;
        if (reviewMedia.rawDecoded && reviewMedia.labeledDecoded) {
          reviewMedia.status = "ready";
          reviewMedia.error = "";
        } else if ((kind === "raw" && !labeledImageUrl.value) || (kind === "labeled" && !rawImageUrl.value)) {
          reviewMedia.status = "idle";
        }
      } catch (reason) {
        if (isCurrentMediaRequest(requestSequence, reviewMedia.projectRoot, reviewMedia.generationRunId, reviewMedia.focusToken)) failReviewMedia(reason);
      }
    }

    function onReviewImageError(kind: "raw" | "labeled", event: Event): void {
      const image = event.currentTarget as HTMLImageElement | null;
      const requestSequence = Number(image?.dataset.reviewRequest);
      if (!image || !Number.isSafeInteger(requestSequence)
        || !isCurrentMediaRequest(requestSequence, reviewMedia.projectRoot, reviewMedia.generationRunId, reviewMedia.focusToken)) return;
      failReviewMedia(new Error(`${kind.toUpperCase()} 图片加载失败；请核对媒体文件后重新读取。`));
    }

    function openOriginalPreview(kind: "raw" | "labeled"): void {
      if (!originalUrlOf(kind)) return;
      originalPreview.value = kind;
    }

    async function onOriginalPreviewLoad(kind: "raw" | "labeled", event: Event): Promise<void> {
      if (imageUrlOf(kind)) return;
      await onReviewImageLoad(kind, event);
    }

    function onOriginalPreviewError(kind: "raw" | "labeled", event: Event): void {
      if (imageUrlOf(kind) && decodedOf(kind)) return;
      onReviewImageError(kind, event);
    }

    function isCurrentReviewSubmission(sequence: number, projectRoot: string, generationRunId: string, focusToken: number): boolean {
      return sequence === reviewSubmissionSequence
        && props.projectRoot === projectRoot
        && props.focus?.generationRunId === generationRunId
        && props.focus.token === focusToken;
    }

    function previousTimeline(): void {
      timelineOffset = Math.max(0, timelineOffset - STUDIO_CONTINUITY_REVIEW_UI_TIMELINE_LIMIT);
      void loadControl(false);
    }

    function nextTimeline(): void {
      if (timelineNextOffset.value === undefined) return;
      timelineOffset = timelineNextOffset.value;
      void loadControl(false);
    }

    function nextReviewHistory(): void {
      const cursor = loadState.control?.review?.history.nextCursor;
      if (!cursor) return;
      reviewCursor = cursor;
      void loadControl(false);
    }

    function previousCheckpoint(): void {
      checkpointOffset = Math.max(0, checkpointOffset - STUDIO_CONTINUITY_REVIEW_UI_CHECKPOINT_LIMIT);
      void loadControl(false);
    }

    function nextCheckpoint(): void {
      const offset = loadState.control?.checkpoint.batches.nextOffset;
      if (offset === undefined) return;
      checkpointOffset = offset;
      void loadControl(false);
    }

    function fieldLabel(field: StudioContinuityField): string {
      return FIELD_LABELS[field];
    }

    function categoryLabel(category: "character" | "scene" | "prop" | "style" | undefined): string {
      return category ? ({ character: "角色", scene: "场景", prop: "道具", style: "风格" } as const)[category] : "资产";
    }

    function fieldStatusLabel(status: StudioContinuityReviewFieldStatus): string {
      return ({
        resolved: "已解析",
        "not-applicable": "不适用",
        unresolved: "未解析",
        missing: "缺失",
        conflict: "冲突",
      } satisfies Record<StudioContinuityReviewFieldStatus, string>)[status];
    }

    function nextActionHasTechnicalReason(reason: string): boolean {
      return reason.includes("slot:") || reason.includes("studio-");
    }

    function nextActionReasonText(reason: string): string {
      if (nextActionHasTechnicalReason(reason)) {
        return "当前六图停检批存在未完成或已陈旧的审片；先完成该批 Review，才能新增生产槽。";
      }
      return reason;
    }

    function assetFieldHasOpaqueState(asset: StudioContinuityReviewAssetControl, field: StudioContinuityField): boolean {
      return asset.timeline.items.some((item) => item.field === field
        && item.state.status === "resolved" && isOpaqueContinuityLocator(item.state.value));
    }

    function assetHasOpaqueState(asset: StudioContinuityReviewAssetControl): boolean {
      return asset.timeline.items.some((item) => item.state.status === "resolved" && isOpaqueContinuityLocator(item.state.value));
    }

    function assetDisplayReady(asset: StudioContinuityReviewAssetControl): boolean {
      return asset.ready && !assetHasOpaqueState(asset);
    }

    function assetResolvedVisualFieldCount(asset: StudioContinuityReviewAssetControl): number {
      return asset.fields.filter((field) => (field.status === "resolved" || field.status === "not-applicable")
        && !assetFieldHasOpaqueState(asset, field.field)).length;
    }

    function isOpaqueContinuityLocator(value: string | undefined): boolean {
      return Boolean(value && /^[a-z0-9._-]+:S\d+E\d+-U\d+:/iu.test(value));
    }

    function stateText(state: StudioContinuityFieldState): string {
      if (state.status !== "resolved") return state.reason;
      return isOpaqueContinuityLocator(state.value)
        ? "内部定位（需人工补全，不可直接用作镜头状态）"
        : state.value;
    }

    function reviewStatusLabel(status: string | undefined): string {
      return ({
        unreviewed: "未审核",
        pass: "通过",
        rework: "返工",
        reject: "拒绝",
        stale: "陈旧",
      } as Record<string, string>)[status ?? ""] ?? "尚无审片结果";
    }

    function checkpointStatusLabel(status: string): string {
      return ({
        "review-blocked": "Review 阻断",
        "refresh-required": "需刷新快照",
        "attestation-required": "需六图验收",
        passed: "已通过",
      } as Record<string, string>)[status] ?? status;
    }

    type ConsistencyVerdict = "consistent" | "needs-review" | "drifted" | "not-checkable";

    const CONSISTENCY_ERROR_LABELS: Record<string, string> = {
      "image-too-small": "图片过小，无法判定",
      "image-extreme-ratio": "图片比例异常，无法判定",
      "cross-project-reference": "引用不属于当前工程",
      "result-pair-missing": "结果对不存在",
      "pack-missing": "冻结包不存在",
      "result-media-missing": "结果媒体缺失",
    };

    // P19：机器一致性辅助横幅（辅助参考，不替代人工审片；数据源只走 control 投影）。
    const consistencyBanner = computed(() => {
      type BannerAsset = { assetId: string; assetName: string; verdict: ConsistencyVerdict; verdictLabel: string; stale: boolean; checklist: string[] };
      const verdictLabels: Record<ConsistencyVerdict, string> = {
        consistent: "一致",
        "needs-review": "需复核",
        drifted: "明显漂移",
        "not-checkable": "无法检查",
      };
      // 盲审 R3-F1：评估期间（含切 run 窗口）必须显示进行中态，不显示空白或旧结论。
      if (loadState.loading) {
        return { state: "evaluating", headline: "机器一致性：评估中（约几秒，最长 15 秒）…", detail: "", staleCount: 0, assets: [] as BannerAsset[] };
      }
      const consistency = loadState.control?.consistency;
      if (!consistency) return null;
      if (consistency.status === "not-evaluated") {
        return { state: "not-checkable", headline: "机器一致性：未评估", detail: "本次审片加载未请求评估。", staleCount: 0, assets: [] as BannerAsset[] };
      }
      if (consistency.status === "unavailable") {
        const detail = CONSISTENCY_ERROR_LABELS[consistency.reason ?? ""] ?? "评估输入不可用";
        return { state: "not-checkable", headline: "机器一致性：无法检查", detail, staleCount: 0, assets: [] as BannerAsset[] };
      }
      const evaluation = consistency.evaluation;
      if (!evaluation) {
        return { state: "not-checkable", headline: "机器一致性：无法检查", detail: "评估结果缺失", staleCount: 0, assets: [] as BannerAsset[] };
      }
      const assetNames = new Map((loadState.control?.assets ?? []).map((asset) => [asset.assetId, asset.assetName]));
      const detail = evaluation.transient
        ? "评估暂时失败（超时或被取消），点“重新读取”可重试。"
        : evaluation.evidence.errorClass
          ? (CONSISTENCY_ERROR_LABELS[evaluation.evidence.errorClass] ?? "评估器异常，无法判定")
          : "";
      return {
        state: evaluation.verdict as ConsistencyVerdict | string,
        headline: `机器一致性：${verdictLabels[evaluation.verdict]}（辅助参考，不替代人工审片）`,
        detail,
        staleCount: evaluation.assets.filter((asset) => asset.stale).length,
        assets: evaluation.assets.map((asset) => ({
          assetId: asset.assetId,
          assetName: assetNames.get(asset.assetId) ?? asset.assetId,
          verdict: asset.verdict,
          verdictLabel: verdictLabels[asset.verdict],
          stale: asset.stale,
          checklist: asset.criteria
            .filter((criterion) => criterion.code === "structural-locks")
            .flatMap((criterion) => (criterion.note ?? "").split("；").map((note) => note.trim()).filter(Boolean)),
        })),
      };
    });

    function consistencyStateClass(state: string): string {
      return ({
        consistent: "consistency-ok",
        "needs-review": "consistency-warn",
        drifted: "consistency-danger",
      } as Record<string, string>)[state] ?? "consistency-muted";
    }

    // applyFocus 同步触发媒体失效逻辑；必须在 setup 的全部状态完成初始化后再注册 immediate watcher，
    // 否则首次从“生成”进入“审片”会命中后置 let 的 TDZ，界面静默停在空态。
    watch(() => props.focus?.token, () => {
      if (props.focus) void applyFocus();
    }, { immediate: true });

    return {
      draft,
      loadState,
      consistencyBanner,
      consistencyStateClass,
      timelineNextOffset,
      timelinePageTotal,
      continuityHandoff,
      frozenPreviousStandingLine,
      frozenLightingLine,
      frozenCostumeLine,
      frozenShotTypeLine,
      frozenBeatLine,
      continuityCorrectionRows,
      canAppendContinuityCorrection,
      reviewMediaAvailable,
      readOnlyEvidenceNote,
      continuityCorrectionDrafts,
      continuityCorrectionModes,
      continuityCorrectionSavingKey,
      continuityCorrectionError,
      appendOpaqueCorrection,
      get timelineOffset() { return timelineOffset; },
      get checkpointOffset() { return checkpointOffset; },
      checkpointStatusLabel,
      categoryLabel,
      focus,
      fieldLabel,
      fieldStatusLabel,
      nextActionReasonText,
      nextActionHasTechnicalReason,
      assetFieldHasOpaqueState,
      assetHasOpaqueState,
      assetDisplayReady,
      assetResolvedVisualFieldCount,
      loadControl,
      applyFocus,
      nextCheckpoint,
      nextReviewHistory,
      nextTimeline,
      previousCheckpoint,
      previousTimeline,
      reviewStatusLabel,
      reviewPairAvailable,
      reviewPairReady,
      reviewMedia,
      rawImageUrl,
      labeledImageUrl,
      rawOriginalUrl,
      labeledOriginalUrl,
      originalPreview,
      reviewNote,
      reviewSubmitting,
      compareMode,
      compareModeOptions,
      abSource,
      wipePercent,
      differenceCanvas,
      differenceState,
      draftAnnotations,
      annotationTool,
      categoryLabels,
      dragState,
      reworkGuidance,
      incompleteDraftCount,
      decodedOf,
      imageUrlOf,
      originalUrlOf,
      overlayAnnotations,
      onStagePointerDown,
      onWipePointerDown,
      onWipeDividerKeydown,
      removeHeadAnnotation,
      onReviewImageError,
      onReviewImageLoad,
      onOriginalPreviewLoad,
      onOriginalPreviewError,
      openOriginalPreview,
      submitVisualReview,
      stateText,
    };
  },
});
</script>

<style scoped>
.continuity-review{min-height:0;height:100%;overflow:auto;background:var(--ui-surface);color:var(--ui-text)}
.control-header{display:grid;grid-template-columns:minmax(320px,1fr) minmax(300px,.8fr);gap:22px;padding:22px 26px;border-bottom:1px solid var(--ui-line);background:var(--ui-bg)}
.control-header>div:first-child>span,.control-section>header span{color:var(--ui-accent-strong);font:8px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.13em}
.control-header h2,.control-section h3{margin:5px 0 0}
.control-header h2{font-size:21px}
.control-header p{margin:7px 0 0;color:var(--ui-text-3);font-size:9px;line-height:1.6}
.next-action{padding:12px 14px;border:1px solid var(--ui-accent-strong);background:var(--ui-accent)}
.next-action.ready{border-color:var(--ui-ok);background:var(--ui-surface)}
.next-action span,.next-action strong,.next-action code{display:block}
.next-action span{color:var(--ui-accent-strong);font-size:8px}
.next-action strong{margin-top:4px;color:var(--ui-accent-strong);font-size:12px}
.next-action p{margin:5px 0}
.next-action code{margin-top:7px;color:var(--ui-text-2);font-size:8px}
.scope-form{display:grid;grid-template-columns:2fr .65fr 1.5fr .75fr .75fr;gap:9px;padding:14px 26px;border-bottom:1px solid var(--ui-line);background:var(--ui-surface)}
.scope-form label{min-width:0}
.scope-form label.wide{grid-column:span 2}
.scope-form label>span{display:block;margin-bottom:5px;color:var(--ui-text-3);font-size:8px}
.scope-form input{width:100%;height:31px;box-sizing:border-box;padding:0 8px;border:1px solid var(--ui-line);outline:0;background:var(--ui-surface);color:var(--ui-text);font:9px ui-monospace,SFMono-Regular,Menlo,monospace}
.scope-form input:focus{border-color:var(--ui-accent-strong)}
.scope-form>button{align-self:end;height:31px;display:flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--ui-accent-strong);background:var(--ui-accent-soft);color:var(--ui-accent-strong);font-size:9px;cursor:pointer}
.error-banner{margin:14px 26px 0;padding:10px 12px;border:1px solid var(--ui-danger);background:color-mix(in srgb, var(--ui-danger) 10%, var(--ui-surface));color:var(--ui-danger);font-size:9px}
.empty-control{min-height:360px;display:grid;place-content:center;justify-items:center;gap:8px;padding:30px;color:var(--ui-line);text-align:center}
.empty-control h3{margin:4px 0 0;color:var(--ui-text-2);font-size:15px}
.empty-control p{max-width:480px;margin:0;font-size:9px;line-height:1.7}
.summary-strip{display:grid;grid-template-columns:repeat(5,1fr);border-bottom:1px solid var(--ui-line)}
.summary-strip div{padding:13px 18px;border-right:1px solid var(--ui-line)}
.summary-strip div:last-child{border-right:0}
.summary-strip strong,.summary-strip span{display:block}
.summary-strip strong{color:var(--ui-accent-strong);font:14px ui-monospace,SFMono-Regular,Menlo,monospace}
.summary-strip span{margin-top:4px;color:var(--ui-text-3);font-size:8px}
.control-section{margin:16px 26px 0;border:1px solid var(--ui-line);background:var(--ui-surface)}
.control-section>header{display:flex;align-items:center;justify-content:space-between;padding:11px 14px;border-bottom:1px solid var(--ui-line)}
.control-section h3{font-size:13px}
.control-section>header small{color:var(--ui-text-3);font:8px ui-monospace,SFMono-Regular,Menlo,monospace}
.handoff-note{margin:0;padding:10px 14px;border-bottom:1px solid var(--ui-line);color:var(--ui-text-3);font-size:9px;line-height:1.6}
.handoff-note.ready{color:var(--ui-ok)}
.handoff-note.blocked{color:var(--ui-danger)}
.handoff-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1px;background:var(--ui-line)}
.handoff-grid>div{min-width:0;padding:9px 10px;background:var(--ui-surface);content-visibility:auto;contain-intrinsic-size:auto 40px}
.handoff-grid span,.handoff-grid b{display:block}
.handoff-grid span{color:var(--ui-text-3);font-size:8px}
.handoff-grid b{margin-top:4px;overflow:hidden;color:var(--ui-danger);font:8px ui-monospace,SFMono-Regular,Menlo,monospace;text-overflow:ellipsis;white-space:nowrap}
.handoff-grid .usable b{color:var(--ui-ok)}
.opaque-correction-section{border-color:color-mix(in srgb,var(--ui-danger) 52%,var(--ui-line))}
.opaque-correction-note{margin:0;padding:10px 14px;border-bottom:1px solid var(--ui-line);color:var(--ui-text-3);font-size:9px;line-height:1.6}
.opaque-correction-error{margin:10px 12px}
.opaque-correction-list{display:grid;gap:1px;background:var(--ui-line)}
.opaque-correction-list article{display:grid;grid-template-columns:minmax(180px,1fr) minmax(260px,2fr) auto;gap:10px;align-items:end;padding:10px 12px;background:var(--ui-surface)}
.opaque-correction-list header b,.opaque-correction-list header small{display:block}
.opaque-correction-list header b{font-size:9px}.opaque-correction-list header small{margin-top:4px;color:var(--ui-danger);font-size:8px}
.opaque-correction-list label{display:grid;gap:5px}.opaque-correction-list label span{color:var(--ui-text-3);font-size:8px}
.opaque-correction-list textarea{width:100%;min-height:46px;resize:vertical;border:1px solid var(--ui-line);background:var(--ui-surface-alt);color:var(--ui-text);font:9px ui-monospace,SFMono-Regular,Menlo,monospace;line-height:1.45}
.opaque-correction-list button{align-self:end;min-height:30px}
.inline-empty{padding:18px;color:var(--ui-text-3);font-size:9px}
.asset-control{margin:12px;border-left:3px solid var(--ui-danger);background:var(--ui-surface);content-visibility:auto;contain-intrinsic-size:auto 160px}
.asset-control.ready{border-left-color:var(--ui-ok)}
.asset-control>header{display:flex;align-items:center;justify-content:space-between;padding:9px 11px;border-bottom:1px solid var(--ui-line)}
.asset-control>header>div{display:flex;align-items:center;gap:9px}
.asset-control>header code{color:var(--ui-text-2);font-size:9px}
.asset-control>header strong{color:var(--ui-danger);font-size:8px}
.asset-control.ready>header strong{color:var(--ui-ok)}
.asset-control>header>span{color:var(--ui-text-3);font:9px ui-monospace,SFMono-Regular,Menlo,monospace}
.field-grid{display:grid;grid-template-columns:repeat(9,minmax(72px,1fr));border-bottom:1px solid var(--ui-line)}
.field-grid>div{padding:8px;border-right:1px solid var(--ui-line)}
.field-grid>div:last-child{border-right:0}
.field-grid span,.field-grid b,.field-grid small{display:block}
.field-grid span{color:var(--ui-text-3);font-size:7px}
.field-grid b{margin-top:4px;color:var(--ui-danger);font-size:8px}
.field-grid small{margin-top:3px;color:var(--ui-line);font-size:7px}
.field-grid .field-resolved b,.field-grid .field-not-applicable b{color:var(--ui-ok)}
.field-grid .field-conflict b{color:var(--ui-accent-strong)}
.field-grid .field-opaque b{color:var(--ui-danger)}
.blocker-list{margin:0;padding:9px 14px 9px 29px;border-bottom:1px solid var(--ui-line);color:var(--ui-danger);font-size:8px;line-height:1.6}
.blocker-list b{margin-right:6px;color:var(--ui-danger)}
.timeline-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:1px;background:var(--ui-line)}
.timeline-list>div{position:relative;padding:9px 10px;background:var(--ui-surface);content-visibility:auto;contain-intrinsic-size:auto 40px}
.timeline-list span,.timeline-list b{display:inline-block}
.timeline-list span{color:var(--ui-text-3);font:7px ui-monospace,SFMono-Regular,Menlo,monospace}
.timeline-list b{margin-left:7px;color:var(--ui-text-2);font-size:8px}
.timeline-list p{margin:5px 0 0;overflow:hidden;color:var(--ui-text-3);font-size:8px;text-overflow:ellipsis;white-space:nowrap}
.timeline-list em{position:absolute;right:8px;top:8px;color:var(--ui-accent-strong);font-size:7px;font-style:normal}
.timeline-list>small{padding:7px 10px;background:var(--ui-surface);color:var(--ui-text-3);font-size:7px}
.page-actions{display:flex;align-items:center;justify-content:center;gap:13px;padding:9px;border-top:1px solid var(--ui-line)}
.page-actions button,.page-more{height:25px;padding:0 9px;border:1px solid var(--ui-line);background:transparent;color:var(--ui-accent-strong);font-size:8px;cursor:pointer}
.page-actions button:disabled{color:var(--ui-line)}
.page-actions span{color:var(--ui-text-3);font-size:8px}
.conflict-section article{display:grid;grid-template-columns:minmax(180px,1fr) 1fr minmax(180px,1fr);gap:12px;padding:10px 13px;border-top:1px solid var(--ui-line);content-visibility:auto;contain-intrinsic-size:auto 56px}
.conflict-section article>div{display:flex;gap:8px}
.conflict-section article b{font-size:9px}
.conflict-section article span{color:var(--ui-accent-strong);font-size:8px}
.conflict-section article p{margin:0;color:var(--ui-text-3);font-size:8px}
.conflict-section article code{overflow:hidden;color:var(--ui-text-3);font-size:7px;text-overflow:ellipsis;white-space:nowrap}
.review-head{margin:12px;padding:12px;border:1px solid var(--ui-line);background:var(--ui-surface)}
.review-head.pass{border-color:var(--ui-ok)}
.review-head.stale,.review-head.rework,.review-head.reject{border-color:var(--ui-danger)}
.review-head strong{color:var(--ui-accent-strong);font-size:12px}
.review-head span{margin-left:10px;color:var(--ui-text-3);font-size:8px}
.review-head p{margin:7px 0 0;color:var(--ui-text-3);font-size:8px}
.history-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:1px;background:var(--ui-line);border-top:1px solid var(--ui-line)}
.history-list article{padding:11px;background:var(--ui-surface);content-visibility:auto;contain-intrinsic-size:auto 56px}
.history-list span,.history-list b,.history-list em{display:inline-block}
.history-list span{color:var(--ui-text-3);font-size:7px}
.history-list b{margin-left:8px;color:var(--ui-accent-strong);font-size:8px}
.history-list em{float:right;font-size:7px;font-style:normal}
.history-list em.current{color:var(--ui-ok)}
.history-list em.stale{color:var(--ui-danger)}
.history-list p{margin:7px 0 0;color:var(--ui-text-2);font-size:8px}
.history-list small{display:block;margin-top:5px;color:var(--ui-danger);font-size:7px}
.page-more{margin:10px 12px}
.checkpoint-summary{display:flex;gap:18px;padding:10px 14px;border-bottom:1px solid var(--ui-line);color:var(--ui-text-3);font-size:8px}
.ready-text{color:var(--ui-ok)!important}
.blocked-text{color:var(--ui-danger)!important}
.blocking-batch{margin:12px;padding:11px;border:1px solid var(--ui-danger);background:color-mix(in srgb, var(--ui-danger) 10%, var(--ui-surface))}
.blocking-batch strong,.blocking-batch span{display:inline-block}
.blocking-batch strong{color:var(--ui-accent-strong);font-size:10px}
.blocking-batch span{margin-left:9px;color:var(--ui-accent-strong);font-size:8px}
.blocking-batch p{margin:6px 0 0;color:var(--ui-danger);font-size:8px}
.batch-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1px;background:var(--ui-line)}
.batch-grid article{padding:11px;background:var(--ui-surface);content-visibility:auto;contain-intrinsic-size:auto 56px}
.batch-grid header{display:flex;justify-content:space-between}
.batch-grid b{font-size:9px}
.batch-grid header span{color:var(--ui-accent-strong);font-size:8px}
.batch-grid p{margin:6px 0 0;color:var(--ui-text-3);font-size:8px}
.batch-grid small{display:block;margin-top:6px;color:var(--ui-danger);font-size:7px}
.read-only-note{display:flex;align-items:center;gap:8px;margin:14px 26px 20px;color:var(--ui-text-3);font-size:8px}
.spinning{animation:continuity-spin .8s linear infinite}
@keyframes continuity-spin{to{transform:rotate(360deg)}}
@media(max-width:1180px){.control-header{grid-template-columns:1fr}
.scope-form{grid-template-columns:repeat(3,1fr)}
.opaque-correction-list article{grid-template-columns:1fr}
.field-grid{grid-template-columns:repeat(3,1fr)}
.summary-strip{grid-template-columns:repeat(3,1fr)}
}
@media(prefers-reduced-motion:reduce){.spinning{animation:none}
}
.summary-strip{grid-template-columns:repeat(6,1fr)}
.review-entry-empty{display:grid;justify-items:center;gap:8px;padding:28px 26px;color:var(--ui-text-3);text-align:center}
.review-entry-empty h3{margin:4px 0 0;color:var(--ui-text-2);font-size:15px}
.review-entry-empty>p{max-width:560px;margin:0;font-size:9px;line-height:1.7}
.empty-goto-canvas{margin-top:6px;min-height:32px;padding:0 14px;border:1px solid var(--ui-accent);border-radius:var(--ui-radius-ctl);background:var(--ui-accent);color:var(--ui-accent-contrast);font-size:12px;cursor:pointer}
.empty-goto-canvas:hover{background:var(--ui-accent-strong);border-color:var(--ui-accent-strong)}
.diagnostic-details{width:min(920px,100%);margin-top:10px;border:1px solid var(--ui-line);background:var(--ui-surface);text-align:left}
.diagnostic-details>summary{padding:10px 12px;color:var(--ui-text-3);font-size:9px;cursor:pointer}
.diagnostic-details[open]>summary{border-bottom:1px solid var(--ui-line)}
.diagnostic-details .scope-form{border-bottom:0;padding:14px}
.focused-scope{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:13px 26px;border-bottom:1px solid var(--ui-line);background:var(--ui-surface)}
.focused-scope span,.focused-scope strong,.focused-scope small{display:block}
.focused-scope span{color:var(--ui-accent-strong);font-size:8px}
.focused-scope strong{margin-top:4px;font-size:11px}
.focused-scope small{margin-top:4px;color:var(--ui-text-3);font-size:8px}
.focused-scope button{height:29px;padding:0 10px;border:1px solid var(--ui-accent-strong);background:transparent;color:var(--ui-accent-strong);font-size:8px;cursor:pointer}
.review-workbench,.continuity-reference-workbench{margin:12px;border:1px solid var(--ui-line);background:var(--ui-surface)}
.continuity-reference-note{margin:0;padding:9px 11px;border-bottom:1px solid var(--ui-line);color:var(--ui-text-3);font-size:8px;line-height:1.6}
.review-comparison{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--ui-line)}
.review-comparison figure{min-width:0;margin:0;background:var(--ui-preview-bg)}
.review-comparison figcaption{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-bottom:1px solid var(--ui-line);color:var(--ui-accent-strong);font-size:8px}
.review-comparison figcaption button{height:24px;padding:0 8px;border:1px solid var(--ui-line);background:transparent;color:var(--ui-accent-strong);font-size:8px;cursor:pointer}
.review-comparison figcaption button:disabled{cursor:not-allowed;opacity:.4}
.review-comparison img{display:block;width:100%;height:auto;background:var(--ui-preview-bg)}
.media-placeholder{height:360px;display:grid;place-items:center;background:var(--ui-preview-bg);color:var(--ui-preview-text);font-size:9px}
.media-state{margin:0;padding:9px 11px;border-top:1px solid var(--ui-line);color:var(--ui-accent-strong);font-size:8px}
.media-state.ready{color:var(--ui-ok)}
.media-state.error{border-color:var(--ui-danger);background:color-mix(in srgb, var(--ui-danger) 10%, var(--ui-surface));color:var(--ui-danger)}
.review-note{display:block;padding:11px}
.review-note span{display:block;margin-bottom:6px;color:var(--ui-text-3);font-size:8px}
.review-note textarea{width:100%;box-sizing:border-box;padding:8px;border:1px solid var(--ui-line);background:var(--ui-surface);color:var(--ui-text);font:9px/1.55 inherit;resize:vertical}
.review-actions{display:flex;justify-content:flex-end;gap:8px;padding:0 11px 11px}
.review-actions button{min-width:90px;height:31px;border:1px solid var(--ui-line);background:transparent;font-size:9px;cursor:pointer}
.review-actions .pass{border-color:var(--ui-ok);color:var(--ui-ok)}
.review-actions .rework{border-color:var(--ui-danger);color:var(--ui-danger)}
.review-actions button:disabled{cursor:not-allowed;opacity:.42}
.original-preview{position:fixed;inset:24px;z-index:80;display:grid;grid-template-rows:auto minmax(0,1fr);border:1px solid var(--ui-text-3);background:var(--ui-preview-bg);box-shadow:0 24px 80px rgba(0,0,0,.25)}
.original-preview>header{display:flex;align-items:center;justify-content:space-between;padding:10px 13px;border-bottom:1px solid var(--ui-line);background:var(--ui-bg)}
.original-preview>header strong{font-size:10px}
.original-preview>header button{height:27px;padding:0 10px;border:1px solid var(--ui-accent-strong);background:transparent;color:var(--ui-accent-strong);cursor:pointer}
.original-preview>div{overflow:auto;padding:18px}
.original-preview img{display:block;width:auto;height:auto;max-width:none;max-height:none;margin:auto;background:var(--ui-preview-bg)}
@media(max-width:900px){.review-comparison{grid-template-columns:1fr}
.review-comparison img,.media-placeholder{height:280px}
.original-preview{inset:8px}
}
.review-actions .reject{border-color:var(--ui-danger);background:color-mix(in srgb, var(--ui-danger) 10%, var(--ui-surface));color:var(--ui-danger)}
.technical-diagnostics{margin-top:7px;border:1px solid var(--ui-line);background:var(--ui-surface);color:var(--ui-text-3)}
.technical-diagnostics>summary{padding:7px 9px;font-size:8px;cursor:pointer}
.technical-diagnostics>code{display:block;padding:8px;overflow-wrap:anywhere;color:var(--ui-text-3);font-size:8px}
.next-action-diagnostics{width:100%;text-align:left}
.consistency-banner{margin:8px 0;padding:10px 12px;border:1px solid var(--ui-line);border-radius:10px;background:rgba(215,175,85,.06);display:grid;gap:6px}
.consistency-banner strong{font-size:13px}
.consistency-banner p{margin:0;font-size:12px;color:var(--ui-text-2)}
.consistency-banner ul{margin:0;padding:0;list-style:none;display:grid;gap:4px}
.consistency-banner li{display:flex;gap:8px;align-items:baseline;font-size:12px;flex-wrap:wrap}
.consistency-banner li b{font-weight:600}
.consistency-banner li em{font-style:normal;font-size:10px;color:var(--ui-text-2)}
.consistency-banner li small{color:var(--ui-text-2);flex-basis:100%}
.consistency-ok{color:var(--ui-ok)}
.consistency-warn{color:var(--ui-accent)}
.consistency-danger{color:var(--ui-danger)}
.consistency-muted{color:var(--ui-text-2)}
</style>
<style scoped>
.compare-modes{display:flex;gap:6px;margin-bottom:8px}
.review-decode-loaders{position:absolute;left:-10000px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none}
.review-decode-loaders img{width:1px;height:1px}
.compare-modes button{height:24px;padding:0 10px;border:1px solid var(--ui-line);background:transparent;color:var(--ui-accent-strong);cursor:pointer;font-size:10px}
.compare-modes button.active{background:var(--ui-line);color:var(--ui-accent-strong)}
.annotation-stage{position:relative;width:100%;user-select:none;touch-action:none}
.annotation-stage img{display:block;width:100%;height:auto}
.annotation-overlay{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.ann-rect{fill:rgba(215,184,92,.18);stroke:#d7b85c;stroke-width:.4;vector-effect:non-scaling-stroke}
.ann-rect.stale{fill:rgba(120,120,120,.12);stroke:var(--ui-text-3)}
.ann-rect.draft{fill:rgba(143,196,125,.2);stroke:var(--ui-ok)}
.ann-rect.draft-preview{fill:rgba(143,196,125,.15);stroke:var(--ui-ok);stroke-dasharray:1.5 1}
.ann-point{fill:#d7b85c;stroke:#121313;stroke-width:.3}
.ann-point.stale{fill:var(--ui-text-3)}
.ann-point.draft{fill:var(--ui-ok)}
.review-single{margin-bottom:8px}
.ab-switch{display:flex;gap:6px;margin-bottom:6px}
.ab-switch button{height:22px;padding:0 10px;border:1px solid var(--ui-line);background:transparent;color:var(--ui-accent-strong);cursor:pointer;font-size:10px}
.ab-switch button.active{background:var(--ui-line);color:var(--ui-accent-strong)}
.wipe-stage{position:relative;width:100%;cursor:ew-resize;user-select:none;touch-action:none}
.wipe-base{display:block;width:100%;height:auto}
.wipe-top{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.wipe-divider{position:absolute;top:0;bottom:0;width:2px;background:var(--ui-accent);transform:translateX(-1px)}
.wipe-divider span{position:absolute;top:6px;left:6px;background:var(--ui-line);color:var(--ui-accent);font-size:9px;padding:1px 4px}
.difference-canvas{display:block;width:100%;height:auto;image-rendering:pixelated}
.annotation-tools{border-top:1px solid var(--ui-line);padding-top:8px;margin-top:4px}
.tool-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.tool-row span{font-size:10px;color:var(--ui-accent)}
.tool-row button{height:22px;padding:0 8px;border:1px solid var(--ui-line);background:transparent;color:var(--ui-accent-strong);cursor:pointer;font-size:10px}
.tool-row button.active{background:var(--ui-line);color:var(--ui-accent-strong)}
.tool-row small{color:var(--ui-text-3);font-size:9px}
.draft-annotation{display:grid;grid-template-columns:120px minmax(0,1fr) auto;gap:6px;margin-top:6px}
.draft-annotation select,.draft-annotation input{height:26px;background:var(--ui-surface);border:1px solid var(--ui-line);color:var(--ui-text);font-size:10px;padding:0 6px}
.draft-annotation button{height:26px;border:1px solid var(--ui-danger);background:transparent;color:var(--ui-danger);cursor:pointer;font-size:10px}
.rework-guidance{margin-top:6px;padding:8px 10px;border:1px solid var(--ui-accent-strong);color:var(--ui-accent);font-size:10px}
.history-annotations{display:flex;flex-wrap:wrap;gap:4px;margin:4px 0}
.history-annotations.stale{opacity:.55}
.history-annotation-chip{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--ui-line);padding:1px 6px;font-size:9px;color:var(--ui-text-2)}
.history-annotation-chip button{border:0;background:transparent;color:var(--ui-danger);cursor:pointer;font-size:9px;text-decoration:underline}
.draft-incomplete-hint{margin:6px 0 0;padding:6px 10px;border:1px solid var(--ui-danger);color:var(--ui-danger);font-size:10px}
</style>
