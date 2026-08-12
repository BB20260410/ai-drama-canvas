<template>
  <section class="canonical-library" data-testid="canonical-asset-library">
    <header class="library-header">
      <div>
        <span class="eyebrow">规范资产知识库 · P5</span>
        <h2>角色、场景与道具唯一权威视图</h2>
        <p>媒体仍以本地文件和 SHA 为事实源；列表只读取内容寻址索引，不扫描其他项目。</p>
      </div>
      <button type="button" :disabled="loading" @click="refresh">
        <RefreshCw :size="15" :class="{ spinning: loading }" />刷新
      </button>
    </header>

    <div v-if="state?.available" class="catalog-strip" :class="{ stale: !state.current }">
      <div><span>全部资产</span><b>{{ state.counts?.assets ?? 0 }}</b></div>
      <div><span>角色</span><b>{{ state.counts?.byCategory.character ?? 0 }}</b></div>
      <div><span>场景</span><b>{{ state.counts?.byCategory.scene ?? 0 }}</b></div>
      <div><span>道具</span><b>{{ state.counts?.byCategory.prop ?? 0 }}</b></div>
      <div><span>已有版本</span><b>{{ state.counts?.assetsWithVersions ?? 0 }}</b></div>
      <div><span>待生成</span><b>{{ state.counts?.assetsWithoutVersions ?? 0 }}</b></div>
      <div><span>Store Revision</span><b>r{{ state.storeRevision ?? 0 }}</b></div>
      <p v-if="!state.current"><ShieldAlert :size="14" /> 输入已漂移：{{ state.driftedInputs.join("、") }}。在重新迁移前禁止把旧索引用于生产。</p>
    </div>

    <section v-if="state && !state.available" class="migration-empty">
      <ShieldAlert :size="28" />
      <h3>规范资产库尚未物化</h3>
      <p>此界面不会从路径或标题猜测资产类别，也不会直接修改旧硬锁。</p>
      <template v-if="migrationPreview">
        <div class="preview-counts" v-if="migrationPreview.counts">
          <span>{{ migrationPreview.counts.assets }} 项资产</span>
          <span>{{ migrationPreview.counts.versions }} 个版本</span>
          <span>{{ migrationPreview.counts.authorities }} 项权威</span>
        </div>
        <ul v-if="migrationPreview.blockers.length">
          <li v-for="blocker in migrationPreview.blockers" :key="blocker">{{ blocker }}</li>
        </ul>
        <small v-else-if="migrationPreview.canMigrate">迁移预检已通过；正式写入必须走命令总线 CAS。</small>
      </template>
    </section>

    <section v-else-if="state?.available && !state.current" class="migration-empty">
      <ShieldAlert :size="28" />
      <h3>规范资产库输入已漂移</h3>
      <p>旧列表、详情和缩略图已清空；重新完成内容寻址迁移前不会显示或返回旧权威媒体。</p>
    </section>

    <template v-else-if="state?.available && state.current">
      <div class="library-toolbar">
        <label><Search :size="15" /><input v-model="search" placeholder="按正式 ID、名称或确认别名搜索" /></label>
        <div class="category-tabs">
          <button v-for="entry in categories" :key="entry.id" type="button" :class="{ active: category === entry.id }" @click="category = entry.id">{{ entry.label }}</button>
        </div>
        <select v-model="authority">
          <option value="any">全部权威状态</option>
          <option value="with-authority">已有权威</option>
          <option value="without-authority">尚无权威</option>
        </select>
        <span>{{ page?.total ?? 0 }} 项</span>
      </div>

      <div class="library-body">
        <section class="asset-browser" aria-label="规范资产列表">
          <button
            v-for="item in page?.items ?? []"
            :key="item.id"
            type="button"
            class="canonical-card"
            :class="{ selected: selectedId === item.id }"
            :data-asset-id="item.id"
            @click="selectAsset(item.id)">
            <figure>
              <img v-if="item.thumbnail" loading="lazy" decoding="async" :src="assetUrl(item.thumbnail.path, item.thumbnail.sha256)" :alt="`${item.id} ${item.canonicalName}`" />
              <span v-else><ImageIcon :size="22" />尚无权威图片</span>
            </figure>
            <div class="card-copy">
              <span>{{ categoryLabel(item.category) }} · {{ item.id }}</span>
              <b>{{ item.canonicalName }}</b>
              <small>{{ item.versionCount }} 个版本 · {{ item.authorityCount }} 项权威</small>
              <em v-if="item.hasPrimaryAuthority"><LockKeyhole :size="11" /> 主权威已冻结</em>
              <em v-else>等待权威版本</em>
              <i v-if="item.hasSupportingAuthority">含不可直接生成的辅助身份参考</i>
            </div>
          </button>
          <div v-if="!loading && !(page?.items.length)" class="list-empty">当前筛选没有规范资产。</div>
          <footer class="pager">
            <button type="button" :disabled="offset === 0 || loading" @click="changePage(-1)"><ChevronLeft :size="14" />上一页</button>
            <span>{{ pageStart }}–{{ pageEnd }} / {{ page?.total ?? 0 }}</span>
            <button type="button" :disabled="!hasNext || loading" @click="changePage(1)">下一页<ChevronRight :size="14" /></button>
          </footer>
        </section>

        <aside class="asset-detail" aria-label="规范资产详情">
          <div v-if="detailLoading" class="detail-empty">读取内容寻址详情…</div>
          <template v-else-if="detail">
            <header>
              <span>{{ categoryLabel(detail.asset.category) }} · {{ detail.asset.id }}</span>
              <h3>{{ detail.asset.canonicalName }}</h3>
              <code>{{ detail.asset.fingerprint }}</code>
            </header>

            <section>
              <h4>确认别名</h4>
              <div class="alias-list"><span v-for="alias in detail.aliases" :key="alias.id">{{ alias.value }}</span></div>
            </section>

            <section>
              <h4>当前定义与合同</h4>
              <dl>
                <dt>Definition</dt><dd>{{ detail.asset.currentDefinitionVersionId }}</dd>
                <dt>Contract</dt><dd>{{ detail.asset.currentContractVersionId }}</dd>
                <dt>定义历史</dt><dd>{{ detail.definitionVersions.length }}</dd>
                <dt>合同历史</dt><dd>{{ detail.contractVersions.length }}</dd>
              </dl>
            </section>

            <section>
              <h4>权威与版本</h4>
              <article v-for="entry in detail.authorities" :key="entry.id" class="authority-entry" :class="[entry.exposure, { historical: !isCurrentAuthority(entry.id) }]">
                <div><b>{{ authorityRoleLabel(entry.role) }}</b><span>{{ entry.kind }} · {{ authorityStateLabel(entry) }}</span></div>
                <code>{{ entry.assetVersionId }}</code>
              </article>
              <article v-for="version in detail.versions" :key="version.id" class="version-entry" :class="{ historical: !isCurrentVersion(version.id) }">
                <div><b>{{ representationLabel(version.representation) }}</b><span>{{ isCurrentVersion(version.id) ? "当前" : "历史，不可用于生成" }} · {{ version.media.length }} 个媒体成员 · {{ version.reviewIds.length }} 条 Review</span></div>
                <button v-for="media in version.media" :key="`${version.id}-${media.role}`" type="button" @click="reveal(media.path)"><FolderOpen :size="12" />{{ media.role }} · {{ shortSha(media.sha256) }}</button>
              </article>
              <p v-if="!detail.versions.length" class="muted">尚无真实媒体版本；不会用合同或定义伪造完成状态。</p>
            </section>

            <section v-if="detail.asset.positiveLocks.length || detail.asset.negativeLocks.length">
              <h4>一致性硬锁</h4>
              <ul class="lock-list positive"><li v-for="rule in detail.asset.positiveLocks" :key="rule.id">必须：{{ rule.instruction }}</li></ul>
              <ul class="lock-list negative"><li v-for="rule in detail.asset.negativeLocks" :key="rule.id">禁止：{{ rule.instruction }}</li></ul>
            </section>

            <section v-if="detail.migrationAnomalies.length">
              <h4>迁移异常（保留原貌）</h4>
              <ul class="anomaly-list"><li v-for="entry in detail.migrationAnomalies" :key="entry.id">{{ entry.message }}</li></ul>
            </section>

            <footer>Store r{{ detail.storeRevision }} · {{ shortSha(detail.storeFingerprint) }}</footer>
          </template>
          <div v-else class="detail-empty">选择资产后才按需读取定义、合同、版本、权威和 SHA。</div>
        </aside>
      </div>
    </template>

    <div v-if="error" class="library-error" role="alert">{{ error }}</div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { ChevronLeft, ChevronRight, FolderOpen, Image as ImageIcon, LockKeyhole, RefreshCw, Search, ShieldAlert } from "lucide-vue-next";
