<script setup lang="ts">
import { state } from "./lib/store";
import EditorView from "./components/EditorView.vue";
import ProjectsView from "./components/ProjectsView.vue";
import Toasts from "./components/Toasts.vue";
import ConflictModal from "./components/ConflictModal.vue";
import SettingsModal from "./components/SettingsModal.vue";
import WordCountModal from "./components/WordCountModal.vue";
</script>

<template>
  <EditorView v-if="state.info" />
  <ProjectsView v-else />
  <!-- App-level so the menu bar can open them from the dashboard too. -->
  <SettingsModal v-if="state.ui.settingsOpen" />
  <WordCountModal v-if="state.ui.wordCountOpen && state.info" />
  <ConflictModal />
  <Toasts />
</template>
