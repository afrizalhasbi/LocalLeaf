<script setup lang="ts">
import { computed } from "vue";
import { countWords } from "../lib/latex";
import { state } from "../lib/store";
import Modal from "./Modal.vue";
import Btn from "./Btn.vue";

const count = computed(() => (state.mainDocument ? countWords(state.mainDocument, state.texts) : null));
const rows = computed(() =>
  count.value
    ? [
        ["Total Words", count.value.words],
        ["Headers", count.value.headers],
        ["Math Inline", count.value.mathInline],
        ["Math Display", count.value.mathDisplay],
      ]
    : [],
);
</script>

<template>
  <Modal title="Word Count" width="24rem" @close="state.ui.wordCountOpen = false">
    <div class="px-5 py-4">
      <p v-if="!count" class="text-[13px] text-surface-muted">Choose a main document to count words.</p>
      <template v-else>
        <div v-for="[label, value] in rows" :key="label" class="flex justify-between border-b border-surface-border py-2 text-[14px] last:border-0">
          <span class="font-semibold">{{ label }}:</span>
          <span class="tabular-nums">{{ value.toLocaleString() }}</span>
        </div>
        <p class="mt-3 text-[12px] text-surface-muted">
          Counted from {{ state.mainDocument }} and {{ count.files - 1 }} included file{{ count.files === 2 ? "" : "s" }}.
        </p>
      </template>
    </div>
    <template #footer>
      <Btn variant="primary" @click="state.ui.wordCountOpen = false">Close</Btn>
    </template>
  </Modal>
</template>
