<script setup lang="ts">
defineProps<{ size?: number }>();
</script>

<template>
  <svg :width="size ?? 22" :height="size ?? 22" viewBox="0 0 64 64" aria-hidden="true">
    <path d="M54 8C30 8 12 20 12 40c0 5 1.5 9.5 4 13l-6 6 4 3 6-6c3.5 2.5 8 4 13 4 20 0 21-30 21-52Z" fill="#098842" />
    <path d="M18 50C26 38 36 28 48 18" stroke="#fff" stroke-width="3.5" stroke-linecap="round" fill="none" />
    <text x="24" y="44" font-family="Georgia, serif" font-size="17" font-style="italic" font-weight="700" fill="#fff">L</text>
  </svg>
</template>