import type {
  CanonicalAssetAuthority,
  CanonicalAssetAuthorityFilter,
  CanonicalAssetCatalogState,
  CanonicalAssetCategory,
  CanonicalAssetDetail,
  CanonicalAssetMigrationPreview,
  CanonicalAssetPage,
  CanonicalAssetVersionRepresentation,
} from "@core/canonical-assets";
import { assetUrl } from "../utils";

const props = defineProps<{ projectRoot: string }>();
const emit = defineEmits<{ failed: [message: string] }>();
const state = ref<CanonicalAssetCatalogState | null>(null);
const migrationPreview = ref<CanonicalAssetMigrationPreview | null>(null);
const page = ref<CanonicalAssetPage | null>(null);
const detail = ref<CanonicalAssetDetail | null>(null);
const selectedId = ref("");
const search = ref("");
const category = ref<CanonicalAssetCategory | "any">("any");
const authority = ref<CanonicalAssetAuthorityFilter>("any");
const offset = ref(0);
const limit = 24;
const loading = ref(false);
const detailLoading = ref(false);
const error = ref("");
let catalogRequest = 0;
let listRequest = 0;
let detailRequest = 0;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

const categories = [
  { id: "any" as const, label: "全部" },
  { id: "character" as const, label: "角色" },
  { id: "scene" as const, label: "场景" },
  { id: "prop" as const, label: "道具" },
];
const pageStart = computed(() => page.value?.total ? page.value.offset + 1 : 0);
const pageEnd = computed(() => page.value ? Math.min(page.value.total, page.value.offset + page.value.items.length) : 0);
const hasNext = computed(() => Boolean(page.value && page.value.offset + page.value.items.length < page.value.total));

