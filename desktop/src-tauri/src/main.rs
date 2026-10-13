// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! LocalLeaf desktop: an Overleaf-style UI on top of `texcraft-core`.
//!
//! The same executable doubles as an MCP server (`--mcp [--root DIR]`), so an AI agent
//! can drive the very project that is open in the editor. Edits the agent makes are
//! picked up by the file watcher and pushed to the UI as events.

mod menu;
mod projects;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use texcraft_core::compiler::{self, CompileOptions, TeXEngine};
use texcraft_core::project::{FileNode, Project};
use texcraft_core::{synctex, DEFAULT_OUTPUT_DIR};

pub(crate) type CmdResult<T> = Result<T, String>;

pub(crate) fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn anyhow_err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

struct OpenProject {
    project: Project,
    _watcher: Option<RecommendedWatcher>,
}

#[derive(Default)]
pub(crate) struct AppState {
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectInfo {
    root: String,
    name: String,
    main_document: Option<String>,
    tree: Vec<FileNode>,
    /// Command line an MCP client can use to drive this project.
    mcp_command: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineInfo {
    engine: TeXEngine,
    installed: bool,
    path: Option<String>,
}

#[derive(Serialize)]
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

#[tauri::command]
fn open_project(app: AppHandle, state: State<'_, AppState>, path: String) -> CmdResult<ProjectInfo> {
    let project = Project::open(&path).map_err(anyhow_err)?;
    let watcher = match start_watcher(app, project.root().to_path_buf(), state.compiling.clone()) {
        Ok(w) => Some(w),
        Err(e) => {
            tracing::warn!("file watcher unavailable: {e}");
            None
        }
    };
    let info = project_info(&project)?;
    *state.open.write().map_err(err)? = Some(OpenProject { project, _watcher: watcher });
    Ok(info)
}

#[tauri::command]
fn create_project(
    app: AppHandle,
    state: State<'_, AppState>,
    parent: String,
    name: String,
) -> CmdResult<ProjectInfo> {
    let name = name.trim();
    if name.is_empty() || name.contains(['/', '\\']) || name.starts_with('.') {
        return Err("invalid project name".into());
    }
    let dir = Path::new(&parent).join(name);
    if dir.exists() {
        return Err(format!("{} already exists", dir.display()));
    }
    std::fs::create_dir_all(&dir).map_err(err)?;
    let title = name.replace(['\\', '{', '}', '%', '#', '&', '$', '_', '^', '~'], " ");
    let template = format!(
        "\\documentclass{{article}}\n\\usepackage[utf8]{{inputenc}}\n\\usepackage{{graphicx}}\n\n\
         \\title{{{title}}}\n\\author{{}}\n\\date{{\\today}}\n\n\\begin{{document}}\n\n\\maketitle\n\n\
         \\section{{Introduction}}\n\nYour text here.\n\n\\end{{document}}\n"
    );
    std::fs::write(dir.join("main.tex"), template).map_err(err)?;
    open_project(app, state, dir.to_string_lossy().into_owned())
}

#[tauri::command]
fn close_project(state: State<'_, AppState>) -> CmdResult<()> {
    *state.open.write().map_err(err)? = None;
    Ok(())
}

#[tauri::command]
fn get_tree(state: State<'_, AppState>) -> CmdResult<Vec<FileNode>> {
    state.project()?.tree(&[]).map_err(anyhow_err)
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
        main_document: project.guess_main_document(),
        tree: project.tree(&[]).map_err(anyhow_err)?,
        mcp_command: vec![exe, "--mcp".into(), "--root".into(), root.to_string_lossy().into_owned()],
    })
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

#[tauri::command]
async fn read_project_file(state: State<'_, AppState>, path: String) -> CmdResult<String> {
    state.project()?.read_text(&path).await.map_err(anyhow_err)
}

#[tauri::command]
async fn read_binary_file(state: State<'_, AppState>, path: String) -> CmdResult<tauri::ipc::Response> {
    let bytes = state.project()?.read_bytes(&path).await.map_err(anyhow_err)?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
async fn write_project_file(state: State<'_, AppState>, path: String, content: String) -> CmdResult<()> {
    state.project()?.write(&path, content.as_bytes()).await.map_err(anyhow_err)
}

#[tauri::command]
async fn create_file(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    state.project()?.create_file(&path).await.map_err(anyhow_err)
}

#[tauri::command]
async fn create_folder(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    state.project()?.create_dir(&path).await.map_err(anyhow_err)
}

#[tauri::command]
async fn rename_path(state: State<'_, AppState>, from: String, to: String) -> CmdResult<()> {
    state.project()?.rename(&from, &to).await.map_err(anyhow_err)
}

#[tauri::command]
async fn delete_path(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    state.project()?.delete(&path).await.map_err(anyhow_err)
}

/// Copies files chosen by the user (dialog or drag & drop) into `target_dir`.
#[tauri::command]
async fn import_files(
    state: State<'_, AppState>,
    target_dir: String,
    sources: Vec<ImportSource>,
) -> CmdResult<Vec<String>> {
    let project = state.project()?;
    let mut imported = Vec::new();
    for src in sources {
        let src_path = PathBuf::from(&src.path);
        let name = src_path
            .file_name()
            .ok_or_else(|| format!("invalid file {}", src.path))?
            .to_string_lossy()
            .into_owned();
        if src_path.is_dir() {
            return Err(format!("{name} is a folder; only files can be uploaded"));
        }
        let rel = if target_dir.is_empty() { name } else { format!("{target_dir}/{name}") };
        let bytes = tokio::fs::read(&src_path).await.map_err(err)?;
        project.write(&rel, &bytes).await.map_err(anyhow_err)?;
        imported.push(rel);
    }
    Ok(imported)
}

/// Copies a project file (typically the output PDF) to a location chosen by the user.
#[tauri::command]
async fn export_file(state: State<'_, AppState>, path: String, destination: String) -> CmdResult<()> {
    let src = state.project()?.resolve(&path).map_err(anyhow_err)?;
    tokio::fs::copy(&src, &destination).await.map_err(err)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

#[tauri::command]
fn list_available_engines() -> Vec<EngineInfo> {
    TeXEngine::ALL
        .iter()
        .map(|&engine| {
            let path = engine.locate();
            EngineInfo {
                engine,
                installed: path.is_some(),
                path: path.map(|p| p.to_string_lossy().into_owned()),
            }
        })
        .collect()
}

#[tauri::command]
async fn compile_tex(
    app: AppHandle,
    state: State<'_, AppState>,
    entry_point: String,
    engine: TeXEngine,
    options: Option<CompileOptions>,
) -> CmdResult<Value> {
    let project = state.project()?;
    let entry = project.resolve(&entry_point).map_err(anyhow_err)?;
    let output_dir = project.resolve(DEFAULT_OUTPUT_DIR).map_err(anyhow_err)?;
    let mut opts = options.unwrap_or_default();
    opts.synctex = true;

    let _guard = state.compile_lock.lock().await;
    state.compiling.store(true, Ordering::SeqCst);
    let _ = app.emit("compile://started", json!({ "entryPoint": entry_point, "engine": engine }));

    let outcome = compiler::compile_with(engine, &entry, &output_dir, &opts).await;
    state.compiling.store(false, Ordering::SeqCst);

    let payload = match outcome {
        Ok(result) => relativize_result(&project, &entry, &result),
        Err(e) => {
            let msg = anyhow_err(e);
            let _ = app.emit("compile://failed", json!({ "message": msg }));
            return Err(msg);
        }
    };
    let _ = app.emit("compile://finished", &payload);
    Ok(payload)
}

/// Rewrites every path in a compilation result relative to the project root, so the UI
/// can open diagnostics directly in the file tree.
fn relativize_result(project: &Project, entry: &Path, result: &compiler::CompilationResult) -> Value {
    let mut value = serde_json::to_value(result).unwrap_or(Value::Null);
    for key in ["pdf_path", "log_path", "synctex_path"] {
        if let Some(Value::String(p)) = value.get(key) {
            value[key] = Value::String(project.relative(Path::new(p)));
        }
    }
    let workdir = entry.parent().unwrap_or(project.root());
    let entry_rel = project.relative(entry);
    for list in ["errors", "warnings"] {
        if let Some(Value::Array(items)) = value.get_mut(list) {
            for item in items {
                let resolved = item
                    .get("file")
                    .and_then(Value::as_str)
                    .and_then(|f| workdir.join(f).canonicalize().ok())
                    .filter(|p| p.starts_with(project.root()))
                    .map(|p| project.relative(&p))
                    .unwrap_or_else(|| entry_rel.clone());
                item["file"] = Value::String(resolved);
            }
        }
    }
    value
}

#[tauri::command]
async fn clear_build_dir(state: State<'_, AppState>) -> CmdResult<()> {
    let dir = state.project()?.resolve(DEFAULT_OUTPUT_DIR).map_err(anyhow_err)?;
    if dir.exists() {
        tokio::fs::remove_dir_all(&dir).await.map_err(err)?;
    }
    Ok(())
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

#[tauri::command]
async fn synctex_forward(
    state: State<'_, AppState>,
    main_document: String,
    file: String,
    line: u32,
    column: u32,
) -> CmdResult<Vec<synctex::PdfLocation>> {
    let project = state.project()?;
    let pdf = output_pdf(&project, &main_document)?;
    let source = project.resolve(&file).map_err(anyhow_err)?;
    synctex::forward(&pdf, &source, line, column).await.map_err(anyhow_err)
}

#[tauri::command]
async fn synctex_inverse(
    state: State<'_, AppState>,
    main_document: String,
    page: u32,
    x: f64,
    y: f64,
) -> CmdResult<Option<SyncTexSource>> {
    let project = state.project()?;
    let pdf = output_pdf(&project, &main_document)?;
    let Some(loc) = synctex::inverse(&pdf, page, x, y).await.map_err(anyhow_err)? else {
        return Ok(None);
    };
    // SyncTeX reports paths like `/root/./chapters/intro.tex`; only files inside the project are openable.
    let file = loc
        .file
        .canonicalize()
        .ok()
        .filter(|p| p.starts_with(project.root()))
        .map(|p| project.relative(&p));
    Ok(file.map(|file| SyncTexSource { file, line: loc.line }))
}

#[tauri::command]
fn synctex_available() -> bool {
    synctex::is_available()
}

/// Opens the system file manager on a folder (Finder on macOS).
#[tauri::command]
fn reveal_in_file_manager(path: String) -> CmdResult<()> {
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(windows) {
        "explorer"
    } else {
        "xdg-open"
    };
    std::process::Command::new(opener).arg(&path).spawn().map_err(err)?;
    Ok(())
}

/// Opens a web page in the default browser (Help menu links).
#[tauri::command]
fn open_external(url: String) -> CmdResult<()> {
    if !url.starts_with("https://") {
        return Err("only https links can be opened".into());
    }
    let opener = if cfg!(target_os = "macos") { "open" } else if cfg!(windows) { "explorer" } else { "xdg-open" };
    std::process::Command::new(opener).arg(&url).spawn().map_err(err)?;
    Ok(())
}

/// Project folder passed on the command line (`LocalLeaf path/to/project`), if any.
#[tauri::command]
fn initial_project() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|a| !a.starts_with('-') && Path::new(a).is_dir())
        .and_then(|a| std::fs::canonicalize(a).ok())
        .map(|p| p.to_string_lossy().into_owned())
}

/// Surfaces webview errors in the terminal, where `tauri dev` users look first.
#[tauri::command]
fn frontend_log(level: String, message: String) {
    match level.as_str() {
        "error" => tracing::error!(target: "frontend", "{message}"),
        "warn" => tracing::warn!(target: "frontend", "{message}"),
        _ => tracing::info!(target: "frontend", "{message}"),
    }
}

// ---------------------------------------------------------------------------
// File watching
// ---------------------------------------------------------------------------

/// Watches the project and emits debounced change events:
/// - `project://changed` `{ paths }` for source edits (by the user elsewhere or by an MCP agent)
/// - `project://pdf-changed` when a PDF is rebuilt outside this app (e.g. an agent ran `compile_tex`)
fn start_watcher(app: AppHandle, root: PathBuf, compiling: Arc<AtomicBool>) -> notify::Result<RecommendedWatcher> {
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
                    if rel.is_empty()
                        || rel.starts_with(".git")
                        || rel.starts_with(".texcraft")
                        || name == ".DS_Store"
                        || name.ends_with(".texcraft-tmp")
                    {
                        continue;
                    }
                    changed.insert(rel);
                }
            }
            if !changed.is_empty() {
                let _ = app.emit("project://changed", json!({ "paths": changed }));
            }
            if pdf_changed && !compiling.load(Ordering::SeqCst) {
                let _ = app.emit("project://pdf-changed", ());
            }
        }
    });
    Ok(watcher)
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

