<script setup lang="ts">
// Continuous-scroll PDF.js viewer with lazy page rendering, a selectable text layer,
// SyncTeX highlights and double-click inverse search.
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PdfLocation } from "../lib/ipc";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type ZoomMode = "fit-width" | "fit-page" | number;
export interface ViewerState {
  page: number;
  numPages: number;
  scale: number;
  mode: ZoomMode;
}

const props = defineProps<{
  data: Uint8Array | null;
  version: number;
  highlights?: PdfLocation[];
  highlightVersion?: number;
}>();
const emit = defineEmits<{ state: [s: ViewerState]; inverse: [page: number, x: number, y: number] }>();

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const PAGE_GAP = 12;
const MARGIN = 16;

interface PageSlot {
  el: HTMLDivElement;
  width: number; // PDF points at scale 1
  height: number;
  renderedScale: number | null;
  task: RenderTask | null;
  textLayer: pdfjs.TextLayer | null;
}

const scroller = ref<HTMLDivElement>();
const pagesHost = ref<HTMLDivElement>();
const loading = ref(false);
const loadError = ref<string | null>(null);
const pageCount = ref(0);

let doc: PDFDocumentProxy | null = null;
let docTask: PDFDocumentLoadingTask | null = null;
let slots: PageSlot[] = [];
let scale = 1;
let mode: ZoomMode = "fit-width";
let currentPage = 1;
let loadToken = 0;
let rafPending = false;

function emitState() {
  emit("state", { page: currentPage, numPages: slots.length, scale, mode });
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function load(data: Uint8Array) {
  const token = ++loadToken;
  loading.value = true;
  loadError.value = null;
  // Keep the reader's place across recompiles, like Overleaf.
  const sc = scroller.value!;
  const anchor = slots.length ? { page: currentPage, offset: offsetWithinPage(currentPage) } : null;
  try {
    const task = pdfjs.getDocument({ data: data.slice() });
    const next = await task.promise;
    if (token !== loadToken) {
      void task.destroy();
      return;
    }
    const sizes = await Promise.all(
      Array.from({ length: next.numPages }, async (_, i) => {
        const vp = (await next.getPage(i + 1)).getViewport({ scale: 1 });
        return { width: vp.width, height: vp.height };
      }),
    );
    if (token !== loadToken) {
      void task.destroy();
      return;
    }
    const oldTask = docTask;
    doc = next;
    docTask = task;
    buildSlots(sizes);
    computeFitScale();
    layout();
    if (anchor && anchor.page <= slots.length) {
      sc.scrollTop = pageTop(anchor.page) + anchor.offset * scale;
    }
    scheduleRender();
    void oldTask?.destroy();
  } catch (e) {
    if (token === loadToken) loadError.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (token === loadToken) loading.value = false;
  }
}

function buildSlots(sizes: { width: number; height: number }[]) {
  slots.forEach((s) => {
    s.task?.cancel();
    s.textLayer?.cancel();
  });
  const host = pagesHost.value!;
  // Reuse existing page elements so the old rendering stays visible until replaced.
  const oldEls = slots.map((s) => s.el);
  slots = sizes.map((size, i) => {
    let el = oldEls[i];
    if (!el) {
      el = document.createElement("div");
      el.className = "pdf-page";
      el.dataset.page = String(i + 1);
      host.appendChild(el);
    }
    return { el, ...size, renderedScale: null, task: null, textLayer: null };
  });
  oldEls.slice(sizes.length).forEach((el) => el.remove());
  pageCount.value = slots.length;
}

// ---------------------------------------------------------------------------
// Layout & rendering
// ---------------------------------------------------------------------------

function computeFitScale() {
  const sc = scroller.value;
  if (!sc || !slots.length || typeof mode === "number") return;
  const maxW = Math.max(...slots.map((s) => s.width));
  const availW = sc.clientWidth - 2 * MARGIN;
  const fitW = availW / maxW;
  if (mode === "fit-width") scale = fitW;
  else {
    const maxH = Math.max(...slots.map((s) => s.height));
    scale = Math.min(fitW, (sc.clientHeight - 2 * MARGIN) / maxH);
  }
  scale = Math.max(0.1, scale);
}

function layout() {
  for (const s of slots) {
    s.el.style.width = `${Math.floor(s.width * scale)}px`;
    s.el.style.height = `${Math.floor(s.height * scale)}px`;
    s.el.style.setProperty("--scale-factor", String(scale));
    s.el.style.setProperty("--total-scale-factor", String(scale));
  }
  drawHighlights(false);
  emitState();
}

function pageTop(page: number): number {
  const s = slots[page - 1];
  return s ? s.el.offsetTop - MARGIN : 0;
}

function offsetWithinPage(page: number): number {
  const sc = scroller.value!;
  return (sc.scrollTop - pageTop(page)) / scale;
}

function scheduleRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    renderVisible();
  });
}

function renderVisible() {
  const sc = scroller.value;
  if (!sc || !doc) return;
  const top = sc.scrollTop - sc.clientHeight;
  const bottom = sc.scrollTop + sc.clientHeight * 2;
  const mid = sc.scrollTop + sc.clientHeight / 3;
  slots.forEach((s, i) => {
    const t = s.el.offsetTop;
    const b = t + s.el.offsetHeight;
    if (t <= mid && b + PAGE_GAP > mid) currentPage = i + 1;
    if (b >= top && t <= bottom) void renderPage(i);
  });
  emitState();
}

