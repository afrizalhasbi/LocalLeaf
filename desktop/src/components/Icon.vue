<script setup lang="ts">
defineProps<{ name: string; size?: number; fill?: boolean }>();
</script>

<template>
  <span
    class="material-symbols-outlined shrink-0 leading-none select-none"
    :style="{
      fontSize: `${size ?? 20}px`,
      fontVariationSettings: fill ? `'FILL' 1, 'wght' 400` : undefined,
    }"
    aria-hidden="true"
    >{{ name }}</span
  >
</template>
