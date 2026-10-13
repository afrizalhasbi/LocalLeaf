<script setup lang="ts">
import { state } from "./lib/store";
import EditorView from "./components/EditorView.vue";
import ProjectsView from "./components/ProjectsView.vue";
import Toasts from "./components/Toasts.vue";
</script>

<template>
  <EditorView v-if="state.info" />
  <ProjectsView v-else />
  <Toasts />
</template>
