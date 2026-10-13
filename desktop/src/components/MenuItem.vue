<script setup lang="ts">
import Icon from "./Icon.vue";

defineProps<{ icon?: string; checked?: boolean; disabled?: boolean; shortcut?: string; danger?: boolean }>();
defineEmits<{ select: [] }>();
</script>

<template>
  <button
    type="button"
    class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] disabled:cursor-not-allowed disabled:opacity-45"
    :class="danger ? 'text-danger hover:bg-danger-light' : 'hover:bg-surface-hover'"
    :disabled="disabled"
    @click="$emit('select')"
  >
    <span class="flex w-5 justify-center">
      <Icon v-if="checked" name="check" :size="18" class="text-accent" />
      <Icon v-else-if="icon" :name="icon" :size="18" class="opacity-80" />
    </span>
    <span class="flex-1 truncate"><slot /></span>
    <span v-if="shortcut" class="text-xs text-surface-muted">{{ shortcut }}</span>
  </button>
</template>
