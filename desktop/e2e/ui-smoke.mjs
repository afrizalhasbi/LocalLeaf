// UI smoke test: renders the frontend in WebKit (the engine Tauri uses on macOS) with the
// Tauri IPC bridged to Node, serving a real project folder, and saves screenshots.
//
// Usage: node e2e/ui-smoke.mjs [project_dir] [out_dir] [url]
// Defaults to the bundled fixture (e2e/fixture) and writes screenshots to e2e/screenshots.
// Requires the Vite dev server (`npm run dev`) and a compiled PDF in
// <project_dir>/.texcraft/build/main.pdf or <project_dir>/build/main.pdf.
import { webkit } from "playwright";
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const [projectDir = path.join(here, "fixture"), outDir = path.join(here, "screenshots"), url = "http://localhost:1420"] =
  process.argv.slice(2);
const root = fs.realpathSync(projectDir);
// Path shown in the UI (e.g. DISPLAY_ROOT=/Users/you/Documents/thesis for README screenshots).
const displayRoot = process.env.DISPLAY_ROOT ?? root;
fs.mkdirSync(outDir, { recursive: true });

function tree(dir = root) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith("."))
    .map((e) => {
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full);
      return e.isDirectory()
        ? { name: e.name, path: rel, isDir: true, children: tree(full) }
        : { name: e.name, path: rel, isDir: false };
    })
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
}

let failCompile = false;
let exitConfirmed = false;
let savedSettings = null;
let renamedTo = null;
// Answer of the native "Replace files?" dialog, and calls to import_files.
let askAnswer = false;
const imports = [];
// Files "deleted on disk" during the test.
const deleted = new Set();
const pdfRel = fs.existsSync(path.join(root, ".texcraft/build/main.pdf")) ? ".texcraft/build/main.pdf" : "build/main.pdf";
// Files saved by the app during the test (the real project folder is never modified).
const written = new Map();
let lastMenuSync = null;
const errors = [];

const handlers = {
  initial_project: () => (process.env.NO_PROJECT ? null : root),
  open_project: () => ({
    root: displayRoot,
    name: path.basename(displayRoot),
    mainDocument: "main.tex",
    tree: tree(),
    mcpCommand: ["/Applications/LocalLeaf.app/Contents/MacOS/localleaf", "--mcp", "--root", displayRoot],
  }),
  get_tree: () => tree().filter((n) => !deleted.has(n.path)),
  import_files: ({ targetDir, sources, overwrite }) => {
    imports.push({ targetDir, names: sources.map((s) => path.basename(s.path)), overwrite });
    return sources.map((s) => (targetDir ? `${targetDir}/` : "") + path.basename(s.path));
  },
  close_project: () => null,
  list_available_engines: () => [
    { engine: "tectonic", installed: true, path: "/opt/homebrew/bin/tectonic" },
    { engine: "pdflatex", installed: true, path: "/Library/TeX/texbin/pdflatex" },
    { engine: "xelatex", installed: true, path: "/Library/TeX/texbin/xelatex" },
    { engine: "lualatex", installed: false, path: null },
  ],
  synctex_available: () => true,
  read_project_file: ({ path: p }) => {
    if (deleted.has(p)) throw new Error(`cannot access ${p}`);
    return written.get(p) ?? fs.readFileSync(path.join(root, p), "utf8");
  },
  read_binary_file: ({ path: p }) => ({ __bytes: [...fs.readFileSync(path.join(root, p))] }),
  write_project_file: ({ path: p, content }) => {
    written.set(p, content);
    return null;
  },
  compile_tex: ({ engine }) => ({
    engine,
    success: !failCompile,
    exit_code: failCompile ? 1 : 0,
    pdf_path: failCompile ? null : pdfRel,
    log_path: ".texcraft/build/main.log",
    synctex_path: ".texcraft/build/main.synctex.gz",
    duration_ms: 812,
    stdout: "",
    stderr: "",
    errors: failCompile
      ? [{ kind: "error", message: "Undefined control sequence.", file: "chapters/method.tex", line: 2 }]
      : [],
    warnings: [
      { kind: "warning", message: "Citation `lamport' on page 1 undefined on input line 12.", file: "main.tex", line: 12 },
      { kind: "bad_box", message: "Overfull \\hbox (4.2pt too wide) in paragraph at lines 13--14", file: "main.tex", line: 13 },
    ],
  }),
  synctex_forward: () => [{ page: 1, h: 133.8, v: 300, width: 343.7, height: 10 }],
  synctex_inverse: () => ({ file: "main.tex", line: 12 }),
  update_menu_state: ({ sync }) => {
    lastMenuSync = sync;
    return null;
  },
  open_external: () => null,
  save_project_settings: ({ settings }) => {
    savedSettings = settings;
    return null;
  },
  rename_open_project: ({ newName }) => {
    renamedTo = newName;
    return { ...handlers.open_project(), root: path.join(path.dirname(displayRoot), newName), name: newName };
  },
  confirm_exit: () => {
    exitConfirmed = true;
    return null;
  },
  reveal_in_file_manager: () => null,
  frontend_log: ({ level, message }) => {
    if (level === "error") errors.push(message);
    console.log(`[frontend:${level}] ${message}`);
  },
};

