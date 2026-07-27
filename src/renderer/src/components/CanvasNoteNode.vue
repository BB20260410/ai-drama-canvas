<template>
  <article class="canvas-note" :class="`tone-${data.entity.color}`" :style="{ width: `${data.entity.width}px`, minHeight: `${data.entity.height}px` }">
    <header class="canvas-entity-handle">
      <span><StickyNote :size="13" /> 导演批注</span>
      <div><button type="button" title="编辑批注" @click.stop="data.onEdit(data.entity)"><Pencil :size="12" /></button><button type="button" title="删除批注" @click.stop="data.onDelete(data.entity.id)"><X :size="13" /></button></div>
    </header>
    <h3>{{ data.entity.title }}</h3>
    <p>{{ data.entity.body || "暂无正文" }}</p>
    <footer>{{ new Date(data.entity.updatedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) }}</footer>
  </article>
</template>

<script setup lang="ts">
import { Pencil, StickyNote, X } from "lucide-vue-next";
import type { CanvasEntity } from "@core/types";

defineProps<{ data: { entity: CanvasEntity; onEdit: (entity: CanvasEntity) => void; onDelete: (id: string) => void } }>();
</script>

<style scoped>
.canvas-note { overflow: hidden; border: 1px solid #66572f; background: #201d14; box-shadow: 0 12px 30px rgba(0,0,0,.28); }.canvas-note header { height: 33px; display: flex; align-items: center; justify-content: space-between; padding: 0 8px 0 10px; border-bottom: 1px solid rgba(255,255,255,.08); cursor: grab; }.canvas-note header > span { display: flex; align-items: center; gap: 6px; color: #d7af55; font-size: 8px; letter-spacing: .08em; }.canvas-note header div { display: flex; }.canvas-note header button { width: 24px; height: 24px; display: grid; place-items: center; border: 0; background: transparent; color: #8f8c80; cursor: pointer; }.canvas-note header button:hover { color: #e3c46f; }.canvas-note h3 { margin: 13px 14px 0; color: #ede7d6; font-size: 13px; }.canvas-note p { margin: 10px 14px; color: #b9b4a7; font-size: 10px; line-height: 1.65; white-space: pre-wrap; word-break: break-word; }.canvas-note footer { margin: auto 14px 10px; color: #6f6c62; font: 7px Menlo,monospace; }.tone-blue { border-color: #3f6476; background: #151e22; }.tone-blue header > span { color: #70a7c5; }.tone-green { border-color: #49633f; background: #182016; }.tone-green header > span { color: #83aa72; }.tone-red { border-color: #71433a; background: #251815; }.tone-red header > span { color: #d36b59; }.tone-purple { border-color: #654c76; background: #201824; }.tone-purple header > span { color: #b98fdf; }.tone-gray { border-color: #4a4c45; background: #1b1c19; }.tone-gray header > span { color: #a2a49b; }
</style>
