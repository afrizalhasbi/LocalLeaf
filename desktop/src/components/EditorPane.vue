<script setup lang="ts">
import { computed } from "vue";
import { state } from "../lib/store";
import { iconForFile } from "./fileIcons";
import BinaryPreview from "./BinaryPreview.vue";
import CodeEditor from "./CodeEditor.vue";
import Icon from "./Icon.vue";

const crumbs = computed(() => state.openPath?.split("/") ?? []);
const fileIcon = computed(() => (state.openPath ? iconForFile(state.openPath) : null));
</script>

<template>
  <div class="flex h-full min-w-0 flex-col bg-app">
    <!-- Breadcrumbs -->
    <div class="flex h-9 shrink-0 items-center gap-1 border-b border-divider bg-toolbar px-3 text-[12.5px] text-toolbar-fg">
      <template v-if="state.openPath">
        <Icon v-if="fileIcon" :name="fileIcon.icon" :size="16" :style="{ color: fileIcon.color }" />
        <template v-for="(c, i) in crumbs" :key="i">
          <Icon v-if="i > 0" name="chevron_right" :size="16" class="opacity-50" />
          <span :class="i === crumbs.length - 1 ? 'font-semibold' : 'opacity-70'">{{ c }}</span>
        </template>
        <span
          v-if="state.openPath === state.mainDocument"
          class="ml-2 rounded-full bg-accent px-2 py-px text-[11px] font-semibold text-white"
          >main document</span
        >
      </template>
      <span v-else class="opacity-60">No file open</span>
    </div>

    <div class="relative min-h-0 flex-1">
      <CodeEditor v-show="state.openKind === 'text'" class="absolute inset-0" />
      <BinaryPreview v-if="state.openKind && state.openKind !== 'text'" class="absolute inset-0" />
      <div v-if="!state.openKind" class="absolute inset-0 flex flex-col items-center justify-center gap-2 text-surface-muted">
        <Icon name="description" :size="44" />
        <p class="text-[14px]">Select a file in the file tree to start editing</p>
      </div>
    </div>

    <!-- Status bar: cursor position (bottom right) -->
    <div class="flex h-6 shrink-0 items-center gap-4 border-t border-divider bg-toolbar px-3 text-[11.5px] text-toolbar-fg/75">
      <span v-if="state.openKind === 'text'">{{ state.openPath?.split(".").pop()?.toUpperCase() }}</span>
      <div class="flex-1" />
      <span v-if="state.openKind === 'text'">Line {{ state.cursor.line }}, Column {{ state.cursor.col }}</span>
    </div>
  </div>
</template>
