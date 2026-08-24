<template>
  <section
    class="global-resource-center"
    data-testid="global-resource-center-view"
    :aria-busy="loading || Boolean(pendingReuseKey)">
    <header class="resource-center-header">
      <div>
        <span class="eyebrow">总资源中心</span>
        <h2>全部项目图片、音频与视频</h2>
        <p>统一浏览全部受管项目；图片自动归类，资源仍由来源工程的 SQLite / CAS 提供，不建立第二份目录。</p>
      </div>
      <div class="target-project" data-testid="global-resource-target-project">
        <span>调用到</span>
        <b>{{ targetProjectName || "当前项目" }}</b>
      </div>
    </header>

    <div class="resource-policy" role="note">
      <ShieldCheck :size="17" aria-hidden="true" />
      <p>
        <b>使用无限画布导入或生成的图片会自动进入总资源并分类</b>
        <span>分类是可解释的目录投影，不会擅自创建权威资产；已通过的 Primary 可按资产调用，任意图片也可按 SHA 调入当前项目。调用不会覆盖同名资源，音频和视频同样按 SHA 去重。</span>
      </p>
    </div>

    <nav class="resource-tabs" role="tablist" aria-label="总资源分类">
      <button
        v-for="(entry, index) in categories"
        :key="entry.kind"
        :id="`global-resource-tab-${entry.kind}`"
        type="button"
        role="tab"
        aria-controls="global-resource-panel"
        :data-testid="`global-resource-tab-${entry.kind}`"
        :aria-selected="activeCategory === entry.kind"
        :tabindex="activeCategory === entry.kind ? 0 : -1"
        :class="{ active: activeCategory === entry.kind }"
        :disabled="loading || Boolean(pendingReuseKey)"
        @click="selectCategory(entry.kind)"
        @keydown="onTabKeydown($event, index)">
        <component :is="entry.icon" :size="16" aria-hidden="true" />
        <span>{{ entry.label }}</span>
        <small v-if="categoryCount(entry.kind) !== undefined">{{ categoryCount(entry.kind) }}</small>
      </button>
    </nav>

    <div class="resource-toolbar">
      <label class="resource-search">
        <Search :size="16" aria-hidden="true" />
        <span class="sr-only">搜索总资源</span>
        <input
          v-model="searchInput"
          data-testid="global-resource-search"
          type="search"
          autocomplete="off"
          :disabled="Boolean(pendingReuseKey)"
          placeholder="搜索名称、来源项目、文件名或 SHA" />
        <button
          v-if="searchInput"
          type="button"
          aria-label="清空总资源搜索"
          :disabled="Boolean(pendingReuseKey)"
          @click="searchInput = ''">
          <X :size="14" aria-hidden="true" />
        </button>
      </label>
      <span class="result-count">
        {{ categoryLabel(activeCategory) }} · {{ currentTotal }} 项
      </span>
    </div>

    <div
      v-if="pageState"
      class="resource-summary"
      data-testid="global-resource-summary"
      role="status">
      已读取 {{ pageState.page.readableProjectCount }} /
      {{ pageState.page.registeredProjectCount }} 个受管项目。
      <template v-if="pageState.kind === 'image'">
        共 {{ pageState.page.projectImageEntries }} 个项目图片条目，
        {{ pageState.page.uniqueContentSha256 }} 个不同图片内容；
        {{ pageState.page.canonicalImageEntries }} 个已有规范资产关联，
        {{ pageState.page.ordinaryImageEntries }} 个普通图片条目。
      </template>
      <template v-if="pageState.page.unavailableProjects.length">
        {{ pageState.page.unavailableProjects.length }} 个项目暂不可读取，未冒充完整覆盖。
      </template>
    </div>

    <p v-if="errorMessage" class="resource-error" data-testid="global-resource-error" role="alert">
      <CircleAlert :size="16" aria-hidden="true" />
      <span>{{ errorMessage }}</span>
      <button type="button" aria-label="关闭总资源错误" @click="errorMessage = ''">×</button>
    </p>
    <p
      v-if="operationNotice"
      class="resource-notice"
      data-testid="global-resource-operation-notice"
      role="status"
      aria-live="polite">
      {{ operationNotice }}
    </p>

    <main
      id="global-resource-panel"
      class="resource-browser"
      role="tabpanel"
      :aria-labelledby="`global-resource-tab-${activeCategory}`">
      <div v-if="loading && !pageState" class="resource-loading" role="status">
        <LoaderCircle :size="22" class="spinning" aria-hidden="true" />
        <span>正在读取总资源轻量索引…</span>
      </div>

      <div
        v-else-if="pageState && pageState.page.items.length === 0"
        class="resource-empty">
        <component :is="activeCategoryIcon" :size="30" aria-hidden="true" />
        <h3>{{ searchQuery ? "没有匹配结果" : `还没有${categoryLabel(activeCategory)}资源` }}</h3>
        <p>{{ searchQuery ? "换一个名称、来源项目或 SHA 关键词。" : "总资源只展示已经登记进受管项目的真实资源。" }}</p>
      </div>

      <div
        v-else-if="pageState?.kind === 'image'"
        class="resource-viewport"
        data-testid="global-resource-viewport">
        <ul class="resource-grid" :aria-label="`${categoryLabel(activeCategory)}总资源列表`">
          <li
            v-for="item in pageState.page.items"
            :key="imageResourceKey(item)"
            class="resource-card asset-resource-card"
            data-testid="global-resource-item"
            :data-resource-key="imageResourceKey(item)">
            <figure>
              <img
                :src="imageThumbnailUrl(item)"
                :alt="`${item.displayName}缩略图`"
                loading="lazy"
                decoding="async" />
            </figure>
            <article>
              <div class="card-heading">
                <div>
                  <span class="resource-kind">
                    {{ categoryLabel(item.classification.primaryCategory) }}
                    · {{ resourceRoleLabel(item.classification.resourceRole) }}
                  </span>
                  <h3>{{ item.displayName }}</h3>
                </div>
                <code>{{ shortSha(item.mediaSha256) }}</code>
              </div>
              <p class="source-project" data-testid="global-resource-source-project">
                来源项目：{{ item.sourceProject.name }}
              </p>
              <p class="resource-meta">
                {{ item.sourceNames.slice(0, 2).join(" / ") }}
                <template v-if="item.sourceNames.length > 2"> 等 {{ item.sourceNames.length }} 个名称</template>
                · {{ formatBytes(item.sizeBytes) }}
              </p>
              <div class="classification-row" data-testid="global-resource-classification">
                <span>{{ classificationStateLabel(item.classification.classificationState) }}</span>
                <span>{{ Math.round(item.classification.confidence * 100) }}%</span>
                <span
                  v-for="tag in item.classification.contentTags"
                  :key="`${imageResourceKey(item)}:${tag}`">
                  {{ categoryLabel(tag) }}
                </span>
              </div>
              <div class="media-reuse-row image-reuse-row">
                <button
                  type="button"
                  data-testid="global-resource-use-image-in-project"
                  :disabled="
                    Boolean(pendingReuseKey)
                    || isCurrentProjectResource(item.sourceProject.primaryRoot)
                    || reuseCompleted(imageResourceKey(item))
                  "
                  @click="reuseImage(item)">
                  {{ reuseButtonLabel(imageResourceKey(item), item.sourceProject.primaryRoot) }}
                </button>
                <small
                  v-if="isCurrentProjectResource(item.sourceProject.primaryRoot)"
                  class="target-state"
                  data-testid="global-resource-target-state">
                  已在当前项目，无需调用
                </small>
                <small
                  v-else-if="reuseDispositionByKey[imageResourceKey(item)]"
                  class="target-state"
                  data-testid="global-resource-target-state">
                  {{ reuseStateLabel(reuseDispositionByKey[imageResourceKey(item)]!) }}
                </small>
              </div>

              <ul v-if="item.associations.length" class="association-list">
                <li
                  v-for="association in item.associations"
                  :key="associationReuseKey(item, association)"
                  data-testid="global-resource-association">
                  <div>
                    <b>{{ association.name }}</b>
                    <span>
                      v{{ association.versionOrdinal }} ·
                      {{ reviewLabel(association.reviewStatus) }} ·
                      {{ association.isPrimary ? "Primary" : "非 Primary" }}
                    </span>
                  </div>
                  <button
                    v-if="canReuseAssociation(association)"
                    type="button"
                    data-testid="global-resource-use-in-project"
                    :disabled="
                      Boolean(pendingReuseKey)
                      || isCurrentProjectResource(item.sourceProject.primaryRoot)
                      || reuseCompleted(associationReuseKey(item, association))
                    "
                    @click="reuseAsset(item, association)">
                    {{
                      reuseButtonLabel(
                        associationReuseKey(item, association),
                        item.sourceProject.primaryRoot,
                      )
                    }}
                  </button>
                  <small v-else class="reuse-unavailable">仅已通过的 Primary 可调用</small>
                  <small
                    v-if="isCurrentProjectResource(item.sourceProject.primaryRoot)"
                    class="target-state"
                    data-testid="global-resource-target-state">
                    已在当前项目，无需调用
                  </small>
                  <small
                    v-else-if="reuseDispositionByKey[associationReuseKey(item, association)]"
                    class="target-state"
                    data-testid="global-resource-target-state">
                    {{ reuseStateLabel(reuseDispositionByKey[associationReuseKey(item, association)]!) }}
                  </small>
                </li>
              </ul>
            </article>
          </li>
        </ul>
      </div>

      <div
        v-else-if="pageState?.kind === 'media'"
        class="resource-viewport"
        data-testid="global-resource-viewport">
        <ul class="resource-grid" :aria-label="`${categoryLabel(activeCategory)}总资源列表`">
          <li
            v-for="item in pageState.page.items"
            :key="mediaResourceKey(item)"
            class="resource-card media-resource-card"
            data-testid="global-resource-item"
            :data-resource-key="mediaResourceKey(item)">
            <figure>
              <img
                v-if="mediaPreviewUrl(item)"
                :src="mediaPreviewUrl(item)"
                :alt="`${item.sourceBasename}${item.kind === 'audio' ? '波形' : '封面'}`"
                loading="lazy"
                decoding="async" />
              <span v-else>{{ item.kind === "audio" ? "音" : "视" }}</span>
            </figure>
            <article>
              <div class="card-heading">
                <div>
                  <span class="resource-kind">{{ categoryLabel(item.kind) }}</span>
                  <h3>{{ item.sourceBasename }}</h3>
                </div>
                <code>{{ shortSha(item.mediaSha256) }}</code>
              </div>
              <p class="source-project" data-testid="global-resource-source-project">
                来源项目：{{ item.sourceProject.name }}
              </p>
              <p class="resource-meta">
                {{ item.mimeType }} · {{ formatBytes(item.sizeBytes) }}
                <template v-if="item.preview"> · 已有{{ item.kind === "audio" ? "波形" : "封面" }}</template>
                <template v-if="item.playback"> · 已有轻量视频代理</template>
              </p>
              <div class="media-reuse-row">
                <button
                  type="button"
                  data-testid="global-resource-use-in-project"
                  :disabled="
                    Boolean(pendingReuseKey)
                    || isCurrentProjectResource(item.sourceProject.primaryRoot)
                    || reuseCompleted(mediaResourceKey(item))
                  "
                  @click="reuseMedia(item)">
                  {{ reuseButtonLabel(mediaResourceKey(item), item.sourceProject.primaryRoot) }}
                </button>
                <small
                  v-if="isCurrentProjectResource(item.sourceProject.primaryRoot)"
                  class="target-state"
                  data-testid="global-resource-target-state">
                  已在当前项目，无需调用
                </small>
                <small
                  v-else-if="reuseDispositionByKey[mediaResourceKey(item)]"
                  class="target-state"
                  data-testid="global-resource-target-state">
                  {{ reuseStateLabel(reuseDispositionByKey[mediaResourceKey(item)]!) }}
                </small>
              </div>
            </article>
          </li>
        </ul>
      </div>

      <div v-if="pageState?.page.items.length" class="resource-pager">
        <button
          type="button"
          data-testid="global-resource-prev"
          :disabled="!cursorStack.length || loading || Boolean(pendingReuseKey)"
          @click="loadPreviousPage">
          上一页
        </button>
        <span data-testid="global-resource-page-indicator">
          第 {{ cursorStack.length + 1 }} 页 · 本页 {{ pageState.page.items.length }} /
          共 {{ pageState.page.total }} 项
        </span>
        <button
          type="button"
          data-testid="global-resource-next"
          :disabled="!pageState.page.nextCursor || loading || Boolean(pendingReuseKey)"
          @click="loadNextPage">
          {{ loading ? "读取中…" : "下一页" }}
        </button>
      </div>
    </main>
  </section>
