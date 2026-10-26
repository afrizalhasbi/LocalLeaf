// LocalLeaf Electron main process.
//
// Owns the window, the native menu, the dialogs and the lifecycle; all project logic
// (compilation, file watching, SyncTeX…) lives in the Rust sidecar, which speaks
// newline-delimited JSON on stdio. This process is a thin proxy between the two.

const { app, BrowserWindow, Menu, dialog, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const readline = require("node:readline");

/** @type {BrowserWindow | null} */
let win = null;
/** @type {import('node:child_process').ChildProcess | null} */
let sidecar = null;
let quitting = false;
let exitAllowed = false;
let exitTimer = null;
let initialProject = null;

// ---------------------------------------------------------------------------
// Sidecar (Rust backend)
// ---------------------------------------------------------------------------

function sidecarPath() {
  // Installed layout: <app dir>/resources/sidecar/localleaf-sidecar (see the Makefile).
  const installed = path.join(app.getAppPath(), "resources", "sidecar", "localleaf-sidecar");
  if (fs.existsSync(installed)) return installed;
  // Development: the workspace's cargo build output.
  return path.join(__dirname, "..", "..", "target", "release", "localleaf-sidecar");
}

const pending = new Map();
let nextRequestId = 1;

/** Sends a command to the sidecar and resolves with its reply (rejects with the error string). */
function request(cmd, args = {}) {
  return new Promise((resolve, reject) => {
    if (!sidecar || sidecar.exitCode !== null) return reject(`backend is not running (${cmd})`);
    const id = nextRequestId++;
    pending.set(id, { resolve, reject, cmd });
    sidecar.stdin.write(JSON.stringify({ id, cmd, args }) + "\n");
  });
}

function startSidecar() {
  const bin = sidecarPath();
  if (!fs.existsSync(bin)) {
    dialog.showErrorBox("LocalLeaf", `Backend binary not found at ${bin}. Build it with 'cargo build --release -p localleaf-sidecar'.`);
    app.exit(1);
    return;
  }
  sidecar = spawn(bin, ["--ipc"], { stdio: ["pipe", "pipe", "inherit"] });
  const rl = readline.createInterface({ input: sidecar.stdout });
  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.event !== undefined) {
      // Backend event (compile lifecycle, file watcher…): forward to the UI.
      if (win && !win.isDestroyed()) win.webContents.send("localleaf:event", msg);
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.err !== undefined) p.reject(msg.err);
    else p.resolve(msg.ok);
  });
  sidecar.on("exit", (code) => {
    for (const p of pending.values()) p.reject(`backend exited (${p.cmd})`);
    pending.clear();
    if (!quitting && code !== 0) {
      dialog.showErrorBox("LocalLeaf", `The backend process exited unexpectedly (${code}).`);
      app.exit(1);
    }
  });
}

// ---------------------------------------------------------------------------
// Native menu (mirrors the UI's state through update_menu_state)
// ---------------------------------------------------------------------------

const ENGINES = [
  ["pdflatex", "pdfLaTeX"],
  ["xelatex", "XeLaTeX"],
  ["lualatex", "LuaLaTeX"],
  ["tectonic", "Tectonic"],
];

// Items that only make sense with a project open (and which of those need a compiled PDF).
const PROJECT_ITEMS = [
  "file.new_file", "file.new_folder", "file.upload", "file.save", "file.reveal", "file.close_project",
  "edit.find", "edit.replace", "edit.goto_line", "edit.comment", "edit.bold", "edit.italic",
  "insert.section", "insert.subsection", "insert.subsubsection", "insert.itemize", "insert.enumerate",
  "insert.figure", "insert.table", "insert.equation", "insert.align", "insert.cite", "insert.ref",
  "insert.label", "insert.footnote", "insert.link",
  "view.font_bigger", "view.font_smaller", "view.font_reset",
  "build.compile", "build.compile_scratch", "build.sync_to_pdf", "build.sync_to_code", "build.word_count",
  "build.set_main", "build.clear_cache", "help.mcp",
];
const PDF_ITEMS = ["file.download_pdf", "build.sync_to_pdf", "build.sync_to_code"];
const CHECK_ITEMS = [
  "build.auto_compile", "build.draft", "build.stop_on_error",
  "view.file_tree", "view.outline", "view.logs",
];

