// UI smoke test: renders the frontend in WebKit (the engine Tauri uses on macOS) with the
// Tauri IPC bridged to Node, serving a real project folder, and saves screenshots.
//
// Usage: node e2e/ui-smoke.mjs <project_dir> <out_dir> [url]
// Requires the Vite dev server (`npm run dev`) and a compiled PDF in <project_dir>/.texcraft/build.
import { webkit } from "playwright";
import fs from "node:fs";
import path from "node:path";

const [projectDir, outDir, url = "http://localhost:1420"] = process.argv.slice(2);
if (!projectDir || !outDir) {
  console.error("usage: node e2e/ui-smoke.mjs <project_dir> <out_dir> [url]");
  process.exit(2);
}
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
let lastMenuSync = null;
const errors = [];

const handlers = {
  initial_project: () => (process.env.NO_PROJECT ? null : root),
  open_project: () => ({
    root: displayRoot,
    name: path.basename(root),
    mainDocument: "main.tex",
    tree: tree(),
    mcpCommand: ["/Applications/LocalLeaf.app/Contents/MacOS/localleaf", "--mcp", "--root", displayRoot],
  }),
  get_tree: () => tree(),
  close_project: () => null,
  list_available_engines: () => [
    { engine: "tectonic", installed: true, path: "/opt/homebrew/bin/tectonic" },
    { engine: "pdflatex", installed: true, path: "/Library/TeX/texbin/pdflatex" },
    { engine: "xelatex", installed: true, path: "/Library/TeX/texbin/xelatex" },
    { engine: "lualatex", installed: false, path: null },
  ],
  synctex_available: () => true,
  read_project_file: ({ path: p }) => fs.readFileSync(path.join(root, p), "utf8"),
  read_binary_file: ({ path: p }) => ({ __bytes: [...fs.readFileSync(path.join(root, p))] }),
  write_project_file: () => null,
  compile_tex: ({ engine }) => ({
    engine,
    success: !failCompile,
    exit_code: failCompile ? 1 : 0,
    pdf_path: failCompile ? null : ".texcraft/build/main.pdf",
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
