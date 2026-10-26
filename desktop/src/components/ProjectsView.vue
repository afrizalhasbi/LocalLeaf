<script setup lang="ts">
// Overleaf's project dashboard, backed by local folders.
import { computed, ref, watch } from "vue";
import { open as openDialog } from "../lib/bridge";
import {
  createProject,
  forgetRecent,
  moveProjectFolder,
  openProject,
  renameProjectFolder,
  state,
  trashProject,
  type RecentProject,
} from "../lib/store";
import { ipc } from "../lib/ipc";
import ConfirmModal from "./ConfirmModal.vue";
import Dropdown from "./Dropdown.vue";
import Icon from "./Icon.vue";
import Logo from "./Logo.vue";
import MenuItem from "./MenuItem.vue";
import PromptModal from "./PromptModal.vue";

const search = ref("");
const naming = ref(false);
const renaming = ref<RecentProject | null>(null);
const trashing = ref<RecentProject | null>(null);

// File → New Project from the menu bar.
watch(
  () => state.ui.newProjectRequested,
  (requested) => {
    if (!requested) return;
    state.ui.newProjectRequested = false;
    naming.value = true;
  },
  { immediate: true },
);

function folderName(root: string) {
  return root.split(/[\\/]/).filter(Boolean).pop() ?? root;
}

async function confirmRename(name: string) {
  const p = renaming.value;
  renaming.value = null;
  if (p) await renameProjectFolder(p.root, name);
}

async function moveTo(p: RecentProject) {
  const dest = await openDialog({ directory: true, title: `Move “${p.name}” to…` });
  if (typeof dest === "string") await moveProjectFolder(p.root, dest);
}

async function confirmTrash() {
  const p = trashing.value;
  trashing.value = null;
  if (p) await trashProject(p.root);
}
const filtered = computed(() =>
  [...state.recent]
    .sort((a, b) => b.lastOpened - a.lastOpened)
    .filter((p) => p.name.toLowerCase().includes(search.value.toLowerCase()) || p.root.toLowerCase().includes(search.value.toLowerCase())),
);

async function openFolder() {
  const dir = await openDialog({ directory: true, title: "Open LaTeX project folder" });
  if (typeof dir === "string") await openProject(dir);
}

async function createBlank(name: string) {
  naming.value = false;
  const parent = await openDialog({ directory: true, title: `Choose where to create “${name}”` });
  if (typeof parent === "string") await createProject(parent, name);
}

