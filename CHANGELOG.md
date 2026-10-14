# Changelog

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
