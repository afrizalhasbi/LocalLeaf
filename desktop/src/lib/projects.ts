// Project lifecycle: recent projects, per-project settings, opening and closing projects.
import { watch } from "vue";
import { listen, setTitle, type UnlistenFn } from "./bridge";
import { ipc, type Engine, type ProjectInfo } from "./ipc";
import { requiredEngine } from "./latex";
import { readStored, removeStored, writeStored } from "./storage";
import { allFiles, ancestors, guarded, notify, session, state, type ProjectPrefs } from "./state";
import { cancelPendingSave, flushSave, indexProject, onExternalChange, openFile } from "./files";
import { cancelAutoCompile, compile, reloadPdf } from "./compile";

// ---------------------------------------------------------------------------
// Recent projects & per-project prefs
// ---------------------------------------------------------------------------

function saveRecent() {
  try {
    writeStored("recent", JSON.stringify(state.recent.slice(0, 30)));
  } catch {
    /* ignore */
  }
}

/** Points a recent-projects entry (and its saved prefs) at a project's new location. */
function relocateRecent(oldRoot: string, newRoot: string, newName?: string) {
  const entry = state.recent.find((r) => r.root === oldRoot);
  if (entry) {
    entry.root = newRoot;
    if (newName) entry.name = newName;
  }
  try {
    const prefs: ProjectPrefs = JSON.parse(readStored(prefsKey(oldRoot)) ?? "{}");
    if (newName) prefs.displayName = newName;
    writeStored(prefsKey(newRoot), JSON.stringify(prefs));
    if (newRoot !== oldRoot) removeStored(prefsKey(oldRoot));
  } catch {
    /* ignore */
  }
  saveRecent();
}

export async function renameProjectFolder(root: string, newName: string) {
  const newRoot = await guarded(() => ipc.renameProjectFolder(root, newName));
  if (!newRoot) return;
  relocateRecent(root, newRoot, newName);
  notify(`Renamed to “${newName}”`, "success");
}

export async function moveProjectFolder(root: string, destination: string) {
  const newRoot = await guarded(() => ipc.moveProjectFolder(root, destination));
  if (!newRoot) return;
  relocateRecent(root, newRoot);
  notify(`Moved to ${newRoot.replace(/^\/Users\/[^/]+/, "~")}`, "success");
}

export async function trashProject(root: string) {
  if ((await guarded(() => ipc.trashProjectFolder(root))) === undefined) return;
  forgetRecent(root);
  try {
    removeStored(prefsKey(root));
  } catch {
    /* ignore */
  }
  notify("Project moved to the Trash", "success");
}

export function forgetRecent(root: string) {
  state.recent = state.recent.filter((r) => r.root !== root);
  saveRecent();
}

function prefsKey(root: string) {
  return `project:${root}`;
}

