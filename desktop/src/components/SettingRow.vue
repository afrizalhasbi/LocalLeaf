<script setup lang="ts">
defineProps<{ label: string; hint?: string }>();
</script>

<template>
  <div class="flex items-center justify-between gap-6 border-b border-surface-border py-3 last:border-b-0">
    <div class="min-w-0">
      <div class="text-[13.5px] font-medium">{{ label }}</div>
      <div v-if="hint" class="mt-0.5 text-[12px] text-surface-muted">{{ hint }}</div>
    </div>
    <div class="shrink-0"><slot /></div>
  </div>
</template>
