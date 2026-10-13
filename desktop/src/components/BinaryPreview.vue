<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { extension, state } from "../lib/store";
import Icon from "./Icon.vue";
import PdfViewer from "./PdfViewer.vue";

const url = ref<string | null>(null);
const mime = computed(() => {
  const ext = extension(state.openPath ?? "");
  return ext === "svg" ? "image/svg+xml" : ext === "jpg" ? "image/jpeg" : `image/${ext}`;
});

watch(
  () => state.binaryData,
  (data) => {
    if (url.value) URL.revokeObjectURL(url.value);
    url.value = data && state.openKind === "image" ? URL.createObjectURL(new Blob([data.slice()], { type: mime.value })) : null;
  },
  { immediate: true },
);
onBeforeUnmount(() => url.value && URL.revokeObjectURL(url.value));

const size = computed(() => {
  const n = state.binaryData?.length ?? 0;
  return n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-pdf">
    <PdfViewer v-if="state.openKind === 'pdf' && state.binaryData" :data="state.binaryData" :version="0" class="flex-1" />
    <div v-else class="flex flex-1 flex-col items-center justify-center gap-3 overflow-auto p-6 text-center">
      <img v-if="url" :src="url" class="max-h-[80%] max-w-full rounded bg-white object-contain shadow-lg" alt="" />
      <template v-else>
        <Icon name="draft" :size="48" class="text-surface-muted" />
        <p class="text-[14px] text-surface-fg">This file can't be shown in the editor.</p>
      </template>
      <p class="text-[12px] text-surface-muted">{{ state.openPath }} · {{ size }}</p>
    </div>
  </div>
</template>
