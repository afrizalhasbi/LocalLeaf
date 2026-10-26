// Renderer bridge: everything the UI needs from the app shell (Electron + Rust sidecar).
// Replaces the former Tauri API: same shapes, so call sites change minimally.

export type UnlistenFn = () => void;

interface DialogFilters {
  name: string;
  extensions: string[];
}

export interface DialogApi {
  /** Picks existing file(s); a directory when `directory` is set. Null on cancel. */
  open(options: { directory?: true; multiple?: true; title?: string }): Promise<string | string[] | null>;
  /** Picks a destination for a new file. Null on cancel. */
  save(options: { title?: string; defaultPath?: string; filters?: DialogFilters[] }): Promise<string | null>;
  /** Native yes/no message box. */
  ask(
    message: string,
    options?: { title?: string; kind?: "info" | "warning" | "error"; okLabel?: string; cancelLabel?: string },
  ): Promise<boolean>;
}

interface LocalLeaf {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
  listen(event: string, handler: (e: { payload: unknown }) => void): UnlistenFn;
  dialog: DialogApi;
  setTitle(title: string): Promise<void>;
  pathForFile(file: File): string | null;
}

declare global {
  interface Window {
    localleaf?: LocalLeaf;
  }
}

function api(): LocalLeaf {
  if (!window.localleaf) {
    throw new Error("the app bridge is unavailable — run inside the LocalLeaf desktop app");
  }
  return window.localleaf;
}

/** Calls the backend (Rust sidecar via the main process). Errors reject with a string. */
export function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return api().invoke(cmd, args) as Promise<T>;
}

/** Subscribes to a backend event (`project://changed`, `menu://action`, …). */
export async function listen<T = unknown>(
  event: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  return api().listen(event, (e) => handler(e.payload as T));
}

export const dialog: DialogApi = {
  open: (options) => api().dialog.open(options) as Promise<string | string[] | null>,
  save: (options) => api().dialog.save(options) as Promise<string | null>,
  ask: (message, options) => api().dialog.ask(message, options) as Promise<boolean>,
};

/** Picks existing file(s); a directory when `directory` is set. Null on cancel. */
export const open = dialog.open;
/** Picks a destination for a new file. Null on cancel. */
export const save = dialog.save;

export function setTitle(title: string) {
  api().setTitle(title).catch(() => undefined);
}

/** Absolute filesystem path of a file dropped from the OS file manager, if known. */
export function pathForFile(file: File): string | null {
  try {
    return window.localleaf?.pathForFile(file) ?? null;
  } catch {
    return null;
  }
}