</template>

<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  ref,
  shallowRef,
  watch,
  type Component,
} from "vue";
import {
  CircleAlert,
  CircleHelp,
  Film,
  Headphones,
  Image as ImageIcon,
  LoaderCircle,
  Mountain,
  Package,
  Palette,
  Search,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-vue-next";
import type {
  GlobalStudioAssetResourceAssociation,
  GlobalStudioMediaResourceItem,
  GlobalStudioMediaResourcePage,
  GlobalStudioMediaResourceQuery,
} from "@core/studio-global-asset-catalog";
import type {
  GlobalStudioImageResourceItem,
  GlobalStudioImageResourcePage,
  GlobalStudioImageResourceQuery,
} from "@core/studio-global-image-resource-catalog";
import type {
  StudioGlobalImageClassificationState,
  StudioGlobalImageResourceRole,
} from "@core/studio-global-image-classification";
import type {
  ReuseStudioGlobalResourceInput,
  ReuseStudioGlobalResourceResult,
} from "@core/studio-global-resource-reuse";
import { moveGlobalResourceTabIndex } from "../global-resource-tabs";

export type GlobalResourceCenterCategory =
  | "all"
  | "character"
  | "scene"
  | "prop"
  | "style"
  | "storyboard"
  | "reference"
  | "other"
  | "audio"
  | "video";

export interface GlobalResourceCenterApi {
  listGlobalResourceImages?(
    query: GlobalStudioImageResourceQuery,
  ): Promise<GlobalStudioImageResourcePage>;
  listGlobalMediaResources?(
    query: GlobalStudioMediaResourceQuery,
  ): Promise<GlobalStudioMediaResourcePage>;
  reuseGlobalResource?(
    targetProjectRoot: string,
    input: ReuseStudioGlobalResourceInput,
  ): Promise<ReuseStudioGlobalResourceResult>;
}

const props = defineProps<{
  targetProjectRoot: string;
  targetProjectName?: string;
  api: GlobalResourceCenterApi;
}>();

const emit = defineEmits<{
  failed: [message: string];
  reused: [message: string];
}>();

const RESOURCE_PAGE_LIMIT = 36;
const categories: ReadonlyArray<{
  kind: GlobalResourceCenterCategory;
  label: string;
  icon: Component;
}> = [
  { kind: "all", label: "全部图片", icon: ImageIcon },
  { kind: "character", label: "人物", icon: UserRound },
  { kind: "scene", label: "场景", icon: Mountain },
  { kind: "prop", label: "道具", icon: Package },
  { kind: "style", label: "风格", icon: Palette },
  { kind: "storyboard", label: "分镜/宫格", icon: Film },
  { kind: "reference", label: "参考图", icon: ShieldCheck },
  { kind: "other", label: "其他/待复核", icon: CircleHelp },
  { kind: "audio", label: "音频", icon: Headphones },
  { kind: "video", label: "视频", icon: Film },
];

type ImagePageState = {
  kind: "image";
  page: GlobalStudioImageResourcePage;
};
type MediaPageState = {
  kind: "media";
  page: GlobalStudioMediaResourcePage;
};
type ResourcePageState = ImagePageState | MediaPageState;
type ReuseDisposition = ReuseStudioGlobalResourceResult["disposition"];

const activeCategory = ref<GlobalResourceCenterCategory>("all");
const searchInput = ref("");
const searchQuery = ref("");
const pageState = shallowRef<ResourcePageState | null>(null);
const imageCounts = shallowRef<GlobalStudioImageResourcePage["counts"] | null>(null);
const mediaCounts = shallowRef<GlobalStudioMediaResourcePage["counts"] | null>(null);
const currentCursor = ref<string | undefined>();
const cursorStack = ref<string[]>([]);
const loading = ref(false);
const errorMessage = ref("");
const operationNotice = ref("");
const pendingReuseKey = ref("");
const reuseDispositionByKey = shallowRef<Record<string, ReuseDisposition>>({});

let disposed = false;
let listRequestSequence = 0;
let pendingListFingerprint = "";
let reuseRequestSequence = 0;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

const activeCategoryIcon = computed(
  () => categories.find((entry) => entry.kind === activeCategory.value)?.icon ?? Package,
);
const currentTotal = computed(() => pageState.value?.page.total ?? 0);

watch(
  [() => props.targetProjectRoot, () => props.api],
  () => {
    resetForTargetProject();
    void loadFirstPage();
  },
  { immediate: true },
);

watch(searchInput, (value) => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const next = value.normalize("NFKC").trim();
    if (next === searchQuery.value) return;
    searchQuery.value = next;
    void loadFirstPage();
  }, 260);
});

