<script setup lang="ts">
// Shown when the open file changed or was deleted on disk while it had unsaved edits
// (another editor, git, or an AI agent through MCP). Autosave waits for this choice.
import { computed } from "vue";
import { basename } from "../lib/latex";
import { resolveConflict, state } from "../lib/store";
import Btn from "./Btn.vue";
import Modal from "./Modal.vue";

const name = computed(() => basename(state.conflict?.path ?? ""));
const deleted = computed(() => state.conflict?.diskText === null);
</script>

<template>
  <Modal
    v-if="state.conflict"
    :title="deleted ? `${name} was deleted` : `${name} changed on disk`"
    width="30rem"
    @close="resolveConflict('mine')"
  >
    <p class="px-5 py-4 text-[14px] leading-relaxed">
      <template v-if="deleted">
        The file was deleted outside LocalLeaf while you had unsaved changes. Keep your version to save it again, or
        discard your changes and close it.
      </template>
      <template v-else>
        The file was changed outside LocalLeaf (another editor, git, or an AI agent) while you had unsaved changes.
        Choose which version to keep; the other one is discarded.
      </template>
    </p>
    <template #footer>
      <Btn @click="resolveConflict('disk')">{{ deleted ? "Discard my changes" : "Load the version on disk" }}</Btn>
      <Btn variant="primary" @click="resolveConflict('mine')">Keep my version</Btn>
    </template>
  </Modal>
</template>
