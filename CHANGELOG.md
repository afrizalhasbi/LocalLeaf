# Changelog

## Unreleased

### Fixed
- Exported files (e.g. *Download PDF*) were saved with the macOS `hidden` flag, inherited from the build folder, and did not show up in Finder.
- Edits typed right before closing the window or quitting are saved instead of lost.
- Saves no longer collide: they run one at a time, and every write uses its own temporary file (also when an MCP agent writes the same file).
- A file changed or deleted on disk while it has unsaved edits no longer gets silently overwritten or recreated: autosave pauses and LocalLeaf asks which version to keep.
- Uploading a file that already exists asks before replacing it.
- Switching project while a compilation runs no longer shows its result in the new project.
- The app and MCP agents can no longer compile into the same build folder at the same time.
- *Settings* and *Keyboard Shortcuts* open from the project dashboard too.
- A project with an unreadable subfolder still opens.
- The command-line MCP server finds TeX when launched by a GUI app (it now recovers the login-shell `PATH`, as the app does; TeX Live's Linux install paths are added too).
- Without an explicit engine, the MCP server picks the same engine as the app (the one the preamble needs, else pdfLaTeX) instead of Tectonic.
- MCP requests other than compilations are answered in order.
- Renaming a file by changing only upper/lower case works in the file tree.
- External changes to `.gitignore` and files in `.github/` are picked up.
- ⌘W is no longer bound twice in the menu bar.
- <kbd>Tab</kbd> pressed right as the suggestion list opens accepts the suggestion instead of indenting.

### Security
- Files inside `.git/` can no longer be read or written through the editor or the MCP server.

### Performance
- The PDF viewer frees pages far from the visible area (a 60-page document went from ~380 MB to ~47 MB of rendered pages) and renders one page at a time, nearest first, so typing stays responsive while the PDF updates.
- Recompiles reuse the previous page layout; long documents no longer measure every page up front.
- The file outline is updated shortly after typing stops instead of on every keystroke.
- Opening projects and refreshing the file tree no longer block the interface.

### Changed
- Per-project settings (main document, compiler, compile options) are stored in the project, in `.texcraft/settings.json`, and shared with the MCP server. Settings from older versions are migrated automatically.
- MCP `compile_tex` can be called without arguments: it builds the project's main document with the engine chosen in LocalLeaf. Diagnostics now point at project files (`main.tex` instead of `./main.tex`). The server reports its name as `localleaf`.
- Renaming the project from the header renames its folder too, as in the project dashboard.
- System spell checking is now a setting (*Settings → Editor*), off by default because it also underlined LaTeX commands.
- New projects no longer include the obsolete `\usepackage[utf8]{inputenc}`.
- Menus and dialogs are accessible: ARIA roles, arrow-key navigation in menus, focus kept inside dialogs and restored when they close.
- The Recompile button keeps its width while compiling, so the toolbar no longer shifts.

### Changed
- New app icon and logo.

## 1.0.1 — 2026-10-14

### Fixed
- Typing no longer triggers a false "changed on disk while you were editing" warning: LocalLeaf's own autosaves are no longer mistaken for external edits.
- Selecting text by dragging with the mouse or trackpad works on macOS (the selection was cancelled because WebKit reported no pressed button during the drag).
- <kbd>Tab</kbd> accepts the highlighted autocompletion suggestion.
- PDF viewer: fixed an error when the viewer was closed right after a resize.

### Changed
- Brackets always auto-close, whatever follows the cursor: `(`, `[`, `{`, `$`, and the math delimiters `\[ \]` and `\( \)`. Typing a closer in front of the same closer steps over it, a selection is wrapped, and <kbd>Backspace</kbd> inside an empty pair removes both halves. `\$` stays a literal dollar and quotes are no longer paired.

## 1.0.0 — 2026-10-13

First public release.

### Desktop app
- Overleaf-style layout: header with **Recompile**, file tree with outline, CodeMirror 6 editor, PDF.js preview, logs pane; resizable and collapsible panels; three layouts.
- LaTeX editing: syntax highlighting, autocompletion (commands, environments, `\ref` labels, `\cite` keys, file paths), Vim/Emacs keybindings, five editor themes, JetBrains Mono.
- Compilation with pdfLaTeX, XeLaTeX, LuaLaTeX or Tectonic; auto-compile, draft mode, stop-on-first-error, recompile from scratch; engine detection from the preamble.
- Bidirectional SyncTeX navigation.
- Clickable errors, warnings and bad boxes with hints for common local issues.
- Native menu bar with Insert menu and standard shortcuts.
- Project dashboard: create, open, search, rename, move and trash projects.
- Autosave and live reload of files changed outside the app.
- Built-in MCP server (`--mcp`) sharing the project and build folder with the editor.

### texcraft-core
- Engine runner with `bibtex`/`biber` and `latexmk`-style reruns; PDF produced despite non-fatal errors by default.
- Log parser for errors, warnings and bad boxes.
- Sandboxed project file access.
- MCP server with `compile_tex`, `read_project_file`, `write_project_file` and `list_available_engines`.
