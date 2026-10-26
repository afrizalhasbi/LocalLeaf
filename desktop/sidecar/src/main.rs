// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! LocalLeaf sidecar: a headless backend for the Electron UI, talking newline-delimited
//! JSON over stdio, plus the headless MCP server (`--mcp [--root DIR]`).
//!
//! Requests:  `{"id": 1, "cmd": "open_project", "args": {"path": "…"}}`
//! Responses: `{"id": 1, "ok": …}` or `{"id": 1, "err": "…"}`
//! Events (no id): `{"event": "project://changed", "payload": …}`
//!
//! Logs go to stderr; stdout carries only protocol lines.

mod projects;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use base64::Engine as _;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Deserialize;
use serde_json::{json, Value};
use texcraft_core::compiler::{self, CompileOptions, TeXEngine};
use texcraft_core::project::{FileNode, Project, ProjectSettings};
use texcraft_core::{synctex, DEFAULT_OUTPUT_DIR};

pub(crate) type CmdResult<T> = Result<T, String>;

pub(crate) fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn anyhow_err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

/// Callback used to push events to the UI (called from any thread).
type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;

struct OpenProject {
    project: Project,
    _watcher: Option<RecommendedWatcher>,
}

struct AppState {
    open: RwLock<Option<OpenProject>>,
    compile_lock: tokio::sync::Mutex<()>,
    compiling: Arc<AtomicBool>,
}

impl AppState {
    /// Root of the project currently open in the editor, if any.
    pub(crate) fn open_root(&self) -> Option<PathBuf> {
        self.open.read().ok()?.as_ref().map(|o| o.project.root().to_path_buf())
    }

