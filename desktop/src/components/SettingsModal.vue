<script setup lang="ts">
import { computed } from "vue";
import { ENGINE_LABELS } from "../lib/ipc";
import { EDITOR_THEMES } from "../lib/editor";
import { FONT_FAMILIES, LINE_HEIGHTS, settings } from "../lib/settings";
import { allFiles, notify, state } from "../lib/store";
import Icon from "./Icon.vue";
import Modal from "./Modal.vue";
import SettingRow from "./SettingRow.vue";
import Toggle from "./Toggle.vue";

const tabs = [
  { id: "editor", label: "Editor", icon: "code" },
  { id: "compiler", label: "Compiler", icon: "build" },
  { id: "appearance", label: "Appearance", icon: "palette" },
  { id: "shortcuts", label: "Shortcuts", icon: "keyboard" },
  { id: "agent", label: "AI agent (MCP)", icon: "smart_toy" },
] as const;

const isMac = navigator.platform.toLowerCase().includes("mac");
const key = (k: string) => (isMac ? k : k.replace(/⌘/g, "Ctrl+").replace(/⇧/g, "Shift+").replace(/⌥/g, "Alt+"));
const SHORTCUTS: { group: string; items: [string, string][] }[] = [
  {
    group: "Compile",
    items: [["Recompile", "⌘↵"], ["Save and recompile", "⌘S"], ["Recompile from scratch", "⇧⌘↵"], ["Go to location in PDF", "⌥⌘→"], ["Go to location in code", "⌥⌘←  ·  double-click the PDF"]],
  },
  {
    group: "Editing",
    items: [["Bold / Italic", "⌘B / ⌘I"], ["Toggle comment", "⌘/"], ["Find / Find and replace", "⌘F / ⌥⌘F"], ["Go to line", "⌘L"], ["Autocomplete", "⌃Space"], ["Insert section / subsection", "⌥⌘1 / ⌥⌘2"], ["Insert equation", "⌥⌘E"], ["Insert link", "⌘K"]],
  },
  {
    group: "Files and view",
    items: [["New file / New folder", "⌘N / ⌥⌘N"], ["Upload files", "⌘U"], ["Download PDF", "⇧⌘S"], ["Show project in Finder", "⌥⌘R"], ["Editor & PDF / Editor / PDF", "⌘1 / ⌘2 / ⌘3"], ["File tree / Outline / Logs", "⌥⌘B / ⇧⌘O / ⇧⌘L"], ["Editor font size", "⌘= / ⌘- / ⌘0"]],
  },
  {
    group: "Projects",
    items: [["New project", "⇧⌘N"], ["Open folder", "⌘O"], ["All projects", "⇧⌘P"], ["Close project", "⇧⌘W"], ["Settings", "⌘,"]],
  },
];

const texFiles = computed(() => allFiles(state.tree).filter((p) => p.endsWith(".tex")));
const fontSizes = [10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24];

const mcpJson = computed(() => {
  const [command, ...args] = state.info?.mcpCommand ?? ["texcraft-core", "--mcp"];
  return JSON.stringify({ mcpServers: { localleaf: { command, args } } }, null, 2);
});
const claudeCommand = computed(() => {
  const cmd = state.info?.mcpCommand ?? [];
  return `claude mcp add localleaf -- ${cmd.map((c) => (/\s/.test(c) ? `"${c}"` : c)).join(" ")}`;
});

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    notify("Copied to clipboard", "success");
  } catch {
    notify("Could not copy to clipboard", "error");
  }
}
</script>

