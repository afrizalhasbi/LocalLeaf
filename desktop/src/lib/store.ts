// Application state and actions: the local-first equivalent of Overleaf's editor context.
import { reactive, nextTick, watch } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ipc,
  errorMessage,
  type CompileResult,
  type Diagnostic,
  type Engine,
  type EngineInfo,
  type FileNode,
  type PdfLocation,
  type ProjectInfo,
} from "./ipc";
import { basename, dirname, extractBibKeys, extractLabels, requiredEngine } from "./latex";

export type FileKind = "text" | "image" | "pdf" | "binary";
export type SaveState = "saved" | "saving" | "unsaved" | "error";
export type Layout = "split" | "editor" | "pdf";

const TEXT_EXT = new Set([
  "tex", "bib", "sty", "cls", "bst", "bbx", "cbx", "txt", "md", "ltx", "dtx", "ins", "cfg", "def",
  "clo", "log", "json", "yaml", "yml", "csv", "tsv", "lua", "py", "r", "m", "gitignore", "latexmkrc",
  "tikz", "pgf", "dat", "asy", "mp",
]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp"]);

export function extension(path: string): string {
  const name = basename(path);
  const i = name.lastIndexOf(".");
  return i <= 0 ? name.toLowerCase().replace(/^\./, "") : name.slice(i + 1).toLowerCase();
}

export function fileKind(path: string): FileKind {
  const ext = extension(path);
  if (IMAGE_EXT.has(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (TEXT_EXT.has(ext) || !basename(path).includes(".")) return "text";
  return "binary";
}

interface ProjectPrefs {
  displayName?: string;
  mainDocument?: string;
  engine?: Engine;
  autoCompile?: boolean;
  draft?: boolean;
  stopOnFirstError?: boolean;
}

export interface RecentProject {
  root: string;
  name: string;
  lastOpened: number;
}

export interface Toast {
  id: number;
  kind: "info" | "error" | "success";
  message: string;
}

export const state = reactive({
  info: null as ProjectInfo | null,
  displayName: "",
  tree: [] as FileNode[],
  expanded: {} as Record<string, boolean>,
  selectedPath: null as string | null,

  openPath: null as string | null,
  openKind: null as FileKind | null,
  content: "",
  savedContent: "",
  saveState: "saved" as SaveState,
  lastSavedAt: null as number | null,
  binaryData: null as Uint8Array | null,
  cursor: { line: 1, col: 1 },

  mainDocument: null as string | null,
  engines: [] as EngineInfo[],
  engine: "pdflatex" as Engine,
  autoCompile: false,
  draft: false,
  stopOnFirstError: false,

  compiling: false,
  compileQueued: false,
  result: null as CompileResult | null,
  compileError: null as string | null,
  lastCompileAt: 0,
  pdfData: null as Uint8Array | null,
  pdfPath: null as string | null,
  pdfVersion: 0,
  synctexAvailable: false,
  highlights: [] as PdfLocation[],
  highlightVersion: 0,

  /** Text of every .tex/.bib file, for autocomplete, word count and outline of other files. */
  texts: {} as Record<string, string>,

  ui: {
    showLogs: false,
    showOutline: true,
    sidebarCollapsed: false,
    /** "New file"/"New folder" prompts, opened from the file tree or the menu bar. */
    fileModal: null as null | "file" | "folder",
    showRawLog: false,
    layout: "split" as Layout,
    settingsOpen: false,
    settingsTab: "editor" as "editor" | "compiler" | "appearance" | "shortcuts" | "agent",
    wordCountOpen: false,
    /** Set by File → New Project; the dashboard opens its "new project" prompt. */
    newProjectRequested: false,
  },
  recent: loadRecent(),
  toasts: [] as Toast[],
});

// ---------------------------------------------------------------------------
// Editor bridge (implemented by CodeEditor.vue)
// ---------------------------------------------------------------------------

export type EditorCommand = "find" | "replace" | "gotoLine" | "comment" | "bold" | "italic";

export const editorBridge: {
  setContent?: (text: string) => void;
  goto?: (line: number, column?: number) => void;
  focus?: () => void;
  /** Runs an editor command (menu bar). */
  command?: (cmd: EditorCommand) => void;
  /** Inserts a CodeMirror snippet (`#{}` fields) at the cursor, wrapping the selection into the first field. */
  insert?: (template: string, complete?: boolean) => void;
} = {};

// A shortcut can reach both the web view and the native menu; run each action once.
const lastRun = new Map<string, number>();
export function recentlyRan(action: string, windowMs = 400): boolean {
  const now = Date.now();
  const prev = lastRun.get(action) ?? 0;
  lastRun.set(action, now);
  return now - prev < windowMs;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

let toastId = 0;
export function notify(message: string, kind: Toast["kind"] = "info") {
  const id = ++toastId;
  state.toasts.push({ id, kind, message });
  setTimeout(() => dismissToast(id), kind === "error" ? 7000 : 3500);
}

export function dismissToast(id: number) {
  const i = state.toasts.findIndex((t) => t.id === id);
  if (i >= 0) state.toasts.splice(i, 1);
}

async function guarded<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    notify(errorMessage(e), "error");
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Recent projects & per-project prefs
// ---------------------------------------------------------------------------

function loadRecent(): RecentProject[] {
  try {
    return JSON.parse(localStorage.getItem("texcraft:recent") ?? "[]");
  } catch {
    return [];
  }
}

function saveRecent() {
  try {
    localStorage.setItem("texcraft:recent", JSON.stringify(state.recent.slice(0, 30)));
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
    const prefs: ProjectPrefs = JSON.parse(localStorage.getItem(prefsKey(oldRoot)) ?? "{}");
    if (newName) prefs.displayName = newName;
    localStorage.setItem(prefsKey(newRoot), JSON.stringify(prefs));
    if (newRoot !== oldRoot) localStorage.removeItem(prefsKey(oldRoot));
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
    localStorage.removeItem(prefsKey(root));
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
  return `texcraft:project:${root}`;
}

function loadPrefs(root: string): ProjectPrefs {
  try {
    return JSON.parse(localStorage.getItem(prefsKey(root)) ?? "{}");
  } catch {
    return {};
  }
}

function savePrefs() {
  if (!state.info) return;
  const prefs: ProjectPrefs = {
    displayName: state.displayName,
    mainDocument: state.mainDocument ?? undefined,
    engine: state.engine,
    autoCompile: state.autoCompile,
    draft: state.draft,
    stopOnFirstError: state.stopOnFirstError,
  };
  try {
    localStorage.setItem(prefsKey(state.info.root), JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

watch(
  () => [state.displayName, state.mainDocument, state.engine, state.autoCompile, state.draft, state.stopOnFirstError],
  savePrefs,
);

watch(
  () => [state.displayName, state.info] as const,
  ([name]) => {
    void getCurrentWindow()
      .setTitle(state.info ? `${name} — LocalLeaf` : "LocalLeaf")
      .catch(() => undefined);
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

  const prefs = loadPrefs(info.root);
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
  state.engine = prefs.engine && installed.includes(prefs.engine) ? prefs.engine : installed[0] ?? "pdflatex";
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
  if (state.mainDocument) {
    for (const dir of ancestors(state.mainDocument)) state.expanded[dir] = true;
    await openFile(state.mainDocument);
    // Like Overleaf, show a fresh preview as soon as the project opens.
    void compile();
  }
}

function resetProjectState() {
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

export function renameProject(name: string) {
  const trimmed = name.trim();
  if (!trimmed || !state.info) return;
  state.displayName = trimmed;
  const recent = state.recent.find((r) => r.root === state.info!.root);
  if (recent) {
    recent.name = trimmed;
    saveRecent();
  }
}

async function subscribeToEvents() {
  unlisteners.forEach((u) => u());
  unlisteners = [
    await listen<{ paths: string[] }>("project://changed", (e) => void onExternalChange(e.payload.paths)),
    await listen("project://pdf-changed", () => {
      // Ignore the echo of our own compile; reload when an agent compiled via MCP.
      if (!state.compiling && Date.now() - state.lastCompileAt > 2000) void reloadPdf();
    }),
  ];
}

// ---------------------------------------------------------------------------
// File tree
// ---------------------------------------------------------------------------

export function allFiles(nodes: FileNode[]): string[] {
  return nodes.flatMap((n) => (n.isDir ? allFiles(n.children ?? []) : [n.path]));
}

export function findNode(path: string, nodes: FileNode[] = state.tree): FileNode | null {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.children) {
      const found = findNode(path, n.children);
      if (found) return found;
    }
  }
  return null;
}

function ancestors(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

export async function refreshTree() {
  const tree = await guarded(() => ipc.getTree());
  if (tree) state.tree = tree;
}

/** Folder that new files go into: the selected folder, or the selected file's folder. */
export function targetFolder(): string {
  const sel = state.selectedPath;
  if (!sel) return "";
  const node = findNode(sel);
  return node?.isDir ? sel : dirname(sel);
}

async function indexProject() {
  const paths = allFiles(state.tree).filter((p) => /\.(tex|bib)$/.test(p));
  const entries = await Promise.all(
    paths.map(async (p) => [p, await ipc.readFile(p).catch(() => "")] as const),
  );
  state.texts = Object.fromEntries(entries);
}

export function projectLabels(): string[] {
  return [...new Set(Object.entries(state.texts).filter(([p]) => p.endsWith(".tex")).flatMap(([, t]) => extractLabels(t)))];
}

export function projectBibKeys(): { key: string; info: string }[] {
  return Object.entries(state.texts)
    .filter(([p]) => p.endsWith(".bib"))
    .flatMap(([, t]) => extractBibKeys(t));
}

export async function newFile(name: string) {
  const path = joinTarget(name);
  if ((await guarded(() => ipc.createFile(path))) === undefined) return;
  await refreshTree();
  state.expanded[targetFolder()] = true;
  if (fileKind(path) === "text") state.texts[path] = "";
  await openFile(path);
}

export async function newFolder(name: string) {
  const path = joinTarget(name);
  if ((await guarded(() => ipc.createFolder(path))) === undefined) return;
  state.expanded[path] = true;
  await refreshTree();
}

function joinTarget(name: string) {
  const dir = targetFolder();
  return dir ? `${dir}/${name.trim()}` : name.trim();
}

export async function renamePath(from: string, to: string) {
  if (from === to) return;
  await flushSave();
  if ((await guarded(() => ipc.rename(from, to))) === undefined) return;
  const remap = (p: string | null) =>
    p && (p === from || p.startsWith(from + "/")) ? to + p.slice(from.length) : p;
  state.openPath = remap(state.openPath);
  state.selectedPath = remap(state.selectedPath);
  state.mainDocument = remap(state.mainDocument);
  for (const key of Object.keys(state.texts)) {
    const next = remap(key)!;
    if (next !== key) {
      state.texts[next] = state.texts[key];
      delete state.texts[key];
    }
  }
  await refreshTree();
}

export async function deletePath(path: string) {
  if ((await guarded(() => ipc.remove(path))) === undefined) return;
  const gone = (p: string | null) => !!p && (p === path || p.startsWith(path + "/"));
  if (gone(state.openPath)) {
    state.openPath = null;
    state.openKind = null;
    state.content = state.savedContent = "";
    state.saveState = "saved";
  }
  if (gone(state.selectedPath)) state.selectedPath = null;
  for (const key of Object.keys(state.texts)) if (gone(key)) delete state.texts[key];
  await refreshTree();
  if (gone(state.mainDocument)) {
    state.mainDocument = allFiles(state.tree).find((p) => p.endsWith(".tex")) ?? null;
  }
}

export async function importFiles(paths: string[], targetDir = targetFolder()) {
  const imported = await guarded(() => ipc.importFiles(targetDir, paths));
  if (!imported) return;
  if (targetDir) state.expanded[targetDir] = true;
  await refreshTree();
  for (const p of imported.filter((p) => /\.(tex|bib)$/.test(p))) {
    state.texts[p] = await ipc.readFile(p).catch(() => "");
  }
  notify(`Uploaded ${imported.length} file${imported.length === 1 ? "" : "s"}`, "success");
}

// ---------------------------------------------------------------------------
// Editing & saving (local-first autosave)
// ---------------------------------------------------------------------------

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let autoCompileTimer: ReturnType<typeof setTimeout> | undefined;
const SAVE_DELAY = 600;
const AUTO_COMPILE_DELAY = 2000;

export async function openFile(path: string) {
  if (path === state.openPath) return;
  await flushSave();
  const kind = fileKind(path);
  state.selectedPath = path;
  state.binaryData = null;
  if (kind === "text") {
    const text = await guarded(() => ipc.readFile(path));
    if (text === undefined) return;
    state.openPath = path;
    state.openKind = kind;
    state.content = state.savedContent = text;
    state.saveState = "saved";
    if (/\.(tex|bib)$/.test(path)) state.texts[path] = text;
    await nextTick();
    editorBridge.setContent?.(text);
  } else {
    state.openPath = path;
    state.openKind = kind;
    state.binaryData = (await guarded(() => ipc.readBinary(path))) ?? null;
  }
}

/** Called by the editor on every document change. */
export function updateContent(text: string) {
  if (text === state.content) return;
  state.content = text;
  if (state.openPath && /\.(tex|bib)$/.test(state.openPath)) state.texts[state.openPath] = text;
  state.saveState = text === state.savedContent ? "saved" : "unsaved";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), SAVE_DELAY);
  if (state.autoCompile) {
    clearTimeout(autoCompileTimer);
    autoCompileTimer = setTimeout(() => void compile(), AUTO_COMPILE_DELAY);
  }
}

/**
 * Contents LocalLeaf itself wrote recently, per file. The file watcher reports our own
 * autosaves too; matching them here keeps those echoes from looking like external edits.
 */
const ownWrites = new Map<string, string[]>();
function rememberOwnWrite(path: string, content: string) {
  const list = ownWrites.get(path) ?? [];
  list.push(content);
  ownWrites.set(path, list.slice(-8));
}

export async function save() {
  clearTimeout(saveTimer);
  const path = state.openPath;
  if (!path || state.openKind !== "text" || state.content === state.savedContent) return;
  const content = state.content;
  state.saveState = "saving";
  rememberOwnWrite(path, content);
  try {
    await ipc.writeFile(path, content);
    if (state.openPath === path) {
      state.savedContent = content;
      state.saveState = state.content === content ? "saved" : "unsaved";
      state.lastSavedAt = Date.now();
    }
  } catch (e) {
    state.saveState = "error";
    notify(`Could not save ${path}: ${errorMessage(e)}`, "error");
  }
}

export async function flushSave() {
  if (state.saveState === "unsaved" || state.saveState === "error") await save();
}

/** Applies edits made outside the app (another editor, or an AI agent through MCP). */
async function onExternalChange(paths: string[]) {
  await refreshTree();
  for (const p of paths) {
    if (!/\.(tex|bib)$/.test(p) && p !== state.openPath) continue;
    const text = await ipc.readFile(p).catch(() => null);
    if (text === null) continue;
    // Our own autosave coming back through the watcher: nothing changed externally.
    if (ownWrites.get(p)?.includes(text)) continue;
    if (/\.(tex|bib)$/.test(p)) state.texts[p] = text;
    if (p === state.openPath && state.openKind === "text" && text !== state.content) {
      if (state.content === state.savedContent) {
        state.content = state.savedContent = text;
        editorBridge.setContent?.(text);
        notify(`${basename(p)} was updated on disk`);
      } else {
        notify(`${basename(p)} changed on disk while you were editing; your version will be kept`, "error");
      }
    }
  }
  if (state.openPath && state.openKind !== "text" && paths.includes(state.openPath)) {
    state.binaryData = await ipc.readBinary(state.openPath).catch(() => null);
  }
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

/** `queued` marks the internal re-run of a request that arrived mid-compile (never deduplicated). */
export async function compile(queued = false) {
  clearTimeout(autoCompileTimer);
  if (!state.info || (!queued && recentlyRan("compile"))) return;
  if (!state.mainDocument) {
    notify("No main document: create a .tex file or choose one in Settings → Compiler", "error");
    return;
  }
  if (state.compiling) {
    state.compileQueued = true;
    return;
  }
  await flushSave();
  state.compiling = true;
  state.compileError = null;
  try {
    const result = await ipc.compile(state.mainDocument, state.engine, {
      draft: state.draft,
      stop_on_first_error: state.stopOnFirstError,
    });
    state.result = result;
    if (result.pdf_path) {
      state.pdfPath = result.pdf_path;
      await reloadPdf();
    }
    // With no new PDF there is nothing else to look at: open the logs, as Overleaf does.
    if (!result.pdf_path) state.ui.showLogs = true;
  } catch (e) {
    state.result = null;
    state.compileError = errorMessage(e);
    state.ui.showLogs = true;
  } finally {
    state.compiling = false;
    state.lastCompileAt = Date.now();
  }
  if (state.compileQueued) {
    state.compileQueued = false;
    void compile(true);
  }
}

export async function recompileFromScratch() {
  await guarded(() => ipc.clearBuildDir());
  await compile(true);
}

async function reloadPdf() {
  const path = state.pdfPath ?? (state.mainDocument ? `.texcraft/build/${basename(state.mainDocument).replace(/\.tex$/, "")}.pdf` : null);
  if (!path) return;
  const data = await ipc.readBinary(path).catch(() => null);
  if (data) {
    state.pdfPath = path;
    state.pdfData = data;
    state.pdfVersion++;
  }
}

export function diagnostics(): { errors: Diagnostic[]; warnings: Diagnostic[]; badBoxes: Diagnostic[] } {
  const r = state.result;
  return {
    errors: r?.errors ?? [],
    warnings: r?.warnings.filter((w) => w.kind === "warning") ?? [],
    badBoxes: r?.warnings.filter((w) => w.kind === "bad_box") ?? [],
  };
}

// ---------------------------------------------------------------------------
// Navigation & SyncTeX
// ---------------------------------------------------------------------------

export async function gotoLocation(file: string | null, line: number | null) {
  const target = file ?? state.mainDocument;
  if (!target) return;
  if (!findNode(target)) {
    notify(`${target} is not part of the project`, "error");
    return;
  }
  for (const dir of ancestors(target)) state.expanded[dir] = true;
  await openFile(target);
  await nextTick();
  if (line) editorBridge.goto?.(line);
  editorBridge.focus?.();
}

/** Editor → PDF. */
export async function syncToPdf() {
  if (!state.mainDocument || !state.openPath || !state.openPath.endsWith(".tex")) return;
  if (!state.pdfData) {
    notify("Compile the project to use SyncTeX");
    return;
  }
  await flushSave();
  const boxes = await guarded(() =>
    ipc.synctexForward(state.mainDocument!, state.openPath!, state.cursor.line, state.cursor.col),
  );
  if (!boxes) return;
  if (!boxes.length) {
    notify("No matching location in the PDF; try recompiling");
    return;
  }
  state.ui.showLogs = false;
  state.highlights = boxes;
  state.highlightVersion++;
}

/** PDF → editor. Coordinates are PDF points from the top-left of the page. */
export async function syncToCode(page: number, x: number, y: number) {
  if (!state.mainDocument) return;
  const loc = await guarded(() => ipc.synctexInverse(state.mainDocument!, page, x, y));
  if (loc) await gotoLocation(loc.file, loc.line);
  else if (loc === null) notify("No matching source location");
}
