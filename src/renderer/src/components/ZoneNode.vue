<template>
  <section class="zone-node" :style="{ height: `${data.height}px` }">
    <header>
      <span>{{ data.index }}</span>
      <strong>{{ data.title }}</strong>
      <small>{{ data.count }}</small>
    </header>
  </section>
</template>

<script setup lang="ts">
defineProps<{
  data: { title: string; count: number; index: string; height: number };
}>();
</script>
