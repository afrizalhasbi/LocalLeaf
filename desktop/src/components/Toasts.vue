<script setup lang="ts">
import { dismissToast, state } from "../lib/store";
import Icon from "./Icon.vue";
</script>

<template>
  <div class="pointer-events-none fixed bottom-4 left-1/2 z-[200] flex -translate-x-1/2 flex-col items-center gap-2">
    <div
      v-for="t in state.toasts"
      :key="t.id"
      class="pointer-events-auto flex max-w-[36rem] items-start gap-2 rounded-md px-4 py-2.5 text-[13px] text-white shadow-lg"
      :class="{ 'bg-danger': t.kind === 'error', 'bg-accent': t.kind === 'success', 'bg-[#2f3a4c]': t.kind === 'info' }"
    >
      <Icon :name="t.kind === 'error' ? 'error' : t.kind === 'success' ? 'check_circle' : 'info'" :size="18" />
      <span class="flex-1 break-words">{{ t.message }}</span>
      <button class="opacity-70 hover:opacity-100" @click="dismissToast(t.id)"><Icon name="close" :size="16" /></button>
    </div>
  </div>
</template>
