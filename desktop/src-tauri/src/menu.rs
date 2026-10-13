//! Native menu bar (macOS-style), forwarding item clicks to the UI as `menu://action` events.
//!
//! The UI owns the state; it pushes it back through `update_menu_state` so check marks and
//! enabled items always reflect the editor.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Deserialize;
use tauri::menu::{
    AboutMetadataBuilder, CheckMenuItem, CheckMenuItemBuilder, IsMenuItem, MenuBuilder, MenuItem, MenuItemBuilder,
    SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::{err, CmdResult};

const ENGINES: [(&str, &str); 4] = [
    ("pdflatex", "pdfLaTeX"),
    ("xelatex", "XeLaTeX"),
    ("lualatex", "LuaLaTeX"),
    ("tectonic", "Tectonic"),
];

/// Items that only make sense with a project open.
const PROJECT_ITEMS: &[&str] = &[
    "file.new_file", "file.new_folder", "file.upload", "file.save", "file.reveal", "file.close_project",
    "edit.find", "edit.replace", "edit.goto_line", "edit.comment", "edit.bold", "edit.italic",
    "insert.section", "insert.subsection", "insert.subsubsection", "insert.itemize", "insert.enumerate",
    "insert.figure", "insert.table", "insert.equation", "insert.align", "insert.cite", "insert.ref",
    "insert.label", "insert.footnote", "insert.link",
    "view.font_bigger", "view.font_smaller", "view.font_reset",
    "build.compile", "build.compile_scratch", "build.sync_to_pdf", "build.sync_to_code", "build.word_count",
    "build.set_main", "build.clear_cache", "help.mcp",
];
/// Items that need a compiled PDF.
const PDF_ITEMS: &[&str] = &["file.download_pdf", "build.sync_to_pdf", "build.sync_to_code"];

#[derive(Default)]
pub struct MenuHandles {
    items: HashMap<String, MenuItem<Wry>>,
    checks: HashMap<String, CheckMenuItem<Wry>>,
}

pub type MenuState = Mutex<MenuHandles>;

struct Builder<'a> {
    app: &'a AppHandle,
    handles: MenuHandles,
}