watch(() => props.projectRoot, async () => {
  selectedId.value = "";
  detail.value = null;
  offset.value = 0;
  await refresh();
}, { immediate: true });
watch([category, authority], () => { offset.value = 0; void loadPage(); });
watch(search, () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { offset.value = 0; void loadPage(); }, 180);
});
onBeforeUnmount(() => { if (searchTimer) clearTimeout(searchTimer); });

async function refresh(): Promise<void> {
  const request = ++catalogRequest;
  const root = props.projectRoot;
  // FE-06：刷新重置分页，防数据收缩后越界空页（pageStart > total）。
  offset.value = 0;
  loading.value = true;
  error.value = "";
  try {
    const next = await window.canvasApi.getCanonicalAssetCatalogState(root);
    if (request !== catalogRequest || root !== props.projectRoot) return;
    state.value = next;
    migrationPreview.value = next.available ? null : await window.canvasApi.previewCanonicalAssetMigration(root);
    if (request !== catalogRequest || root !== props.projectRoot) return;
    if (next.available && !next.current) {
      page.value = null;
      detail.value = null;
      selectedId.value = "";
      return;
    }
    await loadPage();
  } catch (reason) {
    if (request === catalogRequest && root === props.projectRoot) fail(reason);
  } finally {
    if (request === catalogRequest) loading.value = false;
  }
}

async function loadPage(): Promise<void> {
  if (!state.value?.available || !state.value.current) {
    page.value = null;
    detail.value = null;
    selectedId.value = "";
    return;
  }
  const request = ++listRequest;
  const root = props.projectRoot;
  loading.value = true;
  try {
    const next = await window.canvasApi.listCanonicalAssets(root, {
      category: category.value,
      authority: authority.value,
      search: search.value,
      offset: offset.value,
      limit,
    });
    if (request !== listRequest || root !== props.projectRoot) return;
    page.value = next;
  } catch (reason) {
    if (request === listRequest && root === props.projectRoot) fail(reason);
  } finally {
    if (request === listRequest) loading.value = false;
  }
}

async function selectAsset(assetId: string): Promise<void> {
  selectedId.value = assetId;
  detail.value = null;
  const request = ++detailRequest;
  const root = props.projectRoot;
  detailLoading.value = true;
  try {
    const next = await window.canvasApi.getCanonicalAsset(root, assetId);
    if (request !== detailRequest || root !== props.projectRoot || selectedId.value !== assetId) return;
    detail.value = next;
  } catch (reason) {
    if (request === detailRequest && root === props.projectRoot && selectedId.value === assetId) fail(reason);
  } finally {
    if (request === detailRequest) detailLoading.value = false;
  }
}

