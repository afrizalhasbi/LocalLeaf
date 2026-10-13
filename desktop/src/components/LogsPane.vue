<script setup lang="ts">
// Overleaf's "Logs and output files" pane: clickable errors, warnings and typesetting issues.
import { computed, ref, watch } from "vue";
import type { Diagnostic } from "../lib/ipc";
import { ipc } from "../lib/ipc";
import { allFiles, compile, diagnostics, gotoLocation, recompileFromScratch, state } from "../lib/store";
import { hintFor, type LogHint } from "../lib/latex";
import { ENGINE_LABELS } from "../lib/ipc";
import Icon from "./Icon.vue";

const d = computed(() => diagnostics());
const rawLog = ref("");
const groups = computed(() => [
  { key: "error", label: "Error", items: d.value.errors, icon: "error", cls: "border-danger", head: "bg-danger text-white" },
  { key: "warning", label: "Warning", items: d.value.warnings, icon: "warning", cls: "border-warning", head: "bg-warning text-white" },
  { key: "bad_box", label: "Typesetting", items: d.value.badBoxes, icon: "info", cls: "border-info", head: "bg-info text-white" },
]);
const total = computed(() => d.value.errors.length + d.value.warnings.length + d.value.badBoxes.length);

watch(
  () => [state.ui.showRawLog, state.result] as const,
  async ([show, result]) => {
    if (!show || !result) return;
    rawLog.value = result.log_path
      ? await ipc.readFile(result.log_path).catch(() => result.stdout)
      : `${result.stdout}\n${result.stderr}`;
  },
  { immediate: true },
);

function hint(item: Diagnostic): LogHint | null {
  const main = state.mainDocument ? state.texts[state.mainDocument] ?? "" : "";
  return hintFor(item.message, state.result?.engine ?? state.engine, main, allFiles(state.tree));
}

function switchEngine(engine: LogHint["switchTo"]) {
  if (!engine) return;
  state.engine = engine;
  void compile();
}

function location(item: Diagnostic) {
  const file = item.file ?? state.mainDocument ?? "";
  return item.line ? `${file}, line ${item.line}` : file;
}
</script>

<template>
  <div class="flex h-full flex-col bg-surface text-surface-fg">
    <div class="flex h-10 shrink-0 items-center gap-2 border-b border-surface-border px-4">
      <h3 class="text-[14px] font-semibold">Logs</h3>
      <span v-if="state.result" class="text-[12px] text-surface-muted">
        {{ state.result.engine }} · {{ (state.result.duration_ms / 1000).toFixed(1) }}s
      </span>
      <div class="flex-1" />
      <button class="rounded p-1 text-surface-muted hover:bg-surface-hover" title="Close logs" @click="state.ui.showLogs = false">
        <Icon name="close" :size="18" />
      </button>
    </div>

    <div class="min-h-0 flex-1 space-y-3 overflow-auto p-4">
      <div v-if="state.compiling" class="flex items-center gap-2 text-[13px] text-surface-muted">
        <Icon name="progress_activity" class="spin" :size="18" /> Compiling…
      </div>

      <div v-if="state.compileError" class="overflow-hidden rounded border border-danger">
        <div class="flex items-center gap-2 bg-danger px-3 py-2 text-[13px] font-semibold text-white">
          <Icon name="error" :size="18" /> Compilation could not start
        </div>
        <p class="px-3 py-2 text-[13px]">{{ state.compileError }}</p>
      </div>

      <template v-if="state.result">
        <div
          v-if="!state.result.success"
          class="flex items-start gap-2 rounded bg-danger-light px-3 py-2.5 text-[13px]"
        >
          <Icon name="report" :size="18" class="text-danger" />
          <div v-if="state.result.pdf_path">
            <p class="font-semibold">Compiled with errors.</p>
            <p class="text-surface-muted">The PDF was produced anyway, but some content may be missing or wrong.</p>
          </div>
          <div v-else>
            <p class="font-semibold">This project did not compile.</p>
            <p class="text-surface-muted">
              {{ state.pdfData ? "Showing the last successfully compiled PDF. " : "" }}Fix the errors below and recompile.
            </p>
          </div>
        </div>
        <div v-else-if="!total" class="flex items-center gap-2 rounded bg-accent-light px-3 py-2.5 text-[13px]">
          <Icon name="check_circle" :size="18" class="text-accent" /> No errors or warnings. Nice!
        </div>

        <template v-for="g in groups" :key="g.key">
          <button
            v-for="(item, i) in g.items"
            :key="`${g.key}-${i}`"
            class="block w-full overflow-hidden rounded border text-left transition-shadow hover:shadow-md"
            :class="g.cls"
            :title="item.line ? 'Go to this line' : 'Open file'"
            @click="gotoLocation(item.file, item.line)"
          >
            <div class="flex items-center gap-2 px-3 py-1.5 text-[13px] font-semibold" :class="g.head">
              <Icon :name="g.icon" :size="17" />
              <span class="flex-1 truncate">{{ g.label }}</span>
              <span class="shrink-0 text-[12px] font-normal underline-offset-2 opacity-90 hover:underline">{{ location(item) }}</span>
            </div>
            <p class="px-3 py-2 font-mono text-[12px] break-words whitespace-pre-wrap">{{ item.message }}</p>
            <div
              v-if="hint(item)"
              class="mx-3 mb-2.5 flex items-start gap-2 rounded bg-info-light px-3 py-2 text-[12.5px] leading-snug"
              @click.stop
            >
              <Icon name="lightbulb" :size="17" class="text-info" />
              <div class="flex-1">
                <p>{{ hint(item)!.text }}</p>
                <button
                  v-if="hint(item)!.switchTo"
                  class="mt-1.5 rounded-full bg-accent px-3 py-1 text-[12px] font-semibold text-white hover:bg-accent-hover"
                  @click="switchEngine(hint(item)!.switchTo)"
                >
                  Switch to {{ ENGINE_LABELS[hint(item)!.switchTo!] }} and recompile
                </button>
              </div>
            </div>
          </button>
        </template>
      </template>

      <p v-if="!state.result && !state.compileError && !state.compiling" class="text-[13px] text-surface-muted">
        No compile output yet. Click Recompile to build the PDF.
      </p>

      <div v-if="state.result" class="flex flex-wrap gap-2 pt-1">
        <button
          class="rounded-full border border-surface-border px-3 py-1 text-[12.5px] font-semibold hover:bg-surface-hover"
          @click="state.ui.showRawLog = !state.ui.showRawLog"
        >
          {{ state.ui.showRawLog ? "Hide raw logs" : "View raw logs" }}
        </button>
        <button
          class="rounded-full border border-surface-border px-3 py-1 text-[12.5px] font-semibold hover:bg-surface-hover"
          @click="recompileFromScratch()"
        >
          Clear cached files
        </button>
        <button
          class="rounded-full border border-surface-border px-3 py-1 text-[12.5px] font-semibold hover:bg-surface-hover"
          @click="compile()"
        >
          Recompile
        </button>
      </div>
      <pre
        v-if="state.ui.showRawLog"
        class="max-h-[60vh] overflow-auto rounded border border-surface-border bg-surface-hover p-3 font-mono text-[11.5px] leading-snug whitespace-pre-wrap"
        >{{ rawLog }}</pre
      >
    </div>
  </div>
</template>
