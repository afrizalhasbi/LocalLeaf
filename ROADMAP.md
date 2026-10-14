# Roadmap

Planned features, roughly in order of priority. Ideas and contributions are welcome: please [open an issue](https://github.com/leoaliperti/LocalLeaf/issues) to discuss one before starting.

## 1. Git versioning in the interface

Save and sync a project with git without opening a terminal.

- **A "Versions" panel** in the sidebar, next to the file tree and the outline:
  - the list of changed files (new, modified, deleted), with a line-by-line diff;
  - a message field and a **Commit** button;
  - **Pull** and **Push** buttons, showing how many commits you are ahead of or behind the remote;
  - the commit history, with the option to view or restore an earlier version of a file.
- **Setup**: for a project without git, "Enable versioning" creates the repository and a `.gitignore` covering `.texcraft/`, LaTeX's temporary files (`*.aux`, `*.log`, `*.synctex.gz`, …) and `.DS_Store`, and can connect a remote (GitHub, Forgejo/Gitea, GitLab…).
- **How**: use the `git` command installed on the system, in keeping with LocalLeaf's approach (no reimplementations), so credentials go through the keychain or credential helper already configured.
- **Conflicts after a pull**: reuse the existing "keep my version / load the version on disk" dialog, or at least open the file with the `<<<<<<<` markers highlighted.
- **Menu bar**: *File → Commit…*, *File → Pull* / *Push*.
- **MCP**: `git_status` and `git_commit` tools for agents, with the user's confirmation before any push.
- An option for **automatic commits** (for example after each successful compilation) as a safety net.

## 2. Installing missing LaTeX packages from the interface

When a compilation fails with `! LaTeX Error: File 'xyz.sty' not found`, offer to install the package straight from the logs.

- **Detection**: the log parser already extracts the error; add the name of the missing file (`.sty`, `.cls`, `.bst`, fonts).
- **From file to package**:
  - TeX Live / MacTeX: `tlmgr search --global --file /xyz.sty` returns the package that contains the file;
  - MiKTeX: `miktex packages search`, or MiKTeX's own on-the-fly installation;
  - Tectonic downloads packages by itself, so nothing is needed.
- **Installation**:
  - a system-wide TeX Live (MacTeX) needs administrator rights: ask for them with the OS's native prompt and show progress;
  - alternatively install into the user's own tree with `tlmgr --usermode` (no password; initialised once with `tlmgr init-usertree`).
- **Interface**: an **"Install package xyz"** button in the error card, then an automatic recompile.
- The same for **missing fonts** (today LocalLeaf only suggests a `brew install --cask font-…` command): one-click installation.
- Possibly a check when a project opens: list the `\usepackage`s that are not installed (`kpsewhich xyz.sty`) before compiling.

## More Overleaf parity

- **Stop** a running compilation.
- **Code folding** for `\begin…\end` blocks and sections.
- An option to enable **shell-escape** (needed by `minted`), with a security warning.
- Support for **`latexmkrc`** and custom build commands.
- **Project-wide search**, and jumping from a `\ref` to its `\label` and back.
- **Search in the PDF**.
- **Per-file undo history** that survives switching between files.
- Opening **non-UTF-8 files** (older documents in Latin-1) and `.bib` files larger than 2 MB.
- **File → Open Recent**, remembering the window size and position, and a single app instance.
- **Uploading whole folders** (today only files).
- **Localisation**, starting with Italian.
