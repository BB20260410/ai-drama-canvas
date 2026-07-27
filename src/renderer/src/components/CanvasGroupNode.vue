<template>
  <section class="canvas-group" :class="`tone-${data.entity.color}`" :style="{ width: `${data.entity.width}px`, height: `${data.entity.height}px` }">
    <header class="canvas-entity-handle">
      <div><span>自定义分组</span><b>{{ data.entity.title }}</b><small v-if="data.entity.memberIds.length">{{ data.entity.memberIds.length }} 个显式成员</small></div>
      <div class="group-actions"><button type="button" title="编辑分组" @click.stop="data.onEdit(data.entity)"><Pencil :size="12" /></button><button type="button" title="删除分组" @click.stop="data.onDelete(data.entity.id)"><X :size="13" /></button></div>
    </header>
    <p v-if="data.entity.body">{{ data.entity.body }}</p>
  </section>
</template>

<script setup lang="ts">
import { Pencil, X } from "lucide-vue-next";
import type { CanvasEntity } from "@core/types";

defineProps<{ data: { entity: CanvasEntity; onEdit: (entity: CanvasEntity) => void; onDelete: (id: string) => void } }>();
</script>

<style scoped>
.canvas-group { position: relative; border: 1px dashed #66572f; background: rgba(71,59,28,.08); }.canvas-group header { height: 46px; display: flex; align-items: center; justify-content: space-between; padding: 0 9px 0 13px; border-bottom: 1px solid rgba(215,175,85,.14); background: rgba(24,23,18,.88); cursor: grab; }.canvas-group header > div:first-child { min-width: 0; display: flex; align-items: center; gap: 9px; }.canvas-group header span { color: #d7af55; font-size: 7px; letter-spacing: .1em; }.canvas-group header b { max-width: 420px; overflow: hidden; color: #d7d4c9; font-size: 11px; white-space: nowrap; text-overflow: ellipsis; }.canvas-group header small { color: #6f7169; font-size: 7px; }.group-actions { display: flex; }.group-actions button { width: 25px; height: 25px; display: grid; place-items: center; border: 0; background: transparent; color: #777970; cursor: pointer; }.group-actions button:hover { color: #e1c16c; }.canvas-group > p { max-width: 80%; margin: 11px 13px; color: #777a70; font-size: 8px; line-height: 1.5; white-space: pre-wrap; }.tone-blue { border-color: #446f83; background: rgba(37,77,94,.08); }.tone-blue header { border-bottom-color: rgba(112,167,197,.15); }.tone-blue header span { color: #70a7c5; }.tone-green { border-color: #527249; background: rgba(54,88,43,.08); }.tone-green header span { color: #83aa72; }.tone-red { border-color: #805044; background: rgba(109,52,41,.08); }.tone-red header span { color: #d36b59; }.tone-purple { border-color: #76558a; background: rgba(85,49,104,.08); }.tone-purple header span { color: #b98fdf; }.tone-gray { border-color: #55584f; background: rgba(80,82,75,.06); }.tone-gray header span { color: #a2a49b; }
</style>
