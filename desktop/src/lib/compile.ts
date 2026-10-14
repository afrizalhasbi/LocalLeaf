// Compilation: running the TeX engine, loading the PDF, diagnostics and auto-compile.
import { ipc, errorMessage, type Diagnostic } from "./ipc";
import { basename } from "./latex";
import { guarded, notify, recentlyRan, session, state } from "./state";
import { flushSave } from "./files";

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

/** `queued` marks the internal re-run of a request that arrived mid-compile (never deduplicated). */
let autoCompileTimer: ReturnType<typeof setTimeout> | undefined;
const AUTO_COMPILE_DELAY = 2000;

/** Recompiles a couple of seconds after the last edit (Auto compile). */
export function scheduleAutoCompile() {
  clearTimeout(autoCompileTimer);
  autoCompileTimer = setTimeout(() => void compile(), AUTO_COMPILE_DELAY);
}

export function cancelAutoCompile() {
  clearTimeout(autoCompileTimer);
}

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
  const gen = session.generation;
  state.compiling = true;
  state.compileError = null;
  try {
    const result = await ipc.compile(state.mainDocument, state.engine, {
      draft: state.draft,
      stop_on_first_error: state.stopOnFirstError,
    });
    // Results of a project that is no longer open are dropped.
    if (gen === session.generation) {
      state.result = result;
      if (result.pdf_path) {
        state.pdfPath = result.pdf_path;
        await reloadPdf();
      }
      // With no new PDF there is nothing else to look at: open the logs, as Overleaf does.
      if (!result.pdf_path) state.ui.showLogs = true;
    }
  } catch (e) {
    if (gen === session.generation) {
      state.result = null;
      state.compileError = errorMessage(e);
      state.ui.showLogs = true;
    }
  } finally {
    state.compiling = false;
    state.lastCompileAt = Date.now();
  }
  // A request that arrived meanwhile (possibly for a newly opened project) runs now.
  if (state.compileQueued) {
    state.compileQueued = false;
    void compile(true);
  }
}

export async function recompileFromScratch() {
  await guarded(() => ipc.clearBuildDir());
  await compile(true);
}

export async function reloadPdf() {
  const path = state.pdfPath ?? (state.mainDocument ? `.texcraft/build/${basename(state.mainDocument).replace(/\.tex$/, "")}.pdf` : null);
  if (!path) return;
  const gen = session.generation;
  const data = await ipc.readBinary(path).catch(() => null);
  if (data && gen === session.generation) {
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

