<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { pathForFile } from "../lib/bridge";
import { compile, importFiles, state, syncToPdf } from "../lib/store";
import { syncFromPdfView } from "../lib/pdfSync";
import { readStored, writeStored } from "../lib/storage";
import EditorPane from "./EditorPane.vue";
import HeaderBar from "./HeaderBar.vue";
import Icon from "./Icon.vue";
import PdfPane from "./PdfPane.vue";
import ResizeHandle from "./ResizeHandle.vue";
import Sidebar from "./Sidebar.vue";

// Panel sizes, remembered across sessions.
function stored(key: string, fallback: number) {
  const v = Number(readStored(key));
  return v > 0 ? v : fallback;
}
const sidebarWidth = ref(stored("sidebarWidth", 240));
const pdfRatio = ref(stored("pdfRatio", 0.5));
const splitArea = ref<HTMLDivElement>();

watch([sidebarWidth, pdfRatio], () => {
  try {
    writeStored("sidebarWidth", String(sidebarWidth.value));
    writeStored("pdfRatio", String(pdfRatio.value));
  } catch {
    /* ignore */
  }
});

function dragSidebar(dx: number) {
  state.ui.sidebarCollapsed = false;
  sidebarWidth.value = Math.min(520, Math.max(160, sidebarWidth.value + dx));
}
function dragSplit(dx: number) {
  const w = splitArea.value?.clientWidth ?? 1;
  pdfRatio.value = Math.min(0.8, Math.max(0.2, pdfRatio.value - dx / w));
}

const showEditor = computed(() => state.ui.layout !== "pdf");
const showPdf = computed(() => state.ui.layout !== "editor");
const canSync = computed(() => state.synctexAvailable && !!state.pdfData);

// Global shortcuts (also when the focus is in the PDF or the file tree).
function onKey(e: KeyboardEvent) {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key === "Enter") {
    e.preventDefault();
    void compile();
  } else if (mod && e.key.toLowerCase() === "s") {
    e.preventDefault();
    void compile();
  }
}

// Files dragged in from the OS file manager are uploaded into the selected folder.
const dropping = ref(false);
let dragDepth = 0;
function onDragEnter(e: DragEvent) {
  if (!e.dataTransfer?.types.includes("Files")) return;
  e.preventDefault();
  dragDepth++;
  dropping.value = true;
}
function onDragOver(e: DragEvent) {
  if (!e.dataTransfer?.types.includes("Files")) return;
  e.preventDefault(); // needed so the drop is allowed
  dropping.value = true;
}
function onDragLeave() {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropping.value = false;
}
function onDrop(e: DragEvent) {
  e.preventDefault();
  dragDepth = 0;
  dropping.value = false;
  const files = Array.from(e.dataTransfer?.files ?? []);
  const paths = files.map((f) => pathForFile(f) ?? f.name).filter((p) => !!p);
  if (paths.length) void importFiles(paths);
}
onMounted(() => {
  window.addEventListener("keydown", onKey);
  window.addEventListener("dragenter", onDragEnter);
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("dragleave", onDragLeave);
  window.addEventListener("drop", onDrop);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("dragenter", onDragEnter);
  window.removeEventListener("dragover", onDragOver);
  window.removeEventListener("dragleave", onDragLeave);
  window.removeEventListener("drop", onDrop);
});

</script>

<template>
  <div class="flex h-full flex-col">
    <HeaderBar />

    <div class="relative flex min-h-0 flex-1">
      <!-- B. Sidebar -->
      <template v-if="!state.ui.sidebarCollapsed">
        <Sidebar :style="{ width: `${sidebarWidth}px` }" class="shrink-0" />
        <ResizeHandle title="Drag to resize, double-click to hide" @drag="dragSidebar" @toggle="state.ui.sidebarCollapsed = true" />
      </template>
      <!-- Collapsed sidebar: a slim strip with the arrow to bring it back -->
      <div v-else class="flex w-9 shrink-0 flex-col items-center border-r border-divider bg-sidebar text-sidebar-fg">
        <button
          class="mt-1 flex h-7 w-7 items-center justify-center rounded hover:bg-sidebar-hover"
          title="Show sidebar (⌥⌘B)"
          @click="state.ui.sidebarCollapsed = false"
        >
          <Icon name="keyboard_double_arrow_right" :size="19" />
        </button>
      </div>

      <div ref="splitArea" class="flex min-w-0 flex-1">
        <!-- C. Editor -->
        <section v-show="showEditor" class="min-w-0 flex-1">
          <EditorPane />
        </section>

        <!-- SyncTeX arrows live on the divider, as in Overleaf -->
        <ResizeHandle v-if="showEditor && showPdf" class="w-[14px]!" @drag="dragSplit">
          <div class="flex flex-col gap-1.5">
            <button
              class="sync-btn"
              :disabled="!canSync"
              title="Go to code location in PDF (→)"
              @click="syncToPdf()"
            >
              <Icon name="arrow_forward" :size="14" />
            </button>
            <button
              class="sync-btn"
              :disabled="!canSync"
              title="Go to PDF location in code (←). Tip: double-click the PDF"
              @click="syncFromPdfView()"
            >
              <Icon name="arrow_back" :size="14" />
            </button>
          </div>
        </ResizeHandle>

        <!-- D. PDF -->
        <section
          v-show="showPdf"
          class="min-w-0"
          :style="showEditor ? { flex: `0 0 ${pdfRatio * 100}%` } : { flex: '1 1 0' }"
        >
          <PdfPane />
        </section>
      </div>

      <div
        v-if="dropping"
        class="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent/15 text-[15px] font-semibold text-white"
      >
        <span class="rounded-full bg-accent px-4 py-2">Drop files to upload them to {{ state.selectedPath ? "the selected folder" : "the project" }}</span>
      </div>
    </div>

  </div>
</template>

<style scoped>
@reference "../style.css";
.sync-btn {
  @apply flex h-6 w-[12px] items-center justify-center rounded-sm bg-accent text-white shadow hover:bg-accent-hover disabled:bg-surface-muted disabled:opacity-60;
}
</style>
