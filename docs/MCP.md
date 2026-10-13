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

`--root` defaults to the current working directory. Every path an agent passes is resolved inside that folder; anything that escapes it (`..`, absolute paths elsewhere, symlinks pointing outside) is rejected.

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

- Files written with `write_project_file` appear in the editor immediately. If you have unsaved edits in the same file, your version is kept and LocalLeaf warns you.
- `compile_tex` writes to the same `.texcraft/build/` folder the app uses, and the open app reloads the PDF when the agent recompiles.

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
| `entry_point` | string | required | Main `.tex` file, relative to the project root (e.g. `"main.tex"`). |
| `engine` | `"pdflatex"` \| `"xelatex"` \| `"lualatex"` \| `"tectonic"` | first installed | Engine to use. |
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
      "file": "./main.tex",
      "line": 1778,
      "message": "Package luatex.def Error: File `figure.png' not found: using draft setting."
    }
  ],
  "warnings": [
    { "kind": "warning", "file": null, "line": 299, "message": "Reference `eq:f' on page 3 undefined on input line 299." },
    { "kind": "bad_box", "file": null, "line": 42, "message": "Overfull \\hbox (4.2pt too wide) in paragraph at lines 42--44" }
  ],
  "stdout": "…last 16,000 characters of the engine output…",
  "stderr": ""
}
```

A `pdf_path` with `success: false` means the PDF was produced despite non-fatal errors.

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
- Requests are handled concurrently, so a long compilation does not block other calls.
- A single compilation is limited to 5 minutes.

Quick manual test:

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"compile_tex","arguments":{"entry_point":"main.tex"}}}' \
  | texcraft-core --mcp --root ~/Documents/thesis
```
