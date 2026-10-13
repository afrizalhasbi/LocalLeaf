<script setup lang="ts">
const model = defineModel<boolean>({ required: true });
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="model"
    class="relative h-5.5 w-10 rounded-full transition-colors"
    :class="model ? 'bg-accent' : 'bg-surface-border'"
    @click="model = !model"
  >
    <span class="absolute top-0.5 left-0.5 h-4.5 w-4.5 rounded-full bg-white shadow transition-transform" :class="{ 'translate-x-4.5': model }" />
  </button>
</template>