onBeforeUnmount(() => {
  disposed = true;
  listRequestSequence += 1;
  reuseRequestSequence += 1;
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = undefined;
});

function isAssetCategory(
  category: GlobalResourceCenterCategory,
): category is GlobalStudioImageResourceQuery["category"] {
  return category === "all"
    || category === "character"
    || category === "scene"
    || category === "prop"
    || category === "style"
    || category === "storyboard"
    || category === "reference"
    || category === "other";
}

function resetForTargetProject(): void {
  listRequestSequence += 1;
  reuseRequestSequence += 1;
  pendingListFingerprint = "";
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = undefined;
  activeCategory.value = "all";
  searchInput.value = "";
  searchQuery.value = "";
  pageState.value = null;
  imageCounts.value = null;
  mediaCounts.value = null;
  currentCursor.value = undefined;
  cursorStack.value = [];
  loading.value = false;
  pendingReuseKey.value = "";
  reuseDispositionByKey.value = {};
  errorMessage.value = "";
  operationNotice.value = "";
}

function requestFingerprint(input: {
  targetProjectRoot: string;
  category: GlobalResourceCenterCategory;
  search: string;
  cursor?: string;
  limit: number;
}): string {
  return JSON.stringify([
    input.targetProjectRoot,
    input.category,
    input.search,
    input.cursor ?? "",
    input.limit,
  ]);
}

