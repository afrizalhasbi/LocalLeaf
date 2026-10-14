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

## 2. Guided installation of TeX and its packages

Today LocalLeaf needs a TeX distribution that the user installs beforehand, usually from a terminal. A setup dialog would let anyone get a working installation without leaving the app.

- **When it appears**: on first launch, or whenever no engine is found (the system check already knows); also available any time from *Settings → Compiler → Manage TeX installation…*.
- **Choosing a distribution**, with size, install time and a short explanation of each:
  - **Tectonic** (recommended to get started): about 30 MB, downloads the packages a document needs on its own, no administrator rights. LocalLeaf can download the official binary into its own data folder;
  - **TeX Live / MacTeX (full)**: everything Overleaf has, around 5–8 GB; LocalLeaf downloads the official installer and runs it (the OS asks for the administrator password);
  - **A minimal TeX Live** (BasicTeX on macOS, `scheme-basic` elsewhere) plus only the packages the open project needs;
  - on Windows, **MiKTeX** or TeX Live (via `winget` or the official installer); on Linux, the distribution's packages (`apt`, `dnf`, `pacman`, through a graphical authentication prompt such as `pkexec`).
- **Progress and outcome**: a progress bar with the current step, the option to cancel, and at the end the same engine check *Settings → Compiler* shows today, followed by a test compilation.
- **Package manager**: a second tab of the same dialog to search, install, update and remove LaTeX packages (`tlmgr` for TeX Live, `miktex packages` for MiKTeX), with the installed version and a short description, plus "Update all".
- **Fonts**: the same dialog lists the fonts a document asks for (`fontspec`, `\babelfont`) and installs the missing ones.
- Installing a missing package straight from a compile error (next item) reuses this dialog.

## 3. Installing missing LaTeX packages from the interface

When a compilation fails with `! LaTeX Error: File 'xyz.sty' not found`, offer to install the package straight from the logs.

- **Detection**: the log parser already extracts the error; add the name of the missing file (`.sty`, `.cls`, `.bst`, fonts).
- **From file to package**:
  - TeX Live / MacTeX: `tlmgr search --global --file /xyz.sty` returns the package that contains the file;
  - MiKTeX: `miktex packages search`, or MiKTeX's own on-the-fly installation;
  - Tectonic downloads packages by itself, so nothing is needed.
- **Installation**:
  - a system-wide TeX Live (MacTeX) needs administrator rights: ask for them with the OS's native prompt and show progress;
  - alternatively install into the user's own tree with `tlmgr --usermode` (no password; initialised once with `tlmgr init-usertree`).
- **Interface**: an **"Install package xyz"** button in the error card, which opens the package manager of item 2 on that package, then recompiles automatically.
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