function when(ts: number) {
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)} minutes ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)} hours ago`;
  return new Date(ts).toLocaleDateString();
}
function shortPath(root: string) {
  return root.replace(/^\/Users\/[^/]+/, "~");
}
</script>

<template>
  <div class="flex h-full flex-col bg-app text-surface-fg">
    <header class="flex h-12 shrink-0 items-center gap-2 border-b border-header-border bg-header px-4 text-header-fg">
      <Logo :size="26" />
      <span class="text-[17px] font-semibold tracking-tight">Local<span class="text-accent">Leaf</span></span>
      <span class="ml-2 rounded-full border border-header-muted/40 px-2 py-px text-[11px] text-header-muted">local-first</span>
    </header>

    <div class="flex min-h-0 flex-1">
      <aside class="flex w-60 shrink-0 flex-col gap-3 border-r border-divider bg-sidebar p-4 text-sidebar-fg">
        <Dropdown width="14rem">
          <template #trigger="{ toggle }">
            <button
              class="flex w-full items-center justify-center gap-1 rounded-full bg-accent px-4 py-2 text-[14px] font-semibold text-white hover:bg-accent-hover"
              @click="toggle"
            >
              New Project <Icon name="expand_more" :size="18" />
            </button>
          </template>
          <MenuItem icon="note_add" @select="naming = true">Blank project</MenuItem>
          <MenuItem icon="folder_open" @select="openFolder()">Open existing folder…</MenuItem>
        </Dropdown>
        <nav class="mt-2 flex flex-col">
          <span class="rounded bg-sidebar-selected px-3 py-2 text-[14px] font-semibold text-sidebar-selected-fg">All projects</span>
        </nav>
        <div class="flex-1" />
        <p class="text-[11.5px] leading-relaxed text-sidebar-muted">
          Projects are plain folders on your disk. Nothing leaves this machine; compilation uses your local TeX installation.
        </p>
      </aside>

      <main class="min-w-0 flex-1 overflow-auto px-10 py-8">
        <div class="mb-6 flex items-center gap-4">
          <h1 class="flex-1 text-[24px] font-semibold">All projects</h1>
          <div class="relative w-80">
            <Icon name="search" :size="18" class="absolute top-1/2 left-3 -translate-y-1/2 text-surface-muted" />
            <input
              v-model="search"
              placeholder="Search in all projects…"
              class="w-full rounded-full border border-surface-border bg-surface py-1.5 pr-3 pl-9 text-[13.5px] outline-none focus:border-accent"
            />
          </div>
        </div>

        <div v-if="!state.recent.length" class="mx-auto mt-16 max-w-md text-center">
          <Logo :size="64" class="mx-auto" />
          <h2 class="mt-4 text-[20px] font-semibold">Welcome to LocalLeaf</h2>
          <p class="mt-2 text-[14px] text-surface-muted">Create a new LaTeX project or open an existing folder to get started.</p>
          <div class="mt-6 flex justify-center gap-3">
            <button class="rounded-full bg-accent px-5 py-2 text-[14px] font-semibold text-white hover:bg-accent-hover" @click="naming = true">
              Create first project
            </button>
            <button class="rounded-full border border-surface-border px-5 py-2 text-[14px] font-semibold hover:bg-surface-hover" @click="openFolder()">
              Open folder
            </button>
          </div>
        </div>

        <table v-else class="w-full border-collapse text-[14px]">
          <thead>
            <tr class="border-b border-surface-border text-left text-[13px] text-surface-muted">
              <th class="py-2 pl-3 font-semibold">Title</th>
              <th class="py-2 font-semibold">Location</th>
              <th class="py-2 font-semibold">Last opened</th>
              <th class="w-24 py-2 text-right font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="p in filtered"
              :key="p.root"
              class="cursor-pointer border-b border-surface-border hover:bg-surface-hover"
              @click="openProject(p.root)"
            >
              <td class="py-2.5 pl-3 font-semibold text-accent">{{ p.name }}</td>
              <td class="max-w-0 truncate py-2.5 pr-4 font-mono text-[12px] text-surface-muted">{{ shortPath(p.root) }}</td>
              <td class="py-2.5 text-surface-muted">{{ when(p.lastOpened) }}</td>
              <td class="py-2.5 pr-2 text-right" @click.stop>
                <Dropdown align="right" width="14rem" class="inline-block">
                  <template #trigger="{ toggle, open }">
                    <button
                      class="rounded p-1 text-surface-muted hover:bg-surface-border"
                      :class="{ 'bg-surface-border': open }"
                      title="Actions"
                      @click="toggle"
                    >
                      <Icon name="more_vert" :size="20" />
                    </button>
                  </template>
                  <MenuItem icon="open_in_new" @select="openProject(p.root)">Open</MenuItem>
                  <MenuItem icon="edit" @select="renaming = p">Rename…</MenuItem>
                  <MenuItem icon="drive_file_move" @select="moveTo(p)">Move to…</MenuItem>
                  <MenuItem icon="folder_open" @select="ipc.revealInFileManager(p.root)">Show in Finder</MenuItem>
                  <div class="my-1 border-t border-surface-border" />
                  <MenuItem icon="playlist_remove" @select="forgetRecent(p.root)">Remove from list</MenuItem>
                  <MenuItem icon="delete" danger @select="trashing = p">Move to Trash…</MenuItem>
                </Dropdown>
              </td>
            </tr>
          </tbody>
        </table>
      </main>
    </div>

    <PromptModal
      v-if="renaming"
      title="Rename project"
      label="New name (the folder on disk is renamed too)"
      :initial="folderName(renaming.root)"
      confirm-label="Rename"
      @close="renaming = null"
      @confirm="confirmRename"
    />
    <ConfirmModal
      v-if="trashing"
      title="Move to Trash"
      :message="`Move the folder “${folderName(trashing.root)}” and all its files to the Trash? You can restore it from the Trash in Finder.`"
      confirm-label="Move to Trash"
      danger
      @close="trashing = null"
      @confirm="confirmTrash"
    />
    <PromptModal v-if="naming" title="New project" label="Project name" confirm-label="Choose location…" @close="naming = false" @confirm="createBlank" />
  </div>
</template>
