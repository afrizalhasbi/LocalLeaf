<script setup lang="ts">
defineProps<{ title?: string; divider?: boolean }>();
</script>

<template>
  <div>
    <div v-if="divider" class="my-1 border-t border-surface-border" />
    <div v-if="title" class="px-3 pt-1.5 pb-0.5 text-[11px] font-semibold tracking-wide text-surface-muted uppercase">
      {{ title }}
    </div>
    <slot />
  </div>
</template>
