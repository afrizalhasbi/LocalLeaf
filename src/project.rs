//! Sandboxed access to a local LaTeX project directory.
//!
//! Every path coming from an agent (MCP) or the desktop UI is relative to the project
//! root and is rejected if it escapes it, through `..`, absolute paths or symlinks.

use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::compiler::{CompilationResult, TeXEngine};

/// Largest text file served to clients.
pub const MAX_TEXT_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// Directory names never shown in the file tree.
const HIDDEN_DIRS: &[&str] = &[".git", "node_modules", "target", ".texcraft"];

/// Folders no client may read or write. `.git` in particular: `.git/config` and hooks can make
/// git run arbitrary commands, so an agent must never be able to touch them.
const FORBIDDEN_DIRS: &[&str] = &[".git"];

/// Distinguishes temporary files of concurrent writes (in this process).
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Per-project settings shared by the desktop app and the MCP server, stored in
/// `.texcraft/settings.json` next to the build output.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectSettings {
    pub display_name: Option<String>,
    pub main_document: Option<String>,
    pub engine: Option<TeXEngine>,
    pub auto_compile: Option<bool>,
    pub draft: Option<bool>,
    pub stop_on_first_error: Option<bool>,
}

/// Where [`ProjectSettings`] live, relative to the project root.
pub const SETTINGS_FILE: &str = ".texcraft/settings.json";

#[derive(Debug, Clone)]
pub struct Project {
    root: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    pub name: String,
    /// Path relative to the project root, always with `/` separators.
    pub path: String,
    pub is_dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<FileNode>>,
}

impl Project {
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref();
        let root = root
            .canonicalize()
            .with_context(|| format!("invalid project root {}", root.display()))?;
        if !root.is_dir() {
            bail!("project root {} is not a directory", root.display());
        }
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Resolves a client-supplied path against the project root, rejecting escapes.
    /// The path does not need to exist (so it can be used for new files and output dirs).
    pub fn resolve(&self, rel: &str) -> Result<PathBuf> {
        let candidate = Path::new(rel);
        let joined = if candidate.is_absolute() {
            candidate.to_path_buf()
        } else {
            self.root.join(candidate)
        };

        // Normalise lexically first, then canonicalise the deepest existing ancestor
        // so that not-yet-existing paths can still be validated against symlinks.
        let mut normalized = PathBuf::new();
        for comp in joined.components() {
            match comp {
                Component::ParentDir => {
                    normalized.pop();
                }
                Component::CurDir => {}
                other => normalized.push(other),
            }
        }
        let mut existing = normalized.as_path();
        let mut suffix = Vec::new();
        while !existing.exists() {
            suffix.push(existing.file_name().map(|s| s.to_owned()));
            existing = existing.parent().context("path has no existing ancestor")?;
        }
        let mut resolved = existing.canonicalize()?;
        for part in suffix.into_iter().rev().flatten() {
            resolved.push(part);
        }

        if !resolved.starts_with(&self.root) {
            bail!("path '{rel}' is outside the project root");
        }
        if let Ok(inner) = resolved.strip_prefix(&self.root) {
            if inner
                .components()
                .any(|c| FORBIDDEN_DIRS.iter().any(|d| c.as_os_str().eq_ignore_ascii_case(d)))
            {
                bail!("access to '{rel}' is not allowed (files inside .git are protected)");
            }
        }
        Ok(resolved)
    }

    /// Converts an absolute path inside the project to a root-relative `/`-separated path.
    pub fn relative(&self, path: &Path) -> String {
        let rel = path.strip_prefix(&self.root).unwrap_or(path);
        rel.components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/")
    }

    pub async fn read_text(&self, rel: &str) -> Result<String> {
        let path = self.resolve(rel)?;
        let meta = tokio::fs::metadata(&path)
            .await
            .with_context(|| format!("cannot access {rel}"))?;
        if !meta.is_file() {
            bail!("{rel} is not a regular file");
        }
        if meta.len() > MAX_TEXT_FILE_BYTES {
            bail!("{rel} is too large ({} bytes, limit {MAX_TEXT_FILE_BYTES})", meta.len());
        }
        let bytes = tokio::fs::read(&path).await?;
        String::from_utf8(bytes).map_err(|_| anyhow!("{rel} is not a UTF-8 text file"))
    }

