# Using LocalLeaf with AI agents (MCP)

LocalLeaf includes a native [Model Context Protocol](https://modelcontextprotocol.io) server. It speaks JSON-RPC 2.0 over stdio and gives an agent four tools to work on **one** LaTeX project folder: compile it, read files, write files and list the TeX engines on the machine.

There are two ways to run it:

| Server | Command |
|---|---|
| The LocalLeaf app itself | `<path to LocalLeaf executable> --mcp --root <project folder>` |
| The standalone CLI (from the `texcraft-core-*` release archive, or `cargo build --release -p texcraft-core`) | `texcraft-core --mcp --root <project folder>` |

Both behave the same way. Using the app's executable means nothing extra to install, and the exact command for the open project is shown in **Help → Connect an AI Agent** (with a copy button). Typical locations:

| Platform | LocalLeaf executable |
|---|---|
| macOS | `/Applications/LocalLeaf.app/Contents/MacOS/localleaf` |
| Linux (`.deb`/`.rpm`) | `/usr/bin/localleaf` |
| Windows | `localleaf.exe` in the folder chosen during installation |

`--root` defaults to the current working directory. Every path an agent passes is resolved inside that folder; anything that escapes it (`..`, absolute paths elsewhere, symlinks pointing outside) is rejected, and files inside `.git/` can be neither read nor written (git configuration and hooks can run commands).

Both servers recover your login-shell `PATH` at startup, so TeX is found even when a GUI client (such as Claude Desktop) launches them with a minimal environment.

## Client setup

### Claude Code

```sh
claude mcp add localleaf -- /Applications/LocalLeaf.app/Contents/MacOS/localleaf --mcp --root ~/Documents/thesis
```

Or commit a `.mcp.json` to the project so everyone working on it gets the server:

```json
{
  "mcpServers": {
    "localleaf": {
      "command": "/Applications/LocalLeaf.app/Contents/MacOS/localleaf",
      "args": ["--mcp", "--root", "."]
    }
  }
}
```

### Claude Desktop and other clients

Add an entry to the client's MCP configuration (for Claude Desktop, *Settings → Developer → Edit Config*):

```json
{
  "mcpServers": {
    "localleaf": {
      "command": "/Applications/LocalLeaf.app/Contents/MacOS/localleaf",
      "args": ["--mcp", "--root", "/Users/you/Documents/thesis"]
    }
  }
}
```

Any MCP client that launches stdio servers works the same way.

## Working alongside the editor

The server and the app share the project folder, so you can keep the project open while an agent works on it:

- Files written with `write_project_file` appear in the editor immediately. If you have unsaved edits in the same file, LocalLeaf pauses autosave and asks which version to keep.
- The agent and the app share the project's settings (`.texcraft/settings.json`): `compile_tex` without arguments builds the same main document with the same engine you picked in LocalLeaf.
- `compile_tex` writes to the same `.texcraft/build/` folder the app uses, and the open app reloads the PDF when the agent recompiles. Compilations of the app and of agents never overlap: they take turns on a lock in the build folder.

## Tools

### `list_available_engines`

Detects which TeX engines are installed in `PATH`. No arguments.

```json
{
  "engines": [
    { "engine": "pdflatex", "installed": true,  "path": "/Library/TeX/texbin/pdflatex" },
    { "engine": "xelatex",  "installed": true,  "path": "/Library/TeX/texbin/xelatex" },
    { "engine": "lualatex", "installed": true,  "path": "/Library/TeX/texbin/lualatex" },
    { "engine": "tectonic", "installed": false, "path": null }
  ]
}
```

### `compile_tex`

Compiles a document with a local engine, running `bibtex`/`biber` and extra LaTeX passes when needed, like `latexmk`.

| Argument | Type | Default | Description |
|---|---|---|---|
| `entry_point` | string | main document | Main `.tex` file, relative to the project root (e.g. `"main.tex"`). By default the project's main document: the one set in LocalLeaf, else the root `.tex` file with `\documentclass` (preferring `main.tex`). |
| `engine` | `"pdflatex"` \| `"xelatex"` \| `"lualatex"` \| `"tectonic"` | see below | Engine to use. By default the engine chosen for the project in LocalLeaf; if none, the one the preamble needs (`fontspec`, `\babelfont` → XeLaTeX; LuaTeX-only features → LuaLaTeX), otherwise the first installed of pdfLaTeX, XeLaTeX, LuaLaTeX, Tectonic. |
| `output_dir` | string | `".texcraft/build"` | Output folder, relative to the project root. |
| `stop_on_first_error` | boolean | `false` | Halt at the first error. By default, as on Overleaf, compilation continues and a PDF is produced whenever possible. |
| `draft` | boolean | `false` | Fast draft mode: images become placeholders (LaTeX engines). |

The result is returned as JSON text. `isError` is `true` when the compilation did not succeed, so the agent can read the diagnostics and fix them.

```json
{
  "engine": "lualatex",
  "success": false,
  "exit_code": 1,
  "pdf_path": ".texcraft/build/main.pdf",
  "log_path": ".texcraft/build/main.log",
  "synctex_path": ".texcraft/build/main.synctex.gz",
  "duration_ms": 3258,
  "errors": [
    {
      "kind": "error",
      "file": "main.tex",
      "line": 1778,
      "message": "Package luatex.def Error: File `figure.png' not found: using draft setting."
    }
  ],
  "warnings": [
    { "kind": "warning", "file": "main.tex", "line": 299, "message": "Reference `eq:f' on page 3 undefined on input line 299." },
    { "kind": "bad_box", "file": "main.tex", "line": 42, "message": "Overfull \\hbox (4.2pt too wide) in paragraph at lines 42--44" }
  ],
  "stdout": "…last 16,000 characters of the engine output…",
  "stderr": ""
}
```

A `pdf_path` with `success: false` means the PDF was produced despite non-fatal errors. Every `file` is a path in the project (TeX's own paths, like `./chapters/intro.tex`, are resolved); diagnostics TeX does not attribute to a file point at the main document.

### `read_project_file`

Reads a UTF-8 text file (`.tex`, `.bib`, `.sty`, `.cls`, `.log`…) from the project. Files larger than 2 MB are refused.

| Argument | Type | Description |
|---|---|---|
| `path` | string | File path relative to the project root. |

```json
{ "path": "chapters/intro.tex", "content": "\\section{Introduction}\n…" }
```

### `write_project_file`

Creates or overwrites a UTF-8 text file. The write is atomic (temporary file and rename) and parent folders are created.

| Argument | Type | Description |
|---|---|---|
| `path` | string | File path relative to the project root. |
| `content` | string | Full new contents of the file. |

```json
{ "path": "chapters/intro.tex", "bytes_written": 1834 }
```

## Protocol details

- Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout. Logs go to stderr (`RUST_LOG=debug` for more).
- Methods: `initialize`, `ping`, `tools/list`, `tools/call`; notifications are accepted and ignored.
- Protocol versions: `2025-06-18`, `2025-03-26`, `2024-11-05` (the client's version is echoed when supported).
- `compile_tex` runs in the background, so a long compilation does not block other calls; all other requests are handled in the order they arrive (a read that follows a write sees it).
- Each TeX, BibTeX or Biber run is limited to 5 minutes; a compilation can involve several runs (bibliography plus up to three extra LaTeX passes).

Quick manual test:

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"compile_tex","arguments":{}}}' \
  | texcraft-core --mcp --root ~/Documents/thesis
```