/** Preferences saved by versions before 1.0.2, in the WebView's storage. */
function loadLegacyPrefs(root: string): ProjectPrefs | null {
  try {
    const raw = readStored(prefsKey(root));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

let prefsTimer: ReturnType<typeof setTimeout> | undefined;
let loadingProject = false;

/** Saves the project's settings to `.texcraft/settings.json` (debounced). */
function savePrefs() {
  if (!state.info || loadingProject) return;
  const prefs: ProjectPrefs = {
    displayName: state.displayName,
    mainDocument: state.mainDocument,
    engine: state.engine,
    autoCompile: state.autoCompile,
    draft: state.draft,
    stopOnFirstError: state.stopOnFirstError,
  };
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => void ipc.saveProjectSettings(prefs).catch(() => undefined), 300);
}

watch(
  () => [state.displayName, state.mainDocument, state.engine, state.autoCompile, state.draft, state.stopOnFirstError],
  savePrefs,
);

watch(
  () => [state.displayName, state.info] as const,
  ([name]) => {
    setTitle(state.info ? `${name} — LocalLeaf` : "LocalLeaf");
  },
);

// ---------------------------------------------------------------------------
// Project lifecycle
// ---------------------------------------------------------------------------

let unlisteners: UnlistenFn[] = [];


export async function openProject(path: string) {
  const info = await guarded(() => ipc.openProject(path));
  if (info) await loadProject(info);
}

export async function createProject(parent: string, name: string) {
  const info = await guarded(() => ipc.createProject(parent, name));
  if (info) await loadProject(info);
}

async function loadProject(info: ProjectInfo) {
  await flushSave();
  resetProjectState();
  state.info = info;
  state.tree = info.tree;

  loadingProject = true;
  // Settings live in the project; older versions kept them in the WebView's storage.
  const legacy = info.settings ? null : loadLegacyPrefs(info.root);
  const prefs: ProjectPrefs = info.settings ?? legacy ?? {};
  state.displayName = prefs.displayName || info.name;
  state.autoCompile = prefs.autoCompile ?? false;
  state.draft = prefs.draft ?? false;
  state.stopOnFirstError = prefs.stopOnFirstError ?? false;

  const texFiles = allFiles(info.tree).filter((p) => p.endsWith(".tex"));
  state.mainDocument =
    (prefs.mainDocument && texFiles.includes(prefs.mainDocument) ? prefs.mainDocument : null) ??
    info.mainDocument ??
    texFiles[0] ??
    null;

  state.engines = (await guarded(() => ipc.listEngines())) ?? [];
  // Overleaf's default compiler is pdfLaTeX; fall back through the others.
  const preference: Engine[] = ["pdflatex", "xelatex", "lualatex", "tectonic"];
  const installed = preference.filter((p) => state.engines.some((e) => e.engine === p && e.installed));
  state.engine = prefs.engine && installed.includes(prefs.engine) ? prefs.engine : (installed[0] ?? "pdflatex");
  state.synctexAvailable = (await ipc.synctexAvailable().catch(() => false)) ?? false;

  state.recent = [
    { root: info.root, name: state.displayName, lastOpened: Date.now() },
    ...state.recent.filter((r) => r.root !== info.root),
  ];
  saveRecent();

  await subscribeToEvents();
  await indexProject();
  // First time a project is opened: pick the engine its preamble needs (e.g. fontspec → XeLaTeX/LuaLaTeX).
  const needed = !prefs.engine && state.mainDocument ? requiredEngine(state.texts[state.mainDocument] ?? "") : null;
  if (needed && installed.includes(needed)) state.engine = needed;
  loadingProject = false;
  // Persist the resolved settings (also migrates legacy ones into the project).
  savePrefs();
  if (legacy) {
    try {
      removeStored(prefsKey(info.root));
    } catch {
      /* ignore */
    }
  }
  if (state.mainDocument) {
    for (const dir of ancestors(state.mainDocument)) state.expanded[dir] = true;
    await openFile(state.mainDocument);
    // Like Overleaf, show a fresh preview as soon as the project opens.
    void compile();
  }
}

function resetProjectState() {
  session.generation++;
  cancelPendingSave();
  cancelAutoCompile();
  Object.assign(state, {
    info: null,
    tree: [],
    expanded: {},
    selectedPath: null,
    openPath: null,
    openKind: null,
    content: "",
    savedContent: "",
    saveState: "saved",
    binaryData: null,
    result: null,
    compileError: null,
    pdfData: null,
    pdfPath: null,
    highlights: [],
    texts: {},
    compileQueued: false,
    conflict: null,
  });
  state.ui.showLogs = false;
}

export async function closeProject() {
  await flushSave();
  unlisteners.forEach((u) => u());
  unlisteners = [];
  await ipc.closeProject().catch(() => undefined);
  resetProjectState();
}

/** Renames the open project: its folder on disk and its displayed name. */
export async function renameProject(name: string) {
  const trimmed = name.trim();
  if (!trimmed || !state.info || trimmed === state.displayName) return;
  await flushSave();
  const oldRoot = state.info.root;
  const info = await guarded(() => ipc.renameOpenProject(trimmed));
  if (!info) return;
  state.info = info;
  state.displayName = trimmed;
  relocateRecent(oldRoot, info.root, trimmed);
  savePrefs();
  notify(`Renamed to “${trimmed}”`, "success");
}

async function subscribeToEvents() {
  unlisteners.forEach((u) => u());
  unlisteners = [
    await listen<{ paths: string[] }>("project://changed", (paths) => void onExternalChange(paths.paths)),
    await listen("project://pdf-changed", () => {
      // Ignore the echo of our own compile; reload when an agent compiled via MCP.
      if (!state.compiling && Date.now() - state.lastCompileAt > 2000) void reloadPdf();
    }),
  ];
}

