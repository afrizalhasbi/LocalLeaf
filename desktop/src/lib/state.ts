// Shared application state: the local-first equivalent of Overleaf's editor context.
// Actions live in projects.ts, files.ts, compile.ts and sync.ts (all re-exported by store.ts).
import { reactive } from "vue";
import {
  errorMessage,
  type CompileResult,
  type Engine,
  type EngineInfo,
  type FileNode,
  type PdfLocation,
  type ProjectInfo,
  type ProjectSettings,
} from "./ipc";
import { basename } from "./latex";
import { readStored } from "./storage";

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

export type ProjectPrefs = ProjectSettings;

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

export function loadRecent(): RecentProject[] {
  try {
    return JSON.parse(readStored("recent") ?? "[]");
  } catch {
    return [];
  }
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

  /**
   * The open file changed (or was deleted) on disk while it had unsaved edits. Autosave is
   * paused until the user chooses which version to keep.
   */
  conflict: null as null | { path: string; diskText: string | null },

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

export async function guarded<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    notify(errorMessage(e), "error");
    return undefined;
  }
}


/**
 * Bumped whenever the open project changes. Async work (compile, file reads) started for a
 * previous project compares it before touching the state, so late results are dropped.
 */
export const session = { generation: 0 };

// ---------------------------------------------------------------------------
// File tree helpers
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

export function ancestors(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