/** @type {Electron.Menu | null} */
let menu = null;

function menuItem(id) {
  return menu?.getMenuItemById(id) ?? null;
}

function updateMenuState(sync = {}) {
  if (!menu) return;
  for (const id of PROJECT_ITEMS) {
    const item = menuItem(id);
    if (item) item.enabled = !!sync.projectOpen && (!PDF_ITEMS.includes(id) || !!sync.hasPdf);
  }
  for (const [id, checked] of [
    ...ENGINES.map(([engine]) => [`engine:${engine}`, sync.engine === engine]),
    ...CHECK_ITEMS.map((id) => [id, !!sync[id]]),
    ...["layout:split", "layout:editor", "layout:pdf"].map((id) => [id, sync.layout === id.slice(7)]),
    ...["theme:dark", "theme:light", "theme:system"].map((id) => [id, sync.theme === id.slice(6)]),
  ]) {
    const item = menuItem(id);
    if (!item) continue;
    item.checked = !!checked;
    if (id.startsWith("engine:") || CHECK_ITEMS.includes(id) || id.startsWith("layout:")) {
      item.enabled = !!sync.projectOpen;
    }
  }
}

function installMenu() {
  // Helper: an item that forwards its click to the UI as a `menu://action` event.
  const item = (id, label, accelerator) => ({
    id,
    label,
    accelerator,
    click: () => win?.webContents.send("localleaf:event", { event: "menu://action", payload: id }),
  });
  const isMac = process.platform === "darwin";

  const appMenu = {
    label: "LocalLeaf",
    submenu: [
      { role: "about" },
      { type: "separator" },
      item("app.settings", "Settings…", "CmdOrCtrl+,"),
      ...(isMac ? [{ type: "separator" }, { role: "services" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }] : []),
      { type: "separator" },
      // Our own Quit (not the predefined role): it lets the UI flush pending edits first.
      item("app.quit", "Quit LocalLeaf", "CmdOrCtrl+Q"),
    ],
  };
  const file = {
    label: "File",
    submenu: [
      item("file.new_project", "New Project…", "CmdOrCtrl+Shift+N"),
      item("file.open", "Open Folder…", "CmdOrCtrl+O"),
      item("file.projects", "All Projects", "CmdOrCtrl+Shift+P"),
      { type: "separator" },
      item("file.new_file", "New File…", "CmdOrCtrl+N"),
      item("file.new_folder", "New Folder…", "CmdOrCtrl+Alt+N"),
      item("file.upload", "Upload Files…", "CmdOrCtrl+U"),
      { type: "separator" },
      item("file.save", "Save", "CmdOrCtrl+S"),
      item("file.download_pdf", "Download PDF…", "CmdOrCtrl+Shift+S"),
      item("file.reveal", "Show Project in Finder", "CmdOrCtrl+Alt+R"),
      { type: "separator" },
      item("file.close_project", "Close Project", "CmdOrCtrl+Shift+W"),
      { role: "close" },
    ],
  };
  const edit = {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
      { type: "separator" },
      item("edit.find", "Find…", "CmdOrCtrl+F"),
      item("edit.replace", "Find and Replace…", "CmdOrCtrl+Alt+F"),
      item("edit.goto_line", "Go to Line…", "CmdOrCtrl+L"),
      { type: "separator" },
      item("edit.comment", "Toggle Comment", "CmdOrCtrl+/"),
      item("edit.bold", "Bold", "CmdOrCtrl+B"),
      item("edit.italic", "Italic", "CmdOrCtrl+I"),
    ],
  };
  const insert = {
    label: "Insert",
    submenu: [
      item("insert.section", "Section", "CmdOrCtrl+Alt+1"),
      item("insert.subsection", "Subsection", "CmdOrCtrl+Alt+2"),
      item("insert.subsubsection", "Subsub-section", "CmdOrCtrl+Alt+3"),
      { type: "separator" },
      item("insert.itemize", "Bulleted List"),
      item("insert.enumerate", "Numbered List"),
      item("insert.figure", "Figure"),
      item("insert.table", "Table"),
      { type: "separator" },
      item("insert.equation", "Equation", "CmdOrCtrl+Alt+E"),
      item("insert.align", "Aligned Equations"),
      { type: "separator" },
      item("insert.cite", "Citation"),
      item("insert.ref", "Cross-reference"),
      item("insert.label", "Label"),
      item("insert.footnote", "Footnote"),
      item("insert.link", "Link", "CmdOrCtrl+K"),
    ],
  };
  const layout = {
    label: "Layout",
    submenu: [
      item("layout:split", "Editor & PDF", "CmdOrCtrl+1"),
      item("layout:editor", "Editor Only", "CmdOrCtrl+2"),
      item("layout:pdf", "PDF Only", "CmdOrCtrl+3"),
    ],
  };
  const theme = {
    label: "Theme",
    submenu: [
      item("theme:dark", "Dark"),
      item("theme:light", "Light"),
      item("theme:system", "Match System"),
    ],
  };
  const view = {
    label: "View",
    submenu: [
      layout,
      { type: "separator" },
      item("view.file_tree", "File Tree", "CmdOrCtrl+Alt+B"),
      item("view.outline", "File Outline", "CmdOrCtrl+Shift+O"),
      item("view.logs", "Logs and Errors", "CmdOrCtrl+Shift+L"),
      { type: "separator" },
      item("view.font_bigger", "Bigger Editor Font", "CmdOrCtrl+="),
      item("view.font_smaller", "Smaller Editor Font", "CmdOrCtrl+-"),
      item("view.font_reset", "Default Editor Font Size", "CmdOrCtrl+0"),
      { type: "separator" },
      theme,
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  };
  const compiler = {
    label: "Compiler",
    submenu: ENGINES.map(([engine, label]) => item(`engine:${engine}`, label)),
  };
  const build = {
    label: "Project",
    submenu: [
      item("build.compile", "Recompile", "CmdOrCtrl+Enter"),
      item("build.compile_scratch", "Recompile from Scratch", "CmdOrCtrl+Shift+Enter"),
      { type: "separator" },
      compiler,
      item("build.auto_compile", "Auto Compile"),
      item("build.draft", "Fast Draft Mode"),
      item("build.stop_on_error", "Stop on First Error"),
      { type: "separator" },
      item("build.sync_to_pdf", "Go to Location in PDF", "CmdOrCtrl+Alt+Right"),
      item("build.sync_to_code", "Go to Location in Code", "CmdOrCtrl+Alt+Left"),
      { type: "separator" },
      item("build.set_main", "Set Current File as Main Document"),
      item("build.word_count", "Word Count", "CmdOrCtrl+Shift+C"),
      item("build.clear_cache", "Clear Cached Files"),
    ],
  };
  const windowMenu = {
    label: "Window",
    submenu: [{ role: "minimize" }, { role: "zoom" }],
  };
  const help = {
    label: "Help",
    submenu: [
      item("help.shortcuts", "Keyboard Shortcuts", "CmdOrCtrl+Shift+/"),
      item("help.mcp", "Connect an AI Agent (MCP)…"),
      { type: "separator" },
      item("help.latex_guide", "LaTeX Guide (Wikibooks)"),
      item("help.ctan", "Search Packages on CTAN"),
    ],
  };

  // Checkable items get type: "checkbox"; checked/enabled are pushed by update_menu_state.
  const template = [appMenu, file, edit, insert, view, build, windowMenu, help];
  for (const menu_ of template) {
    for (const entry of menu_.submenu) {
      const id = typeof entry === "object" ? entry.id : null;
      if (id && (id.startsWith("engine:") || id.startsWith("layout:") || id.startsWith("theme:") || CHECK_ITEMS.includes(id))) {
        entry.type = "checkbox";
      }
    }
  }
  menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// ---------------------------------------------------------------------------
// Exit handshake (the UI saves pending edits before the app quits)
// ---------------------------------------------------------------------------

function requestExit() {
  if (exitAllowed || !win || win.isDestroyed()) {
    exitAllowed = true;
    app.exit(0);
    return;
  }
  win.webContents.send("localleaf:event", { event: "app://exit-requested", payload: null });
  clearTimeout(exitTimer);
  // A hung UI must not block quitting forever.
  exitTimer = setTimeout(() => {
    exitAllowed = true;
    app.exit(0);
  }, 3000);
}

// ---------------------------------------------------------------------------
// Dialogs (the renderer asks for them through the preload bridge)
// ---------------------------------------------------------------------------

async function showOpenDialog(sender, opts = {}) {
  const window = BrowserWindow.fromWebContents(sender);
  const properties = opts.directory ? ["openDirectory"] : ["openFile"];
  if (opts.multiple) properties.push("multiSelections");
  const r = await dialog.showOpenDialog(window, {
    title: opts.title,
    defaultPath: opts.defaultPath,
    properties,
  });
  if (r.canceled || !r.filePaths.length) return null;
  return opts.multiple ? r.filePaths : r.filePaths[0];
}

async function showSaveDialog(sender, opts = {}) {
  const window = BrowserWindow.fromWebContents(sender);
  const r = await dialog.showSaveDialog(window, {
    title: opts.title,
    defaultPath: opts.defaultPath,
    filters: opts.filters?.map((f) => ({ name: f.name, extensions: f.extensions })),
  });
  if (r.canceled || !r.filePath) return null;
  return r.filePath;
}

async function askDialog(sender, opts = {}) {
  const window = BrowserWindow.fromWebContents(sender);
  const r = await dialog.showMessageBox(window, {
    message: opts.message,
    title: opts.title,
    type: opts.kind === "warning" ? "warning" : opts.kind === "error" ? "error" : "info",
    buttons: [opts.okLabel ?? "Yes", opts.cancelLabel ?? "No"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  return r.response === 0;
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function findInitialProject() {
  // `LocalLeaf path/to/project` opens that folder (dev: `electron . path/to/project`).
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  for (const arg of args) {
    if (!arg.startsWith("-") && arg !== "." && fs.existsSync(arg) && fs.statSync(arg).isDirectory()) {
      return fs.realpathSync(arg);
    }
  }
  return null;
}

function createWindow() {
  win = new BrowserWindow({
    title: "LocalLeaf",
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  const devUrl = process.env.ELECTRON_START_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  win.once("ready-to-show", () => win.show());
  win.on("close", (e) => {
    if (!exitAllowed) {
      e.preventDefault();
      requestExit();
    }
  });
  win.on("closed", () => {
    win = null;
  });
}

app.on("before-quit", (e) => {
  quitting = true;
  if (!exitAllowed) {
    e.preventDefault();
    requestExit();
  }
});

app.on("will-quit", () => {
  sidecar?.kill();
});

app.on("window-all-closed", () => {
  quitting = true;
  app.quit();
});

app.whenReady().then(() => {
  initialProject = findInitialProject();
  startSidecar();
  installMenu();
  createWindow();
});

// ---------------------------------------------------------------------------
// Renderer bridge
// ---------------------------------------------------------------------------

ipcMain.handle("localleaf:invoke", async (e, cmd, args) => {
  switch (cmd) {
    case "initial_project":
      return initialProject;
    case "confirm_exit":
      // The UI has flushed pending edits in response to `app://exit-requested`.
      clearTimeout(exitTimer);
      exitAllowed = true;
      quitting = true;
      app.exit(0);
      return null;
    case "update_menu_state":
      updateMenuState(args.sync);
      return null;
    default:
      return request(cmd, args ?? {});
  }
});

ipcMain.handle("localleaf:dialog", (e, kind, opts) => {
  if (kind === "open") return showOpenDialog(e.sender, opts);
  if (kind === "save") return showSaveDialog(e.sender, opts);
  if (kind === "ask") return askDialog(e.sender, opts);
  return null;
});

ipcMain.handle("localleaf:setTitle", (e, title) => {
  BrowserWindow.fromWebContents(e.sender)?.setTitle(title);
});
