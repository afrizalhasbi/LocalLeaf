<script setup lang="ts">
// Overleaf-style dropdown menu: closes on outside click, Escape, or item selection.
// Accessible: ARIA menu roles, arrow-key navigation, focus returns to the trigger.
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = withDefaults(defineProps<{ align?: "left" | "right"; width?: string }>(), {
  align: "left",
  width: "15rem",
});

const open = ref(false);
const root = ref<HTMLElement>();
const panel = ref<HTMLElement>();

function trigger(): HTMLElement | null {
  const first = root.value?.firstElementChild as HTMLElement | null;
  return first?.matches("button") ? first : (first?.querySelector("button") ?? null);
}

function items(): HTMLElement[] {
  return [...(panel.value?.querySelectorAll<HTMLElement>("[role^='menuitem']:not([disabled])") ?? [])];
}

function toggle() {
  open.value = !open.value;
}
function close(returnFocus = false) {
  open.value = false;
  if (returnFocus) trigger()?.focus();
}

function onDocMouseDown(e: MouseEvent) {
  if (root.value && !root.value.contains(e.target as Node)) close();
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    close(true);
    return;
  }
  if (e.key === "Tab") {
    close();
    return;
  }
  const list = items();
  if (!list.length) return;
  const index = list.indexOf(document.activeElement as HTMLElement);
  const focusAt = (i: number) => list[(i + list.length) % list.length].focus();
  if (e.key === "ArrowDown") {
    e.preventDefault();
    focusAt(index + 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    focusAt(index < 0 ? list.length - 1 : index - 1);
  } else if (e.key === "Home") {
    e.preventDefault();
    focusAt(0);
  } else if (e.key === "End") {
    e.preventDefault();
    focusAt(list.length - 1);
  }
}

watch(open, async (isOpen) => {
  trigger()?.setAttribute("aria-expanded", String(isOpen));
  if (isOpen) {
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
    await nextTick();
    // Focus the checked item if any, else the first one, so the keyboard works right away.
    const list = items();
    (list.find((el) => el.getAttribute("aria-checked") === "true") ?? list[0])?.focus();
  } else {
    document.removeEventListener("mousedown", onDocMouseDown);
    document.removeEventListener("keydown", onKey);
  }
});

onMounted(() => {
  const t = trigger();
  t?.setAttribute("aria-haspopup", "menu");
  t?.setAttribute("aria-expanded", "false");
});
onBeforeUnmount(() => close());

defineExpose({ close });
</script>

<template>
  <div ref="root" class="relative">
    <slot name="trigger" :toggle="toggle" :open="open" />
    <div
      v-if="open"
      ref="panel"
      role="menu"
      class="absolute top-full z-50 mt-1 rounded-md border border-surface-border bg-surface py-1 text-surface-fg shadow-xl"
      :class="props.align === 'right' ? 'right-0' : 'left-0'"
      :style="{ width: props.width }"
      @click="close(true)"
    >
      <slot />
    </div>
  </div>
</template>