async function renderPage(index: number) {
  const slot = slots[index];
  if (!doc || !slot || slot.renderedScale === scale) return;
  const renderScale = scale;
  const currentDoc = doc;
  slot.renderedScale = renderScale;
  slot.task?.cancel();
  slot.textLayer?.cancel();

  const page = await currentDoc.getPage(index + 1);
  if (doc !== currentDoc || slot.renderedScale !== renderScale) return;
  const viewport = page.getViewport({ scale: renderScale });
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  canvas.className = "pdf-canvas";

  const task = page.render({
    canvas,
    viewport,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
  });
  slot.task = task;
  try {
    await task.promise;
  } catch {
    return; // cancelled by a newer render
  }
  if (doc !== currentDoc || slot.renderedScale !== renderScale) return;

  const textDiv = document.createElement("div");
  textDiv.className = "textLayer";
  const textLayer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: textDiv, viewport });
  slot.textLayer = textLayer;

  // Swap the new rendering in only once it is complete, so recompiles don't flash.
  slot.el.querySelectorAll(".pdf-canvas, .textLayer").forEach((n) => n.remove());
  slot.el.prepend(canvas);
  slot.el.appendChild(textDiv);
  textLayer.render().catch(() => undefined);
}

function setScale(next: number, nextMode: ZoomMode) {
  const sc = scroller.value!;
  const page = currentPage;
  const offset = offsetWithinPage(page);
  mode = nextMode;
  scale = Math.min(5, Math.max(0.1, next));
  if (typeof nextMode !== "number") computeFitScale();
  layout();
  sc.scrollTop = pageTop(page) + offset * scale;
  scheduleRender();
}

// ---------------------------------------------------------------------------
// Public API (used by the PDF toolbar)
// ---------------------------------------------------------------------------

function zoomIn() {
  const next = ZOOM_STEPS.find((z) => z > scale + 0.001) ?? scale;
  setScale(next, next);
}
function zoomOut() {
  const next = [...ZOOM_STEPS].reverse().find((z) => z < scale - 0.001) ?? scale;
  setScale(next, next);
}
function setZoom(m: ZoomMode) {
  setScale(typeof m === "number" ? m : scale, m);
}
function gotoPage(page: number) {
  const p = Math.min(Math.max(1, page), slots.length);
  scroller.value?.scrollTo({ top: pageTop(p) });
}

defineExpose({ zoomIn, zoomOut, setZoom, gotoPage });

// ---------------------------------------------------------------------------
// SyncTeX
// ---------------------------------------------------------------------------

function drawHighlights(scrollIntoView: boolean) {
  pagesHost.value?.querySelectorAll(".synctex-highlight").forEach((n) => n.remove());
  const boxes = props.highlights ?? [];
  if (!boxes.length) return;
  let first: HTMLElement | null = null;
  for (const b of boxes) {
    const slot = slots[b.page - 1];
    if (!slot) continue;
    const el = document.createElement("div");
    el.className = "synctex-highlight";
    const pad = 2;
    el.style.left = `${b.h * scale - pad}px`;
    el.style.top = `${(b.v - b.height) * scale - pad}px`;
    el.style.width = `${Math.max(b.width, 8) * scale + 2 * pad}px`;
    el.style.height = `${Math.max(b.height, 8) * scale + 2 * pad}px`;
    slot.el.appendChild(el);
    first ??= el;
  }
  if (scrollIntoView && first) {
    const sc = scroller.value!;
    const slotTop = (first.parentElement as HTMLElement).offsetTop;
    sc.scrollTo({ top: slotTop + first.offsetTop - sc.clientHeight / 3, behavior: "smooth" });
  }
}

function onDblClick(e: MouseEvent) {
  const pageEl = (e.target as HTMLElement).closest<HTMLElement>(".pdf-page");
  if (!pageEl) return;
  const rect = pageEl.getBoundingClientRect();
  const page = Number(pageEl.dataset.page);
  emit("inverse", page, (e.clientX - rect.left) / scale, (e.clientY - rect.top) / scale);
}

function onWheel(e: WheelEvent) {
  // Pinch-to-zoom on trackpads arrives as ctrl+wheel.
  if (!e.ctrlKey) return;
  e.preventDefault();
  const factor = Math.exp(-e.deltaY / 100);
  setScale(scale * factor, scale * factor);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let resizeObserver: ResizeObserver | null = null;
let resizeTimer: ReturnType<typeof setTimeout> | undefined;

onMounted(() => {
  resizeObserver = new ResizeObserver(() => {
    if (typeof mode === "number") return scheduleRender();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => setScale(scale, mode), 60);
  });
  resizeObserver.observe(scroller.value!);
  if (props.data) void load(props.data);
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  loadToken++;
  slots.forEach((s) => s.task?.cancel());
  void docTask?.destroy();
  doc = null;
  docTask = null;
});

watch(
  () => [props.data, props.version] as const,
  ([data]) => {
    if (data) void load(data);
  },
);
watch(
  () => props.highlightVersion,
  () => drawHighlights(true),
);
</script>

<template>
  <div
    ref="scroller"
    class="relative h-full overflow-auto bg-pdf"
    @scroll.passive="scheduleRender"
    @dblclick="onDblClick"
    @wheel="onWheel"
  >
    <div ref="pagesHost" class="flex flex-col items-center gap-3 py-4" />
    <div v-if="loading && !pageCount" class="absolute inset-0 flex items-center justify-center text-[13px] text-white/80">
      Loading PDF…
    </div>
    <div v-if="loadError" class="absolute inset-x-4 top-4 rounded bg-danger px-3 py-2 text-[13px] text-white">
      Could not display the PDF: {{ loadError }}
    </div>
  </div>
</template>

<style scoped>
:deep(.pdf-page) {
  position: relative;
  flex-shrink: 0;
  background: #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
}
:deep(.pdf-canvas) {
  position: absolute;
  inset: 0;
  display: block;
}
:deep(.textLayer) {
  user-select: text;
  -webkit-user-select: text;
}
</style>