async function loadPage(cursor?: string): Promise<boolean> {
  const targetProjectRoot = props.targetProjectRoot;
  const category = activeCategory.value;
  const search = searchQuery.value;
  const fingerprint = requestFingerprint({
    targetProjectRoot,
    category,
    search,
    cursor,
    limit: RESOURCE_PAGE_LIMIT,
  });
  const request = ++listRequestSequence;
  pendingListFingerprint = fingerprint;
  loading.value = true;
  errorMessage.value = "";
  const isCurrent = (): boolean => (
    !disposed
    && request === listRequestSequence
    && pendingListFingerprint === fingerprint
    && targetProjectRoot === props.targetProjectRoot
    && category === activeCategory.value
    && search === searchQuery.value
  );
  try {
    if (isAssetCategory(category)) {
      if (!props.api.listGlobalResourceImages) {
        throw new Error("当前桌面适配层未接入人物、场景和道具总资源。");
      }
      const page = await props.api.listGlobalResourceImages({
        category,
        ...(search ? { search } : {}),
        ...(cursor ? { cursor } : {}),
        limit: RESOURCE_PAGE_LIMIT,
      });
      if (!isCurrent()) return false;
      const boundedPage: GlobalStudioImageResourcePage = {
        ...page,
        items: page.items.slice(0, RESOURCE_PAGE_LIMIT),
      };
      pageState.value = { kind: "image", page: boundedPage };
      imageCounts.value = boundedPage.counts;
    } else {
      if (!props.api.listGlobalMediaResources) {
        throw new Error("当前桌面适配层未接入音频和视频总资源。");
      }
      const page = await props.api.listGlobalMediaResources({
        kind: category,
        ...(search ? { search } : {}),
        ...(cursor ? { cursor } : {}),
        limit: RESOURCE_PAGE_LIMIT,
      });
      if (!isCurrent()) return false;
      const boundedPage: GlobalStudioMediaResourcePage = {
        ...page,
        items: page.items.slice(0, RESOURCE_PAGE_LIMIT),
      };
      pageState.value = { kind: "media", page: boundedPage };
      mediaCounts.value = boundedPage.counts;
    }
    currentCursor.value = cursor;
    return true;
  } catch (reason) {
    if (!isCurrent()) return false;
    const detail = message(reason);
    errorMessage.value = detail.includes("cursor") || detail.includes("游标")
      ? `总资源目录已经变化，请从第一页重新读取。${detail}`
      : detail;
    emit("failed", errorMessage.value);
    return false;
  } finally {
    if (isCurrent()) loading.value = false;
  }
}