function changePage(direction: -1 | 1): void {
  offset.value = Math.max(0, offset.value + direction * limit);
  void loadPage();
}
function fail(reason: unknown): void {
  error.value = reason instanceof Error ? reason.message : String(reason);
  emit("failed", error.value);
}
function reveal(filePath: string): void { void window.canvasApi.showInFolder(filePath); }
function shortSha(value: string): string { return `${value.slice(0, 10)}…${value.slice(-6)}`; }
function categoryLabel(value: CanonicalAssetCategory): string { return ({ character: "角色", scene: "场景", prop: "道具" } as const)[value]; }
function authorityRoleLabel(value: CanonicalAssetAuthority["role"]): string { return ({ "primary-identity": "主身份权威", "production-hard-lock": "生产硬锁", "supporting-identity": "辅助身份权威" } as const)[value]; }
function representationLabel(value: CanonicalAssetVersionRepresentation): string { return ({ "production-output": "生产输出", "primary-reference": "主参考版本", "supporting-reference": "辅助参考版本" } as const)[value]; }
function currentAuthorityIds(): Set<string> {
  if (!detail.value) return new Set();
  return new Set([
    detail.value.asset.primaryAuthorityId,
    ...(detail.value.asset.currentSupportingAuthorityIds ?? []),
  ].filter((value): value is string => Boolean(value)));
}
function isCurrentAuthority(authorityId: string): boolean { return currentAuthorityIds().has(authorityId); }
function isCurrentVersion(versionId: string): boolean {
  if (!detail.value) return false;
  return detail.value.authorities.some((entry) => isCurrentAuthority(entry.id) && entry.assetVersionId === versionId);
}
function authorityStateLabel(entry: CanonicalAssetAuthority): string {
  if (!isCurrentAuthority(entry.id)) return "历史，不可用于生成";
  return entry.exposure === "allowed" && entry.scope.usage === "generation-reference"
    ? "当前可用于生成"
    : "当前仅人工复核/禁止上传生成";
}
</script>

