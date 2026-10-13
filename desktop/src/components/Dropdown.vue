<script setup lang="ts">
// Overleaf-style dropdown menu: closes on outside click, Escape, or item selection.
import { onBeforeUnmount, ref, watch } from "vue";

const props = withDefaults(defineProps<{ align?: "left" | "right"; width?: string }>(), {
  align: "left",
  width: "15rem",
});

const open = ref(false);
const root = ref<HTMLElement>();

function toggle() {
  open.value = !open.value;
}
function close() {
  open.value = false;
}

function onDocMouseDown(e: MouseEvent) {
  if (root.value && !root.value.contains(e.target as Node)) close();
}
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") close();
}

watch(open, (isOpen) => {
  if (isOpen) {
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
  } else {
    document.removeEventListener("mousedown", onDocMouseDown);
    document.removeEventListener("keydown", onKey);
  }
});
onBeforeUnmount(close);

defineExpose({ close });
</script>

<template>
  <div ref="root" class="relative">
    <slot name="trigger" :toggle="toggle" :open="open" />
    <div
      v-if="open"
      class="absolute top-full z-50 mt-1 rounded-md border border-surface-border bg-surface py-1 text-surface-fg shadow-xl"
      :class="props.align === 'right' ? 'right-0' : 'left-0'"
      :style="{ width: props.width }"
      @click="close"
    >
      <slot />
    </div>
  </div>
</template>