async function loadFirstPage(): Promise<void> {
  listRequestSequence += 1;
  pendingListFingerprint = "";
  currentCursor.value = undefined;
  cursorStack.value = [];
  pageState.value = null;
  operationNotice.value = "";
  await loadPage();
}

async function loadNextPage(): Promise<void> {
  if (loading.value || pendingReuseKey.value) return;
  const next = pageState.value?.page.nextCursor;
  if (!next) return;
  const previousCursor = currentCursor.value ?? "";
  if (await loadPage(next)) cursorStack.value = [...cursorStack.value, previousCursor];
}

async function loadPreviousPage(): Promise<void> {
  if (loading.value || pendingReuseKey.value) return;
  const previous = cursorStack.value.at(-1);
  if (previous === undefined) return;
  if (await loadPage(previous || undefined)) {
    cursorStack.value = cursorStack.value.slice(0, -1);
  }
}

function onTabKeydown(event: KeyboardEvent, index: number): void {
  const next = moveGlobalResourceTabIndex(index, categories.length, event.key);
  if (next === null) return;
  event.preventDefault();
  selectCategory(categories[next]!.kind);
  document.getElementById(`global-resource-tab-${categories[next]!.kind}`)?.focus();
}

function selectCategory(category: GlobalResourceCenterCategory): void {
  if (category === activeCategory.value || loading.value || pendingReuseKey.value) return;
  activeCategory.value = category;
  void loadFirstPage();
}

function categoryCount(category: GlobalResourceCenterCategory): number | undefined {
  if (isAssetCategory(category)) {
    return category === "all" ? imageCounts.value?.total : imageCounts.value?.[category];
  }
  return mediaCounts.value?.[category];
}

function categoryLabel(category: GlobalResourceCenterCategory): string {
  return categories.find((entry) => entry.kind === category)?.label ?? category;
}

function imageResourceKey(item: GlobalStudioImageResourceItem): string {
  return `image:${item.sourceProject.id}:${item.mediaSha256}`;
}

function associationReuseKey(
  item: GlobalStudioImageResourceItem,
  association: GlobalStudioAssetResourceAssociation,
): string {
  return `asset:${item.sourceProject.id}:${association.assetId}:${association.versionId}`;
}

function mediaResourceKey(item: GlobalStudioMediaResourceItem): string {
  return `${item.kind}:${item.sourceProject.id}:${item.mediaSha256}`;
}

function isCurrentProjectResource(sourceProjectRoot: string): boolean {
  return sourceProjectRoot === props.targetProjectRoot;
}

