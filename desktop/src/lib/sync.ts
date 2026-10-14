// Navigation between the editor, the logs and the PDF (SyncTeX).
import { nextTick } from "vue";
import { ipc } from "./ipc";
import { ancestors, editorBridge, findNode, guarded, notify, state } from "./state";
import { flushSave, openFile } from "./files";

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
