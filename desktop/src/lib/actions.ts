// UI actions that need native dialogs.
import { open, save } from "@tauri-apps/plugin-dialog";
import { ipc, errorMessage } from "./ipc";
import { importFiles, notify, state } from "./store";
import { basename } from "./latex";

export async function downloadPdf() {
  if (!state.pdfPath) {
    notify("Compile the project first");
    return;
  }
  const destination = await save({
    title: "Download PDF",
    defaultPath: `${state.displayName || basename(state.pdfPath).replace(/\.pdf$/, "")}.pdf`,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (!destination) return;
  try {
    await ipc.exportFile(state.pdfPath, destination);
    notify("PDF saved", "success");
  } catch (e) {
    notify(errorMessage(e), "error");
  }
}

export async function uploadFiles() {
  const picked = await open({ multiple: true, title: "Upload files to the project" });
  if (!picked) return;
  const paths = Array.isArray(picked) ? picked : [picked];
  if (paths.length) await importFiles(paths);
}

export async function revealProject() {
  if (!state.info) return;
  try {
    await ipc.revealInFileManager(state.info.root);
  } catch (e) {
    notify(errorMessage(e), "error");
  }
}

export async function copyProjectPath() {
  if (!state.info) return;
  try {
    await navigator.clipboard.writeText(state.info.root);
    notify("Folder path copied", "success");
  } catch {
    notify(state.info.root);
  }
}
