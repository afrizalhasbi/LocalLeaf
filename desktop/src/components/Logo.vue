<script setup lang="ts">
import logoUrl from "../assets/logo.png";

defineProps<{ size?: number }>();
</script>

<template>
  <img :src="logoUrl" :width="size ?? 22" :height="size ?? 22" alt="" draggable="false" class="shrink-0 select-none" />
</template>
