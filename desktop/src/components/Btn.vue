<script setup lang="ts">
withDefaults(defineProps<{ variant?: "primary" | "secondary" | "danger"; disabled?: boolean; type?: "button" | "submit" }>(), {
  variant: "secondary",
  type: "button",
});
</script>

<template>
  <button
    :type="type"
    :disabled="disabled"
    class="inline-flex items-center justify-center gap-1.5 rounded-full px-4 py-1.5 text-[13px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50"
    :class="{
      'bg-accent text-white hover:bg-accent-hover': variant === 'primary',
      'bg-danger text-white hover:brightness-110': variant === 'danger',
      'border border-surface-border bg-surface text-surface-fg hover:bg-surface-hover': variant === 'secondary',
    }"
  >
    <slot />
  </button>
</template>