impl Builder<'_> {
    fn item(&mut self, id: &str, label: &str, accel: Option<&str>) -> tauri::Result<MenuItem<Wry>> {
        let mut b = MenuItemBuilder::with_id(id, label);
        if let Some(a) = accel {
            b = b.accelerator(a);
        }
        let item = b.build(self.app)?;
        self.handles.items.insert(id.to_string(), item.clone());
        Ok(item)
    }

    fn check(&mut self, id: &str, label: &str, accel: Option<&str>) -> tauri::Result<CheckMenuItem<Wry>> {
        let mut b = CheckMenuItemBuilder::with_id(id, label);
        if let Some(a) = accel {
            b = b.accelerator(a);
        }
        let item = b.build(self.app)?;
        self.handles.checks.insert(id.to_string(), item.clone());
        Ok(item)
    }
}

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let mut b = Builder { app, handles: MenuHandles::default() };
    let pkg = app.package_info();

    let about = AboutMetadataBuilder::new()
        .name(Some("LocalLeaf"))
        .version(Some(pkg.version.to_string()))
        .comments(Some("Local-first LaTeX editor. Uses the TeX engines installed on this Mac."))
        .build();

    let app_menu = SubmenuBuilder::new(app, "LocalLeaf")
        .about(Some(about))
        .separator()
        .item(&b.item("app.settings", "Settings…", Some("CmdOrCtrl+,"))?)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file = SubmenuBuilder::new(app, "File")
        .item(&b.item("file.new_project", "New Project…", Some("CmdOrCtrl+Shift+N"))?)
        .item(&b.item("file.open", "Open Folder…", Some("CmdOrCtrl+O"))?)
        .item(&b.item("file.projects", "All Projects", Some("CmdOrCtrl+Shift+P"))?)
        .separator()
        .item(&b.item("file.new_file", "New File…", Some("CmdOrCtrl+N"))?)
        .item(&b.item("file.new_folder", "New Folder…", Some("CmdOrCtrl+Alt+N"))?)
        .item(&b.item("file.upload", "Upload Files…", Some("CmdOrCtrl+U"))?)
        .separator()
        .item(&b.item("file.save", "Save", Some("CmdOrCtrl+S"))?)
        .item(&b.item("file.download_pdf", "Download PDF…", Some("CmdOrCtrl+Shift+S"))?)
        .item(&b.item("file.reveal", "Show Project in Finder", Some("CmdOrCtrl+Alt+R"))?)
        .separator()
        .item(&b.item("file.close_project", "Close Project", Some("CmdOrCtrl+Shift+W"))?)
        .close_window()
        .build()?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&b.item("edit.find", "Find…", Some("CmdOrCtrl+F"))?)
        .item(&b.item("edit.replace", "Find and Replace…", Some("CmdOrCtrl+Alt+F"))?)
        .item(&b.item("edit.goto_line", "Go to Line…", Some("CmdOrCtrl+L"))?)
        .separator()
        .item(&b.item("edit.comment", "Toggle Comment", Some("CmdOrCtrl+/"))?)
        .item(&b.item("edit.bold", "Bold", Some("CmdOrCtrl+B"))?)
        .item(&b.item("edit.italic", "Italic", Some("CmdOrCtrl+I"))?)
        .build()?;

    let insert = SubmenuBuilder::new(app, "Insert")
        .item(&b.item("insert.section", "Section", Some("CmdOrCtrl+Alt+1"))?)
        .item(&b.item("insert.subsection", "Subsection", Some("CmdOrCtrl+Alt+2"))?)
        .item(&b.item("insert.subsubsection", "Subsubsection", Some("CmdOrCtrl+Alt+3"))?)
        .separator()
        .item(&b.item("insert.itemize", "Bulleted List", None)?)
        .item(&b.item("insert.enumerate", "Numbered List", None)?)
        .item(&b.item("insert.figure", "Figure", None)?)
        .item(&b.item("insert.table", "Table", None)?)
        .separator()
        .item(&b.item("insert.equation", "Equation", Some("CmdOrCtrl+Alt+E"))?)
        .item(&b.item("insert.align", "Aligned Equations", None)?)
        .separator()
        .item(&b.item("insert.cite", "Citation", None)?)
        .item(&b.item("insert.ref", "Cross-reference", None)?)
        .item(&b.item("insert.label", "Label", None)?)
        .item(&b.item("insert.footnote", "Footnote", None)?)
        .item(&b.item("insert.link", "Link", Some("CmdOrCtrl+K"))?)
        .build()?;

    let layout = SubmenuBuilder::new(app, "Layout")
        .item(&b.check("layout:split", "Editor & PDF", Some("CmdOrCtrl+1"))?)
        .item(&b.check("layout:editor", "Editor Only", Some("CmdOrCtrl+2"))?)
        .item(&b.check("layout:pdf", "PDF Only", Some("CmdOrCtrl+3"))?)
        .build()?;
    let theme = SubmenuBuilder::new(app, "Theme")
        .item(&b.check("theme:dark", "Dark", None)?)
        .item(&b.check("theme:light", "Light", None)?)
        .item(&b.check("theme:system", "Match System", None)?)
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&layout)
        .separator()
        .item(&b.check("view.file_tree", "File Tree", Some("CmdOrCtrl+Alt+B"))?)
        .item(&b.check("view.outline", "File Outline", Some("CmdOrCtrl+Shift+O"))?)
        .item(&b.check("view.logs", "Logs and Errors", Some("CmdOrCtrl+Shift+L"))?)
        .separator()
        .item(&b.item("view.font_bigger", "Bigger Editor Font", Some("CmdOrCtrl+="))?)
        .item(&b.item("view.font_smaller", "Smaller Editor Font", Some("CmdOrCtrl+-"))?)
        .item(&b.item("view.font_reset", "Default Editor Font Size", Some("CmdOrCtrl+0"))?)
        .separator()
        .item(&theme)
        .separator()
        .fullscreen()
        .build()?;

    let mut compiler = SubmenuBuilder::new(app, "Compiler");
    for (id, label) in ENGINES {
        compiler = compiler.item(&b.check(&format!("engine:{id}"), label, None)?);
    }
    let compiler = compiler.build()?;
    let build = SubmenuBuilder::new(app, "Project")
        .item(&b.item("build.compile", "Recompile", Some("CmdOrCtrl+Enter"))?)
        .item(&b.item("build.compile_scratch", "Recompile from Scratch", Some("CmdOrCtrl+Shift+Enter"))?)
        .separator()
        .item(&compiler)
        .item(&b.check("build.auto_compile", "Auto Compile", None)?)
        .item(&b.check("build.draft", "Fast Draft Mode", None)?)
        .item(&b.check("build.stop_on_error", "Stop on First Error", None)?)
        .separator()
        .item(&b.item("build.sync_to_pdf", "Go to Location in PDF", Some("CmdOrCtrl+Alt+Right"))?)
        .item(&b.item("build.sync_to_code", "Go to Location in Code", Some("CmdOrCtrl+Alt+Left"))?)
        .separator()
        .item(&b.item("build.set_main", "Set Current File as Main Document", None)?)
        .item(&b.item("build.word_count", "Word Count", Some("CmdOrCtrl+Shift+C"))?)
        .item(&b.item("build.clear_cache", "Clear Cached Files", None)?)
        .build()?;

    let window = SubmenuBuilder::new(app, "Window").minimize().maximize().separator().close_window().build()?;

    let help = SubmenuBuilder::new(app, "Help")
        .item(&b.item("help.shortcuts", "Keyboard Shortcuts", Some("CmdOrCtrl+Shift+/"))?)
        .item(&b.item("help.mcp", "Connect an AI Agent (MCP)…", None)?)
        .separator()
        .item(&b.item("help.latex_guide", "LaTeX Guide (Wikibooks)", None)?)
        .item(&b.item("help.ctan", "Search Packages on CTAN", None)?)
        .build()?;

    let menus: [&dyn IsMenuItem<Wry>; 8] = [&app_menu, &file, &edit, &insert, &view, &build, &window, &help];
    let menu = MenuBuilder::new(app).items(&menus).build()?;
    app.set_menu(menu)?;
    *app.state::<MenuState>().lock().expect("menu state") = b.handles;

    app.on_menu_event(|app, event| {
        let _ = app.emit("menu://action", event.id().as_ref());
    });
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuSync {
    project_open: bool,
    has_pdf: bool,
    auto_compile: bool,
    draft: bool,
    stop_on_first_error: bool,
    engine: String,
    installed_engines: Vec<String>,
    layout: String,
    theme: String,
    show_file_tree: bool,
    show_outline: bool,
    show_logs: bool,
}

