<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import type { FileNode } from "../lib/ipc";
import { basename, dirname } from "../lib/latex";
import { deletePath, findNode, newFile, newFolder, renamePath, state } from "../lib/store";
import { uploadFiles } from "../lib/actions";
import ConfirmModal from "./ConfirmModal.vue";
import FileTreeItem from "./FileTreeItem.vue";
import Icon from "./Icon.vue";
import MenuItem from "./MenuItem.vue";
import OutlinePanel from "./OutlinePanel.vue";
import PromptModal from "./PromptModal.vue";

const modal = ref<null | "delete">(null);
const renaming = ref<string | null>(null);
const deleteTarget = ref<string | null>(null);
const selectedNode = computed(() => (state.selectedPath ? findNode(state.selectedPath) : null));

function startRename(path = state.selectedPath) {
  if (path) renaming.value = path;
}
function askDelete(path = state.selectedPath) {
  if (!path) return;
  deleteTarget.value = path;
  modal.value = "delete";
}
async function confirmDelete() {
  modal.value = null;
  if (deleteTarget.value) await deletePath(deleteTarget.value);
}

// Context menu
const menu = ref<{ x: number; y: number; node: FileNode | null } | null>(null);
function openMenu(e: MouseEvent, node: FileNode | null) {
  if (node) state.selectedPath = node.path;
  menu.value = { x: e.clientX, y: e.clientY, node };
  document.addEventListener("mousedown", closeMenuOutside);
}
function closeMenu() {
  menu.value = null;
  document.removeEventListener("mousedown", closeMenuOutside);
}
function closeMenuOutside(e: MouseEvent) {
  if (!(e.target as HTMLElement).closest("[data-context-menu]")) closeMenu();
}
onBeforeUnmount(closeMenu);
function hideSidebar() {
  state.ui.sidebarCollapsed = true;
}
function setFileModal(kind: typeof state.ui.fileModal) {
  state.ui.fileModal = kind;
}
function setMain(path: string) {
  state.mainDocument = path;
}
function menuAction(fn: () => void) {
  closeMenu();
  fn();
}

async function moveInto(from: string, toDir: string) {
  if (toDir === from || toDir.startsWith(from + "/") || dirname(from) === toDir) return;
  await renamePath(from, toDir ? `${toDir}/${basename(from)}` : basename(from));
  if (toDir) state.expanded[toDir] = true;
}
const rootDragOver = ref(false);
function onRootDrop(e: DragEvent) {
  rootDragOver.value = false;
  const from = e.dataTransfer?.getData("text/x-texcraft-path");
  if (from) void moveInto(from, "");
}
</script>

<template>
  <aside class="flex h-full min-w-0 flex-col bg-sidebar text-sidebar-fg">
    <!-- File actions (Overleaf's file tree toolbar) -->
    <div class="flex h-9 shrink-0 items-center gap-0.5 border-b border-divider px-1.5">
      <button class="tree-btn" title="New file" @click="state.ui.fileModal = 'file'"><Icon name="note_add" :size="19" /></button>
      <button class="tree-btn" title="New folder" @click="state.ui.fileModal = 'folder'"><Icon name="create_new_folder" :size="19" /></button>
      <button class="tree-btn" title="Upload" @click="uploadFiles()"><Icon name="upload" :size="19" /></button>
      <div class="flex-1" />
      <template v-if="selectedNode">
        <button class="tree-btn" title="Rename" @click="startRename()"><Icon name="edit" :size="18" /></button>
        <button class="tree-btn" title="Delete" @click="askDelete()"><Icon name="delete" :size="18" /></button>
      </template>
      <div class="mx-0.5 h-5 border-l border-divider" />
      <button class="tree-btn" title="Hide sidebar (⌥⌘B)" @click="hideSidebar()">
        <Icon name="keyboard_double_arrow_left" :size="19" />
      </button>
    </div>

    <div
      class="min-h-0 flex-1 overflow-auto py-1"
      :class="{ 'bg-accent/10': rootDragOver }"
      @contextmenu.self.prevent="openMenu($event, null)"
      @click.self="state.selectedPath = null"
      @dragover.self.prevent="rootDragOver = true"
      @dragleave.self="rootDragOver = false"
      @drop.self="onRootDrop"
    >
      <ul>
        <FileTreeItem
          v-for="node in state.tree"
          :key="node.path"
          :node="node"
          :depth="0"
          :renaming="renaming"
          @contextmenu="openMenu"
          @start-rename="startRename"
          @end-rename="renaming = null"
          @drop="moveInto"
        />
      </ul>
      <p v-if="!state.tree.length" class="px-4 py-3 text-[12px] text-sidebar-muted">This folder is empty.</p>
    </div>

    <OutlinePanel />

    <!-- Right-click menu -->
    <Teleport to="body">
      <div
        v-if="menu"
        data-context-menu
        class="fixed z-[150] w-56 rounded-md border border-surface-border bg-surface py-1 text-surface-fg shadow-xl"
        :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      >
        <template v-if="menu.node">
          <MenuItem icon="edit" @select="menuAction(() => startRename(menu!.node!.path))">Rename</MenuItem>
          <MenuItem icon="delete" danger @select="menuAction(() => askDelete(menu!.node!.path))">Delete</MenuItem>
          <MenuItem
            v-if="menu.node.path.endsWith('.tex')"
            icon="star"
            :checked="state.mainDocument === menu.node.path"
            @select="menuAction(() => setMain(menu!.node!.path))"
            >Set as main document</MenuItem
          >
          <div class="my-1 border-t border-surface-border" />
        </template>
        <MenuItem icon="note_add" @select="menuAction(() => setFileModal('file'))">New file</MenuItem>
        <MenuItem icon="create_new_folder" @select="menuAction(() => setFileModal('folder'))">New folder</MenuItem>
        <MenuItem icon="upload" @select="menuAction(() => uploadFiles())">Upload</MenuItem>
      </div>
    </Teleport>

    <PromptModal
      v-if="state.ui.fileModal === 'file'"
      title="Add files"
      label="File name"
      initial="name.tex"
      select-stem
      @close="setFileModal(null)"
      @confirm="(n) => { setFileModal(null); newFile(n); }"
    />
    <PromptModal
      v-if="state.ui.fileModal === 'folder'"
      title="Add folder"
      label="Folder name"
      @close="setFileModal(null)"
      @confirm="(n) => { setFileModal(null); newFolder(n); }"
    />
    <ConfirmModal
      v-if="modal === 'delete' && deleteTarget"
      title="Delete"
      :message="`Are you sure you want to permanently delete ${deleteTarget}? This removes it from disk.`"
      confirm-label="Delete"
      danger
      @close="modal = null"
      @confirm="confirmDelete"
    />
  </aside>
</template>

<style scoped>
@reference "../style.css";
.tree-btn {
  @apply flex h-7 w-7 items-center justify-center rounded text-sidebar-fg hover:bg-sidebar-hover;
}
</style>
