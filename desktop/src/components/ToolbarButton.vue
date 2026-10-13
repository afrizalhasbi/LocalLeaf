<script setup lang="ts">
import Icon from "./Icon.vue";

defineProps<{ icon: string; label: string; active?: boolean; badge?: number; badgeKind?: "error" | "warning" }>();
</script>

<template>
  <button
    class="relative flex h-10 min-w-12 flex-col items-center justify-center gap-0.5 rounded px-2 text-header-fg transition-colors hover:bg-header-hover"
    :class="{ 'bg-header-hover': active }"
    :title="label"
  >
    <Icon :name="icon" :size="20" :fill="active" />
    <span class="text-[10.5px] leading-none text-header-muted">{{ label }}</span>
    <span
      v-if="badge"
      class="absolute top-0.5 right-1 min-w-4 rounded-full px-1 text-center text-[10px] leading-4 font-bold text-white"
      :class="badgeKind === 'warning' ? 'bg-warning' : 'bg-danger'"
      >{{ badge > 99 ? "99+" : badge }}</span
    >
  </button>
</template>
