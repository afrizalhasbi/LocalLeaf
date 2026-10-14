# Architecture

LocalLeaf has two parts: **texcraft-core**, a Rust library and CLI that knows how to compile LaTeX projects, and the **desktop app**, a Tauri v2 shell with a Vue 3 interface built on that library.

```
┌─────────────────────────────── LocalLeaf app ───────────────────────────────┐
│  Vue 3 UI (desktop/src)                                                     │
│   CodeMirror 6 editor · PDF.js viewer · file tree · logs · dashboard        │
│        │  invoke("compile_tex", …)               ▲ events: compile://*,     │
│        ▼                                         │ project://*, menu://*    │
│  Tauri backend (desktop/src-tauri)                                          │
│   IPC commands · native menu bar · file watcher · project folder actions    │
└────────┬────────────────────────────────────────────────────────────────────┘
         │ Rust API
┌────────▼─────────────── texcraft-core (src/) ───────────────┐      ┌──────────────┐
│ compiler  project (sandbox)  synctex  mcp_server            │◀────▶│ MCP clients  │
└────────┬─────────────────────────┬──────────────────────────┘ stdio└──────────────┘
         │ spawns                  │ spawns
   pdflatex / xelatex / lualatex   synctex
   tectonic / bibtex / biber
```

## texcraft-core

| Module | Responsibility |
|---|---|
| `compiler.rs` | Finds engines in `PATH`, runs them with `tokio::process`, and adds the `latexmk`-style loop for the LaTeX engines: `bibtex` or `biber` when the first pass asks for a bibliography, then reruns while the log says *Rerun to get cross-references right* (up to 3 extra passes). Subfolders are mirrored into the output folder so `\include{chapters/x}` works. Parses the log into errors (`-file-line-error` style, classic `! ` errors, tectonic `error:` lines, multi-line package errors), warnings and over/underfull boxes, re-joining lines TeX wrapped at 79 characters. |
| `project.rs` | All file access for a project folder: path resolution that rejects anything outside the root (including through symlinks) and anything inside `.git/`, atomic writes with a unique temporary file per write, create/rename/delete, the file tree (unreadable subfolders are skipped), main-document detection, the per-project settings file and the conversion of compile results to project-relative paths. |
| `env.rs` | Recovers the login-shell `PATH` (plus the usual TeX locations) for processes started by GUI apps. |
| `synctex.rs` | Forward (source → PDF boxes) and inverse (PDF point → source line) lookups through the `synctex` CLI. |
| `mcp_server.rs` | The MCP server (see [MCP.md](MCP.md)). Each request runs in its own task; one writer task serialises responses on stdout. |

Build artifacts go to `.texcraft/build/` inside the project (the `DEFAULT_OUTPUT_DIR` constant), shared by the app and the MCP server. A lock file in that folder (`.texcraft.lock`) makes their compilations take turns. Per-project settings (main document, engine, compile options, displayed name) live in `.texcraft/settings.json`, so the MCP server uses the same choices as the editor.

## Desktop backend (`desktop/src-tauri`)

- `main.rs`: IPC commands (project lifecycle, file operations, compile, SyncTeX, import/export), the debounced file watcher (`notify`) that emits `project://changed` and `project://pdf-changed`, and the startup code. On launch it recovers the user's login-shell `PATH` and adds the usual TeX locations, because apps started from Finder get a minimal `PATH`. With `--mcp` the same executable runs the MCP server instead of the GUI.
- `menu.rs`: the native menu bar. Clicks are forwarded as `menu://action` events; the UI pushes its state back through `update_menu_state` so check marks and enabled items stay in sync.
- `projects.rs`: dashboard actions on whole project folders: rename, move (rename on the same volume; across volumes copy, verify the file count, then delete the original) and move to the Trash.

## UI (`desktop/src`)

- `lib/store.ts`: the single entry point components import from; it re-exports
  - `lib/state.ts`: the reactive state, notifications and file-tree helpers;
  - `lib/projects.ts`: recent projects, per-project settings, opening, closing and renaming projects;
  - `lib/files.ts`: the file tree, opening files, autosave (600 ms debounce, saves serialised), external changes and disk conflicts;
  - `lib/compile.ts`: compilation, compile queueing, auto-compile and the PDF;
  - `lib/sync.ts`: navigation and SyncTeX.
  A `session.generation` counter drops async results that belong to a project that is no longer open.
- `lib/storage.ts`: per-machine UI preferences in localStorage (`localleaf:` keys).
- `lib/editor.ts`: CodeMirror configuration: LaTeX language (legacy `stex` mode), themes, autocompletion sources and Overleaf shortcuts.
- `lib/latex.ts`: source analysis without TeX: outline, labels, BibTeX keys, includes, word count, engine detection and log hints.
- `lib/menu.ts`: handlers for every menu-bar action.
- `components/`: the layout: `HeaderBar`, `Sidebar` (file tree and outline), `EditorPane`/`CodeEditor`, `PdfPane`/`PdfViewer`, `LogsPane`, modals and the `ProjectsView` dashboard. `PdfViewer` renders pages one at a time, nearest to the reader first, and frees pages far from the viewport, so long documents stay light.

Some interactions can arrive twice: a keyboard shortcut may reach both CodeMirror and the native menu. Actions go through `recentlyRan()`, which ignores a repeat of the same action within 400 ms.

## Testing

- `npm test` (in `desktop/`): unit tests for the LaTeX source analysis (outline, word count, labels, BibTeX keys, includes, engine detection, log hints).
- `cargo test --workspace`: log parser cases (wrapped lines, package errors, bad boxes), project sandbox and file operations, SyncTeX output parsing, project folder rename/move/guards.
- `examples/smoke.rs`: compiles a real project and runs SyncTeX in both directions.
- `desktop/e2e/ui-smoke.mjs`: renders the UI in Playwright's WebKit (the engine Tauri uses on macOS) with the Tauri IPC bridged to Node and backed by a real project folder. It drives the editor, logs, menus and dashboard, fails on any frontend error, and writes screenshots.