    fn project(&self) -> CmdResult<Project> {
        self.open
            .read()
            .map_err(err)?
            .as_ref()
            .map(|o| o.project.clone())
            .ok_or_else(|| "no project is open".to_string())
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectInfo {
    root: String,
    name: String,
    main_document: Option<String>,
    /// Saved per-project settings (`.texcraft/settings.json`), if any.
    settings: Option<ProjectSettings>,
    tree: Vec<FileNode>,
    /// Command line an MCP client can use to drive this project.
    mcp_command: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineInfo {
    engine: TeXEngine,
    installed: bool,
    path: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncTexSource {
    file: String,
    line: u32,
}

#[derive(Deserialize)]
struct ImportSource {
    path: String,
}

// ---------------------------------------------------------------------------
// Project lifecycle
// ---------------------------------------------------------------------------

/// Opens a project and starts watching it.
async fn open_project_at(emit: &Emit, state: &AppState, path: PathBuf) -> CmdResult<ProjectInfo> {
    let (project, info) = tokio::task::spawn_blocking(move || -> CmdResult<(Project, ProjectInfo)> {
        let project = Project::open(&path).map_err(anyhow_err)?;
        let info = project_info(&project)?;
        Ok((project, info))
    })
    .await
    .map_err(err)??;
    let watcher = match start_watcher(emit.clone(), project.root().to_path_buf(), state.compiling.clone()) {
        Ok(w) => Some(w),
        Err(e) => {
            tracing::warn!("file watcher unavailable: {e}");
            None
        }
    };
    *state.open.write().map_err(err)? = Some(OpenProject { project, _watcher: watcher });
    Ok(info)
}

async fn open_project(state: &AppState, emit: &Emit, args: Value) -> CmdResult<Value> {
    #[derive(Deserialize)] struct A { #[serde(rename = "path")] path: String }
    let a: A = serde_json::from_value(args).map_err(err)?;
    to_value(open_project_at(emit, state, PathBuf::from(a.path)).await)
}

async fn create_project(state: &AppState, emit: &Emit, args: Value) -> CmdResult<Value> {
    #[derive(Deserialize)] struct A { parent: String, name: String }
    let a: A = serde_json::from_value(args).map_err(err)?;
    let name = a.name.trim().to_string();
    if name.is_empty() || name.contains(['/', '\\', ':']) || name.starts_with('.') {
        return Err("invalid project name".into());
    }
    let dir = Path::new(&a.parent).join(&name);
    if dir.exists() {
        return Err(format!("{} already exists", dir.display()));
    }
    tokio::fs::create_dir_all(&dir).await.map_err(err)?;
    let title = name.replace(['\\', '{', '}', '%', '#', '&', '$', '_', '^', '~'], " ");
    let template = format!(
        "\\documentclass{{article}}\n\\usepackage{{graphicx}}\n\n\
         \\title{{{title}}}\n\\author{{}}\n\\date{{\\today}}\n\n\\begin{{document}}\n\n\\maketitle\n\n\
         \\section{{Introduction}}\n\nYour text here.\n\n\\end{{document}}\n"
    );
    tokio::fs::write(dir.join("main.tex"), template).await.map_err(err)?;
    to_value(open_project_at(emit, state, dir).await)
}

/// Renames the folder of the open project (and reopens it at the new path).
async fn rename_open_project(state: &AppState, emit: &Emit, args: Value) -> CmdResult<Value> {
    #[derive(Deserialize)] struct A { #[serde(rename = "newName")] new_name: String }
    let a: A = serde_json::from_value(args).map_err(err)?;
    if state.compiling.load(Ordering::SeqCst) {
        return Err("wait for the compilation to finish before renaming the project".into());
    }
    let old_root = state.project()?.root().to_path_buf();
    // Stop watching before the folder moves.
    *state.open.write().map_err(err)? = None;
    let from = old_root.clone();
    let renamed = tokio::task::spawn_blocking(move || projects::rename_dir(&from, &a.new_name))
        .await
        .map_err(err)?;
    match renamed {
        Ok(new_root) => to_value(open_project_at(emit, state, PathBuf::from(new_root)).await),
        Err(e) => {
            // Leave the project open where it was.
            let _ = open_project_at(emit, state, old_root).await;
            Err(e)
        }
    }
}

async fn get_tree(state: &AppState) -> CmdResult<Value> {
    let project = state.project()?;
    tokio::task::spawn_blocking(move || project.tree(&[]).map_err(anyhow_err))
        .await
        .map_err(err)
        .and_then(to_value)
}

async fn save_project_settings(state: &AppState, args: Value) -> CmdResult<Value> {
    #[derive(Deserialize)] struct A { settings: ProjectSettings }
    let a: A = serde_json::from_value(args).map_err(err)?;
    state.project()?.save_settings(&a.settings).await.map_err(anyhow_err)?;
    Ok(Value::Null)
}

fn project_info(project: &Project) -> CmdResult<ProjectInfo> {
    let root = project.root();
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "texcraft-core".into());
    Ok(ProjectInfo {
        root: root.to_string_lossy().into_owned(),
        name: root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Project".into()),
        main_document: project.main_document(),
        settings: project.load_settings(),
        tree: project.tree(&[]).map_err(anyhow_err)?,
        mcp_command: vec![exe, "--mcp".into(), "--root".into(), root.to_string_lossy().into_owned()],
    })
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

async fn read_project_file(state: &AppState, args: Value) -> CmdResult<Value> {
    #[derive(Deserialize)] struct A { path: String }
    let a: A = serde_json::from_value(args).map_err(err)?;
    Ok(Value::String(state.project()?.read_text(&a.path).await.map_err(anyhow_err)?))
}

async fn read_binary_file(state: &AppState, args: Value) -> CmdResult<Value> {
    #[derive(Deserialize)] struct A { path: String }
    let a: A = serde_json::from_value(args).map_err(err)?;
    let bytes = state.project()?.read_bytes(&a.path).await.map_err(anyhow_err)?;
    Ok(json!({ "base64": base64::engine::general_purpose::STANDARD.encode(bytes) }))
}

async fn write_project_file(state: &AppState, args: Value) -> CmdResult<Value> {
    #[derive(Deserialize)] struct A { path: String, content: String }
    let a: A = serde_json::from_value(args).map_err(err)?;
    state.project()?.write(&a.path, a.content.as_bytes()).await.map_err(anyhow_err)?;
    Ok(Value::Null)
}

async fn create_file(state: &AppState, args: Value) -> CmdResult<Value> {
    #[derive(Deserialize)] struct A { path: String }
    let a: A = serde_json::from_value(args).map_err(err)?;
    state.project()?.create_file(&a.path).await.map_err(anyhow_err)?;
    Ok(Value::Null)
}

async fn create_folder(state: &AppState, args: Value) -> CmdResult<Value> {
    #[derive(Deserialize)] struct A { path: String }
    let a: A = serde_json::from_value(args).map_err(err)?;
    state.project()?.create_dir(&a.path).await.map_err(anyhow_err)?;
    Ok(Value::Null)
}

async fn rename_path(state: &AppState, args: Value) -> CmdResult<Value> {
    #[derive(Deserialize)] struct A { from: String, to: String }
    let a: A = serde_json::from_value(args).map_err(err)?;
    state.project()?.rename(&a.from, &a.to).await.map_err(anyhow_err)?;
    Ok(Value::Null)
}

async fn delete_path(state: &AppState, args: Value) -> CmdResult<Value> {
    #[derive(Deserialize)] struct A { path: String }
    let a: A = serde_json::from_value(args).map_err(err)?;
    state.project()?.delete(&a.path).await.map_err(anyhow_err)?;
    Ok(Value::Null)
}

/// Copies files chosen by the user (dialog or drag & drop) into `target_dir`.
/// Existing files are only replaced when `overwrite` is true (the UI asks first).
async fn import_files(state: &AppState, args: Value) -> CmdResult<Value> {
    #[derive(Deserialize)] struct A { #[serde(rename = "targetDir")] target_dir: String, sources: Vec<ImportSource>, overwrite: Option<bool> }
    let a: A = serde_json::from_value(args).map_err(err)?;
    let project = state.project()?;
    let mut imported = Vec::new();
    for src in a.sources {
        let src_path = PathBuf::from(&src.path);
        let name = src_path
            .file_name()
            .ok_or_else(|| format!("invalid file {}", src.path))?
            .to_string_lossy()
            .into_owned();
        if src_path.is_dir() {
            return Err(format!("{name} is a folder; only files can be uploaded"));
        }
        let rel = if a.target_dir.is_empty() { name } else { format!("{}/{name}", a.target_dir) };
        if !a.overwrite.unwrap_or(false) && project.resolve(&rel).map_err(anyhow_err)?.exists() {
            return Err(format!("{rel} already exists"));
        }
        let bytes = tokio::fs::read(&src_path).await.map_err(err)?;
        project.write(&rel, &bytes).await.map_err(anyhow_err)?;
        imported.push(rel);
    }
    to_value(Ok(imported))
}

/// Copies a project file (typically the output PDF) to a location chosen by the user.
async fn export_file(state: &AppState, args: Value) -> CmdResult<Value> {
    #[derive(Deserialize)] struct A { path: String, destination: String }
    let a: A = serde_json::from_value(args).map_err(err)?;
    let src = state.project()?.resolve(&a.path).map_err(anyhow_err)?;
    let bytes = tokio::fs::read(&src).await.map_err(err)?;
    // Write only the contents into a brand-new file. `fs::copy` would also carry over
    // macOS file flags, and build output inside the hidden `.texcraft` folder is flagged
    // `hidden`, which made exported PDFs invisible in Finder. Removing an existing file
    // first matters too: overwriting it in place would keep its old flags.
    match tokio::fs::remove_file(&a.destination).await {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(err(e)),
    }
    tokio::fs::write(&a.destination, bytes).await.map_err(err)?;
    Ok(Value::Null)
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

fn list_available_engines() -> CmdResult<Value> {
    let engines: Vec<EngineInfo> = TeXEngine::ALL
        .iter()
        .map(|&engine| {
            let path = engine.locate();
            EngineInfo {
                engine,
                installed: path.is_some(),
                path: path.map(|p| p.to_string_lossy().into_owned()),
            }
        })
        .collect();
    to_value(Ok(engines))
}

async fn compile_tex(state: &AppState, emit: &Emit, args: Value) -> CmdResult<Value> {
    #[derive(Deserialize)] struct A { #[serde(rename = "entryPoint")] entry_point: String, engine: TeXEngine, options: Option<CompileOptions> }
    let a: A = serde_json::from_value(args).map_err(err)?;
    let project = state.project()?;
    let entry = project.resolve(&a.entry_point).map_err(anyhow_err)?;
    let output_dir = project.resolve(DEFAULT_OUTPUT_DIR).map_err(anyhow_err)?;
    let mut opts = a.options.unwrap_or_default();
    opts.synctex = true;

    let _guard = state.compile_lock.lock().await;
    state.compiling.store(true, Ordering::SeqCst);
    let _ = emit("compile://started", json!({ "entryPoint": a.entry_point, "engine": a.engine }));

    let outcome = compiler::compile_with(a.engine, &entry, &output_dir, &opts).await;
    state.compiling.store(false, Ordering::SeqCst);

    let payload = match outcome {
        Ok(result) => project.relativize_compilation(&entry, &result),
        Err(e) => {
            let msg = anyhow_err(e);
            let _ = emit("compile://failed", json!({ "message": msg }));
            return Err(msg);
        }
    };
    let _ = emit("compile://finished", payload.clone());
    Ok(payload)
}

async fn clear_build_dir(state: &AppState) -> CmdResult<Value> {
    let dir = state.project()?.resolve(DEFAULT_OUTPUT_DIR).map_err(anyhow_err)?;
    if dir.exists() {
        tokio::fs::remove_dir_all(&dir).await.map_err(err)?;
    }
    Ok(Value::Null)
}

// ---------------------------------------------------------------------------
// SyncTeX
// ---------------------------------------------------------------------------

fn output_pdf(project: &Project, main_document: &str) -> CmdResult<PathBuf> {
    let stem = Path::new(main_document)
        .file_stem()
        .ok_or("invalid main document")?
        .to_string_lossy()
        .into_owned();
    let pdf = project
        .resolve(&format!("{DEFAULT_OUTPUT_DIR}/{stem}.pdf"))
        .map_err(anyhow_err)?;
    if !pdf.is_file() {
        return Err("compile the project first".into());
    }
    Ok(pdf)
}

async fn synctex_forward(state: &AppState, args: Value) -> CmdResult<Value> {
    #[derive(Deserialize)] struct A { #[serde(rename = "mainDocument")] main_document: String, file: String, line: u32, column: u32 }
    let a: A = serde_json::from_value(args).map_err(err)?;
    let project = state.project()?;
    let pdf = output_pdf(&project, &a.main_document)?;
    let source = project.resolve(&a.file).map_err(anyhow_err)?;
    let locs = synctex::forward(&pdf, &source, a.line, a.column).await.map_err(anyhow_err)?;
    to_value(Ok(locs))
}

async fn synctex_inverse(state: &AppState, args: Value) -> CmdResult<Value> {
    #[derive(Deserialize)] struct A { #[serde(rename = "mainDocument")] main_document: String, page: u32, x: f64, y: f64 }
    let a: A = serde_json::from_value(args).map_err(err)?;
    let project = state.project()?;
    let pdf = output_pdf(&project, &a.main_document)?;
    let Some(loc) = synctex::inverse(&pdf, a.page, a.x, a.y).await.map_err(anyhow_err)? else {
        return Ok(Value::Null);
    };
    // SyncTeX reports paths like `/root/./chapters/intro.tex`; only files inside the project are openable.
    let file = loc
        .file
        .canonicalize()
        .ok()
        .filter(|p| p.starts_with(project.root()))
        .map(|p| project.relative(&p));
    to_value(Ok(file.map(|file| SyncTexSource { file, line: loc.line })))
}

/// Opens a folder or URL with the system's default handler (Finder, Explorer, xdg-open).
fn open_with_system(target: &str) -> CmdResult<()> {
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(windows) {
        "explorer"
    } else {
        "xdg-open"
    };
    std::process::Command::new(opener).arg(target).spawn().map_err(err)?;
    Ok(())
}

async fn reveal_in_file_manager(args: Value) -> CmdResult<Value> {
    #[derive(Deserialize)] struct A { path: String }
    let a: A = serde_json::from_value(args).map_err(err)?;
    open_with_system(&a.path)?;
    Ok(Value::Null)
}

/// Opens a web page in the default browser (Help menu links).
async fn open_external(args: Value) -> CmdResult<Value> {
    #[derive(Deserialize)] struct A { url: String }
    let a: A = serde_json::from_value(args).map_err(err)?;
    if !a.url.starts_with("https://") {
        return Err("only https links can be opened".into());
    }
    open_with_system(&a.url)?;
    Ok(Value::Null)
}

async fn frontend_log(args: Value) -> CmdResult<Value> {
    #[derive(Deserialize)] struct A { level: String, message: String }
    let a: A = serde_json::from_value(args).map_err(err)?;
    match a.level.as_str() {
        "error" => tracing::error!(target: "frontend", "{}", a.message),
        "warn" => tracing::warn!(target: "frontend", "{}", a.message),
        _ => tracing::info!(target: "frontend", "{}", a.message),
    }
    Ok(Value::Null)
}

// ---------------------------------------------------------------------------
// Project folder management (dashboard)
// ---------------------------------------------------------------------------

async fn rename_project_folder(state: &AppState, args: Value) -> CmdResult<Value> {
    #[derive(Deserialize)] struct A { root: String, #[serde(rename = "newName")] new_name: String }
    let a: A = serde_json::from_value(args).map_err(err)?;
    let src = checked_project_dir(state.open_root().as_deref(), &a.root)?;
    to_value(projects::rename_dir(&src, &a.new_name))
}

async fn move_project_folder(state: &AppState, args: Value) -> CmdResult<Value> {
    #[derive(Deserialize)] struct A { root: String, destination: String }
    let a: A = serde_json::from_value(args).map_err(err)?;
    let src = checked_project_dir(state.open_root().as_deref(), &a.root)?;
    let destination = a.destination;
    tokio::task::spawn_blocking(move || projects::move_dir(&src, &destination))
        .await
        .map_err(err)
        .and_then(to_value)
}

async fn trash_project_folder(state: &AppState, args: Value) -> CmdResult<Value> {
    #[derive(Deserialize)] struct A { root: String }
    let a: A = serde_json::from_value(args).map_err(err)?;
    let path = checked_project_dir(state.open_root().as_deref(), &a.root)?;
    tokio::task::spawn_blocking(move || trash::delete(&path).map_err(err))
        .await
        .map_err(err)
        .and_then(to_value)
}

fn checked_project_dir(open_root: Option<&Path>, root: &str) -> CmdResult<PathBuf> {
    let path = Path::new(root)
        .canonicalize()
        .map_err(|_| format!("{root} no longer exists"))?;
    if !path.is_dir() {
        return Err(format!("{} is not a folder", path.display()));
    }
    let home = std::env::var_os("HOME").map(PathBuf::from);
    if path.parent().is_none() || Some(&path) == home.as_ref() || path.components().count() < 3 {
        return Err(format!("refusing to modify {}", path.display()));
    }
    if open_root == Some(path.as_path()) {
        return Err("close the project before changing its folder".into());
    }
    Ok(path)
}

fn to_value<T: serde::Serialize>(r: CmdResult<T>) -> CmdResult<Value> {
    serde_json::to_value(r?).map_err(err)
}

// ---------------------------------------------------------------------------
// File watching
// ---------------------------------------------------------------------------

/// Watches the project and emits debounced change events:
/// - `project://changed` `{ paths }` for source edits (by the user elsewhere or by an MCP agent)
/// - `project://pdf-changed` when a PDF is rebuilt outside this app (e.g. an agent ran `compile_tex`)
fn start_watcher(emit: Emit, root: PathBuf, compiling: Arc<AtomicBool>) -> notify::Result<RecommendedWatcher> {
    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(tx)?;
    watcher.watch(&root, RecursiveMode::Recursive)?;

    std::thread::spawn(move || {
        // Ends when the watcher (and therefore the sender) is dropped.
        while let Ok(first) = rx.recv() {
            let mut batch = vec![first];
            let deadline = Instant::now() + Duration::from_millis(250);
            while let Ok(ev) = rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                batch.push(ev);
            }

            let mut changed = BTreeSet::new();
            let mut pdf_changed = false;
            for ev in batch.into_iter().flatten() {
                if ev.kind.is_access() {
                    continue;
                }
                for path in ev.paths {
                    let Ok(rel) = path.strip_prefix(&root) else { continue };
                    let rel = rel.to_string_lossy().replace('\\', "/");
                    if rel.starts_with(DEFAULT_OUTPUT_DIR) {
                        pdf_changed |= rel.ends_with(".pdf");
                        continue;
                    }
                    let name = rel.rsplit('/').next().unwrap_or("");
                    // Compare whole folder names: `.gitignore` and `.github/` are project files.
                    let top = rel.split('/').next().unwrap_or("");
                    if rel.is_empty()
                        || top == ".git"
                        || top == ".texcraft"
                        || name == ".DS_Store"
                        || name.ends_with(".texcraft-tmp")
                    {
                        continue;
                    }
                    changed.insert(rel);
                }
            }
            if !changed.is_empty() {
                let _ = emit("project://changed", json!({ "paths": changed }));
            }
            if pdf_changed && !compiling.load(Ordering::SeqCst) {
                let _ = emit("project://pdf-changed", Value::Null);
            }
        }
    });
    Ok(watcher)
}

// ---------------------------------------------------------------------------
// IPC server
// ---------------------------------------------------------------------------

async fn dispatch(state: &Arc<AppState>, emit: &Emit, cmd: &str, args: Value) -> CmdResult<Value> {
    match cmd {
        "open_project" => open_project(state, emit, args).await,
        "create_project" => create_project(state, emit, args).await,
        "rename_open_project" => rename_open_project(state, emit, args).await,
        "close_project" => {
            *state.open.write().map_err(err)? = None;
            Ok(Value::Null)
        }
        "get_tree" => get_tree(state).await,
        "save_project_settings" => save_project_settings(state, args).await,
        "read_project_file" => read_project_file(state, args).await,
        "read_binary_file" => read_binary_file(state, args).await,
        "write_project_file" => write_project_file(state, args).await,
        "create_file" => create_file(state, args).await,
        "create_folder" => create_folder(state, args).await,
        "rename_path" => rename_path(state, args).await,
        "delete_path" => delete_path(state, args).await,
        "import_files" => import_files(state, args).await,
        "export_file" => export_file(state, args).await,
        "list_available_engines" => list_available_engines(),
        "compile_tex" => compile_tex(state, emit, args).await,
        "clear_build_dir" => clear_build_dir(state).await,
        "synctex_forward" => synctex_forward(state, args).await,
        "synctex_inverse" => synctex_inverse(state, args).await,
        "synctex_available" => Ok(Value::Bool(synctex::is_available())),
        "reveal_in_file_manager" => reveal_in_file_manager(args).await,
        "open_external" => open_external(args).await,
        "frontend_log" => frontend_log(args).await,
        "rename_project_folder" => rename_project_folder(state, args).await,
        "move_project_folder" => move_project_folder(state, args).await,
        "trash_project_folder" => trash_project_folder(state, args).await,
        other => Err(format!("unknown command {other}")),
    }
}

/// Serves JSON lines on stdio until stdin is closed.
async fn run_ipc() -> anyhow::Result<()> {
    let state = Arc::new(AppState {
        open: RwLock::new(None),
        compile_lock: tokio::sync::Mutex::new(()),
        compiling: Arc::new(AtomicBool::new(false)),
    });

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let emit: Emit = Arc::new({
        let tx = tx.clone();
        move |event: &str, payload: Value| {
            let line = json!({ "event": event, "payload": payload }).to_string();
            let _ = tx.send(line);
        }
    });

    // Writer task: responses and events interleave safely through the channel.
    let mut stdout = tokio::io::BufWriter::new(tokio::io::stdout());
    let writer = tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if stdout.write_all(line.as_bytes()).await.is_err() || stdout.write_all(b"\n").await.is_err() {
                break;
            }
            if stdout.flush().await.is_err() {
                break;
            }
        }
    });

    use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncWriteExt;
    let reader = tokio::io::BufReader::new(tokio::io::stdin());
    let mut lines = reader.lines();
    let next_id = Arc::new(AtomicU64::new(0));
    while let Some(line) = lines.next_line().await.map_err(|e| anyhow::anyhow!(e))? {
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            tracing::warn!("ignoring malformed request: {line}");
            continue;
        };
        let cmd = msg.get("cmd").and_then(|c| c.as_str()).unwrap_or_default().to_string();
        let args = msg.get("args").cloned().unwrap_or(Value::Null);
        let id = msg.get("id").cloned();
        let state = state.clone();
        let emit = emit.clone();
        let tx = tx.clone();
        let seq = next_id.fetch_add(1, Ordering::Relaxed);
        tokio::spawn(async move {
            let started = Instant::now();
            let reply = match dispatch(&state, &emit, &cmd, args).await {
                Ok(ok) => json!({ "id": id, "ok": ok }),
                Err(e) => {
                    tracing::warn!("{cmd} failed after {:?}: {e}", started.elapsed());
                    json!({ "id": id, "err": e })
                }
            };
            let _ = tx.send(reply.to_string());
            let _ = seq; // requests may finish out of order; ids keep them aligned
        });
    }

    drop(tx);
    let _ = writer.await;
    Ok(())
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .init();
    texcraft_core::env::fix_path();

    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--mcp") {
        // Headless MCP server (drives a project folder, for AI agents).
        let root = args
            .iter()
            .position(|a| a == "--root")
            .and_then(|i| args.get(i + 1))
            .map(PathBuf::from)
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| PathBuf::from("."));
        let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
        if let Err(e) = runtime.block_on(texcraft_core::mcp_server::run(root)) {
            eprintln!("texcraft MCP server error: {e:#}");
            std::process::exit(1);
        }
        return;
    }

    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
    if let Err(e) = runtime.block_on(run_ipc()) {
        eprintln!("LocalLeaf sidecar error: {e:#}");
        std::process::exit(1);
    }
}
