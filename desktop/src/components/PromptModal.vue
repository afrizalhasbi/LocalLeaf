<script setup lang="ts">
// Name prompt used for "New file", "New folder" and project creation.
import { nextTick, onMounted, ref } from "vue";
import Modal from "./Modal.vue";
import Btn from "./Btn.vue";

const props = defineProps<{ title: string; label: string; initial?: string; confirmLabel?: string; selectStem?: boolean }>();
const emit = defineEmits<{ close: []; confirm: [value: string] }>();

const value = ref(props.initial ?? "");
const input = ref<HTMLInputElement>();
const error = ref("");

onMounted(async () => {
  await nextTick();
  const el = input.value;
  if (!el) return;
  el.focus();
  const dot = props.selectStem ? value.value.lastIndexOf(".") : -1;
  el.setSelectionRange(0, dot > 0 ? dot : value.value.length);
});

function submit() {
  const v = value.value.trim();
  if (!v) {
    error.value = "Please enter a name";
    return;
  }
  if (/[\\:*?"<>|]/.test(v) || v.startsWith("/") || v.split("/").includes("..")) {
    error.value = "This name contains characters that are not allowed";
    return;
  }
  emit("confirm", v);
}
</script>

<template>
  <Modal :title="props.title" width="28rem" @close="emit('close')">
    <form class="px-5 py-4" @submit.prevent="submit">
      <label class="mb-1.5 block text-[13px] font-semibold">{{ props.label }}</label>
      <input
        ref="input"
        v-model="value"
        class="w-full rounded border border-surface-border bg-surface px-3 py-2 text-[14px] outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
        spellcheck="false"
        autocomplete="off"
        @input="error = ''"
      />
      <p v-if="error" class="mt-1.5 text-[12px] text-danger">{{ error }}</p>
      <button type="submit" class="hidden" />
    </form>
    <template #footer>
      <Btn @click="emit('close')">Cancel</Btn>
      <Btn variant="primary" @click="submit">{{ props.confirmLabel ?? "Create" }}</Btn>
    </template>
  </Modal>
</template>
