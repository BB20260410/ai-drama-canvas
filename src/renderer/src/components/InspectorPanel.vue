<template>
  <aside class="inspector" :class="{ open: Boolean(item) }">
    <template v-if="item">
      <header class="inspector-header">
        <div>
          <span class="eyebrow">节点检查器</span>
          <h2>{{ item.title }}</h2>
        </div>
        <button class="icon-button" type="button" @click="$emit('close')"><X :size="18" /></button>
      </header>

      <section class="inspector-status">
        <label>生产状态</label>
        <select v-model="draftStatus">
          <option v-for="status in WORK_ITEM_STATUSES" :key="status" :value="status">{{ status }}</option>
        </select>
        <textarea v-model="note" rows="2" placeholder="视觉判断或返工说明"></textarea>
        <button class="primary-button" type="button" :disabled="saving" @click="saveStatus">
          {{ saving ? "写入中…" : "写回画布" }}
        </button>
      </section>

      <section class="inspector-section action-row">
        <button v-if="item.infoPath" type="button" @click="openInfo"><FileText :size="16" /> 打开信息</button>
        <button type="button" @click="revealPrimary"><FolderOpen :size="16" /> 定位文件</button>
      </section>

      <section class="inspector-section">
        <div class="section-heading">
          <span>下一动作</span>
          <strong>{{ item.status }}</strong>
        </div>
        <p class="next-action">{{ item.nextAction }}</p>
        <p v-if="item.failureReason" class="failure">{{ item.failureReason }}</p>
      </section>

      <section class="inspector-section">
        <div class="section-heading"><span>关联硬锁</span><strong>{{ itemHardLocks.length }}</strong></div>
        <ul class="lock-list">
          <li v-for="lock in itemHardLocks" :key="lock.id">
            <LockKeyhole :size="14" />
            <div><b>{{ lock.name }}</b><small>{{ lock.note }}</small></div>
          </li>
        </ul>
      </section>

      <section v-if="item.infoExcerpt" class="inspector-section">
        <div class="section-heading"><span>信息与提示词</span><strong>{{ item.infoPath ? "已落盘" : "摘要" }}</strong></div>
        <pre>{{ item.infoExcerpt }}</pre>
      </section>

      <section class="inspector-section artifacts-section">
        <div class="section-heading"><span>素材版本</span><strong>{{ artifacts.length }}</strong></div>
        <div
          v-for="artifact in sortedArtifacts"
          :key="artifact.id"
          class="artifact-row"
          :class="{ authoritative: artifact.authoritative }">
          <button class="artifact-open" type="button" @click="revealArtifact(artifact.path)">
            <span class="artifact-icon"><ImageIcon v-if="artifact.kind.includes('image')" :size="15" /><Film v-else-if="artifact.kind === 'video'" :size="15" /><FileText v-else :size="15" /></span>
            <span class="artifact-copy">
              <b>{{ artifact.variant }} · {{ artifact.kind }} · {{ artifact.versionLabel }}</b>
              <small>{{ artifact.path }}</small>
            </span>
            <span class="artifact-check" :class="{ ok: artifact.check.ok, deprecated: artifact.deprecated }">
              {{ artifact.authoritative ? "权威" : artifact.deprecated ? "历史" : artifact.check.ok ? "可选" : "异常" }}
            </span>
          </button>
          <button
            v-if="!artifact.authoritative && !artifact.deprecated && artifact.check.ok && ['raw-image','labeled-image','video'].includes(artifact.kind)"
            class="authority-action"
            type="button"
            :disabled="settingAuthority === artifact.id"
            @click="setAuthority(artifact)">设为权威</button>
        </div>
      </section>
    </template>
    <div v-else class="inspector-empty">
      <ScanSearch :size="28" />
      <span>选择一个节点</span>
      <small>查看提示词、文件路径、版本与验收结果</small>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { FileText, Film, FolderOpen, Image as ImageIcon, LockKeyhole, ScanSearch, X } from "lucide-vue-next";
import { WORK_ITEM_STATUSES, type Artifact, type HardLock, type WorkItem, type WorkItemStatus } from "@core/types";

const props = defineProps<{
  item: WorkItem | null;
  artifacts: Artifact[];
  hardLocks: HardLock[];
  projectRoot: string;
}>();

const emit = defineEmits<{
  close: [];
  updated: [];
}>();

const draftStatus = ref<WorkItemStatus>("待规划");
const note = ref("");
const saving = ref(false);
const settingAuthority = ref("");

watch(
  () => props.item,
  (item) => {
    if (item) draftStatus.value = item.status;
    note.value = "";
  },
  { immediate: true },
);

const sortedArtifacts = computed(() =>
  [...props.artifacts].sort(
    (a, b) => Number(b.authoritative) - Number(a.authoritative) || Number(a.deprecated) - Number(b.deprecated) || a.path.localeCompare(b.path),
  ),
);
const itemHardLocks = computed(() => props.hardLocks.filter((lock) => props.item?.hardLockIds.includes(lock.id)));

async function saveStatus() {
  if (!props.item) return;
  saving.value = true;
  try {
    await window.canvasApi.updateStatus(props.projectRoot, props.item.id, draftStatus.value, note.value || undefined);
    emit("updated");
  } finally {
    saving.value = false;
  }
}

async function setAuthority(artifact: Artifact) {
  if (!props.item) return;
  settingAuthority.value = artifact.id;
  try {
    await window.canvasApi.setAuthoritativeArtifact(props.projectRoot, props.item.id, artifact.id, "在节点检查器中人工选择权威版本");
    emit("updated");
  } finally {
    settingAuthority.value = "";
  }
}

function revealPrimary() {
  const target = props.item?.infoPath ?? props.item?.sourcePaths[0];
  if (target) void window.canvasApi.showInFolder(target);
}

function openInfo() {
  if (props.item?.infoPath) void window.canvasApi.openPath(props.item.infoPath);
}

function revealArtifact(filePath: string) {
  void window.canvasApi.showInFolder(filePath);
}
</script>
