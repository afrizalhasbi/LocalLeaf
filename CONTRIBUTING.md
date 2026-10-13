# Contributing to LocalLeaf

Thanks for your interest! Bug reports, ideas and pull requests are welcome.

## Reporting a problem

Please [open an issue](https://github.com/leoaliperti/LocalLeaf/issues) with:

- your OS and LocalLeaf version (*LocalLeaf → About*);
- your TeX distribution and the engine selected (*Settings → Compiler* lists what was detected);
- for compile problems, a minimal `.tex` file that reproduces it and the raw log (*Logs → View raw logs*). If the project compiles on Overleaf, mention the compiler it uses there.

## Development setup

See [Building from source](README.md#building-from-source). In short:

```sh
cd desktop && npm install && npm run app
```

`npm run app` starts Vite and the Tauri app with hot reload for the UI; Rust changes trigger a rebuild.

## Before opening a pull request

```sh
cargo test --workspace
cd desktop && npm run typecheck
```

For UI changes, also run the WebKit smoke test against a sample project and look at the screenshots:

```sh
npm run dev &
node e2e/ui-smoke.mjs <project-folder> <screenshot-folder>
```

Guidelines:

- Keep the Overleaf-like layout and behaviour unless there is a good reason to differ.
- LocalLeaf stays local-first: no network access except opening links the user clicks.
- Never reimplement TeX: call the engines and tools installed on the system.
- Any path that comes from the UI or from an agent must go through `Project::resolve`.
- Match the style of the surrounding code; add tests for parser and file-system logic.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