    pub async fn read_bytes(&self, rel: &str) -> Result<Vec<u8>> {
        let path = self.resolve(rel)?;
        tokio::fs::read(&path)
            .await
            .with_context(|| format!("cannot read {rel}"))
    }

    /// Writes a file atomically (temp file + rename), creating parent directories.
    pub async fn write(&self, rel: &str, contents: &[u8]) -> Result<()> {
        let path = self.resolve(rel)?;
        if path == self.root {
            bail!("cannot write to the project root");
        }
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        // Unique per write: concurrent saves (the editor, an MCP agent, two quick autosaves)
        // must never share a temporary file, or one rename would publish the other's content.
        let tmp = path.with_file_name(format!(
            ".{}.{}-{}.texcraft-tmp",
            path.file_name().unwrap_or_default().to_string_lossy(),
            std::process::id(),
            TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        tokio::fs::write(&tmp, contents)
            .await
            .with_context(|| format!("cannot write {rel}"))?;
        if let Err(e) = tokio::fs::rename(&tmp, &path).await {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(e).with_context(|| format!("cannot write {rel}"));
        }
        Ok(())
    }

    pub async fn create_file(&self, rel: &str) -> Result<()> {
        let path = self.resolve(rel)?;
        if path.exists() {
            bail!("{rel} already exists");
        }
        self.write(rel, b"").await
    }

    pub async fn create_dir(&self, rel: &str) -> Result<()> {
        let path = self.resolve(rel)?;
        if path.exists() {
            bail!("{rel} already exists");
        }
        tokio::fs::create_dir_all(&path)
            .await
            .with_context(|| format!("cannot create folder {rel}"))
    }

    pub async fn rename(&self, from: &str, to: &str) -> Result<()> {
        let src = self.resolve(from)?;
        let mut dst = self.resolve(to)?;
        // `resolve` canonicalises existing paths, which on case-insensitive file systems would
        // turn `main.tex` back into the existing `Main.tex`: keep the requested final name.
        if let Some(name) = Path::new(to).file_name() {
            dst.set_file_name(name);
        }
        if src == self.root {
            bail!("cannot rename the project root");
        }
        if !src.exists() {
            bail!("{from} does not exist");
        }
        // On case-insensitive file systems (macOS, Windows) `Main.tex` → `main.tex` points at
        // the same file: that rename is allowed.
        let same_file = dst.canonicalize().map(|d| d == src).unwrap_or(false);
        if dst.exists() && !same_file {
            bail!("{to} already exists");
        }
        if let Some(parent) = dst.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::rename(&src, &dst)
            .await
            .with_context(|| format!("cannot rename {from} to {to}"))
    }

    pub async fn delete(&self, rel: &str) -> Result<()> {
        let path = self.resolve(rel)?;
        if path == self.root {
            bail!("cannot delete the project root");
        }
        let meta = tokio::fs::symlink_metadata(&path)
            .await
            .with_context(|| format!("{rel} does not exist"))?;
        if meta.is_dir() {
            tokio::fs::remove_dir_all(&path).await
        } else {
            tokio::fs::remove_file(&path).await
        }
        .with_context(|| format!("cannot delete {rel}"))
    }

    /// Recursively lists the project, folders first, then files, both alphabetically.
    /// `exclude` names root-level directories to hide (e.g. the build output dir).
    pub fn tree(&self, exclude: &[&str]) -> Result<Vec<FileNode>> {
        self.walk(&self.root, exclude, 0)
    }

    fn walk(&self, dir: &Path, exclude: &[&str], depth: usize) -> Result<Vec<FileNode>> {
        if depth > 16 {
            return Ok(Vec::new());
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(e) if depth == 0 => return Err(e).with_context(|| format!("cannot read {}", dir.display())),
            // An unreadable subfolder (permissions, broken mount) must not hide the whole project.
            Err(e) => {
                tracing::warn!(dir = %dir.display(), "skipping unreadable folder: {e}");
                return Ok(Vec::new());
            }
        };
        let mut nodes = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(file_type) = entry.file_type() else { continue };
            if name == ".DS_Store" || name.ends_with(".texcraft-tmp") {
                continue;
            }
            if file_type.is_dir()
                && (HIDDEN_DIRS.contains(&name.as_str()) || (depth == 0 && exclude.contains(&name.as_str())))
            {
                continue;
            }
            let path = entry.path();
            // Symlinks are listed but never followed, so the tree can't escape the root.
            let is_dir = file_type.is_dir();
            nodes.push(FileNode {
                name,
                path: self.relative(&path),
                is_dir,
                children: if is_dir { Some(self.walk(&path, exclude, depth + 1)?) } else { None },
            });
        }
        nodes.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(nodes)
    }

    /// Settings saved for this project, or `None` if there are none (or they are unreadable).
    pub fn load_settings(&self) -> Option<ProjectSettings> {
        let text = std::fs::read_to_string(self.root.join(SETTINGS_FILE)).ok()?;
        serde_json::from_str(&text).ok()
    }

    pub async fn save_settings(&self, settings: &ProjectSettings) -> Result<()> {
        let json = serde_json::to_string_pretty(settings)?;
        self.write(SETTINGS_FILE, json.as_bytes()).await
    }

    /// The main document: the one saved in the settings if it still exists, else the guess.
    pub fn main_document(&self) -> Option<String> {
        self.load_settings()
            .and_then(|s| s.main_document)
            .filter(|m| self.resolve(m).map(|p| p.is_file()).unwrap_or(false))
            .or_else(|| self.guess_main_document())
    }

    /// Serialises a compilation result with every path relative to the project root, and each
    /// diagnostic's file resolved to the project file it refers to (TeX prints paths relative
    /// to the main document's folder, e.g. `./chapters/intro.tex`). Diagnostics without a
    /// file, or pointing outside the project, are attributed to the main document.
    pub fn relativize_compilation(&self, entry: &Path, result: &CompilationResult) -> Value {
        let mut value = serde_json::to_value(result).unwrap_or(Value::Null);
        for key in ["pdf_path", "log_path", "synctex_path"] {
            if let Some(Value::String(p)) = value.get(key) {
                value[key] = Value::String(self.relative(Path::new(p)));
            }
        }
        let workdir = entry.parent().unwrap_or(&self.root);
        let entry_rel = self.relative(entry);
        for list in ["errors", "warnings"] {
            if let Some(Value::Array(items)) = value.get_mut(list) {
                for item in items {
                    let resolved = item
                        .get("file")
                        .and_then(Value::as_str)
                        .and_then(|f| workdir.join(f).canonicalize().ok())
                        .filter(|p| p.starts_with(&self.root))
                        .map(|p| self.relative(&p))
                        .unwrap_or_else(|| entry_rel.clone());
                    item["file"] = Value::String(resolved);
                }
            }
        }
        value
    }

    /// Picks the most likely main document: a root-level `.tex` file containing `\documentclass`,
    /// preferring `main.tex`.
    pub fn guess_main_document(&self) -> Option<String> {
        let mut candidates: Vec<String> = std::fs::read_dir(&self.root)
            .ok()?
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tex"))
            .filter(|n| {
                std::fs::read_to_string(self.root.join(n))
                    .map(|s| s.contains("\\documentclass"))
                    .unwrap_or(false)
            })
            .collect();
        candidates.sort();
        candidates
            .iter()
            .find(|n| n.as_str() == "main.tex")
            .or_else(|| candidates.first())
            .cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project() -> (PathBuf, Project) {
        // Tests run in parallel: a counter (not the clock) keeps their folders apart.
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "texcraft-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let project = Project::open(&dir).unwrap();
        (dir, project)
    }

    #[test]
    fn rejects_escapes() {
        let (dir, project) = temp_project();
        assert!(project.resolve("../outside.tex").is_err());
        assert!(project.resolve("/etc/passwd").is_err());
        assert!(project.resolve("a/../../b").is_err());
        assert!(project.resolve("chapters/new.tex").is_ok());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn protects_git_folder() {
        let (dir, project) = temp_project();
        std::fs::create_dir_all(dir.join(".git/hooks")).unwrap();
        assert!(project.resolve(".git/config").is_err());
        assert!(project.resolve(".git/hooks/pre-commit").is_err());
        assert!(project.resolve("sub/.git/config").is_err());
        assert!(project.resolve(".GIT/config").is_err());
        assert!(project.resolve(".gitignore").is_ok());
        assert!(project.resolve(".github/workflows/ci.yml").is_ok());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn concurrent_writes_never_collide() {
        let (dir, project) = temp_project();
        let tasks: Vec<_> = (0..32)
            .map(|i| {
                let p = project.clone();
                tokio::spawn(async move { p.write("main.tex", format!("version {i}").as_bytes()).await })
            })
            .collect();
        for t in tasks {
            t.await.unwrap().unwrap();
        }
        let text = project.read_text("main.tex").await.unwrap();
        assert!(text.starts_with("version "));
        let leftovers = std::fs::read_dir(&dir).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".texcraft-tmp")).count();
        assert_eq!(leftovers, 0);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn case_only_rename() {
        let (dir, project) = temp_project();
        project.write("Main.tex", b"x").await.unwrap();
        project.rename("Main.tex", "main.tex").await.unwrap();
        let names: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, vec!["main.tex".to_string()]);
        project.write("other.tex", b"y").await.unwrap();
        assert!(project.rename("main.tex", "other.tex").await.is_err(), "must not overwrite another file");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_subfolder_is_skipped() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, project) = temp_project();
        std::fs::write(dir.join("main.tex"), "x").unwrap();
        std::fs::create_dir_all(dir.join("locked")).unwrap();
        std::fs::set_permissions(dir.join("locked"), std::fs::Permissions::from_mode(0o000)).unwrap();
        let tree = project.tree(&[]);
        std::fs::set_permissions(dir.join("locked"), std::fs::Permissions::from_mode(0o755)).unwrap();
        let tree = tree.expect("tree must still load");
        assert!(tree.iter().any(|n| n.path == "main.tex"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn settings_round_trip() {
        let (dir, project) = temp_project();
        assert_eq!(project.load_settings(), None);
        std::fs::write(dir.join("thesis.tex"), "\\documentclass{article}").unwrap();
        std::fs::write(dir.join("other.tex"), "\\documentclass{article}").unwrap();
        assert_eq!(project.main_document().as_deref(), Some("other.tex"));
        let settings = ProjectSettings {
            main_document: Some("thesis.tex".into()),
            engine: Some(TeXEngine::LuaLaTeX),
            ..Default::default()
        };
        project.save_settings(&settings).await.unwrap();
        assert_eq!(project.load_settings(), Some(settings));
        assert_eq!(project.main_document().as_deref(), Some("thesis.tex"));
        std::fs::remove_file(dir.join("thesis.tex")).unwrap();
        assert_eq!(project.main_document().as_deref(), Some("other.tex"), "stale setting ignored");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn file_operations_round_trip() {
        let (dir, project) = temp_project();
        project.write("chapters/intro.tex", b"\\section{Intro}").await.unwrap();
        assert_eq!(project.read_text("chapters/intro.tex").await.unwrap(), "\\section{Intro}");
        project.rename("chapters/intro.tex", "intro.tex").await.unwrap();
        project.create_dir("figures").await.unwrap();
        let tree = project.tree(&[]).unwrap();
        let names: Vec<_> = tree.iter().map(|n| n.path.as_str()).collect();
        assert_eq!(names, vec!["chapters", "figures", "intro.tex"]);
        project.delete("chapters").await.unwrap();
        assert!(project.read_text("chapters/intro.tex").await.is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