<style scoped>
.canonical-library{height:100%;min-width:0;overflow:auto;background:#11120f;color:#e7e5dd}.library-header{position:sticky;top:0;z-index:8;height:92px;display:flex;align-items:center;justify-content:space-between;padding:0 26px;border-bottom:1px solid #30322c;background:#121310f5;backdrop-filter:blur(12px)}.library-header h2{margin:6px 0 3px;font-size:19px}.library-header p{margin:0;color:#83867b;font-size:9px}.library-header>button{height:32px;display:flex;align-items:center;gap:7px;border:1px solid #49432f;background:#1d1d18;color:#d7af55}.eyebrow{color:#d7af55;font-size:8px;letter-spacing:.12em}.catalog-strip{display:grid;grid-template-columns:repeat(7,minmax(80px,1fr));gap:1px;border-bottom:1px solid #30322c;background:#30322c}.catalog-strip>div{padding:12px 14px;background:#171815}.catalog-strip span,.catalog-strip b{display:block}.catalog-strip span{color:#71746b;font-size:7px}.catalog-strip b{margin-top:5px;font:13px Menlo,monospace}.catalog-strip>p{grid-column:1/-1;margin:0;padding:9px 14px;display:flex;align-items:center;gap:7px;background:#35251e;color:#e19a7c;font-size:8px}.library-toolbar{position:sticky;top:92px;z-index:7;height:53px;display:flex;align-items:center;gap:10px;padding:0 26px;border-bottom:1px solid #2c2e28;background:#151613}.library-toolbar>label{width:min(340px,32%);height:31px;display:flex;align-items:center;gap:7px;padding:0 9px;border:1px solid #35372f;background:#1b1c18}.library-toolbar input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:#eee}.library-toolbar select{height:31px;border:1px solid #35372f;background:#1b1c18;color:#ddd}.library-toolbar>span{margin-left:auto;color:#777a70;font-size:8px}.category-tabs{display:flex}.category-tabs button{height:29px;border:0;border-bottom:1px solid transparent;background:transparent;color:#74776d}.category-tabs button.active{border-bottom-color:#d7af55;color:#d7af55}.library-body{min-height:calc(100% - 190px);display:grid;grid-template-columns:minmax(520px,1fr) 380px}.asset-browser{min-width:0;border-right:1px solid #30322c}.canonical-card{width:calc(25% - 1px);min-width:170px;vertical-align:top;padding:0;border:0;border-right:1px solid #2b2d27;border-bottom:1px solid #2b2d27;background:#171815;color:inherit;text-align:left}.canonical-card:hover,.canonical-card.selected{background:#20211d;box-shadow:inset 0 0 0 1px #6d5a2d}.canonical-card figure{height:150px;margin:0;display:grid;place-items:center;overflow:hidden;background:#0c0d0b}.canonical-card figure img{width:100%;height:100%;object-fit:cover}.canonical-card figure span{display:grid;justify-items:center;gap:8px;color:#55584f;font-size:8px}.card-copy{min-height:112px;padding:11px}.card-copy>span,.card-copy>b,.card-copy>small,.card-copy>em,.card-copy>i{display:block}.card-copy>span{color:#d7af55;font-size:7px;letter-spacing:.08em}.card-copy>b{margin-top:6px;overflow:hidden;font-size:10px;text-overflow:ellipsis;white-space:nowrap}.card-copy>small{margin-top:6px;color:#696c63;font-size:7px}.card-copy>em{margin-top:9px;display:flex;align-items:center;gap:5px;color:#8aaa76;font-size:7px;font-style:normal}.card-copy>i{margin-top:5px;color:#c99767;font-size:6px;font-style:normal}.pager{height:48px;display:flex;align-items:center;justify-content:center;gap:18px;border-top:1px solid #30322c}.pager button{display:flex;align-items:center;gap:3px;border:0;background:transparent;color:#d7af55}.pager button:disabled{color:#44473f}.pager span{color:#6d7067;font:7px Menlo,monospace}.asset-detail{min-width:0;overflow:auto;background:#141512}.asset-detail>header{padding:20px;border-bottom:1px solid #2d2f29}.asset-detail>header span{color:#d7af55;font-size:8px}.asset-detail h3{margin:7px 0;font-size:16px}.asset-detail code{display:block;overflow:hidden;color:#55584f;font:6px Menlo,monospace;text-overflow:ellipsis;white-space:nowrap}.asset-detail>section{padding:15px 20px;border-bottom:1px solid #2d2f29}.asset-detail h4{margin:0 0 10px;color:#a8aa9f;font-size:8px}.alias-list{display:flex;flex-wrap:wrap;gap:5px}.alias-list span{padding:4px 6px;border:1px solid #34362f;color:#aaa;font-size:7px}.asset-detail dl{display:grid;grid-template-columns:75px minmax(0,1fr);gap:7px;margin:0}.asset-detail dt{color:#696c63;font-size:7px}.asset-detail dd{margin:0;overflow:hidden;color:#9b9d94;font:6px Menlo,monospace;text-overflow:ellipsis;white-space:nowrap}.authority-entry,.version-entry{padding:9px 0;border-top:1px solid #292b25}.authority-entry>div,.version-entry>div{display:flex;justify-content:space-between;gap:7px}.authority-entry b,.version-entry b{font-size:8px}.authority-entry span,.version-entry span{color:#70736a;font-size:6px}.authority-entry.forbidden b{color:#d38b6d}.version-entry button{margin:7px 5px 0 0;display:inline-flex;align-items:center;gap:4px;border:1px solid #383a33;background:transparent;color:#9b9e94;font-size:6px}.lock-list,.anomaly-list{margin:0;padding-left:18px;color:#92958b;font-size:7px;line-height:1.65}.lock-list.positive li::marker{color:#83aa72}.lock-list.negative li::marker,.anomaly-list li::marker{color:#d37b67}.asset-detail>footer{padding:12px 20px;color:#55584f;font:6px Menlo,monospace}.detail-empty,.list-empty{min-height:180px;display:grid;place-items:center;color:#5d6057;font-size:8px}.migration-empty{height:calc(100% - 92px);display:grid;place-content:center;justify-items:center;gap:9px;color:#666960;text-align:center}.migration-empty h3{margin:0;color:#ddd}.migration-empty p{max-width:500px;margin:0;font-size:8px}.preview-counts{display:flex;gap:8px}.preview-counts span{padding:5px 8px;border:1px solid #35372f;color:#aaa;font-size:7px}.migration-empty ul{max-width:620px;text-align:left;color:#d17a68;font-size:7px}.migration-empty small{color:#85a876}.library-error{position:fixed;right:18px;bottom:18px;z-index:20;max-width:520px;padding:10px 12px;border-left:2px solid #d36b59;background:#2a1c18;color:#e9a088;font-size:8px}.muted{color:#65685f;font-size:7px}.spinning{animation:spin .8s linear infinite}@media(max-width:1250px){.library-body{grid-template-columns:minmax(480px,1fr) 320px}.canonical-card{width:33.333%}.catalog-strip{grid-template-columns:repeat(4,1fr)}}
.authority-entry.historical,.version-entry.historical{opacity:.55}.authority-entry.historical b,.version-entry.historical b{color:#777a70}
</style>
