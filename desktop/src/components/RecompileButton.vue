<script setup lang="ts">
import { computed } from "vue";
import { compile, recompileFromScratch, state } from "../lib/store";
import { ENGINE_LABELS } from "../lib/ipc";
import Dropdown from "./Dropdown.vue";
import Icon from "./Icon.vue";
import MenuItem from "./MenuItem.vue";
import MenuSection from "./MenuSection.vue";

const isMac = navigator.platform.toLowerCase().includes("mac");
const shortcut = isMac ? "⌘↵" : "Ctrl+↵";
const title = computed(() => `Recompile (${shortcut})`);
</script>

<template>
  <div class="flex items-stretch">
    <button
      class="flex h-8 items-center gap-1.5 rounded-l-full bg-accent pr-3 pl-3.5 text-[13px] font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-80"
      :title="title"
      @click="compile()"
    >
      <Icon :name="state.compiling ? 'progress_activity' : 'refresh'" :size="18" :class="{ spin: state.compiling }" />
      <span>{{ state.compiling ? "Compiling…" : "Recompile" }}</span>
    </button>
    <Dropdown align="right" width="17rem">
      <template #trigger="{ toggle }">
        <button
          class="flex h-8 items-center rounded-r-full border-l border-white/25 bg-accent pr-2 pl-1.5 text-white hover:bg-accent-hover"
          aria-label="Compile options"
          @click="toggle"
        >
          <Icon name="expand_more" :size="18" />
        </button>
      </template>

      <MenuSection title="Auto compile">
        <MenuItem :checked="state.autoCompile" @select="state.autoCompile = true">On</MenuItem>
        <MenuItem :checked="!state.autoCompile" @select="state.autoCompile = false">Off</MenuItem>
      </MenuSection>
      <MenuSection title="Compile mode" divider>
        <MenuItem :checked="!state.draft" @select="state.draft = false">Normal</MenuItem>
        <MenuItem :checked="state.draft" @select="state.draft = true">Fast [draft]</MenuItem>
      </MenuSection>
      <MenuSection title="Compile error handling" divider>
        <MenuItem :checked="state.stopOnFirstError" @select="state.stopOnFirstError = true">Stop on first error</MenuItem>
        <MenuItem :checked="!state.stopOnFirstError" @select="state.stopOnFirstError = false">Try compiling despite errors</MenuItem>
      </MenuSection>
      <MenuSection title="Compiler" divider>
        <MenuItem
          v-for="e in state.engines"
          :key="e.engine"
          :checked="state.engine === e.engine"
          :disabled="!e.installed"
          @select="state.engine = e.engine"
        >
          {{ ENGINE_LABELS[e.engine] }}<span v-if="!e.installed" class="ml-1 text-surface-muted">(not installed)</span>
        </MenuItem>
      </MenuSection>
      <MenuSection divider>
        <MenuItem icon="mop" @select="recompileFromScratch()">Recompile from scratch</MenuItem>
      </MenuSection>
    </Dropdown>
  </div>
</template>
