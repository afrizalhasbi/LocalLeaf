<script setup lang="ts">
// Vertical drag handle between panels, like Overleaf's split-pane resizers.
import { ref } from "vue";

const emit = defineEmits<{ drag: [dx: number]; dragEnd: []; toggle: [] }>();
const dragging = ref(false);

function onPointerDown(e: PointerEvent) {
  if ((e.target as HTMLElement).closest("button")) return;
  e.preventDefault();
  dragging.value = true;
  let last = e.clientX;
  const el = e.currentTarget as HTMLElement;
  el.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => {
    emit("drag", ev.clientX - last);
    last = ev.clientX;
  };
  const up = () => {
    dragging.value = false;
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    emit("dragEnd");
  };
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
}
</script>

<template>
  <div
    class="group relative z-10 flex w-[7px] shrink-0 cursor-col-resize flex-col items-center justify-center bg-toolbar transition-colors hover:bg-accent/40"
    :class="{ 'bg-accent/60': dragging }"
    style="border-left: 1px solid var(--divider); border-right: 1px solid var(--divider)"
    role="separator"
    aria-orientation="vertical"
    @pointerdown="onPointerDown"
    @dblclick="emit('toggle')"
  >
    <slot />
    <!-- While dragging, cover iframes/canvases so pointer events are not swallowed. -->
    <div v-if="dragging" class="fixed inset-0 z-50 cursor-col-resize" />
  </div>
</template>
