// Files: the project tree, opening and autosaving files, disk changes and conflicts.
import { nextTick } from "vue";
import { ask } from "@tauri-apps/plugin-dialog";
import { ipc, errorMessage } from "./ipc";
import { basename, dirname, extractBibKeys, extractLabels } from "./latex";
import { allFiles, editorBridge, fileKind, findNode, guarded, notify, session, state } from "./state";
import { scheduleAutoCompile } from "./compile";

// ---------------------------------------------------------------------------
// File tree
// ---------------------------------------------------------------------------

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

export async function indexProject() {
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
  const name = (p: string) => p.split(/[\\/]/).pop() ?? p;
  const existing = paths.filter((p) => findNode(targetDir ? `${targetDir}/${name(p)}` : name(p)));
  let overwrite = false;
  if (existing.length) {
    const list = existing.map(name).join(", ");
    overwrite = await ask(
      `${list} already ${existing.length === 1 ? "exists" : "exist"} in ${targetDir || "the project"}. Replace ${existing.length === 1 ? "it" : "them"}?`,
      { title: "Replace files?", kind: "warning", okLabel: "Replace", cancelLabel: "Skip" },
    ).catch(() => false);
    if (!overwrite) paths = paths.filter((p) => !existing.includes(p));
    if (!paths.length) return;
  }
  const imported = await guarded(() => ipc.importFiles(targetDir, paths, overwrite));
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
const SAVE_DELAY = 600;

/** Drops a pending autosave (the project is closing; its edits were already flushed). */
export function cancelPendingSave() {
  clearTimeout(saveTimer);
}

export async function openFile(path: string) {
  if (path === state.openPath) return;
  await flushSave();
  const gen = session.generation;
  const kind = fileKind(path);
  state.selectedPath = path;
  state.binaryData = null;
  if (kind === "text") {
    const text = await guarded(() => ipc.readFile(path));
    if (text === undefined || gen !== session.generation) return;
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
    const data = (await guarded(() => ipc.readBinary(path))) ?? null;
    if (gen === session.generation && state.openPath === path) state.binaryData = data;
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
  if (state.autoCompile) scheduleAutoCompile();
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

/** Saves run one at a time, in order: a later save can never be overtaken by an earlier one. */
let saveChain: Promise<void> = Promise.resolve();

export function save(): Promise<void> {
  clearTimeout(saveTimer);
  saveChain = saveChain.then(saveNow, saveNow);
  return saveChain;
}

async function saveNow() {
  const path = state.openPath;
  if (!path || state.openKind !== "text" || state.content === state.savedContent) return;
  // A disk conflict is pending: never overwrite the other version behind the user's back.
  if (state.conflict?.path === path) return;
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
    if (state.openPath === path) state.saveState = "error";
    notify(`Could not save ${path}: ${errorMessage(e)}`, "error");
  }
}

export async function flushSave() {
  if (state.saveState === "unsaved" || state.saveState === "error") await save();
  else await saveChain;
}

/** Resolves a disk conflict: keep the editor's text (and save it) or load the disk version. */
export async function resolveConflict(keep: "mine" | "disk") {
  const c = state.conflict;
  if (!c) return;
  state.conflict = null;
  if (c.path !== state.openPath) return;
  if (keep === "disk") {
    if (c.diskText === null) {
      resolveDeletedOpenFile(c.path);
      return;
    }
    state.content = state.savedContent = c.diskText;
    state.saveState = "saved";
    editorBridge.setContent?.(c.diskText);
  } else {
    state.savedContent = c.diskText ?? "";
    state.saveState = "unsaved";
    await save();
    await refreshTree();
  }
}

/** Applies edits made outside the app (another editor, or an AI agent through MCP). */
export async function onExternalChange(paths: string[]) {
  await refreshTree();
  for (const p of paths) {
    if (!/\.(tex|bib)$/.test(p) && p !== state.openPath) continue;
    const text = await ipc.readFile(p).catch(() => null);
    if (text === null) {
      if (findNode(p)) continue; // still there, unreadable for another reason: leave it alone
      delete state.texts[p];
      if (p === state.openPath && state.openKind === "text") {
        if (state.content === state.savedContent) resolveDeletedOpenFile(p);
        // Deleted while edited: ask, instead of silently recreating it on the next autosave.
        else state.conflict = { path: p, diskText: null };
      }
      continue;
    }
    // Our own autosave coming back through the watcher: nothing changed externally.
    if (ownWrites.get(p)?.includes(text)) continue;
    if (/\.(tex|bib)$/.test(p)) state.texts[p] = text;
    if (p === state.openPath && state.openKind === "text" && text !== state.content) {
      if (state.content === state.savedContent && state.saveState !== "saving") {
        state.content = state.savedContent = text;
        editorBridge.setContent?.(text);
        notify(`${basename(p)} was updated on disk`);
      } else {
        // Unsaved edits on both sides: ask instead of overwriting either version.
        clearTimeout(saveTimer);
        state.conflict = { path: p, diskText: text };
      }
    }
  }
  if (state.openPath && state.openKind !== "text" && paths.includes(state.openPath)) {
    state.binaryData = await ipc.readBinary(state.openPath).catch(() => null);
  }
}

function resolveDeletedOpenFile(path: string) {
  state.openPath = null;
  state.openKind = null;
  state.content = state.savedContent = "";
  state.saveState = "saved";
  notify(`${basename(path)} was deleted on disk`);
}

/** Saves everything before the window closes or the app quits. */
export async function flushBeforeExit() {
  clearTimeout(saveTimer);
  await flushSave();
}

