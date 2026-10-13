<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue";
import Icon from "./Icon.vue";

const props = withDefaults(defineProps<{ title: string; width?: string }>(), { width: "32rem" });
const emit = defineEmits<{ close: [] }>();

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}
onMounted(() => document.addEventListener("keydown", onKey));
onBeforeUnmount(() => document.removeEventListener("keydown", onKey));
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-[100] flex items-start justify-center bg-black/50 pt-[10vh]" @mousedown.self="emit('close')">
      <div
        class="flex max-h-[80vh] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg bg-surface text-surface-fg shadow-2xl"
        :style="{ width: props.width }"
        role="dialog"
        aria-modal="true"
      >
        <header class="flex items-center justify-between border-b border-surface-border px-5 py-3.5">
          <h2 class="text-[17px] font-semibold">{{ props.title }}</h2>
          <button class="rounded p-1 text-surface-muted hover:bg-surface-hover" aria-label="Close" @click="emit('close')">
            <Icon name="close" />
          </button>
        </header>
        <div class="min-h-0 flex-1 overflow-auto">
          <slot />
        </div>
        <footer v-if="$slots.footer" class="flex justify-end gap-2 border-t border-surface-border px-5 py-3">
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>
