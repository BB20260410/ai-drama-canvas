<script setup lang="ts">
/**
 * Qwen D5 · 导演动作面板 UI（只读导航；不 emit execute_command）
 */
import { computed, ref } from "vue";
import { DIRECTOR_ACTIONS, filterDirectorActions, type DirectorAction } from "../director-action-panel.js";

const props = defineProps<{
  open: boolean;
  season?: string;
  episode?: string;
}>();

const emit = defineEmits<{
  close: [];
  action: [DirectorAction];
}>();

const query = ref("");
const items = computed(() => filterDirectorActions(query.value));

function onPick(action: DirectorAction) {
  if (action.requiresSeasonEpisode && (!props.season || !props.episode)) return;
  emit("action", action);
}
</script>

<template>
  <aside
    v-if="open"
    class="director-panel"
    data-testid="director-action-panel"
    role="dialog"
    aria-label="导演动作面板"
  >
    <header>
      <h3>导演动作</h3>
      <button type="button" data-testid="director-panel-close" @click="emit('close')">关闭</button>
    </header>
    <p class="hint">仅只读定位 / 对照 / 追溯；禁止任意执行写命令。</p>
    <input
      v-model="query"
      type="search"
      placeholder="过滤动作…"
      data-testid="director-panel-filter"
    />
    <ul>
      <li v-for="action in items" :key="action.id">
        <button
          type="button"
          class="director-action"
          :data-testid="`director-action-${action.id}`"
          :disabled="Boolean(action.requiresSeasonEpisode && (!season || !episode))"
          @click="onPick(action)"
        >
          <b>{{ action.title }}</b>
          <small>{{ action.description }}</small>
          <code v-if="action.readonlyHint">{{ action.readonlyHint }}</code>
        </button>
      </li>
    </ul>
    <footer v-if="!items.length">无匹配动作</footer>
  </aside>
</template>

<style scoped>
.director-panel {
  position: absolute;
  right: 12px;
  top: 56px;
  z-index: 40;
  width: min(360px, calc(100% - 24px));
  max-height: min(70vh, 520px);
  overflow: auto;
  border: 1px solid var(--msc-line, #34362f);
  border-radius: 10px;
  background: var(--msc-surface, #1a1c17);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.35);
  padding: 10px 12px 14px;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
header h3 {
  margin: 0;
  font-size: 13px;
  color: var(--msc-text, #e8e6dc);
}
header button {
  border: 0;
  background: transparent;
  color: var(--msc-text-2, #a6a99e);
  cursor: pointer;
}
.hint {
  margin: 6px 0 10px;
  color: var(--msc-text-3, #7a7d72);
  font-size: 10px;
  line-height: 1.45;
}
input[type="search"] {
  width: 100%;
  box-sizing: border-box;
  margin-bottom: 8px;
  border: 1px solid var(--msc-line, #34362f);
  border-radius: 7px;
  background: var(--msc-bg, #121310);
  color: var(--msc-text, #e8e6dc);
  padding: 7px 9px;
  font-size: 12px;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
}
.director-action {
  width: 100%;
  display: grid;
  gap: 3px;
  text-align: left;
  border: 1px solid var(--msc-line, #34362f);
  border-radius: 8px;
  background: var(--msc-bg, #121310);
  color: inherit;
  padding: 8px 9px;
  cursor: pointer;
}
.director-action:disabled {
  opacity: 0.4;
  cursor: default;
}
.director-action b {
  font-size: 12px;
  color: var(--msc-text, #e8e6dc);
}
.director-action small {
  color: var(--msc-text-2, #a6a99e);
  font-size: 10px;
  line-height: 1.4;
}
.director-action code {
  color: #9bb07a;
  font: 9px/1.3 Menlo, monospace;
  overflow-wrap: anywhere;
}
footer {
  margin-top: 8px;
  color: var(--msc-text-3, #7a7d72);
  font-size: 11px;
}
</style>
