<template>
  <article class="narrative-node" :class="[data.kind,{compact:data.compact}]">
    <span>{{ kindLabel }}</span><b>{{ data.title }}</b><p>{{ data.detail }}</p><small>{{ data.meta }}</small>
  </article>
</template>

<script setup lang="ts">
import { computed } from "vue";
const props=defineProps<{data:{kind:"source"|"fact"|"beat"|"plan";title:string;detail:string;meta:string;compact:boolean}}>();
const kindLabel=computed(()=>({source:"小说原文",fact:"小说事实",beat:"剧情节拍",plan:"改编方案"})[props.data.kind]);
</script>

<style scoped>
.narrative-node{width:236px;min-height:112px;padding:13px 14px;border:1px solid #37382f;border-left:2px solid #7a6a3c;background:#171814;color:#b8bab2;box-shadow:0 12px 30px rgba(0,0,0,.22)}.narrative-node span,.narrative-node b,.narrative-node small{display:block}.narrative-node span{color:#d7af55;font:7px Menlo}.narrative-node b{margin-top:8px;font-size:10px;line-height:1.35}.narrative-node p{margin:7px 0;color:#777b72;font-size:8px;line-height:1.5}.narrative-node small{color:#555950;font:6px Menlo}.narrative-node.source{border-left-color:#8b8f85}.narrative-node.beat{border-left-color:#65906a}.narrative-node.plan{border-left-color:#d7af55}.narrative-node.compact{min-height:62px}.narrative-node.compact p,.narrative-node.compact small{display:none}
</style>
