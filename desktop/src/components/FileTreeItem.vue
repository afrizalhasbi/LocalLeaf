<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { FileNode } from "../lib/ipc";
import { openFile, renamePath, state } from "../lib/store";
import { dirname } from "../lib/latex";
import { iconForFile } from "./fileIcons";
import Icon from "./Icon.vue";

defineOptions({ name: "FileTreeItem" });

const props = defineProps<{ node: FileNode; depth: number; renaming: string | null }>();
const emit = defineEmits<{
  contextmenu: [e: MouseEvent, node: FileNode];
  startRename: [path: string];
  endRename: [];
  drop: [from: string, toDir: string];
}>();

const expanded = computed(() => !!state.expanded[props.node.path]);
const selected = computed(() => state.selectedPath === props.node.path);
const isMain = computed(() => state.mainDocument === props.node.path);
const icon = computed(() =>
  props.node.isDir ? { icon: expanded.value ? "folder_open" : "folder", color: "#9aa3b2" } : iconForFile(props.node.path),
);
const dragOver = ref(false);

function onClick() {
  state.selectedPath = props.node.path;
  if (props.node.isDir) state.expanded[props.node.path] = !expanded.value;
  else void openFile(props.node.path);
}

const renameValue = ref("");
const renameInput = ref<HTMLInputElement>();
const isRenaming = computed(() => props.renaming === props.node.path);
watch(isRenaming, async (v) => {
  if (!v) return;
  renameValue.value = props.node.name;
  await nextTick();
  const dot = props.node.isDir ? -1 : props.node.name.lastIndexOf(".");
  renameInput.value?.focus();
  renameInput.value?.setSelectionRange(0, dot > 0 ? dot : props.node.name.length);
});
async function commitRename() {
  if (!isRenaming.value) return;
  const name = renameValue.value.trim();
  emit("endRename");
  if (!name || name === props.node.name || name.includes("/")) return;
  const dir = dirname(props.node.path);
  await renamePath(props.node.path, dir ? `${dir}/${name}` : name);
}

function onDragStart(e: DragEvent) {
  e.dataTransfer?.setData("text/x-texcraft-path", props.node.path);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
}
function onDragOver(e: DragEvent) {
  if (!props.node.isDir || !e.dataTransfer?.types.includes("text/x-texcraft-path")) return;
  e.preventDefault();
  dragOver.value = true;
}
function onDrop(e: DragEvent) {
  dragOver.value = false;
  const from = e.dataTransfer?.getData("text/x-texcraft-path");
  if (!from || !props.node.isDir) return;
  e.preventDefault();
  e.stopPropagation();
  emit("drop", from, props.node.path);
}
</script>

<template>
  <li>
    <div
      class="group flex h-7 cursor-pointer items-center gap-1 pr-2 text-[13px]"
      :class="[
        selected ? 'bg-sidebar-selected text-sidebar-selected-fg' : 'hover:bg-sidebar-hover',
        dragOver ? 'outline-2 -outline-offset-2 outline-accent' : '',
      ]"
      :style="{ paddingLeft: `${8 + depth * 16}px` }"
      :draggable="!isRenaming"
      :title="node.path"
      @click="onClick"
      @dblclick.stop="!node.isDir && emit('startRename', node.path)"
      @contextmenu.prevent="emit('contextmenu', $event, node)"
      @dragstart="onDragStart"
      @dragover="onDragOver"
      @dragleave="dragOver = false"
      @drop="onDrop"
    >
      <Icon
        v-if="node.isDir"
        :name="expanded ? 'expand_more' : 'chevron_right'"
        :size="18"
        class="text-sidebar-muted"
        :class="{ 'text-sidebar-selected-fg': selected }"
      />
      <span v-else class="w-[18px]" />
      <Icon :name="icon.icon" :size="18" :fill="node.isDir" :style="{ color: selected ? undefined : icon.color }" />
      <input
        v-if="isRenaming"
        ref="renameInput"
        v-model="renameValue"
        class="ml-1 min-w-0 flex-1 rounded border border-accent bg-surface px-1 text-[13px] text-surface-fg outline-none"
        @click.stop
        @keydown.enter="commitRename"
        @keydown.esc="emit('endRename')"
        @blur="commitRename"
      />
      <span v-else class="ml-1 flex-1 truncate">{{ node.name }}</span>
      <Icon v-if="isMain && !isRenaming" name="star" :size="14" fill class="opacity-70" title="Main document" />
    </div>
    <ul v-if="node.isDir && expanded">
      <FileTreeItem
        v-for="child in node.children"
        :key="child.path"
        :node="child"
        :depth="depth + 1"
        :renaming="renaming"
        @contextmenu="(e, n) => emit('contextmenu', e, n)"
        @start-rename="(p) => emit('startRename', p)"
        @end-rename="emit('endRename')"
        @drop="(f, t) => emit('drop', f, t)"
      />
    </ul>
  </li>
</template>
