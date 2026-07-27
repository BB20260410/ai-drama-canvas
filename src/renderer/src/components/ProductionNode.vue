<template>
  <article class="production-node" :class="[{ compact: data.compact, asset: item.type === 'asset' }, statusClass(item.status)]">
    <header class="node-header">
      <div class="node-kicker">
        <span class="status-dot"></span>
        <span v-if="item.type === 'asset'">项目资产</span>
        <span v-else>EP{{ String(item.episode ?? 0).padStart(2, "0") }} · {{ item.unit ? `15s ${String(item.unit).padStart(3, "0")}` : `镜${item.shot}` }}</span>
      </div>
      <span class="node-status">{{ item.status }}</span>
    </header>

    <h3>{{ item.title }}</h3>

    <div v-if="item.type === 'asset'" class="asset-preview">
      <img v-if="item.thumbnailPath" :src="assetThumbnailUrl(item.thumbnailPath)" alt="硬锁参考" loading="lazy" decoding="async" />
      <div v-else class="empty-frame">缺失</div>
    </div>
    <div v-else class="frame-strip">
      <figure>
        <img v-if="startImage" :src="assetThumbnailUrl(startImage.path)" alt="首帧" loading="lazy" decoding="async" />
        <div v-else class="empty-frame">首帧</div>
        <figcaption>
          <span>首帧</span>
          <b :class="{ ok: startPair }">{{ startPair ? "成对" : "待补" }}</b>
        </figcaption>
      </figure>
      <figure>
        <img v-if="endImage" :src="assetThumbnailUrl(endImage.path)" alt="尾帧" loading="lazy" decoding="async" />
        <div v-else class="empty-frame">尾帧</div>
        <figcaption>
          <span>尾帧</span>
          <b :class="{ ok: endPair }">{{ endPair ? "成对" : "待补" }}</b>
        </figcaption>
      </figure>
    </div>

    <footer>
      <span>{{ data.videoCount ? `${data.videoCount} 个视频` : item.nextAction }}</span>
      <span class="arrow">→</span>
    </footer>
  </article>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { Artifact, WorkItem } from "@core/types";
import { assetThumbnailUrl, authoritativeArtifacts, statusClass } from "../utils";

const props = defineProps<{
  data: { item: WorkItem; artifacts: Artifact[]; compact: boolean; videoCount: number };
}>();

const item = computed(() => props.data.item);
const activeArtifacts = computed(() => authoritativeArtifacts(props.data.artifacts));
const startImage = computed(
  () =>
    activeArtifacts.value.find((artifact) => artifact.kind === "raw-image" && artifact.variant === "start") ??
    activeArtifacts.value.find((artifact) => artifact.kind === "raw-image" && artifact.variant === "generic"),
);
const endImage = computed(() => activeArtifacts.value.find((artifact) => artifact.kind === "raw-image" && artifact.variant === "end"));
const startPair = computed(
  () =>
    Boolean(startImage.value) &&
    activeArtifacts.value.some(
      (artifact) => artifact.kind === "labeled-image" && (artifact.variant === startImage.value?.variant || artifact.variant === "generic"),
    ),
);
const endPair = computed(
  () => Boolean(endImage.value) && activeArtifacts.value.some((artifact) => artifact.kind === "labeled-image" && artifact.variant === "end"),
);
</script>
