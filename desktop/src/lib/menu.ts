// Native menu bar: dispatches `menu://action` events and mirrors UI state into check marks.
import { watch } from "vue";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ipc, type Engine } from "./ipc";
import { settings, type OverallTheme } from "./settings";
import {
  closeProject,
  compile,
  editorBridge,
  flushBeforeExit,
  flushSave,
  notify,
  openProject,
  recentlyRan,
  recompileFromScratch,
  save,
  state,
  syncToPdf,
  type EditorCommand,
  type Layout,
} from "./store";
import { downloadPdf, revealProject, uploadFiles } from "./actions";
import { syncFromPdfView } from "./pdfSync";

/** Insert menu: snippets with `#{}` fields (the selection fills the first one). */
const INSERTS: Record<string, { tpl: string; complete?: boolean }> = {
  section: { tpl: "\\section{#{}}\n" },
  subsection: { tpl: "\\subsection{#{}}\n" },
  subsubsection: { tpl: "\\subsubsection{#{}}\n" },
  itemize: { tpl: "\\begin{itemize}\n\t\\item #{}\n\\end{itemize}\n" },
  enumerate: { tpl: "\\begin{enumerate}\n\t\\item #{}\n\\end{enumerate}\n" },
  figure: {
    tpl: "\\begin{figure}[h]\n\t\\centering\n\t\\includegraphics[width=0.8\\linewidth]{#{}}\n\t\\caption{#{Caption}}\n\t\\label{fig:#{label}}\n\\end{figure}\n",
  },
  table: {
    tpl: "\\begin{table}[h]\n\t\\centering\n\t\\begin{tabular}{#{c c c}}\n\t\t#{} &  &  \\\\\n\t\\end{tabular}\n\t\\caption{#{Caption}}\n\t\\label{tab:#{label}}\n\\end{table}\n",
  },
  equation: { tpl: "\\begin{equation}\n\t#{}\n\\end{equation}\n" },
  align: { tpl: "\\begin{align}\n\t#{} &= #{} \\\\\n\\end{align}\n" },
  cite: { tpl: "\\cite{#{}}", complete: true },
  ref: { tpl: "\\ref{#{}}", complete: true },
  label: { tpl: "\\label{#{}}" },
  footnote: { tpl: "\\footnote{#{}}" },
  link: { tpl: "\\href{#{https://}}{#{}}" },
};

const EDITOR_COMMANDS: Record<string, EditorCommand> = {
  "edit.find": "find",
  "edit.replace": "replace",
  "edit.goto_line": "gotoLine",
  "edit.comment": "comment",
  "edit.bold": "bold",
  "edit.italic": "italic",
};

function openSettings(tab: typeof state.ui.settingsTab = "editor") {
  state.ui.settingsTab = tab;
  state.ui.settingsOpen = true;
}

async function openFolder() {
  const dir = await openDialog({ directory: true, title: "Open LaTeX project folder" });
  if (typeof dir === "string") await openProject(dir);
}

function setFontSize(size: number) {
  settings.fontSize = Math.min(28, Math.max(9, size));
}

async function handle(id: string) {
  // Editor shortcuts may reach both CodeMirror and the menu; the editor bridge dedupes those.
  if (EDITOR_COMMANDS[id]) return editorBridge.command?.(EDITOR_COMMANDS[id]);
  if (id.startsWith("insert.")) {
    const ins = INSERTS[id.slice("insert.".length)];
    if (ins && state.openKind === "text") editorBridge.insert?.(ins.tpl, ins.complete);
    return;
  }
  if (id.startsWith("engine:")) {
    state.engine = id.slice("engine:".length) as Engine;
    return;
  }
  if (id.startsWith("layout:")) {
    state.ui.layout = id.slice("layout:".length) as Layout;
    return;
  }
  if (id.startsWith("theme:")) {
    settings.overallTheme = id.slice("theme:".length) as OverallTheme;
    return;
  }

  switch (id) {
    case "app.settings":
      return openSettings();
    case "app.quit":
      await flushBeforeExit().catch(() => undefined);
      return invoke("confirm_exit");
    case "file.new_project":
      if (state.info) await closeProject();
      state.ui.newProjectRequested = true;
      return;
    case "file.open":
      return openFolder();
    case "file.projects":
    case "file.close_project":
      return closeProject();
    case "file.new_file":
      state.ui.fileModal = "file";
      return;
    case "file.new_folder":
      state.ui.fileModal = "folder";
      return;
    case "file.upload":
      return uploadFiles();
    case "file.save":
      // ⌘S saves and recompiles, as in Overleaf.
      if (recentlyRan("save")) return;
      await save();
      return compile();
    case "file.download_pdf":
      return downloadPdf();
    case "file.reveal":
      return revealProject();
    case "view.file_tree":
      state.ui.sidebarCollapsed = !state.ui.sidebarCollapsed;
      return;
    case "view.outline":
      state.ui.showOutline = !state.ui.showOutline;
      if (state.ui.showOutline) state.ui.sidebarCollapsed = false;
      return;
    case "view.logs":
      state.ui.showLogs = !state.ui.showLogs;
      if (state.ui.showLogs && state.ui.layout === "editor") state.ui.layout = "split";
      return;
    case "view.font_bigger":
      return setFontSize(settings.fontSize + 1);
    case "view.font_smaller":
      return setFontSize(settings.fontSize - 1);
    case "view.font_reset":
      return setFontSize(14);
    case "build.compile":
      return compile();
    case "build.compile_scratch":
      await flushSave();
      return recompileFromScratch();
    case "build.auto_compile":
      state.autoCompile = !state.autoCompile;
      return;
    case "build.draft":
      state.draft = !state.draft;
      return;
    case "build.stop_on_error":
      state.stopOnFirstError = !state.stopOnFirstError;
      return;
    case "build.sync_to_pdf":
      return syncToPdf();
    case "build.sync_to_code":
      return syncFromPdfView();
    case "build.set_main":
      if (state.openPath?.endsWith(".tex")) {
        state.mainDocument = state.openPath;
        notify(`${state.openPath} is now the main document`, "success");
      } else notify("Open a .tex file to make it the main document");
      return;
    case "build.word_count":
      state.ui.wordCountOpen = true;
      return;
    case "build.clear_cache":
      await ipc.clearBuildDir().catch(() => undefined);
      notify("Cached build files cleared", "success");
      return;
    case "help.shortcuts":
      return openSettings("shortcuts");
    case "help.mcp":
      return openSettings("agent");
    case "help.latex_guide":
      return invoke("open_external", { url: "https://en.wikibooks.org/wiki/LaTeX" });
    case "help.ctan":
      return invoke("open_external", { url: "https://ctan.org/search" });
  }
}

export async function installMenuBar() {
  await listen<string>("menu://action", (e) => {
    void handle(e.payload).catch((err) => notify(String(err), "error"));
  });

  // Keep check marks and enabled items in sync with the UI.
  watch(
    () => ({
      projectOpen: !!state.info,
      hasPdf: !!state.pdfData,
      autoCompile: state.autoCompile,
      draft: state.draft,
      stopOnFirstError: state.stopOnFirstError,
      engine: state.engine,
      installedEngines: state.engines.filter((e) => e.installed).map((e) => e.engine),
      layout: state.ui.layout,
      theme: settings.overallTheme,
      showFileTree: !state.ui.sidebarCollapsed,
      showOutline: state.ui.showOutline,
      showLogs: state.ui.showLogs,
    }),
    (sync) => void invoke("update_menu_state", { sync }).catch(() => undefined),
    { immediate: true, deep: true },
  );
}