/// Apps launched from Finder/Dock get a minimal PATH that lacks TeX. Recover the user's
/// login-shell PATH and add the usual TeX/Homebrew locations so engines are found.
fn fix_path_env() {
    let mut paths: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();

    #[cfg(unix)]
    if let Ok(shell) = std::env::var("SHELL") {
        if let Ok(out) = std::process::Command::new(shell)
            .args(["-lc", "printf '%s' \"$PATH\""])
            .stdin(std::process::Stdio::null())
            .output()
        {
            let shell_path = String::from_utf8_lossy(&out.stdout);
            if let Some(last) = shell_path.lines().last() {
                paths.extend(std::env::split_paths(last));
            }
        }
    }

    let mut extra = vec![
        PathBuf::from("/Library/TeX/texbin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        extra.push(PathBuf::from(&home).join(".cargo/bin"));
        extra.push(PathBuf::from(&home).join("bin"));
    }
    paths.extend(extra);

    let mut seen = BTreeSet::new();
    paths.retain(|p| seen.insert(p.clone()));
    if let Ok(joined) = std::env::join_paths(paths) {
        std::env::set_var("PATH", joined);
    }
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
    fix_path_env();

    // `LocalLeaf --mcp [--root DIR]` runs the headless MCP server instead of the GUI.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--mcp") {
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

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .manage(menu::MenuState::default())
        .setup(|app| {
            menu::install(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_project,
            create_project,
            close_project,
            get_tree,
            read_project_file,
            read_binary_file,
            write_project_file,
            create_file,
            create_folder,
            rename_path,
            delete_path,
            import_files,
            export_file,
            list_available_engines,
            compile_tex,
            clear_build_dir,
            synctex_forward,
            synctex_inverse,
            synctex_available,
            initial_project,
            reveal_in_file_manager,
            open_external,
            menu::update_menu_state,
            projects::rename_project_folder,
            projects::move_project_folder,
            projects::trash_project_folder,
            frontend_log,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LocalLeaf");
}
