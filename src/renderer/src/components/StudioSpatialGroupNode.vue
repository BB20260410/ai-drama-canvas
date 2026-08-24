<template>
  <section class="studio-spatial-group" :style="{ width: `${data.width}px`, height: `${data.height}px` }">
    <header>{{ data.title }} · {{ data.memberIds.length }}</header>
  </section>
</template>

<script setup lang="ts">
defineProps<{
  data: { title: string; memberIds: string[]; width: number; height: number };
}>();
</script>

<style scoped>
.studio-spatial-group {
  min-width: 80px;
  min-height: 60px;
  border: 1px dashed #66572f;
  background: rgba(71, 59, 28, 0.08);
}
.studio-spatial-group header {
  height: 28px;
  display: flex;
  align-items: center;
  padding: 0 10px;
  border-bottom: 1px solid rgba(215, 175, 85, 0.14);
  background: rgba(24, 23, 18, 0.88);
  color: #d7af55;
  font-size: 11px;
  cursor: grab;
}
</style>
