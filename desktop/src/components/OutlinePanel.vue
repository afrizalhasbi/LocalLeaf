<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { parseOutline, type OutlineItem } from "../lib/latex";
import { gotoLocation, state } from "../lib/store";
import Icon from "./Icon.vue";

// Parsing a long document on every keystroke is wasted work: re-parse shortly after typing
// stops, and immediately when another file is opened.
const source = ref("");
let timer: ReturnType<typeof setTimeout> | undefined;
const isTex = computed(() => !!state.openPath?.endsWith(".tex") && state.openKind === "text");
watch(
  () => state.openPath,
  () => {
    clearTimeout(timer);
    source.value = isTex.value ? state.content : "";
  },
  { immediate: true },
);
watch(
  () => state.content,
  (text) => {
    clearTimeout(timer);
    timer = setTimeout(() => (source.value = isTex.value ? text : ""), 200);
  },
);
onBeforeUnmount(() => clearTimeout(timer));

const outline = computed(() => (source.value ? parseOutline(source.value) : []));

interface Row {
  item: OutlineItem;
  depth: number;
}
const rows = computed(() => {
  const out: Row[] = [];
  const walk = (items: OutlineItem[], depth: number) =>
    items.forEach((item) => {
      out.push({ item, depth });
      walk(item.children, depth + 1);
    });
  walk(outline.value, 0);
  return out;
});

// The section containing the cursor is highlighted, as in Overleaf.
const currentLine = computed(() => {
  let line = -1;
  for (const r of rows.value) if (r.item.line <= state.cursor.line) line = Math.max(line, r.item.line);
  return line;
});
</script>

<template>
  <section class="flex min-h-0 flex-col border-t border-divider" :class="state.ui.showOutline ? 'h-[38%]' : 'h-auto'">
    <button
      class="flex h-8 shrink-0 items-center gap-1 px-2 text-[12px] font-semibold tracking-wide text-sidebar-muted uppercase hover:bg-sidebar-hover"
      @click="state.ui.showOutline = !state.ui.showOutline"
    >
      <Icon :name="state.ui.showOutline ? 'expand_more' : 'chevron_right'" :size="18" />
      File outline
    </button>
    <div v-if="state.ui.showOutline" class="min-h-0 flex-1 overflow-auto pb-2">
      <p v-if="!rows.length" class="px-4 py-2 text-[12px] text-sidebar-muted">
        {{ state.openPath?.endsWith(".tex") ? "No sections in this file" : "Open a .tex file to see its outline" }}
      </p>
      <button
        v-for="r in rows"
        :key="`${r.item.line}-${r.item.title}`"
        class="flex h-6.5 w-full items-center truncate pr-2 text-left text-[13px]"
        :class="r.item.line === currentLine ? 'font-semibold text-accent' : 'text-sidebar-fg hover:bg-sidebar-hover'"
        :style="{ paddingLeft: `${16 + r.depth * 14}px` }"
        :title="`\\${r.item.command}{${r.item.title}} — line ${r.item.line}`"
        @click="gotoLocation(state.openPath, r.item.line)"
      >
        <span class="truncate">{{ r.item.title }}</span>
      </button>
    </div>
  </section>
</template>