function imageThumbnailUrl(item: GlobalStudioImageResourceItem): string {
  return `aicanvas-studio://thumbnail/${item.thumbnailRecipeKey}?projectRoot=${encodeURIComponent(item.sourceProject.primaryRoot)}`;
}

function mediaPreviewUrl(item: GlobalStudioMediaResourceItem): string | undefined {
  if (!item.preview?.recipeKey) return undefined;
  return `aicanvas-studio://derivative/${item.preview.recipeKey}?projectRoot=${encodeURIComponent(item.sourceProject.primaryRoot)}`;
}

function canReuseAssociation(association: GlobalStudioAssetResourceAssociation): boolean {
  return association.reviewStatus === "approved" && association.isPrimary;
}

function reuseCompleted(key: string): boolean {
  return Boolean(reuseDispositionByKey.value[key]);
}

function reuseButtonLabel(key: string, sourceProjectRoot: string): string {
  if (isCurrentProjectResource(sourceProjectRoot)) return "当前项目资源";
  if (pendingReuseKey.value === key) return "调用中…";
  const disposition = reuseDispositionByKey.value[key];
  if (disposition === "imported-pending") return "已调用，待审核";
  if (disposition === "already-imported" || disposition === "already-present") return "当前项目已有";
  if (disposition === "imported") return "已调用";
  return "调用到当前项目";
}

function reuseStateLabel(disposition: ReuseDisposition): string {
  if (disposition === "imported-pending") return "已作为 pending 候选导入";
  if (disposition === "already-imported") return "当前项目已有该资产版本";
  if (disposition === "imported") return "已进入当前项目 CAS";
  return "当前项目已有同一媒体";
}

async function reuseAsset(
  item: GlobalStudioImageResourceItem,
  association: GlobalStudioAssetResourceAssociation,
): Promise<void> {
  if (isCurrentProjectResource(item.sourceProject.primaryRoot)) return;
  if (!canReuseAssociation(association)) return;
  await runReuse(
    associationReuseKey(item, association),
    association.name,
    {
      resourceKind: "asset",
      sourceProjectRoot: item.sourceProject.primaryRoot,
      expectedSourceProjectId: item.sourceProject.id,
      sourceAssetId: association.assetId,
      sourceVersionId: association.versionId,
      expectedSourceAssetRevision: association.assetRevision,
      targetExpectedRevision: 0,
    },
  );
}

async function reuseImage(item: GlobalStudioImageResourceItem): Promise<void> {
  if (isCurrentProjectResource(item.sourceProject.primaryRoot)) return;
  await runReuse(
    imageResourceKey(item),
    item.displayName,
    {
      resourceKind: "image",
      sourceProjectRoot: item.sourceProject.primaryRoot,
      expectedSourceProjectId: item.sourceProject.id,
      sourceMediaSha256: item.mediaSha256,
      expectedSourceMediaSizeBytes: item.sizeBytes,
      targetExpectedRevision: 0,
    },
  );
}

async function reuseMedia(item: GlobalStudioMediaResourceItem): Promise<void> {
  if (isCurrentProjectResource(item.sourceProject.primaryRoot)) return;
  await runReuse(
    mediaResourceKey(item),
    item.sourceBasename,
    {
      resourceKind: item.kind,
      sourceProjectRoot: item.sourceProject.primaryRoot,
      expectedSourceProjectId: item.sourceProject.id,
      sourceMediaSha256: item.mediaSha256,
      expectedSourceMediaSizeBytes: item.sizeBytes,
      targetExpectedRevision: 0,
    },
  );
}

async function runReuse(
  key: string,
  label: string,
  input: ReuseStudioGlobalResourceInput,
): Promise<void> {
  if (!props.api.reuseGlobalResource || pendingReuseKey.value || reuseCompleted(key)) return;
  const targetProjectRoot = props.targetProjectRoot;
  const request = ++reuseRequestSequence;
  pendingReuseKey.value = key;
  errorMessage.value = "";
  operationNotice.value = "";
  const isCurrent = (): boolean => (
    !disposed
    && request === reuseRequestSequence
    && targetProjectRoot === props.targetProjectRoot
  );
  try {
    const result = await props.api.reuseGlobalResource(targetProjectRoot, input);
    if (!isCurrent()) return;
    reuseDispositionByKey.value = {
      ...reuseDispositionByKey.value,
      [key]: result.disposition,
    };
    if (result.disposition === "imported-pending") {
      operationNotice.value = `已将“${label}”调用到当前项目，并作为 pending 候选等待当前项目独立审核；不会覆盖同名资源。`;
    } else if (result.disposition === "already-imported") {
      operationNotice.value = `当前项目已有“${label}”的同一来源版本，未重复导入。`;
    } else if (result.disposition === "imported") {
      operationNotice.value = `已将“${label}”调用到当前项目 CAS；未自动播放、挂接时间线或加入画布。`;
    } else {
      operationNotice.value = `当前项目已有与“${label}”相同 SHA 的媒体，未重复复制。`;
    }
    emit("reused", operationNotice.value);
  } catch (reason) {
    if (!isCurrent()) return;
    errorMessage.value = message(reason);
    emit("failed", errorMessage.value);
  } finally {
    if (isCurrent()) pendingReuseKey.value = "";
  }
}

