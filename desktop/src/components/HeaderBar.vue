<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { closeProject, diagnostics, renameProject, state } from "../lib/store";
import { revealProject } from "../lib/actions";
import Icon from "./Icon.vue";
import Logo from "./Logo.vue";
import RecompileButton from "./RecompileButton.vue";
import ToolbarButton from "./ToolbarButton.vue";

const editing = ref(false);
const draft = ref("");
const titleInput = ref<HTMLInputElement>();

async function startEditing() {
  draft.value = state.displayName;
  editing.value = true;
  await nextTick();
  titleInput.value?.select();
}
function commit() {
  if (editing.value) renameProject(draft.value);
  editing.value = false;
}

const shortRoot = computed(() => (state.info?.root ?? "").replace(/^\/Users\/[^/]+/, "~"));

const counts = computed(() => {
  const d = diagnostics();
  return { errors: d.errors.length + (state.compileError ? 1 : 0), warnings: d.warnings.length + d.badBoxes.length };
});

// Re-render the "Saved Xs ago" label periodically.
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval>;
onMounted(() => (timer = setInterval(() => (now.value = Date.now()), 10_000)));
onBeforeUnmount(() => clearInterval(timer));

const saveStatus = computed(() => {
  switch (state.saveState) {
    case "saving":
      return { icon: "sync", text: "Saving…", cls: "spin" };
    case "unsaved":
      return { icon: "edit", text: "Unsaved changes", cls: "" };
    case "error":
      return { icon: "error", text: "Save failed", cls: "text-danger" };
    default: {
      const ago = state.lastSavedAt ? Math.round((now.value - state.lastSavedAt) / 1000) : null;
      const when = ago === null ? "" : ago < 10 ? " just now" : ago < 60 ? ` ${ago}s ago` : ` ${Math.round(ago / 60)}m ago`;
      return { icon: "task_alt", text: `Saved locally${when}`, cls: "" };
    }
  }
});



function toggleLogs() {
  state.ui.showLogs = !state.ui.showLogs;
  if (state.ui.showLogs && state.ui.layout === "editor") state.ui.layout = "split";
}
</script>

<template>
  <header class="flex h-12 shrink-0 items-center gap-1 border-b border-header-border bg-header px-2 text-header-fg">
    <!-- Left: home, project title + folder, save state -->
    <button class="flex h-10 w-10 items-center justify-center rounded hover:bg-header-hover" title="All projects (⇧⌘P)" @click="closeProject()">
      <Logo :size="24" />
    </button>

    <div class="ml-1 flex min-w-0 items-center gap-3">
      <input
        v-if="editing"
        ref="titleInput"
        v-model="draft"
        class="w-72 rounded border border-accent bg-transparent px-2 py-1 text-[15px] font-semibold outline-none"
        @keydown.enter="commit"
        @keydown.esc="editing = false"
        @blur="commit"
      />
      <div v-else class="flex min-w-0 flex-col leading-tight">
        <button
          class="group flex min-w-0 items-center gap-1 rounded px-2 text-[15px] font-semibold hover:bg-header-hover"
          title="Rename project"
          @click="startEditing"
        >
          <span class="truncate">{{ state.displayName }}</span>
          <Icon name="edit" :size="14" class="opacity-0 transition-opacity group-hover:opacity-60" />
        </button>
        <button
          class="truncate px-2 text-left font-mono text-[11px] text-header-muted hover:text-header-fg hover:underline"
          :title="`${state.info?.root} — click to show in Finder`"
          @click="revealProject()"
        >
          {{ shortRoot }}
        </button>
      </div>
      <span class="flex shrink-0 items-center gap-1 text-[12px] text-header-muted" :title="state.info?.root">
        <Icon :name="saveStatus.icon" :size="15" :class="saveStatus.cls" />
        {{ saveStatus.text }}
      </span>
    </div>

    <div class="flex-1" />

    <!-- Right: compile and tools -->
    <RecompileButton class="mr-2" />

    <ToolbarButton
      icon="article"
      label="Logs"
      :active="state.ui.showLogs"
      :badge="counts.errors || counts.warnings"
      :badge-kind="counts.errors ? 'error' : 'warning'"
      @click="toggleLogs"
    />
    <ToolbarButton icon="toc" label="Outline" :active="state.ui.showOutline" @click="state.ui.showOutline = !state.ui.showOutline" />

  </header>
</template>
