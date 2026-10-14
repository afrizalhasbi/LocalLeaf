<script setup lang="ts">
// Accessible dialog: labelled, focus moves inside on open, Tab stays inside, focus returns
// to where it was on close.
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import Icon from "./Icon.vue";

const props = withDefaults(defineProps<{ title: string; width?: string }>(), { width: "32rem" });
const emit = defineEmits<{ close: [] }>();

const dialog = ref<HTMLElement>();
const titleId = `modal-title-${Math.random().toString(36).slice(2, 9)}`;
let previousFocus: HTMLElement | null = null;

const FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    emit("close");
    return;
  }
  if (e.key !== "Tab" || !dialog.value) return;
  const els = [...dialog.value.querySelectorAll<HTMLElement>(FOCUSABLE)];
  if (!els.length) return;
  const first = els[0];
  const last = els[els.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

onMounted(async () => {
  previousFocus = document.activeElement as HTMLElement | null;
  document.addEventListener("keydown", onKey);
  await nextTick();
  // An autofocus field inside (e.g. a name prompt) wins; otherwise focus the dialog itself.
  if (!dialog.value?.contains(document.activeElement)) dialog.value?.focus();
});
onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKey);
  previousFocus?.focus?.();
});
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-[100] flex items-start justify-center bg-black/50 pt-[10vh]" @mousedown.self="emit('close')">
      <div
        ref="dialog"
        class="flex max-h-[80vh] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg bg-surface text-surface-fg shadow-2xl outline-none"
        :style="{ width: props.width }"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
      >
        <header class="flex items-center justify-between border-b border-surface-border px-5 py-3.5">
          <h2 :id="titleId" class="text-[17px] font-semibold">{{ props.title }}</h2>
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