<template>
  <Modal title="Settings" width="46rem" @close="state.ui.settingsOpen = false">
    <div class="flex min-h-[26rem]">
      <nav class="w-48 shrink-0 border-r border-surface-border p-2">
        <button
          v-for="t in tabs"
          :key="t.id"
          class="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-[13.5px]"
          :class="state.ui.settingsTab === t.id ? 'bg-accent-light font-semibold text-accent' : 'hover:bg-surface-hover'"
          @click="state.ui.settingsTab = t.id"
        >
          <Icon :name="t.icon" :size="18" /> {{ t.label }}
        </button>
      </nav>

      <div class="min-w-0 flex-1 px-6 py-2">
        <template v-if="state.ui.settingsTab === 'editor'">
          <SettingRow label="Auto-complete" hint="Suggest commands, environments, \ref labels and \cite keys">
            <Toggle v-model="settings.autoComplete" />
          </SettingRow>
          <SettingRow label="Auto-close brackets"><Toggle v-model="settings.autoCloseBrackets" /></SettingRow>
          <SettingRow label="Wrap long lines" hint="Soft-wrap lines wider than the editor">
            <Toggle v-model="settings.lineWrapping" />
          </SettingRow>
          <SettingRow label="Highlight current line"><Toggle v-model="settings.highlightActiveLine" /></SettingRow>
          <SettingRow label="Keybindings">
            <select v-model="settings.keybindings" class="select">
              <option value="default">None (standard)</option>
              <option value="vim">Vim</option>
              <option value="emacs">Emacs</option>
            </select>
          </SettingRow>
          <p class="pt-3 text-[12px] text-surface-muted">
            All keyboard shortcuts are in the <button class="underline" @click="state.ui.settingsTab = 'shortcuts'">Shortcuts</button> tab and in the menu bar.
          </p>
        </template>

        <template v-else-if="state.ui.settingsTab === 'compiler'">
          <SettingRow label="Compiler">
            <select v-model="state.engine" class="select">
              <option v-for="e in state.engines" :key="e.engine" :value="e.engine" :disabled="!e.installed">
                {{ ENGINE_LABELS[e.engine] }}{{ e.installed ? "" : " (not installed)" }}
              </option>
            </select>
          </SettingRow>
          <SettingRow label="Main document" hint="The file passed to the compiler">
            <select v-model="state.mainDocument" class="select">
              <option v-for="f in texFiles" :key="f" :value="f">{{ f }}</option>
            </select>
          </SettingRow>
          <SettingRow label="Auto compile" hint="Recompile a couple of seconds after you stop typing">
            <Toggle v-model="state.autoCompile" />
          </SettingRow>
          <SettingRow label="Fast [draft] mode" hint="Images are replaced by placeholders (LaTeX engines)">
            <Toggle v-model="state.draft" />
          </SettingRow>
          <SettingRow label="Stop on first error"><Toggle v-model="state.stopOnFirstError" /></SettingRow>
          <div class="mt-3 rounded border border-surface-border p-3">
            <div class="mb-2 text-[12px] font-semibold tracking-wide text-surface-muted uppercase">Detected on this system</div>
            <div v-for="e in state.engines" :key="e.engine" class="flex items-center gap-2 py-0.5 text-[12.5px]">
              <Icon :name="e.installed ? 'check_circle' : 'cancel'" :size="16" :class="e.installed ? 'text-accent' : 'text-surface-muted'" />
              <span class="w-20 font-medium">{{ e.engine }}</span>
              <span class="truncate font-mono text-[11.5px] text-surface-muted">{{ e.path ?? "not found in PATH" }}</span>
            </div>
            <div class="flex items-center gap-2 py-0.5 text-[12.5px]">
              <Icon :name="state.synctexAvailable ? 'check_circle' : 'cancel'" :size="16" :class="state.synctexAvailable ? 'text-accent' : 'text-surface-muted'" />
              <span class="w-20 font-medium">synctex</span>
              <span class="text-[11.5px] text-surface-muted">{{ state.synctexAvailable ? "code ↔ PDF sync enabled" : "install TeX Live for SyncTeX" }}</span>
            </div>
          </div>
        </template>

        <template v-else-if="state.ui.settingsTab === 'appearance'">
          <SettingRow label="Overall theme">
            <select v-model="settings.overallTheme" class="select">
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="system">System</option>
            </select>
          </SettingRow>
          <SettingRow label="Editor theme">
            <select v-model="settings.editorTheme" class="select">
              <option value="auto">Match overall theme</option>
              <option v-for="t in EDITOR_THEMES" :key="t.id" :value="t.id">{{ t.label }}</option>
            </select>
          </SettingRow>
          <SettingRow label="Font size">
            <select v-model.number="settings.fontSize" class="select">
              <option v-for="s in fontSizes" :key="s" :value="s">{{ s }}px</option>
            </select>
          </SettingRow>
          <SettingRow label="Font family">
            <select v-model="settings.fontFamily" class="select">
              <option v-for="(f, id) in FONT_FAMILIES" :key="id" :value="id">{{ f.label }}</option>
            </select>
          </SettingRow>
          <SettingRow label="Line height">
            <select v-model="settings.lineHeight" class="select">
              <option v-for="(l, id) in LINE_HEIGHTS" :key="id" :value="id">{{ l.label }}</option>
            </select>
          </SettingRow>
        </template>

        <template v-else-if="state.ui.settingsTab === 'shortcuts'">
          <div v-for="g in SHORTCUTS" :key="g.group" class="py-2">
            <div class="mb-1 text-[12px] font-semibold tracking-wide text-surface-muted uppercase">{{ g.group }}</div>
            <div v-for="[label, keys] in g.items" :key="label" class="flex items-center justify-between border-b border-surface-border py-1.5 text-[13px] last:border-0">
              <span>{{ label }}</span>
              <kbd class="rounded border border-surface-border bg-surface-hover px-1.5 py-0.5 font-mono text-[11.5px]">{{ key(keys) }}</kbd>
            </div>
          </div>
        </template>

        <template v-else>
          <p class="py-3 text-[13px] leading-relaxed">
            LocalLeaf doubles as a native MCP server. Connect an AI agent to this project and it can compile, read and edit
            files; changes appear here live and the PDF refreshes when the agent recompiles.
          </p>
          <div class="mb-1 text-[12px] font-semibold tracking-wide text-surface-muted uppercase">Claude Code</div>
          <div class="flex items-start gap-2">
            <pre class="flex-1 overflow-x-auto rounded bg-surface-hover p-2.5 font-mono text-[11.5px] whitespace-pre-wrap">{{ claudeCommand }}</pre>
            <button class="rounded p-1.5 hover:bg-surface-hover" title="Copy" @click="copy(claudeCommand)"><Icon name="content_copy" :size="18" /></button>
          </div>
          <div class="mt-4 mb-1 text-[12px] font-semibold tracking-wide text-surface-muted uppercase">.mcp.json</div>
          <div class="flex items-start gap-2">
            <pre class="flex-1 overflow-x-auto rounded bg-surface-hover p-2.5 font-mono text-[11.5px]">{{ mcpJson }}</pre>
            <button class="rounded p-1.5 hover:bg-surface-hover" title="Copy" @click="copy(mcpJson)"><Icon name="content_copy" :size="18" /></button>
          </div>
          <p class="mt-3 text-[12px] text-surface-muted">
            Tools: compile_tex, read_project_file, write_project_file, list_available_engines.
          </p>
        </template>
      </div>
    </div>
  </Modal>
</template>

<style scoped>
@reference "../style.css";
.select {
  @apply rounded border border-surface-border bg-surface px-2 py-1 text-[13px] text-surface-fg outline-none focus:border-accent;
  min-width: 12rem;
}
</style>