function reviewLabel(status: GlobalStudioAssetResourceAssociation["reviewStatus"]): string {
  return status === "approved" ? "已通过" : status === "rejected" ? "已拒绝" : "待审核";
}

function resourceRoleLabel(role: StudioGlobalImageResourceRole): string {
  return ({
    "asset-reference": "资产参考",
    raw: "原图 raw",
    labeled: "标注图 labeled",
    "source-original": "源图",
    "storyboard-grid": "故事板/宫格",
    "shot-frame": "镜头帧",
    "poster-cover": "海报/封面",
    reference: "参考图",
    other: "普通图片",
  } satisfies Record<StudioGlobalImageResourceRole, string>)[role];
}

function classificationStateLabel(state: StudioGlobalImageClassificationState): string {
  return ({
    canonical: "规范资产关联",
    "metadata-high": "自动分类",
    "metadata-ambiguous": "分类有歧义",
    "visual-pending": "待视觉复核",
    manual: "人工分类",
  } satisfies Record<StudioGlobalImageClassificationState, string>)[state];
}

function shortSha(value: string): string {
  return value.slice(0, 12);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MiB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
</script>

<style scoped>
.global-resource-center {
  --grc-border: color-mix(in srgb, var(--ui-border, #887658) 58%, transparent);
  --grc-surface: var(--ui-surface, #191815);
  --grc-surface-2: var(--ui-surface-2, #23211d);
  --grc-text: var(--ui-text, #f2eadb);
  --grc-text-2: var(--ui-text-2, #c8bdad);
  --grc-text-3: var(--ui-text-3, #8f877a);
  --grc-accent: var(--ui-accent, #c99842);
  min-height: 0;
  height: 100%;
  overflow: auto;
  color: var(--grc-text);
  background:
    radial-gradient(circle at 85% 0%, color-mix(in srgb, var(--grc-accent) 10%, transparent), transparent 30%),
    var(--grc-surface);
}

.resource-center-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  padding: 22px 28px 18px;
  border-bottom: 1px solid var(--grc-border);
}

.resource-center-header h2 { margin: 4px 0 6px; font-size: 22px; }
.resource-center-header p { margin: 0; color: var(--grc-text-2); font-size: 12px; line-height: 1.6; }
.eyebrow { color: var(--grc-accent); font-size: 10px; letter-spacing: .12em; text-transform: uppercase; }

.target-project {
  min-width: 220px;
  padding: 10px 12px;
  border: 1px solid var(--grc-border);
  background: var(--grc-surface-2);
}
.target-project span,
.target-project b { display: block; }
.target-project span { color: var(--grc-text-3); font-size: 9px; }
.target-project b { margin-top: 4px; overflow-wrap: anywhere; font-size: 12px; }

.resource-policy,
.resource-summary,
.resource-error,
.resource-notice {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  margin: 0;
  padding: 10px 28px;
  border-bottom: 1px solid var(--grc-border);
  font-size: 10px;
  line-height: 1.55;
}
.resource-policy { color: var(--grc-accent); background: color-mix(in srgb, var(--grc-accent) 8%, transparent); }
.resource-policy p { margin: 0; }
.resource-policy b,
.resource-policy span { display: block; }
.resource-policy span { margin-top: 2px; color: var(--grc-text-2); }
.resource-summary { color: var(--grc-text-2); }
.resource-error { color: #e69b8f; background: rgb(110 35 31 / 18%); }
.resource-error span { flex: 1; }
.resource-error button { border: 0; color: inherit; background: transparent; cursor: pointer; }
.resource-notice { color: #9fd6a8; background: rgb(37 105 54 / 16%); }

.resource-tabs {
  display: grid;
  grid-template-columns: repeat(5, minmax(100px, 1fr));
  gap: 1px;
  padding: 14px 28px 0;
}
.resource-tabs button {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 7px;
  min-height: 38px;
  padding: 8px 10px;
  border: 1px solid var(--grc-border);
  color: var(--grc-text-2);
  background: var(--grc-surface-2);
  cursor: pointer;
}
.resource-tabs button.active {
  border-color: var(--grc-accent);
  color: var(--grc-text);
  background: color-mix(in srgb, var(--grc-accent) 13%, var(--grc-surface-2));
}
.resource-tabs button:disabled { cursor: wait; opacity: .6; }
.resource-tabs small { color: var(--grc-text-3); font-size: 9px; }

.resource-toolbar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 28px;
}
.resource-search {
  display: flex;
  align-items: center;
  flex: 1;
  gap: 8px;
  min-width: 0;
  padding: 0 10px;
  border: 1px solid var(--grc-border);
  background: var(--grc-surface-2);
}
.resource-search input {
  flex: 1;
  min-width: 0;
  height: 36px;
  border: 0;
  outline: 0;
  color: var(--grc-text);
  background: transparent;
}
.resource-search button {
  border: 0;
  color: var(--grc-text-3);
  background: transparent;
  cursor: pointer;
}
.result-count { color: var(--grc-text-3); font-size: 10px; white-space: nowrap; }

.resource-browser { padding: 0 28px 24px; }
.resource-loading,
.resource-empty {
  display: grid;
  place-items: center;
  gap: 8px;
  min-height: 280px;
  color: var(--grc-text-3);
  text-align: center;
}
.resource-empty h3,
.resource-empty p { margin: 0; }
.resource-empty h3 { color: var(--grc-text); font-size: 15px; }
.resource-empty p { font-size: 11px; }

.resource-viewport { min-height: 0; }
.resource-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.resource-card {
  display: grid;
  grid-template-columns: 104px minmax(0, 1fr);
  min-height: 152px;
  overflow: hidden;
  border: 1px solid var(--grc-border);
  background: var(--grc-surface-2);
  content-visibility: auto;
  contain-intrinsic-size: auto 152px;
}
.resource-card > figure {
  display: grid;
  place-items: center;
  min-height: 152px;
  margin: 0;
  overflow: hidden;
  color: var(--grc-accent);
  font-size: 30px;
  background: #111;
}
.resource-card > figure img { width: 100%; height: 100%; object-fit: cover; }
.resource-card > article { min-width: 0; padding: 11px; }
.card-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.card-heading > div { min-width: 0; }
.card-heading h3 {
  margin: 3px 0 0;
  overflow: hidden;
  font-size: 12px;
  line-height: 1.4;
  text-overflow: ellipsis;
}
.card-heading code { color: var(--grc-text-3); font-size: 8px; }
.resource-kind { color: var(--grc-accent); font-size: 8px; }
.source-project,
.resource-meta { margin: 6px 0 0; color: var(--grc-text-3); font-size: 9px; line-height: 1.45; }
.classification-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 7px;
}
.classification-row span {
  padding: 2px 5px;
  border: 1px solid var(--grc-border);
  color: var(--grc-text-2);
  font-size: 8px;
  background: color-mix(in srgb, var(--grc-accent) 6%, transparent);
}

.association-list {
  display: grid;
  gap: 7px;
  margin: 9px 0 0;
  padding: 0;
  list-style: none;
}
.association-list > li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 5px 8px;
  padding-top: 7px;
  border-top: 1px solid var(--grc-border);
}
.association-list b,
.association-list span { display: block; }
.association-list b { overflow-wrap: anywhere; font-size: 10px; }
.association-list span { margin-top: 2px; color: var(--grc-text-3); font-size: 8px; }
.association-list button,
.media-reuse-row button {
  min-height: 28px;
  padding: 5px 8px;
  border: 1px solid var(--grc-accent);
  color: var(--grc-text);
  background: color-mix(in srgb, var(--grc-accent) 16%, transparent);
  font-size: 9px;
  cursor: pointer;
}
.association-list button:disabled,
.media-reuse-row button:disabled { cursor: default; opacity: .58; }
.reuse-unavailable { color: var(--grc-text-3); font-size: 8px; text-align: right; }
.target-state { grid-column: 1 / -1; color: #9fd6a8; font-size: 8px; }

.media-reuse-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 14px; }
.media-reuse-row .target-state { flex: 1; }
.image-reuse-row { margin-top: 9px; }

.resource-pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  margin-top: 16px;
}
.resource-pager button {
  min-width: 80px;
  min-height: 30px;
  border: 1px solid var(--grc-border);
  color: var(--grc-text);
  background: var(--grc-surface-2);
  cursor: pointer;
}
.resource-pager button:disabled { cursor: default; opacity: .45; }
.resource-pager span { color: var(--grc-text-3); font-size: 9px; }

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
.spinning { animation: resource-spin .8s linear infinite; }
@keyframes resource-spin { to { transform: rotate(360deg); } }

@media (max-width: 1180px) {
  .resource-tabs { grid-template-columns: repeat(3, minmax(90px, 1fr)); }
}
@media (max-width: 760px) {
  .resource-center-header { display: grid; }
  .target-project { min-width: 0; }
  .resource-tabs { grid-template-columns: repeat(2, minmax(90px, 1fr)); }
  .resource-card { grid-template-columns: 86px minmax(0, 1fr); }
}
</style>
