<template>
  <section class="higgsfield-video-step" data-testid="higgsfield-seedance25-video-step">
    <b>Higgsfield · Seedance 2.5 视频</b>
    <p>固定调用单：References · 20 秒输出（时间线仅绑定 0–15 秒）· 720p · 1 条 · 音频开启 · Unlimited-only。</p>
    <dl>
      <div><dt>模型</dt><dd>Seedance 2.5 / omni_reference</dd></div>
      <div><dt>参考</dt><dd>最多预览 6 张；实际顺序以已冻结 source closure 为准</dd></div>
      <div><dt>并发</dt><dd>1（不批量、不回退 credits）</dd></div>
    </dl>
    <p :class="control?.availability === 'ready' ? 'ready' : 'blocked'" role="status">{{ control?.availabilityReason ?? "当前实测快照：网页有 Unlimited，但程序化 Seedance 2.5 Unlimited 暂不可用。" }}</p>
    <p v-if="control">参考 {{ control.referenceCount }} 张（预览上限 {{ control.referencePreviewCount }}）· 队列状态 {{ control.connectorRequest?.status ?? "未排队" }}{{ control.connectorRequest?.blockers.length ? ` · ${control.connectorRequest.blockers.join("、")}` : "" }}</p>
    <button type="button" :disabled="!canQueue || busy" :title="busy ? '正在处理，不能再加入 Higgsfield 视频队列' : canQueue ? '只写入本地队列；不会上传、调用网页或扣 credits' : '需先完成机械验证视频包；当前 Provider 未证实免费模式时 Codex 会停止在预检门禁'" @click="queueVideo">
      {{ control?.connectorRequest?.status === "blocked_by_provider" ? "重新加入 Higgsfield 视频队列" : control?.connectorRequest ? `队列已记录：${control.connectorRequest.status}` : "加入 Higgsfield 视频队列" }}
    </button>
    <small>按钮只写入本地队列；受信任 connector 适配器落地前不能领取或调用，也不会上传或扣 credits。图片复用既有 Codex 生图派发，不在此创建第二个图片 owner。</small>
  </section>
</template>

<script setup lang="ts">
import type { StudioHiggsfieldVideoControl } from "@core/studio-higgsfield-video-generation";
import { computed } from "vue";
const props = defineProps<{ control: StudioHiggsfieldVideoControl | null; busy?: boolean }>();
const emit = defineEmits<{ queueVideo: [intentId: string] }>();
const canQueue = computed(() => Boolean((props.control?.connectorRequest === null || props.control?.connectorRequest?.status === "blocked_by_provider") && props.control?.referenceCount > 0));
function queueVideo(): void {
  if (props.busy || !props.control || !canQueue.value) return;
  // 控制面本身不暴露 intentId；队列由父组件在已解析的视频包上下文内提交。
  emit("queueVideo", props.control.intentId);
}
</script>

<style scoped>
.higgsfield-video-step { border: 1px solid #d9c790; border-radius: 10px; padding: 12px; display: grid; gap: 7px; }
.higgsfield-video-step p { margin: 0; color: #5f625f; line-height: 1.45; }
.higgsfield-video-step dl { margin: 0; display: grid; gap: 4px; }
.higgsfield-video-step dl div { display: flex; gap: 8px; font-size: 12px; }
.higgsfield-video-step dt { color: #74766f; min-width: 42px; }.higgsfield-video-step dd { margin: 0; }
.higgsfield-video-step .blocked { color: #9d493a; font-weight: 700; }
.higgsfield-video-step .ready { color: #26764a; font-weight: 700; }
.higgsfield-video-step button { justify-self: start; }.higgsfield-video-step small { color: #74766f; }
</style>
