<script setup lang="ts">
import Modal from "./Modal.vue";
import Btn from "./Btn.vue";

const props = defineProps<{ title: string; message: string; confirmLabel?: string; danger?: boolean }>();
const emit = defineEmits<{ close: []; confirm: [] }>();
</script>

<template>
  <Modal :title="props.title" width="28rem" @close="emit('close')">
    <p class="px-5 py-4 text-[14px] leading-relaxed">{{ props.message }}</p>
    <template #footer>
      <Btn @click="emit('close')">Cancel</Btn>
      <Btn :variant="props.danger ? 'danger' : 'primary'" @click="emit('confirm')">{{ props.confirmLabel ?? "OK" }}</Btn>
    </template>
  </Modal>
</template>