#[tauri::command]
pub fn update_menu_state(menu: tauri::State<'_, MenuState>, sync: MenuSync) -> CmdResult<()> {
    let handles = menu.lock().map_err(err)?;
    let set_check = |id: &str, checked: bool| {
        if let Some(c) = handles.checks.get(id) {
            let _ = c.set_checked(checked);
        }
    };
    let set_enabled_check = |id: &str, enabled: bool| {
        if let Some(c) = handles.checks.get(id) {
            let _ = c.set_enabled(enabled);
        }
    };

    for id in PROJECT_ITEMS {
        if let Some(i) = handles.items.get(*id) {
            let _ = i.set_enabled(sync.project_open && (!PDF_ITEMS.contains(id) || sync.has_pdf));
        }
    }
    for id in PDF_ITEMS {
        if let Some(i) = handles.items.get(*id) {
            let _ = i.set_enabled(sync.project_open && sync.has_pdf);
        }
    }

    for (engine, _) in ENGINES {
        let id = format!("engine:{engine}");
        set_check(&id, sync.engine == engine);
        set_enabled_check(&id, sync.project_open && sync.installed_engines.iter().any(|e| e == engine));
    }
    for (id, value) in [
        ("build.auto_compile", sync.auto_compile),
        ("build.draft", sync.draft),
        ("build.stop_on_error", sync.stop_on_first_error),
        ("view.file_tree", sync.show_file_tree),
        ("view.outline", sync.show_outline),
        ("view.logs", sync.show_logs),
    ] {
        set_check(id, value);
        set_enabled_check(id, sync.project_open);
    }
    for l in ["split", "editor", "pdf"] {
        set_check(&format!("layout:{l}"), sync.layout == l);
        set_enabled_check(&format!("layout:{l}"), sync.project_open);
    }
    for t in ["dark", "light", "system"] {
        set_check(&format!("theme:{t}"), sync.theme == t);
    }
    Ok(())
}