const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => {
  errors.push(String(e));
  console.log("[pageerror]", e);
});
page.on("console", (m) => m.type() === "error" && console.log("[console.error]", m.text()));

await page.exposeFunction("__bridge", (cmd, args) => {
  // plugin-dialog's ask() shows a message dialog and compares the pressed button's label.
  if (cmd === "plugin:dialog|message") {
    const [ok, cancel] = args?.buttons?.OkCancelCustom ?? ["Yes", "No"];
    return askAnswer ? ok : cancel;
  }
  if (cmd.startsWith("plugin:")) return null;
  const h = handlers[cmd];
  if (!h) throw new Error(`unmocked command ${cmd}`);
  return h(args ?? {});
});
await page.addInitScript(() => {
  let next = 1;
  const callbacks = new Map();
  const listeners = [];
  // Lets the test fire native events such as `menu://action`.
  window.__emit = (event, payload) =>
    listeners.filter((l) => l.event === event).forEach((l) => callbacks.get(l.handler)?.({ event, id: 0, payload }));
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback: (cb) => {
      const id = next++;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback: () => undefined,
    convertFileSrc: (p) => p,
    invoke: async (cmd, args) => {
      if (cmd === "plugin:event|listen") {
        listeners.push({ event: args.event, handler: args.handler });
        return next++;
      }
      const r = await window.__bridge(cmd, args);
      return r && r.__bytes ? new Uint8Array(r.__bytes).buffer : r;
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
});

const menu = (id) => page.evaluate((id) => window.__emit("menu://action", id), id);

const shot = async (name) => {
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
  console.log("screenshot", name);
};

await page.goto(url);
await page.waitForSelector(".pdf-page canvas", { timeout: 20000 });
await shot("1-editor-dark");

// --- Editor behaviour regressions (skipped with DOCS=1 for clean README screenshots) ---
if (!process.env.DOCS) {
const activeLine = () => page.locator(".cm-activeLine").innerText();
const newLine = async (text) => {
  await page.click(".cm-content");
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Enter");
  if (text) await page.keyboard.type(text);
};
const expectLine = async (label, expected) => {
  const got = (await activeLine()).trim();
  if (got !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
  console.log(`ok  ${label}: ${got}`);
};
for (const [typed, expected] of [["(", "()"], ["[", "[]"], ["{", "{}"], ["$", "$$"], ["\\[", "\\[\\]"], ["\\(", "\\(\\)"], ["a (b", "a (b)"], ["\\$", "\\$"]]) {
  await newLine(typed);
  await expectLine(`auto-close ${typed}`, expected);
  // Remove the whole test line, closer included.
  await page.keyboard.press("Meta+ArrowRight");
  await page.keyboard.press("Meta+Shift+ArrowLeft");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
}
await newLine("$x");
await page.keyboard.type("$ ok");
await expectLine("typing the closer steps over it", "$x$ ok");
await newLine("\\[");
await page.keyboard.press("Backspace");
await expectLine("Backspace removes an empty \\[ \\] pair", "");
await newLine("\\secti");
await page.waitForSelector(".cm-tooltip-autocomplete");
await page.keyboard.press("Tab"); // immediately, inside CodeMirror's interaction delay
await page.waitForTimeout(250);
if (!(await activeLine()).includes("\\section{")) throw new Error("Tab did not accept the completion: " + (await activeLine()));
console.log("ok  Tab accepts completion:", (await activeLine()).trim());
await page.keyboard.press("Escape");

// Mouse drag selects text.
await page.click(".cm-content");
await page.keyboard.press("Meta+ArrowUp");
await page.waitForTimeout(150);
const textLine = page.locator(".cm-line", { hasText: "Hello world" }).first();
const lb = await textLine.boundingBox();
await page.mouse.move(lb.x + 4, lb.y + lb.height / 2);
await page.mouse.down();
await page.mouse.move(lb.x + 160, lb.y + lb.height / 2, { steps: 6 });
await page.mouse.up();
if (!(await page.locator(".cm-selectionBackground").count())) throw new Error("mouse drag did not select text");
console.log("ok  mouse drag selects text");

// Our own autosave echoed by the file watcher must not look like an external edit.
await newLine("autosaved text");
await page.waitForTimeout(1000); // autosave fires after 600 ms
await page.keyboard.type(" and more typing");
await page.evaluate(() => window.__emit("project://changed", { paths: ["main.tex"] }));
await page.waitForTimeout(800);
if (await page.locator("text=changed on disk").count()) throw new Error("own autosave reported as an external change");
console.log("ok  autosave echo ignored");

// A real external edit (e.g. an AI agent via MCP) is still picked up.
await page.waitForTimeout(1000); // let pending autosaves settle first
written.set("main.tex", (written.get("main.tex") ?? "") + "% edited by an agent\n");
await page.evaluate(() => window.__emit("project://changed", { paths: ["main.tex"] }));
await page.waitForSelector(".cm-line:has-text('edited by an agent')", { timeout: 3000 });
console.log("ok  external edit reloaded into the editor");

// A change on disk while there are unsaved edits asks instead of overwriting.
const conflictTo = async (choice) => {
  await newLine(`my unsaved edit ${choice}`);
  written.set("main.tex", "% rewritten by an agent\n" + (written.get("main.tex") ?? ""));
  await page.evaluate(() => window.__emit("project://changed", { paths: ["main.tex"] }));
  await page.waitForSelector("text=main.tex changed on disk", { timeout: 3000 });
  await page.waitForTimeout(900); // autosave must stay paused while the dialog is open
  if ((written.get("main.tex") ?? "").includes(`my unsaved edit ${choice}`)) throw new Error("autosave overwrote the disk version during a conflict");
  await page.click(choice === "mine" ? "text=Keep my version" : "text=Load the version on disk");
  await page.waitForTimeout(900);
};
await conflictTo("mine");
if (!(written.get("main.tex") ?? "").includes("my unsaved edit mine")) throw new Error("'Keep my version' did not save");
console.log("ok  conflict: keep my version");
await conflictTo("disk");
if (await page.locator(".cm-line:has-text('my unsaved edit disk')").count()) throw new Error("'Load the version on disk' kept the local edit");
console.log("ok  conflict: load the version on disk");

// Upload of an existing file asks first; "Skip" imports nothing, "Replace" overwrites.
askAnswer = false;
await page.evaluate(() => window.__emit("tauri://drag-drop", { paths: ["/tmp/elsewhere/refs.bib"], position: { x: 10, y: 10 } }));
await page.waitForTimeout(500);
if (imports.length) throw new Error("existing file imported although the user chose Skip");
askAnswer = true;
await page.evaluate(() => window.__emit("tauri://drag-drop", { paths: ["/tmp/elsewhere/refs.bib", "/tmp/elsewhere/new.png"], position: { x: 10, y: 10 } }));
await page.waitForTimeout(500);
if (imports.length !== 1 || imports[0].overwrite !== true || imports[0].names.length !== 2) throw new Error("replace upload: " + JSON.stringify(imports));
console.log("ok  upload asks before replacing existing files");

// The open file deleted on disk while edited: ask instead of recreating it.
await newLine("edit before deletion");
deleted.add("main.tex");
await page.evaluate(() => window.__emit("project://changed", { paths: ["main.tex"] }));
await page.waitForSelector("text=main.tex was deleted", { timeout: 3000 });
await page.click("text=Keep my version");
await page.waitForTimeout(600);
deleted.delete("main.tex");
if (!(written.get("main.tex") ?? "").includes("edit before deletion")) throw new Error("'Keep my version' after deletion did not save");
console.log("ok  deleted-while-edited file asks, then saves");
}


// SyncTeX forward: put the cursor somewhere and click the → arrow.
await page.click(".cm-content");
await page.click('button[title^="Go to code location in PDF"]');
await page.waitForSelector(".synctex-highlight");
await shot("2-synctex-forward");

// Autocomplete for \ref.
await page.keyboard.press("Meta+ArrowDown");
await page.keyboard.type("\nSee \\ref{");
await page.waitForSelector(".cm-tooltip-autocomplete");
await shot("3-autocomplete-ref");
await page.keyboard.press("Escape");

// Failing compile → logs pane with clickable errors.
failCompile = true;
await page.click('button[title^="Recompile"]');
await page.waitForSelector("text=This project did not compile");
await shot("4-logs-errors");
await page.click("text=chapters/method.tex, line 2");
await shot("5-jump-to-error");
failCompile = false;

// Recompile dropdown.
await page.click('button[aria-label="Compile options"]');
await shot("6-recompile-menu");
await page.keyboard.press("Escape");

// Menu bar: Insert → Section wraps the selection.
await page.click(".cm-content");
await page.keyboard.press("Meta+ArrowDown");
await page.keyboard.type("\nNew heading");
await page.keyboard.press("Shift+Home");
await menu("insert.section");
await page.waitForSelector("text=\\section{New heading}");
console.log("insert.section wrapped the selection");

// Menu bar: Settings… (⌘,) → Shortcuts, then Theme → Light.
await menu("app.settings");
await page.click("text=Shortcuts");
await shot("7-settings-shortcuts");
await page.keyboard.press("Escape");
await menu("theme:light");
await shot("8-editor-light");
if (lastMenuSync?.theme !== "light") throw new Error("menu state not synced: " + JSON.stringify(lastMenuSync));

// Menu bar: Project → Word Count.
await menu("build.word_count");
await shot("9-word-count");
await page.keyboard.press("Escape");

// Hide the sidebar with its arrow, then bring it back.
await page.click('button[title^="Hide sidebar"]');
await page.waitForSelector('button[title^="Show sidebar"]');
await shot("10-sidebar-hidden");
await page.click('button[title^="Show sidebar"]');
await page.waitForSelector("text=File outline");
await shot("11-sidebar-shown");

// Project settings are written to the project (.texcraft/settings.json) when they change.
if (!process.env.DOCS) {
  await menu("engine:xelatex");
  await page.waitForTimeout(600);
  if (savedSettings?.engine !== "xelatex") throw new Error("engine change not saved to project settings: " + JSON.stringify(savedSettings));
  await menu("engine:pdflatex");
  console.log("ok  project settings saved");

  // Menus work from the keyboard: arrows move, Escape closes and returns focus.
  await page.click('button[aria-label="Compile options"]');
  await page.waitForSelector('[role="menu"]');
  const firstFocused = await page.evaluate(() => document.activeElement?.getAttribute("role"));
  await page.keyboard.press("ArrowDown");
  const movedTo = await page.evaluate(() => document.activeElement?.textContent?.trim());
  await page.keyboard.press("Escape");
  const back = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
  if (!firstFocused?.startsWith("menuitem") || !movedTo || back !== "Compile options") {
    throw new Error(`menu keyboard navigation: ${firstFocused} / ${movedTo} / ${back}`);
  }
  console.log("ok  menus are keyboard accessible");

  // Renaming from the header renames the folder too.
  await page.click('button[title="Rename project"]');
  await page.keyboard.press("Meta+A");
  await page.keyboard.type("renamed-thesis");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  if (renamedTo !== "renamed-thesis") throw new Error("header rename did not rename the folder: " + renamedTo);
  if (!(await page.locator("header >> text=renamed-thesis").count())) throw new Error("header not updated after rename");
  console.log("ok  header rename renames the project folder");
}

// Quit (⌘Q) saves pending edits before exiting.
if (!process.env.DOCS) {
  await page.click(".cm-content");
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.type("typed right before quitting");
  await menu("app.quit");
  await page.waitForTimeout(300);
  if (!exitConfirmed) throw new Error("quit did not reach confirm_exit");
  // The editor may have another file open by now (an earlier step jumped to an error).
  if (![...written.values()].some((t) => t.includes("typed right before quitting"))) throw new Error("quit lost the last edit");
  console.log("ok  quit saves pending edits first");
}

// Settings and shortcuts open from the dashboard too, and don't reappear later.
if (!process.env.DOCS) {
  await page.click('button[title^="All projects"]');
  await page.waitForSelector("text=All projects");
  await menu("app.settings");
  await page.waitForSelector("text=Auto-complete", { timeout: 2000 });
  if (await page.locator("nav >> text=Compiler").count()) throw new Error("project-only Settings tabs shown on the dashboard");
  await page.keyboard.press("Escape");
  await page.locator("tbody tr").first().click(); // most recent project (renamed earlier)
  await page.waitForSelector(".cm-content");
  await page.waitForTimeout(600);
  if (await page.locator("h2", { hasText: "Settings" }).count()) throw new Error("Settings popped up after opening a project");
  console.log("ok  settings from the dashboard");
}

// Back to the project dashboard and open a project's ⋮ menu.
await page.click('button[title^="All projects"]');
await page.waitForSelector("text=All projects");
await page.click('button[title="Actions"]');
await shot("12-projects-menu");

await browser.close();
if (errors.length) {
  console.log(`FAILED with ${errors.length} frontend error(s)`);
  process.exit(1);
}
console.log("OK: no frontend errors");
