<script setup lang="ts">
import { computed, ref } from "vue";
import { compile, state, syncToCode } from "../lib/store";
import { downloadPdf } from "../lib/actions";
import Dropdown from "./Dropdown.vue";
import Icon from "./Icon.vue";
import LogsPane from "./LogsPane.vue";
import MenuItem from "./MenuItem.vue";
import PdfViewer, { type ViewerState, type ZoomMode } from "./PdfViewer.vue";

const viewer = ref<InstanceType<typeof PdfViewer>>();
const vs = ref<ViewerState>({ page: 1, numPages: 0, scale: 1, mode: "fit-width" });
const pageInput = ref("");

const zoomLabel = computed(() => `${Math.round(vs.value.scale * 100)}%`);
const presets: { label: string; mode: ZoomMode }[] = [
  { label: "Fit to width", mode: "fit-width" },
  { label: "Fit to page", mode: "fit-page" },
  { label: "50%", mode: 0.5 },
  { label: "75%", mode: 0.75 },
  { label: "100%", mode: 1 },
  { label: "150%", mode: 1.5 },
  { label: "200%", mode: 2 },
  { label: "400%", mode: 4 },
];

function onState(s: ViewerState) {
  vs.value = s;
  if (document.activeElement?.id !== "pdf-page-input") pageInput.value = String(s.page);
}
function submitPage() {
  const n = parseInt(pageInput.value, 10);
  if (!Number.isNaN(n)) viewer.value?.gotoPage(n);
}
</script>

<template>
  <div class="relative flex h-full min-w-0 flex-col bg-pdf">
    <!-- PDF toolbar -->
    <div class="flex h-9 shrink-0 items-center gap-1 border-b border-divider bg-toolbar px-2 text-toolbar-fg">
      <template v-if="state.pdfData">
        <button class="pdf-btn" title="Previous page" :disabled="vs.page <= 1" @click="viewer?.gotoPage(vs.page - 1)">
          <Icon name="keyboard_arrow_up" />
        </button>
        <button class="pdf-btn" title="Next page" :disabled="vs.page >= vs.numPages" @click="viewer?.gotoPage(vs.page + 1)">
          <Icon name="keyboard_arrow_down" />
        </button>
        <input
          id="pdf-page-input"
          v-model="pageInput"
          class="h-6 w-9 rounded border border-surface-border bg-surface text-center text-[12px] text-surface-fg outline-none focus:border-accent"
          @keydown.enter="submitPage"
          @blur="pageInput = String(vs.page)"
        />
        <span class="text-[12px] opacity-70">/ {{ vs.numPages }}</span>
      </template>
      <span v-else class="pl-1 text-[12.5px] opacity-70">PDF preview</span>

      <div class="flex-1" />

      <template v-if="state.pdfData">
        <button class="pdf-btn" title="Zoom out" @click="viewer?.zoomOut()"><Icon name="remove" /></button>
        <Dropdown align="right" width="10rem">
          <template #trigger="{ toggle }">
            <button class="flex h-7 items-center gap-0.5 rounded px-2 text-[12.5px] hover:bg-header-hover" @click="toggle">
              {{ zoomLabel }} <Icon name="expand_more" :size="16" />
            </button>
          </template>
          <MenuItem icon="zoom_in" @select="viewer?.zoomIn()">Zoom in</MenuItem>
          <MenuItem icon="zoom_out" @select="viewer?.zoomOut()">Zoom out</MenuItem>
          <div class="my-1 border-t border-surface-border" />
          <MenuItem v-for="p in presets" :key="p.label" :checked="vs.mode === p.mode" @select="viewer?.setZoom(p.mode)">
            {{ p.label }}
          </MenuItem>
        </Dropdown>
        <button class="pdf-btn" title="Zoom in" @click="viewer?.zoomIn()"><Icon name="add" /></button>
        <div class="mx-1 h-5 border-l border-surface-border" />
        <button class="pdf-btn" title="Download PDF" @click="downloadPdf()"><Icon name="download" /></button>
      </template>
    </div>

    <div class="relative min-h-0 flex-1">
      <PdfViewer
        v-if="state.pdfData"
        ref="viewer"
        :data="state.pdfData"
        :version="state.pdfVersion"
        :highlights="state.highlights"
        :highlight-version="state.highlightVersion"
        class="absolute inset-0"
        @state="onState"
        @inverse="syncToCode"
      />
      <div v-else class="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center text-white/85">
        <template v-if="state.compiling">
          <Icon name="progress_activity" class="spin" :size="36" />
          <p class="text-[14px]">Compiling your project…</p>
        </template>
        <template v-else>
          <Icon name="picture_as_pdf" :size="44" />
          <p class="text-[14px]">Click Recompile to see a preview of your document</p>
          <button class="rounded-full bg-accent px-4 py-1.5 text-[13px] font-semibold text-white hover:bg-accent-hover" @click="compile()">
            Recompile
          </button>
        </template>
      </div>

      <!-- Thin progress bar while recompiling over an existing PDF -->
      <div v-if="state.compiling && state.pdfData" class="absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-accent/30">
        <div class="h-full w-1/3 animate-[progress_1.2s_ease-in-out_infinite] bg-accent" />
      </div>

      <LogsPane v-if="state.ui.showLogs" class="absolute inset-0 z-20" />
    </div>
  </div>
</template>

<style scoped>
@reference "../style.css";
.pdf-btn {
  @apply flex h-7 w-7 items-center justify-center rounded hover:bg-header-hover disabled:opacity-35 disabled:hover:bg-transparent;
}
@keyframes progress {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(300%);
  }
}
</style>
